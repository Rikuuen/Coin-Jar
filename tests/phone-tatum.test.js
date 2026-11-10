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

test('testnet requests require a verified personal memory namespace', async () => {
  const origin = 'https://coinjar.example', shared = 's'.repeat(43), personal = 'p'.repeat(43);
  let calls = 0;
  const env = { COINJAR_PHONE_ACCESS_CODE: shared, COINJAR_PHONE_ORIGIN: origin, TATUM_API_KEY: 'fake', MEMWAL_MAINNET_PRIVATE_KEY: 'fake', MEMWAL_MAINNET_ACCOUNT_ID: 'fake' };
  const handler = createPhoneTatumHandler({ env, memoryFactory: async ({ namespace }) => ({ list: async () => ({ memories: namespace === personalNamespace(personal, true) ? [{ namespace_id: namespace, blob_id: 'blob' }] : [], has_more: false }) }), testnetHandler: async (code, input) => { calls++; assert.equal(code, personal); assert.equal(input.action, 'state'); return { state: { onchainTransfers: [] } }; } });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (code, personalHeader = true, requestOrigin = origin) => fetch(`http://127.0.0.1:${server.address().port}/api/phone/testnet`, { method: 'POST', headers: { origin: requestOrigin, authorization: `Bearer ${code}`, ...(personalHeader ? { 'x-coinjar-memory-user': '1', 'x-coinjar-memory-demo': '1' } : {}) }, body: JSON.stringify({ action: 'state' }) });
  try {
    assert.equal((await send(shared, false)).status, 401);
    assert.equal((await send('q'.repeat(43))).status, 401);
    assert.equal((await send(personal, true, 'https://evil.example')).status, 401);
    assert.equal(calls, 0);
    assert.equal((await send(personal)).status, 200);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('transaction lookup reports only the linked wallet net changes and rejects unconfirmed or invalid provider data', async () => {
  const code = 'a'.repeat(43), origin = 'https://coinjar.example', address = '0x' + '1'.repeat(64), other = '0x' + '2'.repeat(64), digest = 'A'.repeat(44);
  let tx = { network: 'mainnet', digest, success: true, checkpoint: '123', balanceChanges: [{ address, coinType: '0x2::sui::SUI', amount: '1000000000' }, { address, coinType: '0x2::sui::SUI', amount: '-10' }, { address: other, coinType: '0x2::sui::SUI', amount: '-1000000000' }] };
  let calls = 0;
  const server = createServer(createPhoneTatumHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, TATUM_API_KEY: 'secret' }, adapterFactory: async () => ({ getTransaction: async value => { calls++; assert.equal(value, digest); return tx; } }) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const send = (body, token = code) => fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { origin, authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await send({ address, digest }, 'b'.repeat(43))).status, 401);
    assert.equal((await send({ address, digest: 'bad' })).status, 400);
    assert.equal((await send({ address, digest, extra: true })).status, 400);
    assert.equal(calls, 0);
    let result = await (await send({ address, digest })).json();
    assert.deepEqual(result, { network: 'mainnet', digest, status: 'success', checkpoint: '123', address, changes: [{ coinType: '0x2::sui::SUI', amount: '999999990' }] });
    tx = { ...tx, success: false }; result = await (await send({ address, digest })).json(); assert.equal(result.status, 'failed');
    for (const invalid of [{ success: null }, { checkpoint: null }, { digest: 'B'.repeat(44) }, { network: 'testnet' }, { balanceChanges: null }, { balanceChanges: [{ address, coinType: 'invalid', amount: '1' }] }]) {
      const original = tx; tx = { ...tx, ...invalid }; assert.equal((await send({ address, digest })).status, 502); tx = original;
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
