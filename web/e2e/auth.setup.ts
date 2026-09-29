import { expect, test as setup } from '@playwright/test';

setup('sign in through the real login form', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Username').fill(process.env.DEMO_USERNAME ?? '');
  await page.getByLabel('Password').fill(process.env.DEMO_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Good morning' })).toBeVisible();
  await page.context().storageState({ path: 'e2e/.auth/state.json' });
});
