/**
 * §7.4 days-open, exercised against a real Postgres. The whole point of this
 * module is that the SQL is correct, so an in-memory fake would test nothing.
 */
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, upsertEvents, type Db, type NewEventRow } from '@hub/db';
import { threadWaits } from '../src/days-open';
import { generateBrief } from '../src/generate';
import type { MessagesCreateClient } from '../src/synthesize';

const require = createRequire(import.meta.url);
const migrationsFolder = resolve(dirname(require.resolve('@hub/db/package.json')), 'migrations');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const hasDb = Boolean(TEST_DATABASE_URL);

const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function msg(over: Partial<NewEventRow> & { externalId: string }): NewEventRow {
  return {
    accountId: null,
    source: 'outlook',
    type: 'email',
    threadId: 'thread-1',
    actorName: 'T. Nickolas',
    actorHandle: 'nickolas@example-supplier.com',
    subject: '2269.2 GVR',
    bodyExcerpt: 'body',
    url: null,
    occurredAt: daysAgo(1),
    isFromOwner: false,
    prefilterVerdict: 'keep',
    raw: {},
    ...over,
  };
}

const EXTRACTION = {
  external_id: 'x',
  job_number: '2269.2',
  project_name: 'GVR Local Stone',
  counterparty: 'T. Nickolas',
  counterparty_type: 'supplier',
  category: 'pricing',
  summary: 'Waiting on FOB clarification.',
  action_required: true,
  action_owner: 'jason',
  blocking_question: 'FOB Livorno or ex-works Carrara?',
  urgency: 'high',
  dates_mentioned: [],
  amounts_mentioned: [],
  vessel_or_container: null,
};

