import { sql } from 'drizzle-orm';
import { getDb } from '@hub/db';

export const dynamic = 'force-dynamic';

/**
 * Railway health check. Unauthenticated on purpose — it reports liveness only,
 * never account or message data.
 */
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;

  try {
    await getDb().execute(sql`select 1`);
    checks.database = 'ok';
  } catch (err) {
    ok = false;
    checks.database = err instanceof Error ? err.message : 'error';
  }

  for (const name of ['TOKEN_ENCRYPTION_KEY', 'APP_BASE_URL', 'HUB_ACCESS_TOKEN'] as const) {
    if (!process.env[name]) {
      ok = false;
      checks[name] = 'missing';
    }
  }

  return Response.json(
    { status: ok ? 'ok' : 'degraded', checks, at: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
