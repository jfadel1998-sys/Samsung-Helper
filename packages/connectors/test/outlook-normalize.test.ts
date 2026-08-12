import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeOutlook } from '../src/outlook/normalize';
import type { NormalizedEvent } from '../src/types';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(here, 'fixtures/outlook', name), 'utf8'));

const OWNERS = ['jason@traxtone.com'];

function byId(events: NormalizedEvent[], id: string): NormalizedEvent {
  const found = events.find((e) => e.externalId === id);
  if (!found) throw new Error(`no event ${id}`);
  return found;
}

describe('normalizeOutlook — delta page', () => {
  const events = normalizeOutlook(fixture('delta-page.json'), OWNERS);

  it('drops tombstones and drafts, keeps real messages', () => {
    expect(events.map((e) => e.externalId)).toEqual(['AAMkAGI2THVSAAA=', 'AAMkAGI2NEWSLETTER=']);
  });

  it('maps the core fields', () => {
    const e = byId(events, 'AAMkAGI2THVSAAA=');
    expect(e.source).toBe('outlook');
    expect(e.type).toBe('email');
    expect(e.threadId).toBe('AAQkAGI2conv1');
    expect(e.actorName).toBe('T. Nickolas');
    expect(e.actorHandle).toBe('t.nickolas@example-supplier.com');
    expect(e.subject).toBe('2269.2 GVR Local Stone - revised pricing');
    expect(e.occurredAt.toISOString()).toBe('2026-08-10T16:42:11.000Z');
    expect(e.url).toContain('outlook.office365.com');
    expect(e.isFromOwner).toBe(false);
  });

  it('converts HTML to plaintext and strips the quoted reply and signature', () => {
    const e = byId(events, 'AAMkAGI2THVSAAA=');
    expect(e.bodyExcerpt).toContain('Revised pricing attached for the 12 line items');
    expect(e.bodyExcerpt).toContain('Lead time is now 6-8 weeks');
    // The quoted chain and signature must not eat the extraction budget.
    expect(e.bodyExcerpt).not.toContain('Can you confirm the pricing');
    expect(e.bodyExcerpt).not.toContain('Export Sales');
    // No CSS or markup leakage.
    expect(e.bodyExcerpt).not.toContain('margin:0');
    expect(e.bodyExcerpt).not.toContain('<p>');
  });

  it('lower-cases recipient addresses for the To/Cc prefilter rules', () => {
    const e = byId(events, 'AAMkAGI2THVSAAA=');
    expect(e.signals.toAddresses).toEqual(['jason@traxtone.com']);
    expect(e.signals.ccAddresses).toEqual(['moet@traxtone.com']);
  });

  it('surfaces List-Unsubscribe as a prefilter signal', () => {
    expect(byId(events, 'AAMkAGI2NEWSLETTER=').signals.listUnsubscribe).toBe(true);
    expect(byId(events, 'AAMkAGI2THVSAAA=').signals.listUnsubscribe).toBe(false);
  });

  it('preserves the provider payload verbatim in raw', () => {
    const e = byId(events, 'AAMkAGI2THVSAAA=');
    expect((e.raw as { id: string }).id).toBe('AAMkAGI2THVSAAA=');
  });
});

