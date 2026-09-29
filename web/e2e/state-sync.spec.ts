import { expect, test } from '@playwright/test';
import pg from 'pg';

/**
 * Phase 6 browser E2E: after real edits made in Airtable (applied, refused or recovered by RoofOps; see
 * docs/phase6-status.md), the dashboard and the Copilot show exactly the canonical Postgres state.
 * The expected values are read from the database in the test, with the dashboard's own read-only role.
 */
const OUT = '../docs/screenshots/phase6';
test.describe.configure({ mode: 'serial' });

async function canonical(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.DASHBOARD_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try { return (await c.query(sql, params)).rows as Record<string, unknown>[]; } finally { await c.end(); }
}
const STAGE: Record<string, string> = { PLANNING: 'Planning', MATERIALS_PENDING: 'Waiting on materials', SCHEDULED: 'Scheduled', IN_PROGRESS: 'On site',
  ON_HOLD: 'On hold', COMPLETED: 'Completed', CLOSED: 'Closed', CANCELLED: 'Cancelled' };

for (const project of ['PRJ-2026-0001', 'PRJ-2026-0009', 'PRJ-2026-0010', 'PRJ-2026-0011', 'PRJ-2026-0013']) {
  test(`${project}: dashboard shows the canonical stage and no false sync warning`, async ({ page }) => {
    const [row] = await canonical(`select status, status_out_of_sync from (select status, coalesce(airtable_status_seen is not null and airtable_status_seen <> sm_label('project', status), false) status_out_of_sync
                                  from v_dashboard_projects where project_number = $1) x`, [project]);
    await page.goto(`/projects/${project}`);
    await expect(page.locator('.proj-head .badge').first()).toHaveText(STAGE[String(row!.status)]!);
    await expect(page.locator('.sync-note')).toHaveCount(row!.status_out_of_sync ? 1 : 0);
  });
}

test('a cancelled job is not in the ready-to-invoice list', async ({ page }) => {
  const ready = (await canonical(`select project_number from v_dashboard_projects where invoice_status = 'READY_TO_INVOICE' order by 1`)).map((r) => String(r.project_number));
  expect(ready).not.toContain('PRJ-2026-0001');
  await page.goto('/finance');
  for (const p of ready) await expect(page.getByText(p).first()).toBeVisible();
});

test('System Health shows real checks and agreement figures', async ({ page }) => {
  await page.goto('/health');
  await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();
  await expect(page.locator('.svc')).toHaveCount(7);
  for (const s of await page.locator('.svc .badge').allTextContents()) expect(['Healthy', 'Degraded', 'Needs attention', 'Unknown']).toContain(s.trim());
  const [a] = await canonical(`select checked, drift_now from v_consistency where system = 'AIRTABLE'`);
  await expect(page.getByText(`${Number(a!.checked) - Number(a!.drift_now)} / ${String(a!.checked)} in sync`)).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/01-system-health.png`, fullPage: true });
});

test('Copilot answers PRJ-2026-0001 with the canonical Cancelled', async ({ page }) => {
  await page.goto('/projects/PRJ-2026-0001');
  await page.screenshot({ path: `${OUT}/02-project-PRJ-2026-0001-cancelled.png`, fullPage: false });
  await page.getByRole('button', { name: /Ask RoofOps/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox', { name: 'Ask the copilot' }).fill("What's the status of PRJ-2026-0001 currently?");
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect(dlg.locator('.answer').last()).toContainText(/cancelled/i, { timeout: 90_000 });
  await expect(dlg.locator('.answer').last()).not.toContainText(/ready to invoice\b(?! )/i);
  await page.screenshot({ path: `${OUT}/03-copilot-PRJ-2026-0001.png`, fullPage: false });
});
