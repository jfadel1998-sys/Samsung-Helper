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
  const url = getConnector(provider).getAuthUrl(createState(provider, audience.key));
  return Response.redirect(url, 302);
}
