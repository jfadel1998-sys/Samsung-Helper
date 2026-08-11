import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createVault } from '@hub/crypto';
import {
  deleteAccount,
  findAccount,
  getAccount,
  listAccounts,
  listActiveAccounts,
  setAccountStatus,
  updateTokens,
  upsertAccount,
} from '../src/repos/accounts';
import type { Db } from '../src/client';
import { closeTestDb, connectTestDb, hasTestDb, truncateAll } from './helpers';

const vault = createVault(randomBytes(32).toString('base64'));

describe.skipIf(!hasTestDb)('accounts repository', () => {
  let db: Db;

  beforeAll(async () => {
    db = await connectTestDb();
  });
  afterAll(closeTestDb);
  beforeEach(async () => {
    await truncateAll(db);
  });

  const base = {
    provider: 'outlook',
    externalId: 'AAD-USER-1',
    email: 'jason@traxtone.com',
    displayName: 'Jason',
    scopes: ['Mail.Read', 'offline_access', 'User.Read'],
  };

  it('creates and reads back an account with its scopes array', async () => {
    const created = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'a', refreshToken: 'r' }),
    });

    expect(created.status).toBe('active');
    expect(created.scopes).toEqual(base.scopes);

    const found = await getAccount(db, created.id);
    expect(found?.email).toBe('jason@traxtone.com');
    expect(vault.decryptTokens(found!.encryptedTokens).refreshToken).toBe('r');
  });

  it('reconnecting the same mailbox replaces tokens instead of duplicating', async () => {
    const first = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'old', refreshToken: 'old-r' }),
    });
    const second = await upsertAccount(db, {
      ...base,
      displayName: 'Jason F',
      encryptedTokens: vault.encryptTokens({ accessToken: 'new', refreshToken: 'new-r' }),
    });

    expect(second.id).toBe(first.id);
    expect(await listAccounts(db)).toHaveLength(1);
    expect(second.displayName).toBe('Jason F');
    expect(vault.decryptTokens(second.encryptedTokens).accessToken).toBe('new');
  });

  it('treats the same external id under a different provider as a separate account', async () => {
    await upsertAccount(db, { ...base, encryptedTokens: vault.encryptTokens({ accessToken: 'a' }) });
    await upsertAccount(db, {
      ...base,
      provider: 'gmail',
      encryptedTokens: vault.encryptTokens({ accessToken: 'b' }),
    });
    expect(await listAccounts(db)).toHaveLength(2);
  });

  it('reconnecting clears a reauth_required flag', async () => {
    const acct = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'a' }),
    });
    await setAccountStatus(db, acct.id, 'reauth_required');
    expect((await getAccount(db, acct.id))?.status).toBe('reauth_required');
    expect(await listActiveAccounts(db)).toHaveLength(0);

    const reconnected = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'fresh' }),
    });
    expect(reconnected.status).toBe('active');
    expect(await listActiveAccounts(db)).toHaveLength(1);
  });

  it('rotates stored tokens in place', async () => {
    const acct = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'a', refreshToken: 'r' }),
    });
    await updateTokens(db, acct.id, vault.encryptTokens({ accessToken: 'a2', refreshToken: 'r' }));

    const after = await getAccount(db, acct.id);
    expect(vault.decryptTokens(after!.encryptedTokens).accessToken).toBe('a2');
  });

  it('finds by provider and external id, and deletes', async () => {
    const acct = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'a' }),
    });
    expect((await findAccount(db, 'outlook', 'AAD-USER-1'))?.id).toBe(acct.id);
    expect(await findAccount(db, 'outlook', 'nope')).toBeUndefined();

    await deleteAccount(db, acct.id);
    expect(await listAccounts(db)).toHaveLength(0);
  });

  it('stores only ciphertext — no plaintext token reaches the column', async () => {
    const acct = await upsertAccount(db, {
      ...base,
      encryptedTokens: vault.encryptTokens({ accessToken: 'super-secret', refreshToken: 'rt-xyz' }),
    });
    const row = await getAccount(db, acct.id);
    expect(row!.encryptedTokens).not.toContain('super-secret');
    expect(row!.encryptedTokens).not.toContain('rt-xyz');
    expect(row!.encryptedTokens.startsWith('v1.')).toBe(true);
  });
});
