import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createPhoneWalrusHandler } from '../phone-walrus.mjs';

test('encrypted backups are isolated and restore only the latest listed blob', async () => {
  const origin = 'https://coinjar.example', env = { COINJAR_PHONE_ACCESS_CODE: 'z'.repeat(43), COINJAR_PHONE_ORIGIN: origin, MEMWAL_MAINNET_PRIVATE_KEY: 'mock', MEMWAL_MAINNET_ACCOUNT_ID: 'mock' };
  const spaces = new Map(); let omitLatest = false;
  const handler = createPhoneWalrusHandler({ env, network: 'mainnet', adapterFactory: async ({ namespace }) => {
    const rows = spaces.get(namespace) ?? []; spaces.set(namespace, rows);
    return {
      remember: async text => { const n = rows.length + 1; rows.push({ text, blob_id: `blob${n}`, namespace_id: namespace, created_at: `2026-01-0${n}T00:00:00Z` }); return { id: `id${n}`, blob_id: `blob${n}` }; },
      list: async () => ({ memories: rows, has_more: false, must_resync: false }),
      search: async () => ({ results: omitLatest ? rows.slice(0, 1) : rows }),
    };
  } });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (code, body) => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { origin, authorization: `Bearer ${code}`, 'x-coinjar-recovery': '1' }, body: JSON.stringify({ consent: true, ...body }) });
  const first = 'a'.repeat(43), other = 'b'.repeat(43), envelope = { version: 1, iv: 'a'.repeat(16), ciphertext: 'b'.repeat(24) };
  try {
    assert.equal((await send(first, { action: 'backupSave', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111', envelope })).status, 200);
    const second = { ...envelope, ciphertext: 'c'.repeat(24) };
    assert.equal((await send(first, { action: 'backupSave', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690112', envelope: second })).status, 200);
    assert.deepEqual((await (await send(first, { action: 'backupRestore' })).json()).envelope, second);
    assert.equal((await send(other, { action: 'backupRestore' })).status, 404);
    omitLatest = true;
    assert.equal((await send(first, { action: 'backupRestore' })).status, 502);
    assert.equal((await send(first, { action: 'backupSave', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690113', envelope: { ...envelope, note: 'plaintext' } })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('personal codes isolate memory spaces and ignore caller-provided namespaces', async () => {
  const origin = 'https://coinjar.example', env = { COINJAR_PHONE_ACCESS_CODE: 'z'.repeat(43), COINJAR_PHONE_ORIGIN: origin, MEMWAL_MAINNET_PRIVATE_KEY: 'mock', MEMWAL_MAINNET_ACCOUNT_ID: 'mock' };
  const records = new Map(), spaces = [];
  const handler = createPhoneWalrusHandler({ env, network: 'mainnet', adapterFactory: async ({ namespace }) => {
    spaces.push(namespace);
    return { remember: async text => { records.set(namespace, text); return { id: 'mock-id', blob_id: 'mock-blob' }; }, search: async () => ({ results: records.has(namespace) ? [{ text: records.get(namespace) }] : [] }) };
  } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (token, body, requestOrigin = origin, demo = false) => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: requestOrigin, 'x-coinjar-memory-user': '1', ...(demo ? { 'x-coinjar-memory-demo': '1' } : {}) }, body: JSON.stringify({ consent: true, ...body }) });
  const first = 'a'.repeat(43), second = 'b'.repeat(43);
  const memory = 'COINJAR_PHONE_PREFERENCES_V1 ' + JSON.stringify({ currency: 'PHP', bufferCents: 10, dailyLimitCents: 5, origin: 'manual' });
  try {
    assert.equal((await send(first, { action: 'remember', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111', memory })).status, 200);
    assert.deepEqual((await (await send(second, { action: 'recall', namespace: spaces[0] })).json()).memories, []);
    assert.deepEqual((await (await send(first, { action: 'recall' })).json()).memories, [memory]);
    assert.notEqual(spaces[0], spaces[1]); assert.equal(spaces[0], spaces[2]);
    assert.deepEqual((await (await send(first, { action: 'recall' }, origin, true)).json()).memories, []);
    assert.notEqual(spaces[0], spaces[3]);
    assert.equal((await send(first, { action: 'recall' }, 'https://evil.example')).status, 401);
    assert.equal((await send('short', { action: 'recall' })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('currency-only memories do not include removed financial preferences', async () => {
  const origin = 'https://coinjar.example', code = 'z'.repeat(43); let sent = '';
  const handler = createPhoneWalrusHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'mock', MEMWAL_ACCOUNT_ID: 'mock' }, adapterFactory: async () => ({ remember: async text => { sent = text; return { blob_id: 'blob' }; }, search: async () => ({ results: [{ text: sent }] }) }) });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { origin, authorization: `Bearer ${code}` }, body: JSON.stringify({ consent: true, ...body }) });
  try {
    const memory = 'COINJAR_PHONE_PREFERENCES_V2 ' + JSON.stringify({ currency: 'PHP', origin: 'manual' });
    assert.equal((await post({ action: 'remember', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111', memory })).status, 200);
    assert.deepEqual((await (await post({ action: 'recall' })).json()).memories, [memory]);
    assert.equal((await post({ action: 'remember', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690112', memory: memory.replace('"origin"', '"bufferCents":5,"origin"') })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('daily habit memories accept only aggregate day evidence', async () => {
  const origin = 'https://coinjar.example', code = 'z'.repeat(43); let sent = '';
  const handler = createPhoneWalrusHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'mock', MEMWAL_ACCOUNT_ID: 'mock' }, adapterFactory: async () => ({ remember: async text => { sent = text; return { blob_id: 'blob' }; }, search: async () => ({ results: [{ text: sent }] }) }) });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const post = memory => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { origin, authorization: `Bearer ${code}` }, body: JSON.stringify({ consent: true, action: 'remember', operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111', memory }) });
  try {
    const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'higher-day-spending', days: [1, 3], sampleDays: [3, 3], recordedDays: 9, observedThrough: '2026-01-20' });
    assert.equal((await post(memory)).status, 200);
    assert.equal((await post(memory.replace('"recordedDays":9', '"recordedDays":9,"amount":100'))).status, 400);
    assert.equal((await post(memory.replace('"days":[1,3]', '"days":[3,1]'))).status, 400);
    assert.equal((await post(memory.replace('"recordedDays":9', '"recordedDays":6').replace('"sampleDays":[3,3]', '"sampleDays":[4,4]'))).status, 400);
    assert.equal(sent, memory);
    const cleared = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'higher-day-spending', days: [], sampleDays: [], recordedDays: 9, observedThrough: '2026-01-21' });
    assert.equal((await post(cleared)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('mainnet uses separate credentials and demo namespace without falling back to testnet', async () => {
  const code = 'a'.repeat(43), origin = 'https://coinjar.example';
  const env = { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'testnet-only', MEMWAL_ACCOUNT_ID: 'testnet-account' };
  let called = false;
  const handler = createPhoneWalrusHandler({ env, network: 'mainnet', adapterFactory: async options => {
    called = true;
    assert.deepEqual(options, { key: 'mainnet-only', accountId: 'mainnet-account', serverUrl: 'https://relayer.memory.walrus.xyz', namespace: 'coinjar-hackathon-demo' });
    return { search: async () => ({ results: [] }), list: async () => ({ memories: [{ namespace_id: 'coinjar-hackathon-demo', memory_id: 'm1', blob_id: 'b1' }, { namespace_id: 'other', memory_id: 'm2', blob_id: 'b2' }], has_more: false, must_resync: false }) };
  } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (action = 'recall') => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { authorization: `Bearer ${code}`, origin }, body: JSON.stringify({ action, consent: true }) });
  try {
    assert.equal((await send()).status, 503); assert.equal(called, false);
    env.MEMWAL_MAINNET_PRIVATE_KEY = 'mainnet-only'; env.MEMWAL_MAINNET_ACCOUNT_ID = 'mainnet-account';
    assert.equal((await send()).status, 200); assert.equal(called, true);
    assert.deepEqual(await (await send('listDemo')).json(), { memoryIds: ['m1'] });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('explicit mainnet demo flag pauses testnet before reusing the current key', async () => {
  const code = 'a'.repeat(43), origin = 'https://coinjar.example';
  const env = { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, COINJAR_MAINNET_USE_CURRENT_KEY: '1', MEMWAL_PRIVATE_KEY: 'demo-key', MEMWAL_MAINNET_ACCOUNT_ID: 'mainnet-account', MEMWAL_ACCOUNT_ID: 'testnet-account' };
  let calls = 0;
  const adapterFactory = async options => { calls++; assert.equal(options.key, 'demo-key'); assert.equal(options.accountId, 'mainnet-account'); assert.equal(options.serverUrl, 'https://relayer.memory.walrus.xyz'); return { search: async () => ({ results: [] }) }; };
  const testnet = createServer(createPhoneWalrusHandler({ env, adapterFactory }));
  const mainnet = createServer(createPhoneWalrusHandler({ env, adapterFactory, network: 'mainnet' }));
  await Promise.all([testnet, mainnet].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
  const send = server => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { authorization: `Bearer ${code}`, origin }, body: JSON.stringify({ action: 'recall', consent: true }) });
  try { assert.equal((await send(testnet)).status, 503); assert.equal(calls, 0); assert.equal((await send(mainnet)).status, 200); assert.equal(calls, 1); }
  finally { await Promise.all([testnet, mainnet].map(server => new Promise(resolve => server.close(resolve)))); }
});

test('phone Walrus endpoint restricts access, content and provider responses', async () => {
  const code = 'a'.repeat(43), origin = 'https://coinjar.example';
  let calls = 0, sent, providerResult = { blob_id: 'fictional' };
  const memory = 'COINJAR_PHONE_PREFERENCES_V1 ' + JSON.stringify({ currency: 'PHP', bufferCents: 10, dailyLimitCents: 5, origin: 'manual' });
  const handler = createPhoneWalrusHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'fictional', MEMWAL_ACCOUNT_ID: 'fictional' }, adapterFactory: async options => {
    assert.equal(options.serverUrl, 'https://relayer.dev.memwal.ai');
    return { remember: async (value, options) => { assert.equal(options.dedupe, true); assert.equal(options.idempotencyKey, '8a133cdd-a43b-4c6d-b702-84f6ac690111'); calls++; sent = value; return providerResult; }, search: async () => ({ results: [{ text: memory }, { text: 'untrusted content' }] }) };
  } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (payload, token = code, requestOrigin = origin) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: requestOrigin }, body: JSON.stringify(payload) });
  const write = { action: 'remember', consent: true, operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111', memory };
  try {
    assert.equal((await send(write, 'b'.repeat(43))).status, 401);
    assert.equal((await send(write, code, 'https://evil.example')).status, 401);
    assert.equal((await send({ ...write, consent: false })).status, 400);
    assert.equal((await send({ ...write, memory: memory.replace('"origin":"manual"', '"origin":"manual","transaction":"private"') })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await send(write)).status, 200);
    assert.equal(sent, memory);
    const recall = await send({ action: 'recall', consent: true });
    assert.deepEqual((await recall.json()).memories, [memory]);
    providerResult = {};
    assert.equal((await send(write)).status, 502);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('habit endpoint accepts only aggregate weekend evidence and keeps recall separate', async () => {
  const code = 'b'.repeat(43), origin = 'https://coinjar.example';
  const habit = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'higher-weekend-spending', weekendDays: 3, weekdayDays: 4, observedThrough: '2026-01-10' });
  let sent = '';
  const handler = createPhoneWalrusHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'fictional', MEMWAL_ACCOUNT_ID: 'fictional' }, adapterFactory: async () => ({ remember: async value => { sent = value; return { blob_id: 'mock' }; }, search: async query => { assert.equal(query, 'COINJAR_PHONE_HABIT_V1 '); return { results: [{ text: habit }, { text: habit.replace('"weekdayDays":4', '"weekdayDays":4,"note":"private"') }] }; } }) });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = body => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${code}`, origin }, body: JSON.stringify(body) });
  try {
    const base = { action: 'remember', consent: true, operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111' };
    assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(43)}`, origin }, body: JSON.stringify({ ...base, memory: habit }) })).status, 401);
    assert.equal((await send({ ...base, consent: false, memory: habit })).status, 400);
    assert.equal((await send({ ...base, memory: habit.replace('"weekdayDays":4', '"weekdayDays":4,"amount":1000') })).status, 400);
    assert.equal((await send({ ...base, memory: habit })).status, 200);
    assert.equal(sent, habit);
    assert.deepEqual((await (await send({ action: 'recallHabit', consent: true })).json()).memories, [habit]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('recent spending memory rejects raw amounts and notes at the server boundary', async () => {
  const code = 'c'.repeat(43), origin = 'https://coinjar.example';
  const memory = 'COINJAR_PHONE_HABIT_V1 ' + JSON.stringify({ type: 'recent-spending-spike', recentDays: 3, previousDays: 4, observedThrough: '2026-01-10' });
  let sent = '';
  const handler = createPhoneWalrusHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'fictional', MEMWAL_ACCOUNT_ID: 'fictional' }, adapterFactory: async () => ({ remember: async text => { sent = text; return { blob_id: 'mock' }; }, search: async () => ({ results: [{ text: memory }] }) }) });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = body => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${code}`, origin }, body: JSON.stringify(body) });
  try {
    const base = { action: 'remember', consent: true, operationId: '8a133cdd-a43b-4c6d-b702-84f6ac690111' };
    assert.equal((await send({ ...base, memory: memory.replace('"recentDays":3', '"recentDays":3,"note":"private"') })).status, 400);
    assert.equal((await send({ ...base, memory })).status, 200);
    assert.equal(sent, memory);
    assert.deepEqual((await (await send({ action: 'recallHabit', consent: true })).json()).memories, [memory]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
