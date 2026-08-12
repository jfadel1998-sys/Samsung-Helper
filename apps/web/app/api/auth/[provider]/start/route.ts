import { resolveAudience } from '@hub/config';
import { getConnector, hasConnector } from '@hub/connectors';
import { hasSession } from '../../../../../lib/session';
import { createState } from '../../../../../lib/oauth-state';

export const dynamic = 'force-dynamic';

/**
 * Kicks off the OAuth round trip. Session-gated — this grants mailbox access.
 *
 * `?audience=moet` files the mailbox against that person's brief. An unknown
 * value falls back to the default rather than erroring, so a typo cannot
 * create a mailbox whose mail reaches nobody's brief.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!(await hasSession())) {
    return Response.redirect(new URL('/login', process.env.APP_BASE_URL ?? 'http://localhost:3000'));
  }

  const { provider } = await params;
  if (!hasConnector(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 404 });
  }

  const audience = resolveAudience(new URL(req.url).searchParams.get('audience'));
  const connector = getConnector(provider);

  // Credentials connectors (IMAP) have no redirect to start. They get their own
  // route under /api/auth/<provider>/start, which a static segment resolves to
  // ahead of this one — reaching here means a provider was added without it.
  if (connector.authKind !== 'oauth' || !connector.getAuthUrl) {
    return Response.json(
      { error: `${provider} does not use OAuth; connect it from its own form` },
      { status: 400 },
    );
  }

  return Response.redirect(connector.getAuthUrl(createState(provider, audience.key)), 302);
}
