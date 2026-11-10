import { test, expect } from '@playwright/test';

test('pending on-chain activity updates in place and profile refreshes the linked wallet', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-10T08:00:00+08:00'));
  const address = '0x' + '1'.repeat(64), code = 'p'.repeat(43), digest = 'A'.repeat(44);
  const transfer = { id: 'pending-1', goalId: 'g', network: 'testnet', asset: 'USDC', sender: '', recipient: address, amountMicroUsdc: '1690000', status: 'unknown', external: true, createdAt: '2026-11-10T00:00:00Z' };
  const walletState = { goal: { id: 'g', wallet: { address } }, onchainTransfers: [transfer] };
  let walletRequests = 0;
  await page.route('**/api/phone/walrus', route => route.fulfill({ json: { saved: true, memoryId: 'mock', blobId: 'mock' } }));
  await page.route('**/api/phone/wallet-balance', route => { walletRequests++; expect(route.request().postDataJSON()).toEqual({ address, asset: 'test-dusdc' }); return walletRequests === 1 ? route.fulfill({ json: { network: 'testnet', asset: 'test-dusdc', balanceBaseUnits: '1230000', checkedAt: '2026-11-10T00:00:00Z' } }) : route.fulfill({ status: 502, json: { error: 'unavailable' } }); });
  await page.route('**/api/phone/testnet', route => {
    const { action } = route.request().postDataJSON();
    if (action === 'quote') return route.fulfill({ json: { rate: { value: '0.017', timestamp: Date.parse('2026-11-10T00:00:00Z') } } });
    if (action === 'detect') return route.fulfill({ json: { check: 'verified', state: { ...walletState, onchainTransfers: [{ ...transfer, status: 'verified', digest }] } } });
    return route.fulfill({ json: { state: walletState } });
  });
  await page.addInitScript(({ address, code }) => {
    localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 3, nickname: 'Test', currency: 'PHP', walletAddress: address, openingCents: 100000, openingDate: '2026-11-01', bufferCents: 0, dailyLimitCents: 0, adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 50000, targetDate: '2026-11-20', status: 'active', createdAt: '' }, otherGoals: [], entries: [{ id: 'manual', kind: 'contribution', goalId: 'g', amountCents: 1000, date: '2026-11-10', note: '', createdAt: '2026-11-10T00:00:00Z' }] }));
    localStorage.setItem('coinjar.phone.walrus.auto.v1.mainnet-demo', JSON.stringify({ enabled: true, code, personal: true, habits: false, recentHabits: false, restorePending: false }));
  }, { address, code });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Savings wallet' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Balance', exact: true })).toBeVisible();
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 915 });
    const positions = await page.evaluate(() => ['.phone-hero', '.phone-goal', '.simple-balance'].map(selector => document.querySelector(selector)!.getBoundingClientRect().top));
    expect(positions[0]).toBeLessThan(positions[1]); expect(positions[1]).toBeLessThan(positions[2]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const today = page.locator('.phone-day').filter({ has: page.getByRole('heading', { name: 'Today', exact: true }) });
  const pending = today.getByRole('button', { name: /On-chain saving/ });
  await expect(pending).toContainText('Pending · Testnet'); await expect(pending).toContainText('1.69 DUSDC');
  for (const width of [320, 375, 430]) { await page.setViewportSize({ width, height: 915 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  await page.screenshot({ path: 'activity-check.png' });
  await expect(today).toContainText('Recorded saving'); await expect(page.getByLabel('Last 7 days')).toContainText('₱10.00');
  await expect(page.getByRole('heading', { name: 'On-chain activity' })).toHaveCount(0);
  await pending.click(); await expect(page.getByRole('button', { name: 'I’ve sent it' })).toBeVisible();
  await page.getByRole('button', { name: 'I’ve sent it' }).click();
  await expect(today).toContainText('Receipt confirmed · Testnet'); await expect(page.getByRole('button', { name: 'I’ve sent it' })).toBeHidden();
  await page.getByRole('button', { name: 'Home', exact: true }).click(); await expect(page.locator('.phone-goal')).toContainText('₱10.00 saved of ₱500.00');
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Savings wallet' })).toBeVisible(); await expect(page.getByText('1.23 DUSDC')).toBeVisible();
  await page.screenshot({ path: 'profile-check.png' });
  expect(walletRequests).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Refresh balance' }).click(); await expect(page.getByText('Last saved test DUSDC · Sui testnet')).toBeVisible(); await expect(page.getByText('1.23 DUSDC')).toBeVisible();
  await expect(page.getByLabel('Sui public address')).toBeHidden(); await page.getByText('Manage linked wallet').click(); await expect(page.getByLabel('Sui public address')).toHaveValue(address); await expect(page.getByRole('button', { name: 'Update linked wallet' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Unlink wallet' })).toBeVisible();
  const order = await page.locator('main section').evaluateAll(sections => sections.map(section => section.querySelector('h1,h2')?.textContent));
  expect(order.indexOf('Savings wallet')).toBeLessThan(order.indexOf('Daily reminder'));
  await expect(page.getByText('Check a transaction')).toHaveCount(0); await expect(page.getByText('Last checked', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('savings choice fits a phone and manual recording remains intentional', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-10T08:00:00+08:00'));
  await page.addInitScript(() => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 3, nickname: 'Test', currency: 'PHP', openingCents: 100000, openingDate: '2026-11-01', bufferCents: 0, dailyLimitCents: 0, adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 50000, targetDate: '2026-11-20', status: 'active', createdAt: '' }, otherGoals: [], entries: [] })));
  await page.goto('/');
  async function openChoice() { await page.getByRole('button', { name: 'Add savings' }).click(); await page.getByLabel('Amount in PHP').fill('50'); await page.getByRole('button', { name: 'Save', exact: true }).click(); }
  await openChoice();
  const dialog = page.getByRole('dialog', { name: 'How did you save?' });
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('₱50.00');
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 700 });
    const bounds = await dialog.evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, screen: innerWidth, height: innerHeight }; });
    expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.screen); expect(bounds.top).toBeGreaterThanOrEqual(0); expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  }
  await dialog.getByRole('button', { name: 'Not now' }).click(); await expect(dialog).toBeHidden();
  await expect(page.locator('.phone-goal')).toContainText('₱0.00 saved');
  await openChoice(); await dialog.getByRole('button', { name: /Record in CoinJar/ }).click();
  await expect(dialog).toBeHidden(); await expect(page.locator('.phone-goal')).toContainText('₱50.00 saved');
});

