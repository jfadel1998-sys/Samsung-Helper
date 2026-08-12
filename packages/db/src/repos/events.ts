import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { events, type EventRow, type NewEventRow } from '../schema';

/** Hard cap from §5: body_excerpt is capped at 4000 chars. */
export const BODY_EXCERPT_MAX = 4000;

/**
 * Idempotent bulk upsert (§5).
 *
 * Conflict target is (source, external_id). A re-run of any sync must never
 * duplicate rows, so every write goes through here.
 *
 * `extracted` / `extracted_at` / `prefilter_verdict` are deliberately NOT
 * overwritten: a re-sync of an already-processed message must not throw away
 * the extraction we already paid for.
 */
export async function upsertEvents(db: Db, rows: NewEventRow[]): Promise<EventRow[]> {
  if (rows.length === 0) return [];

  const capped = rows.map((r) => ({
    ...r,
    bodyExcerpt: r.bodyExcerpt ? r.bodyExcerpt.slice(0, BODY_EXCERPT_MAX) : r.bodyExcerpt,
  }));

  // Chunked so a large backfill doesn't blow the parameter limit.
  const out: EventRow[] = [];
  for (let i = 0; i < capped.length; i += 200) {
    const chunk = capped.slice(i, i + 200);
    const res = await db
      .insert(events)
      .values(chunk)
      .onConflictDoUpdate({
        target: [events.source, events.externalId],
        set: {
          accountId: sql`excluded.account_id`,
          threadId: sql`excluded.thread_id`,
          actorName: sql`excluded.actor_name`,
          actorHandle: sql`excluded.actor_handle`,
          subject: sql`excluded.subject`,
          bodyExcerpt: sql`excluded.body_excerpt`,
          url: sql`excluded.url`,
          occurredAt: sql`excluded.occurred_at`,
          isFromOwner: sql`excluded.is_from_owner`,
          raw: sql`excluded.raw`,
        },
      })
      .returning();
    out.push(...res);
  }
  return out;
}

export async function setPrefilterVerdict(db: Db, eventId: string, verdict: string) {
  await db.update(events).set({ prefilterVerdict: verdict }).where(eq(events.id, eventId));
}

/** Batch of events awaiting extraction (§8: batches of 30). */
export async function pendingExtraction(db: Db, limit = 30): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(isNull(events.extracted), eq(events.prefilterVerdict, 'keep')))
    .orderBy(asc(events.occurredAt))
    .limit(limit);
}

export async function saveExtraction(
  db: Db,
  items: Array<{ externalId: string; source: string; extracted: unknown }>,
) {
  for (const item of items) {
    await db
      .update(events)
      .set({ extracted: item.extracted as never, extractedAt: new Date() })
      .where(and(eq(events.source, item.source), eq(events.externalId, item.externalId)));
  }
}

/**
 * Marks a batch as attempted-but-failed so it does not spin forever in the
 * pending queue (§7.2: never let one bad batch kill the brief).
 */
export async function markExtractionFailed(db: Db, eventIds: string[], reason: string) {
  if (eventIds.length === 0) return;
  await db
    .update(events)
    .set({
      extracted: sql`jsonb_build_object('extraction_error', ${reason}::text)`,
      extractedAt: new Date(),
    })
    .where(inArray(events.id, eventIds));
}

/**
 * Of the given thread ids, which already contain a message from the owner.
 *
 * Drives the §7.1 "thread contains a prior owner message" keep rule. Done as
 * one query over the whole batch rather than per-event.
 */
export async function threadsWithOwnerMessages(
  db: Db,
  threadIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(threadIds.filter(Boolean))];
  if (ids.length === 0) return new Set();

  const rows = await db
    .selectDistinct({ threadId: events.threadId })
    .from(events)
    .where(and(inArray(events.threadId, ids), eq(events.isFromOwner, true)));

  return new Set(rows.map((r) => r.threadId).filter((t): t is string => Boolean(t)));
}

/** Events ingested before the prefilter existed, or before a rule change. */
export async function eventsMissingVerdict(db: Db, limit = 500): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(isNull(events.prefilterVerdict))
    .orderBy(asc(events.occurredAt))
    .limit(limit);
}

/** Events in the brief window that carry a usable extraction. */
export async function extractedInWindow(db: Db, from: Date, to: Date): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(
      and(
        gte(events.occurredAt, from),
        lt(events.occurredAt, to),
        eq(events.prefilterVerdict, 'keep'),
        sql`${events.extracted} IS NOT NULL`,
        sql`${events.extracted} -> 'extraction_error' IS NULL`,
      ),
    )
    .orderBy(asc(events.occurredAt));
}
