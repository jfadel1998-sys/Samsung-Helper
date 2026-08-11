/**
 * Token vault — AES-256-GCM at rest (§9).
 *
 * Envelope format (all parts base64url, dot separated):
 *
 *   v1.<keyId>.<iv>.<authTag>.<ciphertext>
 *
 * `keyId` is the first 8 hex chars of SHA-256 over the raw key bytes. It is
 * not a secret; it exists so decryption can select the key that actually
 * encrypted a given row rather than trying every key in turn. That is what
 * lets `TOKEN_ENCRYPTION_KEY` be rotated without reconnecting every mailbox
 * (docs/key-rotation.md).
 *
 * Nothing in this module logs plaintext, and errors never quote it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch millis. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  /** Gmail returns an id_token we keep for the account's stable subject id. */
  idToken?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function parseKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return key;
}

export function keyIdFor(rawKey: string): string {
  return createHash('sha256').update(parseKey(rawKey)).digest('hex').slice(0, 8);
}

export interface Vault {
  encrypt(plaintext: string): string;
  decrypt(envelope: string): string;
  encryptTokens(tokens: OAuthTokens): string;
  decryptTokens(envelope: string): OAuthTokens;
  /** True when the blob is already sealed under the current primary key. */
  isCurrent(envelope: string): boolean;
  readonly keyId: string;
}

/**
 * @param primary       base64 key used for all new writes
 * @param previousKeys  base64 keys accepted for decryption only (rotation)
 */
export function createVault(primary: string, previousKeys: string[] = []): Vault {
  const primaryKey = parseKey(primary);
  const primaryId = keyIdFor(primary);

  const keyring = new Map<string, Buffer>([[primaryId, primaryKey]]);
  for (const raw of previousKeys) {
    keyring.set(keyIdFor(raw), parseKey(raw));
  }

  function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, primaryKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, primaryId, b64url(iv), b64url(tag), b64url(ciphertext)].join('.');
  }

  function decrypt(envelope: string): string {
    const parts = envelope.split('.');
    if (parts.length !== 5) {
      throw new DecryptionError('Malformed token envelope');
    }
    const [version, keyId, ivB64, tagB64, ctB64] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (version !== VERSION) {
      throw new DecryptionError(`Unsupported token envelope version: ${version}`);
    }

    const key = keyring.get(keyId);
    if (!key) {
      throw new DecryptionError(
        `No key available for key id ${keyId}. If TOKEN_ENCRYPTION_KEY was rotated, ` +
          'put the previous key in TOKEN_ENCRYPTION_KEY_PREVIOUS.',
      );
    }

    const iv = Buffer.from(ivB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new DecryptionError('Malformed token envelope');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Auth tag mismatch: the blob was tampered with or the key is wrong.
      // The underlying message is deliberately not surfaced.
      throw new DecryptionError('Token authentication failed');
    }
  }

  return {
    keyId: primaryId,
    encrypt,
    decrypt,
    encryptTokens: (tokens) => encrypt(JSON.stringify(tokens)),
    decryptTokens: (envelope) => {
      const json = decrypt(envelope);
      try {
        return JSON.parse(json) as OAuthTokens;
      } catch {
        throw new DecryptionError('Decrypted payload is not valid token JSON');
      }
    },
    isCurrent: (envelope) => envelope.split('.')[1] === primaryId,
  };
}

let cached: Vault | undefined;

/** Process-wide vault built from the environment. */
export function getVault(): Vault {
  if (!cached) {
    const primary = process.env.TOKEN_ENCRYPTION_KEY;
    if (!primary) throw new Error('Missing required environment variable: TOKEN_ENCRYPTION_KEY');
    const previous = (process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    cached = createVault(primary, previous);
  }
  return cached;
}

/** Test seam. */
export function resetVault() {
  cached = undefined;
}
