import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(connectionString: string, opts: { max?: number } = {}) {
  const sql = postgres(connectionString, {
    max: opts.max ?? 10,
    // Railway's managed Postgres terminates plaintext connections from outside
    // the private network; `require` works in both places.
    ssl: connectionString.includes('localhost') ? false : 'require',
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
