import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { encryptJournal } from '../src/journalCipher';
import { newJournal } from '../src/phoneJournal';

test('recovery prompt fits phone widths and helper text has readable contrast', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Nickname').fill('Fictional'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 915 });
    const size = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth, button: document.querySelector('.phone-banner button')!.getBoundingClientRect().right }));
    expect(size.page).toBeLessThanOrEqual(size.viewport); expect(size.button).toBeLessThanOrEqual(size.viewport);
  }
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const ratio = await page.locator('.profile-settings .simple-hint').evaluate(element => {
    const rgb = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (values: number[]) => values.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const foreground = luminance(rgb(getComputedStyle(element).color));
    const background = luminance(rgb(getComputedStyle(element.closest('section')!).backgroundColor));
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('activity groups entries and calculates the last seven days', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-10T12:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 1, nickname: 'Fictional', currency: 'PHP', openingCents: 100000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, adjustments: [], goal: null, entries: [
    { id: 'old', kind: 'income', amountCents: 90000, date: '2026-01-02', note: 'Old income', createdAt: '' },
    { id: 'income', kind: 'income', amountCents: 10000, date: '2026-01-08', note: 'Pay', createdAt: '' },
    { id: 'expense', kind: 'expense', amountCents: 2000, date: '2026-01-09', note: 'Lunch', createdAt: '2026-01-10T04:30:00Z' },
    { id: 'saving', kind: 'contribution', amountCents: 3000, date: '2026-01-10', note: '', createdAt: '2026-01-10T04:00:00Z' },
  ] })));
  await page.goto('/'); await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const week = page.getByLabel('Last 7 days'); await expect(week).toContainText('₱100.00'); await expect(week).toContainText('₱20.00'); await expect(week).toContainText('₱30.00'); await expect(week).not.toContainText('₱900.00');
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Yesterday', exact: true })).toBeVisible(); await expect(page.getByText('Lunch')).toBeVisible();
  const today = page.locator('.phone-day').filter({ has: page.getByRole('heading', { name: 'Today', exact: true }) });
  await expect(today.locator('.phone-day-head')).toContainText('Jan 10, 2026');
  await expect(today.locator('.phone-day-head')).not.toContainText('₱');
  const recordedAt = (value: string) => page.evaluate(timestamp => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp)), value);
  await expect(today).toContainText(`Recorded ${await recordedAt('2026-01-10T04:00:00Z')}`);
  await expect(page.locator('.phone-entry').filter({ hasText: 'Lunch' })).toContainText(`Recorded ${await recordedAt('2026-01-10T04:30:00Z')}`);
  await expect(page.locator('.phone-entry').filter({ hasText: 'Pay' })).toContainText('Recorded time unavailable');
});

test('existing corrections remain accurate without correction controls', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-10T12:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 3, currency: 'PHP', openingCents: 1000000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, entries: [{ id: 'original', kind: 'contribution', goalId: 'g', amountCents: 120000, date: '2026-01-10', note: '', createdAt: '', voidedAt: '2026-01-10T00:00:00Z' }, { id: 'new', kind: 'contribution', goalId: 'g', correctionOf: 'original', amountCents: 100000, date: '2026-01-09', note: '', createdAt: '' }], adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 500000, targetDate: '2026-01-20', status: 'active', createdAt: '' }, otherGoals: [] })));
  await page.goto('/'); await expect(page.locator('.simple-amount')).toHaveText('₱9,000.00');
  await expect(page.locator('.phone-goal')).toContainText('₱1,000.00 saved of ₱5,000.00');
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Correct', exact: true })).toHaveCount(0);
  await expect(page.locator('.phone-entry')).toHaveCount(1);
  await expect(page.locator('.phone-entry')).toContainText('₱1,000.00');
  const journal = await page.evaluate(() => JSON.parse(localStorage.getItem('coinjar.phone.demo.journal.v1')!));
  expect(journal.entries).toHaveLength(2);
});

test('plain link opens the longer-link journal without exposing or deleting the other journal', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    const journal = { version: 1, currency: 'PHP', openingCents: 10000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, entries: [], adjustments: [], goal: null };
    localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ ...journal, nickname: 'Long link' }));
    localStorage.setItem('coinjar.phone.journal.v1', JSON.stringify({ ...journal, nickname: 'Plain link' }));
    localStorage.setItem('coinjar.phone.recovery.key.v1.demo', 'preserved-marker');
    localStorage.setItem('coinjar.phone.journal-space.v1', 'regular');
  });
  const page = await context.newPage(); await page.goto('/');
  await expect(page.getByText('Hi, Long link')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose your journal' })).toHaveCount(0);
  await page.goto('/?walrus=mainnet-demo'); await expect(page.getByText('Hi, Long link')).toBeVisible(); expect(new URL(page.url()).searchParams.has('walrus')).toBe(false);
  await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByRole('button', { name: 'Switch journal' })).toHaveCount(0); await page.reload(); await expect(page.getByText('Hi, Long link')).toBeVisible();
  expect(await page.evaluate(() => [localStorage.getItem('coinjar.phone.demo.journal.v1'), localStorage.getItem('coinjar.phone.journal.v1'), localStorage.getItem('coinjar.phone.recovery.key.v1.demo')])).toEqual([expect.stringContaining('Long link'), expect.stringContaining('Plain link'), 'preserved-marker']);
  await context.close();
});

test('existing legacy journal uses mainnet from the plain link', async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => { localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 1, nickname: 'Legacy', currency: 'PHP', openingCents: 10000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, entries: [], adjustments: [], goal: null })); });
  const page = await context.newPage(); await page.goto('/'); await expect(page.getByText('Hi, Legacy')).toBeVisible();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Savings settings' }).click(); await page.getByLabel('Automatically save preferences').check();
  await expect(page.getByLabel('Walrus access code')).toBeVisible(); await context.close();
});

test('recovery finds an older regular-space backup from the plain link', async ({ browser }) => {
  const second = await browser.newContext(); const key = randomBytes(32).toString('base64url');
  let envelope: unknown = (await encryptJournal(key, newJournal('PHP', 100000, '2026-01-01', 'Older'))).envelope, writes = 0;
  const handle = async (route: import('@playwright/test').Route) => {
    const body = route.request().postDataJSON(), legacy = route.request().headers()['x-coinjar-memory-demo'] === '1';
    if (body.action === 'backupSave') { expect(legacy).toBe(false); envelope = body.envelope; writes++; await route.fulfill({ json: { saved: true } }); }
    else if (body.action === 'backupRestore' && envelope && !legacy) await route.fulfill({ json: { envelope } });
    else await route.fulfill({ status: 404, json: { error: 'No recovery backup found.' } });
  };
  await second.route('**/api/phone/walrus', handle);
  const other = await second.newPage(); await other.goto('/'); await other.getByLabel('Nickname').fill('New'); await other.getByLabel('Currency').selectOption('PHP'); await other.getByLabel('Current balance').fill('10'); await other.getByRole('button', { name: 'Continue', exact: true }).click(); await other.getByRole('button', { name: 'Profile' }).click(); await other.getByLabel('Recovery key', { exact: true }).fill(key); other.once('dialog', dialog => void dialog.accept()); await other.getByRole('button', { name: 'Restore journal' }).click(); await expect(other.getByText('Journal restored on this device.', { exact: false })).toBeVisible();
  await other.getByRole('button', { name: 'Home' }).click(); await expect(other.locator('.simple-amount')).toHaveText('₱1,000.00'); await other.getByRole('button', { name: 'Add expense' }).click(); await other.getByLabel('Amount in PHP').fill('50'); await other.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => writes).toBe(1);
  await second.close();
});

