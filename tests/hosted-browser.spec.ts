import { test, expect, type Page } from '@playwright/test';

test('hosted tracking interface records income, expense and a goal with a simulated account', async ({ page, browser }) => {
  // Approximation only: actual CSS dimensions depend on the device's display settings.
  await page.setViewportSize({ width: 412, height: 892 });
  const entries: Array<{ id: string; kind: string; amount_centavos: string; entry_date: string; note: string }> = [];
  let revision = 0;
  let dropNextResponse = false;
  const operations = new Map<string, { id: string; revision: string }>();
  let goal: { id: string; title: string; target_centavos: string; target_date: null } | null = null;
  async function setup(target: Page) {
  let signedIn = true;
  await target.route('**/api/auth/**', async (route) => {
    const url = route.request().url();
    const headers = { 'access-control-allow-origin': 'http://127.0.0.1:47839', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'set-auth-jwt', 'set-auth-jwt': 'test-jwt' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.includes('/sign-out')) signedIn = false;
    const data = url.includes('/get-session') ? (signedIn ? { user: { id: 'test-user', name: 'Alex', email: 'example@example.test', emailVerified: true }, session: { id: 'session', userId: 'test-user', token: 'test' } } : null) : url.includes('/token') ? { token: 'test-token' } : {};
    return route.fulfill({ status: 200, headers, json: data });
  });
  await target.route('**/api/tracking**', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { revision: String(revision), entries, goal, preferences: { currency: 'PHP', bufferCents: 20000, dailyLimitCents: 50000, pace: 'steady' } } });
    const data = route.request().postDataJSON();
    if (operations.has(data.operationId)) return route.fulfill({ json: operations.get(data.operationId) });
    expect(data.revision).toBe(String(revision));
    revision++;
    if (route.request().url().endsWith('/entries')) entries.push({ id: String(revision), kind: data.kind, amount_centavos: String(data.amountCentavos), entry_date: data.date, note: data.note });
    else goal = { id: 'goal', title: data.title, target_centavos: String(data.targetCentavos), target_date: null };
    const result = { id: String(revision), revision: String(revision) };
    operations.set(data.operationId, result);
    if (dropNextResponse) { dropNextResponse = false; return route.abort('connectionreset'); }
    return route.fulfill({ json: result });
  });
  }
  await setup(page);
  await page.goto('/');
  await expect(page.getByText('Hello, Alex.')).toBeVisible();
  await page.getByRole('button', { name: 'Add income' }).click();
  await page.getByLabel('Amount in PHP').fill('500');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('₱500.00');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount in PHP').fill('150');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('₱350.00');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await page.getByLabel('Goal name').fill('Emergency');
  await page.getByLabel('Target in PHP').fill('1000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Emergency')).toBeVisible();
  const suggestion = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Daily savings suggestion' }) }).locator('.simple-jar-amount');
  await expect(suggestion).toHaveText('₱150.00');
  dropNextResponse = true;
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount in PHP').fill('25');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same entry' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same entry' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry same entry' }).click();
  await expect(page.locator('.simple-amount')).toHaveText('₱325.00');
  await expect(suggestion).toHaveText('₱125.00');
  await page.reload();
  await expect(suggestion).toHaveText('₱125.00');
  expect(entries.filter((entry) => entry.amount_centavos === '2500')).toHaveLength(1);
  await expect(page.getByText('Emergency')).toBeVisible();
  await page.screenshot({ path: 'test-results/hosted-phone.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  for (const width of [320, 375, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  const secondDevice = await browser.newContext({ viewport: { width: 430, height: 900 } });
  try {
    const second = await secondDevice.newPage();
    await setup(second);
    await second.goto('http://127.0.0.1:47839/');
    await expect(second.locator('.simple-amount')).toHaveText('₱325.00');
    await expect(second.getByText('Emergency')).toBeVisible();
    await second.getByRole('button', { name: 'Record savings' }).click();
    await second.getByLabel('Amount in PHP').fill('100');
    await second.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(second.getByText('10% of your recorded savings goal')).toBeVisible();
    await expect(second.locator('.simple-amount')).toHaveText('₱225.00');
  } finally { await secondDevice.close(); }
});

