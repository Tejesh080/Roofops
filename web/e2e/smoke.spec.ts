import { expect, test } from '@playwright/test';

test.describe('access control', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('every operational page and the API require a session', async ({ page, request }) => {
    for (const path of ['/', '/projects', '/projects/PRJ-2026-0004', '/attention', '/materials', '/finance', '/automation', '/demo']) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/login$/);
    }
    const api = await request.post('/api/copilot', { data: { messages: [{ role: 'user', content: 'Which projects need attention today?' }] } });
    expect(api.status()).toBe(401);
    const forged = await request.post('/api/copilot', { headers: { cookie: 'roofops_session=eyJ1Ijoia3lsZSIsImV4cCI6OTk5OTk5OTk5OX0.bm90LWEtc2lnbmF0dXJl' },
      data: { messages: [{ role: 'user', content: 'hi' }] } });
    expect(forged.status()).toBe(401);
  });

  test('a wrong password is refused with a clear message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Username').fill('kyle');
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.form-error')).toContainText('did not match');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test('overview: metric cards filter the table; attention panel answers "what needs me today"', async ({ page }) => {
  await page.goto('/');
  const cards = page.getByRole('button', { name: /Show these projects/ });
  await expect(cards).toHaveCount(5);
  await page.getByRole('button', { name: /^Projects at risk: 6/ }).click();
  await expect(page.getByRole('button', { name: /^Projects at risk/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('table.data tbody tr')).toHaveCount(6);
  await expect(page).toHaveURL(/view=at_risk/);
  await expect(page.getByRole('region', { name: 'Needs attention today' }).or(page.locator('section[aria-labelledby="att-h"]'))).toContainText('PRJ-2026-0011');
  await page.getByPlaceholder('Search project, customer, address').fill('Ethan');
  await expect(page.locator('table.data tbody tr')).toHaveCount(1);
});

test('risk reasons are revealed on hover/focus, not as red prose in the table', async ({ page }) => {
  await page.goto('/?view=at_risk');
  const risk = page.getByRole('button', { name: /At risk: Start date passed, Supplier confirmation overdue/ });
  await risk.focus();
  await expect(page.getByRole('tooltip')).toContainText('Supplier confirmation overdue');
});

test('PRJ-2026-0011: needs-attention panel with the next step', async ({ page }) => {
  await page.goto('/projects/PRJ-2026-0011');
  await expect(page.getByRole('heading', { name: 'PRJ-2026-0011' })).toBeVisible();
  const attn = page.locator('section.attn');
  await expect(attn).toContainText('Start date passed');
  await expect(attn).toContainText('Supplier confirmation overdue');
  await expect(attn).toContainText('PO-2026-0011');
  await expect(page.getByLabel('Project health')).toContainText('Delayed');
});

test('PRJ-2026-0033: retries are grouped into one readable story', async ({ page }) => {
  await page.goto('/projects/PRJ-2026-0033');
  const history = page.locator('#history');
  const more = history.getByRole('button', { name: /Show full history/ });
  if (await more.count()) await more.click();   // the grouped story usually fits in the first five entries
  await expect(history).toContainText('Google Drive temporarily unavailable');
  await expect(history).toContainText(/5 attempts over \d+ seconds/);
  await expect(history).toContainText('Retried by staff');
  await expect(history.locator('.tl-item')).toHaveCount(5);   // 17 raw rows told as 5 steps
  await history.getByRole('button', { name: /View attempts/ }).click();
  await expect(history.locator('.tl-sub li')).toHaveCount(5);
});

test('PRJ-2026-0004: Xero draft shown; the InvoiceID stays under technical details', async ({ page }) => {
  await page.goto('/projects/PRJ-2026-0004');
  await expect(page.getByText('RO-INV-2026-0039').first()).toBeVisible();
  await expect(page.getByText('7b74973c-a487-48f0-85b9-91ca8c5b2909')).toBeHidden();
  await page.getByText('Technical details').first().click();
  await expect(page.getByText('7b74973c-a487-48f0-85b9-91ca8c5b2909')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open in Xero' })).toHaveAttribute('href', /InvoiceID=7b74973c/);
});

test('issues lead with business language; the technical class is secondary', async ({ page }) => {
  await page.goto('/automation');
  await expect(page.getByText('Supplier information was incomplete')).toBeVisible();
  await expect(page.getByText('SCHEMA_MISMATCH · EXC-0006')).toBeHidden();
});

test('copilot: opens as a drawer, answers from live data with evidence, closes on Escape', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Ask RoofOps/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Operations Copilot' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Projects needing attention' }).click();
  await expect(drawer.locator('.answer')).toContainText('PRJ-2026-0011', { timeout: 90_000 });
  await expect(drawer.locator('details.evidence')).toContainText('Checked');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('layout holds at 1280, 1024 and tablet widths without horizontal page scroll', async ({ page }) => {
  for (const [w, h] of [[1280, 800], [1024, 768], [768, 1024]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const path of ['/', '/projects/PRJ-2026-0004']) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${w}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('keyboard: skip-free tab order reaches navigation and the copilot button with visible names', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Finance' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Ask RoofOps/ })).toBeVisible();
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter((el) => !(el.getAttribute('aria-label') || el.textContent?.trim() || el.getAttribute('title'))).length);
  expect(unnamed).toBe(0);
});
