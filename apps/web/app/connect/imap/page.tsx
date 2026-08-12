import { redirect } from 'next/navigation';
import { resolveAudience, audiences } from '@hub/config';
import { getConnector } from '@hub/connectors';
import { getVault } from '@hub/crypto';
import { getDb, upsertAccount } from '@hub/db';
import { enqueueSync } from '@hub/jobs';
import { requireSession } from '../../../lib/session';

export const dynamic = 'force-dynamic';

async function connectMailbox(formData: FormData) {
  'use server';
  await requireSession();

  const username = String(formData.get('username') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const host = String(formData.get('host') ?? '').trim();
  const audience = resolveAudience(String(formData.get('audience') ?? ''));

  const connector = getConnector('imap');
  if (!connector.connect) redirect('/connect/imap?error=unsupported');

  let result;
  try {
    result = await connector.connect({
      username,
      password,
      ...(host ? { host } : {}),
    });
  } catch (err) {
    // The message is shown to the operator and comes from our own code, but
    // encode it anyway rather than reflecting arbitrary provider text.
    const message = err instanceof Error ? err.message : 'Could not connect';
    redirect(`/connect/imap?error=${encodeURIComponent(message.slice(0, 200))}`);
  }

  const account = await upsertAccount(getDb(), {
    provider: 'imap',
    externalId: result.externalId,
    email: result.email ?? null,
    displayName: result.displayName ?? null,
    encryptedTokens: getVault().encryptTokens(result.tokens),
    scopes: connector.scopes,
    audience: audience.key,
  });

  await enqueueSync({ accountId: account.id, trigger: 'imap-connect', full: true });
  redirect('/ops');
}

export default async function ConnectImapPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; audience?: string }>;
}) {
  await requireSession();
  const { error, audience: requested } = await searchParams;
  const selected = resolveAudience(requested ?? null);

  return (
    <main>
      <h1>Connect a mailbox over IMAP</h1>
      <p className="muted">
        For personal Gmail. Uses an app password rather than OAuth, so there is no
        Google verification to clear and nothing expires after 7 days.
      </p>

      <h2>Before you start</h2>
      <ol>
        <li>
          Turn on 2-step verification at{' '}
          <a href="https://myaccount.google.com/security" target="_blank" rel="noreferrer">
            myaccount.google.com/security
          </a>{' '}
          — app passwords are not available without it.
        </li>
        <li>
          Create an app password at{' '}
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">
            myaccount.google.com/apppasswords
          </a>
          . Google shows it as four groups of four letters; spaces do not matter.
        </li>
        <li>
          Make sure IMAP is enabled in Gmail → Settings → Forwarding and POP/IMAP.
        </li>
      </ol>

      {error && (
        <p className="pill bad" style={{ display: 'block', padding: '0.6rem 0.8rem' }}>
          {error}
        </p>
      )}

      <form action={connectMailbox}>
        <p>
          <label>
            Email address
            <br />
            <input
              type="email"
              name="username"
              required
              autoComplete="off"
              placeholder="you@gmail.com"
              style={{ padding: '0.5rem', width: '22rem', maxWidth: '100%' }}
            />
          </label>
        </p>
        <p>
          <label>
            App password
            <br />
            <input
              type="password"
              name="password"
              required
              autoComplete="off"
              placeholder="abcd efgh ijkl mnop"
              style={{ padding: '0.5rem', width: '22rem', maxWidth: '100%' }}
            />
          </label>
        </p>
        <p>
          <label>
            Whose brief should this feed?
            <br />
            <select
              name="audience"
              defaultValue={selected.key}
              style={{ padding: '0.5rem', width: '22rem', maxWidth: '100%' }}
            >
              {audiences().map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            IMAP host <span className="muted">(leave blank for Gmail)</span>
            <br />
            <input
              type="text"
              name="host"
              placeholder="imap.gmail.com"
              style={{ padding: '0.5rem', width: '22rem', maxWidth: '100%' }}
            />
          </label>
        </p>
        <p>
          <button type="submit" style={{ padding: '0.5rem 1rem' }}>
            Connect
          </button>
        </p>
      </form>

      <p className="muted">
        The password is verified by opening the mailbox before anything is saved, then
        encrypted with the same AES-256-GCM vault as every other credential.
      </p>
    </main>
  );
}
