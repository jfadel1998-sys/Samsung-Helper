import { env } from '@hub/config';
import { requestJson } from '../http';
import type { SyncCtx } from '../types';
import { ensureAccessToken, GRAPH_BASE } from './sync';

/**
 * Graph caps mail subscriptions at 4230 minutes (§2.2). We ask for a little
 * under the cap — requesting the exact maximum is rejected when Graph's clock
 * and ours disagree by even a second.
 */
export const GRAPH_MAX_MINUTES = 4230;
const REQUEST_MINUTES = GRAPH_MAX_MINUTES - 30;

const RESOURCE = "/me/mailFolders('inbox')/messages";

interface SubscriptionResponse {
  id: string;
  expirationDateTime: string;
}

export function graphNotificationUrl(baseUrl: string): string {
  return `${baseUrl}/api/webhooks/graph`;
}

function expiration(): string {
  return new Date(Date.now() + REQUEST_MINUTES * 60_000).toISOString();
}

export async function subscribe(ctx: SyncCtx): Promise<{ id: string; expiresAt: Date }> {
  const token = await ensureAccessToken(ctx);
  const { body } = await requestJson<SubscriptionResponse>(`${GRAPH_BASE}/subscriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      changeType: 'created,updated',
      notificationUrl: graphNotificationUrl(ctx.baseUrl),
      resource: RESOURCE,
      expirationDateTime: expiration(),
      // Echoed back in every notification and checked on receipt (§9).
      clientState: env.microsoft.webhookClientState,
    }),
    // Graph calls our notificationUrl synchronously to validate it before
    // replying, so this request is slower than a normal Graph call.
    timeoutMs: 45_000,
    retries: 1,
  });

  return { id: body.id, expiresAt: new Date(body.expirationDateTime) };
}

export async function renew(ctx: SyncCtx): Promise<{ expiresAt: Date }> {
  if (!ctx.subscriptionId) throw new Error('No Outlook subscription id to renew');
  const token = await ensureAccessToken(ctx);

  const { body } = await requestJson<SubscriptionResponse>(
    `${GRAPH_BASE}/subscriptions/${ctx.subscriptionId}`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expirationDateTime: expiration() }),
      retries: 2,
    },
  );

  return { expiresAt: new Date(body.expirationDateTime) };
}

export async function unsubscribe(ctx: SyncCtx): Promise<void> {
  if (!ctx.subscriptionId) return;
  const token = await ensureAccessToken(ctx);
  try {
    await requestJson(`${GRAPH_BASE}/subscriptions/${ctx.subscriptionId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      retries: 1,
    });
  } catch (err) {
    // An already-dead subscription is the desired end state.
    ctx.log('outlook: unsubscribe failed, treating as already gone', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resource?: string;
  changeType?: string;
  subscriptionExpirationDateTime?: string;
  resourceData?: { id?: string } | null;
}

/**
 * Validates a notification batch (§9).
 *
 * Notifications carry no content we trust — a valid one means only "something
 * changed on this subscription, go sync". The clientState comparison is
 * length-safe and constant-ish; Graph sends it verbatim.
 */
export function validateNotifications(
  payload: unknown,
  expectedClientState: string,
): { valid: GraphNotification[]; rejected: number } {
  const value = (payload as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return { valid: [], rejected: 0 };

  const valid: GraphNotification[] = [];
  let rejected = 0;
  for (const item of value) {
    const n = item as GraphNotification;
    if (n && typeof n === 'object' && n.clientState === expectedClientState) {
      valid.push(n);
    } else {
      rejected++;
    }
  }
  return { valid, rejected };
}
