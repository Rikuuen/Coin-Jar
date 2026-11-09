import { test, expect } from '@playwright/test';

test('a fictional weekday pattern and local expenses adjust a goal on another browser', async ({ browser }) => {
  test.setTimeout(150000);
  const first = await browser.newContext(), second = await browser.newContext();
  const goal = { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-11-19', status: 'active', createdAt: '2026-10-01T00:00:00Z' };
  const dates = ['2026-10-20', '2026-10-27', '2026-11-03', '2026-10-21', '2026-10-28', '2026-11-04'];
  const journal = { version: 1, nickname: 'Demo', currency: 'PHP', openingCents: 100000, openingDate: '2026-10-01', bufferCents: 0, dailyLimitCents: 0, entries: dates.map((date, i) => ({ id: `e${i}`, kind: 'expense', amountCents: i < 3 ? 2000 : 500, note: 'fictional', date, createdAt: '' })), adjustments: [], goal };
  try {
    const page = await first.newPage(); await page.clock.setFixedTime(new Date('2026-11-09T12:00:00Z'));
    await page.addInitScript(j => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)), journal);
    await page.goto('/?walrus=mainnet-demo'); await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Savings settings' }).click();
    await page.getByLabel('Automatically save preferences').check(); const code = await page.getByLabel('Walrus access code').inputValue(); await page.getByLabel('I saved my memory code').check(); await page.getByLabel('Remember spending patterns').check(); await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Home' }).click(); await expect(page.getByText('Walrus remembers your spending patterns across the week.')).toBeVisible({ timeout: 90000 });
    const other = await second.newPage(); await other.clock.setFixedTime(new Date('2026-11-09T12:00:00Z'));
    await other.addInitScript(({ j, code }) => { localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ ...j, openingCents: 11500, entries: j.entries.slice(3) })); localStorage.setItem('coinjar.phone.walrus.auto.v1.mainnet-demo', JSON.stringify({ enabled: true, code, habits: true, recentHabits: false, personal: true, restorePending: false })); }, { j: journal, code });
    await other.goto('/?walrus=mainnet-demo'); await expect(other.getByText('Walrus remembers your spending patterns across the week.')).toBeVisible({ timeout: 60000 });
    const suggestion = other.locator('section').filter({ has: other.getByRole('heading', { name: 'Tomorrow’s estimate' }) });
    await expect(suggestion.locator('.simple-jar-amount').last()).toHaveText('₱90.00'); await expect(suggestion.getByText('a rough estimate from a remembered pattern', { exact: false })).toBeVisible();
  } finally { await first.close(); await second.close(); }
});
