/**
 * §7.2 extraction schema.
 *
 * `zod/v4` rather than the classic entry point: the SDK's `zodOutputFormat`
 * helper is built against the v4 API, and mixing the two produces schemas the
 * helper cannot convert.
 */
import * as z from 'zod/v4';
import { normalizeJobNumber } from './job-number';

export const COUNTERPARTY_TYPES = [
  'supplier',
  'freight_forwarder',
  'fabricator',
  'gc',
  'designer',
  'client',
  'internal',
  'unknown',
] as const;

export const CATEGORIES = [
  'pricing',
  'lead_time',
  'shipping_logistics',
  'sample_request',
  'quality_issue',
  'payment',
  'scheduling',
  'scope_change',
  'new_inquiry',
  'admin',
  'other',
] as const;

export const ACTION_OWNERS = ['jason', 'moet', 'other', 'none'] as const;
export const URGENCIES = ['critical', 'high', 'normal', 'low'] as const;

/**
 * `ref` replaces the spec's `external_id`.
 *
 * Provider message ids are long — an Outlook id is ~150 characters, roughly 50
 * output tokens the model would have to copy back perfectly for every event.
 * A short per-batch index costs ~1 token, cannot be mangled, and is mapped back
 * to (source, external_id) on our side. That change alone is most of the
 * difference between hitting and missing the §M4 cost target.
 */
export const ExtractedEvent = z.object({
  ref: z.string(),
  job_number: z.string().nullable(),
  project_name: z.string().nullable(),
  counterparty: z.string().nullable(),
  counterparty_type: z.enum(COUNTERPARTY_TYPES),
  category: z.enum(CATEGORIES),
  summary: z.string().max(200),
  action_required: z.boolean(),
  action_owner: z.enum(ACTION_OWNERS),
  blocking_question: z.string().nullable(),
  urgency: z.enum(URGENCIES),
  dates_mentioned: z.array(z.string()).default([]),
  amounts_mentioned: z.array(z.string()).default([]),
  vessel_or_container: z.string().nullable(),
});

export type ExtractedEvent = z.infer<typeof ExtractedEvent>;

export const ExtractionBatch = z.object({
  events: z.array(ExtractedEvent),
});

export type ExtractionBatch = z.infer<typeof ExtractionBatch>;

/** Shape persisted into `events.extracted`, with the ref resolved away. */
export interface StoredExtraction extends Omit<ExtractedEvent, 'ref'> {
  external_id: string;
}

/**
 * Normalizes on the way to storage so the grouping key is always canonical,
 * whatever form the source email used and whatever the model echoed back.
 * "2269-2", "#2269.2", and "Job 2269.02" all store as "2269.2" and therefore
 * land in one block in the brief.
 */
export function toStored(event: ExtractedEvent, externalId: string): StoredExtraction {
  const { ref: _ref, ...rest } = event;
  return {
    ...rest,
    job_number: normalizeJobNumber(rest.job_number),
    external_id: externalId,
  };
}
