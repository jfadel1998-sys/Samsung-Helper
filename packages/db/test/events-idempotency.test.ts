import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVault } from '@hub/crypto';
import { upsertAccount } from '../src/repos/accounts';
import {
  extractedInWindow,
  markExtractionFailed,
  pendingExtraction,
  saveExtraction,
  setPrefilterVerdict,
  upsertEvents,
} from '../src/repos/events';
import type { Db } from '../src/client';
import type { NewEventRow } from '../src/schema';
import { closeTestDb, connectTestDb, hasTestDb, truncateAll } from './helpers';

const vault = createVault(randomBytes(32).toString('base64'));

function message(n: number, over: Partial<NewEventRow> = {}): NewEventRow {
  return {
    accountId: null,
    source: 'outlook',
    type: 'email',
    externalId: `msg-${n}`,
    threadId: `thread-${n % 3}`,
    actorName: 'T. Nickolas',
    actorHandle: 'nickolas@example-supplier.com',
    subject: `2269.2 GVR Local Stone — line ${n}`,
    bodyExcerpt: `Revised pricing on line item ${n}.`,
    url: `https://outlook.office.com/mail/id/msg-${n}`,
    occurredAt: new Date(Date.UTC(2026, 7, 10, 12, n % 60)),
    isFromOwner: false,
    raw: { id: `msg-${n}` },
    ...over,
  };
}

async function countEvents(db: Db): Promise<number> {
  const res = await db.execute<{ n: string }>(sql`select count(*)::text as n from events`);
  return Number((res as unknown as Array<{ n: string }>)[0]!.n);
}

describe.skipIf(!hasTestDb)('events idempotency', () => {
  let db: Db;

  beforeAll(async () => {
    db = await connectTestDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await truncateAll(db);
  });

  // §11: run the same sync twice, assert row count unchanged.
  it('re-running the same sync does not duplicate rows', async () => {
    const batch = Array.from({ length: 25 }, (_, i) => message(i));

    await upsertEvents(db, batch);
    expect(await countEvents(db)).toBe(25);

    await upsertEvents(db, batch);
    await upsertEvents(db, batch);
    expect(await countEvents(db)).toBe(25);
  });

  it('is idempotent across chunk boundaries', async () => {
    // upsertEvents chunks at 200; use more than that to cross a boundary.
    const batch = Array.from({ length: 450 }, (_, i) => message(i));
    await upsertEvents(db, batch);
    expect(await countEvents(db)).toBe(450);
    await upsertEvents(db, batch);
    expect(await countEvents(db)).toBe(450);
  });

  it('the same external id under a different source is a distinct event', async () => {
    await upsertEvents(db, [message(1), message(1, { source: 'gmail' })]);
    expect(await countEvents(db)).toBe(2);
  });

  it('a re-sync refreshes mutable fields', async () => {
    await upsertEvents(db, [message(1, { subject: 'original' })]);
    const [updated] = await upsertEvents(db, [message(1, { subject: 'edited subject' })]);
    expect(updated!.subject).toBe('edited subject');
    expect(await countEvents(db)).toBe(1);
  });

  // The expensive half of the pipeline must survive a re-sync.
  it('a re-sync preserves prefilter verdict and extraction', async () => {
    const [row] = await upsertEvents(db, [message(1)]);
    await setPrefilterVerdict(db, row!.id, 'keep');
    await saveExtraction(db, [
      { source: 'outlook', externalId: 'msg-1', extracted: { job_number: '2269.2' } },
    ]);

    await upsertEvents(db, [message(1)]);

    const after = await extractedInWindow(
      db,
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 7, 20)),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.extracted).toEqual({ job_number: '2269.2' });
    expect(after[0]!.prefilterVerdict).toBe('keep');
  });

  it('batches empty input without touching the database', async () => {
    expect(await upsertEvents(db, [])).toEqual([]);
    expect(await countEvents(db)).toBe(0);
  });

  it('caps body_excerpt at 4000 chars', async () => {
    const [row] = await upsertEvents(db, [message(1, { bodyExcerpt: 'x'.repeat(9000) })]);
    expect(row!.bodyExcerpt).toHaveLength(4000);
  });

  it('cascades deletes from accounts', async () => {
    const acct = await upsertAccount(db, {
      provider: 'outlook',
      externalId: 'u1',
      encryptedTokens: vault.encryptTokens({ accessToken: 'a' }),
      scopes: ['Mail.Read'],
    });
    await upsertEvents(db, [message(1, { accountId: acct.id })]);
    await db.execute(sql`delete from accounts where id = ${acct.id}::uuid`);
    expect(await countEvents(db)).toBe(0);
  });
});

describe.skipIf(!hasTestDb)('extraction queue', () => {
  let db: Db;

  beforeAll(async () => {
    db = await connectTestDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await truncateAll(db);
  });

  it('only surfaces kept, unextracted events, oldest first', async () => {
    const rows = await upsertEvents(db, [message(1), message(2), message(3), message(4)]);
    await setPrefilterVerdict(db, rows[0]!.id, 'keep');
    await setPrefilterVerdict(db, rows[1]!.id, 'keep');
    await setPrefilterVerdict(db, rows[2]!.id, 'newsletter');
    // rows[3] deliberately left unfiltered

    const pending = await pendingExtraction(db, 30);
    expect(pending.map((r) => r.externalId)).toEqual(['msg-1', 'msg-2']);

    await saveExtraction(db, [
      { source: 'outlook', externalId: 'msg-1', extracted: { job_number: '2269.2' } },
    ]);
    expect((await pendingExtraction(db, 30)).map((r) => r.externalId)).toEqual(['msg-2']);
  });

  it('respects the batch size', async () => {
    const rows = await upsertEvents(db, Array.from({ length: 40 }, (_, i) => message(i)));
    for (const r of rows) await setPrefilterVerdict(db, r.id, 'keep');
    expect(await pendingExtraction(db, 30)).toHaveLength(30);
  });

  // §7.2: one bad batch must not spin forever in the queue.
  it('a failed batch leaves the queue instead of retrying forever', async () => {
    const rows = await upsertEvents(db, [message(1), message(2)]);
    for (const r of rows) await setPrefilterVerdict(db, r.id, 'keep');

    await markExtractionFailed(
      db,
      rows.map((r) => r.id),
      'zod validation failed twice',
    );

    expect(await pendingExtraction(db, 30)).toHaveLength(0);

    // ...and failed rows are excluded from the brief rather than fed to it as junk.
    const forBrief = await extractedInWindow(
      db,
      new Date(Date.UTC(2026, 7, 1)),
      new Date(Date.UTC(2026, 7, 20)),
    );
    expect(forBrief).toHaveLength(0);
  });
});