test('automatic backup pauses if the alternate recovery space cannot be checked', async ({ browser }) => {
  const context = await browser.newContext(); let writes = 0;
  await context.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'backupSave') { writes++; return route.fulfill({ json: { saved: true } }); }
    return route.fulfill(route.request().headers()['x-coinjar-memory-demo'] === '1' ? { status: 404, json: { error: 'No recovery backup found.' } } : { status: 502, json: { error: 'Provider unavailable.' } });
  });
  const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Nickname').fill('Fictional'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click(); await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Generate key' }).click(); await page.getByRole('button', { name: 'I saved my recovery key' }).click(); await expect(page.getByText('Backup not confirmed.', { exact: false })).toBeVisible(); expect(writes).toBe(0);
  await context.close();
});

test('existing personal preferences can be found in the other mainnet namespace', async ({ browser }) => {
  const context = await browser.newContext(); let savedInLegacy: boolean | undefined;
  const memory = 'COINJAR_PHONE_PREFERENCES_V2 ' + JSON.stringify({ currency: 'PHP', origin: 'manual' });
  await context.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON(), legacy = route.request().headers()['x-coinjar-memory-demo'] === '1';
    if (body.action === 'recall') return route.fulfill({ json: { memories: legacy ? [] : [memory] } });
    if (body.action === 'remember') { savedInLegacy = legacy; return route.fulfill({ json: { saved: true } }); }
    return route.fulfill({ json: { memories: [] } });
  });
  const page = await context.newPage(); await page.goto('/'); await page.getByLabel('Nickname').fill('Fictional'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByLabel('Automatically save preferences').check(); await page.getByRole('button', { name: 'Use an existing code' }).click(); await page.getByLabel('Memory access code').fill('a'.repeat(43)); await page.getByLabel('I saved my memory code').check(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Find preferences' }).click(); await expect(page.getByRole('button', { name: 'Review memory 1' })).toBeVisible(); page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Review memory 1' }).click(); await expect(page.getByText('Saved preferences applied on this device.')).toBeVisible(); await expect.poll(() => savedInLegacy).toBe(false);
  await context.close();
});

test('automatic encrypted recovery follows journal changes and pauses on another device', async ({ browser }) => {
  const first = await browser.newContext(), second = await browser.newContext();
  let envelope: unknown, writes = 0;
  const handle = async (route: import('@playwright/test').Route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'backupSave') { envelope = body.envelope; writes++; await route.fulfill({ json: { saved: true } }); }
    else if (body.action === 'backupRestore' && envelope) await route.fulfill({ json: { envelope } });
    else await route.fulfill({ status: 404, json: { error: 'No recovery backup found.' } });
  };
  await first.route('**/api/phone/walrus', handle); await second.route('**/api/phone/walrus', handle);
  const page = await first.newPage(); await page.goto('/?walrus=mainnet-demo');
  await page.getByLabel('Nickname').fill('Fictional'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Set up recovery' })).toBeVisible();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Generate key' }).click();
  const key = await page.getByLabel('Recovery key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible(); expect(writes).toBe(1);
  await page.evaluate(() => localStorage.removeItem('coinjar.phone.recovery.key.v1.demo.automatic'));
  await page.reload(); await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible(); expect(writes).toBe(1);
  await page.getByRole('button', { name: 'Home' }).click(); await expect(page.getByRole('button', { name: 'Journal backed up' })).toHaveCount(0); await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount in PHP').fill('50'); await page.getByLabel('Note (optional)').fill('Private fictional lunch'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => writes).toBe(2); expect(JSON.stringify(envelope)).not.toContain('Private fictional lunch');
  await first.setOffline(true); await page.getByRole('button', { name: 'Add expense' }).click(); await page.getByLabel('Amount in PHP').fill('10'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByText('Backup not confirmed.', { exact: false })).toBeVisible(); expect(writes).toBe(2);
  await first.setOffline(false); await expect.poll(() => writes).toBe(3); await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible();
  const other = await second.newPage(); await other.goto('/?walrus=mainnet-demo');
  await other.getByLabel('Nickname').fill('Other'); await other.getByLabel('Currency').selectOption('PHP'); await other.getByLabel('Current balance').fill('10'); await other.getByRole('button', { name: 'Continue', exact: true }).click();
  await other.getByRole('button', { name: 'Profile' }).click(); await other.getByLabel('Recovery key', { exact: true }).fill(key); await other.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(other.getByText('Automatic backup paused:', { exact: false })).toBeVisible(); expect(writes).toBe(3);
  const dismissed = other.waitForEvent('dialog').then(dialog => dialog.dismiss()); await other.getByRole('button', { name: 'Use this journal for backups' }).click(); await dismissed; await expect(other.getByText('Automatic backup paused:', { exact: false })).toBeVisible(); expect(writes).toBe(3);
  const accepted = other.waitForEvent('dialog').then(dialog => dialog.accept()); await other.getByRole('button', { name: 'Use this journal for backups' }).click(); await accepted; await expect.poll(() => writes).toBe(4); await expect(other.getByText('Journal backed up to Walrus.')).toBeVisible();
  await first.close(); await second.close();
});

test('automatic recovery checks an uncertain write before retrying', async ({ page }) => {
  let envelope: unknown, writes = 0;
  await page.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'backupSave') { envelope = body.envelope; writes++; await route.fulfill({ status: 502, json: { error: 'Outcome unknown.' } }); }
    else if (envelope) await route.fulfill({ json: { envelope } });
    else await route.fulfill({ status: 404, json: { error: 'No recovery backup found.' } });
  });
  await page.goto('/?walrus=mainnet-demo'); await page.getByLabel('Nickname').fill('Fictional'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Generate key' }).click(); await page.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(page.getByText('Backup not confirmed.', { exact: false })).toBeVisible(); expect(writes).toBe(1);
  await page.getByRole('button', { name: 'Retry backup' }).click(); await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible(); expect(writes).toBe(1);
});

