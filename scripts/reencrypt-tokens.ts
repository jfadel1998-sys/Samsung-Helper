/**
 * Re-encrypts every stored token bundle under the current TOKEN_ENCRYPTION_KEY.
 * Step 3 of docs/key-rotation.md.
 *
 * Idempotent: rows already sealed under the primary key are skipped, so this
 * is safe to re-run after an interruption.
 *
 *   DATABASE_URL=... TOKEN_ENCRYPTION_KEY=<new> TOKEN_ENCRYPTION_KEY_PREVIOUS=<old> \
 *     pnpm exec tsx scripts/reencrypt-tokens.ts
 */
import { getDb, getSql, listAccounts, updateTokens } from '@hub/db';
import { getVault } from '@hub/crypto';

const db = getDb();
const vault = getVault();

const accounts = await listAccounts(db);
let rewritten = 0;
let skipped = 0;
let failed = 0;

for (const account of accounts) {
  const label = `${account.provider}:${account.email ?? account.externalId}`;

  if (vault.isCurrent(account.encryptedTokens)) {
    skipped++;
    continue;
  }

  try {
    // Decrypt under whichever key sealed it, re-seal under the primary key.
    const tokens = vault.decryptTokens(account.encryptedTokens);
    await updateTokens(db, account.id, vault.encryptTokens(tokens));
    rewritten++;
    console.log(`re-encrypted ${label}`);
  } catch (err) {
    failed++;
    // Never print the payload — only which account and why.
    console.error(`FAILED ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const remaining = (await listAccounts(db)).filter((a) => !vault.isCurrent(a.encryptedTokens)).length;

console.log(
  `\ndone: ${rewritten} re-encrypted, ${skipped} already current, ${failed} failed\n` +
    `${remaining} remaining under previous keys`,
);

if (remaining > 0) {
  console.error('Do NOT clear TOKEN_ENCRYPTION_KEY_PREVIOUS yet.');
}

await getSql().end();
process.exit(failed > 0 ? 1 : 0);
