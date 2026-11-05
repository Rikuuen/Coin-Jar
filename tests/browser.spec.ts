import { test, expect, type Page } from '@playwright/test';
import { createApp } from '../server/app';
import { createInitialState } from '../src/domain';
import { USDC_TYPES } from '../src/usdc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
async function openMemory(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Memory', exact: true }).click();
}

test('simple journal tracks balance, scheduled income and automatic savings on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let time = new Date('2026-10-30T04:00:00Z');
  const uploaded: string[] = [];
  const app = createApp({ dbPath: ':memory:', env: {}, now: () => time, memory: { remember: async (text) => { uploaded.push(text); return { blobId: 'summary-1' }; }, search: async () => [] } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Your money, more understood.' })).toBeVisible();
    await page.screenshot({ path: 'test-results/welcome-phone.png', fullPage: true });
    await page.getByRole('button', { name: 'Continue without wallet' }).click();
    await page.getByLabel('Your name').fill('Alex');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Monthly income in PHP').fill('0');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Remember my summaries automatically').uncheck();
    await page.getByRole('button', { name: 'Enter CoinJar' }).click();
    await expect(page.getByText('Hello, Alex.')).toBeVisible();
    await page.getByRole('button', { name: 'Set balance' }).click();
    await page.getByLabel('Amount in PHP').fill('500');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.simple-amount')).toHaveText('₱500.00');
    await page.getByRole('button', { name: 'Add expense' }).click();
    await page.getByLabel('Amount in PHP').fill('50');
    await page.getByLabel('Note (optional)').fill('Food');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.simple-amount')).toHaveText('₱450.00');
    await page.getByRole('button', { name: 'Add schedule' }).click();
    await page.getByLabel('Amount in PHP').fill('300');
    await page.getByLabel('Name', { exact: true }).fill('Salary');
    await page.getByLabel('Days of month').fill('31');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Save daily in PHP').fill('10');
    await page.getByLabel('Keep available in PHP').fill('100');
    await page.getByLabel('Remember summaries and spending patterns').check();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => uploaded.length).toBe(1);
    expect(uploaded[0]).not.toContain('Food');
    time = new Date('2026-10-31T04:00:00Z');
    await page.reload();
    await expect(page.locator('.simple-amount')).toHaveText('₱740.00');
    await expect(page.locator('.simple-jar-amount')).toHaveText('₱10.00');
    await page.getByRole('button', { name: 'Move back' }).click();
    await page.getByLabel('Amount in PHP').fill('5');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.simple-amount')).toHaveText('₱745.00');
    await expect(page.locator('.simple-jar-amount')).toHaveText('₱5.00');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: 'test-results/simple-phone.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: 'test-results/simple-desktop.png', fullPage: true });
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('weekend memory asks before changing the saving rule', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const app = createApp({ dbPath: ':memory:', env: {}, now: () => new Date('2026-10-31T04:00:00Z') });
  const state = createInitialState('2026-10-31');
  state.simpleProfile = { name: 'Alex', monthlyIncomeCents: 0 };
  state.openingCashCents = 100000;
  state.autoSavings = { dailyCents: 1000, bufferCents: 0, startDate: '2026-11-01' };
  state.weekendSignal = true;
  app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(state));
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(base);
    await expect(page.getByText('Save 25% less on Fridays and weekends?')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, save less' }).click();
    await expect(page.getByText('Reduced for your saved weekend preference.')).toBeVisible();
    await page.getByRole('button', { name: 'Turn off weekend adjustment' }).click();
    await expect(page.getByText('Save 25% less on Fridays and weekends?')).toHaveCount(0);
    await page.getByRole('button', { name: 'Pause today' }).click();
    await page.getByLabel('Reason').selectOption('weekend');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saving paused today')).toBeVisible();
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('personal journal opens onboarding only after its owner verifies a wallet', async ({ page }) => {
  const owner = Ed25519Keypair.generate();
  const app = createApp({ dbPath: ':memory:', env: { COINJAR_OWNER_ADDRESS: owner.toSuiAddress() }, memory: { remember: async () => ({ blobId: 'test' }), search: async () => [] } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Welcome to CoinJar.' })).toBeVisible();
    const session = await (await page.request.get(base + '/api/session')).json();
    const options = { headers: { 'x-coinjar-token': session.csrfToken }, data: { address: owner.toSuiAddress() } };
    const challenge = await (await page.request.post(base + '/api/simple/wallet/challenge', options)).json();
    const signed = await owner.signPersonalMessage(new TextEncoder().encode(challenge.message));
    const verify = await page.request.post(base + '/api/simple/wallet/verify', { headers: { 'x-coinjar-token': session.csrfToken }, data: { id: challenge.id, signature: signed.signature } });
    expect(verify.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'What should we call you?' })).toBeVisible();
    await page.getByLabel('Your name').fill('Alex');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByLabel('Monthly income in PHP').fill('10000');
    await page.getByLabel('Available balance today in PHP').fill('500');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByLabel('Remember my summaries automatically')).not.toBeChecked();
    await page.getByRole('button', { name: 'Enter CoinJar' }).click();
    await expect(page.locator('.simple-amount')).toHaveText('₱500.00');
    await expect(page.getByText('Sample journal')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Lock journal' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('savings suggestion shows a timestamped USDC estimate', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const app = createApp({ dbPath: ':memory:', env: { COINJAR_MODE: 'demo', TATUM_API_KEY: 'test' }, now: () => new Date('2026-10-30T12:00:00Z'), fx: { getRate: async () => ({ value: '0.015625', basePair: 'USD', symbol: 'PHP', timestamp: Date.parse('2026-10-30T12:00:00Z'), source: 'test' }) } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(`${base}/?advanced=1`);
    await page.getByRole('button', { name: 'Load sample data' }).click();
    await expect(page.locator('.recommendation-intro')).toContainText('USDC');
    await expect(page.locator('.recommendation-intro')).toContainText('Assuming 1 USDC = $1');
    await expect(page.locator('.recommendation-intro')).toContainText('₱64.00 per USD');
    await expect(page.locator('.recommendation-intro')).toContainText('USDC is sent on the Sui network');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: 'test-results/rate-phone.png', fullPage: true });
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('new user sets opening cash, records spending and reviews the savings jar', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    const target = window as unknown as { notices: string[] };
    target.notices = [];
    Object.defineProperty(window, 'Notification', { value: class { static permission = 'granted'; constructor(title: string) { target.notices.push(title); } } });
  });
  const app = createApp({ dbPath: ':memory:', env: {}, now: () => new Date('2026-10-30T12:00:00Z') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(`${base}/?advanced=1`);
    await expect(page.getByText('SETUP · 1 OF 4')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Available cash right now in PHP').fill('500.00');
    await page.getByLabel('Income pattern').selectOption('regular');
    await page.getByLabel('Expected amount per payday in PHP').fill('200.00');
    await page.getByLabel('Days of each month').fill('15, 30');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('Goal amount in PHP').fill('1000.00');
    await page.getByLabel('Cash buffer in PHP').fill('100.00');
    await page.getByLabel('Daily savings limit in PHP').fill('50.00');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.locator('.available-money')).toContainText('₱500.00');
    await expect(page.locator('.monthly-totals')).toContainText('₱0.00');
    await page.getByRole('button', { name: 'Add an expense' }).click();
    await page.getByLabel('Amount in PHP', { exact: true }).fill('50.00');
    await page.getByLabel('Category').fill('Food');
    await page.getByLabel('Time', { exact: true }).fill('09:30');
    await page.getByRole('button', { name: 'Save expense' }).click();
    await expect(page.locator('.available-money')).toContainText('₱450.00');
    await expect(page.locator('.today-expenses')).toContainText('09:30');
    await expect(page.locator('.today-expenses')).toContainText('Food');
    await page.screenshot({ path: 'test-results/daily-flow-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Jar', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('img', { name: /Savings jar 0% full/ })).toBeVisible();
    await page.getByRole('button', { name: 'Record savings' }).click();
    await page.getByLabel('Amount in PHP', { exact: true }).fill('10.00');
    await page.getByRole('button', { name: 'Record savings' }).click();
    await page.getByRole('button', { name: 'Jar', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('img', { name: /Savings jar 1% full/ })).toBeVisible();
    await expect(page.locator('.jar-page')).toContainText('₱10.00');
    await page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).click();
    await page.getByLabel('Schedule type').selectOption('expense');
    await page.getByLabel('Name', { exact: true }).fill('Rent');
    await page.getByLabel('Amount per occurrence in PHP').fill('20.00');
    await page.getByLabel('Days of each month').fill('30');
    await page.getByRole('button', { name: 'Add schedule' }).click();
    await page.getByLabel('Review time').fill('00:00');
    await page.getByLabel('Remind me while CoinJar is open').check();
    await page.getByRole('button', { name: 'Save reminder' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { notices: string[] }).notices.length)).toBe(1);
    await page.getByRole('button', { name: 'Today', exact: true }).filter({ visible: true }).click();
    await expect(page.locator('.expected-items')).toContainText('Rent');
    await page.locator('.expected-items').getByRole('button', { name: 'Record payment' }).click();
    await expect(page.locator('.available-money')).toContainText('₱420.00');
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('automatic memory is opt-in, explains disclosure, and reports sync', async ({ page }) => {
  let writes = 0;
  const app = createApp({ dbPath: ':memory:', env: { COINJAR_MODE: 'demo' }, now: () => new Date('2026-10-30T12:00:00Z'), memory: {
    remember: async () => { writes++; await new Promise((resolve) => setTimeout(resolve, 80)); return { blob_id: 'auto-test' }; },
    search: async () => [],
  } });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(`${base}/?advanced=1`);
    await page.getByRole('button', { name: 'Load sample data' }).click();
    await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/state')).json();
      await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinjar-token': csrfToken }, body: JSON.stringify({ action: 'reduce', suggestedCents: 1000, amountCents: 500 }) });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Insights', exact: true }).filter({ visible: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: 'test-results/auto-sync-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: 'test-results/auto-sync-desktop.png', fullPage: true });
    await expect(page.getByText(/relayer processes this summary as plaintext/)).toBeVisible();
    await expect(page.locator('.auto-sync-control').getByText('Automatic sync is off.')).toBeVisible();
    expect(writes).toBe(0);
    await page.getByRole('button', { name: 'I agree, turn on automatic sync' }).click();
    await expect(page.getByText('Automatic sync is on.')).toBeVisible();
    await page.locator('.insight-card').filter({ hasText: 'You often reduce suggestions' }).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await openMemory(page);
    await expect(page.getByText('Synced to Walrus')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Turn off automatic sync' }).click();
    await expect(page.locator('.auto-sync-control').getByText('Automatic sync is off.')).toBeVisible();
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('recording an expense from Today updates spending and the savings suggestion offline', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  const app = createApp({ dbPath: ':memory:', env: {}, now: () => new Date('2026-10-30T12:00:00Z') });
  const state = createInitialState('2026-10-30');
  state.goal = { id: 'daily-goal', title: 'Emergency fund', targetCents: 1000000, targetDate: '2026-12-31', status: 'active', createdAt: '2026-10-30' };
  state.entries = [{ id: 'income', kind: 'income', amountCents: 50000, note: 'Income', date: '2026-10-30', createdAt: '2026-10-30' }];
  app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(state));
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    await page.goto(`${base}/?advanced=1`);
    await expect(page.locator('.page-intro h1')).toContainText('₱15.00');
    await expect(page.locator('.recommendation-context')).toContainText('recorded so far');
    await expect(page.getByRole('button', { name: 'Save this amount' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review today’s savings' }).click();
    await expect(page.locator('.recommendation-context')).toContainText('Based on what you’ve recorded.');
    await expect(page.getByRole('button', { name: 'Save this amount' })).toBeVisible();
    await expect(page.getByText('Start with what you spent today.')).toBeVisible();
    await page.getByRole('button', { name: 'Add an expense' }).click();
    await page.getByLabel('Amount in PHP', { exact: true }).fill('295.00');
    await page.getByLabel('Category').fill('Groceries');
    await page.getByLabel('Note').fill('Market');
    await page.getByRole('button', { name: 'Save expense' }).click();
    await expect(page.getByText('Expense recorded. Your savings suggestion is up to date.')).toBeVisible();
    await expect(page.locator('.today-spending')).toContainText('₱295.00');
    await expect(page.locator('.today-spending')).toContainText('Market');
    await expect(page.locator('.page-intro h1')).toContainText('₱5.00');
    await expect(page.locator('.recommendation-context')).toContainText('recorded so far');
    await expect(page.getByRole('button', { name: 'Save this amount' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review today’s savings' }).click();
    await page.getByText('Why this amount?').click();
    await expect(page.locator('.recommendation-reasons')).toContainText('buffer');
    await page.reload();
    await expect(page.locator('.today-spending')).toContainText('₱295.00');
    await expect(page.locator('.page-intro h1')).toContainText('₱5.00');
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('confirmed preference syncs, restores and explains the changed recommendation', async ({ page }) => {
  let saved = '';
  const memory = {
    remember: async (text: string) => { saved = text; return { blob_id: 'browser-memory' }; },
    search: async () => ({ results: saved ? [{ blob_id: 'browser-memory', text: saved }] : [] }),
  };
  async function start() {
    const app = createApp({ dbPath: ':memory:', env: { COINJAR_MODE: 'demo' }, now: () => new Date('2026-10-30T12:00:00Z'), memory });
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  }
  const first = await start();
  try {
    await page.goto(`${first.base}/?advanced=1`);
    await page.getByRole('button', { name: 'Load sample data' }).click();
    const response = await page.evaluate(async () => {
      const { csrfToken } = await (await fetch('/api/state')).json();
      return (await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinjar-token': csrfToken }, body: JSON.stringify({ action: 'reduce', suggestedCents: 1000, amountCents: 500 }) })).status;
    });
    expect(response).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: 'Insights', exact: true }).filter({ visible: true }).click();
    const insight = page.locator('.insight-card').filter({ hasText: 'You often reduce suggestions' });
    await expect(insight).toContainText('Observations');
    await insight.getByRole('button', { name: 'Confirm', exact: true }).click();
    await openMemory(page);
    const choice = page.locator('label.memory-choice').filter({ hasText: '₱5.00 daily cap' });
    await expect(choice).toContainText('Supporting observations');
    await choice.locator('input').check();
    await page.getByRole('button', { name: /I consent, sync memory/ }).click();
    await expect.poll(() => saved).toContain('COINJAR_PREFERENCES_V1 ');
  } finally { first.app.server.closeAllConnections(); await first.app.close(); }
  const second = await start();
  try {
    await page.goto(`${second.base}/?advanced=1`);
    await page.getByRole('button', { name: 'Load sample data' }).click();
    const before = await page.locator('.page-intro h1').innerText();
    await openMemory(page);
    await page.getByRole('button', { name: 'Restore recalled preferences' }).click();
    await expect(page.getByText(/Applied valid recalled memories/)).toBeVisible();
    await page.getByRole('button', { name: 'Today', exact: true }).filter({ visible: true }).click();
    const after = await page.locator('.page-intro h1').innerText();
    expect(before).not.toEqual(after);
    await expect(page.locator('.page-intro h1')).toContainText('₱5.00');
    await page.getByText('Personalized using your saved preferences').click();
    await expect(page.locator('.memory-explanation')).toContainText('restored from Walrus');
    await expect(page.locator('.memory-explanation')).toContainText('came from a pattern you confirmed');
    await expect(page.locator('.memory-explanation')).toContainText('suggested, ₱5.00 chosen');
    await page.getByRole('button', { name: 'Correct daily cap' }).click();
    await page.getByLabel('Daily savings cap in PHP').fill('4.00');
    await page.getByRole('button', { name: /Save preferences/ }).click();
    await expect(page.getByText(/Preferences saved/)).toBeVisible();
    await page.getByRole('button', { name: 'Today', exact: true }).filter({ visible: true }).click();
    await expect(page.locator('.page-intro h1')).toContainText('₱4.00');
    await expect(page.getByText('Personalized using your saved preferences')).toHaveCount(0);
  } finally { second.app.server.closeAllConnections(); await second.app.close(); }
});

test('an older USD journal is labeled and is not relabeled as pesos', async ({
  page,
}) => {
  const app = createApp({ dbPath: ':memory:', env: {} });
  const state = createInitialState('2026-10-31');
  state.preferences.currency = 'USD';
  state.goal = {
    id: 'legacy',
    title: 'Legacy goal',
    targetCents: 10000,
    targetDate: '2027-12-01',
    status: 'active',
    createdAt: '2026-10-31',
  };
  app.db
    .prepare('UPDATE app_state SET json=? WHERE id=1')
    .run(JSON.stringify(state));
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Legacy server failed to start');
  try {
    await page.goto(`http://127.0.0.1:${address.port}/?advanced=1`);
    await expect(
      page.getByText(/amounts remain in USD and have not been converted/i),
    ).toBeVisible();
    await expect(
      page.getByText('$100.00', { exact: false }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Settings', exact: true })
      .filter({ visible: true })
      .click();
    await expect(page.getByLabel('Daily savings cap in USD')).toHaveValue(
      '15.00',
    );
    await expect(
      page.getByText('This previous journal uses USD.'),
    ).toBeVisible();
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

test('sample feedback produces a reviewable preference and a paid bill becomes one expense', async ({
  page,
}) => {
  const app = createApp({
    dbPath: ':memory:',
    env: { COINJAR_MODE: 'demo' },
    fx: {
      getRate: async () => ({
        value: '0.017',
        basePair: 'USD',
        symbol: 'PHP',
        timestamp: Date.now(),
        source: 'test',
      }),
    },
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Demo server failed to start');
  try {
    await page.goto(`http://127.0.0.1:${address.port}/?advanced=1`);
    await page.getByRole('button', { name: 'Load sample data' }).click();
    await page.getByRole('button', { name: 'Review today’s savings' }).click();
    await page.getByRole('button', { name: 'Adjust', exact: true }).click();
    await page.getByLabel('Amount in PHP', { exact: true }).fill('5.00');
    await page.getByRole('button', { name: 'Record savings' }).click();
    await page
      .getByRole('button', { name: 'Insights', exact: true })
      .filter({ visible: true })
      .click();
    const insight = page
      .locator('.insight-card')
      .filter({ hasText: 'You often reduce suggestions to around ₱5.00' });
    await expect(insight).toContainText('3 relevant records');
    await insight.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(insight).toContainText('CONFIRMED');
    await page
      .getByRole('button', { name: 'Settings', exact: true })
      .filter({ visible: true })
      .click();
    await expect(page.getByLabel('Daily savings cap in PHP')).toHaveValue(
      '5.00',
    );
    await page
      .getByRole('button', { name: 'Activity', exact: true })
      .filter({ visible: true })
      .click();
    await page.getByLabel('Bill name').fill('Sample rent');
    await page.getByLabel('Bill amount in PHP').fill('25.00');
    await page.getByLabel('Due date').fill('2027-12-01');
    await page.getByRole('button', { name: 'Add bill' }).click();
    const bill = page
      .locator('.ledger-row')
      .filter({ hasText: 'Sample rent' })
      .first();
    await bill.getByRole('button', { name: /record/i }).click();
    await expect(bill).toContainText('PAID');
    await expect(
      page.locator('.ledger-row').filter({ hasText: 'Sample rent' }),
    ).toHaveCount(2);
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

test('sample journey persists preferences and goal changes', async ({
  page,
}) => {
  await page.goto('/?advanced=1');
  await page.getByRole('button', { name: /load sample data/i }).click();
  await expect(
    page.getByText('Sample data loaded. All entries are synthetic.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Activity', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: /add income/i }).click();
  await page.getByLabel('Amount in PHP', { exact: true }).fill('100.00');
  await page.getByLabel(/note/i).fill('Test income');
  await page.getByRole('button', { name: 'Save income' }).click();
  await expect(page.getByText('Test income')).toBeVisible();
  await page
    .getByRole('button', { name: 'Settings', exact: true })
    .first()
    .click();
  await page.getByLabel('Daily savings cap in PHP').fill('1.00');
  await page.getByRole('button', { name: /save preferences/i }).click();
  await expect(page.getByText(/preferences saved/i)).toBeVisible();
  await openMemory(page);
  await expect(page.getByText(/Daily cap: ₱1\.00/)).toBeVisible();
  await expect(page.getByText(/Current suggestion: \₱1.00/)).toBeVisible();
  await page.reload();
  await openMemory(page);
  await expect(page.getByText(/Daily cap: ₱1\.00/)).toBeVisible();
  await page
    .getByRole('button', { name: 'Today', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Review today’s savings' }).click();
  await page.getByRole('button', { name: /save this amount/i }).click();
  await expect(page.getByLabel('Amount in PHP', { exact: true })).toHaveValue(
    '1.00',
  );
  await page.getByRole('button', { name: 'Record savings' }).click();
  await page
    .getByRole('button', { name: 'Today', exact: true })
    .first()
    .click();
  await page.getByText('Why this amount?').click();
  await expect(
    page.getByText(/already recorded a contribution today/i),
  ).toBeVisible();
  await page.getByRole('button', { name: /edit goal/i }).click();
  await page.getByLabel('Status').selectOption('paused');
  await page.getByRole('button', { name: /save goal/i }).click();
  await expect(page.getByText(/STATUS\s+PAUSED/)).toBeVisible();
  await page.getByRole('button', { name: /edit goal/i }).click();
  await page.getByLabel('Status').selectOption('active');
  await page.getByRole('button', { name: /save goal/i }).click();
  await expect(page.getByText(/STATUS\s+ACTIVE/)).toBeVisible();
});

for (const width of [320, 375, 430, 768, 1024, 1440]) {
  test(`layout fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?advanced=1');
    if (width === 375 || width === 1440)
      await page.screenshot({
        path: `test-results/today-${width}.png`,
        fullPage: true,
      });
    for (const tab of ['Today', 'Activity', 'Jar', 'Insights', 'Settings']) {
      if (tab !== 'Today')
        await page
          .getByRole('button', { name: tab, exact: true })
          .filter({ visible: true })
          .click();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    }
    await page.screenshot({
      path: `test-results/coinjar-${width}.png`,
      fullPage: true,
    });
  });
}

test('shows validation error and keeps the form', async ({ page }) => {
  await page.goto('/?advanced=1');
  await page
    .getByRole('button', { name: 'Activity', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: /add income/i }).click();
  await page.getByLabel('Amount in PHP', { exact: true }).fill('invalid');
  await page.getByRole('button', { name: 'Save income' }).click();
  await expect(page.getByText(/invalid amount/i)).toBeVisible();
  await expect(page.getByLabel('Amount in PHP', { exact: true })).toHaveValue(
    'invalid',
  );
});

test('retry after a lost response records one entry', async ({ page }) => {
  await page.goto('/?advanced=1');
  await page
    .getByRole('button', { name: 'Activity', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: /add income/i }).click();
  await page.getByLabel('Amount in PHP', { exact: true }).fill('7.00');
  await page.getByLabel(/note/i).fill('Lost response retry');
  let intercepted = false;
  await page.route('**/api/entries', async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Save income' }).click();
  await expect(page.getByText(/response was lost/i)).toBeVisible();
  await page.getByRole('button', { name: 'Save income' }).click();
  await expect(page.getByText('Lost response retry')).toHaveCount(1);
  await page.reload();
  await page
    .getByRole('button', { name: 'Activity', exact: true })
    .first()
    .click();
  await expect(page.getByText('Lost response retry')).toHaveCount(1);
});

test('voiding a mistaken entry preserves its record after reload', async ({
  page,
}) => {
  const app = createApp({
    dbPath: ':memory:',
    env: { COINJAR_MODE: 'demo' },
    fx: {
      getRate: async () => ({
        value: '0.017',
        basePair: 'USD',
        symbol: 'PHP',
        timestamp: Date.now(),
        source: 'test',
      }),
    },
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Demo server failed to start');
  try {
    await page.goto(`http://127.0.0.1:${address.port}/?advanced=1`);
    await page
      .getByRole('button', { name: 'Activity', exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole('button', { name: /add income/i }).click();
    await page.getByLabel('Amount in PHP', { exact: true }).fill('25.00');
    await page.getByLabel(/note/i).fill('Mistaken income');
    await page.getByRole('button', { name: 'Save income' }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .getByRole('button', { name: /void entry: mistaken income/i })
      .click();
    const entry = page
      .locator('.ledger-row')
      .filter({ hasText: 'Mistaken income' });
    await expect(entry).toContainText('VOIDED');
    await expect(
      entry.getByRole('button', { name: /void entry/i }),
    ).toHaveCount(0);
    await page.reload();
    await page
      .getByRole('button', { name: 'Activity', exact: true })
      .filter({ visible: true })
      .click();
    await expect(entry).toContainText('VOIDED');
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});


test('goal shows recorded savings and a separate wallet balance, including refresh failure', async ({ page }) => {
  let fail = false;
  const app = createApp({ dbPath: ':memory:', env: {}, balance: { getBalance: async () => {
    if (fail) throw new Error('Balance unavailable');
    return { balanceMist: '1250000', coinType: USDC_TYPES.mainnet, network: 'mainnet' };
  } } });
  const state = createInitialState('2026-10-31');
  state.goal = { id: 'wallet-goal', title: 'Wallet goal', targetCents: 10000, targetDate: '2027-12-01', status: 'active', createdAt: '2026-10-31', wallet: { address: '0x' + 'a'.repeat(64) } };
  app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(state));
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Server failed to start');
  try {
    await page.goto(`http://127.0.0.1:${address.port}/?advanced=1`);
    const goal = page.locator('.goal-section');
    await expect(goal).toContainText('Recorded savings');
    await expect(goal).toContainText('Balance not yet checked');
    await expect(goal).toContainText('not automatically allocated');
    await expect(goal).toContainText('USDC and PHP have different values');
    await goal.getByRole('button', { name: 'Refresh balance' }).click();
    await expect(goal).toContainText('1.25 USDC · mainnet');
    fail = true;
    await goal.getByRole('button', { name: 'Refresh balance' }).click();
    await expect(page.getByText('Wallet refresh failed. The last checked balance may be stale.')).toBeVisible();
    await expect(goal).toContainText('1.25 USDC · mainnet');
  } finally { app.server.closeAllConnections(); await app.close(); }
});
