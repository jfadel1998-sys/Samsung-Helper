import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, type Db } from '../src/client';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Integration tests need a real Postgres — the behaviour worth testing here
 * (ON CONFLICT semantics, partial indexes, array columns) has no meaningful
 * in-memory equivalent. Suites guard on `hasTestDb` so `pnpm test` stays green
 * on a bare checkout and in CI.
 *
 *   TEST_DATABASE_URL=postgres://hub@localhost:5432/hub_test pnpm test
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

let handle: { db: Db; end: () => Promise<void> } | undefined;

export async function connectTestDb(): Promise<Db> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  if (!handle) {
    const { db, sql: client } = createDb(TEST_DATABASE_URL, { max: 2 });
    await migrate(db, { migrationsFolder: resolve(here, '../migrations') });
    handle = { db, end: async () => void (await client.end()) };
  }
  return handle.db;
}

export async function closeTestDb() {
  if (handle) {
    await handle.end();
    handle = undefined;
  }
}

export async function truncateAll(db: Db) {
  await db.execute(
    sql`TRUNCATE TABLE events, sync_state, briefs, accounts RESTART IDENTITY CASCADE`,
  );
}
