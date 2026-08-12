import Link from 'next/link';
import { notFound } from 'next/navigation';
import { audiences, defaultAudience, findAudience } from '@hub/config';
import { audiencesWithBriefOn, getBrief, getDb, listBriefs } from '@hub/db';
import { requireSession } from '../../../lib/session';
import { renderBriefMarkdown } from '../../../lib/markdown';

export const dynamic = 'force-dynamic';

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function BriefPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ audience?: string }>;
}) {
  await requireSession();

  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const { audience: requested } = await searchParams;
  const audience = findAudience(requested) ?? defaultAudience();

  const db = getDb();
  const [brief, sameDay, recent] = await Promise.all([
    getBrief(db, date, audience.key),
    // Keys only — fetching rows here would ship every other audience's brief
    // text into this page's payload.
    audiencesWithBriefOn(db, date),
    listBriefs(db, 14, audience.key),
  ]);
  if (!brief) notFound();

  const dates = new Set(recent.map((b) => b.briefDate));
  const prev = shiftDate(date, -1);
  const next = shiftDate(date, 1);
  const others = audiences().filter((a) => a.key !== audience.key);
  const availableSameDay = new Set(sameDay);

  const link = (d: string) =>
    audience.isDefault ? `/brief/${d}` : `/brief/${d}?audience=${audience.key}`;

  return (
    <main>
      <h1>
        {date}
        {!audience.isDefault && <span className="muted"> · {audience.label}</span>}
      </h1>
      <p className="muted">
        {brief.eventIds.length} event{brief.eventIds.length === 1 ? '' : 's'} · {brief.model}
        {brief.inputTokens !== null && brief.outputTokens !== null && (
          <> · {brief.inputTokens} in / {brief.outputTokens} out tokens</>
        )}{' '}
        · generated {brief.generatedAt.toISOString().replace('T', ' ').slice(0, 16)}Z
      </p>

      {others.length > 0 && (
        <p className="muted">
          Brief for <strong>{audience.label}</strong>
          {others.map((a) => (
            <span key={a.key}>
              {' · '}
              {availableSameDay.has(a.key) ? (
                <Link href={`/brief/${date}?audience=${a.key}`}>{a.label}</Link>
              ) : (
                <span title="no brief for this day">{a.label}</span>
              )}
            </span>
          ))}
        </p>
      )}

      <div className="brief">{renderBriefMarkdown(brief.markdown)}</div>

      <h2>Other days</h2>
      <p className="muted">
        {dates.has(prev) ? <Link href={link(prev)}>← {prev}</Link> : <span>← {prev}</span>}
        {' · '}
        <Link href="/">Home</Link>
        {' · '}
        {dates.has(next) ? <Link href={link(next)}>{next} →</Link> : <span>{next} →</span>}
      </p>
    </main>
  );
}
