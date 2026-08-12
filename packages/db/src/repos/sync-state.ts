import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { syncState, type SyncStateRow } from '../schema';

export async function getSyncState(db: Db, accountId: string): Promise<SyncStateRow | undefined> {
  const [row] = await db.select().from(syncState).where(eq(syncState.accountId, accountId)).limit(1);
  return row;
}

export async function ensureSyncState(db: Db, accountId: string): Promise<SyncStateRow> {
  const [row] = await db
    .insert(syncState)
    .values({ accountId })
    .onConflictDoUpdate({
      target: syncState.accountId,
      // No-op update so RETURNING always yields the row.
      set: { accountId },
    })
    .returning();
  return row!;
}

export async function patchSyncState(
  db: Db,
  accountId: string,
  patch: Partial<Omit<SyncStateRow, 'accountId'>>,
) {
  await ensureSyncState(db, accountId);
  await db.update(syncState).set(patch).where(eq(syncState.accountId, accountId));
}

export async function recordSyncSuccess(
  db: Db,
  accountId: string,
  patch: { cursor?: string | null; full?: boolean },
) {
  await patchSyncState(db, accountId, {
    ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
    ...(patch.full ? { lastFullSyncAt: new Date() } : {}),
    lastDeltaSyncAt: new Date(),
    consecutiveFailures: 0,
    lastError: null,
  });
}

export async function recordSyncFailure(db: Db, accountId: string, error: string) {
  await ensureSyncState(db, accountId);
  await db
    .update(syncState)
    .set({
      consecutiveFailures: sql`${syncState.consecutiveFailures} + 1`,
      // Never store a full provider payload here — it can contain message content.
      lastError: error.slice(0, 500),
    })
    .where(eq(syncState.accountId, accountId));
}

/** Resolves a provider webhook notification back to an account. */
export async function findBySubscriptionId(
  db: Db,
  subscriptionId: string,
): Promise<SyncStateRow | undefined> {
  const [row] = await db
    .select()
    .from(syncState)
    .where(eq(syncState.subscriptionId, subscriptionId))
    .limit(1);
  return row;
}

/**
 * Subscriptions expiring inside `withinHours` (§2.2 — the renewal job runs
 * every 6h and renews anything inside 24h).
 */
export async function subscriptionsNeedingRenewal(db: Db, withinHours = 24) {
  const cutoff = new Date(Date.now() + withinHours * 3600_000);
  return db
    .select()
    .from(syncState)
    .where(
      and(isNotNull(syncState.subscriptionId), lt(syncState.subscriptionExpiresAt, cutoff)),
    );
}
