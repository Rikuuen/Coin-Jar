import { test, expect } from '@playwright/test';

test('live automatic backup restores a fictional journal on another device', async ({ browser }) => {
  test.setTimeout(210000);
  const first = await browser.newContext(), second = await browser.newContext();
  try {
    const page = await first.newPage(); await page.goto('/');
    await page.getByLabel('Nickname').fill('Auto recovery test'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Generate key' }).click(); const key = await page.getByLabel('Recovery key', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'I saved my recovery key' }).click(); await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible({ timeout: 90000 });
    await page.getByRole('button', { name: 'Home' }).click(); await page.getByRole('button', { name: 'Add expense' }).click(); await page.getByLabel('Amount in PHP').fill('50'); await page.getByLabel('Note (optional)').fill('Fictional automatic expense'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible({ timeout: 90000 });
    const other = await second.newPage(); await other.goto('/'); await other.getByLabel('Nickname').fill('Other'); await other.getByLabel('Currency').selectOption('PHP'); await other.getByLabel('Current balance').fill('10'); await other.getByRole('button', { name: 'Continue', exact: true }).click();
    await other.getByRole('button', { name: 'Profile' }).click(); await other.getByLabel('Recovery key', { exact: true }).fill(key); other.once('dialog', dialog => void dialog.accept()); await other.getByRole('button', { name: 'Restore journal' }).click();
    await expect(other.getByText('Journal restored on this device.', { exact: false })).toBeVisible({ timeout: 90000 }); await other.getByRole('button', { name: 'Home' }).click(); await expect(other.locator('.simple-amount')).toHaveText('₱950.00'); await other.getByRole('button', { name: 'Activity' }).click(); await expect(other.getByText('Fictional automatic expense')).toBeVisible();
  } finally { await first.close(); await second.close(); }
});

test('live Walrus restores a fictional encrypted journal in another isolated browser', async ({ browser }) => {
  test.setTimeout(210000);
  const first = await browser.newContext(), second = await browser.newContext();
  try {
    const page = await first.newPage(); await page.goto('/');
    await page.getByLabel('Nickname').fill('Recovery demo'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Add expense' }).click(); await page.getByLabel('Amount in PHP').fill('50'); await page.getByLabel('Note (optional)').fill('Fictional expense'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Fictional goal'); await page.getByLabel('Goal target in PHP').fill('500'); await page.getByLabel('Target date', { exact: true }).fill((await page.getByLabel('Target date', { exact: true }).getAttribute('min'))!); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Generate key' }).click();
    const key = await page.getByLabel('Recovery key', { exact: true }).inputValue(); await page.getByRole('button', { name: 'I saved my recovery key' }).click();
    await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible({ timeout: 90000 });
    await page.getByRole('button', { name: 'Home' }).click(); await page.getByRole('button', { name: 'Add income' }).click(); await page.getByLabel('Amount in PHP').fill('20'); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Profile' }).click();
    await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible({ timeout: 90000 });
    const other = await second.newPage(); await other.goto('/');
    await other.getByLabel('Nickname').fill('Other'); await other.getByLabel('Currency').selectOption('PHP'); await other.getByLabel('Current balance').fill('10'); await other.getByRole('button', { name: 'Continue', exact: true }).click();
    await other.getByRole('button', { name: 'Profile' }).click(); await other.getByRole('button', { name: 'Generate key' }).click();
    await other.getByRole('button', { name: 'Restore journal' }).click(); await expect(other.getByText('Could not restore the backup.', { exact: false })).toBeVisible({ timeout: 45000 });
    await other.getByRole('button', { name: 'Home' }).click(); await expect(other.locator('.simple-amount')).toHaveText('₱10.00');
    await other.getByRole('button', { name: 'Profile' }).click(); await other.getByLabel('Recovery key', { exact: true }).fill(key);
    other.once('dialog', dialog => void dialog.accept()); await other.getByRole('button', { name: 'Restore journal' }).click();
    await expect(other.getByText('Journal restored on this device.', { exact: false })).toBeVisible({ timeout: 45000 });
    await other.getByRole('button', { name: 'Home' }).click(); await expect(other.locator('.simple-amount')).toHaveText('₱970.00'); await expect(other.getByText('Fictional goal')).toBeVisible();
    await other.getByRole('button', { name: 'Activity' }).click(); await expect(other.getByText('Fictional expense')).toBeVisible();
  } finally { await first.close(); await second.close(); }
});
