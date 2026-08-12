import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '@hub/config';

/**
 * CSRF state for the OAuth round trip.
 *
 * Signed with HUB_ACCESS_TOKEN and timestamped rather than stored in a table —
 * a single-user app does not need a state table, but it does need to reject a
 * callback it did not initiate.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', env.hubAccessToken).update(payload).digest('base64url');
}

export function createState(provider: string): string {
  const payload = `${provider}.${Date.now()}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyState(state: string | null, provider: string): boolean {
  if (!state) return false;
  const parts = state.split('.');
  if (parts.length !== 4) return false;

  const [gotProvider, issuedAt] = parts as [string, string, string, string];
  const payload = parts.slice(0, 3).join('.');

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(parts[3]!);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;

  if (gotProvider !== provider) return false;

  const age = Date.now() - Number(issuedAt);
  return Number.isFinite(age) && age >= 0 && age < MAX_AGE_MS;
}
