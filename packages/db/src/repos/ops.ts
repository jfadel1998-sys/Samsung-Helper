import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { accounts, events, syncState, type AccountRow, type SyncStateRow } from '../schema';

export interface AccountHealth {
  account: AccountRow;
  state: SyncStateRow | undefined;
  eventCount: number;
  lastEventAt: Date | null;
}

/** Everything the /ops page needs, in one pass. */
export async function accountHealth(db: Db): Promise<AccountHealth[]> {
  const rows = await db
    .select({
      account: accounts,
      state: syncState,
      eventCount: sql<string>`(
        SELECT count(*) FROM ${events} WHERE ${events.accountId} = ${accounts.id}
      )`,
      lastEventAt: sql<Date | null>`(
        SELECT max(${events.occurredAt}) FROM ${events} WHERE ${events.accountId} = ${accounts.id}
      )`,
    })
    .from(accounts)
    .leftJoin(syncState, eq(syncState.accountId, accounts.id))
    .orderBy(desc(accounts.createdAt));

  return rows.map((r) => ({
    account: r.account,
    state: r.state ?? undefined,
    eventCount: Number(r.eventCount ?? 0),
    lastEventAt: r.lastEventAt ? new Date(r.lastEventAt) : null,
  }));
}

export interface PipelineStats {
  totalEvents: number;
  keptEvents: number;
  pendingExtraction: number;
  failedExtraction: number;
  eventsLast24h: number;
}

export async function pipelineStats(db: Db): Promise<PipelineStats> {
  const result = (await db.execute<Record<string, string>>(sql`
    SELECT
      count(*)::text AS total_events,
      count(*) FILTER (WHERE prefilter_verdict = 'keep')::text AS kept_events,
      count(*) FILTER (
        WHERE prefilter_verdict = 'keep' AND extracted IS NULL
      )::text AS pending_extraction,
      count(*) FILTER (
        WHERE extracted -> 'extraction_error' IS NOT NULL
      )::text AS failed_extraction,
      count(*) FILTER (WHERE occurred_at > now() - interval '24 hours')::text AS events_last_24h
    FROM events
  `)) as unknown as Array<Record<string, string>>;

  const row = result[0] ?? {};
  return {
    totalEvents: Number(row.total_events ?? 0),
    keptEvents: Number(row.kept_events ?? 0),
    pendingExtraction: Number(row.pending_extraction ?? 0),
    failedExtraction: Number(row.failed_extraction ?? 0),
    eventsLast24h: Number(row.events_last_24h ?? 0),
  };
}
