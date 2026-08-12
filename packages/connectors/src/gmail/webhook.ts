import { OAuth2Client } from 'google-auth-library';
import { env } from '@hub/config';
import { requestJson } from '../http';
import type { SyncCtx } from '../types';
import { ensureAccessToken, GMAIL_BASE } from './sync';

/**
 * §2.2: users.watch() expires after 7 days and must be re-called. We treat it
 * as a daily renewal rather than weekly — a watch that lapses stops all push
 * notification with no error anywhere.
 */
export const GMAIL_WATCH_MAX_DAYS = 7;

interface WatchResponse {
  historyId?: string;
  /** Epoch millis, as a string. */
  expiration?: string;
}

async function callWatch(ctx: SyncCtx): Promise<{ id: string; expiresAt: Date }> {
  const token = await ensureAccessToken(ctx);
  const { body } = await requestJson<WatchResponse>(`${GMAIL_BASE}/watch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      topicName: env.google.pubsubTopic,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    }),
    retries: 2,
  });

  const expiresAt = body.expiration
    ? new Date(Number(body.expiration))
    : new Date(Date.now() + GMAIL_WATCH_MAX_DAYS * 86_400_000);

  // Gmail has no subscription id — the mailbox has at most one watch. The
  // topic name is the stable identifier for "a watch exists".
  return { id: env.google.pubsubTopic, expiresAt };
}

export async function subscribe(ctx: SyncCtx) {
  return callWatch(ctx);
}

/** Renewal is just calling watch() again; it replaces the existing watch. */
export async function renew(ctx: SyncCtx): Promise<{ expiresAt: Date }> {
  const { expiresAt } = await callWatch(ctx);
  return { expiresAt };
}

export async function unsubscribe(ctx: SyncCtx): Promise<void> {
  const token = await ensureAccessToken(ctx);
  try {
    await requestJson(`${GMAIL_BASE}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      retries: 1,
    });
  } catch (err) {
    ctx.log('gmail: stop() failed, treating watch as already gone', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

export interface GmailPushPayload {
  emailAddress?: string;
  historyId?: string | number;
}

/**
 * Decodes the Pub/Sub push envelope.
 *
 * The historyId inside is deliberately NOT used as a cursor (§9: webhooks
 * carry no content we trust). It tells us only which mailbox changed; the sync
 * then reads from our own stored cursor.
 */
export function decodePushEnvelope(payload: unknown): GmailPushPayload | null {
  const data = (payload as PubSubEnvelope | null)?.message?.data;
  if (!data) return null;
  try {
    const json = Buffer.from(data, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as GmailPushPayload;
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch {
    return null;
  }
}

let verifier: OAuth2Client | undefined;

/**
 * Verifies the JWT Pub/Sub signs push requests with (§9).
 *
 * Unlike the Graph receiver's shared-secret comparison, this is a real
 * signature check against Google's public keys — the endpoint is public, so a
 * forged push is otherwise trivial.
 *
 * @param authorization the raw Authorization header
 * @param audience      the push endpoint URL configured on the subscription
 */
export async function verifyPubSubJwt(
  authorization: string | null,
  audience: string,
  expectedServiceAccount = env.google.pubsubServiceAccount,
): Promise<boolean> {
  if (!authorization?.toLowerCase().startsWith('bearer ')) return false;
  const token = authorization.slice(7).trim();
  if (!token) return false;

  verifier ??= new OAuth2Client();

  try {
    const ticket = await verifier.verifyIdToken({ idToken: token, audience });
    const claims = ticket.getPayload();
    if (!claims) return false;

    // A valid Google-signed token is not enough — it must be OUR push service
    // account, or any Google customer could post here.
    if (expectedServiceAccount && claims.email !== expectedServiceAccount) return false;
    return claims.email_verified !== false;
  } catch {
    return false;
  }
}