test('encrypted journal recovery restores activity in a separate browser without sending the key', async ({ browser }) => {
  const first = await browser.newContext(), second = await browser.newContext();
  let record: { token: string; envelope: unknown } | undefined;
  const handle = async (route: import('@playwright/test').Route) => {
    const body = route.request().postDataJSON(), token = route.request().headers().authorization;
    if (body.action === 'backupSave') { record = { token, envelope: body.envelope }; await route.fulfill({ json: { saved: true } }); }
    else if (body.action === 'backupRestore' && record?.token === token) await route.fulfill({ json: { envelope: record.envelope } });
    else await route.fulfill({ status: 404, json: { error: 'No recovery backup found.' } });
  };
  await first.route('**/api/phone/walrus', handle); await second.route('**/api/phone/walrus', handle);
  const page = await first.newPage(); await page.goto('/?walrus=mainnet-demo');
  await page.getByLabel('Nickname').fill('Fictional'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Add expense' }).click(); await page.getByLabel('Amount in PHP').fill('50'); await page.getByLabel('Note (optional)').fill('Fictional lunch'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Generate key' }).click();
  const key = await page.getByLabel('Recovery key', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'I saved my recovery key' }).click();
  await expect(page.getByText('Journal backed up to Walrus.')).toBeVisible();
  expect(record?.token).not.toContain(key); expect(JSON.stringify(record?.envelope)).not.toContain('Fictional lunch');
  const other = await second.newPage(); await other.goto('/?walrus=mainnet-demo');
  await other.getByLabel('Nickname').fill('Other'); await other.getByLabel('Currency').selectOption('PHP'); await other.getByLabel('Current balance').fill('10'); await other.getByRole('button', { name: 'Continue', exact: true }).click();
  await other.getByRole('button', { name: 'Profile' }).click(); await other.getByLabel('Recovery key', { exact: true }).fill('A'.repeat(43));
  await other.getByRole('button', { name: 'Restore journal' }).click();
  await expect(other.getByText('Could not restore the backup.', { exact: false })).toBeVisible();
  await other.getByRole('button', { name: 'Home' }).click(); await expect(other.locator('.simple-amount')).toHaveText('₱10.00');
  await other.getByRole('button', { name: 'Profile' }).click(); await other.getByLabel('Recovery key', { exact: true }).fill(key);
  other.once('dialog', dialog => void dialog.accept()); await other.getByRole('button', { name: 'Restore journal' }).click();
  await expect(other.getByText('Journal restored on this device.', { exact: false })).toBeVisible(); await other.getByRole('button', { name: 'Home' }).click();
  await expect(other.locator('.simple-amount')).toHaveText('₱950.00'); await other.getByRole('button', { name: 'Activity' }).click(); await expect(other.getByText('Fictional lunch')).toBeVisible();
  await first.close(); await second.close();
});

test('generated memory code recovers preferences without overwriting them on a second device', async ({ page, browser }) => {
  const records = new Map<string, string>(); let writes = 0;
  const handle = async (route: import('@playwright/test').Route) => {
    const code = route.request().headers().authorization;
    const body = route.request().postDataJSON();
    expect(route.request().headers()['x-coinjar-memory-user']).toBe('1');
    if (body.action === 'remember') { writes++; records.set(code, body.memory); await route.fulfill({ json: { saved: true, memoryId: 'id', blobId: 'blob' } }); }
    else await route.fulfill({ json: { memories: records.has(code) ? [records.get(code)] : [] } });
  };
  await page.route('**/api/phone/walrus', handle);
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('1000');
  await page.getByLabel('Automatically save preferences').check();
  const code = await page.getByLabel('Memory access code').inputValue();
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByLabel('I saved my memory code').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  const second = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    await second.route('**/api/phone/walrus', handle);
    const other = await second.newPage(); await other.goto('/');
    await other.getByLabel('Nickname').fill('Ari');
    await other.getByLabel('Currency').selectOption('PHP');
    await other.getByLabel('Current balance').fill('500');
    await other.getByLabel('Automatically save preferences').check();
    await other.getByRole('button', { name: 'Use an existing code' }).click();
    await other.getByLabel('Memory access code').fill(code);
    await other.getByLabel('I saved my memory code').check();
    await other.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(other.getByText('Review your saved preferences in Profile before syncing.')).toBeVisible();
    expect(writes).toBe(1);
    await other.getByRole('button', { name: 'Profile' }).click();
    other.once('dialog', dialog => void dialog.accept());
    await other.getByRole('button', { name: 'Find preferences' }).click();
    other.once('dialog', dialog => void dialog.accept());
    await other.getByRole('button', { name: 'Review memory 1' }).click();
    await expect(other.getByText('Saved preferences applied on this device.')).toBeVisible();
    await expect.poll(() => writes).toBe(2);
  } finally { await second.close(); }
});

test('demo tools are hidden and the normal journal remains untouched', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('coinjar.phone.journal.v1', 'original journal untouched'));
  await page.goto('/?walrus=mainnet-demo');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('1000');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Mainnet demo memories')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save and verify demo memories' })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('coinjar.phone.journal.v1'))).toBe('original journal untouched');
});

test('mainnet demo applies a recalled fictional spending pattern with a mock provider', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-09T12:00:00Z'));
  const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'recent-spending-spike', recentDays: 3, previousDays: 3, observedThrough: '2026-11-09' });
  const journal = { version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2026-11-01', bufferCents: 0, dailyLimitCents: 10000, entries: [], adjustments: [], goal: { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-11-19', phoneStartDate: '2026-01-01', phoneBaselineCents: 10000, status: 'active', createdAt: '' } };
  await page.addInitScript(j => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)), journal);
  await page.route('**/api/phone/walrus', async route => {
    expect(route.request().headers()['x-coinjar-memory-network']).toBe('mainnet');
    const body = route.request().postDataJSON();
    await route.fulfill(body.action === 'recallHabit' ? { json: { memories: [memory] } } : { json: { saved: true, memoryId: 'mock-id', blobId: 'mock-blob' } });
  });
  await page.goto('/?walrus=mainnet-demo');
  const section = page.locator('.phone-hero');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').check();
  if (await page.getByLabel('I saved my memory code').count()) await page.getByLabel('I saved my memory code').check();
  await page.getByLabel('Remember spending patterns').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers a recent spending increase', { exact: false })).toHaveCount(1);
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
});

