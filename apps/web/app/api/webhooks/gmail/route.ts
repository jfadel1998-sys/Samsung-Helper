import { env } from '@hub/config';
import { decodePushEnvelope, verifyPubSubJwt } from '@hub/connectors';
import { findAccount, getDb, listActiveAccounts } from '@hub/db';
import { enqueueSync } from '@hub/jobs';

export const dynamic = 'force-dynamic';

/**
 * Gmail Pub/Sub push receiver.
 *
 * Same two §9 rules as the Graph receiver, with one difference that matters:
 * this endpoint is public and unauthenticated by nature, so the Pub/Sub JWT is
 * verified against Google's signing keys rather than compared to a shared
 * secret. An unsigned or wrongly-signed push is dropped.
 *
 * Rejections still answer 202. Pub/Sub retries 4xx/5xx with backoff and will
 * eventually pile up a backlog for an endpoint that keeps refusing.
 */
export async function POST(req: Request) {
  const audience = `${env.appBaseUrl}/api/webhooks/gmail`;

  const verified = await verifyPubSubJwt(req.headers.get('authorization'), audience);
  if (!verified) {
    console.warn('[webhook:gmail] dropped push with missing or invalid Pub/Sub JWT');
    return new Response(null, { status: 202 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(null, { status: 202 });
  }

  // The envelope names the mailbox. Its historyId is deliberately ignored —
  // the sync reads our own stored cursor rather than trusting the payload.
  const push = decodePushEnvelope(payload);
  const db = getDb();

  if (!push?.emailAddress) {
    console.warn('[webhook:gmail] push carried no emailAddress, syncing all gmail accounts');
    for (const account of await listActiveAccounts(db)) {
      if (account.provider === 'gmail') {
        await enqueueSync({ accountId: account.id, trigger: 'webhook' });
      }
    }
    return new Response(null, { status: 202 });
  }

  const target = push.emailAddress.trim().toLowerCase();
  const account = (await listActiveAccounts(db)).find(
    (a) => a.provider === 'gmail' && a.email?.toLowerCase() === target,
  );

  if (!account) {
    console.warn('[webhook:gmail] no active account matches the pushed mailbox');
    return new Response(null, { status: 202 });
  }

  await enqueueSync({ accountId: account.id, trigger: 'webhook' });
  return new Response(null, { status: 202 });
}
