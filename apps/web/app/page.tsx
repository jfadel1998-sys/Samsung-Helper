import Link from 'next/link';
import { audiences } from '@hub/config';
import { getDb, latestBrief, listAccounts } from '@hub/db';
import { requireSession } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  await requireSession();

  const db = getDb();
  const all = audiences();

  const [accounts, briefs] = await Promise.all([
    listAccounts(db),
    Promise.all(all.map(async (a) => ({ audience: a, brief: await latestBrief(db, a.key) }))),
  ]);

  return (
    <main>
      <h1>Ops Hub</h1>
      <p className="muted">
        {accounts.length === 0
          ? 'No mailboxes connected yet.'
          : `${accounts.length} mailbox${accounts.length === 1 ? '' : 'es'} connected.`}
      </p>

      <h2>Briefs</h2>
      <ul>
        {briefs.map(({ audience, brief }) => (
          <li key={audience.key}>
            {brief ? (
              <Link
                href={
                  audience.isDefault
                    ? `/brief/${brief.briefDate}`
                    : `/brief/${brief.briefDate}?audience=${audience.key}`
                }
              >
                {audience.label} — {brief.briefDate}
              </Link>
            ) : (
              <span className="muted">{audience.label} — none generated yet</span>
            )}
          </li>
        ))}
      </ul>

      <h2>Mailboxes</h2>
      {accounts.length === 0 ? (
        <p className="muted">Connect one to start ingesting.</p>
      ) : (
        <ul>
          {accounts.map((a) => (
            <li key={a.id}>
              {a.email ?? a.externalId} <span className="muted">({a.provider})</span>{' '}
              <span className="muted">→ {a.audience}&apos;s brief</span>{' '}
              {a.status !== 'active' && <span className="pill bad">{a.status}</span>}
            </li>
          ))}
        </ul>
      )}

      <h2>Connect a mailbox</h2>
      <p className="muted">Choose whose brief it should feed.</p>
      <ul>
        {all.map((a) => (
          <li key={a.key}>
            {a.label}:{' '}
            <a href={`/api/auth/outlook/start?audience=${a.key}`}>Outlook</a>
            {' · '}
            <a href={`/api/auth/gmail/start?audience=${a.key}`}>Gmail (Workspace)</a>
            {' · '}
            <a href={`/api/auth/imap/start?audience=${a.key}`}>Gmail (personal, IMAP)</a>
          </li>
        ))}
      </ul>
      <p className="muted">
        A personal @gmail.com must use the IMAP link — it cannot use the Internal
        Workspace consent screen, and OAuth for it means Google&apos;s CASA assessment.
        See <code>docs/imap-setup.md</code>.
      </p>

      <h2>Operations</h2>
      <p>
        <Link href="/ops">Sync status, subscriptions, failures</Link>
      </p>
    </main>
  );
}