test('wallet uses the saved personal memory code automatically', async ({ page }) => {
  const address = '0x' + '1'.repeat(64); let token = '';
  await page.route('**/api/phone/walrus', async route => await route.fulfill({ json: { saved: true, memoryId: 'mock', blobId: 'mock' } }));
  await page.route('**/api/phone/wallet-balance', async route => { token = route.request().headers().authorization; expect(route.request().headers()['x-coinjar-memory-user']).toBe('1'); await route.fulfill({ json: { network: 'mainnet', balanceMist: '1230000000', checkedAt: '2026-11-09T04:00:00Z' } }); });
  await page.goto('/'); await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000');
  await page.getByLabel('Automatically save preferences').check(); const code = await page.getByLabel('Memory access code').inputValue(); await page.getByLabel('I saved my memory code').check(); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Goal'); await page.getByLabel('Goal target in PHP').fill('500'); const date = page.getByLabel('Target date', { exact: true }); await date.fill((await date.getAttribute('min'))!); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByLabel('CoinJar access code')).toHaveCount(0);
  await page.getByLabel('Sui public address').fill(address); await page.getByRole('button', { name: 'Link wallet', exact: true }).click(); await expect(page.getByRole('button', { name: 'Check balance' })).toHaveCount(0); await page.getByRole('button', { name: 'Home' }).click(); await page.getByRole('button', { name: 'Check balance' }).click();
  await expect(page.getByText('1.23 SUI', { exact: false })).toBeVisible(); expect(token).toBe(`Bearer ${code}`);
});

test('transaction lookup shows wallet net changes without crediting a goal', async ({ page }) => {
  const address = '0x' + '1'.repeat(64), digest = 'A'.repeat(44);
  await page.route('**/api/phone/wallet-balance', async route => {
    expect(route.request().postDataJSON()).toEqual({ address, digest });
    await route.fulfill({ json: { network: 'mainnet', digest, address, status: 'success', checkpoint: '123', changes: [{ coinType: '0x2::sui::SUI', amount: '1500000000' }] } });
  });
  await page.goto('/'); await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Emergency'); await page.getByLabel('Goal target in PHP').fill('500'); const date = page.getByLabel('Target date', { exact: true }); await date.fill((await date.getAttribute('min'))!); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByLabel('Sui public address').fill(address); await page.getByRole('button', { name: 'Link wallet', exact: true }).click(); await page.getByRole('button', { name: 'Home' }).click();
  await page.getByLabel('CoinJar access code').fill('a'.repeat(43)); await page.getByText('Check a transaction').click(); await page.getByLabel('Transaction digest').fill(digest); await page.getByRole('button', { name: 'Check transaction' }).click();
  await expect(page.getByText('Status: Successful', { exact: false })).toBeVisible(); await expect(page.getByText('+1.5 SUI')).toBeVisible();
  await expect(page.getByText('₱0.00 saved of ₱500.00 · 0%')).toBeVisible(); await expect(page.locator('.simple-amount')).toHaveText('₱1,000.00');
});

test('goal wallet tracks successful checks without changing savings', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const first = '0x' + '1'.repeat(64), second = '0x' + '2'.repeat(64);
  let count = 0;
  await page.route('**/api/phone/wallet-balance', async route => {
    count++;
    if (count === 4) return route.fulfill({ status: 502, json: { error: 'unavailable' } });
    const balanceMist = ['12500000000', '14500000000', '13000000000', '', '9000000000'][count - 1];
    await route.fulfill({ json: { network: 'mainnet', balanceMist, checkedAt: `2026-11-09T04:0${count}:00Z` } });
  });
  await page.goto('/'); await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Emergency'); await page.getByLabel('Goal target in PHP').fill('500'); const date = page.getByLabel('Target date', { exact: true }); await date.fill((await date.getAttribute('min'))!); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByLabel('Sui public address').fill(first); await page.getByRole('button', { name: 'Link wallet', exact: true }).click(); await page.getByRole('button', { name: 'Home' }).click();
  const wallet = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Savings wallet' }) });
  await wallet.getByLabel('CoinJar access code').fill('a'.repeat(43)); await wallet.getByRole('button', { name: 'Check balance' }).click();
  await expect(wallet.getByText('12.5 SUI', { exact: false })).toBeVisible(); await expect(page.getByText('₱0.00 saved of ₱500.00 · 0%')).toBeVisible();
  await wallet.getByRole('button', { name: 'Check balance' }).click(); await expect(wallet.getByText('Increased by 2 SUI', { exact: false })).toBeVisible();
  await wallet.getByRole('button', { name: 'Check balance' }).click(); await expect(wallet.getByText('Decreased by 1.5 SUI', { exact: false })).toBeVisible();
  await wallet.getByRole('button', { name: 'Check balance' }).click(); await expect(wallet.getByText('Wallet balance is unavailable.', { exact: false })).toBeVisible(); await expect(wallet.getByText('13 SUI', { exact: false })).toBeVisible();
  await page.reload(); await expect(wallet.getByText('Decreased by 1.5 SUI', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Edit goal' }).click(); await page.getByLabel('Goal name').fill('Emergency fund'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Profile' }).click(); await expect(page.getByLabel('Sui public address')).toHaveValue(first);
  await page.getByLabel('Sui public address').fill(second); await page.getByRole('button', { name: 'Update linked wallet' }).click(); await page.getByRole('button', { name: 'Home' }).click(); await wallet.getByLabel('CoinJar access code').fill('a'.repeat(43)); await wallet.getByRole('button', { name: 'Check balance' }).click(); await expect(wallet.getByText('9 SUI', { exact: false })).toBeVisible(); await expect(wallet.getByText('since the previous check', { exact: false })).toHaveCount(0);
  await expect(page.getByText('₱0.00 saved of ₱500.00 · 0%')).toBeVisible(); await expect(page.locator('.simple-amount')).toHaveText('₱1,000.00');
});

test('read-only Sui balance stays separate from the phone journal', async ({ page }) => {
  const address = '0x' + '1'.repeat(64);
  let calls = 0;
  await page.route('**/api/phone/wallet-balance', async route => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({ address });
    await route.fulfill({ json: { network: 'mainnet', balanceMist: '1234567890', checkedAt: '2026-11-09T04:00:00Z' } });
  });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('1000');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Goal'); await page.getByLabel('Goal target in PHP').fill('500'); const date = page.getByLabel('Target date', { exact: true }); await date.fill((await date.getAttribute('min'))!); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByLabel('Sui public address').fill(address);
  await page.getByRole('button', { name: 'Link wallet', exact: true }).click(); await page.getByRole('button', { name: 'Home' }).click(); await page.getByLabel('CoinJar access code').fill('a'.repeat(43));
  await page.getByRole('button', { name: 'Check balance' }).click();
  await expect(page.getByText('1.23456789 SUI', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.locator('.simple-amount')).toHaveText('₱1,000.00');
  expect(calls).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByLabel('Sui public address')).toHaveValue(address);
  await expect(page.getByRole('button', { name: 'Check balance' })).toHaveCount(0);
});

