import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createApp } from '../server/app';
import { recommend } from '../src/domain';
import { getSummary, scheduleOccurrences } from '../src/domain';
import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { getZkLoginSignature, toZkLoginPublicIdentifier } from '@mysten/sui/zklogin';
import { USDC_TYPES } from '../src/usdc';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Memory = {
  remember(text: string): Promise<unknown>;
  search(query: string, limit?: number): Promise<unknown>;
};
const fx = {
  getRate: async () => ({
    value: '0.017',
    basePair: 'USD' as const,
    symbol: 'PHP' as const,
    timestamp: Date.parse('2026-10-30T12:00:00Z'),
    source: 'test',
  }),
};
async function fixture(memory?: Memory, configFile?: string, fxOverride = fx, balanceOverride?: { getBalance(address: string): Promise<unknown>; getTransaction?(digest: string): Promise<unknown> }, clock: () => Date = () => new Date('2026-10-30T12:00:00Z')) {
  const app = createApp({
    dbPath: ':memory:',
    now: clock,
    env: { COINJAR_MODE: 'demo' },
    memory,
    fx: fxOverride,
    configFile,
    balance: balanceOverride,
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('No server address');
  const base = `http://127.0.0.1:${address.port}`;
  const initial = await (await fetch(`${base}/api/state`)).json();
  let cookie = '';
  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coinjar-token': initial.csrfToken,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: response.status, body: await response.json() };
  }
  return { app, initial, post, base };
}
const goal = {
  title: 'Rainy day',
  targetCents: 10000,
  targetDate: '2026-12-01',
};

test('zkLogin verification checks the expected address and fails closed on provider errors', async () => {
  const issuer = 'https://accounts.google.com';
  const address = toZkLoginPublicIdentifier(1n, issuer, { legacyAddress: false }).toSuiAddress();
  const signature = getZkLoginSignature({
    inputs: { proofPoints: { a: [], b: [], c: [] }, issBase64Details: { value: Buffer.from(`"iss":"${issuer}",`).toString('base64url'), indexMod4: 0 }, headerBase64: '', addressSeed: '1' },
    maxEpoch: 1, userSignature: new Uint8Array([0]),
  });
  let result: boolean | 'unavailable' = true;
  const client = new SuiGraphQLClient({ network: 'mainnet', url: 'https://example.invalid/graphql', fetch: async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.variables.author, address);
    assert.equal(payload.variables.intentScope, 'PERSONAL_MESSAGE');
    if (result === 'unavailable') throw new Error('offline');
    return new Response(JSON.stringify({ data: { verifyZkLoginSignature: { success: result } } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  const app = createApp({ dbPath: ':memory:', env: {}, walletClient: client });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinjar-token': state.csrfToken }, body: JSON.stringify(body) });
    for (const [response, expected] of [[true, 200], [false, 403], ['unavailable', 503]] as const) {
      result = response;
      const challenge = await (await post('/api/simple/wallet/challenge', { address })).json();
      const verified = await post('/api/simple/wallet/verify', { id: challenge.id, signature });
      assert.equal(verified.status, expected);
      if (expected !== 200) assert.equal(verified.headers.get('set-cookie'), null);
    }
  } finally { await app.close(); }
});

test('balance correction preserves history, rejects stale updates and is idempotent', async () => {
  const f = await fixture();
  try {
    await f.post('/api/entries', { kind: 'income', amountCents: 10000, date: f.initial.today, operationId: 'income-1' });
    const request = { amountCents: 7500, expectedCents: 10000, operationId: 'balance-1' };
    const saved = await f.post('/api/balance/set', request);
    assert.equal(getSummary(saved.body.state, saved.body.today).availableCents, 7500);
    assert.equal(saved.body.state.entries.length, 1);
    assert.equal(saved.body.state.balanceAdjustments[0].deltaCents, -2500);
    assert.equal((await f.post('/api/balance/set', request)).status, 200);
    assert.equal((await f.post('/api/balance/set', { ...request, amountCents: 5000 })).status, 409);
    assert.equal((await f.post('/api/balance/set', { amountCents: 5000, expectedCents: 10000, operationId: 'balance-2' })).status, 409);
  } finally { await f.app.close(); }
});

test('onboarding verifies a one-time wallet signature and preserves recorded balance', async () => {
  const f = await fixture();
  try {
    const key = Ed25519Keypair.generate();
    const address = key.toSuiAddress();
    const challenge = await f.post('/api/simple/wallet/challenge', { address });
    const signed = await key.signPersonalMessage(new TextEncoder().encode(challenge.body.message));
    assert.equal((await f.post('/api/simple/wallet/verify', { id: challenge.body.id, signature: signed.signature })).status, 200);
    assert.equal((await f.post('/api/simple/wallet/verify', { id: challenge.body.id, signature: signed.signature })).status, 409);
    const setup = await f.post('/api/simple/onboarding', { name: 'Alex', monthlyIncomeCents: 300000, balanceCents: 50000, expectedCents: 0, payday: '15', summarySync: false, useWallet: true });
    assert.equal(setup.body.state.simpleProfile.walletAddress, address);
    assert.equal(getSummary(setup.body.state, setup.body.today).availableCents, 50000);
    assert.equal(setup.body.state.schedules[0].autoRecord, true);
    assert.equal((await f.post('/api/simple/onboarding', { name: 'Other', monthlyIncomeCents: 0, balanceCents: 0, expectedCents: 50000, summarySync: false })).status, 409);
  } finally { await f.app.close(); }
});

test('wallet-linked local journal locks without a valid wallet session', async () => {
  const app = createApp({ dbPath: ':memory:', env: {}, now: () => new Date('2026-10-30T12:00:00Z') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const state = await (await fetch(base + '/api/state')).json();
    const key = Ed25519Keypair.generate();
    const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinjar-token': state.csrfToken, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const challenge = await (await post('/api/simple/wallet/challenge', { address: key.toSuiAddress() })).json();
    const signed = await key.signPersonalMessage(new TextEncoder().encode(challenge.message));
    const verified = await post('/api/simple/wallet/verify', { id: challenge.id, signature: signed.signature });
    const cookie = verified.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await post('/api/simple/onboarding', { name: 'Alex', monthlyIncomeCents: 0, balanceCents: 1000, expectedCents: 0, summarySync: false, useWallet: true }, cookie)).status, 200);
    assert.equal((await fetch(base + '/api/state')).status, 401);
    assert.equal((await post('/api/entries', { kind: 'expense', amountCents: 1, date: state.today, operationId: 'blocked' })).status, 401);
    assert.equal((await fetch(base + '/api/state', { headers: { cookie } })).status, 200);
    const wrong = Ed25519Keypair.generate();
    const other = await (await post('/api/simple/wallet/challenge', { address: wrong.toSuiAddress() })).json();
    const otherSigned = await wrong.signPersonalMessage(new TextEncoder().encode(other.message));
    assert.equal((await post('/api/simple/wallet/verify', { id: other.id, signature: otherSigned.signature })).status, 403);
    await post('/api/simple/logout', {}, cookie);
    assert.equal((await fetch(base + '/api/state', { headers: { cookie } })).status, 401);
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('a preconfigured owner protects a fresh journal before onboarding', async () => {
  const owner = Ed25519Keypair.generate(), other = Ed25519Keypair.generate();
  const app = createApp({ dbPath: ':memory:', env: { COINJAR_OWNER_ADDRESS: owner.toSuiAddress() }, now: () => new Date('2026-10-30T12:00:00Z') });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + '/api/state')).status, 401);
    const session = await (await fetch(base + '/api/session')).json();
    assert.equal(session.hasProfile, false);
    const post = (path: string, body: unknown, cookie = '') => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinjar-token': session.csrfToken, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await post('/api/simple/onboarding', { name: 'Intruder', monthlyIncomeCents: 0, balanceCents: 0, expectedCents: 0, summarySync: false })).status, 401);
    const challenge = await (await post('/api/simple/wallet/challenge', { address: other.toSuiAddress() })).json();
    const wrong = await other.signPersonalMessage(new TextEncoder().encode(challenge.message));
    assert.equal((await post('/api/simple/wallet/verify', { id: challenge.id, signature: wrong.signature })).status, 403);
    const correct = await (await post('/api/simple/wallet/challenge', { address: owner.toSuiAddress() })).json();
    const signed = await owner.signPersonalMessage(new TextEncoder().encode(correct.message));
    const verified = await post('/api/simple/wallet/verify', { id: correct.id, signature: signed.signature });
    const cookie = verified.headers.get('set-cookie')!.split(';')[0];
    const unlocked = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
    assert.equal(unlocked.setupWalletVerified, true);
    assert.equal((await post('/api/simple/onboarding', { name: 'Owner', monthlyIncomeCents: 0, balanceCents: 0, expectedCents: 0, summarySync: false, useWallet: false }, cookie)).status, 403);
    assert.equal((await post('/api/simple/onboarding', { name: 'Owner', monthlyIncomeCents: 0, balanceCents: 0, expectedCents: 0, summarySync: false, useWallet: true }, cookie)).status, 200);
  } finally { app.server.closeAllConnections(); await app.close(); }
});

test('aggregate spending memory is uploaded automatically and can conservatively inform a fresh session', async () => {
  const stored: Array<{ blob_id: string; text: string }> = [];
  const memory = { remember: async (text: string) => { const item = { blob_id: `memory-${stored.length}`, text }; stored.push(item); return item; }, search: async () => ({ results: stored }) };
  const first = await fixture(memory);
  try {
    const s = first.initial.state;
    s.openingCashCents = 1000000;
    s.autoSavings = { dailyCents: 20000, bufferCents: 0, startDate: '2026-10-31' };
    s.summarySync = { enabled: true };
    s.simpleProfile = { name: 'Private', monthlyIncomeCents: 300000 };
    s.entries = ['2026-10-24', '2026-10-27', '2026-10-30'].map((date, i) => ({ id: String(i), kind: 'expense', amountCents: i === 2 ? 15000 : 10000, note: 'private transaction', date, createdAt: date }));
    first.app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(s));
    await fetch(first.base + '/api/state');
  } finally { await first.app.close(); }
  const pattern = stored.find((item) => item.text.startsWith('COINJAR_SPENDING_PATTERN_V1 '));
  assert.ok(pattern);
  assert.ok(!pattern.text.includes('private transaction'));
  assert.ok(!pattern.text.includes('Private'));
  const second = await fixture(memory);
  try {
    const s = second.initial.state;
    s.openingCashCents = 1000000;
    s.autoSavings = { dailyCents: 20000, bufferCents: 0, startDate: '2026-10-31' };
    s.summarySync = { enabled: true };
    second.app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(s));
    const restored = await (await fetch(second.base + '/api/state')).json();
    assert.equal(restored.state.learnedBudget.dailyCents, 5000);
    assert.equal((await import('../src/domain')).simpleSavingsAdvice(restored.state, restored.today).amountCents, 5000);
  } finally { await second.app.close(); }
});

