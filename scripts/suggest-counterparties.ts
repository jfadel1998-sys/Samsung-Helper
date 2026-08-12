/**
 * Proposes counterparty allowlist entries from the mail you have actually
 * received. See docs/counterparties.md.
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/suggest-counterparties.ts
 *
 * Read-only — it prints a suggestion and never edits your config.
 */
import { sql } from 'drizzle-orm';
import { counterpartyConfig, renderConfigBlock, suggestCounterparties } from '@hub/config';
import type { SenderObservation } from '@hub/config';
import { getDb, getSql } from '@hub/db';

const db = getDb();
const cfg = counterpartyConfig();

const rows = (await db.execute<{
  actor_handle: string | null;
  thread_id: string | null;
  subject: string | null;
  body_excerpt: string | null;
  is_from_owner: boolean;
  thread_has_owner_reply: boolean;
}>(sql`
  SELECT
    e.actor_handle,
    e.thread_id,
    e.subject,
    left(e.body_excerpt, 800) AS body_excerpt,
    e.is_from_owner,
    COALESCE(o.replied, false) AS thread_has_owner_reply
  FROM events e
  LEFT JOIN (
    SELECT thread_id, true AS replied
    FROM events
    WHERE is_from_owner AND thread_id IS NOT NULL
    GROUP BY thread_id
  ) o ON o.thread_id = e.thread_id
`)) as unknown as Array<Record<string, unknown>>;

if (rows.length === 0) {
  console.log(
    'No events ingested yet. Connect a mailbox and let the first backfill finish,\n' +
      'then run this again.',
  );
  await getSql().end();
  process.exit(0);
}

const observations: SenderObservation[] = rows.map((r) => ({
  actorHandle: (r.actor_handle as string) ?? null,
  threadId: (r.thread_id as string) ?? null,
  subject: (r.subject as string) ?? null,
  bodyExcerpt: (r.body_excerpt as string) ?? null,
  isFromOwner: Boolean(r.is_from_owner),
  threadHasOwnerReply: Boolean(r.thread_has_owner_reply),
}));

const suggestions = suggestCounterparties(observations, {
  known: new Set(Object.keys(cfg.domains)),
  ignore: new Set([...cfg.notificationDomains, ...Object.keys(cfg.domains).filter(
    (d) => cfg.domains[d] === 'internal',
  )]),
});

const fresh = suggestions.filter((s) => !s.alreadyListed);
const listed = suggestions.filter((s) => s.alreadyListed);

console.log(
  `\nScanned ${rows.length} events across ${suggestions.length} sender domain(s).\n` +
    `${fresh.length} not yet in config/counterparties.json.\n`,
);
console.log('Sorted strongest first. "replied" is the number of threads you answered —');
console.log('that is the signal that matters most; nobody replies to a newsletter.\n');

const pad = (s: string, n: number) => s.padEnd(n);

for (const s of fresh.slice(0, 40)) {
  console.log(
    `${pad(s.domain, 34)} ${String(s.messages).padStart(4)} msgs  ` +
      `${String(s.threads).padStart(3)} threads  ` +
      `${String(s.repliedThreads).padStart(3)} replied   → ${s.guess}`,
  );
  if (s.evidence.length > 0) {
    console.log(`${' '.repeat(36)}guessed from: ${s.evidence.map((e) => `"${e}"`).join(', ')}`);
  }
  if (s.looksLikeBroadcast) {
    console.log(
      `${' '.repeat(36)}⚠ several threads, never answered — reads as broadcast, probably skip`,
    );
  }
  const senders = s.senders.slice(0, 4).map((a) => a.split('@')[0] + '@');
  console.log(
    `${' '.repeat(36)}senders: ${senders.join(', ')}` +
      (s.senders.length > 4 ? ` (+${s.senders.length - 4} more)` : ''),
  );
  console.log('');
}

if (listed.length > 0) {
  console.log(`Already in your config (${listed.length}): ${listed.map((s) => s.domain).join(', ')}\n`);
}

console.log('─'.repeat(72));
console.log('Review the guesses, then paste into the "domains" object of');
console.log('config/counterparties.json:\n');
console.log(renderConfigBlock(suggestions));
console.log('');

await getSql().end();
