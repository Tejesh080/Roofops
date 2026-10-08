import { defineConfig } from '@playwright/test';

// Uses the locally installed Chrome (no browser download). Credentials come from web/.env.local and are never logged.
try { process.loadEnvFile('.env.local'); } catch { /* CI supplies env directly */ }

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    { name: 'smoke', testMatch: /smoke\.spec\.ts/, dependencies: ['setup'], use: { storageState: 'e2e/.auth/state.json' } },
    { name: 'screens', testMatch: /screens\.spec\.ts/, dependencies: ['setup'], use: { storageState: 'e2e/.auth/state.json' } },
    { name: 'state-sync', testMatch: /state-sync\.spec\.ts/, dependencies: ['setup'], use: { storageState: 'e2e/.auth/state.json' } },
    // Opt-in (E2E_PILOT=1), local rehearsal database only: see scripts/pilot-rehearsal.ts.
    { name: 'staff-journey', testMatch: /staff-journey\.spec\.ts/ },
  ],
});
