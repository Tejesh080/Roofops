import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each PGlite-backed suite boots its own in-process Postgres; give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
