import type PgBoss from 'pg-boss';
import { env } from '@hub/config';
import { getDb } from '@hub/db';
import { briefDateFor, generateBrief, resolveWindow } from '@hub/brief';
import { QUEUES, type GenerateBriefJob } from '@hub/jobs';

/** §8: runs at 06:45 America/Los_Angeles, ahead of the 07:00 delivery. */
export async function runGenerateBrief(job: GenerateBriefJob = {}): Promise<void> {
  const db = getDb();
  const now = new Date();
  const briefDate = job.briefDate ?? briefDateFor(now, env.briefTimezone);

  const window = await resolveWindow(db, now, briefDate);
  const result = await generateBrief(db, {
    briefDate,
    from: window.from,
    to: window.to,
  });

  console.log(
    `[brief] ${briefDate}: ${result.itemCount} item(s), ${result.elapsedMs}ms, ` +
      `${result.brief.inputTokens} in / ${result.brief.outputTokens} out tokens`,
  );

  // §7.3 forbids preambles, encouragement, and unread counts. A violation does
  // not block delivery — it means the prompt needs tuning, so it is surfaced.
  if (result.lintWarnings.length > 0) {
    console.warn(`[brief] style warnings: ${result.lintWarnings.join(', ')}`);
  }

  // M5 acceptance: under 60 seconds.
  if (result.elapsedMs > 60_000) {
    console.warn(`[brief] generation took ${result.elapsedMs}ms, over the 60s target`);
  }
}

export async function registerGenerateBrief(boss: PgBoss) {
  await boss.work<GenerateBriefJob>(QUEUES.generateBrief, { batchSize: 1 }, async ([job]) => {
    await runGenerateBrief(job?.data ?? {});
  });
}
