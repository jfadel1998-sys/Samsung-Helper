/**
 * Worker entrypoint — the Railway "worker" service.
 *
 * Owns every scheduled job in §8. The web service never runs work; it only
 * enqueues (from OAuth callbacks and webhook receivers).
 */
import { env } from '@hub/config';
import { getBoss, QUEUES, stopBoss } from '@hub/jobs';
import { registerSyncAccount } from './jobs/sync-account';
import { registerRenewSubscriptions } from './jobs/renew-subscriptions';
import { registerExtractEvents } from './jobs/extract-events';
import { registerGenerateBrief } from './jobs/generate-brief';
import { registerDeliverBrief } from './jobs/deliver-brief';
import { registerTokenHealth } from './jobs/token-health';
import { registerPollAllAccounts, POLL_QUEUE } from './jobs/poll-accounts';

async function main() {
  const tz = env.briefTimezone;
  const boss = await getBoss();
  console.log('[worker] pg-boss connected');

  await registerSyncAccount(boss);
  await registerRenewSubscriptions(boss);
  await registerExtractEvents(boss);
  await registerGenerateBrief(boss);
  await registerDeliverBrief(boss);
  await registerTokenHealth(boss);
  await registerPollAllAccounts(boss);

  // §8 schedule table. pg-boss stores schedules in Postgres, so re-registering
  // on every deploy is idempotent.
  await boss.schedule(POLL_QUEUE, '*/30 * * * *', {}, { tz });
  await boss.schedule(QUEUES.renewSubscriptions, '0 */6 * * *', {}, { tz });
  await boss.schedule(QUEUES.extractEvents, '*/15 * * * *', {}, { tz });
  await boss.schedule(QUEUES.generateBrief, '45 6 * * *', {}, { tz });
  await boss.schedule(QUEUES.deliverBrief, '0 7 * * *', {}, { tz });
  await boss.schedule(QUEUES.tokenHealth, '0 * * * *', {}, { tz });

  console.log(`[worker] schedules registered (tz=${tz})`);

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`[worker] ${sig} received, draining`);
      stopBoss()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
