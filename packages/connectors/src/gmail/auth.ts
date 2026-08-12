import { env } from '@hub/config';
import type { OAuthTokens } from '@hub/crypto';
import { HttpError, requestJson } from '../http';
import { ReauthRequiredError } from '../types';

export const GMAIL_PROVIDER = 'gmail';

/**
 * `gmail.readonly` is a RESTRICTED scope (§2.1). The consequence is not in
 * this file but in the Google Cloud console: a project left in "Testing"
 * publishing status issues refresh tokens that die after 7 days, silently.
 * See docs/gmail-setup.md.
 *
 * openid/email are not restricted and cost nothing extra at consent; they give
 * a stable subject id so the account survives an address change.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'email',
];

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function gmailRedirectUri(): string {
  return `${env.appBaseUrl}/api/auth/gmail/callback`;
}

export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: gmailRedirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    // Both are required to be issued a refresh token at all.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

function toTokens(res: TokenResponse, previous?: OAuthTokens): OAuthTokens {
  return {
    accessToken: res.access_token,
    // Google issues a refresh token only on the first consent.
    refreshToken: res.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + res.expires_in * 1000,
    scope: res.scope ?? previous?.scope,
    tokenType: res.token_type ?? 'Bearer',
    idToken: res.id_token ?? previous?.idToken,
  };
}

async function tokenRequest(
  form: Record<string, string>,
  previous?: OAuthTokens,
): Promise<OAuthTokens> {
  try {
    const { body } = await requestJson<TokenResponse>(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      retries: 2,
    });
    return toTokens(body, previous);
  } catch (err) {
    if (err instanceof HttpError) {
      const code = (err.body as { error?: string } | null)?.error;
      // The 7-day expiry from §2.1 surfaces here, as invalid_grant, on an app
      // that was never moved out of "Testing".
      if (code === 'invalid_grant') {
        throw new ReauthRequiredError(
          'Gmail refresh token rejected (invalid_grant). If the Google Cloud app is in ' +
            '"Testing" publishing status, refresh tokens expire after 7 days — see §2.1.',
        );
      }
      if (err.status === 400 || err.status === 401) {
        throw new ReauthRequiredError(`Gmail token exchange rejected: ${code ?? err.status}`);
      }
    }
    throw err;
  }
}

/**
 * Reads the payload of an id_token without verifying it.
 *
 * Safe here and only here: this token came straight back from Google's token
 * endpoint over TLS in a request we initiated. Tokens arriving from anywhere
 * else — notably the Pub/Sub push JWT — are verified properly in webhook.ts.
 */
function readIdTokenClaims(idToken: string | undefined): { sub?: string; email?: string } {
  if (!idToken) return {};
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export async function exchangeCode(code: string): Promise<{
  tokens: OAuthTokens;
  externalId: string;
  email?: string;
  displayName?: string;
}> {
  const tokens = await tokenRequest({
    client_id: env.google.clientId,
    client_secret: env.google.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: gmailRedirectUri(),
  });

  if (!tokens.refreshToken) {
    // Without a refresh token the connection is dead in an hour. This happens
    // when the user has consented before and `prompt=consent` was dropped.
    throw new ReauthRequiredError(
      'Google did not return a refresh token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and reconnect.',
    );
  }

  const claims = readIdTokenClaims(tokens.idToken);

  // getProfile also gives us the mailbox's current historyId, but the email
  // address is what we need here.
  const { body: profile } = await requestJson<{ emailAddress?: string }>(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  );

  const email = profile.emailAddress ?? claims.email;

  return {
    tokens,
    // Prefer the stable subject id; fall back to the address.
    externalId: claims.sub ?? email ?? 'gmail-unknown',
    email,
    displayName: email,
  };
}

export async function refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new ReauthRequiredError('No Gmail refresh token stored');
  }
  return tokenRequest(
    {
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    },
    tokens,
  );
}

export function isExpiring(tokens: OAuthTokens, withinMs = 5 * 60_000): boolean {
  if (!tokens.expiresAt) return true;
  return tokens.expiresAt - Date.now() <= withinMs;
}
