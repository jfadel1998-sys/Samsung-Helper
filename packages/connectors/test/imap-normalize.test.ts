import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import {
  imapExternalId,
  imapThreadId,
  normalizeImap,
  type ImapMessage,
} from '../src/imap/normalize';
import { formatCursor, headerMap, parseCursor } from '../src/imap/sync';
import { isAuthFailure, resolveCredentials } from '../src/imap/auth';

const OWNERS = ['jason@traxtone.com'];

function msg(over: Partial<ImapMessage> = {}): ImapMessage {
  return {
    uid: 101,
    uidValidity: '77',
    messageId: '<abc123@example-supplier.it>',
    subject: '2269.2 GVR — revised pricing',
    from: { name: 'M. Rossi', address: 'm.rossi@example-supplier.it' },
    to: [{ address: 'jason@traxtone.com' }],
    cc: [],
    date: new Date('2026-08-10T16:42:11Z'),
    text: 'Revised pricing attached for the 12 line items. FOB Livorno unchanged.',
    html: null,
    headers: { from: 'M. Rossi <m.rossi@example-supplier.it>' },
    flags: ['\\Seen'],
    gmailThreadId: null,
    gmailLabels: [],
    ...over,
  };
}

describe('normalizeImap', () => {
  it('maps the core fields', () => {
    const [e] = normalizeImap(msg(), OWNERS);
    expect(e!.source).toBe('imap');
    expect(e!.type).toBe('email');
    expect(e!.actorName).toBe('M. Rossi');
    expect(e!.actorHandle).toBe('m.rossi@example-supplier.it');
    expect(e!.subject).toBe('2269.2 GVR — revised pricing');
    expect(e!.occurredAt.toISOString()).toBe('2026-08-10T16:42:11.000Z');
    expect(e!.bodyExcerpt).toContain('Revised pricing attached');
    expect(e!.isFromOwner).toBe(false);
  });

  it('keys on Message-ID rather than UID', () => {
    // UIDs are reissued when UIDVALIDITY rotates. Keying on them would
    // duplicate the entire mailbox the first time a server does that.
    expect(imapExternalId(msg())).toBe('<abc123@example-supplier.it>');
    const [e] = normalizeImap(msg({ uid: 999, uidValidity: '88' }), OWNERS);
    expect(e!.externalId).toBe('<abc123@example-supplier.it>');
  });

  it('falls back to a uid composite when there is no Message-ID', () => {
    expect(imapExternalId(msg({ messageId: null }))).toBe('uid:77:101');
  });

  it('skips a message with neither Message-ID nor UID', () => {
    expect(normalizeImap(msg({ messageId: null, uid: undefined }), OWNERS)).toEqual([]);
  });

  it('prefers the Gmail thread id', () => {
    expect(imapThreadId(msg({ gmailThreadId: '18f2a1b3' }))).toBe('18f2a1b3');
  });

  it('threads on the root of the References chain when Gmail ids are absent', () => {
    const t = imapThreadId(
      msg({
        headers: { references: '<root@x.com> <second@x.com> <third@x.com>' },
      }),
    );
    expect(t).toBe('<root@x.com>');
  });

  it('falls back to In-Reply-To, then to its own id', () => {
    expect(imapThreadId(msg({ headers: { 'in-reply-to': '<parent@x.com>' } }))).toBe(
      '<parent@x.com>',
    );
    expect(imapThreadId(msg({ headers: {} }))).toBe('<abc123@example-supplier.it>');
  });

  it('maps Gmail category labels onto the same names the API connector emits', () => {
    const [e] = normalizeImap(msg({ gmailLabels: ['\\Inbox', 'CATEGORY_PROMOTIONS'] }), OWNERS);
    // The §7.1 prefilter rule must not care which Gmail connector produced this.
    expect(e!.signals.categories).toEqual(['CATEGORY_PROMOTIONS']);
  });

  it('handles bracketed Gmail label forms', () => {
    const [e] = normalizeImap(msg({ gmailLabels: ['[Gmail]/Category/Social'] }), OWNERS);
    expect(e!.signals.categories).toEqual(['CATEGORY_SOCIAL']);
  });

  it('surfaces List-Unsubscribe and Auto-Submitted', () => {
    const [e] = normalizeImap(
      msg({ headers: { 'list-unsubscribe': '<https://x/u>', 'auto-submitted': 'auto-replied' } }),
      OWNERS,
    );
    expect(e!.signals.listUnsubscribe).toBe(true);
    expect(e!.signals.autoSubmitted).toBe(true);
  });

  it('treats bulk precedence as auto-submitted', () => {
    const [e] = normalizeImap(msg({ headers: { precedence: 'bulk' } }), OWNERS);
    expect(e!.signals.autoSubmitted).toBe(true);
  });

  it('always reports headers as available', () => {
    // A full IMAP fetch carries the header block, unlike a Graph collection.
    const [e] = normalizeImap(msg(), OWNERS);
    expect(e!.signals.headersAvailable).toBe(true);
  });

  it('lower-cases recipients for the To/Cc rules', () => {
    const [e] = normalizeImap(
      msg({ to: [{ address: 'Jason@Traxtone.com' }], cc: [{ address: 'MOET@traxtone.com' }] }),
      OWNERS,
    );
    expect(e!.signals.toAddresses).toEqual(['jason@traxtone.com']);
    expect(e!.signals.ccAddresses).toEqual(['moet@traxtone.com']);
  });

  it('detects owner-sent mail by address and by label', () => {
    expect(
      normalizeImap(msg({ from: { address: 'JASON@traxtone.com' } }), OWNERS)[0]!.isFromOwner,
    ).toBe(true);
    expect(normalizeImap(msg({ gmailLabels: ['\\Sent'] }), OWNERS)[0]!.isFromOwner).toBe(true);
  });

  it('drops drafts and deleted mail', () => {
    expect(normalizeImap(msg({ flags: ['\\Draft'] }), OWNERS)).toEqual([]);
    expect(normalizeImap(msg({ gmailLabels: ['\\Draft'] }), OWNERS)).toEqual([]);
    expect(normalizeImap(msg({ flags: ['\\Deleted'] }), OWNERS)).toEqual([]);
  });

  it('prefers text over html but converts html when that is all there is', () => {
    const [withText] = normalizeImap(msg({ text: 'plain body', html: '<p>rich</p>' }), OWNERS);
    expect(withText!.bodyExcerpt).toBe('plain body');

    const [htmlOnly] = normalizeImap(
      msg({ text: null, html: '<div><table><tr><td>ETA</td><td>Aug 22</td></tr></table></div>' }),
      OWNERS,
    );
    expect(htmlOnly!.bodyExcerpt).toContain('Aug 22');
    expect(htmlOnly!.bodyExcerpt).not.toContain('<td>');
  });

  it('flags an empty body rather than inventing text', () => {
    const [e] = normalizeImap(msg({ text: null, html: null }), OWNERS);
    expect(e!.bodyExcerpt).toBeNull();
    expect(e!.signals.emptyBody).toBe(true);
  });

  it('preserves non-ASCII content', () => {
    const [e] = normalizeImap(
      msg({
        from: { name: 'José Muñoz', address: 'jose@example-supplier.es' },
        subject: 'Génova — cambio de buque · 石材',
        text: 'Naïve façade slabs — 12 crates.',
      }),
      OWNERS,
    );
    expect(e!.actorName).toBe('José Muñoz');
    expect(e!.subject).toBe('Génova — cambio de buque · 石材');
    expect(e!.bodyExcerpt).toContain('Naïve façade');
  });

  it('builds a Gmail search URL from the Message-ID', () => {
    const [e] = normalizeImap(msg(), OWNERS);
    expect(e!.url).toContain('rfc822msgid');
    expect(e!.url).toContain(encodeURIComponent('<abc123@example-supplier.it>'));
  });

  it('falls back to the Date header when the parsed date is missing', () => {
    const [e] = normalizeImap(
      msg({ date: null, headers: { date: 'Wed, 5 Aug 2026 09:00:00 +0000' } }),
      OWNERS,
    );
    expect(e!.occurredAt.toISOString()).toBe('2026-08-05T09:00:00.000Z');
  });

  it('handles a 200-recipient thread', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ address: `p${i}@example-gc.com` }));
    const [e] = normalizeImap(msg({ to: many }), OWNERS);
    expect(e!.signals.toAddresses).toHaveLength(200);
  });

  it('returns an empty array for junk input rather than throwing', () => {
    for (const junk of [null, undefined, 42, 'string', [null]]) {
      expect(normalizeImap(junk, OWNERS)).toEqual([]);
    }
  });

  it('is pure — the same input yields deeply equal output', () => {
    const input = [msg(), msg({ uid: 102, messageId: '<b@x.com>' })];
    expect(normalizeImap(input, OWNERS)).toEqual(normalizeImap(input, OWNERS));
  });
});