describe.skipIf(!hasDb)('days-open SQL (§7.4)', () => {
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    const conn = createDb(TEST_DATABASE_URL!, { max: 2 });
    db = conn.db;
    end = async () => void (await conn.sql.end());
    await migrate(db, { migrationsFolder });
  });
  afterAll(async () => end());
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE events, sync_state, briefs, accounts CASCADE`);
  });

  it('counts days from the oldest unanswered inbound message', async () => {
    await upsertEvents(db, [
      msg({ externalId: 'a', occurredAt: daysAgo(9), isFromOwner: true }),
      msg({ externalId: 'b', occurredAt: daysAgo(3) }),
      msg({ externalId: 'c', occurredAt: daysAgo(1) }),
    ]);

    const waits = await threadWaits(db);
    // A supplier chasing twice must not reset their own wait — the clock runs
    // from the first unanswered message (3 days), not the latest (1 day).
    expect(waits.get('thread-1')?.daysOpen).toBe(3);
  });

  it('reports nothing for a thread the owner answered last', async () => {
    await upsertEvents(db, [
      msg({ externalId: 'a', occurredAt: daysAgo(5) }),
      msg({ externalId: 'b', occurredAt: daysAgo(2), isFromOwner: true }),
    ]);
    expect(await threadWaits(db)).toEqual(new Map());
  });

  it('handles a thread with no owner message at all', async () => {
    await upsertEvents(db, [
      msg({ externalId: 'a', occurredAt: daysAgo(6) }),
      msg({ externalId: 'b', occurredAt: daysAgo(2) }),
    ]);
    expect((await threadWaits(db)).get('thread-1')?.daysOpen).toBe(6);
  });

  it('restarts the clock after the owner replies mid-thread', async () => {
    await upsertEvents(db, [
      msg({ externalId: 'a', occurredAt: daysAgo(20) }),
      msg({ externalId: 'b', occurredAt: daysAgo(10), isFromOwner: true }),
      msg({ externalId: 'c', occurredAt: daysAgo(4) }),
    ]);
    // Not 20 — the owner answered at day 10, so the current wait is 4 days.
    expect((await threadWaits(db)).get('thread-1')?.daysOpen).toBe(4);
  });

  it('tracks several threads independently', async () => {
    await upsertEvents(db, [
      msg({ externalId: 'a', threadId: 't1', occurredAt: daysAgo(2) }),
      msg({ externalId: 'b', threadId: 't2', occurredAt: daysAgo(7) }),
      msg({ externalId: 'c', threadId: 't3', occurredAt: daysAgo(1), isFromOwner: true }),
    ]);

    const waits = await threadWaits(db);
    expect(waits.get('t1')?.daysOpen).toBe(2);
    expect(waits.get('t2')?.daysOpen).toBe(7);
    expect(waits.has('t3')).toBe(false);
  });

  it('ignores events with no thread id', async () => {
    await upsertEvents(db, [msg({ externalId: 'a', threadId: null, occurredAt: daysAgo(5) })]);
    expect(await threadWaits(db)).toEqual(new Map());
  });
});

describe.skipIf(!hasDb)('generateBrief end to end', () => {
  let db: Db;
  let end: () => Promise<void>;

  beforeAll(async () => {
    const conn = createDb(TEST_DATABASE_URL!, { max: 2 });
    db = conn.db;
    end = async () => void (await conn.sql.end());
    await migrate(db, { migrationsFolder });
  });
  afterAll(async () => end());
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE events, sync_state, briefs, accounts CASCADE`);
  });

  function client(text: string) {
    const calls: Record<string, unknown>[] = [];
    const c: MessagesCreateClient & { calls: Record<string, unknown>[] } = {
      calls,
      create: vi.fn(async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          content: [{ type: 'text', text }],
          usage: { input_tokens: 1200, output_tokens: 400 },
        };
      }),
    };
    return c;
  }

  it('persists a brief row with event ids and token counts', async () => {
    const rows = await upsertEvents(db, [
      msg({ externalId: 'a', occurredAt: daysAgo(1) }),
      msg({ externalId: 'b', occurredAt: daysAgo(2), threadId: 'thread-2' }),
    ]);
    await db.execute(
      sql`UPDATE events SET extracted = ${JSON.stringify(EXTRACTION)}::jsonb, extracted_at = now()`,
    );

    const c = client('## Needs you today\n- **2269.2 GVR Local Stone** — FOB clarification pending (2 days open).');
    const result = await generateBrief(db, {
      briefDate: '2026-08-11',
      from: daysAgo(7),
      to: new Date(NOW.getTime() + 1000),
      client: c,
    });

    expect(result.itemCount).toBe(2);
    expect(result.brief.briefDate).toBe('2026-08-11');
    expect(result.brief.eventIds.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(result.brief.model).toBe('claude-sonnet-5');
    expect(result.brief.inputTokens).toBe(1200);
    expect(result.brief.outputTokens).toBe(400);
    expect(result.lintWarnings).toEqual([]);
  });

  it('excludes events whose extraction failed', async () => {
    await upsertEvents(db, [
      msg({ externalId: 'good', occurredAt: daysAgo(1) }),
      msg({ externalId: 'bad', occurredAt: daysAgo(1), threadId: 'thread-2' }),
    ]);
    await db.execute(
      sql`UPDATE events SET extracted = ${JSON.stringify(EXTRACTION)}::jsonb WHERE external_id = 'good'`,
    );
    await db.execute(
      sql`UPDATE events SET extracted = jsonb_build_object('extraction_error', 'zod failed') WHERE external_id = 'bad'`,
    );

    const result = await generateBrief(db, {
      briefDate: '2026-08-11',
      from: daysAgo(7),
      to: new Date(NOW.getTime() + 1000),
      client: client('## Everything else\n- one thing'),
    });

    expect(result.itemCount).toBe(1);
  });

  it('does not call the model when the window is empty', async () => {
    const c = client('should not be used');
    const result = await generateBrief(db, {
      briefDate: '2026-08-11',
      from: daysAgo(7),
      to: NOW,
      client: c,
    });

    expect(c.calls).toHaveLength(0);
    expect(result.brief.model).toBe('none');
    expect(result.brief.inputTokens).toBe(0);
    expect(result.itemCount).toBe(0);
  });

  it('regenerating the same date replaces rather than duplicating', async () => {
    await upsertEvents(db, [msg({ externalId: 'a', occurredAt: daysAgo(1) })]);
    await db.execute(
      sql`UPDATE events SET extracted = ${JSON.stringify(EXTRACTION)}::jsonb`,
    );

    const opts = { briefDate: '2026-08-11', from: daysAgo(7), to: new Date(NOW.getTime() + 1000) };
    await generateBrief(db, { ...opts, client: client('first version') });
    const second = await generateBrief(db, { ...opts, client: client('second version') });

    expect(second.brief.markdown).toBe('second version');
    const count = (await db.execute<{ n: string }>(
      sql`select count(*)::text as n from briefs`,
    )) as unknown as Array<{ n: string }>;
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('surfaces a style violation without failing the brief', async () => {
    await upsertEvents(db, [msg({ externalId: 'a', occurredAt: daysAgo(1) })]);
    await db.execute(sql`UPDATE events SET extracted = ${JSON.stringify(EXTRACTION)}::jsonb`);

    const result = await generateBrief(db, {
      briefDate: '2026-08-11',
      from: daysAgo(7),
      to: new Date(NOW.getTime() + 1000),
      client: client('You have 14 unread emails and 3 meetings today.'),
    });

    expect(result.lintWarnings).toContain('counts unread mail');
    // Still persisted — a bad brief is a prompt problem, not a pipeline failure.
    expect(result.brief.markdown).toContain('14 unread');
  });

  it('completes well inside the 60s M5 target', async () => {
    await upsertEvents(
      db,
      Array.from({ length: 60 }, (_, i) =>
        msg({ externalId: `e${i}`, threadId: `t${i % 7}`, occurredAt: daysAgo(1) }),
      ),
    );
    await db.execute(sql`UPDATE events SET extracted = ${JSON.stringify(EXTRACTION)}::jsonb`);

    const result = await generateBrief(db, {
      briefDate: '2026-08-11',
      from: daysAgo(7),
      to: new Date(NOW.getTime() + 1000),
      client: client('## Everything else\n- items'),
    });

    // Everything except the single model call is local work.
    expect(result.elapsedMs).toBeLessThan(60_000);
    expect(result.itemCount).toBe(60);
  });
});
