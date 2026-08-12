import type { NewEventRow } from '@hub/db';
import type { NormalizedEvent } from './types';

/**
 * NormalizedEvent -> events row.
 *
 * `prefilterVerdict` is passed in rather than computed here: the prefilter
 * (§7.1) is config-driven and lives in @hub/brief, and connectors must not
 * depend on it.
 */
export function toEventRow(
  accountId: string,
  event: NormalizedEvent,
  prefilterVerdict: string | null = null,
): NewEventRow {
  return {
    accountId,
    source: event.source,
    type: event.type,
    externalId: event.externalId,
    threadId: event.threadId,
    actorName: event.actorName,
    actorHandle: event.actorHandle,
    subject: event.subject,
    bodyExcerpt: event.bodyExcerpt,
    url: event.url,
    occurredAt: event.occurredAt,
    isFromOwner: event.isFromOwner,
    prefilterVerdict,
    // The provider payload plus the derived prefilter signals. Keeping the
    // signals here means a prefilter rule change can be re-run over history
    // without re-fetching from the provider.
    raw: { payload: event.raw, signals: event.signals } as NewEventRow['raw'],
  };
}
