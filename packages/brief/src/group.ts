/**
 * §7.3 grouping. Deterministic and done in code, so the model's only job is
 * writing prose — it never decides what belongs where or what is urgent.
 */
import { compareJobNumbers, normalizeJobNumber, type StoredExtraction } from '@hub/extraction';
import type { ThreadWaitRow } from './days-open';

export const URGENCY_ORDER = ['critical', 'high', 'normal', 'low'] as const;

export interface BriefItem {
  eventId: string;
  threadId: string | null;
  occurredAt: Date;
  url: string | null;
  extraction: StoredExtraction;
  /** From the §7.4 SQL, when this item's thread is waiting on someone. */
  daysOpen: number | null;
}

export interface JobGroup {
  jobNumber: string;
  projectName: string | null;
  items: BriefItem[];
}

export interface CounterpartyGroup {
  counterparty: string;
  items: BriefItem[];
}

export interface GroupedBrief {
  /** §7.3 §1: action_required && action_owner === 'jason'. */
  needsYouToday: BriefItem[];
  /** §7.3 §2: one block per job number. */
  byJob: JobGroup[];
  /** §7.3 §3: open blocking questions, with days open. */
  waitingOnOthers: BriefItem[];
  /** §7.3 §4: everything else, one line each. */
  everythingElse: BriefItem[];
  totalItems: number;
}

function urgencyRank(item: BriefItem): number {
  const idx = URGENCY_ORDER.indexOf(item.extraction.urgency as (typeof URGENCY_ORDER)[number]);
  return idx === -1 ? URGENCY_ORDER.length : idx;
}

/** Urgency first, then oldest-first so a long-running item leads its group. */
function byUrgencyThenAge(a: BriefItem, b: BriefItem): number {
  const u = urgencyRank(a) - urgencyRank(b);
  if (u !== 0) return u;
  return a.occurredAt.getTime() - b.occurredAt.getTime();
}

export function groupForBrief(items: BriefItem[]): GroupedBrief {
  const needsYouToday = items
    .filter((i) => i.extraction.action_required && i.extraction.action_owner === 'jason')
    .sort(byUrgencyThenAge);

  const waitingOnOthers = items
    .filter((i) => Boolean(i.extraction.blocking_question) && i.daysOpen !== null)
    .sort((a, b) => (b.daysOpen ?? 0) - (a.daysOpen ?? 0) || byUrgencyThenAge(a, b));

  // An item can legitimately appear in both of the sections above — it is both
  // yours to act on and something you are waiting on. It should not then also
  // reappear in the job blocks and the tail, so those are built from what is
  // left over.
  const alreadyShown = new Set([...needsYouToday, ...waitingOnOthers].map((i) => i.eventId));

  const jobs = new Map<string, JobGroup>();
  const counterparties = new Map<string, CounterpartyGroup>();
  const loose: BriefItem[] = [];

  for (const item of items) {
    if (alreadyShown.has(item.eventId)) continue;

    // Normalize again at grouping time: rows written before normalization
    // existed, or by a future connector, still have to group correctly.
    const job = normalizeJobNumber(item.extraction.job_number);
    if (job) {
      const group = jobs.get(job) ?? {
        jobNumber: job,
        projectName: item.extraction.project_name,
        items: [],
      };
      group.projectName ??= item.extraction.project_name;
      group.items.push(item);
      jobs.set(job, group);
      continue;
    }

    const counterparty = item.extraction.counterparty;
    if (counterparty) {
      const group = counterparties.get(counterparty) ?? { counterparty, items: [] };
      group.items.push(item);
      counterparties.set(counterparty, group);
      continue;
    }

    loose.push(item);
  }

  const byJob = [...jobs.values()]
    .map((g) => ({ ...g, items: g.items.sort(byUrgencyThenAge) }))
    .sort((a, b) => {
      // Most urgent job first; ties broken by job number so ordering is stable
      // across runs on the same data. Numeric, not lexical — otherwise "3310"
      // sorts before "12345" and the list reads as unordered.
      const u = urgencyRank(a.items[0]!) - urgencyRank(b.items[0]!);
      return u !== 0 ? u : compareJobNumbers(a.jobNumber, b.jobNumber);
    });

  // Counterparty groups have no section of their own in §7.3; they are the
  // "loose items" tier, flattened into the tail with their grouping preserved
  // by ordering.
  const everythingElse = [
    ...[...counterparties.values()]
      .sort((a, b) => a.counterparty.localeCompare(b.counterparty))
      .flatMap((g) => g.items.sort(byUrgencyThenAge)),
    ...loose.sort(byUrgencyThenAge),
  ];

  return {
    needsYouToday,
    byJob,
    waitingOnOthers,
    everythingElse,
    totalItems: items.length,
  };
}
