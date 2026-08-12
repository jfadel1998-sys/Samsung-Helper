/**
 * Stage 1 — deterministic prefilter (§7.1). No LLM, no network.
 *
 * Runs on ingest and writes `prefilter_verdict`. Cuts volume ~70% at zero cost,
 * so everything downstream only pays for mail that might matter.
 *
 * The rule order is load-bearing: the strong keep rules are evaluated FIRST and
 * win outright. A supplier who sends from a mailing-list platform, or a
 * fabricator whose ticket system sets Auto-Submitted, still reaches the brief.
 *
 * DEVIATION FROM §7.1, deliberate. The spec lists "Owner is in To" among the
 * rules that keep a message "regardless of the above". Taken literally that
 * cancels the newsletter and notification rules almost entirely, because
 * newsletters and system notifications are addressed to you — measured on the
 * fixture corpus it cut volume by 7.6%, against §7.1's stated ~70% target.
 *
 * Read against that target, "owner is in To" is the counterpart to the
 * "owner is not in To/Cc" bulk rule — it separates direct correspondence from
 * broadcast — rather than an override of the content-based rules. So it is
 * applied AFTER the demotion rules, as the default keep for anything that
 * survives them. The genuinely unconditional keeps are: owner-authored,
 * allowlisted counterparty, job number near stone vocabulary, and a thread the
 * owner has already replied in.
 */
import {
  counterpartyConfig,
  counterpartyTypeFor,
  domainOf,
  type CounterpartyConfig,
} from '@hub/config';
import { findJobNumbers } from '@hub/extraction';

export type PrefilterVerdict = 'keep' | 'newsletter' | 'notification' | 'bulk';

/** The subset of a NormalizedEvent the prefilter reads. Keeps this pure. */
export interface PrefilterInput {
  actorHandle: string | null;
  subject: string | null;
  bodyExcerpt: string | null;
  isFromOwner: boolean;
  signals: {
    listUnsubscribe: boolean;
    autoSubmitted: boolean;
    categories: string[];
    toAddresses: string[];
    ccAddresses: string[];
    emptyBody: boolean;
    headersAvailable: boolean;
  };
}

export interface PrefilterContext {
  /** Lower-cased owner addresses. */
  ownerEmails: string[];
  /**
   * True when the thread already contains a message from the owner. Supplied by
   * the caller (a DB lookup) so this module stays pure and unit-testable.
   */
  threadHasOwnerMessage?: boolean;
  config?: CounterpartyConfig;
}

export interface PrefilterResult {
  verdict: PrefilterVerdict;
  /** Which rule decided it — surfaced in tests and on the ops page. */
  reason: string;
}

/** How close a keyword must be to a bare job number to count as a real reference. */
const KEYWORD_PROXIMITY_CHARS = 120;

const GMAIL_DEMOTED_CATEGORIES = new Set([
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
]);

const KEYWORD_RE_CACHE = new WeakMap<object, RegExp>();

/**
 * Keywords match on word boundaries, not as substrings.
 *
 * The list contains short trade abbreviations — "po", "bl", "lot" — and a
 * substring test makes "po" match "posted", "reported", and "postponed", which
 * turns the job-number proximity rule into a rule that fires on almost any
 * mail containing a four-digit number.
 */
function keywordRegex(cfg: CounterpartyConfig): RegExp | null {
  let re = KEYWORD_RE_CACHE.get(cfg);
  if (!re) {
    const needles = [...cfg.stoneKeywords, ...cfg.projectKeywords].filter(Boolean);
    if (needles.length === 0) return null;
    const alternation = needles
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .sort((a, b) => b.length - a.length)
      .join('|');
    re = new RegExp(`(?<![a-z0-9])(?:${alternation})(?![a-z0-9])`, 'i');
    KEYWORD_RE_CACHE.set(cfg, re);
  }
  return re;
}

/**
 * True when a job-number-shaped token appears near stone/project vocabulary.
 * The subject is treated as one context window, since a subject line is short
 * enough that any keyword in it is "near" any number in it.
 */
