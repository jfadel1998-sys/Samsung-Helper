/**
 * Gmail message resource -> NormalizedEvent. Pure: no network, no clock, no
 * config (§6).
 */
import type { NormalizedEvent, PrefilterSignals } from '../types';
import { parseAddress, toBodyExcerpt } from '../text';
import { GMAIL_PROVIDER } from './auth';

export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string | null;
  filename?: string | null;
  headers?: GmailHeader[] | null;
  body?: { size?: number; data?: string | null; attachmentId?: string } | null;
  parts?: GmailPart[] | null;
}

export interface GmailMessage {
  id?: string;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

/** Gmail's category labels — the Promotions/Social/Updates rule in §7.1. */
export const GMAIL_CATEGORY_LABELS = [
  'CATEGORY_PROMOTIONS',
  'CATEGORY_SOCIAL',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return '';
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function headerMap(headers: GmailHeader[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (!h?.name) continue;
      const key = h.name.toLowerCase();
      // Keep the first occurrence; Gmail lists Received: headers oldest-last.
      if (!map.has(key)) map.set(key, (h.value ?? '').trim());
    }
  }
  return map;
}

/**
 * Depth-first walk collecting the first text/plain and text/html bodies.
 * Attachments (parts with a filename or attachmentId) are skipped — their
 * content is not inlined and their names are already in the payload we keep.
 */
function collectBodies(part: GmailPart | null | undefined): { text: string; html: string } {
  const out = { text: '', html: '' };
  if (!part) return out;

  const walk = (p: GmailPart | null | undefined) => {
    if (!p) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    const isAttachment = Boolean(p.filename) || Boolean(p.body?.attachmentId);

    if (!isAttachment && p.body?.data) {
      if (mime === 'text/plain' && !out.text) out.text = decodeBase64Url(p.body.data);
      else if (mime === 'text/html' && !out.html) out.html = decodeBase64Url(p.body.data);
    }
    if (Array.isArray(p.parts)) for (const child of p.parts) walk(child);
  };

  walk(part);
  return out;
}

/** Splits a To/Cc header into lower-cased addresses. */
export function splitAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let inQuotes = false;

  // Commas inside quoted display names ("Nickolas, T." <a@b.com>) are not
  // separators, so a plain split(',') mangles the list.
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && !inQuotes && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);

  return out
    .map((entry) => parseAddress(entry).address)
    .filter((a): a is string => Boolean(a));
}

function messagesFrom(raw: unknown): GmailMessage[] {
  if (Array.isArray(raw)) return raw as GmailMessage[];
  if (raw && typeof raw === 'object') {
    const page = raw as { messages?: unknown };
    if (Array.isArray(page.messages)) return page.messages as GmailMessage[];
    return [raw as GmailMessage];
  }
  return [];
}

export function normalizeGmail(raw: unknown, ownerAddresses: string[] = []): NormalizedEvent[] {
  const owners = new Set(ownerAddresses.map((a) => a.trim().toLowerCase()));
  const out: NormalizedEvent[] = [];

  for (const msg of messagesFrom(raw)) {
    if (!msg || typeof msg !== 'object' || !msg.id) continue;

    const labels = msg.labelIds ?? [];
    // Drafts are the owner's unsent text; the trash is not signal.
    if (labels.includes('DRAFT') || labels.includes('TRASH')) continue;

    // A message stub from messages.list (id + threadId only) is not yet
    // fetchable content — skip rather than emit an empty event.
    if (!msg.payload) continue;

    const headers = headerMap(msg.payload.headers);
    const bodies = collectBodies(msg.payload);

    const from = parseAddress(headers.get('from'));
    const bodyExcerpt = toBodyExcerpt({
      html: bodies.html || null,
      text: bodies.text || msg.snippet || null,
    });

    const autoSubmitted = headers.get('auto-submitted');
    const precedence = (headers.get('precedence') ?? '').toLowerCase();

    const signals: PrefilterSignals = {
      listUnsubscribe: headers.has('list-unsubscribe'),
      autoSubmitted:
        Boolean(autoSubmitted && autoSubmitted.toLowerCase() !== 'no') ||
        precedence === 'bulk' ||
        precedence === 'auto_reply',
      categories: labels.filter((l) => GMAIL_CATEGORY_LABELS.includes(l)),
      toAddresses: splitAddressList(headers.get('to')),
      ccAddresses: splitAddressList(headers.get('cc')),
      emptyBody: bodyExcerpt.length === 0,
      // format=full always carries headers, so absence here means genuinely absent.
      headersAvailable: true,
    };

    // internalDate is the authoritative receipt time; the Date header is
    // sender-supplied and routinely wrong.
    const internal = Number(msg.internalDate);
    const occurredAt = Number.isFinite(internal) && internal > 0
      ? new Date(internal)
      : (() => {
          const parsed = Date.parse(headers.get('date') ?? '');
          return Number.isNaN(parsed) ? new Date(0) : new Date(parsed);
        })();

    out.push({
      source: GMAIL_PROVIDER,
      type: 'email',
      externalId: msg.id,
      threadId: msg.threadId ?? null,
      actorName: from.name,
      actorHandle: from.address,
      subject: headers.get('subject')?.trim() || null,
      bodyExcerpt: bodyExcerpt || null,
      url: `https://mail.google.com/mail/u/0/#inbox/${msg.id}`,
      occurredAt,
      isFromOwner:
        (from.address ? owners.has(from.address) : false) || labels.includes('SENT'),
      raw: msg,
      signals,
    });
  }

  return out;
}
