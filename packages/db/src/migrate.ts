/**
 * Migration runner. Invoked by `pnpm db:migrate` and by the worker's
 * Railway release step.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDb } from './client';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const { db, sql } = createDb(url, { max: 1 });
  await migrate(db, { migrationsFolder: resolve(here, '../migrations') });
  await sql.end();
  console.log('migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
