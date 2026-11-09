import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createPhoneTatumHandler } from '../phone-tatum.mjs';
import { personalNamespace } from '../phone-walrus.mjs';

test('wallet accepts a personal code only when its Walrus namespace contains a saved memory', async () => {
  const origin = 'https://coinjar.example', shared = 's'.repeat(43), personal = 'p'.repeat(43), address = '0x' + '1'.repeat(64);
  const env = { COINJAR_PHONE_ACCESS_CODE: shared, COINJAR_PHONE_ORIGIN: origin, TATUM_API_KEY: 'tatum', MEMWAL_MAINNET_PRIVATE_KEY: 'mock', MEMWAL_MAINNET_ACCOUNT_ID: 'account' };
  let balanceCalls = 0, fail = false;
  const handler = createPhoneTatumHandler({ env, memoryFactory: async ({ namespace }) => ({ list: async () => {
    if (fail) throw Error('provider unavailable');
    return { memories: namespace === personalNamespace(personal, true) ? [{ namespace_id: namespace, blob_id: 'blob' }] : [], has_more: false };
  } }), adapterFactory: async () => ({ getBalance: async () => { balanceCalls++; return { network: 'mainnet', coinType: '0x2::sui::SUI', balanceMist: '123' }; } }) });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (token, demo = true, host = origin) => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { origin: host, authorization: `Bearer ${token}`, 'x-coinjar-memory-user': '1', ...(demo ? { 'x-coinjar-memory-demo': '1' } : {}) }, body: JSON.stringify({ address }) });
  try {
    assert.equal((await send(personal)).status, 200);
    assert.equal((await send('q'.repeat(43))).status, 401);
    assert.equal((await send(personal, false)).status, 401);
    assert.equal((await send(personal, true, 'https://evil.example')).status, 401);
    assert.equal(balanceCalls, 1);
    fail = true; assert.equal((await send(personal)).status, 502); assert.equal(balanceCalls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('phone wallet balance protects the Tatum key and accepts only read-only mainnet requests', async () => {
  const code = 'a'.repeat(43), origin = 'https://coinjar.example', address = '0x' + '1'.repeat(64);
  let calls = 0, fail = false;
  const handler = createPhoneTatumHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, TATUM_API_KEY: 'test-only' }, adapterFactory: async options => {
    assert.deepEqual(options, { apiKey: 'test-only', network: 'mainnet' });
    return { getBalance: async value => { calls++; assert.equal(value, address); if (fail) throw Error('provider unavailable'); return { network: 'mainnet', coinType: '0x2::sui::SUI', balanceMist: '1234567890' }; } };
  } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (body, token = code, requestOrigin = origin) => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: requestOrigin }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await send({ address }, 'b'.repeat(43))).status, 401);
    assert.equal((await send({ address }, code, 'https://evil.example')).status, 401);
    assert.equal((await send({ address: 'invalid' })).status, 400);
    assert.equal((await send({ address, action: 'transfer' })).status, 400);
    assert.equal(calls, 0);
    const response = await send({ address });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.balanceMist, '1234567890'); assert.equal(result.network, 'mainnet');
    assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
    assert.equal(JSON.stringify(result).includes('test-only'), false);
    fail = true;
    assert.equal((await send({ address })).status, 502);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('wallet lookup is unavailable when the Tatum key is missing', async () => {
  const server = createServer(createPhoneTatumHandler({ env: { COINJAR_PHONE_ACCESS_CODE: 'a'.repeat(43), COINJAR_PHONE_ORIGIN: 'https://coinjar.example' } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal((await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST' })).status, 503); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
