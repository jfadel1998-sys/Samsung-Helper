import type PgBoss from 'pg-boss';
import { audiences, env, findAudience } from '@hub/config';
import { getBrief, getDb } from '@hub/db';
import { briefDateFor, deliverBrief, deliveryConfigFromEnv } from '@hub/brief';
import { QUEUES, type DeliverBriefJob } from '@hub/jobs';

/**
 * §M6: delivery at 07:00 America/Los_Angeles, 15 minutes after generation.
 *
 * One email per audience, each to its own recipient. A missing brief for one
 * person does not block anyone else's delivery; it is collected and rethrown
 * at the end so pg-boss retries — generation running long is the likely cause
 * and it will be there shortly.
 *
 * A missing provider config is NOT an error: the briefs exist on the web page,
 * and retrying a missing API key every morning helps nobody.
 */
export async function runDeliverBrief(job: DeliverBriefJob | undefined): Promise<void> {
  const db = getDb();
  const briefDate = job?.briefDate ?? briefDateFor(new Date(), env.briefTimezone);
  const config = deliveryConfigFromEnv();

  const targets = job?.audience
    ? [findAudience(job.audience)].filter((a) => a !== undefined)
    : audiences();

  const missing: string[] = [];

  for (const audience of targets) {
    const brief = await getBrief(db, briefDate, audience.key);
    if (!brief) {
      missing.push(audience.key);
      continue;
    }

    if (!audience.deliverTo) {
      console.log(`[deliver] ${briefDate} ${audience.key}: no recipient configured, web only`);
      continue;
    }

    const result = await deliverBrief(
      config ? { ...config, to: audience.deliverTo } : null,
      { briefDate, markdown: brief.markdown, label: audience.label },
    );

    if (result.delivered) {
      console.log(
        `[deliver] ${briefDate} ${audience.key} -> ${audience.deliverTo}` +
          `${result.providerId ? ` (${result.providerId})` : ''}`,
      );
    } else {
      console.warn(`[deliver] ${briefDate} ${audience.key} not sent: ${result.reason}`);
    }
  }

  if (missing.length > 0) {
    throw new Error(`No brief generated for ${briefDate}: ${missing.join(', ')}`);
  }
}

export async function registerDeliverBrief(boss: PgBoss) {
  await boss.work<DeliverBriefJob>(QUEUES.deliverBrief, { batchSize: 1 }, async ([job]) => {
    await runDeliverBrief(job?.data);
  });
}
