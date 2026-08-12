import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeGmail, splitAddressList } from '../src/gmail/normalize';
import { decodePushEnvelope } from '../src/gmail/webhook';
import type { NormalizedEvent } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(here, 'fixtures/gmail', name), 'utf8'));

const OWNERS = ['jason@traxtone.com'];
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function byId(events: NormalizedEvent[], id: string): NormalizedEvent {
  const found = events.find((e) => e.externalId === id);
  if (!found) throw new Error(`no event ${id}`);
  return found;
}

describe('normalizeGmail', () => {
  const events = normalizeGmail(fixture('messages.json'), OWNERS);

  it('drops drafts and bare list stubs', () => {
    expect(events.map((e) => e.externalId)).toEqual([
      '18f2a1b3c4d5e6f7',
      '18f2promo0001',
      '18f2ooo0001',
    ]);
  });

  it('prefers the text/plain part over text/html', () => {
    const e = byId(events, '18f2a1b3c4d5e6f7');
    expect(e.bodyExcerpt).toContain('FOB Livorno but the proforma says ex-works Carrara');
    expect(e.bodyExcerpt).toContain('Which is correct?');
    expect(e.bodyExcerpt).not.toContain('<p>');
  });

  it('ignores attachment parts', () => {
    const e = byId(events, '18f2a1b3c4d5e6f7');
    expect(e.bodyExcerpt).not.toContain('proforma-2269.2.pdf');
    expect(e.bodyExcerpt).not.toContain('ANGjdJ');
  });

  it('parses a quoted display name containing a comma', () => {
    const e = byId(events, '18f2a1b3c4d5e6f7');
    expect(e.actorName).toBe('Rossi, Marco');
    expect(e.actorHandle).toBe('m.rossi@example-supplier.it');
    // "Fadel, Jason" <...> must not split into two bogus recipients.
    expect(e.signals.toAddresses).toEqual(['jason@traxtone.com', 'moet@traxtone.com']);
    expect(e.signals.ccAddresses).toEqual(['ops@example-forwarder.com']);
  });

  it('uses internalDate rather than the sender-supplied Date header', () => {
    // Date header says 09:00 +0200 (07:00Z); internalDate is authoritative.
    expect(byId(events, '18f2a1b3c4d5e6f7').occurredAt.toISOString()).toBe(
      '2026-08-07T16:42:11.000Z',
    );
  });

  it('captures Gmail category labels for the §7.1 rules', () => {
    expect(byId(events, '18f2promo0001').signals.categories).toEqual(['CATEGORY_PROMOTIONS']);
    expect(byId(events, '18f2a1b3c4d5e6f7').signals.categories).toEqual([]);
  });

  it('flags List-Unsubscribe and bulk precedence', () => {
    const promo = byId(events, '18f2promo0001');
    expect(promo.signals.listUnsubscribe).toBe(true);
    expect(promo.signals.autoSubmitted).toBe(true);
  });

  it('flags an auto-reply via Auto-Submitted', () => {
    const ooo = byId(events, '18f2ooo0001');
    expect(ooo.signals.autoSubmitted).toBe(true);
    expect(ooo.signals.listUnsubscribe).toBe(false);
  });

  it('reports headers as available — format=full always carries them', () => {
    for (const e of events) expect(e.signals.headersAvailable).toBe(true);
  });

  it('builds a usable message URL and keeps the thread id', () => {
    const e = byId(events, '18f2a1b3c4d5e6f7');
    expect(e.url).toBe('https://mail.google.com/mail/u/0/#inbox/18f2a1b3c4d5e6f7');
    expect(e.threadId).toBe('18f2a1b3c4d5e600');
  });
});

