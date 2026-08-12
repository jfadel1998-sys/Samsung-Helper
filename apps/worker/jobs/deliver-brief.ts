import type PgBoss from 'pg-boss';
import { env } from '@hub/config';
import { getBrief, getDb } from '@hub/db';
import { briefDateFor, deliverBrief, deliveryConfigFromEnv } from '@hub/brief';
import { QUEUES, type DeliverBriefJob } from '@hub/jobs';

/**
 * §M6: delivery at 07:00 America/Los_Angeles, 15 minutes after generation.
 *
 * If the brief for the day is missing this throws, so pg-boss retries — a
 * generation that ran long is the likely cause and it will be there shortly.
 * A missing provider config is NOT a throw: the brief exists on the web page,
 * and retrying a missing API key every morning helps nobody.
 */
export async function runDeliverBrief(job: DeliverBriefJob | undefined): Promise<void> {
  const db = getDb();
  const briefDate = job?.briefDate ?? briefDateFor(new Date(), env.briefTimezone);

  const brief = await getBrief(db, briefDate);
  if (!brief) {
    throw new Error(`No brief generated for ${briefDate} yet`);
  }

  const result = await deliverBrief(deliveryConfigFromEnv(), {
    briefDate,
    markdown: brief.markdown,
  });

  if (result.delivered) {
    console.log(`[deliver] ${briefDate} sent${result.providerId ? ` (${result.providerId})` : ''}`);
    return;
  }

  console.warn(`[deliver] ${briefDate} not sent: ${result.reason}`);
}

export async function registerDeliverBrief(boss: PgBoss) {
  await boss.work<DeliverBriefJob>(QUEUES.deliverBrief, { batchSize: 1 }, async ([job]) => {
    await runDeliverBrief(job?.data);
  });
}
