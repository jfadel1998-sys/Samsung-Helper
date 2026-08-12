import { extractedInWindow, getBrief, saveBrief, type BriefRow, type Db } from '@hub/db';
import type { StoredExtraction } from '@hub/extraction';
import { threadWaits } from './days-open';
import { groupForBrief, type BriefItem } from './group';
import {
  defaultSynthesisClient,
  lintBrief,
  synthesize,
  type MessagesCreateClient,
} from './synthesize';

/** §8: the brief window runs from the previous brief time to now. */
export const DEFAULT_WINDOW_HOURS = 24;

export interface GenerateBriefOptions {
  briefDate: string;
  /** Whose brief. Scopes which mailboxes contribute and who "you" is. */
  audience: string;
  /** Label used in the prompt so the model addresses the right person. */
  audienceLabel?: string;
  from: Date;
  to: Date;
  client?: MessagesCreateClient;
}

export interface GenerateBriefResult {
  brief: BriefRow;
  itemCount: number;
  lintWarnings: string[];
  elapsedMs: number;
}

function isUsable(extracted: unknown): extracted is StoredExtraction {
  return (
    typeof extracted === 'object' &&
    extracted !== null &&
    !('extraction_error' in extracted) &&
    'summary' in extracted
  );
}

/**
 * Runs stage 3 end to end for one audience: pull that audience's extractions
 * from the window, attach days-open from SQL, group deterministically,
 * synthesize, persist.
 */
export async function generateBrief(
  db: Db,
  opts: GenerateBriefOptions,
): Promise<GenerateBriefResult> {
  const startedAt = Date.now();

  const [rows, waits] = await Promise.all([
    extractedInWindow(db, opts.from, opts.to, opts.audience),
    threadWaits(db),
  ]);

  const items: BriefItem[] = [];
  for (const row of rows) {
    if (!isUsable(row.extracted)) continue;
    const wait = row.threadId ? waits.get(row.threadId) : undefined;
    items.push({
      eventId: row.id,
      threadId: row.threadId,
      occurredAt: row.occurredAt,
      url: row.url,
      extraction: row.extracted,
      daysOpen: wait ? wait.daysOpen : null,
    });
  }

  const grouped = groupForBrief(items, opts.audience);
  const client = opts.client ?? defaultSynthesisClient();

  const result =
    items.length === 0
      ? {
          // Nothing to synthesize — do not pay for a model call to be told so.
          markdown: '_No actionable mail in this window._',
          model: 'none',
          inputTokens: 0,
          outputTokens: 0,
        }
      : await synthesize(client, grouped, opts.briefDate, opts.audienceLabel ?? opts.audience);

  const brief = await saveBrief(db, {
    briefDate: opts.briefDate,
    audience: opts.audience,
    markdown: result.markdown,
    eventIds: items.map((i) => i.eventId),
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  return {
    brief,
    itemCount: items.length,
    lintWarnings: lintBrief(result.markdown),
    elapsedMs: Date.now() - startedAt,
  };
}

/** YYYY-MM-DD for a date in the given IANA timezone. */
export function briefDateFor(when: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(when);
}

/**
 * The window is "previous brief time -> now" (§8). The previous brief's own
 * timestamp is the anchor, so a missed or delayed run picks up the gap rather
 * than dropping it. Anchored per audience, since one person's brief may have
 * been generated when another's was not.
 */
export async function resolveWindow(
  db: Db,
  now: Date,
  briefDate: string,
  audience: string,
): Promise<{ from: Date; to: Date }> {
  const previous = await previousBrief(db, briefDate, audience);
  const from = previous
    ? previous.generatedAt
    : new Date(now.getTime() - DEFAULT_WINDOW_HOURS * 3600_000);
  return { from, to: now };
}

async function previousBrief(
  db: Db,
  briefDate: string,
  audience: string,
): Promise<BriefRow | undefined> {
  const previousDate = new Date(`${briefDate}T00:00:00Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  return getBrief(db, previousDate.toISOString().slice(0, 10), audience);
}
