/**
 * Ranks sender domains by how much they look like a real working
 * relationship, and guesses what kind. Pure — the caller supplies the rows, so
 * this is unit-testable without a database.
 *
 * See docs/counterparties.md. The point is that the allowlist gets generated
 * from mail actually received rather than written from memory.
 */
import { type CounterpartyType } from './counterparties';

export interface SenderObservation {
  actorHandle: string | null;
  threadId: string | null;
  subject: string | null;
  bodyExcerpt: string | null;
  isFromOwner: boolean;
  /** True when the owner has a message in this thread. */
  threadHasOwnerReply: boolean;
}

export interface DomainSuggestion {
  domain: string;
  messages: number;
  threads: number;
  repliedThreads: number;
  senders: string[];
  guess: CounterpartyType;
  /** Vocabulary that drove the guess, for the reviewer. */
  evidence: string[];
  score: number;
  alreadyListed: boolean;
  /** Several threads, never answered — reads as broadcast, probably skip. */
  looksLikeBroadcast: boolean;
}

/**
 * Vocabulary that identifies each counterparty type. Ordered most to least
 * specific — the first type to clear the threshold wins.
 */
const TYPE_SIGNALS: Array<{ type: CounterpartyType; terms: string[] }> = [
  {
    type: 'freight_forwarder',
    terms: [
      'vessel', 'container', 'bill of lading', 'b/l', 'freight', 'forwarder',
      'customs', 'demurrage', 'drayage', 'port', 'sailing', 'eta', 'booking',
      'delivery order', 'chassis', 'terminal',
    ],
  },
  {
    type: 'fabricator',
    terms: [
      'template', 'templating', 'fabrication', 'fabricator', 'shop drawing',
      'cnc', 'polish', 'miter', 'seam', 'install crew', 'cutting', 'edge profile',
    ],
  },
  {
    type: 'supplier',
    terms: [
      'quarry', 'block', 'lot', 'bundle', 'slab', 'crate', 'fob', 'cif',
      'ex-works', 'proforma', 'price list', 'quotation', 'mill', 'finish',
    ],
  },
  {
    type: 'gc',
    terms: [
      'punch list', 'submittal', 'rfi', 'change order', 'schedule', 'jobsite',
      'superintendent', 'general contractor', 'coordination', 'lien', 'pay app',
    ],
  },
  {
    type: 'designer',
    terms: [
      'specification', 'spec', 'rendering', 'mockup', 'selection', 'palette',
      'architect', 'interior design', 'vein match', 'layout approval',
    ],
  },
  {
    type: 'client',
    terms: ['owner', 'developer', 'budget approval', 'resort', 'property', 'asset manager'],
  },
];

const MIN_TERM_HITS = 2;

function domainOfAddress(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

function countTerms(haystack: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const term of terms) {
    const re = new RegExp(`(?<![a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`, 'i');
    if (re.test(haystack)) hits.push(term);
  }
  return hits;
}

export interface SuggestOptions {
  /** Domains already in the config — surfaced but sorted below new ones. */
  known?: Set<string>;
  /** Domains never worth suggesting (your own, plus known notification hosts). */
  ignore?: Set<string>;
  minMessages?: number;
}

export function suggestCounterparties(
  observations: SenderObservation[],
  opts: SuggestOptions = {},
): DomainSuggestion[] {
  const known = opts.known ?? new Set<string>();
  const ignore = opts.ignore ?? new Set<string>();
  const minMessages = opts.minMessages ?? 2;

  interface Bucket {
    messages: number;
    threads: Set<string>;
    repliedThreads: Set<string>;
    senders: Set<string>;
    text: string[];
  }
  const buckets = new Map<string, Bucket>();

  for (const o of observations) {
    // Owner-authored mail says nothing about who the counterparty is.
    if (o.isFromOwner || !o.actorHandle) continue;

    const domain = domainOfAddress(o.actorHandle);
    if (!domain) continue;
    if (ignore.has(domain) || [...ignore].some((d) => domain.endsWith(`.${d}`))) continue;

    const bucket = buckets.get(domain) ?? {
      messages: 0,
      threads: new Set<string>(),
      repliedThreads: new Set<string>(),
      senders: new Set<string>(),
      text: [],
    };

    bucket.messages++;
    bucket.senders.add(o.actorHandle.toLowerCase());
    if (o.threadId) {
      bucket.threads.add(o.threadId);
      if (o.threadHasOwnerReply) bucket.repliedThreads.add(o.threadId);
    }
    // Bounded so one enormous thread cannot dominate the vocabulary guess.
    if (bucket.text.length < 60) {
      bucket.text.push(`${o.subject ?? ''} ${(o.bodyExcerpt ?? '').slice(0, 600)}`);
    }

    buckets.set(domain, bucket);
  }

  const suggestions: DomainSuggestion[] = [];

  for (const [domain, bucket] of buckets) {
    if (bucket.messages < minMessages) continue;

    const haystack = bucket.text.join('\n').toLowerCase();
    let guess: CounterpartyType = 'unknown';
    let evidence: string[] = [];

    for (const signal of TYPE_SIGNALS) {
      const hits = countTerms(haystack, signal.terms);
      if (hits.length >= MIN_TERM_HITS) {
        guess = signal.type;
        evidence = hits.slice(0, 6);
        break;
      }
    }

    // Replying is the strongest evidence of a real relationship, and it has to
    // dominate: a newsletter that lands 30 times a month otherwise outranks a
    // supplier you actually correspond with six times. Both the count and the
    // ratio count, so a domain replied to consistently beats one replied to
    // once out of many.
    //
    // Many threads with zero replies is not merely weak evidence, it is the
    // shape of broadcast mail, so it is penalized rather than ignored.
    const threads = bucket.threads.size;
    const replied = bucket.repliedThreads.size;
    const replyRatio = threads > 0 ? replied / threads : 0;
    const neverAnswered = threads >= 5 && replied === 0;

    const score =
      replied * 25 +
      replyRatio * 40 +
      Math.min(threads, 20) * 2 +
      Math.min(bucket.messages, 40) * 0.5 +
      bucket.senders.size * 2 +
      (guess !== 'unknown' ? 10 : 0) -
      (neverAnswered ? 40 : 0);

    suggestions.push({
      domain,
      messages: bucket.messages,
      threads: bucket.threads.size,
      repliedThreads: bucket.repliedThreads.size,
      senders: [...bucket.senders].sort(),
      guess,
      evidence,
      score,
      alreadyListed: known.has(domain),
      looksLikeBroadcast: neverAnswered,
    });
  }

  return suggestions.sort((a, b) => {
    // New domains first — those are what the reviewer has to act on.
    if (a.alreadyListed !== b.alreadyListed) return a.alreadyListed ? 1 : -1;
    return b.score - a.score || a.domain.localeCompare(b.domain);
  });
}

/** Paste-ready block for the `domains` object in config/counterparties.json. */
export function renderConfigBlock(suggestions: DomainSuggestion[]): string {
  const fresh = suggestions.filter((s) => !s.alreadyListed);
  if (fresh.length === 0) return '  (nothing new)';
  const width = Math.max(...fresh.map((s) => s.domain.length)) + 2;
  return fresh
    .map((s) => `    ${`"${s.domain}":`.padEnd(width + 2)} "${s.guess}",`)
    .join('\n');
}
