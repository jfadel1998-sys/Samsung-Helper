import type PgBoss from 'pg-boss';
import { getDb, listActiveAccounts } from '@hub/db';
import { enqueueSync } from '@hub/jobs';

export const POLL_QUEUE = 'poll-accounts';

/**
 * §2.2: the polling fallback. Every active account full-syncs on a schedule
 * regardless of webhook health — webhook-only ingestion is how these systems
 * die quietly.
 */
export async function pollAllAccounts(): Promise<void> {
  const accounts = await listActiveAccounts(getDb());
  for (const account of accounts) {
    await enqueueSync({ accountId: account.id, trigger: 'poll' });
  }
  console.log(`[poll] enqueued ${accounts.length} account sync(s)`);
}

export async function registerPollAllAccounts(boss: PgBoss) {
  await boss.createQueue(POLL_QUEUE, {
    name: POLL_QUEUE,
    policy: 'singleton',
    retryLimit: 3,
    retryBackoff: true,
  });
  await boss.work(POLL_QUEUE, { batchSize: 1 }, async () => {
    await pollAllAccounts();
  });
}
