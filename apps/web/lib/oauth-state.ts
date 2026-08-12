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

/**
 * The audience travels inside the signed state rather than as a separate query
 * parameter, so it cannot be swapped between the start of the flow and the
 * callback — that would file a mailbox against the wrong person's brief.
 */
export function createState(provider: string, audience: string): string {
  const payload = `${provider}.${audience}.${Date.now()}.${randomBytes(12).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}

export interface VerifiedState {
  audience: string;
}

export function verifyState(state: string | null, provider: string): VerifiedState | null {
  if (!state) return null;
  const parts = state.split('.');
  if (parts.length !== 5) return null;

  const [gotProvider, audience, issuedAt] = parts as [string, string, string, string, string];
  const payload = parts.slice(0, 4).join('.');

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(parts[4]!);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  if (gotProvider !== provider) return null;

  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age >= MAX_AGE_MS) return null;

  return { audience };
}
