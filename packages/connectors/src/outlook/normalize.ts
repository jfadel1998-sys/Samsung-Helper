/**
 * Microsoft Graph message -> NormalizedEvent. Pure: no network, no clock, no
 * config. Fixture in, events out (§6).
 */
import type { NormalizedEvent, PrefilterSignals } from '../types';
import { toBodyExcerpt } from '../text';
import { OUTLOOK_PROVIDER } from './auth';

export interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

export interface GraphHeader {
  name?: string | null;
  value?: string | null;
}

export interface GraphMessage {
  id?: string;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  from?: GraphRecipient | null;
  sender?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  webLink?: string | null;
  internetMessageHeaders?: GraphHeader[] | null;
  isDraft?: boolean | null;
  '@removed'?: { reason?: string } | null;
}

/** Accepts a delta/list page, an array, or a single message. */
export interface GraphPage {
  value?: unknown;
}

function addressesOf(list: GraphRecipient[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => r?.emailAddress?.address?.trim().toLowerCase())
    .filter((a): a is string => Boolean(a));
}

function headerLookup(headers: GraphHeader[] | null | undefined) {
  const map = new Map<string, string>();
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h?.name) map.set(h.name.toLowerCase(), (h.value ?? '').trim());
    }
  }
  return map;
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function messagesFrom(raw: unknown): GraphMessage[] {
  if (Array.isArray(raw)) return raw as GraphMessage[];
  if (raw && typeof raw === 'object') {
    const page = raw as GraphPage;
    if (Array.isArray(page.value)) return page.value as GraphMessage[];
    return [raw as GraphMessage];
  }
  return [];
}

/**
 * @param ownerAddresses lower-cased addresses that count as the owner. Passed
 *   in rather than read from env so this stays a pure function.
 */
export function normalizeOutlook(raw: unknown, ownerAddresses: string[] = []): NormalizedEvent[] {
  const owners = new Set(ownerAddresses.map((a) => a.trim().toLowerCase()));
  const out: NormalizedEvent[] = [];

  for (const msg of messagesFrom(raw)) {
    if (!msg || typeof msg !== 'object') continue;

    // Delta tombstones carry an id and @removed and nothing else. We do not
    // delete ingested events — the brief is a record of what arrived — so the
    // tombstone is simply dropped.
    if (msg['@removed']) continue;
    if (!msg.id) continue;
    // Drafts are the owner's unsent text, not inbound signal.
    if (msg.isDraft) continue;

    const headers = headerLookup(msg.internetMessageHeaders);
    const headersAvailable = Array.isArray(msg.internetMessageHeaders);

    const fromAddr = msg.from?.emailAddress ?? msg.sender?.emailAddress ?? null;
    const actorHandle = fromAddr?.address?.trim().toLowerCase() ?? null;

    const isHtml = (msg.body?.contentType ?? '').toLowerCase() === 'html';
    const bodyExcerpt = toBodyExcerpt({
      html: isHtml ? msg.body?.content : null,
      text: isHtml ? null : (msg.body?.content ?? msg.bodyPreview),
    });

    const autoSubmittedRaw = headers.get('auto-submitted');

    const signals: PrefilterSignals = {
      listUnsubscribe: headers.has('list-unsubscribe'),
      autoSubmitted: Boolean(autoSubmittedRaw && autoSubmittedRaw.toLowerCase() !== 'no'),
      categories: [],
      toAddresses: addressesOf(msg.toRecipients),
      ccAddresses: addressesOf(msg.ccRecipients),
      emptyBody: bodyExcerpt.length === 0,
      headersAvailable,
    };

    const occurredAt =
      toDate(msg.receivedDateTime) ?? toDate(msg.sentDateTime) ?? new Date(0);

    out.push({
      source: OUTLOOK_PROVIDER,
      type: 'email',
      externalId: msg.id,
      threadId: msg.conversationId ?? null,
      actorName: fromAddr?.name?.trim() || null,
      actorHandle,
      subject: msg.subject?.trim() || null,
      bodyExcerpt: bodyExcerpt || null,
      url: msg.webLink ?? null,
      occurredAt,
      isFromOwner: actorHandle ? owners.has(actorHandle) : false,
      raw: msg,
      signals,
    });
  }

  return out;
}
