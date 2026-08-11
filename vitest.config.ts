import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one local Postgres; running files in parallel
    // against the same tables produces spurious failures.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
