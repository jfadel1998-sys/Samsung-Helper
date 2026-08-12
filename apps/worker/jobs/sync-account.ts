import type PgBoss from 'pg-boss';
import {
  CursorExpiredError,
  RateLimitError,
  ReauthRequiredError,
  toEventRow,
  type SyncResult,
} from '@hub/connectors';
import {
  getAccount,
  getDb,
  patchSyncState,
  recordSyncFailure,
  recordSyncSuccess,
  setAccountStatus,
  threadsWithOwnerMessages,
  upsertEvents,
} from '@hub/db';
import { env } from '@hub/config';
import { prefilter } from '@hub/brief';
import { getBoss, QUEUES, type SyncAccountJob } from '@hub/jobs';
import { buildAccountContext } from './context';

/** §M2: connect an account and 30 days of history lands in `events`. */
export const BACKFILL_DAYS = 30;

/** §8: surface an account in the UI after 3 consecutive failures. */
export const FAILURE_ALERT_THRESHOLD = 3;

export async function syncAccount(job: SyncAccountJob): Promise<void> {
  const db = getDb();
  const account = await getAccount(db, job.accountId);

  if (!account) {
    console.warn(`[sync] account ${job.accountId} no longer exists, dropping job`);
    return;
  }
  if (account.status !== 'active') {
    console.warn(`[sync] account ${account.id} is ${account.status}, skipping`);
    return;
  }

  const { connector, ctx, state } = await buildAccountContext(account);

  let result: SyncResult;
  let didFullSync = false;

  const runFullSync = async () => {
    didFullSync = true;
    const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
    return connector.fullSync(ctx, { since });
  };

  try {
    if (job.full || !ctx.cursor) {
      result = await runFullSync();
    } else {
      try {
        result = await connector.deltaSync(ctx);
      } catch (err) {
        if (!(err instanceof CursorExpiredError)) throw err;
        // §2.3 / §11: an expired cursor is an expected state, not an error.
        ctx.log('cursor expired, falling back to bounded full sync');
        result = await runFullSync();
      }
    }
  } catch (err) {
    return handleSyncError(err, account.id, ctx.log);
  }

  // The connector produced events; classify then persist them idempotently.
  const verdicts = await classifyBatch(result.events, account);
  const rows = result.events.map((e, i) => toEventRow(account.id, e, verdicts[i]!));
  const written = await upsertEvents(db, rows);

  await recordSyncSuccess(db, account.id, {
    cursor: result.nextCursor ?? ctx.cursor,
    full: didFullSync,
  });

  ctx.log('sync complete', {
    events: written.length,
    full: didFullSync,
    hasMore: result.hasMore,
  });

  // A bounded run left more pages behind — come straight back for them.
  if (result.hasMore) {
    const boss = await getBoss();
    await boss.send(QUEUES.syncAccount, { ...job, full: false }, { singletonKey: account.id });
  }

  await ensureSubscription(account.id, state?.subscriptionId ?? null);
}

/**
 * Runs the §7.1 prefilter over a sync batch.
 *
 * Owner addresses come from the ACCOUNT, not a global env list: in Moet's
 * mailbox, Moet is the owner. A global list would make her own sent mail look
 * like a third party's and put Jason's address in the owner-in-To rule for a
 * mailbox he does not read.
 *
 * The "thread contains a prior owner message" rule needs thread history, so
 * that is resolved once per batch — one query for the DB side, unioned with any
 * owner message arriving in this same batch (common on a first backfill, where
 * the owner's reply and the inbound message land together).
 */
async function classifyBatch(
  events: Array<Parameters<typeof toEventRow>[1]>,
  account: { ownerEmails: string[]; email: string | null },
): Promise<string[]> {
  const db = getDb();
  // Fall back to the global list for accounts connected before owner_emails
  // existed, so an un-backfilled row still classifies sensibly.
  const ownerEmails =
    account.ownerEmails.length > 0
      ? account.ownerEmails
      : [account.email, ...env.ownerEmails].filter((e): e is string => Boolean(e));

  const threadIds = events.map((e) => e.threadId).filter((t): t is string => Boolean(t));
  const ownerThreads = await threadsWithOwnerMessages(db, threadIds);
  for (const e of events) {
    if (e.isFromOwner && e.threadId) ownerThreads.add(e.threadId);
  }

  return events.map(
    (e) =>
      prefilter(
        {
          actorHandle: e.actorHandle,
          subject: e.subject,
          bodyExcerpt: e.bodyExcerpt,
          isFromOwner: e.isFromOwner,
          signals: e.signals,
        },
        {
          ownerEmails,
          threadHasOwnerMessage: Boolean(e.threadId && ownerThreads.has(e.threadId)),
        },
      ).verdict,
  );
}

/**
 * §8 error policy.
 *
 * Nothing here rethrows except genuinely transient failures: pg-boss retries
 * on throw, and retrying a revoked grant or a rate limit immediately is how a
 * retry storm starts.
 */
async function handleSyncError(
  err: unknown,
  accountId: string,
  log: (msg: string, meta?: Record<string, unknown>) => void,
): Promise<void> {
  const db = getDb();
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof ReauthRequiredError) {
    // Dead refresh token. Flag it and stop — no amount of retrying fixes this.
    await setAccountStatus(db, accountId, 'reauth_required');
    await recordSyncFailure(db, accountId, `reauth required: ${message}`);
    log('account needs reauthorization, halting retries');
    return;
  }

  if (err instanceof RateLimitError) {
    // Honor Retry-After by re-queueing at that time rather than throwing,
    // which would let pg-boss's own backoff pick a worse moment.
    await recordSyncFailure(db, accountId, `rate limited: ${message}`);
    const boss = await getBoss();
    await boss.send(
      QUEUES.syncAccount,
      { accountId, trigger: 'rate-limit-retry' },
      { singletonKey: accountId, startAfter: err.retryAfterSeconds },
    );
    log('rate limited, re-queued', { retryAfterSeconds: err.retryAfterSeconds });
    return;
  }

  await recordSyncFailure(db, accountId, message);
  const after = await db.query.syncState.findFirst({
    where: (s, { eq }) => eq(s.accountId, accountId),
  });
  if ((after?.consecutiveFailures ?? 0) >= FAILURE_ALERT_THRESHOLD) {
    log('THREE OR MORE CONSECUTIVE FAILURES — surfaced on /ops', {
      consecutiveFailures: after?.consecutiveFailures,
    });
  }

  // Transient: let pg-boss retry with backoff.
  throw err;
}

/** Creates the webhook subscription if the account does not have one yet. */
async function ensureSubscription(accountId: string, existing: string | null): Promise<void> {
  if (existing) return;
  const db = getDb();
  const account = await getAccount(db, accountId);
  if (!account) return;

  const { connector, ctx } = await buildAccountContext(account);
  try {
    const sub = await connector.subscribe(ctx);
    await patchSyncState(db, accountId, {
      subscriptionId: sub.id,
      subscriptionExpiresAt: sub.expiresAt,
    });
    ctx.log('webhook subscription created', { expiresAt: sub.expiresAt.toISOString() });
  } catch (err) {
    // A missing subscription degrades us to polling, which still works (§2.2).
    ctx.log('could not create webhook subscription, polling will cover it', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function registerSyncAccount(boss: PgBoss) {
  await boss.work<SyncAccountJob>(
    QUEUES.syncAccount,
    { batchSize: 1, pollingIntervalSeconds: 5 },
    async ([job]) => {
      if (!job) return;
      await syncAccount(job.data);
    },
  );
}