test('phone journal saves its loop locally and restores only a valid confirmed backup', async ({ page, context, browser }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
  await page.goto('/');
  await expect(page.getByTestId('backup-controls')).toBeHidden();
  await expect(page.getByText('Continue with Google')).toHaveCount(0);
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('1000');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click();
  await page.getByLabel('Goal name').fill('Emergency');
  await page.getByLabel('Goal target in PHP').fill('500');
  await page.getByLabel('Target date', { exact: true }).fill((await page.getByLabel('Target date', { exact: true }).getAttribute('min'))!);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Add income' }).click();
  await page.getByLabel('Amount in PHP').fill('100');
  await page.getByLabel('Note (optional)').fill('Pay');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount in PHP').fill('50');
  await page.getByLabel('Note (optional)').fill('Lunch');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('₱1,050.00');
  await expect(page.getByText('Daily savings suggestion')).toBeVisible();
  await page.getByRole('button', { name: 'Add savings' }).click();
  await page.getByLabel('Amount in PHP').fill('10');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Record manually' }).click();
  await expect(page.getByText('₱10.00 saved of ₱500.00 · 2%')).toBeVisible();
  await page.reload();
  await expect(page.locator('.simple-amount')).toHaveText('₱1,040.00');
  await expect(page.getByText('Hi, Ari')).toBeVisible();
  await expect(page.getByTestId('backup-controls')).toBeHidden();
  await page.getByTestId('backup-controls').evaluate(element => element.removeAttribute('hidden'));
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise;
  const backup = await download.path();
  expect(backup).toBeTruthy();
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByLabel('Amount in PHP').fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.simple-amount')).toHaveText('₱1,035.00');
  await page.getByLabel('Restore backup').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await expect(page.getByRole('alert')).toContainText('not changed');
  await expect(page.locator('.simple-amount')).toHaveText('₱1,035.00');
  page.once('dialog', dialog => void dialog.dismiss());
  await page.getByLabel('Restore backup').setInputFiles(backup!);
  await expect(page.locator('.simple-amount')).toHaveText('₱1,035.00');
  page.once('dialog', dialog => void dialog.accept());
  await page.getByLabel('Restore backup').setInputFiles(backup!);
  await expect(page.locator('.simple-amount')).toHaveText('₱1,040.00');
  await page.getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByText('Lunch')).toBeVisible();
  await page.getByRole('button', { name: 'Home' }).click();
  await page.reload();
  await expect(page.getByText('₱10.00 saved of ₱500.00 · 2%')).toBeVisible();
  expect(requests).toEqual([]);
  const fresh = await context.newPage();
  await fresh.goto('/');
  await expect(fresh.locator('.simple-amount')).toHaveText('₱1,040.00');
  await fresh.close();
  const otherDevice = await browser.newContext({ viewport: { width: 412, height: 915 }, baseURL: new URL(page.url()).origin });
  try {
    const restoredPage = await otherDevice.newPage();
    await restoredPage.goto('/');
    await expect(restoredPage.getByLabel('Currency')).toBeVisible();
    await expect(restoredPage.getByTestId('backup-controls')).toBeHidden();
    await restoredPage.getByTestId('backup-controls').evaluate(element => element.removeAttribute('hidden'));
    await restoredPage.getByLabel('Restore backup').setInputFiles(backup!);
    await expect(restoredPage.locator('.simple-amount')).toHaveText('₱1,040.00');
    await expect(restoredPage.getByText('Hi, Ari')).toBeVisible();
    await expect(restoredPage.getByText('₱10.00 saved of ₱500.00 · 2%')).toBeVisible();
  } finally { await otherDevice.close(); }
});

test('a damaged local journal is not silently replaced', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('coinjar.phone.demo.journal.v1', '{broken'));
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('Could not read');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('10');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('another tab');
  expect(await page.evaluate(() => localStorage.getItem('coinjar.phone.demo.journal.v1'))).toBe('{broken');
});

test('goal coach reserves estimated spending only when needed', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-27T12:00:00Z'));
  const dates = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-07', '2026-01-14', '2026-01-21'];
  const journal = { version: 1, currency: 'PHP', openingCents: 123000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, entries: dates.map((date, i) => ({ id: `e${i}`, kind: 'expense', amountCents: [10000, 20000, 30000, 1000, 1000, 1000][i], date, note: '', createdAt: '' })), adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 500000, targetDate: '2026-02-05', status: 'active', createdAt: '' } };
  await page.addInitScript(j => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)), journal); await page.goto('/');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Daily savings suggestion' }) });
  await expect(section.locator('.phone-today-value')).toHaveText('Save ₱400.00 today!');
  await page.getByRole('button', { name: 'How is this calculated?' }).click();
  await expect(page.getByRole('dialog')).toContainText('They can change when you add an entry');
  await expect(page.getByRole('dialog').getByText('short of the remaining goal', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Add income' }).click(); await page.getByLabel('Amount in PHP').fill('300'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.locator('.phone-today-value')).toHaveText('Save ₱500.00 today!');
});

test('new goals require a target date', async ({ page }) => {
  await page.goto('/?walrus=mainnet-demo');
  await page.getByLabel('Nickname').fill('Demo'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Goal'); await page.getByLabel('Goal target in PHP').fill('5000');
  const date = page.getByLabel('Target date', { exact: true }); await expect(date).toHaveAttribute('required', '');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create goal' })).toBeVisible();
  await expect(date).toBeVisible();
});

test('goal coach recalculates after different daily savings', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-01T12:00:00Z'));
  await page.goto('/'); await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('10000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Create goal' }).click(); await page.getByLabel('Goal name').fill('Goal'); await page.getByLabel('Goal target in PHP').fill('5000'); await page.getByLabel('Target date', { exact: true }).fill('2026-01-10'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Daily savings suggestion' }) });
  await expect(section.locator('.phone-today-value')).toHaveText('Save ₱500.00 today!');
  await page.getByRole('button', { name: 'Add savings' }).click(); await page.getByLabel('Amount in PHP').fill('300'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Record manually' }).click();
  await expect(section.getByText('Total saved')).toHaveCount(0); await expect(section.locator('.phone-today-value')).toHaveText('You saved ₱300.00 today!'); await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱522.23.');
  await page.clock.setFixedTime(new Date('2026-01-02T12:00:00Z')); await page.reload(); await page.getByRole('button', { name: 'Add savings' }).click(); await page.getByLabel('Amount in PHP').fill('500'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Record manually' }).click();
  await page.clock.setFixedTime(new Date('2026-01-03T12:00:00Z')); await page.reload(); await page.getByRole('button', { name: 'Add savings' }).click(); await page.getByLabel('Amount in PHP').fill('200'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Record manually' }).click();
  await expect(section.locator('.phone-today-value')).toHaveText('You saved ₱200.00 today!'); await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱571.43.');
  await page.reload(); await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱571.43.');
  await page.getByRole('button', { name: 'Profile' }).click(); await page.getByRole('button', { name: 'Savings settings' }).click();
  await expect(page.getByLabel('Minimum cash buffer')).toHaveCount(0); await expect(page.getByLabel('Daily savings limit')).toHaveCount(0);
});

test('today and tomorrow stay distinct and learning appears once', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  await page.addInitScript(() => {
    localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 1500, entries: [{ id: 'c', kind: 'contribution', amountCents: 5000, date: '2026-01-09', note: '', createdAt: '2026-01-09T12:00:00Z' }], adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 100000, targetDate: '2026-01-10', phoneStartDate: '2026-01-01', phoneBaselineCents: 1500, status: 'active', createdAt: '' } }));
    localStorage.setItem('coinjar.phone.walrus.auto.v1.mainnet-demo', JSON.stringify({ enabled: true, habits: true, recentHabits: true, code: 'g'.repeat(43) }));
  });
  await page.route('**/api/phone/walrus', async route => await route.fulfill({ json: route.request().postDataJSON().action === 'recallHabit' ? { memories: [] } : { saved: true } }));
  await page.goto('/');
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Daily savings suggestion' }) });
  await expect(section.getByText('Total saved')).toHaveCount(0);
  await expect(section.locator('.phone-today-value')).toHaveText('You saved ₱50.00 today!');
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱950.00.');
  await expect(page.getByText('Still learning: more recorded expenses are needed.')).toHaveCount(0);
});

