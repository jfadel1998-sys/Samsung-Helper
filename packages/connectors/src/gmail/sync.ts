import { env } from '@hub/config';
import { HttpError, requestJson } from '../http';
import { CursorExpiredError, type SyncCtx, type SyncResult } from '../types';
import { isExpiring, refresh } from './auth';
import { normalizeGmail, type GmailMessage } from './normalize';

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Bounds per run. Gmail bills in quota units (messages.get is 5) against a
 * per-user ceiling, and §8 holds us to concurrency 1 per account, so a run is
 * capped and resumed rather than fetched all at once.
 */
const MAX_MESSAGES_PER_RUN = 250;
const LIST_PAGE_SIZE = 100;

interface HistoryResponse {
  history?: Array<{
    id?: string;
    messagesAdded?: Array<{ message?: { id?: string; threadId?: string; labelIds?: string[] } }>;
  }>;
  nextPageToken?: string;
  historyId?: string;
}

interface ListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export async function ensureAccessToken(ctx: SyncCtx): Promise<string> {
  if (!isExpiring(ctx.tokens)) return ctx.tokens.accessToken;
  const refreshed = await refresh(ctx.tokens);
  await ctx.saveTokens(refreshed);
  ctx.tokens = refreshed;
  return refreshed.accessToken;
}

async function gmailGet<T>(ctx: SyncCtx, path: string): Promise<T> {
  const token = await ensureAccessToken(ctx);
  const { body } = await requestJson<T>(`${GMAIL_BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return body;
}

export async function getProfile(ctx: SyncCtx): Promise<{
  emailAddress?: string;
  historyId?: string;
}> {
  return gmailGet(ctx, '/profile');
}

/** Fetches full message resources one at a time (§8: concurrency 1 per account). */
async function fetchMessages(ctx: SyncCtx, ids: string[]): Promise<GmailMessage[]> {
  const out: GmailMessage[] = [];
  for (const id of ids) {
    try {
      out.push(await gmailGet<GmailMessage>(ctx, `/messages/${id}?format=full`));
    } catch (err) {
      // A message deleted between listing and fetching is normal, not a failure.
      if (err instanceof HttpError && (err.status === 404 || err.status === 403)) {
        ctx.log('gmail: message vanished before fetch, skipping', { id });
        continue;
      }
      throw err;
    }
  }
  return out;
}

/**
 * §2.3: `historyId` cursors are valid for roughly 7 days. An expired one comes
 * back as 404 — that is an expected state and must trigger a bounded full sync,
 * not an error.
 */
function isHistoryExpired(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  if (err.status === 404) return true;
  if (err.status === 400) {
    const reason = JSON.stringify(err.body ?? '');
    return /historyId|startHistoryId|failedPrecondition/i.test(reason);
  }
  return false;
}

/**
 * Bounded backfill over the last N days, re-seeding the history cursor.
 *
 * The cursor is read from getProfile *before* listing, so anything arriving
 * mid-backfill is picked up by the next delta rather than lost.
 */
export async function fullSync(ctx: SyncCtx, opts: { since: Date }): Promise<SyncResult> {
  const owners = env.ownerEmails;

  let nextCursor: string | null = null;
  try {
    nextCursor = (await getProfile(ctx)).historyId ?? null;
  } catch (err) {
    ctx.log('gmail: could not read profile historyId, will seed on next run', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Rounded, not ceiled: a caller passing "now - 30 days" is asking for 30,
  // and ceil turns that into 31 the moment a millisecond elapses in between.
  const days = Math.max(1, Math.round((Date.now() - opts.since.getTime()) / 86_400_000));
  const query = encodeURIComponent(`in:inbox newer_than:${days}d`);

  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const page: ListResponse = await gmailGet<ListResponse>(
      ctx,
      `/messages?q=${query}&maxResults=${LIST_PAGE_SIZE}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
    );
    for (const m of page.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < MAX_MESSAGES_PER_RUN);

  const bounded = ids.slice(0, MAX_MESSAGES_PER_RUN);
  const messages = await fetchMessages(ctx, bounded);

  ctx.log('gmail: full sync complete', {
    listed: ids.length,
    fetched: messages.length,
    days,
  });

  return {
    events: normalizeGmail(messages, owners),
    nextCursor,
    hasMore: ids.length > bounded.length || Boolean(pageToken),
  };
}

/** Incremental sync from the stored historyId. */
export async function deltaSync(ctx: SyncCtx): Promise<SyncResult> {
  if (!ctx.cursor) {
    throw new CursorExpiredError('No Gmail history cursor stored');
  }

  const owners = env.ownerEmails;
  const ids = new Set<string>();
  let latestHistoryId: string | null = null;
  let pageToken: string | undefined;
  let truncated = false;

  try {
    do {
      const page: HistoryResponse = await gmailGet<HistoryResponse>(
        ctx,
        `/history?startHistoryId=${encodeURIComponent(ctx.cursor)}` +
          `&historyTypes=messageAdded&labelId=INBOX&maxResults=${LIST_PAGE_SIZE}` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''),
      );

      for (const entry of page.history ?? []) {
        for (const added of entry.messagesAdded ?? []) {
          const id = added.message?.id;
          if (id) ids.add(id);
        }
      }

      if (page.historyId) latestHistoryId = page.historyId;
      pageToken = page.nextPageToken;

      if (ids.size >= MAX_MESSAGES_PER_RUN) {
        truncated = true;
        break;
      }
    } while (pageToken);
  } catch (err) {
    if (isHistoryExpired(err)) {
      throw new CursorExpiredError(
        'Gmail historyId is no longer valid (older than ~7 days or unknown)',
      );
    }
    throw err;
  }

  const bounded = [...ids].slice(0, MAX_MESSAGES_PER_RUN);
  const messages = await fetchMessages(ctx, bounded);

  return {
    events: normalizeGmail(messages, owners),
    // A truncated run must keep the old cursor, or the messages we did not
    // reach this time are skipped permanently.
    nextCursor: truncated ? ctx.cursor : latestHistoryId,
    hasMore: truncated,
  };
}
