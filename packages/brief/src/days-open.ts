/**
 * §7.4 — days-open, computed in SQL before the LLM sees anything.
 *
 * "Find threads where the newest message is inbound and no owner reply
 * follows; now() - occurred_at is days open."
 *
 * The clock starts at the OLDEST unanswered inbound message after the owner's
 * last reply, not the newest one — otherwise a supplier who chases twice
 * resets their own wait to zero, which is exactly backwards.
 *
 * Date arithmetic never goes to the model. Models are unreliable at it, and
 * "3 days open" is a fact someone will act on.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@hub/db';

export interface ThreadWaitRow {
  threadId: string;
  waitingSince: Date;
  daysOpen: number;
}

const DAYS_OPEN_SQL = sql`
  WITH last_owner AS (
    SELECT thread_id, MAX(occurred_at) AS last_owner_at
    FROM events
    WHERE is_from_owner AND thread_id IS NOT NULL
    GROUP BY thread_id
  ),
  newest AS (
    SELECT DISTINCT ON (thread_id) thread_id, occurred_at, is_from_owner
    FROM events
    WHERE thread_id IS NOT NULL
    ORDER BY thread_id, occurred_at DESC
  ),
  oldest_unanswered AS (
    SELECT e.thread_id, MIN(e.occurred_at) AS waiting_since
    FROM events e
    LEFT JOIN last_owner lo ON lo.thread_id = e.thread_id
    WHERE e.thread_id IS NOT NULL
      AND NOT e.is_from_owner
      AND (lo.last_owner_at IS NULL OR e.occurred_at > lo.last_owner_at)
    GROUP BY e.thread_id
  )
  SELECT
    n.thread_id AS thread_id,
    o.waiting_since AS waiting_since,
    FLOOR(EXTRACT(EPOCH FROM (now() - o.waiting_since)) / 86400)::int AS days_open
  FROM newest n
  JOIN oldest_unanswered o ON o.thread_id = n.thread_id
  WHERE NOT n.is_from_owner
`;

/**
 * Threads currently waiting on someone else, keyed by thread id.
 *
 * A thread whose newest message is from the owner is not waiting — it has been
 * answered — and does not appear.
 */
export async function threadWaits(db: Db): Promise<Map<string, ThreadWaitRow>> {
  const result = await db.execute<{
    thread_id: string;
    waiting_since: string | Date;
    days_open: number;
  }>(DAYS_OPEN_SQL);

  const rows = result as unknown as Array<{
    thread_id: string;
    waiting_since: string | Date;
    days_open: number;
  }>;

  const out = new Map<string, ThreadWaitRow>();
  for (const row of rows) {
    out.set(row.thread_id, {
      threadId: row.thread_id,
      waitingSince:
        row.waiting_since instanceof Date ? row.waiting_since : new Date(row.waiting_since),
      daysOpen: Number(row.days_open),
    });
  }
  return out;
}
