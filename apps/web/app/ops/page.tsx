import Link from 'next/link';
import { accountHealth, getDb, listBriefs, pipelineStats } from '@hub/db';
import { requireSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

/** §8: after 3 consecutive failures an account has to be visible, not silent. */
const FAILURE_ALERT_THRESHOLD = 3;

function ago(when: Date | null | undefined): string {
  if (!when) return 'never';
  const mins = Math.floor((Date.now() - when.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function until(when: Date | null | undefined): { label: string; cls: string } {
  if (!when) return { label: 'none', cls: 'bad' };
  const mins = Math.floor((when.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return { label: 'expired', cls: 'bad' };
  if (mins < 60) return { label: `${mins}m`, cls: 'warn' };
  const hours = Math.floor(mins / 60);
  // The renewal job runs every 6h and renews anything inside 24h, so under 24h
  // remaining is normal, not a problem.
  return { label: `${hours}h`, cls: hours < 6 ? 'warn' : 'ok' };
}

export default async function OpsPage() {
  await requireSession();

  const db = getDb();
  const [health, stats, briefs] = await Promise.all([
    accountHealth(db),
    pipelineStats(db),
    listBriefs(db, 7),
  ]);

  const degraded = health.filter(
    (h) =>
      h.account.status !== 'active' ||
      (h.state?.consecutiveFailures ?? 0) >= FAILURE_ALERT_THRESHOLD,
  );

  return (
    <main>
      <h1>Operations</h1>
      <p className="muted">
        <Link href="/">Home</Link>
      </p>

      {degraded.length > 0 && (
        <>
          <h2>Needs attention</h2>
          <ul>
            {degraded.map((h) => (
              <li key={h.account.id}>
                <strong>{h.account.email ?? h.account.externalId}</strong>{' '}
                {h.account.status !== 'active' && (
                  <span className="pill bad">{h.account.status}</span>
                )}{' '}
                {(h.state?.consecutiveFailures ?? 0) >= FAILURE_ALERT_THRESHOLD && (
                  <span className="pill bad">
                    {h.state?.consecutiveFailures} consecutive failures
                  </span>
                )}
                {h.state?.lastError && <div className="muted">{h.state.lastError}</div>}
                {h.account.status === 'reauth_required' && (
                  <div>
                    {/* Carry the audience through so reconnecting cannot
                        silently move the mailbox to someone else's brief. */}
                    <a
                      href={`/api/auth/${h.account.provider}/start?audience=${h.account.audience}`}
                    >
                      Reconnect
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Mailboxes</h2>
      {health.length === 0 ? (
        <p className="muted">None connected.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Mailbox</th>
                <th>Brief</th>
                <th>Status</th>
                <th>Last sync</th>
                <th>Last full</th>
                <th>Subscription</th>
                <th>Failures</th>
                <th>Events</th>
                <th>Newest mail</th>
              </tr>
            </thead>
            <tbody>
              {health.map((h) => {
                const sub = until(h.state?.subscriptionExpiresAt);
                const failures = h.state?.consecutiveFailures ?? 0;
                return (
                  <tr key={h.account.id}>
                    <td>
                      {h.account.email ?? h.account.externalId}
                      <div className="muted">{h.account.provider}</div>
                    </td>
                    <td>{h.account.audience}</td>
                    <td>
                      <span
                        className={`pill ${h.account.status === 'active' ? 'ok' : 'bad'}`}
                      >
                        {h.account.status}
                      </span>
                    </td>
                    <td>{ago(h.state?.lastDeltaSyncAt)}</td>
                    <td>{ago(h.state?.lastFullSyncAt)}</td>
                    <td>
                      <span className={`pill ${sub.cls}`}>{sub.label}</span>
                    </td>
                    <td>
                      {failures === 0 ? (
                        <span className="pill ok">0</span>
                      ) : (
                        <span
                          className={`pill ${failures >= FAILURE_ALERT_THRESHOLD ? 'bad' : 'warn'}`}
                        >
                          {failures}
                        </span>
                      )}
                    </td>
                    <td>{h.eventCount}</td>
                    <td>{ago(h.lastEventAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Pipeline</h2>
      <div className="tablewrap">
        <table>
          <tbody>
            <tr>
              <th>Events ingested</th>
              <td>{stats.totalEvents}</td>
            </tr>
            <tr>
              <th>Last 24h</th>
              <td>{stats.eventsLast24h}</td>
            </tr>
            <tr>
              <th>Kept by prefilter</th>
              <td>
                {stats.keptEvents}
                {stats.totalEvents > 0 && (
                  <span className="muted">
                    {' '}
                    ({Math.round((1 - stats.keptEvents / stats.totalEvents) * 100)}% cut)
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <th>Awaiting extraction</th>
              <td>{stats.pendingExtraction}</td>
            </tr>
            <tr>
              <th>Extraction failures</th>
              <td>
                {stats.failedExtraction > 0 ? (
                  <span className="pill warn">{stats.failedExtraction}</span>
                ) : (
                  0
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Recent briefs</h2>
      {briefs.length === 0 ? (
        <p className="muted">None generated yet.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Brief</th>
                <th>Events</th>
                <th>Model</th>
                <th>Tokens</th>
                <th>Generated</th>
              </tr>
            </thead>
            <tbody>
              {briefs.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link href={`/brief/${b.briefDate}?audience=${b.audience}`}>
                      {b.briefDate}
                    </Link>
                  </td>
                  <td>{b.audience}</td>
                  <td>{b.eventIds.length}</td>
                  <td>{b.model}</td>
                  <td>
                    {b.inputTokens ?? 0} / {b.outputTokens ?? 0}
                  </td>
                  <td>{ago(b.generatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
