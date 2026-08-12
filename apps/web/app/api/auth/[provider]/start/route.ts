import { getConnector, hasConnector } from '@hub/connectors';
import { hasSession } from '../../../../../lib/session';
import { createState } from '../../../../../lib/oauth-state';

export const dynamic = 'force-dynamic';

/** Kicks off the OAuth round trip. Session-gated — this grants mailbox access. */
export async function GET(_req: Request, { params }: { params: Promise<{ provider: string }> }) {
  if (!(await hasSession())) {
    return Response.redirect(new URL('/login', process.env.APP_BASE_URL ?? 'http://localhost:3000'));
  }

  const { provider } = await params;
  if (!hasConnector(provider)) {
    return Response.json({ error: `Unknown provider: ${provider}` }, { status: 404 });
  }

  const url = getConnector(provider).getAuthUrl(createState(provider));
  return Response.redirect(url, 302);
}
