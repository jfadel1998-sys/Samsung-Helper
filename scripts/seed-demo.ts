/**
 * Seeds a local database with a realistic day of mail and generates a brief
 * with a stubbed model, so the web pages can be exercised without connecting a
 * real mailbox or spending anything.
 *
 *   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... pnpm exec tsx scripts/seed-demo.ts
 */
import { sql } from 'drizzle-orm';
import { getVault } from '@hub/crypto';
import { getDb, getSql, upsertAccount, upsertEvents, type NewEventRow } from '@hub/db';
import { generateBrief, briefDateFor } from '@hub/brief';
import type { MessagesCreateClient } from '@hub/brief';

const db = getDb();
const vault = getVault();

await db.execute(sql`TRUNCATE TABLE events, sync_state, briefs, accounts CASCADE`);

const account = await upsertAccount(db, {
  provider: 'outlook',
  externalId: 'demo-user',
  email: 'jason@traxtone.com',
  displayName: 'Jason',
  encryptedTokens: vault.encryptTokens({ accessToken: 'demo', refreshToken: 'demo' }),
  scopes: ['Mail.Read', 'offline_access', 'User.Read'],
  audience: 'jason',
});

const moetAccount = await upsertAccount(db, {
  provider: 'outlook',
  externalId: 'demo-moet',
  email: 'moet@traxtone.com',
  displayName: 'Moet',
  encryptedTokens: vault.encryptTokens({ accessToken: 'demo', refreshToken: 'demo' }),
  scopes: ['Mail.Read', 'offline_access', 'User.Read'],
  audience: 'moet',
});

await db.execute(sql`
  INSERT INTO sync_state (account_id, cursor, subscription_id, subscription_expires_at,
                          last_full_sync_at, last_delta_sync_at, consecutive_failures)
  VALUES (${account.id}::uuid, 'delta-token', 'sub-1', now() + interval '40 hours',
          now() - interval '3 hours', now() - interval '12 minutes', 0)
  ON CONFLICT (account_id) DO NOTHING
`);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function ev(
  externalId: string,
  over: Partial<NewEventRow>,
  extracted: Record<string, unknown> | null,
): NewEventRow {
  return {
    accountId: account.id,
    source: 'outlook',
    type: 'email',
    externalId,
    threadId: `thread-${externalId}`,
    actorName: 'Unknown',
    actorHandle: 'someone@example.com',
    subject: '(no subject)',
    bodyExcerpt: 'body',
    url: `https://outlook.office365.com/owa/?ItemID=${externalId}`,
    occurredAt: hoursAgo(6),
    isFromOwner: false,
    prefilterVerdict: 'keep',
    extracted: extracted as NewEventRow['extracted'],
    extractedAt: extracted ? new Date() : null,
    raw: {},
    ...over,
  };
}

const base = {
  dates_mentioned: [] as string[],
  amounts_mentioned: [] as string[],
  vessel_or_container: null,
};

