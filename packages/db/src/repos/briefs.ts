import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { briefs, type BriefRow } from '../schema';

export async function saveBrief(
  db: Db,
  input: {
    briefDate: string; // YYYY-MM-DD
    audience: string;
    markdown: string;
    eventIds: string[];
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  },
): Promise<BriefRow> {
  const [row] = await db
    .insert(briefs)
    .values({
      briefDate: input.briefDate,
      audience: input.audience,
      markdown: input.markdown,
      eventIds: input.eventIds,
      model: input.model,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    })
    .onConflictDoUpdate({
      // One brief per audience per day — regenerating replaces that audience's
      // brief without touching anyone else's.
      target: [briefs.briefDate, briefs.audience],
      set: {
        markdown: input.markdown,
        eventIds: input.eventIds,
        model: input.model,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        generatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

export async function getBrief(
  db: Db,
  briefDate: string,
  audience: string,
): Promise<BriefRow | undefined> {
  const [row] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.briefDate, briefDate), eq(briefs.audience, audience)))
    .limit(1);
  return row;
}

/**
 * Which audiences have a brief on a date — keys only, deliberately not rows.
 *
 * The brief page uses this to decide which audience-switcher links to enable.
 * Selecting whole rows there would serialize every other audience's full brief
 * text into this page's payload, so one person's page would carry another
 * person's brief in its source.
 */
export async function audiencesWithBriefOn(db: Db, briefDate: string): Promise<string[]> {
  const rows = await db
    .select({ audience: briefs.audience })
    .from(briefs)
    .where(eq(briefs.briefDate, briefDate));
  return rows.map((r) => r.audience);
}

export async function latestBrief(db: Db, audience?: string): Promise<BriefRow | undefined> {
  const [row] = await db
    .select()
    .from(briefs)
    .where(audience ? eq(briefs.audience, audience) : undefined)
    .orderBy(desc(briefs.briefDate))
    .limit(1);
  return row;
}

export async function listBriefs(db: Db, limit = 30, audience?: string): Promise<BriefRow[]> {
  return db
    .select()
    .from(briefs)
    .where(audience ? eq(briefs.audience, audience) : undefined)
    .orderBy(desc(briefs.briefDate))
    .limit(limit);
}