export function looksLikeJobReference(
  subject: string | null,
  body: string | null,
  cfg: CounterpartyConfig,
): boolean {
  const keywords = keywordRegex(cfg);
  if (!keywords) return false;

  for (const [text, isSubject] of [
    [(subject ?? '').toLowerCase(), true],
    [(body ?? '').toLowerCase(), false],
  ] as Array<[string, boolean]>) {
    if (!text) continue;

    for (const match of findJobNumbers(text)) {
      // An explicit marker ("job 2269.2", "#2269.2") is unambiguous on its own.
      if (match.confidence === 'marked') return true;

      // A bare number needs supporting vocabulary. A subject line is short
      // enough that any keyword in it counts as nearby; in a body the keyword
      // has to sit within the proximity window.
      const window = isSubject
        ? text
        : text.slice(
            Math.max(0, match.index - KEYWORD_PROXIMITY_CHARS),
            match.index + match.raw.length + KEYWORD_PROXIMITY_CHARS,
          );
      if (keywords.test(window)) return true;
    }
  }

  return false;
}

/** Canonical job numbers referenced anywhere in a message. */
export function jobNumbersIn(subject: string | null, body: string | null): string[] {
  const found = [...findJobNumbers(subject ?? ''), ...findJobNumbers(body ?? '')];
  return [...new Set(found.map((m) => m.value))];
}

function isNotificationSender(address: string | null, cfg: CounterpartyConfig): boolean {
  if (!address) return false;
  const addr = address.toLowerCase();
  if (cfg.notificationSenders.some((prefix) => addr.startsWith(prefix))) return true;

  const domain = domainOf(addr);
  if (!domain) return false;
  return cfg.notificationDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/**
 * Classify one event.
 *
 * Keep rules run first and are absolute — that ordering is what stops a real
 * counterparty from being filtered out by a generic bulk-mail heuristic.
 */
export function prefilter(input: PrefilterInput, ctx: PrefilterContext): PrefilterResult {
  const cfg = ctx.config ?? counterpartyConfig();
  const owners = new Set(ctx.ownerEmails.map((e) => e.trim().toLowerCase()));
  const { signals } = input;

  // ── Keep rules (§7.1, "regardless of the above") ────────────────────────
  if (input.isFromOwner) {
    return { verdict: 'keep', reason: 'sent by owner' };
  }

  const counterparty = counterpartyTypeFor(input.actorHandle, cfg);
  if (counterparty) {
    return { verdict: 'keep', reason: `allowlisted counterparty (${counterparty})` };
  }

  if (looksLikeJobReference(input.subject, input.bodyExcerpt, cfg)) {
    return { verdict: 'keep', reason: 'job number near stone/project keyword' };
  }

  if (ctx.threadHasOwnerMessage) {
    return { verdict: 'keep', reason: 'thread contains a prior owner message' };
  }

  // ── Demotion rules ───────────────────────────────────────────────────────
  if (signals.listUnsubscribe) {
    return { verdict: 'newsletter', reason: 'List-Unsubscribe header' };
  }

  if (signals.categories.some((c) => GMAIL_DEMOTED_CATEGORIES.has(c))) {
    return { verdict: 'newsletter', reason: 'Gmail promotional/social/updates category' };
  }

  if (signals.autoSubmitted) {
    return { verdict: 'notification', reason: 'Auto-Submitted (bounce or auto-reply)' };
  }

  if (isNotificationSender(input.actorHandle, cfg)) {
    return { verdict: 'notification', reason: 'known notification sender' };
  }

  // A calendar invite with no body text carries nothing to extract.
  if (signals.emptyBody) {
    return { verdict: 'notification', reason: 'no body text' };
  }

  const ownerInTo = signals.toAddresses.some((a) => owners.has(a));
  const ownerInCc = signals.ccAddresses.some((a) => owners.has(a));
  if (!ownerInTo && !ownerInCc) {
    // Owner is not addressed and never replied — this is broadcast mail.
    return { verdict: 'bulk', reason: 'owner not in To/Cc and no owner reply in thread' };
  }

  // Survived every demotion rule and is addressed to the owner: direct human
  // correspondence, which is exactly what the brief is for.
  return { verdict: 'keep', reason: ownerInTo ? 'owner in To' : 'owner in Cc' };
}
