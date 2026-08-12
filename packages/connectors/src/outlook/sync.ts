import { env } from '@hub/config';
import { HttpError, requestJson } from '../http';
import { CursorExpiredError, type SyncCtx, type SyncResult } from '../types';
import { isExpiring, refresh } from './auth';
import { normalizeOutlook, type GraphMessage } from './normalize';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Fields we ask Graph for. Keeping this tight matters: the delta endpoint
 * returns every selected field for every changed message.
 *
 * `internetMessageHeaders` is requested for the §7.1 header rules
 * (List-Unsubscribe, Auto-Submitted). Graph does not guarantee it on
 * collection responses, which is why NormalizedEvent carries
 * `headersAvailable` — an absent header set must not be read as "no
 * List-Unsubscribe header".
 */
const SELECT = [
  'id',
  'conversationId',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'webLink',
  'isDraft',
  'internetMessageHeaders',
].join(',');

const PAGE_SIZE = 50;
/** Safety bound so one run can't page forever; hasMore tells the caller to come back. */
const MAX_PAGES_PER_RUN = 20;

interface DeltaPage {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Ensures the access token is live, refreshing and persisting if needed. */
export async function ensureAccessToken(ctx: SyncCtx): Promise<string> {
  if (!isExpiring(ctx.tokens)) return ctx.tokens.accessToken;
  const refreshed = await refresh(ctx.tokens);
  await ctx.saveTokens(refreshed);
  ctx.tokens = refreshed;
  return refreshed.accessToken;
}

async function graphGet<T>(ctx: SyncCtx, url: string): Promise<T> {
  const token = await ensureAccessToken(ctx);
  const { body } = await requestJson<T>(url, {
    headers: {
      authorization: `Bearer ${token}`,
      // Ask Graph to return plain bodies where it can; we still handle HTML.
      prefer: `outlook.body-content-type="text", odata.maxpagesize=${PAGE_SIZE}`,
    },
  });
  return body;
}

/**
 * Graph signals an unusable delta token with 410 Gone (resyncRequired).
 * Some tenants surface the same condition as a 400 with a syncState error code.
 */
function isResyncRequired(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 410) return true;
  const code = (err.body as { error?: { code?: string } } | null)?.error?.code ?? '';
  return /resyncRequired|SyncStateNotFound|syncStateNotFound/i.test(code);
}

async function drainDelta(ctx: SyncCtx, startUrl: string): Promise<SyncResult> {
  const owners = env.ownerEmails;
  const events = [];
  let url: string | undefined = startUrl;
  let deltaLink: string | null = null;
  let pages = 0;

  while (url) {
    const page: DeltaPage = await graphGet<DeltaPage>(ctx, url);
    events.push(...normalizeOutlook(page.value ?? [], owners));
    pages++;

    if (page['@odata.deltaLink']) {
      deltaLink = page['@odata.deltaLink'];
      break;
    }
    url = page['@odata.nextLink'];

    if (url && pages >= MAX_PAGES_PER_RUN) {
      // Persist the nextLink as the cursor: resuming from it continues the same
      // delta run rather than restarting it.
      return { events, nextCursor: url, hasMore: true };
    }
  }

  return { events, nextCursor: deltaLink, hasMore: false };
}

function deltaUrl(): string {
  return `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=${SELECT}`;
}

/**
 * Bounded backfill. Re-runnable: every event upserts on
 * (source, external_id), so overlapping windows converge rather than duplicate.
 *
 * The cursor is seeded from `$deltatoken=latest`, which returns a delta token
 * for "now" without re-downloading the mailbox — so the backfill's own pages
 * are not replayed by the first deltaSync.
 */
export async function fullSync(ctx: SyncCtx, opts: { since: Date }): Promise<SyncResult> {
  const owners = env.ownerEmails;
  const since = opts.since.toISOString();

  // Seed the cursor first. Doing it before the backfill means any message that
  // lands mid-backfill is caught by the next delta rather than missed.
  let nextCursor: string | null = null;
  try {
    const seed = await graphGet<DeltaPage>(
      ctx,
      `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=latest`,
    );
    nextCursor = seed['@odata.deltaLink'] ?? null;
  } catch (err) {
    ctx.log('outlook: could not seed delta token, will seed on next delta run', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const events = [];
  let url: string | undefined =
    `${GRAPH_BASE}/me/mailFolders/inbox/messages` +
    `?$select=${SELECT}` +
    `&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}` +
    `&$orderby=${encodeURIComponent('receivedDateTime desc')}` +
    `&$top=${PAGE_SIZE}`;
  let pages = 0;

  while (url && pages < MAX_PAGES_PER_RUN) {
    const page: DeltaPage = await graphGet<DeltaPage>(ctx, url);
    events.push(...normalizeOutlook(page.value ?? [], owners));
    url = page['@odata.nextLink'];
    pages++;
  }

  ctx.log('outlook: full sync page complete', { events: events.length, pages });
  return { events, nextCursor, hasMore: Boolean(url) };
}

/** Incremental sync from the stored deltaLink. */
export async function deltaSync(ctx: SyncCtx): Promise<SyncResult> {
  if (!ctx.cursor) {
    throw new CursorExpiredError('No Outlook delta cursor stored');
  }
  try {
    return await drainDelta(ctx, ctx.cursor);
  } catch (err) {
    if (isResyncRequired(err)) {
      // §11: assert a clean fallback to full sync on 410 Gone.
      throw new CursorExpiredError('Outlook delta token rejected (resync required)');
    }
    throw err;
  }
}

/** Used only to bootstrap when no cursor exists and no backfill is wanted. */
export function initialDeltaUrl(): string {
  return deltaUrl();
}