test('saved today message stays on one line within the card on phones', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 1, currency: 'PHP', openingCents: 1000000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, entries: [{ id: 'c', kind: 'contribution', amountCents: 120000, date: '2026-01-09', note: '', createdAt: '' }], adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 5000000, targetDate: '2026-12-31', status: 'active', createdAt: '' } })));
  await page.goto('/');
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 915 });
    const saved = page.locator('.phone-saved-today');
    await expect(saved).toHaveText('You saved ₱1,200.00 today!');
    const dimensions = await saved.evaluate(element => ({ width: element.clientWidth, textWidth: element.scrollWidth, height: element.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(element).lineHeight) }));
    expect(dimensions.textWidth).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.lineHeight + 1);
  }
});

test('multiple goals preserve existing savings and keep contributions separate', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  await page.addInitScript(() => localStorage.getItem('coinjar.phone.demo.journal.v1') || localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 1, currency: 'PHP', openingCents: 1000000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 0, entries: [{ id: 'c', kind: 'contribution', amountCents: 120000, date: '2026-01-09', note: '', createdAt: '' }], adjustments: [], goal: { id: 'g', title: 'Emergency', targetCents: 500000, targetDate: '2026-01-19', status: 'active', createdAt: '' } })));
  await page.goto('/'); await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByText('₱1,200.00 saved of ₱5,000.00', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Create goal', exact: true }).click();
  await page.getByLabel('Goal name').fill('Trip'); await page.getByLabel('Goal target in PHP').fill('3000'); await page.getByLabel('Target date', { exact: true }).fill('2026-01-19'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  const trip = page.locator('.phone-goal-item').filter({ has: page.getByRole('heading', { name: 'Trip', exact: true }) });
  await expect(trip).toContainText('₱0.00 saved');
  await trip.getByRole('button', { name: 'Save for this goal' }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.phone-goal')).toContainText('Trip');
  await expect(page.locator('.simple-amount')).toHaveText('₱8,800.00');
  await expect(page.locator('.phone-today-value')).toContainText('Save ');
  await page.getByRole('button', { name: 'Add savings' }).click(); await page.getByLabel('Amount in PHP').fill('300'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await page.getByRole('button', { name: 'Record manually' }).click();
  await expect(page.locator('.phone-goal')).toContainText('₱300.00 saved of ₱3,000.00');
  await page.reload(); await expect(page.locator('.phone-goal')).toContainText('₱300.00 saved of ₱3,000.00');
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  const emergency = page.locator('.phone-goal-item').filter({ has: page.getByRole('heading', { name: 'Emergency', exact: true }) });
  await expect(emergency).toContainText('₱1,200.00 saved of ₱5,000.00');
  await emergency.getByRole('button', { name: 'Save for this goal' }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.phone-goal')).toContainText('₱1,200.00 saved of ₱5,000.00');
  await expect(page.locator('.simple-amount')).toHaveText('₱8,500.00');
});

test('first goal created in Goals appears on Home', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  await page.goto('/'); await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Goals', exact: true }).click();
  await expect(page.getByText('Create your first savings goal.')).toBeVisible();
  await page.getByRole('button', { name: 'Create goal', exact: true }).click();
  await page.getByLabel('Goal name').fill('First goal'); await page.getByLabel('Goal target in PHP').fill('500'); await page.getByLabel('Target date', { exact: true }).fill('2026-01-19'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.phone-goal-item')).toContainText('First goal');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.phone-goal')).toContainText('First goal');
});

test('savings day resets at local midnight while the app remains open', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:' + (process.env.PORT ?? '4371'), timezoneId: 'Asia/Manila' });
  try {
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-11-09T15:59:59Z') });
    await page.addInitScript(() => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify({ version: 1, currency: 'PHP', openingCents: 1000000, openingDate: '2026-11-01', bufferCents: 0, dailyLimitCents: 0, entries: [{ id: 'c', kind: 'contribution', amountCents: 120000, date: '2026-11-09', note: '', createdAt: '2026-11-09T12:00:00Z' }], adjustments: [], goal: { id: 'g', title: 'Goal', targetCents: 500000, targetDate: '2026-11-20', status: 'active', createdAt: '' } })));
    await page.goto('/');
    await expect(page.locator('.phone-today-value')).toHaveText('You saved ₱1,200.00 today!');
    await page.clock.runFor(2000);
    await expect(page.locator('.phone-today-value')).toContainText('Save ');
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Yesterday', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await page.reload();
    await expect(page.locator('.phone-today-value')).toContainText('Save ');
  } finally { await context.close(); }
});

test('optional 8 PM reminder appears only in the open app and can be dismissed', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:' + (process.env.PORT ?? '4371'), timezoneId: 'Asia/Manila' });
  try {
    const page = await context.newPage(); await page.clock.install({ time: new Date('2026-11-10T11:59:59Z') });
    await page.goto('/'); await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('100'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Profile', exact: true }).click(); await page.getByLabel('Remind me at 8 PM').check();
    await expect(page.getByText('No notification is sent when the app is closed.', { exact: false })).toBeVisible();
    await expect(page.getByText('It’s time to review today’s savings.')).toHaveCount(0);
    await page.clock.runFor(2000); await expect(page.getByText('It’s time to review today’s savings.')).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click(); await page.reload();
    await expect(page.getByText('It’s time to review today’s savings.')).toHaveCount(0);
  } finally { await context.close(); }
});

test('savings settings opens in view on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('100');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await expect(page.getByRole('heading', { name: 'Savings settings' })).toBeVisible();
  await expect.poll(() => page.getByRole('heading', { name: 'Savings settings' }).evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
});

