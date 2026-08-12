import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * TLS on unless the server is on this machine.
 *
 * Railway's managed Postgres terminates plaintext connections from outside the
 * private network, so `require` is right everywhere except a local dev or test
 * database. Matching on the parsed host rather than a substring: a URL written
 * as `127.0.0.1` is just as local as one written `localhost`, and getting it
 * wrong surfaces as "socket disconnected before secure TLS connection was
 * established", which reads like a network fault rather than a config choice.
 */
export function wantsTls(connectionString: string): boolean {
  let host: string;
  try {
    const url = new URL(connectionString);
    // An explicit sslmode in the URL wins over the host heuristic.
    const mode = url.searchParams.get('sslmode');
    if (mode === 'disable') return false;
    if (mode) return true;
    host = url.hostname.toLowerCase();
  } catch {
    // Unparseable: fall back to the safe direction.
    return true;
  }
  return !LOOPBACK_HOSTS.has(host);
}

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const sql = postgres(connectionString, {
    max: opts.max ?? 10,
    ssl: wantsTls(connectionString) ? 'require' : false,
    onnotice: () => {},
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

let cached: { db: Db; sql: postgres.Sql } | undefined;

/** Process-wide singleton. Safe to call from Next.js route handlers and the worker. */
export function getDb() {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    cached = createDb(url);
  }
  return cached.db;
}

export function getSql() {
  if (!cached) getDb();
  return cached!.sql;
}
