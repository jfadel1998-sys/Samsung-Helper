import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCounterpartyConfig } from '@hub/config';
import { looksLikeJobReference, prefilter } from '../src/prefilter';
import { CORPUS, OWNER_EMAILS, type LabeledMessage } from './fixtures/corpus';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = loadCounterpartyConfig(resolve(here, 'fixtures/counterparties.test.json'));

function classify(m: LabeledMessage) {
  return prefilter(m.input, {
    ownerEmails: OWNER_EMAILS,
    ...(m.threadHasOwnerMessage ? { threadHasOwnerMessage: true } : {}),
    config: cfg,
  });
}

describe('prefilter corpus (M4 acceptance)', () => {
  it('has a corpus of at least 100 labeled messages', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(100);
    expect(CORPUS.filter((m) => m.label === 'actionable').length).toBeGreaterThan(20);
    expect(new Set(CORPUS.map((m) => m.id)).size).toBe(CORPUS.length);
  });

  // M4: "prefilter keeps >=95% of genuinely actionable mail in the fixture set"
  it('keeps at least 95% of genuinely actionable mail', () => {
    const actionable = CORPUS.filter((m) => m.label === 'actionable');
    const missed = actionable.filter((m) => classify(m).verdict !== 'keep');

    const recall = (actionable.length - missed.length) / actionable.length;

    if (missed.length > 0) {
      console.error(
        'Actionable mail dropped by the prefilter:\n' +
          missed.map((m) => `  ${m.id}: ${m.note} -> ${classify(m).verdict}`).join('\n'),
      );
    }

    expect(recall).toBeGreaterThanOrEqual(0.95);
  });

  it('reports precision and volume reduction', () => {
    const kept = CORPUS.filter((m) => classify(m).verdict === 'keep');
    const keptActionable = kept.filter((m) => m.label === 'actionable');

    const precision = kept.length === 0 ? 1 : keptActionable.length / kept.length;
    const reduction = 1 - kept.length / CORPUS.length;

    console.log(
      `prefilter: ${CORPUS.length} messages -> ${kept.length} kept ` +
        `(precision ${(precision * 100).toFixed(1)}%, volume cut ${(reduction * 100).toFixed(1)}%)`,
    );

    // §7.1 targets roughly a 70% cut. Precision matters less than recall here:
    // a false keep costs a fraction of a cent, a false drop loses real work.
    expect(reduction).toBeGreaterThanOrEqual(0.5);
    expect(precision).toBeGreaterThanOrEqual(0.6);
  });

  it('assigns a demotion reason to everything it drops', () => {
    for (const m of CORPUS) {
      const { verdict, reason } = classify(m);
      expect(reason.length).toBeGreaterThan(0);
      expect(['keep', 'newsletter', 'notification', 'bulk']).toContain(verdict);
    }
  });
});

describe('prefilter keep rules override demotions (§7.1)', () => {
  const base = {
    actorHandle: 'm.rossi@example-supplier.it',
    subject: 'Container booking',
    bodyExcerpt: 'Booking confirmed.',
    isFromOwner: false,
    signals: {
      listUnsubscribe: false,
      autoSubmitted: false,
      categories: [] as string[],
      toAddresses: ['jason@traxtone.com'],
      ccAddresses: [] as string[],
      emptyBody: false,
      headersAvailable: true,
    },
  };

  it('keeps an allowlisted counterparty despite List-Unsubscribe', () => {
    const r = prefilter(
      { ...base, signals: { ...base.signals, listUnsubscribe: true } },
      { ownerEmails: OWNER_EMAILS, config: cfg },
    );
    expect(r.verdict).toBe('keep');
    expect(r.reason).toContain('allowlisted');
  });

  it('keeps an allowlisted counterparty despite a Promotions label', () => {
    const r = prefilter(
      { ...base, signals: { ...base.signals, categories: ['CATEGORY_PROMOTIONS'] } },
      { ownerEmails: OWNER_EMAILS, config: cfg },
    );
    expect(r.verdict).toBe('keep');
  });

  it('keeps an allowlisted counterparty despite Auto-Submitted', () => {
    const r = prefilter(
      { ...base, signals: { ...base.signals, autoSubmitted: true } },
      { ownerEmails: OWNER_EMAILS, config: cfg },
    );
    expect(r.verdict).toBe('keep');
  });

  it('matches a parent domain for a subdomain sender', () => {
    const r = prefilter(
      { ...base, actorHandle: 'noreply@mail.example-supplier.it' },
      { ownerEmails: OWNER_EMAILS, config: cfg },
    );
    expect(r.verdict).toBe('keep');
  });

  it('demotes the same message from an unknown sender', () => {
    const r = prefilter(
      {
        ...base,
        actorHandle: 'random@unrelated-example.com',
        subject: 'Booking',
        bodyExcerpt: 'Booking confirmed.',
        signals: { ...base.signals, listUnsubscribe: true },
      },
      { ownerEmails: OWNER_EMAILS, config: cfg },
    );
    expect(r.verdict).toBe('newsletter');
  });
});

describe('job-number detection', () => {
  it('matches a decimal job number near stone vocabulary', () => {
    expect(looksLikeJobReference('Quote for 2269.2', 'slab pricing attached', cfg)).toBe(true);
    expect(looksLikeJobReference(null, 'The marble for project 2269.2 is ready', cfg)).toBe(true);
  });

  it('matches a bare four-digit job number near stone vocabulary', () => {
    expect(looksLikeJobReference('Job 2269 slabs', null, cfg)).toBe(true);
  });

  it('does not match a four-digit number with no stone or project context', () => {
    expect(looksLikeJobReference('Your 2026 benefits enrollment', 'Open enrollment', cfg)).toBe(
      false,
    );
    expect(looksLikeJobReference('Payment of 4500 posted', 'A payment posted.', cfg)).toBe(false);
  });

  it('requires the keyword to be near the number, not merely present', () => {
    const far = `Project kickoff notes. ${'filler text. '.repeat(40)} Reference 8812.`;
    expect(looksLikeJobReference(null, far, cfg)).toBe(false);
  });

  it('handles empty and null input', () => {
    expect(looksLikeJobReference(null, null, cfg)).toBe(false);
    expect(looksLikeJobReference('', '', cfg)).toBe(false);
  });

  it('is not confused by repeated calls (regex lastIndex safety)', () => {
    const subject = 'Quote for 2269.2 slabs';
    for (let i = 0; i < 5; i++) {
      expect(looksLikeJobReference(subject, null, cfg)).toBe(true);
    }
  });
});