test('restore preferences requests a code only when needed and asks for consent', async ({ page }) => {
  let recalls = 0;
  const memory = 'COINJAR_PHONE_PREFERENCES_V2 ' + JSON.stringify({ currency: 'PHP', origin: 'manual' });
  await page.route('**/api/phone/walrus', async route => {
    expect(route.request().headers()['x-coinjar-memory-user']).toBe('1');
    expect(route.request().postDataJSON().action).toBe('recall');
    recalls++;
    await route.fulfill({ json: { memories: [memory] } });
  });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari'); await page.getByLabel('Currency').selectOption('PHP'); await page.getByLabel('Current balance').fill('1000'); await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Add expense' }).click(); await page.getByLabel('Amount in PHP').fill('10'); await page.getByLabel('Note (optional)').fill('private lunch'); await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByRole('button', { name: 'Save preferences' })).toHaveCount(0);
  await expect(page.getByLabel('Memory code', { exact: true })).not.toBeVisible();
  await page.getByText('Restore preferences', { exact: true }).click();
  await page.getByLabel('Memory code', { exact: true }).fill('a'.repeat(43));
  page.once('dialog', dialog => void dialog.dismiss()); await page.getByRole('button', { name: 'Find preferences' }).click(); expect(recalls).toBe(0);
  page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Find preferences' }).click();
  await expect(page.getByRole('button', { name: 'Review memory 1' })).toBeVisible();
  page.once('dialog', dialog => void dialog.accept()); await page.getByRole('button', { name: 'Review memory 1' }).click();
  await expect(page.getByText('Saved preferences applied on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Home' }).click(); await expect(page.locator('.simple-amount')).toHaveText('₱990.00');
  await page.getByRole('button', { name: 'Activity' }).click(); await expect(page.getByText('private lunch')).toBeVisible();
});

test('automatic Walrus preferences opt in on onboarding and retry the same pending write after reload', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const writes: { memory: string; operationId: string }[] = [];
  await page.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    await route.fulfill(writes.length === 1 ? { status: 503, json: { error: 'unavailable' } } : { json: { saved: true } });
  });
  await page.goto('/');
  await expect(page.getByLabel('Automatically save preferences')).not.toBeChecked();
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('1000');
  await page.getByLabel('Automatically save preferences').check();
  await expect(page.getByLabel('Memory access code')).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  await page.getByLabel('I saved my memory code').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Could not confirm Walrus sync.', { exact: false })).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0].memory).not.toContain('100000');
  await page.reload();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Preferences saved to Walrus mainnet.')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ operationId: writes[0].operationId, memory: writes[0].memory });
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await expect(page.getByLabel('Automatically save preferences')).toBeChecked();
  await expect(page.getByLabel('Minimum cash buffer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  expect(writes).toHaveLength(2);
  expect(writes[1].memory).not.toContain('bufferCents');
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await expect(page.getByLabel('Automatically save preferences')).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('coinjar.phone.walrus.auto.v1.mainnet-demo'))).toBeNull();
  expect(writes).toHaveLength(2);
});

test('automatic Walrus can be enabled later from savings settings', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  let writes = 0;
  await page.route('**/api/phone/walrus', async route => { writes++; await route.fulfill({ json: { saved: true } }); });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('USD');
  await page.getByLabel('Current balance').fill('100');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect(writes).toBe(0);
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').check();
  if (await page.getByLabel('I saved my memory code').count()) await page.getByLabel('I saved my memory code').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Preferences saved to Walrus mainnet.')).toBeVisible();
  expect(writes).toBe(1);
});

test('automatic Walrus waits offline and resumes when the browser reconnects', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  let writes = 0;
  await page.addInitScript(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); });
  await page.route('**/api/phone/walrus', async route => { writes++; await route.fulfill({ json: { saved: true } }); });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('100');
  await page.getByLabel('Automatically save preferences').check();
  await expect(page.getByLabel('Memory access code')).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  await page.getByLabel('I saved my memory code').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Offline. Preferences remain on this device', { exact: false })).toBeVisible();
  expect(writes).toBe(0);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }); window.dispatchEvent(new Event('online')); });
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Preferences saved to Walrus mainnet.')).toBeVisible();
  expect(writes).toBe(1);
});

test('turning automatic saving off also stops another open tab', async ({ page, context }) => {
  let writes = 0;
  await context.route('**/api/phone/walrus', async route => { writes++; await route.fulfill({ json: { saved: true } }); });
  await page.goto('/');
  await page.getByLabel('Nickname').fill('Ari');
  await page.getByLabel('Currency').selectOption('PHP');
  await page.getByLabel('Current balance').fill('100');
  await page.getByLabel('Automatically save preferences').check();
  await expect(page.getByLabel('Memory access code')).toHaveValue(/^[A-Za-z0-9_-]{43}$/);
  await page.getByLabel('I saved my memory code').check();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.getByText('Preferences saved to Walrus mainnet.')).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByRole('button', { name: 'Profile' }).click();
  await expect(second.getByText('Preferences saved to Walrus mainnet.')).toBeVisible();
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await second.getByRole('button', { name: 'Profile' }).click();
  await expect(second.getByText('Automatic Walrus saving is off.')).toBeVisible();
  await second.getByRole('button', { name: 'Profile' }).click();
  await second.getByRole('button', { name: 'Savings settings' }).click();
  await expect(second.getByLabel('Automatically save preferences')).not.toBeChecked();
  expect(writes).toBe(1);
  await second.close();
});

test('a separately approved recalled habit changes the next-day estimate and can be turned off', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'higher-day-spending', days: [6], sampleDays: [3], recordedDays: 7, observedThrough: '2026-01-08' });
  const journal = { version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 10000, entries: [], adjustments: [], goal: { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-01-19', phoneStartDate: '2026-01-01', phoneBaselineCents: 10000, status: 'active', createdAt: '' } };
  await page.addInitScript(j => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)), journal);
  let recalls = 0;
  await page.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'recallHabit') { recalls++; await route.fulfill({ json: { memories: [memory, memory.replace('"recordedDays":7', '"recordedDays":7,"note":"private"')] } }); }
    else await route.fulfill({ json: { saved: true } });
  });
  await page.goto('/');
  const section = page.locator('.phone-hero');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  expect(recalls).toBe(0);
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').check();
  if (await page.getByLabel('I saved my memory code').count()) await page.getByLabel('I saved my memory code').check();
  await expect(page.getByLabel('Remember spending patterns')).not.toBeChecked();
  await page.getByLabel('Remember spending patterns').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Using an approved spending pattern recalled from Walrus mainnet.')).toHaveCount(1);
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers your spending patterns across the week', { exact: false })).toHaveCount(1);
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Remember spending patterns').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers your spending patterns across the week', { exact: false })).toHaveCount(0);
});

