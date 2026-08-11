# Rotating `TOKEN_ENCRYPTION_KEY`

OAuth refresh tokens are encrypted at rest with AES-256-GCM (§9). Rotating the
key is a three-deploy process. It never requires re-authorizing a mailbox.

Every ciphertext carries a key ID in its envelope (`v1.<keyId>.<iv>.<tag>.<ct>`),
where `keyId` is the first 8 hex chars of SHA-256 over the raw key bytes. That
is what makes a staged rotation possible: the decryptor picks the key that
actually encrypted a given blob instead of guessing.

## 1. Generate the new key

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 2. Deploy with both keys present

Set on **both** the web and worker services:

- `TOKEN_ENCRYPTION_KEY` — the **new** key
- `TOKEN_ENCRYPTION_KEY_PREVIOUS` — the **old** key (comma-separated if more than one)

At this point:

- everything written encrypts under the new key
- everything already stored still decrypts, because the old key is in the
  decrypt-only set and the envelope names which key each row needs

Nothing is broken and no mailbox has to be reconnected. Do not skip straight to
step 4 — clearing the old key before step 3 makes every stored token
undecryptable, which means reconnecting every account by hand.

## 3. Re-encrypt stored rows

```sh
DATABASE_URL=... TOKEN_ENCRYPTION_KEY=... TOKEN_ENCRYPTION_KEY_PREVIOUS=... \
  pnpm --filter @hub/db exec tsx ../../scripts/reencrypt-tokens.ts
```

The script is idempotent — rows already under the current key are skipped — so
it is safe to re-run if it is interrupted partway.

## 4. Drop the old key

Once the script reports `0 remaining under previous keys`, clear
`TOKEN_ENCRYPTION_KEY_PREVIOUS` and redeploy.

## Recovery

If the key is lost outright, no stored token is recoverable. Clear
`accounts.encrypted_tokens`, set every account to `status = 'reauth_required'`,
and reconnect each mailbox through the UI. Ingested `events` are unaffected —
only the credentials are encrypted.
