import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { accounts, type AccountRow, type AccountStatus } from '../schema';

export async function listAccounts(db: Db): Promise<AccountRow[]> {
  return db.select().from(accounts);
}

export async function listActiveAccounts(db: Db): Promise<AccountRow[]> {
  return db.select().from(accounts).where(eq(accounts.status, 'active'));
}

export async function getAccount(db: Db, id: string): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
  return row;
}

export async function findAccount(
  db: Db,
  provider: string,
  externalId: string,
): Promise<AccountRow | undefined> {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, provider), eq(accounts.externalId, externalId)))
    .limit(1);
  return row;
}

/**
 * Upsert on (provider, external_id) — reconnecting an already-connected
 * mailbox replaces its tokens instead of creating a second row.
 */
export async function upsertAccount(
  db: Db,
  input: {
    provider: string;
    externalId: string;
    email?: string | null;
    displayName?: string | null;
    encryptedTokens: string;
    scopes: string[];
  },
): Promise<AccountRow> {
  const [row] = await db
    .insert(accounts)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      email: input.email ?? null,
      displayName: input.displayName ?? null,
      encryptedTokens: input.encryptedTokens,
      scopes: input.scopes,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [accounts.provider, accounts.externalId],
      set: {
        email: input.email ?? null,
        displayName: input.displayName ?? null,
        encryptedTokens: input.encryptedTokens,
        scopes: input.scopes,
        // Reconnecting clears a reauth_required flag.
        status: 'active',
      },
    })
    .returning();
  return row!;
}

export async function updateTokens(db: Db, id: string, encryptedTokens: string) {
  await db.update(accounts).set({ encryptedTokens }).where(eq(accounts.id, id));
}

export async function setAccountStatus(db: Db, id: string, status: AccountStatus) {
  await db.update(accounts).set({ status }).where(eq(accounts.id, id));
}

export async function deleteAccount(db: Db, id: string) {
  await db.delete(accounts).where(eq(accounts.id, id));
}