test('automatic habit saving sends aggregate evidence only and recalls it', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  const dates = ['2025-12-20', '2025-12-27', '2026-01-03', '2025-12-21', '2025-12-28', '2026-01-04'];
  const journal = { version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2025-12-20', bufferCents: 0, dailyLimitCents: 10000, entries: dates.map((date, i) => ({ id: `e${i}`, kind: 'expense', amountCents: i < 3 ? 200 : 50, note: 'private coffee', date, createdAt: '' })), adjustments: [], goal: { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-12-31', phoneStartDate: '2026-01-01', phoneBaselineCents: 10000, status: 'active', createdAt: '' } };
  await page.addInitScript(j => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)), journal);
  let habit = '';
  await page.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'recallHabit') await route.fulfill({ json: { memories: habit ? [habit] : [] } });
    else { if (body.memory?.startsWith('COINJAR_PHONE_HABIT_V1 ')) habit = body.memory; await route.fulfill({ json: { saved: true } }); }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').check();
  if (await page.getByLabel('I saved my memory code').count()) await page.getByLabel('I saved my memory code').check();
  await page.getByLabel('Remember spending patterns').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Using an approved spending pattern recalled from Walrus mainnet.')).toHaveCount(1);
  expect(habit).toContain('"days":[6]');
  expect(habit).not.toContain('private coffee');
  expect(habit).not.toContain('"amountCents"');
});

test('unavailable Walrus habits leave tomorrow’s estimate based on local data', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-09T12:00:00Z'));
  const journal = { version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 10000, entries: [{ id: 'future', kind: 'expense', amountCents: 95000, note: '', date: '2026-01-10', createdAt: '' }], adjustments: [], goal: { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-01-19', phoneStartDate: '2026-01-01', phoneBaselineCents: 10000, status: 'active', createdAt: '' } };
  await page.addInitScript(j => { localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)); localStorage.setItem('coinjar.phone.walrus.auto.v1.mainnet-demo', JSON.stringify({ enabled: true, habits: true, code: 'g'.repeat(43) })); }, journal);
  await page.route('**/api/phone/walrus', async route => { const body = route.request().postDataJSON(); await route.fulfill(body.action === 'recallHabit' ? { status: 503, json: { error: 'unavailable' } } : { json: { saved: true } }); });
  await page.goto('/');
  await expect(page.getByText('Walrus habits unavailable.', { exact: false })).toHaveCount(1);
  const section = page.locator('.phone-hero');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers your spending patterns across the week', { exact: false })).toHaveCount(0);
});

test('recent-spending memories require separate consent and adjust tomorrow without stacking', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.clock.setFixedTime(new Date('2026-01-12T12:00:00Z'));
  const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'recent-spending-spike', recentDays: 3, previousDays: 4, observedThrough: '2026-01-11' });
  const journal = { version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 10000, entries: [], adjustments: [], goal: { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-01-22', phoneStartDate: '2026-01-01', phoneBaselineCents: 10000, status: 'active', createdAt: '' } };
  await page.addInitScript(j => localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j)), journal);
  let recalls = 0;
  await page.route('**/api/phone/walrus', async route => { const body = route.request().postDataJSON(); if (body.action === 'recallHabit') { recalls++; await route.fulfill({ json: { memories: [memory] } }); } else await route.fulfill({ json: { saved: true } }); });
  await page.goto('/');
  const section = page.locator('.phone-hero');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  expect(recalls).toBe(0);
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').check();
  if (await page.getByLabel('I saved my memory code').count()) await page.getByLabel('I saved my memory code').check();
  await expect(page.getByLabel('Remember spending patterns')).not.toBeChecked();
  await page.getByLabel('Remember spending patterns').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers a recent spending increase', { exact: false })).toHaveCount(1);
  await expect(section.locator('.phone-today-value')).toHaveText('Save ₱90.91 today!');
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Remember spending patterns').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(section.locator('.phone-tomorrow-amount')).toHaveText('Tomorrow, consider saving around ₱100.00.');
  await expect(section.locator('.phone-today-value')).toHaveText('Save ₱90.91 today!');
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers a recent spending increase', { exact: false })).toHaveCount(0);
});

test('recent-spending detection saves only aggregate evidence', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T12:00:00Z'));
  const dates = ['2026-01-13', '2026-01-14', '2026-01-15', '2026-01-06', '2026-01-07', '2026-01-08'];
  const journal = { version: 1, currency: 'PHP', openingCents: 100000, openingDate: '2026-01-01', bufferCents: 0, dailyLimitCents: 10000, entries: dates.map((date, i) => ({ id: `e${i}`, kind: 'expense', amountCents: i < 3 ? 2000 : 500, note: 'private lunch', date, createdAt: '' })), adjustments: [], goal: { id: 'g', title: 'Fictional goal', targetCents: 100000, targetDate: '2026-12-31', phoneStartDate: '2026-01-01', phoneBaselineCents: 10000, status: 'active', createdAt: '' } };
  await page.addInitScript((j) => {
    localStorage.setItem('coinjar.phone.demo.journal.v1', JSON.stringify(j));
    const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'recent-spending-spike', recentDays: 3, previousDays: 3, observedThrough: '2026-01-01' });
    localStorage.setItem('coinjar.phone.walrus.spike.pending.v1', JSON.stringify({ memory, operationId: '00000000-0000-4000-8000-000000000000' }));
  }, journal);
  let spike = '';
  await page.route('**/api/phone/walrus', async route => {
    const body = route.request().postDataJSON();
    if (body.action === 'recallHabit') await route.fulfill({ json: { memories: spike ? [spike] : [] } });
    else { if (body.memory?.includes('recent-spending-spike')) spike = body.memory; await route.fulfill({ json: { saved: true } }); }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Profile' }).click();
  await page.getByRole('button', { name: 'Savings settings' }).click();
  await page.getByLabel('Automatically save preferences').check();
  const personalPendingKey = 'coinjar.phone.walrus.spike.pending.v1.mainnet-demo.personal.' + createHash('sha256').update(await page.getByLabel('Walrus access code').inputValue()).digest('hex');
  await page.evaluate(key => {
    const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'recent-spending-spike', recentDays: 3, previousDays: 3, observedThrough: '2026-01-01' });
    localStorage.setItem(key, JSON.stringify({ memory, operationId: '00000000-0000-4000-8000-000000000001' }));
  }, personalPendingKey);
  if (await page.getByLabel('I saved my memory code').count()) await page.getByLabel('I saved my memory code').check();
  await page.getByLabel('Remember spending patterns').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Walrus remembers a recent spending increase', { exact: false })).toHaveCount(1);
  expect(spike).toContain('"recentDays":3');
  expect(spike).toContain('2026-01-15');
  expect(await page.evaluate(key => localStorage.getItem(key), personalPendingKey)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('coinjar.phone.walrus.spike.pending.v1'))).not.toBeNull();
  expect(spike).not.toContain('private lunch');
  expect(spike).not.toContain('"amountCents"');
});
