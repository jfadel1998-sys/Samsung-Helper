/**
 * Stage 2 — batched structured extraction (§7.2).
 *
 * Batches of ~30 events, bodies truncated to 1500 chars, one call per batch.
 * Output is validated with Zod; on validation failure the batch is retried
 * once, then marked and skipped. One bad batch must never kill the brief.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  BODY_TRUNCATE_CHARS,
  buildBatchPrompt,
  EXTRACTION_SYSTEM_PROMPT,
  type BatchItem,
} from './prompts';
import { ExtractedEvent, ExtractionBatch, toStored, type StoredExtraction } from './schema';

/**
 * §3 assigns extraction to Haiku 4.5.
 *
 * Note for future tuning: Haiku 4.5 does NOT accept `output_config.effort` —
 * sending it is a 400. Depth control on this stage is prompt and batch size,
 * not an effort level.
 */
export const EXTRACTION_MODEL = 'claude-haiku-4-5';

export const BATCH_SIZE = 30;

/** 30 events x ~120 output tokens leaves generous headroom without inviting drift. */
const MAX_TOKENS = 16_000;

export interface ExtractableEvent {
  id: string;
  source: string;
  externalId: string;
  actorName: string | null;
  actorHandle: string | null;
  subject: string | null;
  bodyExcerpt: string | null;
  occurredAt: Date;
}

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BatchOutcome {
  /** Successful extractions, keyed back to the source event. */
  extracted: Array<{ eventId: string; source: string; externalId: string; value: StoredExtraction }>;
  /** Event ids in this batch that produced nothing usable. */
  failedEventIds: string[];
  failureReason?: string;
  usage: ExtractionUsage;
}

/** Minimal surface we need from the SDK — lets tests inject a stub (§11). */
export interface MessagesClient {
  parse(params: Record<string, unknown>): Promise<{
    parsed_output?: unknown;
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
}

export function defaultClient(apiKey?: string): MessagesClient {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  return client.messages as unknown as MessagesClient;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toBatchItem(event: ExtractableEvent, index: number): BatchItem {
  const from = [event.actorName, event.actorHandle].filter(Boolean).join(' ') || 'unknown sender';
  return {
    ref: String(index + 1),
    from,
    subject: event.subject ?? '(no subject)',
    received: event.occurredAt.toISOString(),
    body: (event.bodyExcerpt ?? '').slice(0, BODY_TRUNCATE_CHARS),
  };
}

async function callOnce(
  client: MessagesClient,
  events: ExtractableEvent[],
): Promise<{ batch: ExtractionBatch; usage: ExtractionUsage }> {
  const items = events.map(toBatchItem);

  const response = await client.parse({
    model: EXTRACTION_MODEL,
    max_tokens: MAX_TOKENS,
    system: EXTRACTION_SYSTEM_PROMPT,
    // Structured outputs constrain generation to the schema, so a malformed
    // shape is close to impossible. The Zod check below still runs — the model
    // can still return the wrong *number* of events or an unknown ref, which
    // the schema cannot express.
    output_config: { format: zodOutputFormat(ExtractionBatch) },
    messages: [{ role: 'user', content: buildBatchPrompt(items) }],
  });

  const usage: ExtractionUsage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };

  // `parsed_output` is populated by the SDK when parsing succeeds; fall back to
  // parsing the text ourselves so a stubbed or older client still works.
  const candidate =
    response.parsed_output ??
    (() => {
      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      return JSON.parse(text) as unknown;
    })();

  return { batch: ExtractionBatch.parse(candidate), usage };
}

/**
 * Extract one batch. Retries once on a validation or parse failure, then gives
 * up on that batch and reports which events it covered — the caller marks them
 * so they leave the queue instead of being retried forever (§7.2).
 */
export async function extractBatch(
  client: MessagesClient,
  events: ExtractableEvent[],
): Promise<BatchOutcome> {
  const usage: ExtractionUsage = { inputTokens: 0, outputTokens: 0 };
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { batch, usage: attemptUsage } = await callOnce(client, events);
      usage.inputTokens += attemptUsage.inputTokens;
      usage.outputTokens += attemptUsage.outputTokens;

      const byRef = new Map(events.map((e, i) => [String(i + 1), e]));
      const extracted: BatchOutcome['extracted'] = [];
      const seen = new Set<string>();

      for (const item of batch.events) {
        const event = byRef.get(item.ref);
        // A ref we did not send, or one sent twice, is dropped rather than
        // guessed at — attaching an extraction to the wrong message would put
        // a false fact in the brief.
        if (!event || seen.has(item.ref)) continue;
        seen.add(item.ref);
        extracted.push({
          eventId: event.id,
          source: event.source,
          externalId: event.externalId,
          value: toStored(item, event.externalId),
        });
      }

      // Events the model silently skipped still have to leave the queue.
      const covered = new Set(extracted.map((e) => e.eventId));
      const failedEventIds = events.filter((e) => !covered.has(e.id)).map((e) => e.id);

      return {
        extracted,
        failedEventIds,
        ...(failedEventIds.length > 0 ? { failureReason: 'omitted by model' } : {}),
        usage,
      };
    } catch (err) {
      lastError = err;
      usage.inputTokens += 0;
    }
  }

  return {
    extracted: [],
    failedEventIds: events.map((e) => e.id),
    failureReason:
      lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError).slice(0, 200),
    usage,
  };
}

export interface ExtractionRunResult {
  extracted: BatchOutcome['extracted'];
  failed: Array<{ eventIds: string[]; reason: string }>;
  usage: ExtractionUsage;
  batches: number;
}

/**
 * Extract a set of events in batches. A failing batch is isolated — the run
 * continues and reports it.
 */
export async function runExtraction(
  client: MessagesClient,
  events: ExtractableEvent[],
  opts: { batchSize?: number } = {},
): Promise<ExtractionRunResult> {
  const batches = chunk(events, opts.batchSize ?? BATCH_SIZE);

  const result: ExtractionRunResult = {
    extracted: [],
    failed: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    batches: batches.length,
  };

  for (const batch of batches) {
    const outcome = await extractBatch(client, batch);
    result.extracted.push(...outcome.extracted);
    result.usage.inputTokens += outcome.usage.inputTokens;
    result.usage.outputTokens += outcome.usage.outputTokens;
    if (outcome.failedEventIds.length > 0) {
      result.failed.push({
        eventIds: outcome.failedEventIds,
        reason: outcome.failureReason ?? 'unknown',
      });
    }
  }

  return result;
}

/** Haiku 4.5 list pricing, USD per million tokens — used by the cost check. */
export const HAIKU_PRICING = { inputPerMTok: 1.0, outputPerMTok: 5.0 } as const;

export function estimateCostUsd(usage: ExtractionUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * HAIKU_PRICING.inputPerMTok +
    (usage.outputTokens / 1_000_000) * HAIKU_PRICING.outputPerMTok
  );
}