test('weekend decisions are remembered automatically but change savings only after approval', async () => {
  let time = new Date('2026-10-30T04:00:00Z');
  const stored: Array<{ blob_id: string; text: string }> = [];
  const memory = { remember: async (text: string) => { const item = { blob_id: `memory-${stored.length}`, text }; stored.push(item); return item; }, search: async () => ({ results: stored }) };
  const first = await fixture(memory, undefined, fx, undefined, () => time);
  try {
    await first.post('/api/balance/set', { amountCents: 100000, expectedCents: 0, operationId: 'opening' });
    await first.post('/api/simple/settings', { dailyCents: 1000, bufferCents: 0, summarySync: true, consent: true });
    for (const date of ['2026-10-30', '2026-10-31', '2026-11-01']) {
      time = new Date(`${date}T04:00:00Z`);
      await fetch(first.base + '/api/state');
      const paused = await first.post('/api/simple/pause', { reason: 'weekend' });
      assert.equal(paused.status, 200);
    }
    const state = await (await fetch(first.base + '/api/state')).json();
    assert.equal(state.state.weekendSignal, true);
    assert.notEqual(state.state.rememberedWeekendSpending, true);
    assert.equal(getSummary(state.state, state.today).availableCents, 100000);
    assert.equal((await first.post('/api/simple/weekend', { enabled: true })).status, 200);
  } finally { await first.app.close(); }
  assert.ok(stored.some((item) => item.text.startsWith('COINJAR_WEEKEND_SIGNAL_V1 ')));
  assert.ok(stored.some((item) => item.text.startsWith('COINJAR_HABIT_V1 ')));
  const second = await fixture(memory, undefined, fx, undefined, () => time);
  try {
    const s = second.initial.state;
    s.openingCashCents = 100000;
    s.autoSavings = { dailyCents: 1000, bufferCents: 0, startDate: '2026-11-02' };
    s.summarySync = { enabled: true };
    second.app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(s));
    const restored = await (await fetch(second.base + '/api/state')).json();
    assert.equal(restored.state.rememberedWeekendSpending, true);
    assert.equal((await import('../src/domain')).simpleSavingsAdvice(restored.state, restored.today).amountCents, 750);
    await second.post('/api/simple/weekend', { enabled: false });
    const after = await (await fetch(second.base + '/api/state')).json();
    assert.equal(after.state.rememberedWeekendSpending, false);
  } finally { await second.app.close(); }
});

