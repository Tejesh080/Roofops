import { expect, test, type Page } from '@playwright/test';

/**
 * Read-only: the controls do what they say, not just render. Runs as the shared demo viewer against any server (local,
 * hosted data, or the protected Vercel preview with VERCEL_BYPASS). Nothing here submits a form or changes data.
 */
const PAGES = ['/', '/projects', '/attention', '/materials', '/finance', '/automation', '/health', '/demo'];
const rowsIn = (page: Page) => page.locator('table.data tbody tr.clickable');

test('every internal link on every page resolves (no 404 or server error)', async ({ page }) => {
  test.setTimeout(240_000);
  const seen = new Set<string>();
  for (const p of PAGES) {
    await page.goto(p);
    await expect(page.locator('main')).toBeVisible();
    for (const href of await page.locator('main a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) {
      seen.add(href.split('#')[0]!);
    }
  }
  seen.delete('');
  const bad: string[] = [];
  for (const href of [...seen].slice(0, 120)) {
    const r = await page.request.get(href, { maxRedirects: 0 });
    if (r.status() >= 400) bad.push(`${href} → ${r.status()}`);
  }
  expect(bad, `checked ${seen.size} links`).toEqual([]);
  expect(seen.size).toBeGreaterThan(20);
});

test('projects: search narrows the rows, clears, and says when nothing matches', async ({ page }) => {
  await page.goto('/projects');
  const all = await rowsIn(page).count();
  expect(all).toBeGreaterThan(10);
  const first = rowsIn(page).first();
  const customer = (await first.locator('.cell-main').innerText()).trim();
  const search = page.getByRole('searchbox');
  await search.fill(customer);
  await expect(rowsIn(page).first()).toContainText(customer);
  expect(await rowsIn(page).count()).toBeLessThan(all);
  await search.fill('PRJ-2026-0004');
  await expect(rowsIn(page)).toHaveCount(1);
  await search.fill('zzz-no-such-customer');
  await expect(rowsIn(page)).toHaveCount(0);
  await expect(page.getByText('No projects match')).toBeVisible();
  await search.fill('');
  await expect(rowsIn(page)).toHaveCount(all);
});

test('projects: every filter tab shows exactly the number on its label', async ({ page }) => {
  await page.goto('/projects');
  const tabs = page.getByRole('tablist', { name: 'Filter projects' }).getByRole('tab');
  for (let i = 0; i < await tabs.count(); i++) {
    const tab = tabs.nth(i);
    const n = Number(await tab.locator('.count').innerText());
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(rowsIn(page), await tab.innerText()).toHaveCount(n);
  }
});

test('overview: a metric card filters the table; a row click opens that project', async ({ page }) => {
  await page.goto('/');
  const card = page.getByRole('button', { name: /Show these projects/ }).nth(1);
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  const row = rowsIn(page).first();
  const number = (await row.locator('a.pn').innerText()).trim();
  await row.locator('td').nth(1).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${number}$`));
  await expect(page.getByRole('heading', { level: 1 })).toContainText(number);
});

test('project page: timeline expands, back link works, copy gives feedback', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await page.goto('/projects/PRJ-2026-0004');
  const toggles = page.locator('#history button[aria-expanded]');
  if (await toggles.count()) {
    const t = toggles.first();
    const was = await t.getAttribute('aria-expanded');
    await t.click();
    await expect(t).not.toHaveAttribute('aria-expanded', String(was));
  }
  const tech = page.locator('details.tech').first();
  if (await tech.count()) {                       // only projects with an invoice or approval have technical details
    await tech.locator('summary').click();
    const copy = tech.getByRole('button', { name: /^Copy / }).first();
    if (await copy.count()) {
      await copy.click();
      await expect(page.getByText(/copied/i).first()).toBeVisible();
    }
  }
  await page.getByRole('link', { name: /Projects/ }).first().click();
  await expect(page).toHaveURL(/\/projects$/);
});

// The status can be 200: the project page streams its loading state before notFound() runs (Next.js), so check the page.
test('bad project numbers show the not-found page, not an error', async ({ page }) => {
  for (const p of ['/projects/PRJ-2099-9999', '/projects/not-a-project', "/projects/PRJ-2026-0004'--"]) {
    const r = await page.goto(p);
    expect([200, 404], p).toContain(r?.status());
    await expect(page.getByText('Not found')).toBeVisible();
  }
});

test('the account menu opens, explains the demo viewer, and closes on Escape', async ({ page }) => {
  await page.goto('/');
  const menuButton = page.getByRole('button', { name: /Demo/ }).last();
  await menuButton.click();
  await expect(page.getByRole('menu')).toContainText('Shared demo viewer: cannot approve or resolve');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('the demo viewer sees no approve, request or resolve controls, and is told why', async ({ page }) => {
  await page.goto('/finance');
  await expect(page.locator('#reissues')).toContainText('Sign in as yourself');
  await expect(page.locator('#reissues').locator('button, textarea')).toHaveCount(0);
  await page.goto('/automation');
  await expect(page.getByRole('button', { name: 'Mark resolved' })).toHaveCount(0);
});

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('the navigation strip reaches every section without sideways scrolling', async ({ page }) => {
    await page.goto('/');
    for (const name of ['Projects', 'Finance', 'Automation']) {
      await page.getByRole('navigation').getByRole('link', { name: new RegExp(`^${name}`) }).first().click();
      await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}$`));
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    }
  });
});
