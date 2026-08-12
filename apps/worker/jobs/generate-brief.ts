import type PgBoss from 'pg-boss';
import { audiences, env, findAudience } from '@hub/config';
import { getDb } from '@hub/db';
import { briefDateFor, generateBrief, resolveWindow } from '@hub/brief';
import { QUEUES, type GenerateBriefJob } from '@hub/jobs';

/**
 * §8: runs at 06:45 America/Los_Angeles, ahead of the 07:00 delivery.
 *
 * One brief per audience. A failure generating one person's brief must not
 * stop anyone else's, so each is isolated.
 */
export async function runGenerateBrief(job: GenerateBriefJob = {}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const briefDate = job.briefDate ?? briefDateFor(now, env.briefTimezone);

  const targets = job.audience
    ? [findAudience(job.audience)].filter((a) => a !== undefined)
    : audiences();

  if (targets.length === 0) {
    console.warn(`[brief] no audience matches ${job.audience}`);
    return;
  }

  for (const audience of targets) {
    try {
      const window = await resolveWindow(db, now, briefDate, audience.key);
      const result = await generateBrief(db, {
        briefDate,
        audience: audience.key,
        audienceLabel: audience.label,
        from: window.from,
        to: window.to,
      });

      console.log(
        `[brief] ${briefDate} ${audience.key}: ${result.itemCount} item(s), ` +
          `${result.elapsedMs}ms, ${result.brief.inputTokens} in / ` +
          `${result.brief.outputTokens} out tokens`,
      );

      // §7.3 forbids preambles, encouragement, and unread counts. A violation
      // does not block delivery — it means the prompt needs tuning.
      if (result.lintWarnings.length > 0) {
        console.warn(`[brief] ${audience.key} style warnings: ${result.lintWarnings.join(', ')}`);
      }

      // M5 acceptance: under 60 seconds.
      if (result.elapsedMs > 60_000) {
        console.warn(
          `[brief] ${audience.key} took ${result.elapsedMs}ms, over the 60s target`,
        );
      }
    } catch (err) {
      console.error(
        `[brief] ${audience.key} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function registerGenerateBrief(boss: PgBoss) {
  await boss.work<GenerateBriefJob>(QUEUES.generateBrief, { batchSize: 1 }, async ([job]) => {
    await runGenerateBrief(job?.data ?? {});
  });
}