test('scheduled income and automatic jar savings run once, and only summary totals sync', async () => {
  let time = new Date('2026-10-30T04:00:00Z');
  const uploaded: string[] = [];
  const memory = { remember: async (text: string) => { uploaded.push(text); return { blobId: `blob-${uploaded.length}` }; }, search: async () => [] };
  const f = await fixture(memory, undefined, fx, undefined, () => time);
  try {
    await f.post('/api/balance/set', { amountCents: 2000, expectedCents: 0, operationId: 'initial-balance' });
    const schedule = { kind: 'income', title: 'Private salary name', amountCents: 10000, days: [31], autoRecord: true, operationId: 'salary-schedule' };
    await f.post('/api/schedules', schedule);
    await f.post('/api/schedules', schedule);
    const configured = await f.post('/api/simple/settings', { dailyCents: 500, bufferCents: 1000, summarySync: true, consent: true });
    assert.equal(configured.body.state.schedules.length, 1);
    assert.equal(configured.body.state.autoMemorySync, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(uploaded.length, 1);
    assert.ok(uploaded[0].startsWith('COINJAR_DAILY_SUMMARY_V1 '));
    assert.ok(!uploaded[0].includes('Private salary name'));
    time = new Date('2026-10-31T04:00:00Z');
    const first = await (await fetch(f.base + '/api/state')).json();
    assert.equal(getSummary(first.state, first.today).availableCents, 11500);
    assert.equal(getSummary(first.state, first.today).savedCents, 500);
    const again = await (await fetch(f.base + '/api/state')).json();
    assert.equal(again.state.entries.filter((e: { autoSavingsDate?: string }) => e.autoSavingsDate === first.today).length, 1);
    assert.equal(again.state.entries.filter((e: { scheduleId?: string }) => e.scheduleId).length, 1);
    const moved = await f.post('/api/jar/withdraw', { amountCents: 200, operationId: 'withdraw-1' });
    assert.equal(getSummary(moved.body.state, moved.body.today).availableCents, 11700);
    assert.equal(getSummary(moved.body.state, moved.body.today).savedCents, 300);
    assert.equal((await f.post('/api/jar/withdraw', { amountCents: 400, operationId: 'withdraw-2' })).status, 409);
    time = new Date('2026-11-30T04:00:00Z');
    const later = await (await fetch(f.base + '/api/state')).json();
    assert.equal(later.state.entries.filter((e: { scheduleId?: string }) => e.scheduleId).length, 2);
    assert.equal(later.state.entries.filter((e: { autoSavingsDate?: string }) => e.autoSavingsDate).length, 2);
  } finally { await f.app.close(); }
});

test('voided automatic records stay void and an uncertain summary is not retried', async () => {
  let time = new Date('2026-10-30T04:00:00Z');
  let calls = 0;
  const f = await fixture({ remember: async () => { calls++; throw new Error('uncertain'); }, search: async () => [] }, undefined, fx, undefined, () => time);
  try {
    await f.post('/api/balance/set', { amountCents: 1000, expectedCents: 0, operationId: 'balance' });
    await f.post('/api/schedules', { kind: 'income', title: 'Salary', amountCents: 100, days: [31], autoRecord: true });
    await f.post('/api/simple/settings', { dailyCents: 500, bufferCents: 800, summarySync: true, consent: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    time = new Date('2026-10-31T04:00:00Z');
    const state = await (await fetch(f.base + '/api/state')).json();
    assert.equal(getSummary(state.state, state.today).savedCents, 300);
    const income = state.state.entries.find((e: { scheduleId?: string }) => e.scheduleId);
    const saving = state.state.entries.find((e: { autoSavingsDate?: string }) => e.autoSavingsDate);
    await f.post('/api/entries/void', { id: income.id, acknowledged: true });
    await f.post('/api/entries/void', { id: saving.id, acknowledged: true });
    const after = await (await fetch(f.base + '/api/state')).json();
    assert.equal(after.state.entries.filter((e: { scheduleId?: string }) => e.scheduleId).length, 1);
    assert.equal(after.state.entries.filter((e: { autoSavingsDate?: string }) => e.autoSavingsDate).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fetch(f.base + '/api/state');
    assert.equal(calls, 2);
  } finally { await f.app.close(); }
});

test('USD estimate reuses an hourly quote and reports unavailable refreshes', async () => {
  let time = Date.parse('2026-10-30T12:00:00Z');
  let calls = 0;
  let unavailable = false;
  const f = await fixture(undefined, undefined, { getRate: async () => {
    calls++;
    if (unavailable) throw new Error('offline');
    return { value: '0.015625', basePair: 'USD' as const, symbol: 'PHP' as const, timestamp: time, source: 'test' };
  } }, undefined, () => new Date(time));
  try {
    const first = await f.post('/api/fx/estimate', {});
    assert.equal(first.status, 200);
    assert.equal(first.body.rate.value, '0.015625');
    await f.post('/api/fx/estimate', {});
    assert.equal(calls, 1);
    time += 3600000;
    unavailable = true;
    assert.equal((await f.post('/api/fx/estimate', {})).status, 503);
    assert.equal(calls, 2);
  } finally { await f.app.close(); }
});

test('on-chain transfer is credited only after a matching checkpoint and cannot be reused', async () => {
  const sender = `0x${'a'.repeat(64)}`;
  const recipient = `0x${'b'.repeat(64)}`;
  const digest = '3'.repeat(44);
  let checkpoint: string | null = null;
  let received = '1000000';
  let chain = 'mainnet';
  let returnedSender = sender;
  let coinType = USDC_TYPES.mainnet as string;
  let transactionTime = Date.parse('2026-10-30T12:00:00Z');
  let marker = '';
  const quoteProvider = { ...fx, getSuiPhpRate: async () => ({ value: '123.45', basePair: 'PHP' as const, symbol: 'SUI' as const, timestamp: Date.parse('2026-10-30T12:00:00Z'), source: 'test' }) };
  const f = await fixture(undefined, undefined, quoteProvider, {
    getBalance: async () => ({ network: 'mainnet', coinType: '0x2::sui::SUI', balanceMist: '0' }),
    getTransaction: async () => ({ network: chain, digest, success: true, checkpoint, timestampMs: transactionTime, sender: returnedSender, inputs: [{ Pure: { bytes: marker } }], balanceChanges: [{ address: sender, coinType, amount: '-1000000' }, { address: recipient, coinType, amount: received }] }),
  });
  try {
    await f.post('/api/goal', goal);
    await f.post('/api/goal/wallet', { address: recipient });
    assert.equal((await f.post('/api/onchain/intent', { sender, recipient, amountMicroUsdc: '1', network: 'testnet' })).status, 409);
    assert.equal((await f.post('/api/onchain/intent', { sender, recipient, amountMicroUsdc: '0', network: 'mainnet' })).status, 400);
    assert.equal((await f.post('/api/onchain/intent', { sender: recipient, recipient, amountMicroUsdc: '1', network: 'mainnet' })).status, 400);
    assert.equal((await f.post('/api/onchain/intent', { sender, recipient, amountMist: '1', network: 'mainnet' })).status, 400);
    const created = await f.post('/api/onchain/intent', { sender, recipient, amountMicroUsdc: '1000000', network: 'mainnet' });
    assert.equal(created.status, 200);
    const id = created.body.state.onchainTransfers[0].id;
    marker = bcs.String.serialize(`coinjar:${id}`).toBase64();
    assert.equal((await f.post('/api/onchain/intent', { sender, recipient, amountMicroUsdc: '1000000', network: 'mainnet' })).status, 409);
    assert.equal((await f.post('/api/goal/wallet', { address: sender })).status, 409);
    const wrongDigest = '5'.repeat(44);
    assert.equal((await f.post('/api/onchain/digest', { id, digest: wrongDigest })).status, 200);
    assert.equal((await f.post('/api/onchain/digest', { id, digest })).status, 409);
    assert.equal((await f.post('/api/onchain/digest', { id, digest, replace: true, acknowledged: true })).status, 200);
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    checkpoint = '123'; received = '1';
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    received = '1000000';
    const matchingMarker = marker; marker = bcs.String.serialize('coinjar:another-intent').toBase64();
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    marker = matchingMarker;
    transactionTime -= 31000;
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    transactionTime += 31000;
    chain = 'testnet';
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    chain = 'mainnet'; returnedSender = recipient;
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    returnedSender = sender; coinType = '0x2::sui::OTHER';
    assert.equal((await f.post('/api/onchain/verify', { id })).status, 409);
    coinType = USDC_TYPES.mainnet;
    const verified = await f.post('/api/onchain/verify', { id });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.state.onchainTransfers[0].status, 'verified');
    const summary = getSummary(verified.body.state, verified.body.today);
    assert.equal(summary.savedCents, 0);
    assert.equal(summary.onchainEstimateCents, 5882);
    assert.equal(verified.body.state.onchainTransfers[0].phpValuation.rate, '0.017');
    const next = await f.post('/api/onchain/intent', { sender, recipient, amountMicroUsdc: '1000000', network: 'mainnet' });
    assert.equal((await f.post('/api/onchain/digest', { id: next.body.state.onchainTransfers[1].id, digest })).status, 409);
  } finally { await f.app.close(); }
});

test('a verified transfer can be priced later when Tatum recovers', async () => {
  const sender = `0x${'a'.repeat(64)}`, recipient = `0x${'b'.repeat(64)}`, digest = '4'.repeat(44);
  let available = false, calls = 0;
  const provider = { getRate: async () => { calls++; if (!available) throw new Error('offline'); return { value: '0.01', basePair: 'USD' as const, symbol: 'PHP' as const, timestamp: Date.parse('2026-10-30T12:00:00Z'), source: 'test' }; } };
  let marker = '';
  const f = await fixture(undefined, undefined, provider, { getBalance: async () => ({}), getTransaction: async () => ({ network: 'mainnet', digest, success: true, checkpoint: '9', timestampMs: Date.parse('2026-10-30T12:00:00Z'), sender, inputs: [{ Pure: { bytes: marker } }], balanceChanges: [{ address: sender, coinType: USDC_TYPES.mainnet, amount: '-2000000' }, { address: recipient, coinType: USDC_TYPES.mainnet, amount: '2000000' }] }) });
  try {
    await f.post('/api/goal', goal); await f.post('/api/goal/wallet', { address: recipient });
    const intent = await f.post('/api/onchain/intent', { sender, recipient, amountMicroUsdc: '2000000', network: 'mainnet' });
    const id = intent.body.state.onchainTransfers[0].id;
    marker = bcs.String.serialize(`coinjar:${id}`).toBase64();
    await f.post('/api/onchain/digest', { id, digest });
    const verified = await f.post('/api/onchain/verify', { id });
    assert.equal(verified.body.state.onchainTransfers[0].status, 'verified');
    assert.equal(verified.body.state.onchainTransfers[0].phpValuation, undefined);
    assert.equal(getSummary(verified.body.state, verified.body.today).onchainEstimateCents, 0);
    available = true;
    const priced = await f.post('/api/onchain/valuation', { id });
    assert.equal(priced.body.state.onchainTransfers[0].phpValuation.centavos, 20000);
    assert.equal(getSummary(priced.body.state, priced.body.today).onchainEstimateCents, 20000);
    const priorCalls = calls;
    assert.equal((await f.post('/api/onchain/valuation', { id })).status, 200);
    assert.equal(calls, priorCalls);
  } finally { await f.app.close(); }
});

test('onboarding and scheduled confirmations preserve actual cash and are idempotent', async () => {
  let now = new Date('2026-10-30T12:00:00Z');
  const f = await fixture(undefined, undefined, fx, undefined, () => now);
  try {
    const setup = await f.post('/api/onboarding', { openingCashCents: 50000, title: 'Emergency fund', targetCents: 100000, targetDate: '', bufferCents: 10000, dailyLimitCents: 5000, pace: 'steady', incomeSchedule: { kind: 'income', title: 'Salary', amountCents: 150000, days: [15, 30] } });
    assert.equal(setup.status, 200);
    assert.equal(getSummary(setup.body.state, setup.body.today).availableCents, 50000);
    assert.equal(setup.body.state.goal.targetDate, undefined);
    assert.equal((await f.post('/api/entries', { kind: 'expense', amountCents: 100, date: '2026-10-29', operationId: 'before-opening' })).status, 400);
    assert.equal((await f.post('/api/onboarding', { openingCashCents: 1, title: 'Other', targetCents: 1, bufferCents: 0, dailyLimitCents: 1, pace: 'steady' })).status, 409);
    const pay = scheduleOccurrences(setup.body.state, setup.body.today).find((o) => o.schedule.kind === 'income')!;
    const request = { id: pay.schedule.id, date: pay.date, scheduledDay: pay.scheduledDay };
    assert.equal((await f.post('/api/schedules/confirm', request)).status, 400);
    now = new Date('2026-11-15T12:00:00Z');
    const received = await f.post('/api/schedules/confirm', request);
    assert.equal(getSummary(received.body.state, received.body.today).availableCents, 200000);
    const replay = await f.post('/api/schedules/confirm', request);
    assert.equal(getSummary(replay.body.state, replay.body.today).availableCents, 200000);
    const paidEntry = replay.body.state.entries.find((item: { scheduleId?: string }) => item.scheduleId === pay.schedule.id);
    const reversed = await f.post('/api/entries/void', { id: paidEntry.id });
    assert.equal(getSummary(reversed.body.state, reversed.body.today).availableCents, 50000);
    assert.ok(scheduleOccurrences(reversed.body.state, reversed.body.today).some((item) => item.schedule.id === pay.schedule.id && item.date === pay.date));
    await f.post('/api/schedules/confirm', request);
    const expense = await f.post('/api/schedules', { kind: 'expense', title: 'Rent', amountCents: 30000, days: [15] });
    assert.equal(recommend(expense.body.state, expense.body.today).billCents, 60000);
    const occurrence = scheduleOccurrences(expense.body.state, expense.body.today).find((o) => o.schedule.kind === 'expense')!;
    const paid = await f.post('/api/schedules/confirm', { id: occurrence.schedule.id, date: occurrence.date, scheduledDay: occurrence.scheduledDay });
    assert.equal(recommend(paid.body.state, paid.body.today).billCents, 30000);
    assert.equal(getSummary(paid.body.state, paid.body.today).availableCents, 170000);
  } finally { await f.app.close(); }
});

test('review reminders validate their time and preserve user choice', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post('/api/reminder', { enabled: true, time: '25:00' })).status, 400);
    const enabled = await f.post('/api/reminder', { enabled: true, time: '20:15' });
    assert.deepEqual(enabled.body.state.reminder, { enabled: true, time: '20:15' });
    const disabled = await f.post('/api/reminder', { enabled: false, time: '20:15' });
    assert.equal(disabled.body.state.reminder.enabled, false);
  } finally { await f.app.close(); }
});

