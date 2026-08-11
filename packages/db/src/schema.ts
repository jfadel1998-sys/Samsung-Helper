import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Provider identifiers. `source` on `events` is intentionally a superset:
 * future connectors (rss, instagram, replit) write into the same table.
 */
export const PROVIDERS = ['outlook', 'gmail'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ACCOUNT_STATUSES = ['active', 'reauth_required', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const PREFILTER_VERDICTS = ['keep', 'newsletter', 'notification', 'bulk'] as const;
export type PrefilterVerdict = (typeof PREFILTER_VERDICTS)[number];

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    encryptedTokens: text('encrypted_tokens').notNull(),
    scopes: text('scopes').array().notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('accounts_provider_external_id_key').on(t.provider, t.externalId)],
);

export const syncState = pgTable('sync_state', {
  accountId: uuid('account_id')
    .primaryKey()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  /** gmail historyId | graph deltaLink */
  cursor: text('cursor'),
  subscriptionId: text('subscription_id'),
  subscriptionExpiresAt: timestamp('subscription_expires_at', { withTimezone: true }),
  lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
  lastDeltaSyncAt: timestamp('last_delta_sync_at', { withTimezone: true }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  lastError: text('last_error'),
});

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    type: text('type').notNull(),
    externalId: text('external_id').notNull(),
    threadId: text('thread_id'),
    actorName: text('actor_name'),
    actorHandle: text('actor_handle'),
    subject: text('subject'),
    /** normalized plaintext, capped at 4000 chars by the normalizer */
    bodyExcerpt: text('body_excerpt'),
    url: text('url'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    isFromOwner: boolean('is_from_owner').notNull().default(false),
    prefilterVerdict: text('prefilter_verdict'),
    extracted: jsonb('extracted'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    raw: jsonb('raw').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('events_source_external_id_key').on(t.source, t.externalId),
    index('events_occurred_idx').on(t.occurredAt.desc()),
    index('events_pending_extract_idx')
      .on(t.occurredAt)
      .where(sql`${t.extracted} IS NULL AND ${t.prefilterVerdict} = 'keep'`),
    index('events_extracted_gin').using('gin', t.extracted),
    index('events_thread_idx').on(t.threadId, t.occurredAt),
  ],
);

export const briefs = pgTable('briefs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  briefDate: date('brief_date').notNull().unique(),
  markdown: text('markdown').notNull(),
  eventIds: uuid('event_ids').array().notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
export type SyncStateRow = typeof syncState.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type BriefRow = typeof briefs.$inferSelect;
