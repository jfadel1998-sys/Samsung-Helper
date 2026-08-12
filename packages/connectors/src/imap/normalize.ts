/**
 * Parsed IMAP message -> NormalizedEvent. Pure: no network, no clock, no
 * config (§6).
 *
 * MIME parsing happens in sync.ts, which is async and needs a socket; this
 * takes the already-parsed shape so it stays a fixture-in / events-out
 * function like the other two connectors' normalizers.
 */
import type { NormalizedEvent, PrefilterSignals } from '../types';
import { toBodyExcerpt } from '../text';
import { IMAP_PROVIDER } from './auth';

export interface ImapAddress {
  name?: string | null;
  address?: string | null;
}

/** The subset of a parsed message the normalizer reads. */
export interface ImapMessage {
  /** Mailbox-scoped, resets when UIDVALIDITY changes. */
  uid?: number;
  uidValidity?: string;
  /** RFC Message-ID — globally unique and stable. */
  messageId?: string | null;
  subject?: string | null;
  from?: ImapAddress | null;
  to?: ImapAddress[] | null;
  cc?: ImapAddress[] | null;
  date?: string | Date | null;
  text?: string | null;
  html?: string | null;
  /** Lower-cased header names to values. */
  headers?: Record<string, string> | null;
  flags?: string[] | null;
  /** Gmail IMAP extensions, when the server offers them. */
  gmailThreadId?: string | null;
  gmailLabels?: string[] | null;
}

/**
 * Gmail exposes its categories as IMAP labels. Mapped onto the same
 * CATEGORY_* names the Gmail API connector emits, so the §7.1 prefilter rule
 * is provider-blind.
 */
const LABEL_TO_CATEGORY: Record<string, string> = {
  '\\important': '',
  'category/promotions': 'CATEGORY_PROMOTIONS',
  'category/social': 'CATEGORY_SOCIAL',
  'category/updates': 'CATEGORY_UPDATES',
  'category/forums': 'CATEGORY_FORUMS',
};

function normalizeLabel(label: string): string {
  const trimmed = label.trim().toLowerCase().replace(/^"|"$/g, '');
  if (trimmed.startsWith('\\')) return trimmed;
  return trimmed.replace(/^\[gmail\]\//, '').replace(/^category_/, 'category/');
}

function addresses(list: ImapAddress[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((a) => a?.address?.trim().toLowerCase())
    .filter((a): a is string => Boolean(a));
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function messagesFrom(raw: unknown): ImapMessage[] {
  if (Array.isArray(raw)) return raw as ImapMessage[];
  if (raw && typeof raw === 'object') return [raw as ImapMessage];
  return [];
}

/**
 * The stable identity for an IMAP message.
 *
 * Message-ID first: UIDs are scoped to a mailbox and are reissued when
 * UIDVALIDITY changes, so keying on a UID would duplicate every message in the
 * mailbox the first time the server rotates it. The UID composite is only a
 * fallback for messages with no Message-ID header.
 */
export function imapExternalId(msg: ImapMessage): string | null {
  const messageId = msg.messageId?.trim();
  if (messageId) return messageId;
  if (msg.uid !== undefined && msg.uidValidity) return `uid:${msg.uidValidity}:${msg.uid}`;
  return null;
}

/**
 * Thread identity, best available: Gmail's own thread id, else the root of the
 * References chain, else the message's own id (a thread of one).
 */
export function imapThreadId(msg: ImapMessage): string | null {
  if (msg.gmailThreadId) return msg.gmailThreadId;

  const references = msg.headers?.references;
  if (references) {
    const first = references.trim().split(/\s+/)[0];
    if (first) return first;
  }

  const inReplyTo = msg.headers?.['in-reply-to']?.trim();
  if (inReplyTo) return inReplyTo;

  return msg.messageId?.trim() ?? null;
}

export function normalizeImap(raw: unknown, ownerAddresses: string[] = []): NormalizedEvent[] {
  const owners = new Set(ownerAddresses.map((a) => a.trim().toLowerCase()));
  const out: NormalizedEvent[] = [];

  for (const msg of messagesFrom(raw)) {
    if (!msg || typeof msg !== 'object') continue;

    const externalId = imapExternalId(msg);
    if (!externalId) continue;

    const labels = (msg.gmailLabels ?? []).map(normalizeLabel);
    const flags = (msg.flags ?? []).map((f) => f.toLowerCase());
    // Drafts and deleted mail are not inbound signal.
    if (labels.includes('\\draft') || flags.includes('\\draft')) continue;
    if (flags.includes('\\deleted')) continue;

    const headers = msg.headers ?? {};
    const fromAddress = msg.from?.address?.trim().toLowerCase() ?? null;

    const bodyExcerpt = toBodyExcerpt({ html: msg.html ?? null, text: msg.text ?? null });

    const autoSubmitted = headers['auto-submitted'];
    const precedence = (headers.precedence ?? '').toLowerCase();

    const signals: PrefilterSignals = {
      listUnsubscribe: Boolean(headers['list-unsubscribe']),
      autoSubmitted:
        Boolean(autoSubmitted && autoSubmitted.toLowerCase() !== 'no') ||
        precedence === 'bulk' ||
        precedence === 'auto_reply',
      categories: labels
        .map((l) => LABEL_TO_CATEGORY[l])
        .filter((c): c is string => Boolean(c)),
      toAddresses: addresses(msg.to),
      ccAddresses: addresses(msg.cc),
      emptyBody: bodyExcerpt.length === 0,
      // A full IMAP fetch always carries the header block.
      headersAvailable: true,
    };

    const occurredAt = toDate(msg.date) ?? toDate(headers.date) ?? new Date(0);

    out.push({
      source: IMAP_PROVIDER,
      type: 'email',
      externalId,
      threadId: imapThreadId(msg),
      actorName: msg.from?.name?.trim() || null,
      actorHandle: fromAddress,
      subject: msg.subject?.trim() || null,
      bodyExcerpt: bodyExcerpt || null,
      // IMAP has no per-message web URL. Gmail's search-by-message-id link is
      // the closest usable thing and works for any Gmail account.
      url: msg.messageId
        ? `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(msg.messageId)}`
        : null,
      occurredAt,
      isFromOwner:
        (fromAddress ? owners.has(fromAddress) : false) ||
        labels.includes('\\sent') ||
        flags.includes('\\sent'),
      raw: msg,
      signals,
    });
  }

  return out;
}