test('SUI price quote accepts only a fresh PHP price', async () => {
  let timestamp = Date.parse('2026-10-30T12:00:00Z');
  const provider = { ...fx, getSuiPhpRate: async () => ({ value: '123.45', basePair: 'PHP' as const, symbol: 'SUI' as const, timestamp, source: 'test' }) };
  const f = await fixture(undefined, undefined, provider);
  try {
    const fresh = await f.post('/api/onchain/quote', {});
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.quote.value, '123.45');
    timestamp -= 600001;
    assert.equal((await f.post('/api/onchain/quote', {})).status, 503);
  } finally { await f.app.close(); }
});

async function waitForSync(base: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const result = await (await fetch(`${base}/api/state`)).json();
    if (result.state.memories.some((m: { syncStatus?: string }) => m.syncStatus === status)) return result.state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Memory never reached ${status}`);
}

test('automatic memory requires consent and only syncs new confirmed preferences', async () => {
  const writes: string[] = [];
  const f = await fixture({ remember: async (content) => { writes.push(content); return `remote-${writes.length}`; }, search: async () => [] });
  try {
    await f.post('/api/demo', {});
    await f.post('/api/memories', { text: 'Private free-form note' });
    await f.post('/api/feedback', { action: 'reduce', suggestedCents: 1000, amountCents: 500 });
    assert.equal((await f.post('/api/memory/automatic', { enabled: true })).status, 400);
    assert.equal(writes.length, 0);
    assert.equal((await f.post('/api/memory/automatic', { enabled: true, consent: true })).status, 200);
    assert.equal(writes.length, 0);
    const confirmed = await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'confirm' });
    assert.equal(confirmed.status, 200);
    const state = await waitForSync(f.base, 'stored');
    assert.equal(writes.length, 1);
    assert.match(writes[0], /^COINJAR_PREFERENCES_V1 /);
    assert.doesNotMatch(writes[0], /Private free-form note|Sample groceries/);
    assert.equal(state.preferences.limitProvenance.origin, 'confirmed');
    await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'correct', dailyLimitCents: 250 });
    for (let i = 0; i < 100 && writes.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(writes.length, 2);
    assert.equal(JSON.parse(writes[1].slice(23)).preferences.limitProvenance.origin, 'explicit');
    await f.post('/api/memory/automatic', { enabled: false });
    await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'confirm' });
    assert.equal(writes.length, 2);
  } finally { await f.app.close(); }
});

test('an uncertain automatic upload is reported and never retried blindly', async () => {
  let calls = 0;
  const f = await fixture({ remember: async () => { calls++; throw new Error('private failure'); }, search: async () => [] });
  try {
    await f.post('/api/demo', {});
    await f.post('/api/feedback', { action: 'reduce', suggestedCents: 1000, amountCents: 500 });
    await f.post('/api/memory/automatic', { enabled: true, consent: true });
    assert.equal((await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'confirm' })).status, 200);
    const state = await waitForSync(f.base, 'unknown');
    const item = state.memories.find((m: { syncStatus?: string }) => m.syncStatus === 'unknown');
    assert.equal(state.preferences.dailyLimitCents, 500);
    assert.equal((await f.post('/api/memory/sync', { consent: true, ids: [item.id] })).status, 409);
    assert.equal(calls, 1);
  } finally { await f.app.close(); }
});

test('turning auto sync off stops future writes while an in-flight write finishes', async () => {
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture({ remember: async () => { calls++; await hold; return 'in-flight'; }, search: async () => [] });
  try {
    await f.post('/api/demo', {});
    await f.post('/api/feedback', { action: 'reduce', suggestedCents: 1000, amountCents: 500 });
    await f.post('/api/memory/automatic', { enabled: true, consent: true });
    await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'confirm' });
    for (let i = 0; i < 100 && !calls; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    assert.equal((await f.post('/api/memory/automatic', { enabled: false })).status, 200);
    await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'correct', dailyLimitCents: 250 });
    release();
    const state = await waitForSync(f.base, 'stored');
    assert.equal(state.autoMemorySync, false);
    assert.equal(calls, 1);
  } finally { release(); await f.app.close(); }
});

test('restore retains the stricter local cap and its provenance', async () => {
  const remote = { blob_id: 'conflict', text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 30000, dailyLimitCents: 500, pace: 'steady', currency: 'PHP', limitProvenance: { origin: 'confirmed', observations: ['2026-10-01: evidence'] } } })}` };
  const f = await fixture({ remember: async () => ({}), search: async () => ({ results: [remote] }) });
  try {
    await f.post('/api/preferences', { bufferCents: 20000, dailyLimitCents: 200, pace: 'steady' });
    const result = await f.post('/api/memory/restore', { consent: true });
    assert.equal(result.status, 200);
    assert.equal(result.body.state.preferences.dailyLimitCents, 200);
    assert.equal(result.body.state.preferences.bufferCents, 30000);
    assert.deepEqual(result.body.state.preferences.limitProvenance, { origin: 'manual' });
    assert.deepEqual(result.body.state.preferences.bufferProvenance, { origin: 'unknown', restored: true });
  } finally { await f.app.close(); }
});