describe('imap cursor', () => {
  it('round-trips', () => {
    expect(parseCursor(formatCursor({ uidValidity: '77', lastUid: 1234 }))).toEqual({
      uidValidity: '77',
      lastUid: 1234,
    });
  });

  it('returns null for missing or malformed cursors', () => {
    for (const bad of [null, '', 'nonsense', '77:notanumber']) {
      expect(parseCursor(bad)).toBeNull();
    }
  });
});

describe('headerMap', () => {
  const raw = [
    'From: Stone World <news@stoneworld-example.com>',
    'To: jason@traxtone.com',
    'Subject: Stone World Weekly',
    'Message-ID: <msg-two@stoneworld-example.com>',
    'Date: Mon, 10 Aug 2026 16:42:11 +0000',
    'List-Unsubscribe: <https://stoneworld-example.com/u/9>',
    'Precedence: bulk',
    '',
    'This week in stone surfaces.',
    '',
  ].join('\r\n');

  it('keeps List-* headers that mailparser folds away', async () => {
    // Regression: mailparser's `headers` Map collapses every List-* header into
    // one synthetic `list` entry, so reading it there loses `list-unsubscribe`
    // entirely and the §7.1 newsletter rule never fires. Caught only against a
    // real server — a hand-built fixture supplies the header map directly.
    const parsed = await simpleParser(raw);
    expect(parsed.headers.has('list-unsubscribe')).toBe(false);

    const headers = headerMap(parsed);
    expect(headers['list-unsubscribe']).toBe('<https://stoneworld-example.com/u/9>');

    const [e] = normalizeImap({ ...msg({ headers }), messageId: '<x@y>' }, OWNERS);
    expect(e!.signals.listUnsubscribe).toBe(true);
    expect(e!.signals.autoSubmitted).toBe(true);
  });

  it('unfolds continuation lines into a single value', async () => {
    const folded = raw.replace(
      'List-Unsubscribe: <https://stoneworld-example.com/u/9>',
      'List-Unsubscribe: <https://stoneworld-example.com/u/9>,\r\n <mailto:u@stoneworld-example.com>',
    );
    const headers = headerMap(await simpleParser(folded));
    expect(headers['list-unsubscribe']).toBe(
      '<https://stoneworld-example.com/u/9>, <mailto:u@stoneworld-example.com>',
    );
  });

  it('joins repeated headers rather than letting the last one win', () => {
    const headers = headerMap({
      headerLines: [
        { key: 'received', line: 'Received: from a.example' },
        { key: 'received', line: 'Received: from b.example' },
      ],
    });
    expect(headers.received).toBe('from a.example, from b.example');
  });

  it('tolerates a missing headerLines array', () => {
    expect(headerMap({ headerLines: undefined as never })).toEqual({});
  });
});

