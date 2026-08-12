import type PgBoss from 'pg-boss';
import {
  getAccount,
  getDb,
  patchSyncState,
  subscriptionsNeedingRenewal,
} from '@hub/db';
import { QUEUES } from '@hub/jobs';
import { buildAccountContext } from './context';

/** §2.2: renew anything expiring inside 24h. The job itself runs every 6h. */
export const RENEW_WINDOW_HOURS = 24;

export async function renewSubscriptions(): Promise<void> {
  const db = getDb();
  const due = await subscriptionsNeedingRenewal(db, RENEW_WINDOW_HOURS);

  if (due.length === 0) {
    console.log('[renew] nothing expiring inside 24h');
    return;
  }

  for (const state of due) {
    const account = await getAccount(db, state.accountId);
    if (!account || account.status !== 'active') continue;

    const { connector, ctx } = await buildAccountContext(account);

    try {
      const { expiresAt } = await connector.renew(ctx);
      await patchSyncState(db, account.id, { subscriptionExpiresAt: expiresAt });
      ctx.log('subscription renewed', { expiresAt: expiresAt.toISOString() });
    } catch (err) {
      // Renewal failing usually means the subscription is already gone. Drop
      // the stale id so the next sync recreates it; polling covers the gap.
      ctx.log('renewal failed, clearing subscription so it is recreated', {
        error: err instanceof Error ? err.message : String(err),
      });
      await patchSyncState(db, account.id, {
        subscriptionId: null,
        subscriptionExpiresAt: null,
      });
    }
  }
}

export async function registerRenewSubscriptions(boss: PgBoss) {
  await boss.work(QUEUES.renewSubscriptions, { batchSize: 1 }, async () => {
    await renewSubscriptions();
  });
}
