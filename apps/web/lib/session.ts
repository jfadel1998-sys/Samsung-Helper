import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from '@hub/config';

export const SESSION_COOKIE = 'hub_session';

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function isValidToken(token: string | undefined | null): boolean {
  if (!token) return false;
  return constantTimeEquals(token, env.hubAccessToken);
}

export async function hasSession(): Promise<boolean> {
  const jar = await cookies();
  return isValidToken(jar.get(SESSION_COOKIE)?.value);
}

/**
 * §9: single-user app — one session check gates the whole UI. Anything that
 * renders account or message data must call this first.
 */
export async function requireSession(): Promise<void> {
  if (!(await hasSession())) redirect('/login');
}
