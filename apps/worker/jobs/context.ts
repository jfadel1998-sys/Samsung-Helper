import { env } from '@hub/config';
import { getVault } from '@hub/crypto';
import {
  getDb,
  getSyncState,
  updateTokens,
  type AccountRow,
  type SyncStateRow,
} from '@hub/db';
import { getConnector, type Connector, type SyncCtx } from '@hub/connectors';

export interface AccountContext {
  account: AccountRow;
  connector: Connector;
  state: SyncStateRow | undefined;
  ctx: SyncCtx;
}

/**
 * Builds the SyncCtx for an account: decrypts tokens, wires the persistence
 * callback the connector uses after a refresh, and attaches a logger that
 * tags every line with the account.
 */
export async function buildAccountContext(account: AccountRow): Promise<AccountContext> {
  const db = getDb();
  const vault = getVault();
  const connector = getConnector(account.provider);
  const state = await getSyncState(db, account.id);

  const label = `${account.provider}:${account.email ?? account.externalId}`;

  const ctx: SyncCtx = {
    accountId: account.id,
    tokens: vault.decryptTokens(account.encryptedTokens),
    cursor: state?.cursor ?? null,
    subscriptionId: state?.subscriptionId ?? null,
    baseUrl: env.appBaseUrl,
    saveTokens: async (tokens) => {
      await updateTokens(db, account.id, vault.encryptTokens(tokens));
    },
    log: (msg, meta) => {
      // Never log token or body content — only identifiers and counts.
      console.log(`[${label}] ${msg}`, meta ? JSON.stringify(meta) : '');
    },
  };

  return { account, connector, state, ctx };
}
