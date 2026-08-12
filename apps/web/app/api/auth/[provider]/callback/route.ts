import { getVault } from '@hub/crypto';
import { getConnector, hasConnector } from '@hub/connectors';
import { getDb, upsertAccount } from '@hub/db';
import { enqueueSync } from '@hub/jobs';
import { hasSession } from '../../../../../lib/session';
import { verifyState } from '../../../../../lib/oauth-state';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const url = new URL(req.url);

  if (!(await hasSession())) {
    return Response.json({ error: 'Not signed in' }, { status: 401 });
  }
  if (!hasConnector(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 404 });
  }

  // The provider reports user-facing denials here.
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    const description = url.searchParams.get('error_description') ?? '';
    return Response.json({ error: oauthError, description }, { status: 400 });
  }

  if (!verifyState(url.searchParams.get('state'), provider)) {
    return Response.json({ error: 'Invalid or expired OAuth state' }, { status: 400 });
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return Response.json({ error: 'Missing authorization code' }, { status: 400 });
  }

  const connector = getConnector(provider);
  const result = await connector.exchangeCode(code);

  const account = await upsertAccount(getDb(), {
    provider,
    externalId: result.externalId,
    email: result.email ?? null,
    displayName: result.displayName ?? null,
    encryptedTokens: getVault().encryptTokens(result.tokens),
    scopes: connector.scopes,
  });

  // First sync does the 30-day backfill and creates the webhook subscription.
  await enqueueSync({ accountId: account.id, trigger: 'oauth-callback', full: true });

  return Response.redirect(new URL('/', url.origin), 302);
}
