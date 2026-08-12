/**
 * IMAP sync. Cursor is `<uidValidity>:<lastUid>`.
 *
 * UIDs are only meaningful within one UIDVALIDITY generation. When a server
 * rotates it every UID is reissued, so a stored cursor from the previous
 * generation would silently re-ingest or skip mail. That rotation is exactly
 * the same situation as an expired Graph delta token or a stale Gmail
 * historyId, and it raises the same CursorExpiredError so the caller falls
 * back to a bounded full sync (§2.3).
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import { env } from '@hub/config';
import { CursorExpiredError, ReauthRequiredError, type SyncCtx, type SyncResult } from '../types';
import { credentialsFrom, isAuthFailure, isSecurePort } from './auth';
import { normalizeImap, type ImapMessage } from './normalize';

/** Bounded so one run cannot hold a socket open indefinitely. */
const MAX_MESSAGES_PER_RUN = 300;

export interface ImapCursor {
  uidValidity: string;
  lastUid: number;
}

export function parseCursor(cursor: string | null): ImapCursor | null {
  if (!cursor) return null;
  const [uidValidity, lastUid] = cursor.split(':');
  if (!uidValidity || lastUid === undefined) return null;
  const uid = Number(lastUid);
  return Number.isFinite(uid) ? { uidValidity, lastUid: uid } : null;
}

export function formatCursor(c: ImapCursor): string {
  return `${c.uidValidity}:${c.lastUid}`;
}

async function withMailbox<T>(
  ctx: SyncCtx,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const creds = credentialsFrom(ctx.tokens);
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    // Implicit TLS everywhere except loopback; isSecurePort throws rather than
    // silently downgrading against a remote host.
    secure: isSecurePort(creds.host, creds.port),
    auth: { user: creds.username, pass: creds.password },
    // imapflow logs full message metadata at info level; keep it off so
    // subjects and addresses never reach the application log.
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new ReauthRequiredError(
        'IMAP authentication failed. If this is Gmail, check the app password is still valid ' +
          'and that 2-step verification is still on.',
      );
    }
    throw err;
  }

  const lock = await client.getMailboxLock('INBOX');
  try {
    return await fn(client);
  } finally {
    lock.release();
    // logout() can throw on an already-dropped socket; the work is done either
    // way, so a failure here must not fail the sync.
    await client.logout().catch(() => {});
  }
}

/** imapflow exposes UIDVALIDITY as a BigInt. */
function uidValidityOf(client: ImapFlow): string {
  const mailbox = client.mailbox;
  if (!mailbox || typeof mailbox === 'boolean') return '';
  return String(mailbox.uidValidity ?? '');
}

/**
 * Header map built from headerLines, not from `parsed.headers`.
 *
 * mailparser's `headers` Map is interpreted, not raw: it folds every `List-*`
 * header into one synthetic `list` entry, so `list-unsubscribe` is simply
 * absent there and the §7.1 newsletter rule silently never fires. `headerLines`
 * is the verbatim wire form, which is what the normalizer actually wants — it
 * only ever tests presence and reads flat strings.
 */
export function headerMap(parsed: Pick<ParsedMail, 'headerLines'>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const { key, line } of parsed.headerLines ?? []) {
    // `line` is the full "Key: value" with any RFC 5322 folding still in it.
    const colon = line.indexOf(':');
    const value = (colon === -1 ? line : line.slice(colon + 1)).replace(/\s+/g, ' ').trim();
    const name = key.toLowerCase();
    // Repeated headers (a second List-Unsubscribe, a Received chain) are joined
    // rather than overwritten so presence checks can't be lost to last-wins.
    const existing = out[name];
    out[name] = existing ? `${existing}, ${value}` : value;
  }

  return out;
}

function addressList(field: ParsedMail['to']): Array<{ name?: string; address?: string }> {
  if (!field) return [];
  const items = Array.isArray(field) ? field : [field];
  return items.flatMap((f) => f.value.map((v) => ({ name: v.name, address: v.address })));
}

