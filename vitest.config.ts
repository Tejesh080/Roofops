import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // n8n/*.sdk.ts import '@n8n/workflow-sdk', which is not installed here: tests load them through a recorder that
    // keeps each node's real configuration and connections (test/helpers/n8n-sdk-shim.ts).
    alias: { '@n8n/workflow-sdk': fileURLToPath(new URL('./test/helpers/n8n-sdk-shim.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Each PGlite-backed suite boots its own in-process Postgres; give them room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Every suite builds whole databases (PGlite and, with TEST_DATABASE_URL, Postgres); more than 3 at once starves them.
    maxWorkers: 3,
  },
});