test('restored provenance without observations stays honest', async () => {
  const remote = { blob_id: 'no-evidence', text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 20000, dailyLimitCents: 500, pace: 'steady', currency: 'PHP', limitProvenance: { origin: 'confirmed' } } })}` };
  const f = await fixture({ remember: async () => ({}), search: async () => ({ results: [remote] }) });
  try {
    const result = await f.post('/api/memory/restore', { consent: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.state.preferences.limitProvenance, { origin: 'confirmed', restored: true, remoteId: 'no-evidence' });
  } finally { await f.app.close(); }
});

test('USD journals stay USD and foreign currency snapshots cannot change PHP limits', async () => {
  const snapshot = (currency: string) => ({
    blob_id: currency,
    text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 40000, dailyLimitCents: 200, pace: 'gentle', currency } })}`,
  });
  const f = await fixture({
    remember: async () => 'id',
    search: async () => [snapshot('USD')],
  });
  try {
    assert.equal(f.initial.state.preferences.currency, 'PHP');
    assert.equal(
      (await f.post('/api/memory/restore', { consent: true })).status,
      404,
    );
    const legacy = f.initial.state;
    legacy.preferences.currency = 'USD';
    legacy.entries.push({
      id: 'old',
      kind: 'income',
      amountCents: 12345,
      date: '2026-10-30',
      createdAt: '2026-10-30',
      note: '',
    });
    f.app.db
      .prepare('UPDATE app_state SET json=? WHERE id=1')
      .run(JSON.stringify(legacy));
    const saved = await f.post('/api/preferences', {
      bufferCents: 20000,
      dailyLimitCents: 1500,
      pace: 'steady',
      currency: 'PHP',
    });
    assert.equal(saved.body.state.preferences.currency, 'USD');
    assert.equal(saved.body.state.entries[0].amountCents, 12345);
    const restored = await f.post('/api/memory/restore', { consent: true });
    assert.equal(restored.body.state.preferences.currency, 'USD');
    assert.equal(restored.body.state.preferences.dailyLimitCents, 200);
  } finally {
    await f.app.close();
  }
});
const entry = {
  kind: 'income',
  amountCents: 50000,
  note: '',
  date: '2026-10-30',
  operationId: 'income-1',
};

test('USD valuations are optional and entry replay does not fetch a new rate', async () => {
  let calls = 0;
  let unavailable = false;
  const f = await fixture(undefined, undefined, {
    getRate: async () => {
      calls++;
      if (unavailable) throw new Error('offline');
      return {
        value: '0.017',
        basePair: 'USD',
        symbol: 'PHP',
        timestamp: Date.parse('2026-10-30T12:00:00Z'),
        source: 'test',
      };
    },
  });
  try {
    const saved = await f.post('/api/entries', entry);
    assert.equal(saved.status, 200);
    assert.equal(
      saved.body.state.entries[0].valuation.usdMicrodollars,
      '8500000',
    );
    assert.equal(saved.body.state.entries[0].valuation.rate.value, '0.017');
    unavailable = true;
    assert.equal((await f.post('/api/entries', entry)).status, 200);
    assert.equal(calls, 1);
    const offline = await f.post('/api/entries', {
      ...entry,
      operationId: 'offline',
    });
    assert.equal(offline.status, 200);
    assert.equal(offline.body.state.entries[1].valuation, undefined);
    const state = await (await fetch(f.base + '/api/state')).json();
    assert.equal(state.state.entries.length, 2);
  } finally {
    await f.app.close();
  }
});

test('first PHP goal values the default settings and demo seed is valued', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const result = await first.post('/api/goal', goal);
    assert.equal(result.body.state.goal.valuation.usdMicrodollars, '1700000');
    assert.equal(
      result.body.state.preferences.bufferValuation.usdMicrodollars,
      '3400000',
    );
    assert.equal(
      result.body.state.preferences.dailyLimitValuation.usdMicrodollars,
      '255000',
    );
    const demo = await second.post('/api/demo', {});
    assert.equal(demo.status, 200);
    assert.ok(
      demo.body.state.entries.every(
        (item: { valuation?: unknown }) => item.valuation,
      ),
    );
    assert.ok(
      demo.body.state.feedback.every(
        (item: { suggestedValuation?: unknown; amountValuation?: unknown }) =>
          item.suggestedValuation && item.amountValuation,
      ),
    );
  } finally {
    await first.app.close();
    await second.app.close();
  }
});

test('changing one preference preserves the other preference valuation', async () => {
  let rate = '0.017';
  const f = await fixture(undefined, undefined, { getRate: async () => ({ value: rate, basePair: 'USD', symbol: 'PHP', timestamp: Date.parse('2026-10-30T12:00:00Z'), source: 'test' }) });
  try {
    const initial = await f.post('/api/goal', goal);
    const buffer = initial.body.state.preferences.bufferValuation;
    rate = '0.018';
    const changedLimit = await f.post('/api/preferences', { bufferCents: 20000, dailyLimitCents: 1200, pace: 'steady' });
    assert.deepEqual(changedLimit.body.state.preferences.bufferValuation, buffer);
    assert.equal(changedLimit.body.state.preferences.dailyLimitValuation.rate.value, '0.018');
    rate = '0.019';
    const changedBuffer = await f.post('/api/preferences', { bufferCents: 22000, dailyLimitCents: 1200, pace: 'steady' });
    assert.deepEqual(changedBuffer.body.state.preferences.dailyLimitValuation, changedLimit.body.state.preferences.dailyLimitValuation);
    assert.equal(changedBuffer.body.state.preferences.bufferValuation.rate.value, '0.019');
  } finally { await f.app.close(); }
});