test('new users choose a currency and balance, then track a goal and expenses independently', async ({ page, browser }) => {
  type Journal = { revision: number; setupRequired: boolean; preferences: { currency: 'PHP' | 'USD'; bufferCents: number; dailyLimitCents: number; pace: 'steady'; openingCashCents?: number; openingCashDate?: string; balanceAdjustments?: Array<{ id: string; date: string; deltaCents: number; createdAt: string }> }; entries: Array<{ id: string; kind: string; amount_centavos: string; entry_date: string; note: string }>; goal: null | { id: string; title: string; target_centavos: string; target_date: string | null }; operations: Map<string, { id: string; revision: string }> };
  const journals = new Map<string, Journal>();
  let dropSetup = true;
  const setup = async (target: Page, user: string) => {
    const journal: Journal = journals.get(user) ?? { revision: 0, setupRequired: true, preferences: { currency: 'PHP', bufferCents: 20000, dailyLimitCents: 1500, pace: 'steady' }, entries: [], goal: null, operations: new Map() };
    journals.set(user, journal);
    await target.route('**/api/auth/**', async route => {
      const url = route.request().url();
      const data = url.includes('/get-session') ? { user: { id: user, name: user, email: user + '@example.test', emailVerified: true }, session: { id: 'session', userId: user, token: 'test' } } : url.includes('/token') ? { token: 'test-token' } : {};
      await route.fulfill({ json: data, headers: { 'set-auth-jwt': 'test-jwt' } });
    });
    await target.route('**/api/tracking**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'GET') return route.fulfill({ json: { revision: String(journal.revision), setupRequired: journal.setupRequired, preferences: journal.preferences, entries: journal.entries, goal: journal.goal, bills: [] } });
      const data = route.request().postDataJSON();
      if (journal.operations.has(data.operationId)) return route.fulfill({ json: journal.operations.get(data.operationId) });
      expect(data.revision).toBe(String(journal.revision));
      if (path.endsWith('/setup')) {
        journal.setupRequired = false;
        journal.preferences = { ...journal.preferences, currency: data.currency, openingCashCents: data.openingCashCents, openingCashDate: data.openingCashDate };
      } else if (path.endsWith('/balance')) {
        const current = (journal.preferences.openingCashCents ?? 0) + journal.entries.reduce((sum, entry) => sum + Number(entry.amount_centavos) * (entry.kind === 'income' ? 1 : -1), 0) + (journal.preferences.balanceAdjustments ?? []).reduce((sum, item) => sum + item.deltaCents, 0);
        journal.preferences.balanceAdjustments = [...(journal.preferences.balanceAdjustments ?? []), { id: String(journal.revision + 1), date: journal.preferences.openingCashDate!, deltaCents: data.balanceCents - current, createdAt: new Date().toISOString() }];
      } else if (path.endsWith('/entries')) journal.entries.push({ id: String(journal.revision + 1), kind: data.kind, amount_centavos: String(data.amountCentavos), entry_date: data.date, note: data.note });
      else if (path.endsWith('/goal')) journal.goal = { id: 'goal', title: data.title, target_centavos: String(data.targetCentavos), target_date: null };
      journal.revision++;
      const result = { id: String(journal.revision), revision: String(journal.revision) };
      journal.operations.set(data.operationId, result);
      if (path.endsWith('/setup') && user === 'Alex' && dropSetup) { dropSetup = false; return route.abort('connectionreset'); }
      return route.fulfill({ json: result });
    });
  };
  await setup(page, 'Alex'); await page.goto('/');
  await page.getByLabel('Currency').selectOption('USD');
  await page.getByLabel('Current balance').fill('1000');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry setup' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry setup' }).click();
  await expect(page.locator('.simple-amount')).toHaveText('$1,000.00');
  await page.getByRole('button', { name: 'Create goal' }).click();
  await page.getByLabel('Goal name').fill('Emergency');
  await page.getByLabel('Target in USD').fill('2000');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const suggestion = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Daily savings suggestion' }) }).locator('.simple-jar-amount');
  await expect(suggestion).toHaveText('$15.00');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount in USD').fill('790');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('$210.00');
  await expect(suggestion).toHaveText('$10.00');
  await page.reload(); await expect(suggestion).toHaveText('$10.00');
  await page.getByRole('button', { name: 'Add income' }).click();
  await page.getByLabel('Amount in USD').fill('20');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('$230.00');
  await expect(suggestion).toHaveText('$15.00');
  await page.getByRole('button', { name: 'Update balance' }).click();
  await page.getByLabel('Amount in USD').fill('300');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('$300.00');
  await page.reload(); await expect(page.locator('.simple-amount')).toHaveText('$300.00');
  expect(journals.get('Alex')?.operations.size).toBe(5);
  expect(journals.get('Alex')?.entries).toHaveLength(2);
  await expect(page.getByRole('heading', { name: 'Walrus Memory' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Watch-only Sui wallet' })).toHaveCount(0);
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
  try {
    const other = await context.newPage(); await setup(other, 'Sam'); await other.goto('http://127.0.0.1:47839/');
    await other.getByLabel('Currency').selectOption('PHP');
    await other.getByLabel('Current balance').fill('500');
    await other.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(other.locator('.simple-amount')).toHaveText('₱500.00');
    await expect(other.getByText('Emergency')).toHaveCount(0);
    await other.reload(); await expect(other.locator('.simple-amount')).toHaveText('₱500.00');
    expect(await other.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  } finally { await context.close(); }
});
