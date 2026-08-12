import { env } from '@hub/config';
import { validateNotifications } from '@hub/connectors';
import { findBySubscriptionId, getDb } from '@hub/db';
import { enqueueSync } from '@hub/jobs';

export const dynamic = 'force-dynamic';

/**
 * Microsoft Graph webhook receiver.
 *
 * Two rules from §9 govern everything here:
 *
 *  1. Notifications carry no content we trust. A valid one means only
 *     "something changed on this subscription, go sync" — we never read
 *     message data out of the payload.
 *  2. Anything we cannot validate gets a 202, not a 4xx. Graph disables a
 *     subscription that returns errors, and a disabled subscription fails
 *     silently, which is exactly the failure mode we are trying to avoid.
 *
 * Graph also expects a reply within seconds, so this enqueues and returns
 * rather than syncing inline.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);

  // Subscription creation handshake: echo the token back as plain text.
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(null, { status: 202 });
  }

  const { valid, rejected } = validateNotifications(payload, env.microsoft.webhookClientState);

  if (rejected > 0) {
    // A bad clientState means the POST did not come from our subscription.
    console.warn(`[webhook:graph] rejected ${rejected} notification(s) with bad clientState`);
  }

  // Collapse a burst to one sync per subscription.
  const subscriptionIds = [...new Set(valid.map((n) => n.subscriptionId).filter(Boolean))];

  const db = getDb();
  for (const subscriptionId of subscriptionIds) {
    const state = await findBySubscriptionId(db, subscriptionId!);
    if (!state) {
      console.warn(`[webhook:graph] no account for subscription ${subscriptionId}`);
      continue;
    }
    await enqueueSync({ accountId: state.accountId, trigger: 'webhook' });
  }

  return new Response(null, { status: 202 });
}
