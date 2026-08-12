import { env } from '@hub/config';
import type { OAuthTokens } from '@hub/crypto';
import { HttpError, requestJson } from '../http';
import { ReauthRequiredError } from '../types';

export const OUTLOOK_PROVIDER = 'outlook';

/** M2: single-tenant app registration, exactly these scopes. */
export const OUTLOOK_SCOPES = ['Mail.Read', 'offline_access', 'User.Read'];

function authority() {
  return `https://login.microsoftonline.com/${env.microsoft.tenantId}/oauth2/v2.0`;
}

export function outlookRedirectUri(): string {
  return `${env.appBaseUrl}/api/auth/outlook/callback`;
}

export function getAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.microsoft.clientId,
    response_type: 'code',
    redirect_uri: outlookRedirectUri(),
    response_mode: 'query',
    scope: OUTLOOK_SCOPES.join(' '),
    state,
  });
  return `${authority()}/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

function toTokens(res: TokenResponse, previous?: OAuthTokens): OAuthTokens {
  return {
    accessToken: res.access_token,
    // Azure does not always re-issue a refresh token; keep the one we hold.
    refreshToken: res.refresh_token ?? previous?.refreshToken,
    expiresAt: Date.now() + res.expires_in * 1000,
    scope: res.scope ?? previous?.scope,
    tokenType: res.token_type ?? 'Bearer',
  };
}

async function tokenRequest(form: Record<string, string>, previous?: OAuthTokens) {
  try {
    const { body } = await requestJson<TokenResponse>(`${authority()}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      retries: 2,
    });
    return toTokens(body, previous);
  } catch (err) {
    if (err instanceof HttpError) {
      const code = (err.body as { error?: string } | null)?.error;
      // invalid_grant means the refresh token is revoked or expired. §8: flip
      // the account to reauth_required and stop — do not retry.
      if (code === 'invalid_grant' || err.status === 400) {
        throw new ReauthRequiredError(`Outlook token exchange rejected: ${code ?? err.status}`);
      }
    }
    throw err;
  }
}

export async function exchangeCode(code: string): Promise<{
  tokens: OAuthTokens;
  externalId: string;
  email?: string;
  displayName?: string;
}> {
  const tokens = await tokenRequest({
    client_id: env.microsoft.clientId,
    client_secret: env.microsoft.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: outlookRedirectUri(),
    scope: OUTLOOK_SCOPES.join(' '),
  });

  const { body: me } = await requestJson<{
    id: string;
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  }>('https://graph.microsoft.com/v1.0/me', {
    headers: { authorization: `Bearer ${tokens.accessToken}` },
  });

  return {
    tokens,
    externalId: me.id,
    email: me.mail ?? me.userPrincipalName,
    displayName: me.displayName,
  };
}

export async function refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
  if (!tokens.refreshToken) {
    throw new ReauthRequiredError('No Outlook refresh token stored');
  }
  return tokenRequest(
    {
      client_id: env.microsoft.clientId,
      client_secret: env.microsoft.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      scope: OUTLOOK_SCOPES.join(' '),
    },
    tokens,
  );
}

/** Refresh slightly early so a long sync can't expire mid-flight. */
export function isExpiring(tokens: OAuthTokens, withinMs = 5 * 60_000): boolean {
  if (!tokens.expiresAt) return true;
  return tokens.expiresAt - Date.now() <= withinMs;
}
