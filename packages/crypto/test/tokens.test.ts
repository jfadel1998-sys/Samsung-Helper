import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createVault,
  DecryptionError,
  keyIdFor,
  type OAuthTokens,
} from '../src/tokens';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

const SAMPLE: OAuthTokens = {
  accessToken: 'ya29.a0AfB_byC' + 'x'.repeat(120),
  refreshToken: '1//0gL' + 'y'.repeat(80),
  expiresAt: 1_800_000_000_000,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
  tokenType: 'Bearer',
};

describe('vault round trip', () => {
  it('round-trips a token bundle', () => {
    const vault = createVault(KEY_A);
    const sealed = vault.encryptTokens(SAMPLE);
    expect(vault.decryptTokens(sealed)).toEqual(SAMPLE);
  });

  it('never leaves the secret readable in the envelope', () => {
    const vault = createVault(KEY_A);
    const sealed = vault.encryptTokens(SAMPLE);
    expect(sealed).not.toContain(SAMPLE.refreshToken);
    expect(sealed).not.toContain(SAMPLE.accessToken);
    expect(sealed).not.toContain('refreshToken');
  });

  it('produces a distinct ciphertext each time (random IV)', () => {
    const vault = createVault(KEY_A);
    const a = vault.encrypt('same plaintext');
    const b = vault.encrypt('same plaintext');
    expect(a).not.toEqual(b);
    expect(vault.decrypt(a)).toBe('same plaintext');
    expect(vault.decrypt(b)).toBe('same plaintext');
  });

  it('handles unicode and empty strings', () => {
    const vault = createVault(KEY_A);
    for (const s of ['', 'Génova · 石材 · naïve', '🚢📦']) {
      expect(vault.decrypt(vault.encrypt(s))).toBe(s);
    }
  });

  it('stamps the envelope with the key id', () => {
    const vault = createVault(KEY_A);
    const sealed = vault.encrypt('x');
    expect(sealed.split('.')[0]).toBe('v1');
    expect(sealed.split('.')[1]).toBe(keyIdFor(KEY_A));
    expect(vault.isCurrent(sealed)).toBe(true);
  });
});

describe('tamper detection', () => {
  // M1 acceptance: tampered ciphertext must fail auth-tag verification.
  it('rejects a flipped ciphertext byte', () => {
    const vault = createVault(KEY_A);
    const [v, k, iv, tag, ct] = vault.encrypt('sensitive').split('.') as string[];

    const bytes = Buffer.from(ct!, 'base64url');
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);
    const tampered = [v, k, iv, tag, bytes.toString('base64url')].join('.');

    expect(() => vault.decrypt(tampered)).toThrow(DecryptionError);
    expect(() => vault.decrypt(tampered)).toThrow(/authentication failed/i);
  });

  it('rejects a flipped auth tag byte', () => {
    const vault = createVault(KEY_A);
    const [v, k, iv, tag, ct] = vault.encrypt('sensitive').split('.') as string[];

    const bytes = Buffer.from(tag!, 'base64url');
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0x01, 0);

    expect(() => vault.decrypt([v, k, iv, bytes.toString('base64url'), ct].join('.'))).toThrow(
      DecryptionError,
    );
  });

  it('rejects a swapped IV', () => {
    const vault = createVault(KEY_A);
    const a = vault.encrypt('message one').split('.') as string[];
    const b = vault.encrypt('message two').split('.') as string[];

    expect(() => vault.decrypt([a[0], a[1], b[2], a[3], a[4]].join('.'))).toThrow(DecryptionError);
  });

  it('rejects decryption under the wrong key', () => {
    const sealed = createVault(KEY_A).encrypt('secret');
    // Same key id claimed, different key material -> the tag will not verify.
    const forged = createVault(KEY_B);
    const relabelled = [sealed.split('.')[0], forged.keyId, ...sealed.split('.').slice(2)].join('.');
    expect(() => forged.decrypt(relabelled)).toThrow(/authentication failed/i);
  });

  it('rejects malformed envelopes without throwing raw crypto errors', () => {
    const vault = createVault(KEY_A);
    for (const bad of ['', 'nonsense', 'v1.aa.bb.cc', 'v2.aa.bb.cc.dd', 'v1....']) {
      expect(() => vault.decrypt(bad)).toThrow(DecryptionError);
    }
  });

  it('reports a missing key rather than silently failing', () => {
    const sealed = createVault(KEY_A).encrypt('secret');
    expect(() => createVault(KEY_B).decrypt(sealed)).toThrow(/No key available for key id/);
  });
});

describe('key rotation', () => {
  it('decrypts old blobs while writing under the new key', () => {
    const old = createVault(KEY_A);
    const sealedUnderOld = old.encryptTokens(SAMPLE);

    // Deploy state from docs/key-rotation.md step 2.
    const rotated = createVault(KEY_B, [KEY_A]);

    expect(rotated.decryptTokens(sealedUnderOld)).toEqual(SAMPLE);
    expect(rotated.isCurrent(sealedUnderOld)).toBe(false);

    const rewritten = rotated.encryptTokens(SAMPLE);
    expect(rotated.isCurrent(rewritten)).toBe(true);
    expect(rewritten.split('.')[1]).toBe(keyIdFor(KEY_B));

    // Step 4: once re-encrypted, the old key is no longer needed.
    expect(createVault(KEY_B).decryptTokens(rewritten)).toEqual(SAMPLE);
  });

  it('supports more than one previous key', () => {
    const KEY_C = randomBytes(32).toString('base64');
    const oldest = createVault(KEY_A).encrypt('one');
    const older = createVault(KEY_B).encrypt('two');
    const vault = createVault(KEY_C, [KEY_B, KEY_A]);
    expect(vault.decrypt(oldest)).toBe('one');
    expect(vault.decrypt(older)).toBe('two');
  });
});

describe('key validation', () => {
  it('rejects a key that is not 32 bytes', () => {
    expect(() => createVault(randomBytes(16).toString('base64'))).toThrow(/must decode to 32 bytes/);
    expect(() => createVault('not-base64-at-all!!')).toThrow(/must decode to 32 bytes/);
  });
});