async function fetchMessages(
  client: ImapFlow,
  range: string,
  uidValidity: string,
  log: SyncCtx['log'],
): Promise<{ messages: ImapMessage[]; maxUid: number }> {
  const messages: ImapMessage[] = [];
  let maxUid = 0;

  for await (const item of client.fetch(
    range,
    { uid: true, source: true, flags: true, labels: true, envelope: true },
    { uid: true },
  )) {
    if (messages.length >= MAX_MESSAGES_PER_RUN) break;
    if (typeof item.uid === 'number') maxUid = Math.max(maxUid, item.uid);
    if (!item.source) continue;

    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(item.source);
    } catch (err) {
      // One unparseable message must not abort the run.
      log('imap: could not parse message, skipping', { uid: item.uid });
      continue;
    }

    const from = parsed.from?.value?.[0];

    messages.push({
      uid: item.uid,
      uidValidity,
      messageId: parsed.messageId ?? null,
      subject: parsed.subject ?? null,
      from: from ? { name: from.name, address: from.address } : null,
      to: addressList(parsed.to),
      cc: addressList(parsed.cc),
      date: parsed.date ?? null,
      text: parsed.text ?? null,
      html: typeof parsed.html === 'string' ? parsed.html : null,
      headers: headerMap(parsed),
      flags: item.flags ? [...item.flags] : [],
      gmailThreadId: item.threadId ? String(item.threadId) : null,
      gmailLabels: item.labels ? [...item.labels] : [],
    });
  }

  return { messages, maxUid };
}

/** Bounded backfill. Re-runnable — every event upserts on (source, external_id). */
export async function fullSync(ctx: SyncCtx, opts: { since: Date }): Promise<SyncResult> {
  const owners = env.ownerEmails;

  return withMailbox(ctx, async (client) => {
    const uidValidity = uidValidityOf(client);

    const uids = await client.search({ since: opts.since }, { uid: true });
    if (!uids || uids.length === 0) {
      ctx.log('imap: full sync found nothing in window');
      // Seed the cursor at the mailbox's current high-water mark so the next
      // delta does not re-walk an empty window.
      const mailbox = client.mailbox;
      const exists = mailbox && typeof mailbox !== 'boolean' ? mailbox.exists : 0;
      return {
        events: [],
        nextCursor: formatCursor({ uidValidity, lastUid: exists ?? 0 }),
        hasMore: false,
      };
    }

    const bounded = uids.slice(-MAX_MESSAGES_PER_RUN);
    const { messages, maxUid } = await fetchMessages(
      client,
      bounded.join(','),
      uidValidity,
      ctx.log,
    );

    ctx.log('imap: full sync complete', { matched: uids.length, fetched: messages.length });

    return {
      events: normalizeImap(messages, owners),
      nextCursor: formatCursor({ uidValidity, lastUid: maxUid }),
      hasMore: uids.length > bounded.length,
    };
  });
}

/** Incremental sync — everything with a UID above the stored one. */
export async function deltaSync(ctx: SyncCtx): Promise<SyncResult> {
  const stored = parseCursor(ctx.cursor);
  if (!stored) {
    throw new CursorExpiredError('No IMAP cursor stored');
  }

  const owners = env.ownerEmails;

  return withMailbox(ctx, async (client) => {
    const uidValidity = uidValidityOf(client);

    if (uidValidity && stored.uidValidity && uidValidity !== stored.uidValidity) {
      // Every UID has been reissued; the stored high-water mark is meaningless.
      throw new CursorExpiredError(
        `IMAP UIDVALIDITY changed (${stored.uidValidity} -> ${uidValidity}), cursor is stale`,
      );
    }

    const { messages, maxUid } = await fetchMessages(
      client,
      `${stored.lastUid + 1}:*`,
      uidValidity,
      ctx.log,
    );

    // A `N:*` range always returns at least the highest existing message, even
    // when nothing is above N, so drop anything at or below the cursor rather
    // than re-emitting the last message on every poll.
    const fresh = messages.filter((m) => (m.uid ?? 0) > stored.lastUid);

    return {
      events: normalizeImap(fresh, owners),
      nextCursor: formatCursor({
        uidValidity,
        lastUid: Math.max(stored.lastUid, maxUid),
      }),
      hasMore: fresh.length >= MAX_MESSAGES_PER_RUN,
    };
  });
}

/** Verifies credentials by actually opening the mailbox. */
export async function verifyConnection(
  creds: { username: string; password: string; host: string; port: number },
): Promise<{ mailboxExists: number }> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: isSecurePort(creds.host, creds.port),
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = client.mailbox;
      return { mailboxExists: mailbox && typeof mailbox !== 'boolean' ? (mailbox.exists ?? 0) : 0 };
    } finally {
      lock.release();
    }
  } catch (err) {
    if (isAuthFailure(err)) {
      throw new ReauthRequiredError(
        'IMAP rejected those credentials. For Gmail you need an app password ' +
          '(not your account password), with 2-step verification enabled.',
      );
    }
    throw err;
  } finally {
    await client.logout().catch(() => {});
  }
}
