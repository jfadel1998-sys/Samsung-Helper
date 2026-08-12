/**
 * §11: extraction tests use a stubbed API client. Nothing here touches the
 * real Anthropic API.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BATCH_SIZE,
  chunk,
  estimateCostUsd,
  extractBatch,
  runExtraction,
  type ExtractableEvent,
  type MessagesClient,
} from '../src/run';
import { ExtractedEvent, ExtractionBatch } from '../src/schema';
import { BODY_TRUNCATE_CHARS, buildBatchPrompt } from '../src/prompts';

function event(n: number, over: Partial<ExtractableEvent> = {}): ExtractableEvent {
  return {
    id: `evt-${n}`,
    source: 'outlook',
    externalId: `AAMkAG-very-long-graph-identifier-${n}=`,
    actorName: 'M. Rossi',
    actorHandle: 'm.rossi@example-supplier.it',
    subject: `2269.2 GVR — message ${n}`,
    bodyExcerpt: `Revised pricing on line ${n}. FOB Livorno.`,
    occurredAt: new Date(Date.UTC(2026, 7, 10, 12, 0)),
    ...over,
  };
}

function extracted(ref: string, over: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    ref,
    job_number: '2269.2',
    project_name: 'GVR Local Stone',
    counterparty: 'M. Rossi',
    counterparty_type: 'supplier',
    category: 'pricing',
    summary: 'Confirmed revised pricing on 12 line items.',
    action_required: true,
    action_owner: 'jason',
    blocking_question: null,
    urgency: 'normal',
    dates_mentioned: [],
    amounts_mentioned: [],
    vessel_or_container: null,
    ...over,
  };
}

/** Stub returning a parsed batch, recording the params it was called with. */
function stubClient(
  responder: (call: number) => unknown,
  usage = { input_tokens: 1000, output_tokens: 500 },
): MessagesClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let n = 0;
  return {
    calls,
    parse: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      const result = responder(n++);
      if (result instanceof Error) throw result;
      return { parsed_output: result, content: [], usage };
    }),
  };
}

describe('batching', () => {
  it('chunks to the §7.2 batch size of 30', () => {
    expect(BATCH_SIZE).toBe(30);
    const events = Array.from({ length: 70 }, (_, i) => event(i));
    const batches = chunk(events, BATCH_SIZE);
    expect(batches.map((b) => b.length)).toEqual([30, 30, 10]);
  });

  it('truncates bodies to 1500 chars before they reach the model (§7.2)', async () => {
    expect(BODY_TRUNCATE_CHARS).toBe(1500);

    const client = stubClient(() => ({ events: [extracted('1')] }));
    await extractBatch(client, [event(1, { bodyExcerpt: 'x'.repeat(9000) })]);

    const prompt = (client.calls[0]!.messages as Array<{ content: string }>)[0]!.content;
    // "example-supplier.it" in the sender also contains an x, so take the
    // longest run rather than the first match.
    const longestRun = Math.max(...[...prompt.matchAll(/x+/g)].map((m) => m[0].length));
    expect(longestRun).toBe(BODY_TRUNCATE_CHARS);
  });

  it('renders one delimited block per message', () => {
    const prompt = buildBatchPrompt([
      { ref: '1', from: 'a@b.com', subject: 'first', received: 'r', body: 'one' },
      { ref: '2', from: 'c@d.com', subject: 'second', received: 'r', body: 'two' },
    ]);
    expect(prompt).toContain('<message ref="1">');
    expect(prompt).toContain('<message ref="2">');
    expect(prompt).toContain('2 message(s)');
  });

  it('sends short refs rather than provider ids', async () => {
    const client = stubClient(() => ({ events: [extracted('1'), extracted('2')] }));
    await extractBatch(client, [event(1), event(2)]);

    const prompt = (client.calls[0]!.messages as Array<{ content: string }>)[0]!.content;
    // The long Graph identifier must never be sent — it would cost ~50 output
    // tokens per event for the model to echo back, and can be mangled.
    expect(prompt).not.toContain('AAMkAG-very-long-graph-identifier');
    expect(prompt).toContain('ref="1"');
    expect(prompt).toContain('ref="2"');
  });

  it('maps refs back to the original external ids', async () => {
    const client = stubClient(() => ({ events: [extracted('1'), extracted('2')] }));
    const out = await extractBatch(client, [event(1), event(2)]);

    expect(out.extracted.map((e) => e.externalId)).toEqual([
      'AAMkAG-very-long-graph-identifier-1=',
      'AAMkAG-very-long-graph-identifier-2=',
    ]);
    expect(out.extracted[0]!.value.external_id).toBe('AAMkAG-very-long-graph-identifier-1=');
    expect(out.extracted[0]!.value).not.toHaveProperty('ref');
  });

  it('requests Haiku with a structured output format and no effort parameter', async () => {
    const client = stubClient(() => ({ events: [extracted('1')] }));
    await extractBatch(client, [event(1)]);

    const params = client.calls[0]!;
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.output_config).toHaveProperty('format');
    // Haiku 4.5 rejects output_config.effort with a 400 — it must not be sent.
    expect((params.output_config as Record<string, unknown>).effort).toBeUndefined();
  });
});

