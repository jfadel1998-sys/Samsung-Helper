import { desc, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { briefs, type BriefRow } from '../schema';

export async function saveBrief(
  db: Db,
  input: {
    briefDate: string; // YYYY-MM-DD
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
      markdown: input.markdown,
      eventIds: input.eventIds,
      model: input.model,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    })
    .onConflictDoUpdate({
      target: briefs.briefDate,
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

export async function getBrief(db: Db, briefDate: string): Promise<BriefRow | undefined> {
  const [row] = await db.select().from(briefs).where(eq(briefs.briefDate, briefDate)).limit(1);
  return row;
}

export async function latestBrief(db: Db): Promise<BriefRow | undefined> {
  const [row] = await db.select().from(briefs).orderBy(desc(briefs.briefDate)).limit(1);
  return row;
}

export async function listBriefs(db: Db, limit = 30): Promise<BriefRow[]> {
  return db.select().from(briefs).orderBy(desc(briefs.briefDate)).limit(limit);
}
