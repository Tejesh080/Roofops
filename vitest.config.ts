import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each PGlite-backed suite boots its own in-process Postgres; give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Every suite builds whole databases (PGlite and, with TEST_DATABASE_URL, Postgres); more than 3 at once starves them.
    maxWorkers: 3,
  },
});
