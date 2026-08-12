/**
 * IMAP "auth" — an app password, not OAuth.
 *
 * This connector exists because `gmail.readonly` is a restricted scope (§2.1)
 * and a PERSONAL Gmail account cannot use the Internal-Workspace escape hatch.
 * The only OAuth path for a personal account is Google's CASA assessment
 * (paid, weeks), and an unverified app issues refresh tokens that die every
 * 7 days.
 *
 * IMAP with an app password sidesteps all of it: no verification, no
 * expiry, and it works across several personal accounts. See
 * docs/imap-setup.md.
 */
import type { OAuthTokens } from '@hub/crypto';
import { ReauthRequiredError, type Credentials, type StoredCredentials } from '../types';

export const IMAP_PROVIDER = 'imap';

/** IMAP grants whole-mailbox read; there are no scopes to request. */
export const IMAP_SCOPES = ['imap:read'];

export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const IMAP_TLS_PORT = 993;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Implicit TLS on 993, which is what Gmail uses. Anything else is only allowed
 * against loopback — sending an app password in the clear to a remote host is
 * never something we should do quietly because a port happened to differ.
 */
export function isSecurePort(host: string, port: number): boolean {
  if (port === IMAP_TLS_PORT) return true;
  if (LOOPBACK.has(host.toLowerCase())) return false;
  throw new ReauthRequiredError(
    `Refusing to send IMAP credentials unencrypted to ${host}:${port}. ` +
      `Use port ${IMAP_TLS_PORT} (implicit TLS).`,
  );
}

export function resolveCredentials(input: Credentials): StoredCredentials {
  const username = input.username.trim().toLowerCase();
  if (!username || !input.password) {
    throw new ReauthRequiredError('IMAP username and app password are both required');
  }
  const host = input.host?.trim() || GMAIL_IMAP_HOST;
  const port = input.port ?? IMAP_TLS_PORT;
  // Throws for a non-TLS remote host before anything is stored.
  isSecurePort(host, port);

  return {
    username,
    // App passwords are shown with spaces ("abcd efgh ijkl mnop") and Google
    // accepts them either way, but stripping avoids a confusing auth failure
    // when someone pastes the spaced form.
    password: input.password.replace(/\s+/g, ''),
    host,
    port,
  };
}

export function credentialsFrom(tokens: OAuthTokens): StoredCredentials {
  const creds = tokens.credentials;
  if (!creds?.username || !creds.password) {
    throw new ReauthRequiredError('No IMAP credentials stored for this account');
  }
  return {
    username: creds.username,
    password: creds.password,
    host: creds.host || GMAIL_IMAP_HOST,
    port: creds.port || IMAP_TLS_PORT,
  };
}

export function toTokens(creds: StoredCredentials): OAuthTokens {
  return {
    // Nothing to bear — the password IS the credential, and it is only ever
    // read back out of the encrypted blob to open a socket.
    accessToken: '',
    credentials: creds,
  };
}

/**
 * Credentials never expire, so there is nothing to refresh. Returning the
 * tokens unchanged keeps the hourly token-health job uniform across
 * connectors rather than special-casing this one.
 */
export async function refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
  credentialsFrom(tokens); // throws ReauthRequiredError if they are missing
  return tokens;
}

/**
 * Maps a provider auth failure onto ReauthRequiredError so §8's policy applies
 * — flag the account and stop, rather than retrying a wrong password forever.
 *
 * Verified against a real IMAP server: imapflow throws a plain Error whose
 * message is only "Command failed". The signal is on the properties —
 * `authenticationFailed: true` and `serverResponseCode: 'AUTHENTICATIONFAILED'`
 * — so matching the message alone lets a wrong password fall through as a
 * generic error and get retried. Text matching is kept as a fallback for
 * servers that answer NO with a bare description and no response code.
 */
export function isAuthFailure(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { authenticationFailed?: unknown; serverResponseCode?: unknown };
    if (e.authenticationFailed === true) return true;
    if (typeof e.serverResponseCode === 'string' && /^AUTHENTICATIONFAILED$/i.test(e.serverResponseCode)) {
      return true;
    }
  }

  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    const text = (err as Error & { responseText?: unknown }).responseText;
    if (typeof text === 'string') parts.push(text);
  } else {
    parts.push(String(err));
  }

  return /AUTHENTICATIONFAILED|Invalid credentials|Authentication failed|LOGIN failed|Application-specific password required/i.test(
    parts.join(' '),
  );
}
