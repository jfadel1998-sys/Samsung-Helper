import type PgBoss from 'pg-boss';
import {
  getDb,
  markExtractionFailed,
  pendingExtraction,
  saveExtraction,
} from '@hub/db';
import { QUEUES, type ExtractEventsJob } from '@hub/jobs';
import {
  BATCH_SIZE,
  defaultClient,
  estimateCostUsd,
  runExtraction,
  type ExtractableEvent,
} from '@hub/extraction';

/**
 * Stage 2 of the pipeline (§7.2), on the every-15-minutes schedule.
 *
 * Pulls events where `extracted IS NULL AND prefilter_verdict = 'keep'` — the
 * exact predicate the partial index in §5 covers — and runs them through the
 * batched extractor.
 */
export async function extractEvents(job: ExtractEventsJob = {}): Promise<void> {
  const db = getDb();
  const batchSize = job.batchSize ?? BATCH_SIZE;

  const pending = await pendingExtraction(db, batchSize);
  if (pending.length === 0) {
    console.log('[extract] nothing pending');
    return;
  }

  const events: ExtractableEvent[] = pending.map((row) => ({
    id: row.id,
    source: row.source,
    externalId: row.externalId,
    actorName: row.actorName,
    actorHandle: row.actorHandle,
    subject: row.subject,
    bodyExcerpt: row.bodyExcerpt,
    occurredAt: row.occurredAt,
  }));

  const result = await runExtraction(defaultClient(), events, { batchSize });

  if (result.extracted.length > 0) {
    await saveExtraction(
      db,
      result.extracted.map((e) => ({
        source: e.source,
        externalId: e.externalId,
        extracted: e.value,
      })),
    );
  }

  // Failed batches are marked so they leave the pending queue instead of being
  // picked up again every 15 minutes forever (§7.2).
  for (const failure of result.failed) {
    await markExtractionFailed(db, failure.eventIds, failure.reason);
    console.error(`[extract] batch failed (${failure.eventIds.length} events): ${failure.reason}`);
  }

  console.log(
    `[extract] ${result.extracted.length} extracted, ${result.failed.length} batch failure(s), ` +
      `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens, ` +
      `~$${estimateCostUsd(result.usage).toFixed(4)}`,
  );
}

export async function registerExtractEvents(boss: PgBoss) {
  await boss.work<ExtractEventsJob>(QUEUES.extractEvents, { batchSize: 1 }, async ([job]) => {
    await extractEvents(job?.data ?? {});
  });
}
