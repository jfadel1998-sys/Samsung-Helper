/**
 * Smoke check for the pg-boss wiring (M0 acceptance).
 *   DATABASE_URL=... pnpm exec tsx scripts/check-jobs.ts
 */
import { enqueueSync, getBoss, QUEUES, stopBoss } from '@hub/jobs';

const boss = await getBoss();

const queues = await boss.getQueues();
console.log('queues:');
for (const q of queues.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`  ${q.name} policy=${q.policy} retryLimit=${q.retryLimit} backoff=${q.retryBackoff}`);
}

// A webhook burst for one mailbox must collapse to a single pending job.
const acct = '11111111-1111-1111-1111-111111111111';
const first = await enqueueSync({ accountId: acct, trigger: 'webhook' });
const second = await enqueueSync({ accountId: acct, trigger: 'webhook' });
console.log(`burst dedup: first=${first ? 'queued' : 'null'} second=${second ? 'queued' : 'null'}`);
console.log('sync-account queue size:', await boss.getQueueSize(QUEUES.syncAccount));

await stopBoss();
