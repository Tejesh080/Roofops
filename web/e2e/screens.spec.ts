import { expect, test } from '@playwright/test';

/**
 * Visual QA captures at desktop resolution (1440 wide). The invoice-preview capture performs the real
 * "Prepare invoice" action on PRJ-2026-0005 (preview only); run `npm run demo:reset` afterwards.
 */
const OUT = '../docs/screenshots/phase5';
test.describe.configure({ mode: 'serial' });

const shot = async (page: import('@playwright/test').Page, name: string, fullPage = true) => {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
};

test('01 dashboard', async ({ page }) => { await page.goto('/'); await shot(page, '01-dashboard'); });
test('02 PRJ-2026-0011 at risk', async ({ page }) => { await page.goto('/projects/PRJ-2026-0011'); await shot(page, '02-project-PRJ-2026-0011-at-risk'); });
test('03 PRJ-2026-0004 Xero draft', async ({ page }) => { await page.goto('/projects/PRJ-2026-0004'); await shot(page, '03-project-PRJ-2026-0004-xero-draft'); });
test('05 PRJ-2026-0033 recovery history', async ({ page }) => {
  await page.goto('/projects/PRJ-2026-0033');
  const more = page.locator('#history').getByRole('button', { name: /Show full history/ });
  if (await more.count()) await more.click();
  await shot(page, '05-project-PRJ-2026-0033-recovery');
});
test('06 copilot: what needs attention today', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Ask RoofOps/ }).click();
  await shot(page, '06a-copilot-open', false);
  await page.getByRole('dialog').getByRole('button', { name: 'Projects needing attention' }).click();
  await expect(page.getByRole('dialog').locator('.answer')).toBeVisible({ timeout: 90_000 });
  await page.getByRole('dialog').locator('details.evidence summary').click();
  await shot(page, '06-copilot-attention', false);
});
test('07 copilot: invoice preview action card', async ({ page }) => {
  await page.goto('/projects/PRJ-2026-0005');
  await page.getByRole('button', { name: /Ask RoofOps/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByRole('textbox', { name: 'Ask the copilot' }).fill('Prepare invoice for PRJ-2026-0005');
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect(dlg.locator('.action-card')).toBeVisible({ timeout: 90_000 });
  await dlg.locator('.action-card').scrollIntoViewIfNeeded();
  await shot(page, '07-copilot-invoice-preview', false);
});
test('04 PRJ-2026-0005 awaiting approval', async ({ page }) => { await page.goto('/projects/PRJ-2026-0005'); await shot(page, '04-project-PRJ-2026-0005-awaiting-approval'); });
test('08 demo guide', async ({ page }) => { await page.goto('/demo'); await shot(page, '08-demo-guide'); });
test('09 responsive', async ({ page }) => {
  for (const [w, h, n] of [[1280, 900, '1280'], [1024, 900, '1024'], [768, 1024, 'tablet']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await shot(page, `09-dashboard-${n}`, false);
  }
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/projects/PRJ-2026-0011');
  await page.getByRole('button', { name: /Ask RoofOps/ }).click();
  await shot(page, '09-tablet-copilot-drawer', false);
});
