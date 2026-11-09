import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { hostedSavings, type HostedSnapshot } from '../src/hostedSavings';
import { createTrackingHandler } from '../hosted/api';
import { TrackingNotFound, type TrackingStore } from '../hosted/store';
import { memoryPreferences, memoryRows } from '../hosted/memory';

test('hosted recommendations use recorded cash, bills, limits and voided history', () => {
  const snapshot: HostedSnapshot = { revision: '1', preferences: { bufferCents: 10000, dailyLimitCents: 50000, pace: 'steady', currency: 'PHP' }, bills: [{ id: 'bill', title: 'Rent', amountCents: 10000, dueDate: '2026-11-07', paid: false }], entries: [{ id: 'income', kind: 'income', amount_centavos: '50000', entry_date: '2026-11-06', note: '' }, { id: 'saving', kind: 'recorded_saving', amount_centavos: '10000', entry_date: '2026-11-05', note: '' }], goal: { id: 'goal', title: 'Emergency', target_centavos: '100000', target_date: null } };
  const first = hostedSavings(snapshot, '2026-11-06');
  assert.equal(first.summary.availableCents, 40000);
  assert.equal(first.summary.savedCents, 10000);
  assert.equal(first.summary.progress, 0.1);
  assert.equal(first.recommendation.amountCents, 20000);
  snapshot.entries.push({ id: 'expense', kind: 'expense', amount_centavos: '5000', entry_date: '2026-11-06', note: '' });
  assert.equal(hostedSavings(snapshot, '2026-11-06').recommendation.amountCents, 15000);
  snapshot.entries[2].voided_at = '2026-11-06T01:00:00Z';
  assert.equal(hostedSavings(snapshot, '2026-11-06').recommendation.amountCents, 20000);
  assert.equal(hostedSavings({ ...snapshot, entries: [] }, '2026-11-06').summary.availableCents, 0);
  const observation = '3 weekend days and 4 weekdays with recorded expenses in the last 56 days; days without recorded expenses are excluded.';
  snapshot.preferences = { ...snapshot.preferences!, confirmedWeekend: true, limitProvenance: { origin: 'confirmed', restored: true, remoteId: 'memory-a', observations: [observation] } };
  const factor = hostedSavings(snapshot, '2026-11-06').recommendation.factors.find(item => item.type === 'higher-weekend-spending');
  assert.equal(factor?.source, 'walrus');
  assert.equal(factor?.remoteId, 'memory-a');
  assert.deepEqual(factor?.observations, [observation]);
});

test('opening balance and currency feed the existing savings calculation', () => {
  const snapshot: HostedSnapshot = { revision: '1', preferences: { currency: 'USD', bufferCents: 20000, dailyLimitCents: 1500, pace: 'steady', openingCashCents: 100000, openingCashDate: '2026-11-06', setupComplete: true }, entries: [{ id: 'expense', kind: 'expense', amount_centavos: '79000', entry_date: '2026-11-06', note: '' }], goal: { id: 'goal', title: 'Emergency', target_centavos: '200000', target_date: null } };
  const result = hostedSavings(snapshot, '2026-11-06');
  assert.equal(result.summary.availableCents, 21000);
  assert.equal(result.recommendation.amountCents, 1000);
  assert.ok(result.recommendation.reasons.some(reason => reason.includes('$200.00')));
});

test('new hosted endpoints use only the authenticated owner and fail closed', async () => {
  const seen: string[] = [];
  const store = {
    snapshot: async (owner: string) => { seen.push(owner); return { walletAddress: `0x${'a'.repeat(64)}`, revision: '0', entries: [], goal: null }; },
    saveSettings: async (owner: string) => { seen.push(owner); return { id: owner, revision: '1' }; },
    addBill: async (owner: string) => { seen.push(owner); return { id: owner, revision: '1' }; },
    voidEntry: async (owner: string) => { seen.push(owner); throw new TrackingNotFound(); },
  } as unknown as TrackingStore;
  const handler = createTrackingHandler({ store, origin: 'https://coinjar.example', authenticate: async req => req.headers.get('cookie') === 'valid' ? 'user-a' : undefined, walletBalance: async () => { throw new Error('provider outage'); } });
  const post = (path: string, body: object, cookie = 'valid') => handler(new Request(`https://coinjar.example${path}`, { method: 'POST', headers: { origin: 'https://coinjar.example', cookie, 'content-type': 'application/json' }, body: JSON.stringify({ operationId: 'test', revision: '0', owner: 'user-b', ...body }) }));
  assert.equal((await post('/api/tracking/settings', { bufferCents: 1, dailyLimitCents: 2, pace: 'steady', walletAddress: null })).status, 200);
  assert.equal((await post('/api/tracking/bills', { title: 'Rent', amountCents: 1, dueDate: '2026-11-07' })).status, 200);
  assert.equal((await post('/api/tracking/void', { entryId: 'other-user-entry', reason: 'mistake' })).status, 404);
  assert.equal((await post('/api/tracking/settings', { bufferCents: 1 }, '')).status, 401);
  assert.equal((await handler(new Request('https://coinjar.example/api/tracking/wallet', { headers: { cookie: 'valid' } }))).status, 503);
  assert.deepEqual(seen, ['user-a', 'user-a', 'user-a', 'user-a']);
});