describe('normalizeOutlook — edge cases (§11)', () => {
  const events = normalizeOutlook(fixture('edge-cases.json'), OWNERS);

  it('handles a message with no subject', () => {
    const e = byId(events, 'NO-SUBJECT');
    expect(e.subject).toBeNull();
    expect(e.bodyExcerpt).toBe('Vessel changed. Genoa now Aug 22.');
  });

  it('handles multipart HTML-only bodies, keeping table content', () => {
    const e = byId(events, 'HTML-ONLY-MULTIPART');
    expect(e.bodyExcerpt).toContain('MSCU1234567');
    expect(e.bodyExcerpt).toContain('Aug 22');
    // Images dropped, link text kept without the tracking URL.
    expect(e.bodyExcerpt).not.toContain('cid:logo');
    expect(e.bodyExcerpt).not.toContain('token=secret');
  });

  it('flags an empty body rather than inventing text', () => {
    const e = byId(events, 'EMPTY-BODY-INVITE');
    expect(e.bodyExcerpt).toBeNull();
    expect(e.signals.emptyBody).toBe(true);
    expect(e.signals.autoSubmitted).toBe(true);
  });

  it('preserves non-ASCII names and body text', () => {
    const e = byId(events, 'NON-UTF8-NAMES');
    expect(e.actorName).toBe('José Muñoz');
    expect(e.subject).toBe('Génova — cambio de buque · 石材');
    expect(e.bodyExcerpt).toContain('Naïve façade');
    expect(e.bodyExcerpt).toContain('Muñoz confirmó');
  });

  it('tolerates a missing sender', () => {
    const e = byId(events, 'NO-SENDER');
    expect(e.actorHandle).toBeNull();
    expect(e.actorName).toBeNull();
    expect(e.isFromOwner).toBe(false);
  });

  it('falls back to sentDateTime when receivedDateTime is malformed', () => {
    expect(byId(events, 'BAD-DATE').occurredAt.toISOString()).toBe('2026-08-09T16:00:00.000Z');
  });

  it('detects owner-sent mail case-insensitively', () => {
    expect(byId(events, 'OWNER-SENT').isFromOwner).toBe(true);
    expect(byId(events, 'NO-SUBJECT').isFromOwner).toBe(false);
  });

  it('distinguishes "no headers returned" from "header absent"', () => {
    // Graph omits internetMessageHeaders on some collection responses. A
    // prefilter rule must not read that as "this mail has no List-Unsubscribe".
    expect(byId(events, 'NO-SUBJECT').signals.headersAvailable).toBe(true);
    expect(byId(events, 'HTML-ONLY-MULTIPART').signals.headersAvailable).toBe(false);
  });
});

describe('normalizeOutlook — shape tolerance', () => {
  it('accepts a page, a bare array, or a single message', () => {
    const single = {
      id: 'X1',
      subject: 's',
      body: { contentType: 'text', content: 'b' },
      receivedDateTime: '2026-08-09T10:00:00Z',
      from: { emailAddress: { address: 'a@b.com' } },
    };
    expect(normalizeOutlook(single, OWNERS)).toHaveLength(1);
    expect(normalizeOutlook([single], OWNERS)).toHaveLength(1);
    expect(normalizeOutlook({ value: [single] }, OWNERS)).toHaveLength(1);
  });

  it('returns an empty array for junk input rather than throwing', () => {
    for (const junk of [null, undefined, 42, 'string', {}, { value: null }, [null]]) {
      expect(normalizeOutlook(junk, OWNERS)).toEqual([]);
    }
  });

  it('skips messages with no id', () => {
    expect(normalizeOutlook({ value: [{ subject: 'no id' }] }, OWNERS)).toEqual([]);
  });

  it('is pure — the same input yields deeply equal output', () => {
    const input = fixture('edge-cases.json');
    expect(normalizeOutlook(input, OWNERS)).toEqual(normalizeOutlook(input, OWNERS));
  });

  it('handles a 200-recipient thread without truncating the address list', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      emailAddress: { address: `person${i}@example-gc.com` },
    }));
    const [event] = normalizeOutlook(
      {
        value: [
          {
            id: 'BIG-THREAD',
            subject: 'RE: RE: RE: submittal log',
            body: { contentType: 'text', content: 'see attached' },
            from: { emailAddress: { address: 'pm@example-gc.com' } },
            toRecipients: many,
            ccRecipients: many,
            receivedDateTime: '2026-08-09T10:00:00Z',
          },
        ],
      },
      OWNERS,
    );
    expect(event!.signals.toAddresses).toHaveLength(200);
    expect(event!.signals.ccAddresses).toHaveLength(200);
    expect(event!.isFromOwner).toBe(false);
  });

  it('caps the body excerpt at 4000 chars', () => {
    const [event] = normalizeOutlook(
      {
        value: [
          {
            id: 'LONG',
            subject: 'long',
            body: { contentType: 'text', content: 'lorem ipsum '.repeat(2000) },
            from: { emailAddress: { address: 'a@b.com' } },
            receivedDateTime: '2026-08-09T10:00:00Z',
          },
        ],
      },
      OWNERS,
    );
    expect(event!.bodyExcerpt!.length).toBeLessThanOrEqual(4000);
  });
});
