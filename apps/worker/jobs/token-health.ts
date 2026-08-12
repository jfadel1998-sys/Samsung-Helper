import type PgBoss from 'pg-boss';
import { getVault } from '@hub/crypto';
import { getDb, listActiveAccounts, setAccountStatus, updateTokens } from '@hub/db';
import { getConnector, ReauthRequiredError } from '@hub/connectors';
import { QUEUES } from '@hub/jobs';

/** Refresh anything expiring inside this window (§8, hourly job). */
const REFRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

export async function checkTokenHealth(): Promise<void> {
  const db = getDb();
  const vault = getVault();
  const accounts = await listActiveAccounts(db);

  for (const account of accounts) {
    const label = `${account.provider}:${account.email ?? account.externalId}`;

    let tokens;
    try {
      tokens = vault.decryptTokens(account.encryptedTokens);
    } catch (err) {
      // Undecryptable tokens mean a key problem, not a provider problem.
      // Reauthorizing is the only path back.
      console.error(`[token-health] ${label} tokens undecryptable, flagging for reauth`);
      await setAccountStatus(db, account.id, 'reauth_required');
      continue;
    }

    const expiresIn = (tokens.expiresAt ?? 0) - Date.now();
    if (expiresIn > REFRESH_WINDOW_MS) continue;

    try {
      const refreshed = await getConnector(account.provider).refresh(tokens);
      await updateTokens(db, account.id, vault.encryptTokens(refreshed));
      console.log(`[token-health] ${label} refreshed`);
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        // §8: invalid_grant -> reauth_required, and stop. No retry storm.
        await setAccountStatus(db, account.id, 'reauth_required');
        console.error(`[token-health] ${label} needs reauthorization`);
        continue;
      }
      // Transient provider trouble; the next hourly run will try again.
      console.error(
        `[token-health] ${label} refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function registerTokenHealth(boss: PgBoss) {
  await boss.work(QUEUES.tokenHealth, { batchSize: 1 }, async () => {
    await checkTokenHealth();
  });
}
