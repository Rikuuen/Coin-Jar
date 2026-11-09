import { test, expect } from '@playwright/test';

test('live Tatum goal wallet is read-only and stays separate from savings', async ({ page }) => {
  test.setTimeout(150000);
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Fictional wallet test'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000');
  await page.getByLabel('Automatically save preferences').check(); await page.getByLabel('I saved my memory code').check(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByText('Preferences saved to Walrus mainnet.')).toBeVisible({ timeout: 90000 });
  await page.getByRole('button', { name: 'Home' }).click(); await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Fictional goal'); await page.getByLabel('Goal target in PHP').fill('500'); const date = page.getByLabel('Target date', { exact: true }); await date.fill((await date.getAttribute('min'))!); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByLabel('Sui public address').fill('0x' + '1'.repeat(64)); await page.getByRole('button', { name: 'Link wallet', exact: true }).click(); await expect(page.getByRole('button', { name: 'Check balance' })).toHaveCount(0); await page.getByRole('button', { name: 'Home' }).click();
  const wallet = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Savings wallet' }) });
  await wallet.getByRole('button', { name: 'Check balance' }).click();
  await expect(wallet.getByText(/SUI · Last checked/)).toBeVisible({ timeout: 30000 }); await expect(page.getByText('₱0.00 saved of ₱500.00 · 0%')).toBeVisible();
  await page.reload(); await wallet.getByRole('button', { name: 'Check balance' }).click(); await expect(wallet.getByText('since the previous check', { exact: false })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.simple-amount')).toHaveText('₱1,000.00'); await expect(page.getByText('₱0.00 saved of ₱500.00 · 0%')).toBeVisible();
});