test('setup derives the account from the session and validates currency and balance', async () => {
  const calls: unknown[] = [];
  const store = { setup: async (...args: unknown[]) => { calls.push(args); return { id: 'test', revision: '1' }; } } as unknown as TrackingStore;
  const handler = createTrackingHandler({ store, origin: 'https://coinjar.example', authenticate: async req => req.headers.get('cookie') === 'valid' ? 'user-a' : undefined });
  const post = (body: object, cookie = 'valid') => handler(new Request('https://coinjar.example/api/tracking/setup', { method: 'POST', headers: { origin: 'https://coinjar.example', cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const body = { operationId: 'id', revision: '0', currency: 'USD', openingCashCents: 12345, openingCashDate: '2026-11-06', owner: 'user-b' };
  assert.equal((await post(body)).status, 200);
  assert.equal((calls[0] as unknown[])[0], 'user-a');
  assert.equal((await post({ ...body, currency: 'EUR' })).status, 400);
  assert.equal((await post(body, '')).status, 401);
});

test('watch-only wallet reads the saved address for the authenticated user', async () => {
  const addressA = `0x${'a'.repeat(64)}`, addressB = `0x${'b'.repeat(64)}`;
  const addresses = new Map([['user-a', addressA], ['user-b', addressB]]);
  const store = { snapshot: async (owner: string) => ({ walletAddress: addresses.get(owner) ?? null }) } as unknown as TrackingStore;
  const handler = createTrackingHandler({ store, origin: 'https://coinjar.example', authenticate: async req => req.headers.get('cookie') ?? undefined, walletBalance: async address => ({ balanceMist: address === addressA ? '11' : '22', network: 'testnet', coinType: '0x2::sui::SUI' }) });
  const request = (owner?: string) => handler(new Request(`https://coinjar.example/api/tracking/wallet?address=${addressB}`, { headers: owner ? { cookie: owner } : {} }));
  assert.equal((await request()).status, 401);
  const balance = await (await request('user-a')).json();
  assert.equal(balance.balanceMist, '11');
  assert.ok(Number.isFinite(Date.parse(balance.checkedAt)));
  assert.equal((await (await request('user-b')).json()).balanceMist, '22');
  const changing = createTrackingHandler({ store, origin: 'https://coinjar.example', authenticate: async () => 'user-a', walletBalance: async () => { addresses.set('user-a', addressB); return { balanceMist: '11', network: 'testnet', coinType: '0x2::sui::SUI' }; } });
  assert.equal((await changing(new Request('https://coinjar.example/api/tracking/wallet'))).status, 409);
});

test('memory snapshots retain only validated preferences and aggregate observations', () => {
  const safe = memoryPreferences({ currency: 'PHP', bufferCents: 100, dailyLimitCents: 200, pace: 'steady', confirmedWeekend: true, walletAddress: 'secret-address', rawHistory: [{ amount: 123 }], limitProvenance: { origin: 'confirmed', observations: ['3 weekend days and 4 weekdays with recorded expenses in the last 56 days; days without recorded expenses are excluded.', '2026-11-06: PHP 123 bought item', 'private-key'] } });
  assert.deepEqual(safe.limitProvenance.observations, ['3 weekend days and 4 weekdays with recorded expenses in the last 56 days; days without recorded expenses are excluded.']);
  assert.equal(JSON.stringify(safe).includes('secret-address'), false);
  assert.equal(JSON.stringify(safe).includes('private-key'), false);
  assert.equal(JSON.stringify(safe).includes('rawHistory'), false);
  assert.equal(memoryRows({ results: [{ id: 'one', text: 'COINJAR_HOSTED_V1 ' + JSON.stringify({ kind: 'preferences', text: '', preferences: safe }) }] }).length, 1);
  assert.equal(memoryRows({ results: [{ id: 'bad', text: 'COINJAR_HOSTED_V1 ' + JSON.stringify({ kind: 'preferences', text: 'private-key', preferences: safe }) }] }).length, 0);
  assert.throws(() => memoryPreferences({ ...safe, confirmedWeekend: 'true' }));
});

test('memory rejects missing consent and arbitrary text before provider upload', async () => {
  let calls = 0;
  const store = { snapshot: async () => ({ preferences: { currency: 'PHP', bufferCents: 100, dailyLimitCents: 200, pace: 'steady' } }), beginMemory: async () => ({ send: true }), finishMemory: async () => {} } as unknown as TrackingStore;
  const handler = createTrackingHandler({ store, origin: 'https://coinjar.example', authenticate: async () => 'user-a', memory: { remember: async () => { calls++; return { id: 'remote' }; }, recall: async () => ({ results: [] }) } });
  const post = (data: object) => handler(new Request('https://coinjar.example/api/tracking/memory', { method: 'POST', headers: { origin: 'https://coinjar.example', 'content-type': 'application/json' }, body: JSON.stringify(data) }));
  assert.equal((await post({ kind: 'preferences', operationId: 'id' })).status, 400);
  assert.equal((await post({ kind: 'preferences', operationId: 'id', consent: true, text: 'raw transaction details' })).status, 400);
  assert.equal((await post({ kind: 'insight', operationId: 'id', consent: true, text: 'raw transaction details' })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post({ kind: 'preferences', operationId: 'id', consent: true })).status, 200);
  assert.equal(calls, 1);
});

test('memory endpoints isolate users, validate recall and fail closed on provider errors', async () => {
  const saved = new Map<string, Array<{ id: string; text: string }>>();
  let unavailable = false;
  const store = {
    snapshot: async () => ({ preferences: { currency: 'PHP', bufferCents: 100, dailyLimitCents: 200, pace: 'steady' }, walletAddress: null }),
    beginMemory: async () => ({ send: true }), finishMemory: async () => {},
    saveSettings: async (owner: string) => ({ id: owner, revision: '1' }),
  } as unknown as TrackingStore;
  const memory = {
    remember: async (owner: string, text: string) => { const record = { id: `memory-${owner}`, text }; saved.set(owner, [record]); return record; },
    recall: async (owner: string) => { if (unavailable) throw new Error('provider unavailable'); return { results: saved.get(owner) ?? [] }; },
  };
  const handler = createTrackingHandler({ store, memory, origin: 'https://coinjar.example', authenticate: async req => req.headers.get('cookie') ?? undefined });
  const request = (owner: string | undefined, path: string, payload?: object) => handler(new Request(`https://coinjar.example${path}`, { method: payload ? 'POST' : 'GET', headers: { ...(owner ? { cookie: owner } : {}), origin: 'https://coinjar.example', ...(payload ? { 'content-type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }));
  assert.equal((await request(undefined, '/api/tracking/memory')).status, 401);
  assert.equal((await request('a', '/api/tracking/memory', { operationId: 'one', consent: true, kind: 'preferences', owner: 'b' })).status, 200);
  assert.equal((await request('b', '/api/tracking/memory', { operationId: 'two', consent: true, kind: 'preferences', owner: 'a' })).status, 200);
  assert.equal((await (await request('a', '/api/tracking/memory')).json()).memories[0].id, 'memory-a');
  assert.equal((await (await request('b', '/api/tracking/memory')).json()).memories[0].id, 'memory-b');
  assert.equal((await request('b', '/api/tracking/memory/restore', { operationId: 'three', revision: '0', consent: true, remoteId: 'memory-a' })).status, 404);
  assert.equal((await request('a', '/api/tracking/memory/restore', { operationId: 'four', revision: '0', consent: false, remoteId: 'memory-a' })).status, 400);
  unavailable = true;
  assert.equal((await request('a', '/api/tracking/memory')).status, 503);
  assert.equal((await request('a', '/api/tracking/memory/restore', { operationId: 'five', revision: '0', consent: true, remoteId: 'memory-a' })).status, 503);
});