await upsertEvents(db, [
  ev(
    'm1',
    {
      actorName: 'T. Nickolas',
      actorHandle: 't.nickolas@example-supplier.it',
      subject: '2269.2 GVR Local Stone — revised pricing',
      occurredAt: hoursAgo(5),
    },
    {
      ...base,
      external_id: 'm1',
      job_number: '2269.2',
      project_name: 'GVR Local Stone',
      counterparty: 'T. Nickolas',
      counterparty_type: 'supplier',
      category: 'pricing',
      summary: 'Confirmed revised pricing on 12 line items; lead time now 6-8 weeks from PO.',
      action_required: true,
      action_owner: 'jason',
      blocking_question: null,
      urgency: 'high',
      amounts_mentioned: ['12 line items'],
    },
  ),
  ev(
    'm2',
    {
      actorName: 'Moet',
      actorHandle: 'moet@traxtone.com',
      subject: 'FOB clarification still open',
      threadId: 'thread-fob',
      occurredAt: hoursAgo(74),
    },
    {
      ...base,
      external_id: 'm2',
      job_number: '2269.2',
      project_name: 'GVR Local Stone',
      counterparty: 'Example Supplier',
      counterparty_type: 'supplier',
      category: 'shipping_logistics',
      summary: 'Waiting on FOB clarification from the supplier before the PO can be released.',
      action_required: true,
      action_owner: 'moet',
      blocking_question: 'FOB Livorno or ex-works Carrara?',
      urgency: 'high',
    },
  ),
  ev(
    'm3',
    {
      actorName: 'Genoa Freight',
      actorHandle: 'ops@example-forwarder.com',
      subject: 'Genoa vessel change',
      threadId: 'thread-genoa',
      occurredAt: hoursAgo(96),
    },
    {
      ...base,
      external_id: 'm3',
      job_number: '2269.2',
      project_name: 'GVR Local Stone',
      counterparty: 'Genoa Freight',
      counterparty_type: 'freight_forwarder',
      category: 'shipping_logistics',
      summary: 'Genoa sailing rolled; no reply since Tuesday on the replacement vessel.',
      action_required: false,
      action_owner: 'other',
      blocking_question: 'Replacement vessel and revised ETA',
      urgency: 'critical',
      vessel_or_container: 'MSCU1234567',
    },
  ),
  ev(
    'm4',
    {
      actorName: 'Vegas Stoneworks',
      actorHandle: 'shop@example-fabricator.com',
      subject: 'Templating window',
      occurredAt: hoursAgo(9),
    },
    {
      ...base,
      external_id: 'm4',
      job_number: '3310',
      project_name: 'Palms Tower 2',
      counterparty: 'Vegas Stoneworks',
      counterparty_type: 'fabricator',
      category: 'scheduling',
      summary: 'Can template tower 2 the week of the 14th if slabs are on site.',
      action_required: false,
      action_owner: 'none',
      blocking_question: null,
      urgency: 'normal',
      dates_mentioned: ['week of the 14th'],
    },
  ),
  // In Moet's mailbox — these must appear only in her brief.
  ev(
    'moet-1',
    {
      accountId: moetAccount.id,
      actorName: 'Example Supplier',
      actorHandle: 'ar@example-supplier.it',
      subject: 'RE: FOB clarification',
      threadId: 'thread-moet-fob',
      occurredAt: hoursAgo(30),
    },
    {
      ...base,
      external_id: 'moet-1',
      job_number: '2269.2',
      project_name: 'GVR Local Stone',
      counterparty: 'Example Supplier',
      counterparty_type: 'supplier',
      category: 'shipping_logistics',
      summary: 'No answer yet on whether terms are FOB Livorno or ex-works Carrara.',
      action_required: true,
      action_owner: 'moet',
      blocking_question: 'FOB Livorno or ex-works Carrara?',
      urgency: 'high',
    },
  ),
  ev(
    'moet-2',
    {
      accountId: moetAccount.id,
      actorName: 'Vegas Stoneworks',
      actorHandle: 'shop@example-fabricator.com',
      subject: 'Templating confirmed',
      threadId: 'thread-moet-template',
      occurredAt: hoursAgo(8),
    },
    {
      ...base,
      external_id: 'moet-2',
      job_number: '3310',
      project_name: 'Palms Tower 2',
      counterparty: 'Vegas Stoneworks',
      counterparty_type: 'fabricator',
      category: 'scheduling',
      summary: 'Confirmed the templating window for tower 2.',
      action_required: false,
      action_owner: 'none',
      blocking_question: null,
      urgency: 'normal',
    },
  ),
  // Filtered out by the prefilter — present so /ops shows a realistic cut.
  ...Array.from({ length: 22 }, (_, i) =>
    ev(
      `noise-${i}`,
      {
        actorHandle: `newsletter${i}@example-news.com`,
        subject: `Industry digest ${i}`,
        prefilterVerdict: i % 3 === 0 ? 'newsletter' : i % 3 === 1 ? 'notification' : 'bulk',
        occurredAt: hoursAgo(3),
      },
      null,
    ),
  ),
]);

const stub: MessagesCreateClient = {
  create: async () => ({
    content: [
      {
        type: 'text',
        text: `## Needs you today
- **2269.2 GVR Local Stone** — T. Nickolas confirmed revised pricing on 12 line items; lead time is now 6-8 weeks from PO.

## By job

### 2269.2 GVR Local Stone
- Vegas Stoneworks can template tower 2 the week of the 14th if slabs are on site.

## Waiting on others
- Genoa vessel change unresolved — the freight forwarder has not replied on the replacement vessel or revised ETA for container MSCU1234567 (4 days open).
- Moet still waiting on FOB clarification from the supplier — Livorno or ex-works Carrara (3 days open).`,
      },
    ],
    usage: { input_tokens: 1180, output_tokens: 240 },
  }),
};

const moetStub: MessagesCreateClient = {
  create: async () => ({
    content: [
      {
        type: 'text',
        text: `## Needs you today
- **2269.2 GVR Local Stone** — supplier has not answered the FOB question (Livorno or ex-works Carrara); the PO cannot be released until it is settled.

## Everything else
- Vegas Stoneworks confirmed the templating window for Palms Tower 2.`,
      },
    ],
    usage: { input_tokens: 640, output_tokens: 120 },
  }),
};

const briefDate = briefDateFor(new Date(), process.env.BRIEF_TIMEZONE ?? 'America/Los_Angeles');
const window = { from: hoursAgo(24 * 7), to: new Date(Date.now() + 60_000) };

const jasonBrief = await generateBrief(db, {
  briefDate,
  audience: 'jason',
  audienceLabel: 'Jason',
  ...window,
  client: stub,
});
const moetBrief = await generateBrief(db, {
  briefDate,
  audience: 'moet',
  audienceLabel: 'Moet',
  ...window,
  client: moetStub,
});

console.log(
  `seeded: 2 accounts, 28 events\n` +
    `  brief ${briefDate} jason: ${jasonBrief.itemCount} item(s)` +
    `${jasonBrief.lintWarnings.length ? ` (lint: ${jasonBrief.lintWarnings.join(', ')})` : ''}\n` +
    `  brief ${briefDate} moet:  ${moetBrief.itemCount} item(s)` +
    `${moetBrief.lintWarnings.length ? ` (lint: ${moetBrief.lintWarnings.join(', ')})` : ''}`,
);

await getSql().end();