test('on-chain choice still opens the transfer flow without recording savings', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-10T08:00:00+08:00'));
  const address = '0x' + '1'.repeat(64), code = 'p'.repeat(43);
  await page.route('**/api/phone/walrus', route => route.fulfill({ json: { saved: true, memoryId: 'mock', blobId: 'mock' } }));
  await page.route('**/api/phone/testnet', route => route.fulfill({ json: route.request().postDataJSON().action === 'quote' ? { rate: { value: '0.017', timestamp: Date.parse('2026-11-10T00:00:00Z') } } : { state: { goal: null, onchainTransfers: [] } } }));
  await page.addInitScript(({ address, code }) => {
    localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 3, nickname: 'Test', currency: 'PHP', walletAddress: address, openingCents: 100000, openingDate: '2026-11-01', bufferCents: 0, dailyLimitCents: 0, adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 50000, targetDate: '2026-11-20', status: 'active', createdAt: '' }, otherGoals: [], entries: [] }));
    localStorage.setItem('coinjar.phone.walrus.auto.v1.mainnet-demo', JSON.stringify({ enabled: true, code, personal: true, habits: false, recentHabits: false, restorePending: false }));
  }, { address, code });
  await page.goto('/'); await page.getByRole('button', { name: 'Add savings' }).click(); await page.getByLabel('Amount in PHP').fill('50'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog', { name: 'How did you save?' }).getByRole('button', { name: /Save on-chain/ }).click();
  await expect(page.getByRole('button', { name: 'Activity', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Prepare transfer' })).toBeVisible();
  const journal = await page.evaluate(() => JSON.parse(localStorage.getItem('coinjar.phone.demo.journal.v1')!)); expect(journal.entries).toHaveLength(0);
});