describe('normalizeGmail — edge cases (§11)', () => {
  const base = {
    id: 'X',
    threadId: 'T',
    labelIds: ['INBOX'],
    internalDate: '1786120931000',
  };

  it('handles a message with no subject', () => {
    const [e] = normalizeGmail(
      [
        {
          ...base,
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: b64('no subject here') },
          },
        },
      ],
      OWNERS,
    );
    expect(e!.subject).toBeNull();
    expect(e!.bodyExcerpt).toBe('no subject here');
  });

  it('handles an HTML-only multipart message', () => {
    const [e] = normalizeGmail(
      [
        {
          ...base,
          payload: {
            mimeType: 'multipart/alternative',
            headers: [{ name: 'From', value: 'a@b.com' }],
            parts: [
              {
                mimeType: 'text/html',
                body: {
                  data: b64('<div><table><tr><td>ETA</td><td>Aug 22</td></tr></table></div>'),
                },
              },
            ],
          },
        },
      ],
      OWNERS,
    );
    expect(e!.bodyExcerpt).toContain('Aug 22');
  });

  it('walks deeply nested multipart trees', () => {
    const [e] = normalizeGmail(
      [
        {
          ...base,
          payload: {
            mimeType: 'multipart/mixed',
            headers: [{ name: 'From', value: 'a@b.com' }],
            parts: [
              {
                mimeType: 'multipart/related',
                parts: [
                  {
                    mimeType: 'multipart/alternative',
                    parts: [{ mimeType: 'text/plain', body: { data: b64('deeply nested body') } }],
                  },
                ],
              },
            ],
          },
        },
      ],
      OWNERS,
    );
    expect(e!.bodyExcerpt).toBe('deeply nested body');
  });

  it('preserves non-UTF8-safe characters through base64url decoding', () => {
    const text = 'Génova — cambio de buque · 石材 · naïve façade';
    const [e] = normalizeGmail(
      [
        {
          ...base,
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'José Muñoz <jose@example-supplier.es>' },
              { name: 'Subject', value: '石材 update' },
            ],
            body: { data: b64(text) },
          },
        },
      ],
      OWNERS,
    );
    expect(e!.bodyExcerpt).toBe(text);
    expect(e!.actorName).toBe('José Muñoz');
    expect(e!.subject).toBe('石材 update');
  });

  it('falls back to the Date header when internalDate is missing', () => {
    const [e] = normalizeGmail(
      [
        {
          id: 'X',
          threadId: 'T',
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'a@b.com' },
              { name: 'Date', value: 'Wed, 5 Aug 2026 09:00:00 +0000' },
            ],
            body: { data: b64('body') },
          },
        },
      ],
      OWNERS,
    );
    expect(e!.occurredAt.toISOString()).toBe('2026-08-05T09:00:00.000Z');
  });

  it('falls back to the snippet when no body part decodes', () => {
    const [e] = normalizeGmail(
      [
        {
          ...base,
          snippet: 'snippet text only',
          payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'a@b.com' }] },
        },
      ],
      OWNERS,
    );
    expect(e!.bodyExcerpt).toBe('snippet text only');
  });

  it('marks an empty body rather than inventing text', () => {
    const [e] = normalizeGmail(
      [{ ...base, payload: { mimeType: 'text/plain', headers: [] } }],
      OWNERS,
    );
    expect(e!.bodyExcerpt).toBeNull();
    expect(e!.signals.emptyBody).toBe(true);
  });

  it('treats SENT-labelled mail as owner-authored', () => {
    const [e] = normalizeGmail(
      [
        {
          ...base,
          labelIds: ['SENT'],
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'someone-else@example.com' }],
            body: { data: b64('reply') },
          },
        },
      ],
      OWNERS,
    );
    expect(e!.isFromOwner).toBe(true);
  });

  it('handles a 200-recipient thread', () => {
    const list = Array.from({ length: 200 }, (_, i) => `person${i}@example-gc.com`).join(', ');
    const [e] = normalizeGmail(
      [
        {
          ...base,
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'pm@example-gc.com' },
              { name: 'To', value: list },
            ],
            body: { data: b64('submittal log attached') },
          },
        },
      ],
      OWNERS,
    );
    expect(e!.signals.toAddresses).toHaveLength(200);
  });

  it('returns an empty array for junk input rather than throwing', () => {
    for (const junk of [null, undefined, 42, 'string', {}, [null], { messages: null }]) {
      expect(normalizeGmail(junk, OWNERS)).toEqual([]);
    }
  });

  it('survives corrupt base64 body data', () => {
    const [e] = normalizeGmail(
      [
        {
          ...base,
          snippet: 'fallback',
          payload: {
            mimeType: 'text/plain',
            headers: [{ name: 'From', value: 'a@b.com' }],
            body: { data: '!!!not-base64!!!' },
          },
        },
      ],
      OWNERS,
    );
    expect(e).toBeDefined();
  });

  it('is pure — the same input yields deeply equal output', () => {
    const input = fixture('messages.json');
    expect(normalizeGmail(input, OWNERS)).toEqual(normalizeGmail(input, OWNERS));
  });
});

describe('splitAddressList', () => {
  it('splits on real separators only', () => {
    expect(splitAddressList('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com']);
    expect(splitAddressList('"Nickolas, T." <t@x.com>, b@y.com')).toEqual(['t@x.com', 'b@y.com']);
    expect(splitAddressList('Solo <s@x.com>')).toEqual(['s@x.com']);
    expect(splitAddressList(undefined)).toEqual([]);
    expect(splitAddressList('')).toEqual([]);
  });

  it('lower-cases addresses', () => {
    expect(splitAddressList('Jason@Traxtone.COM')).toEqual(['jason@traxtone.com']);
  });
});

describe('decodePushEnvelope (§9)', () => {
  it('decodes the mailbox and historyId from a push envelope', () => {
    const data = Buffer.from(
      JSON.stringify({ emailAddress: 'jason@traxtone.com', historyId: 987654 }),
      'utf8',
    ).toString('base64');

    expect(decodePushEnvelope({ message: { data }, subscription: 'projects/p/subscriptions/s' }))
      .toEqual({ emailAddress: 'jason@traxtone.com', historyId: 987654 });
  });

  it('returns null for malformed envelopes instead of throwing', () => {
    for (const junk of [null, undefined, {}, { message: {} }, { message: { data: '!!!' } }, 42]) {
      expect(decodePushEnvelope(junk)).toBeNull();
    }
  });
});
