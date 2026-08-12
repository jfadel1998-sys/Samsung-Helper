import { hasSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * IMAP has no OAuth redirect — it needs credentials entered directly. This
 * exists so every connector has the same `/api/auth/<provider>/start` entry
 * point; it forwards to the form and carries the audience through.
 */
export async function GET(req: Request) {
  const base = process.env.APP_BASE_URL ?? new URL(req.url).origin;
  if (!(await hasSession())) {
    return Response.redirect(new URL('/login', base));
  }

  const audience = new URL(req.url).searchParams.get('audience');
  const target = new URL('/connect/imap', base);
  if (audience) target.searchParams.set('audience', audience);
  return Response.redirect(target, 302);
}