describe('isAuthFailure', () => {
  it('recognizes imapflow’s real auth error, whose message says only "Command failed"', () => {
    // Verified against dovecot: imapflow puts the signal on properties, not in
    // the message. Matching text alone let a wrong password through as a
    // generic error, which §8 would then retry instead of flagging the account.
    const err = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText: 'Authentication failed.',
      serverResponseCode: 'AUTHENTICATIONFAILED',
    });
    expect(isAuthFailure(err)).toBe(true);
  });

  it('falls back to the response code and to response text', () => {
    expect(
      isAuthFailure(Object.assign(new Error('Command failed'), {
        serverResponseCode: 'AUTHENTICATIONFAILED',
      })),
    ).toBe(true);
    expect(
      isAuthFailure(Object.assign(new Error('Command failed'), {
        responseText: 'Application-specific password required',
      })),
    ).toBe(true);
  });

  it('does not treat a network or server error as an auth failure', () => {
    // These must stay retryable; misclassifying one would flag a healthy
    // account and stop syncing it.
    expect(isAuthFailure(new Error('ECONNRESET'))).toBe(false);
    expect(isAuthFailure(new Error('Command failed'))).toBe(false);
    expect(isAuthFailure(Object.assign(new Error('x'), { authenticationFailed: false }))).toBe(false);
    expect(isAuthFailure(null)).toBe(false);
  });
});

describe('imap credentials', () => {
  it('defaults to Gmail over TLS', () => {
    const c = resolveCredentials({ username: 'You@Gmail.com', password: 'abcd efgh ijkl mnop' });
    expect(c.host).toBe('imap.gmail.com');
    expect(c.port).toBe(993);
    expect(c.username).toBe('you@gmail.com');
  });

  it('strips the spaces Google displays in app passwords', () => {
    // Google shows "abcd efgh ijkl mnop"; pasting it verbatim must work.
    expect(resolveCredentials({ username: 'a@b.com', password: 'abcd efgh ijkl mnop' }).password)
      .toBe('abcdefghijklmnop');
  });

  it('rejects empty credentials', () => {
    expect(() => resolveCredentials({ username: '', password: 'x' })).toThrow();
    expect(() => resolveCredentials({ username: 'a@b.com', password: '' })).toThrow();
  });

  it('accepts a host override for non-Gmail IMAP', () => {
    const c = resolveCredentials({
      username: 'a@b.com',
      password: 'x',
      host: 'imap.fastmail.com',
      port: 993,
    });
    expect(c.host).toBe('imap.fastmail.com');
  });
});
