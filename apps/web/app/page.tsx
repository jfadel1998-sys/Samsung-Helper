import Link from 'next/link';
import { getDb, latestBrief, listAccounts } from '@hub/db';
import { requireSession } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  await requireSession();

  const db = getDb();
  const [accounts, brief] = await Promise.all([listAccounts(db), latestBrief(db)]);

  return (
    <main>
      <h1>Ops Hub</h1>
      <p className="muted">
        {accounts.length === 0
          ? 'No mailboxes connected yet.'
          : `${accounts.length} mailbox${accounts.length === 1 ? '' : 'es'} connected.`}
      </p>

      <h2>Brief</h2>
      {brief ? (
        <p>
          <Link href={`/brief/${brief.briefDate}`}>Latest brief — {brief.briefDate}</Link>
        </p>
      ) : (
        <p className="muted">No brief generated yet.</p>
      )}

      <h2>Mailboxes</h2>
      {accounts.length === 0 ? (
        <p className="muted">Connect one to start ingesting.</p>
      ) : (
        <ul>
          {accounts.map((a) => (
            <li key={a.id}>
              {a.email ?? a.externalId} <span className="muted">({a.provider})</span>{' '}
              {a.status !== 'active' && <span className="pill bad">{a.status}</span>}
            </li>
          ))}
        </ul>
      )}
      <p>
        <a href="/api/auth/outlook/start">Connect Outlook</a>
        {' · '}
        <a href="/api/auth/gmail/start">Connect Gmail</a>
      </p>

      <h2>Operations</h2>
      <p>
        <Link href="/ops">Sync status, subscriptions, failures</Link>
      </p>
    </main>
  );
}
