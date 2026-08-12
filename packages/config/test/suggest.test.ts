import { describe, expect, it } from 'vitest';
import { renderConfigBlock, suggestCounterparties, type SenderObservation } from '../src/suggest';

function obs(
  handle: string,
  over: Partial<SenderObservation> = {},
  n = 1,
): SenderObservation[] {
  return Array.from({ length: n }, (_, i) => ({
    actorHandle: handle,
    threadId: `t-${handle}-${i}`,
    subject: 'a subject',
    bodyExcerpt: 'a body',
    isFromOwner: false,
    threadHasOwnerReply: false,
    ...over,
  }));
}

describe('suggestCounterparties', () => {
  it('groups senders into one domain entry', () => {
    const out = suggestCounterparties([
      ...obs('m.rossi@marmi-carrara.it'),
      ...obs('sales@marmi-carrara.it'),
      ...obs('logistics@marmi-carrara.it'),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('marmi-carrara.it');
    expect(out[0]!.messages).toBe(3);
    expect(out[0]!.senders).toEqual([
      'logistics@marmi-carrara.it',
      'm.rossi@marmi-carrara.it',
      'sales@marmi-carrara.it',
    ]);
  });

  it('ranks a domain you reply to above a higher-volume one you never answer', () => {
    const out = suggestCounterparties([
      ...obs('news@big-newsletter.com', {}, 30),
      ...obs('m.rossi@marmi-carrara.it', { threadHasOwnerReply: true }, 6),
    ]);

    // Replying is the strongest signal — nobody replies to a newsletter.
    expect(out[0]!.domain).toBe('marmi-carrara.it');
    expect(out[0]!.repliedThreads).toBe(6);
  });

  it('flags a many-threads-never-answered domain as broadcast', () => {
    const out = suggestCounterparties(obs('news@big-newsletter.com', {}, 30));
    expect(out[0]!.looksLikeBroadcast).toBe(true);
  });

  it('does not flag a low-volume domain as broadcast on thin evidence', () => {
    const out = suggestCounterparties(obs('new@maybe-example.com', {}, 3));
    expect(out[0]!.looksLikeBroadcast).toBe(false);
  });

  it('guesses freight_forwarder from shipping vocabulary', () => {
    const out = suggestCounterparties(
      obs('ops@genoa-forwarding.com', {
        subject: 'Vessel change — container MSCU1234567',
        bodyExcerpt: 'The bill of lading is issued and the sailing has moved.',
      }, 3),
    );
    expect(out[0]!.guess).toBe('freight_forwarder');
    expect(out[0]!.evidence.length).toBeGreaterThanOrEqual(2);
  });

  it('guesses supplier from quarry vocabulary', () => {
    const out = suggestCounterparties(
      obs('sales@marmi-carrara.it', {
        subject: 'Lot reservation',
        bodyExcerpt: 'Holding block 7741 at the quarry; FOB Livorno on the proforma.',
      }, 3),
    );
    expect(out[0]!.guess).toBe('supplier');
  });

  it('guesses gc from construction-management vocabulary', () => {
    const out = suggestCounterparties(
      obs('pm@builder-example.com', {
        subject: 'Submittal returned',
        bodyExcerpt: 'Punch list attached and the change order is pending.',
      }, 3),
    );
    expect(out[0]!.guess).toBe('gc');
  });

  it('leaves the guess as unknown when vocabulary is thin', () => {
    const out = suggestCounterparties(
      obs('hello@mystery-example.com', { subject: 'Hi', bodyExcerpt: 'Following up.' }, 3),
    );
    expect(out[0]!.guess).toBe('unknown');
    expect(out[0]!.evidence).toEqual([]);
  });

  it('ignores owner-authored mail', () => {
    const out = suggestCounterparties(obs('jason@traxtone.com', { isFromOwner: true }, 5));
    expect(out).toHaveLength(0);
  });

  it('skips ignored domains and their subdomains', () => {
    const out = suggestCounterparties(
      [...obs('noreply@calendar.google.com', {}, 5), ...obs('a@mail.calendar.google.com', {}, 5)],
      { ignore: new Set(['calendar.google.com']) },
    );
    expect(out).toHaveLength(0);
  });

  it('drops one-off senders below the message threshold', () => {
    const out = suggestCounterparties(obs('once@rare-example.com'), { minMessages: 2 });
    expect(out).toHaveLength(0);
  });

  it('marks domains already in the config and sorts them last', () => {
    const out = suggestCounterparties(
      [...obs('a@known-example.com', { threadHasOwnerReply: true }, 20), ...obs('b@new-example.com', {}, 3)],
      { known: new Set(['known-example.com']) },
    );

    // The new domain leads even though the known one scores higher — the
    // reviewer only needs to act on what is not yet listed.
    expect(out[0]!.domain).toBe('new-example.com');
    expect(out[0]!.alreadyListed).toBe(false);
    expect(out[1]!.alreadyListed).toBe(true);
  });

  it('handles malformed and missing addresses without throwing', () => {
    const out = suggestCounterparties([
      ...obs('not-an-address'),
      { actorHandle: null, threadId: null, subject: null, bodyExcerpt: null, isFromOwner: false, threadHasOwnerReply: false },
    ]);
    expect(out).toEqual([]);
  });
});

describe('renderConfigBlock', () => {
  it('emits paste-ready JSON lines for new domains only', () => {
    const out = suggestCounterparties(
      [
        ...obs('ops@genoa-forwarding.com', { subject: 'vessel container', bodyExcerpt: 'bill of lading' }, 3),
        ...obs('a@known-example.com', {}, 3),
      ],
      { known: new Set(['known-example.com']) },
    );

    const block = renderConfigBlock(out);
    expect(block).toContain('"genoa-forwarding.com":');
    expect(block).toContain('"freight_forwarder",');
    expect(block).not.toContain('known-example.com');
  });

  it('says so when there is nothing new', () => {
    expect(renderConfigBlock([])).toContain('nothing new');
  });
});