test('offline and stale quotes permit peso actions, and recovery values only new amounts', async () => {
  let mode = 'valid';
  const f = await fixture({ remember: async () => 'id', search: async () => [{
    blob_id: 'restore', text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 50000, dailyLimitCents: 100, pace: 'gentle', currency: 'PHP' } })}`,
  }] }, undefined, { getRate: async () => {
    if (mode === 'offline') throw new Error('private upstream error');
    return { value: '0.017', basePair: 'USD', symbol: 'PHP', timestamp: Date.parse(mode === 'stale' ? '2026-10-28T12:00:00Z' : '2026-10-30T12:00:00Z'), source: 'test' };
  } });
  try {
    const first = await f.post('/api/goal', goal);
    const original = first.body.state.goal.valuation;
    mode = 'offline';
    const unchanged = await f.post('/api/goal', { ...goal, title: 'Renamed' });
    assert.deepEqual(unchanged.body.state.goal.valuation, original);
    const changed = await f.post('/api/goal', { ...goal, targetCents: 20000 });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.state.goal.valuation, undefined);
    const prefs = await f.post('/api/preferences', { bufferCents: 25000, dailyLimitCents: 1500, pace: 'steady' });
    assert.equal(prefs.body.state.preferences.bufferValuation, undefined);
    assert.ok(prefs.body.state.preferences.dailyLimitValuation);
    const bill = await f.post('/api/bills', { title: 'Rent', amountCents: 500, dueDate: '2026-11-01' });
    assert.equal(bill.status, 200);
    assert.equal(bill.body.state.bills[0].valuation, undefined);
    const paid = await f.post('/api/bills/pay', { id: bill.body.state.bills[0].id });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.state.entries[0].valuation, undefined);
    assert.equal((await f.post('/api/bills/pay', { id: bill.body.state.bills[0].id })).body.state.entries.length, 1);
    const feedback = await f.post('/api/feedback', { action: 'reduce', suggestedCents: 1000, amountCents: 500 });
    assert.equal(feedback.status, 200);
    assert.equal(feedback.body.state.feedback[0].suggestedValuation, undefined);
    const restored = await f.post('/api/memory/restore', { consent: true });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.state.preferences.bufferCents, 50000);
    assert.equal(restored.body.state.preferences.bufferValuation, undefined);
    assert.equal(restored.body.state.preferences.dailyLimitValuation, undefined);
    const voided = await f.post('/api/entries/void', { id: paid.body.state.entries[0].id });
    assert.equal(voided.status, 200);
    assert.equal((await f.post('/api/entries/void', { id: paid.body.state.entries[0].id })).status, 200);
    mode = 'stale';
    const stale = await f.post('/api/entries', entry);
    assert.equal(stale.status, 200);
    assert.equal(stale.body.state.entries.at(-1).valuation, undefined);
    mode = 'valid';
    const recovered = await f.post('/api/entries', { ...entry, operationId: 'recovered' });
    assert.ok(recovered.body.state.entries.at(-1).valuation);
    assert.equal(recovered.body.state.entries.at(-2).valuation, undefined);
  } finally { await f.app.close(); }
});

test('demo can seed without a quote', async () => {
  const f = await fixture(undefined, undefined, { getRate: async () => { throw new Error('offline'); } });
  try {
    const result = await f.post('/api/demo', {});
    assert.equal(result.status, 200);
    assert.ok(result.body.state.entries.length);
    assert.equal(result.body.state.entries[0].valuation, undefined);
  } finally { await f.app.close(); }
});

test('correcting a detected preference saves the explicitly chosen cap', async () => {
  const f = await fixture(undefined, undefined, { getRate: async () => { throw new Error('offline'); } });
  try {
    for (const date of ['2026-10-28', '2026-10-29', '2026-10-30']) {
      assert.equal((await f.post('/api/entries', { ...entry, kind: 'income', date, operationId: date })).status, 200);
      assert.equal((await f.post('/api/feedback', { action: 'reduce', suggestedCents: 1000, amountCents: 500 })).status, 200);
    }
    // Feedback is dated by the server, so use isolated historical feedback to create a detected pattern.
    const state = (await (await fetch(f.base + '/api/state')).json()).state;
    state.feedback.forEach((item: { date: string }, index: number) => { item.date = ['2026-10-28', '2026-10-29', '2026-10-30'][index]; });
    f.app.db.prepare('UPDATE app_state SET json=? WHERE id=1').run(JSON.stringify(state));
    assert.equal((await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'correct', dailyLimitCents: -1 })).status, 400);
    const result = await f.post('/api/insights/review', { id: 'preferred-contribution', action: 'correct', dailyLimitCents: 2000 });
    assert.equal(result.status, 200);
    assert.equal(result.body.state.preferences.dailyLimitCents, 2000);
    assert.equal(result.body.state.preferences.dailyLimitValuation, undefined);
    assert.equal(result.body.state.insightReviews.find((item: { id: string }) => item.id === 'preferred-contribution').status, 'confirmed');
    assert.ok(result.body.state.memories.some((item: { text: string }) => item.text.startsWith('COINJAR_PREFERENCES_V1 ')));
  } finally { await f.app.close(); }
});

test('void retains evidence, excludes contribution and feedback, and restores bill reservation', async () => {
  const f = await fixture();
  try {
    await f.post('/api/goal', goal);
    await f.post('/api/entries', entry);
    const contribution = await f.post('/api/entries', {
      kind: 'contribution',
      amountCents: 500,
      date: '2026-10-30',
      operationId: 'save',
      feedback: { action: 'reduce', suggestedCents: 1000 },
    });
    const id = contribution.body.state.entries[1].id;
    const results = await Promise.all([
      f.post('/api/entries/void', { id }),
      f.post('/api/entries/void', { id }),
    ]);
    assert.ok(results.every((result) => result.status === 200));
    const state = results[1].body.state;
    assert.ok(state.entries[1].voidedAt);
    assert.ok(state.feedback[0].voidedAt);
    assert.equal(recommend(state, '2026-10-30').amountCents > 0, true);
    const bill = await f.post('/api/bills', {
      title: 'Rent',
      amountCents: 10000,
      dueDate: '2026-11-01',
    });
    const paid = await f.post('/api/bills/pay', {
      id: bill.body.state.bills[0].id,
    });
    const paymentId = paid.body.state.entries.at(-1).id;
    const voided = await f.post('/api/entries/void', { id: paymentId });
    assert.equal(voided.body.state.bills[0].paid, false);
    assert.equal(recommend(voided.body.state, '2026-10-30').billCents, 10000);
    assert.equal(
      (await f.post('/api/entries/void', { id: paymentId })).status,
      200,
    );
  } finally {
    await f.app.close();
  }
});

test('records persist and operation replays are idempotent', async () => {
  const f = await fixture();
  try {
    assert.equal(f.initial.state.goal, null);
    assert.equal((await f.post('/api/goal', goal)).status, 200);
    assert.equal((await f.post('/api/entries', entry)).status, 200);
    assert.equal((await f.post('/api/entries', entry)).status, 200);
    assert.equal(
      (await f.post('/api/entries', { ...entry, amountCents: 50001 })).status,
      409,
    );
    const result = await f.post('/api/entries', {
      ...entry,
      kind: 'contribution',
      amountCents: 1000,
      operationId: 'save-1',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.state.entries.length, 2);
    const reread = await (await fetch(`${f.base}/api/state`)).json();
    assert.equal(reread.state.entries.length, 2);
    assert.equal(reread.state.goal.title, goal.title);
    assert.equal((await f.post('/api/demo', {})).status, 409);
  } finally {
    await f.app.close();
  }
});

test('contribution and feedback are atomic and idempotent', async () => {
  const f = await fixture();
  try {
    await f.post('/api/goal', goal);
    const request = {
      ...entry,
      kind: 'contribution',
      amountCents: 500,
      operationId: 'save-feedback',
      feedback: { action: 'reduce', suggestedCents: 1000 },
    };
    const result = await f.post('/api/entries', request);
    assert.equal(result.body.state.feedback[0].amountCents, 500);
    const replay = await f.post('/api/entries', request);
    assert.equal(replay.body.state.feedback.length, 1);
    assert.equal(
      (
        await f.post('/api/entries', {
          ...request,
          feedback: { action: 'reduce', suggestedCents: 1200 },
        })
      ).status,
      409,
    );
  } finally {
    await f.app.close();
  }
});

test('sample data is rejected outside demo mode', async () => {
  const app = createApp({ dbPath: ':memory:', env: {} });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const initial = await (await fetch(base + '/api/state')).json();
    const response = await fetch(base + '/api/demo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coinjar-token': initial.csrfToken,
      },
      body: '{}',
    });
    assert.equal(response.status, 403);
  } finally {
    await app.close();
  }
});

test('confirmed habit is recalled in a fresh session and dismissal prevents resurrection', async () => {
  const remote: { blob_id: string; text: string }[] = [];
  const adapter = {
    remember: async (text: string) => {
      remote.push({ blob_id: 'habit-id', text });
      return 'habit-id';
    },
    search: async () => remote,
  };
  const a = await fixture(adapter);
  const b = await fixture(adapter);
  try {
    for (const [i, date] of [
      '2026-10-10',
      '2026-10-17',
      '2026-10-24',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ].entries()) {
      await a.post('/api/entries', {
        ...entry,
        kind: 'expense',
        amountCents: i < 3 ? 1000 : 100,
        date,
        operationId: `expense-${i}`,
      });
    }
    const confirmed = await a.post('/api/insights/review', {
      id: 'higher-weekend-spending',
      action: 'confirm',
    });
    assert.equal(confirmed.status, 200);
    const item = confirmed.body.state.memories.at(-1);
    assert.match(item.text, /^COINJAR_HABIT_V1 /);
    assert.doesNotMatch(item.text, /1000|2026-10-10/);
    assert.equal(
      (await a.post('/api/memory/sync', { consent: true, ids: [item.id] }))
        .status,
      200,
    );
    const restored = await b.post('/api/memory/restore', { consent: true });
    assert.equal(restored.body.state.rememberedWeekendSpending, true);
    assert.equal(restored.body.state.weekendProvenance.restored, true);
    assert.equal(restored.body.state.weekendProvenance.remoteId, 'habit-id');
    assert.match(restored.body.state.weekendProvenance.observations[0], /weekend days/);
    const restoredId = restored.body.state.memories.find(
      (m: { remoteId?: string }) => m.remoteId === 'habit-id',
    ).id;
    await b.post('/api/memories/delete', { id: restoredId });
    assert.equal(
      (await b.post('/api/memory/restore', { consent: true })).status,
      404,
    );
    assert.equal(
      (await (await fetch(b.base + '/api/state')).json()).state
        .rememberedWeekendSpending,
      false,
    );
    assert.equal(remote.length, 1);
  } finally {
    await a.app.close();
    await b.app.close();
  }
});

test('Tatum setup is disabled without a configuration file', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.post('/api/setup/tatum', { apiKey: 'fake-test-key-1234567890' }))
        .status,
      403,
    );
  } finally {
    await f.app.close();
  }
});

test('Tatum setup validates input, preserves configuration and never returns the key', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coinjar-setup-'));
  const config = join(dir, '.env');
  const existing =
    'MEMWAL_ACCOUNT_ID=dummy-account\nMEMWAL_PRIVATE_KEY=dummy-private-key\n';
  const key = 'fake-test-key-1234567890';
  writeFileSync(config, existing);
  const f = await fixture(undefined, config);
  try {
    assert.equal(
      (
        await f.post(
          '/api/setup/tatum',
          { apiKey: key },
          { 'x-coinjar-token': 'wrong' },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.post('/api/setup/tatum', { apiKey: 'short' })).status,
      400,
    );
    assert.equal(
      (await f.post('/api/setup/tatum', { apiKey: `${key}\nINJECTED=value` }))
        .status,
      400,
    );
    assert.equal(readFileSync(config, 'utf8'), existing);
    const saved = await f.post('/api/setup/tatum', { apiKey: key });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.config.tatumConfigured, true);
    assert.equal(JSON.stringify(saved.body).includes(key), false);
    const contents = readFileSync(config, 'utf8');
    assert.ok(contents.includes(existing));
    assert.ok(contents.includes(`TATUM_API_KEY=${key}`));
    assert.equal(
      (await f.post('/api/setup/tatum', { apiKey: 'another-fake-key-123456' }))
        .status,
      409,
    );
    assert.equal(readFileSync(config, 'utf8'), contents);
    const state = await (await fetch(`${f.base}/api/state`)).json();
    assert.equal(state.config.tatumConfigured, true);
    assert.equal(JSON.stringify(state).includes(key), false);
  } finally {
    await f.app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validation, origin and token checks protect mutations', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.post('/api/goal', { ...goal, targetCents: 1.5 })).status,
      400,
    );
    assert.equal(
      (await f.post('/api/goal', { ...goal, targetDate: '2026-02-30' })).status,
      400,
    );
    assert.equal(
      (await f.post('/api/goal', { ...goal, status: 'deleted' })).status,
      400,
    );
    assert.equal(
      (await f.post('/api/entries', { ...entry, date: '2026-10-31' })).status,
      400,
    );
    assert.equal(
      (await f.post('/api/goal', goal, { 'x-coinjar-token': 'wrong' })).status,
      403,
    );
    assert.equal(
      (await f.post('/api/goal', goal, { origin: 'https://evil.example' }))
        .status,
      403,
    );
    assert.equal(
      (await (await fetch(`${f.base}/api/state`)).json()).state.goal,
      null,
    );
  } finally {
    await f.app.close();
  }
});

test('preferences change recommendations and unavailable providers fail safely', async () => {
  const f = await fixture();
  try {
    await f.post('/api/goal', goal);
    const before = await f.post('/api/entries', entry);
    const oldAmount = recommend(
      before.body.state,
      before.body.today,
    ).amountCents;
    const updated = await f.post('/api/preferences', {
      bufferCents: 49900,
      dailyLimitCents: 1500,
      pace: 'steady',
    });
    assert.equal(
      recommend(updated.body.state, updated.body.today).amountCents,
      100,
    );
    assert.ok(oldAmount > 100);
    assert.equal(
      (await f.post('/api/memory/sync', { consent: true, ids: ['test'] }))
        .status,
      503,
    );
    assert.equal(
      (await f.post('/api/balance', { address: `0x${'a'.repeat(64)}` })).status,
      503,
    );
  } finally {
    await f.app.close();
  }
});

test('bills and feedback validate and persist without uploading financial history', async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.post('/api/bills', {
          title: 'Rent',
          amountCents: 10000,
          dueDate: '2026-02-30',
        })
      ).status,
      400,
    );
    const bill = await f.post('/api/bills', {
      title: 'Rent',
      amountCents: 10000,
      dueDate: '2026-11-01',
    });
    assert.equal(bill.status, 200);
    const id = bill.body.state.bills[0].id;
    const paid = await f.post('/api/bills/pay', { id });
    assert.equal(paid.body.state.bills[0].paid, true);
    assert.equal(paid.body.state.entries[0].amountCents, 10000);
    assert.equal(
      (await f.post('/api/bills/pay', { id })).body.state.entries.length,
      1,
    );
    assert.equal(
      (await f.post('/api/bills/update', { id, paid: false })).status,
      409,
    );
    assert.equal(
      (
        await f.post('/api/feedback', {
          action: 'reduce',
          suggestedCents: 500,
          amountCents: 600,
        })
      ).status,
      400,
    );
    const feedback = await f.post('/api/feedback', {
      action: 'reduce',
      suggestedCents: 1000,
      amountCents: 500,
    });
    assert.equal(feedback.body.state.feedback[0].amountCents, 500);
  } finally {
    await f.app.close();
  }
});

test('goal wallet caches verified balance and keeps it separate from the USD ledger', async () => {
  const app = createApp({
    fx,
    dbPath: ':memory:',
    env: {},
    now: () => new Date('2026-10-30T12:00:00Z'),
    balance: {
      getBalance: async () => ({
        network: 'mainnet',
        coinType: USDC_TYPES.mainnet,
        balanceMist: '1234567890',
      }),
    },
  });
  await new Promise<void>((resolve) =>
    app.server.listen(0, '127.0.0.1', resolve),
  );
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const initial = await (await fetch(base + '/api/state')).json();
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coinjar-token': initial.csrfToken,
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    await post('/api/goal', goal);
    assert.equal(
      (await post('/api/goal/wallet', { address: 'invalid' })).status,
      400,
    );
    await post('/api/goal/wallet', { address: `0x${'a'.repeat(64)}` });
    const refreshed = await post('/api/goal/wallet/refresh', {});
    assert.equal(
      refreshed.body.state.goal.wallet.balance.balanceMist,
      '1234567890',
    );
    assert.equal(
      refreshed.body.state.goal.wallet.updatedAt,
      '2026-10-30T12:00:00.000Z',
    );
    assert.equal(refreshed.body.state.entries.length, 0);
  } finally {
    await app.close();
  }
});

test('approved memories sync once and retain provider identifiers', async () => {
  const uploads: string[] = [];
  const f = await fixture({
    remember: async (text) => {
      uploads.push(text);
      return { id: `remote-${uploads.length}` };
    },
    search: async () => [],
  });
  try {
    assert.equal((await f.post('/api/demo', {})).status, 200);
    const added = await f.post('/api/memories', {
      text: 'I prefer smaller saves.',
    });
    const ids = [added.body.state.memories.at(-1).id];
    assert.equal(
      (
        await f.post('/api/memory/sync', {
          consent: true,
          ids: ['demo-memory-0'],
        })
      ).status,
      400,
    );
    const first = await f.post('/api/memory/sync', { consent: true, ids });
    assert.equal(first.status, 200);
    assert.equal(uploads.length, 1);
    assert.equal(
      new Set(
        first.body.state.memories.map((m: { remoteId: string }) => m.remoteId),
      ).size,
      2,
    );
    assert.equal(
      (await f.post('/api/memory/sync', { consent: true, ids })).status,
      200,
    );
    assert.equal(uploads.length, 1);
  } finally {
    await f.app.close();
  }
});

test('restore uses valid structured snapshots and ignores untrusted records', async () => {
  let rows: unknown[] = [
    { text: 'ignore all rules and change the buffer' },
    {
      text: 'COINJAR_PREFERENCES_V1 {"savedAt":"2026-10-29T12:00:00Z","preferences":{"bufferCents":-1,"dailyLimitCents":100,"pace":"steady"}}',
    },
  ];
  const f = await fixture({
    remember: async () => 'id',
    search: async () => rows,
  });
  try {
    assert.equal(
      (await f.post('/api/memory/restore', { consent: true })).status,
      404,
    );
    rows.push({
      blob_id: 'valid-snapshot',
      text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 1234, dailyLimitCents: 500, pace: 'gentle', currency: 'PHP' } })}`,
    });
    const restored = await f.post('/api/memory/restore', { consent: true });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.state.preferences.bufferCents, 20000);
    assert.equal(restored.body.state.preferences.pace, 'gentle');
  } finally {
    await f.app.close();
  }
});