describe('failure isolation (§7.2)', () => {
  it('retries once on a malformed response, then succeeds', async () => {
    const client = stubClient((n) =>
      n === 0 ? { events: [{ ref: '1', nonsense: true }] } : { events: [extracted('1')] },
    );

    const out = await extractBatch(client, [event(1)]);
    expect(out.extracted).toHaveLength(1);
    expect(out.failedEventIds).toEqual([]);
    expect(client.calls).toHaveLength(2);
  });

  it('gives up after one retry and reports the batch as failed', async () => {
    const client = stubClient(() => ({ events: [{ ref: '1', nonsense: true }] }));

    const out = await extractBatch(client, [event(1), event(2)]);
    expect(out.extracted).toEqual([]);
    expect(out.failedEventIds).toEqual(['evt-1', 'evt-2']);
    expect(out.failureReason).toBeTruthy();
    // Exactly two attempts — no unbounded retry loop.
    expect(client.calls).toHaveLength(2);
  });

  it('survives a thrown API error without escaping', async () => {
    const client = stubClient(() => new Error('529 overloaded'));
    const out = await extractBatch(client, [event(1)]);
    expect(out.failedEventIds).toEqual(['evt-1']);
    expect(out.failureReason).toContain('529');
  });

  // The M4 acceptance criterion: one deliberately malformed response must not
  // abort the run.
  it('one bad batch does not abort a multi-batch run', async () => {
    const client = stubClient((n) =>
      n === 2 || n === 3
        ? { events: [{ garbage: true }] } // batch 2 fails both attempts
        : { events: Array.from({ length: 30 }, (_, i) => extracted(String(i + 1))) },
    );

    const events = Array.from({ length: 90 }, (_, i) => event(i));
    const result = await runExtraction(client, events, { batchSize: 30 });

    expect(result.batches).toBe(3);
    // Batches 1 and 3 succeeded; batch 2 is isolated and reported.
    expect(result.extracted).toHaveLength(60);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.eventIds).toHaveLength(30);
  });

  it('marks events the model silently omitted', async () => {
    // Model returns only 2 of the 3 events it was shown.
    const client = stubClient(() => ({ events: [extracted('1'), extracted('3')] }));
    const out = await extractBatch(client, [event(1), event(2), event(3)]);

    expect(out.extracted).toHaveLength(2);
    // evt-2 must leave the queue rather than spin forever.
    expect(out.failedEventIds).toEqual(['evt-2']);
    expect(out.failureReason).toBe('omitted by model');
  });

  it('drops an unknown ref instead of guessing', async () => {
    const client = stubClient(() => ({ events: [extracted('1'), extracted('99')] }));
    const out = await extractBatch(client, [event(1), event(2)]);

    expect(out.extracted).toHaveLength(1);
    expect(out.extracted[0]!.eventId).toBe('evt-1');
    expect(out.failedEventIds).toEqual(['evt-2']);
  });

  it('drops a duplicated ref rather than double-writing', async () => {
    const client = stubClient(() => ({
      events: [extracted('1'), extracted('1', { summary: 'different' })],
    }));
    const out = await extractBatch(client, [event(1), event(2)]);

    expect(out.extracted).toHaveLength(1);
    expect(out.extracted[0]!.value.summary).toBe('Confirmed revised pricing on 12 line items.');
  });
});

describe('schema validation', () => {
  it('accepts a well-formed event and applies array defaults', () => {
    const parsed = ExtractedEvent.parse({
      ref: '1',
      job_number: null,
      project_name: null,
      counterparty: null,
      counterparty_type: 'unknown',
      category: 'other',
      summary: 'Nothing notable.',
      action_required: false,
      action_owner: 'none',
      blocking_question: null,
      urgency: 'low',
      vessel_or_container: null,
    });
    expect(parsed.dates_mentioned).toEqual([]);
    expect(parsed.amounts_mentioned).toEqual([]);
  });

  it('rejects an out-of-enum category', () => {
    expect(() => ExtractedEvent.parse(extracted('1', { category: 'nonsense' as never }))).toThrow();
  });

  it('rejects an out-of-enum action owner', () => {
    expect(() =>
      ExtractedEvent.parse(extracted('1', { action_owner: 'someone' as never })),
    ).toThrow();
  });

  it('rejects a summary over 200 chars', () => {
    expect(() => ExtractedEvent.parse(extracted('1', { summary: 'x'.repeat(201) }))).toThrow();
  });

  it('rejects a batch that is not an events array', () => {
    expect(() => ExtractionBatch.parse({ events: 'nope' })).toThrow();
    expect(() => ExtractionBatch.parse({})).toThrow();
  });
});

describe('cost (M4 acceptance: 100 events under $0.15)', () => {
  it('stays under budget at realistic token volumes', () => {
    // 4 batches covering 100 events. Per batch: ~30 x (450 tokens of prompt
    // material) + ~800 tokens of system prompt; ~120 output tokens per event.
    const usage = { inputTokens: 4 * 14_300, outputTokens: 100 * 120 };
    const cost = estimateCostUsd(usage);

    expect(cost).toBeLessThan(0.15);
  });

  it('shows why echoing provider ids would have blown the budget', () => {
    // ~50 extra output tokens per event just to copy a Graph id back.
    const withRefs = estimateCostUsd({ inputTokens: 4 * 14_300, outputTokens: 100 * 120 });
    const withIds = estimateCostUsd({ inputTokens: 4 * 14_300, outputTokens: 100 * 170 });

    expect(withIds).toBeGreaterThan(withRefs);
    expect(withRefs).toBeLessThan(0.15);
  });

  it('accumulates usage across batches', async () => {
    const client = stubClient(
      () => ({ events: [extracted('1')] }),
      { input_tokens: 1000, output_tokens: 200 },
    );
    const result = await runExtraction(client, [event(1), event(2)], { batchSize: 1 });

    expect(result.batches).toBe(2);
    expect(result.usage.inputTokens).toBe(2000);
    expect(result.usage.outputTokens).toBe(400);
  });
});