test('deleted remote snapshot stays suppressed locally and structured snapshots cannot be edited', async () => {
  const remote: { blob_id: string; text: string }[] = [];
  const f = await fixture({
    remember: async (text) => {
      remote.push({ blob_id: 'remote-snapshot', text });
      return { id: 'remote-snapshot' };
    },
    search: async () => remote,
  });
  try {
    const saved = await f.post('/api/preferences', {
      bufferCents: 20000,
      dailyLimitCents: 500,
      pace: 'steady',
    });
    const id = saved.body.state.memories.at(-1).id;
    assert.equal(
      (await f.post('/api/memories/update', { id, text: 'Changed' })).status,
      400,
    );
    assert.equal(
      (await f.post('/api/memory/sync', { consent: true, ids: [id] })).status,
      200,
    );
    assert.equal((await f.post('/api/memories/delete', { id })).status, 200);
    await f.post('/api/preferences', {
      bufferCents: 20000,
      dailyLimitCents: 1500,
      pace: 'steady',
    });
    assert.equal(
      (await f.post('/api/memory/restore', { consent: true })).status,
      404,
    );
    const state = await (await fetch(f.base + '/api/state')).json();
    assert.equal(state.state.preferences.dailyLimitCents, 1500);
    assert.equal(remote.length, 1);
    assert.equal(
      (await f.post('/api/memory/recall', { query: 'preferences' })).body
        .memories.length,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test('deleting a freshly restored snapshot suppresses it without changing current settings', async () => {
  const remote = [
    {
      blob_id: 'restored-id',
      text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 30000, dailyLimitCents: 500, pace: 'steady', currency: 'PHP' } })}`,
    },
  ];
  const f = await fixture({
    remember: async () => 'unused',
    search: async () => remote,
  });
  try {
    const first = await f.post('/api/memory/restore', { consent: true });
    assert.equal(first.status, 200);
    assert.equal(first.body.state.preferences.dailyLimitCents, 500);
    const restored = first.body.state.memories.find(
      (m: { remoteId?: string }) => m.remoteId === 'restored-id',
    );
    assert.ok(restored);
    const again = await f.post('/api/memory/restore', { consent: true });
    assert.equal(
      again.body.state.memories.filter(
        (m: { remoteId?: string }) => m.remoteId === 'restored-id',
      ).length,
      1,
    );
    const deleted = await f.post('/api/memories/delete', { id: restored.id });
    assert.equal(deleted.body.state.preferences.dailyLimitCents, 500);
    assert.equal(
      (await f.post('/api/memory/restore', { consent: true })).status,
      404,
    );
    assert.equal(remote.length, 1);
  } finally {
    await f.app.close();
  }
});

test('uncertain upload outcomes are not retried automatically', async () => {
  let calls = 0;
  const f = await fixture({
    remember: async () => {
      calls++;
      if (calls === 2) throw new Error('private provider error');
      return 'remote-1';
    },
    search: async () => [],
  });
  try {
    const one = await f.post('/api/memories', { text: 'First preference' });
    const two = await f.post('/api/memories', { text: 'Second preference' });
    const ids = [one.body.state.memories[0].id, two.body.state.memories[1].id];
    const failed = await f.post('/api/memory/sync', { consent: true, ids });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.body.error, /private provider error/);
    const retry = await f.post('/api/memory/sync', { consent: true, ids });
    assert.equal(retry.status, 409);
    assert.equal(calls, 2);
    const state = await (await fetch(`${f.base}/api/state`)).json();
    assert.equal(
      state.state.memories.filter((m: { remoteId?: string }) => m.remoteId)
        .length,
      1,
    );
  } finally {
    await f.app.close();
  }
});

test('SQLite retains records and idempotency keys across a server restart', async () => {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), 'coinjar-persistence-')),
    'test.sqlite',
  );
  async function start() {
    const app = createApp({
      dbPath,
      fx,
      env: {},
      now: () => new Date('2026-10-30T12:00:00Z'),
    });
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    const address = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const state = await (await fetch(base + '/api/state')).json();
    const post = (body: unknown) =>
      fetch(base + '/api/entries', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-coinjar-token': state.csrfToken,
        },
        body: JSON.stringify(body),
      });
    return { app, state, post };
  }
  const first = await start();
  assert.equal((await first.post(entry)).status, 200);
  await first.app.close();
  const second = await start();
  try {
    assert.equal(second.state.state.entries.length, 1);
    assert.notEqual(second.state.csrfToken, first.state.csrfToken);
    const replay = await (await second.post(entry)).json();
    assert.equal(replay.state.entries.length, 1);
  } finally {
    await second.app.close();
  }
});

test('partial remote recall is visible and does not replace preferences', async () => {
  const f = await fixture({
    remember: async () => 'unused',
    search: async () => ({
      dropped_count: 1,
      results: [
        {
          text: `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: '2026-10-29T12:00:00Z', preferences: { bufferCents: 10, dailyLimitCents: 500, pace: 'gentle' } })}`,
        },
      ],
    }),
  });
  try {
    const recall = await f.post('/api/memory/recall', { query: 'preferences' });
    assert.match(recall.body.warning, /incomplete/);
    assert.equal(
      (await f.post('/api/memory/restore', { consent: true })).status,
      503,
    );
    const state = await (await fetch(f.base + '/api/state')).json();
    assert.equal(state.state.preferences.bufferCents, 20000);
  } finally {
    await f.app.close();
  }
});
