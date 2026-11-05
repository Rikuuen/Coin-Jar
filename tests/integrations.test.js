import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAdapter } from '../server/integrations/walrus.js';
import { createTatumAdapter } from '../server/integrations/tatum.js';
import {
  createFxAdapter,
  phpCentavosToUsdMicrodollars,
} from '../server/integrations/fx.js';

test('Tatum FX validates quotes and converts PHP to USD exactly', async () => {
  const now = 2000000000000;
  const quote = {
    value: '0.01570228',
    basePair: 'USD',
    symbol: 'PHP',
    timestamp: now - 1000,
    source: 'Fixer.io',
  };
  let received;
  const adapter = createFxAdapter({
    apiKey: 'secret',
    now: () => now,
    fetch: async (...args) => {
      received = args;
      return { ok: true, json: async () => quote };
    },
  });
  assert.deepEqual(await adapter.getRate(), quote);
  assert.match(received[0], /symbol=PHP&basePair=USD/);
  assert.equal(received[1].headers['x-api-key'], 'secret');
  assert.equal(phpCentavosToUsdMicrodollars('10000', quote.value), '1570228');
  assert.equal(phpCentavosToUsdMicrodollars('1', '0.00005'), '1');
  assert.equal(
    phpCentavosToUsdMicrodollars('9007199254740993', '1'),
    '90071992547409930000',
  );
  assert.throws(() => phpCentavosToUsdMicrodollars('-1', '1'), /Invalid PHP/);
  for (const changed of [
    { value: '0' },
    { value: 'NaN' },
    { symbol: 'USD' },
    { basePair: 'PHP' },
    { timestamp: now + 1 },
    { timestamp: now - 86400001 },
  ]) {
    const invalid = createFxAdapter({
      apiKey: 'secret',
      now: () => now,
      fetch: async () => ({
        ok: true,
        json: async () => ({ ...quote, ...changed }),
      }),
    });
    await assert.rejects(invalid.getRate());
  }
  const failed = createFxAdapter({
    apiKey: 'secret',
    fetch: async () => {
      throw new Error('secret');
    },
  });
  await assert.rejects(failed.getRate(), {
    message: 'Exchange rate service unavailable',
  });
  assert.throws(() => createFxAdapter(), /not configured/);
});

test('Walrus uses the selected namespace and preserves pagination', async () => {
  const calls = [];
  const client = {
    rememberAndWait: async (...args) => {
      calls.push(args);
      return {
        id: 'id',
        job_id: 'id',
        blob_id: 'blob',
        owner: 'owner',
        namespace: 'savings',
      };
    },
    recall: async (arg) => {
      calls.push(arg);
      return {
        results: [{ blob_id: 'blob', text: 'goal', distance: 0.1 }],
        total: 1,
        dropped_count: 1,
      };
    },
    listMemories: async (arg) => {
      calls.push(arg);
      return { memories: [], has_more: true };
    },
  };
  const memory = await createMemoryAdapter({ client, namespace: 'savings' });
  assert.equal((await memory.remember('goal')).blob_id, 'blob');
  const result = await memory.search('goal', 5);
  assert.equal(result.results[0].text, 'goal');
  assert.equal(result.dropped_count, 1);
  assert.equal((await memory.list({ cursor: 'next' })).has_more, true);
  assert.deepEqual(calls, [
    ['goal', 'savings'],
    { query: 'goal', namespace: 'savings', limit: 5 },
    { cursor: 'next', namespace: 'savings' },
  ]);
  await assert.rejects(createMemoryAdapter(), /not configured/);
  const failure = new Error('SDK failed');
  const broken = await createMemoryAdapter({
    client: {
      rememberAndWait: async () => {
        throw failure;
      },
      recall: async () => {
        throw failure;
      },
      listMemories: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(broken.remember('goal'), failure);
  await assert.rejects(broken.search('goal'), failure);
  await assert.rejects(broken.list(), failure);
});

test('Tatum preserves exact base units and rejects invalid inputs', async () => {
  const address = `0x${'a'.repeat(64)}`;
  const calls = [];
  const adapter = await createTatumAdapter({
    client: {
      getBalance: async (arg) => {
        calls.push(arg);
        return { balance: { balance: '9007199254740993' } };
      },
    },
  });
  assert.equal(
    (await adapter.getBalance(address)).balanceMist,
    '9007199254740993',
  );
  assert.deepEqual(calls[0], { owner: address, coinType: '0x2::sui::SUI' });
  await assert.rejects(adapter.getBalance('bad'), /Invalid Sui address/);
  const bad = await createTatumAdapter({
    client: { getBalance: async () => ({ balance: { balance: '-1' } }) },
  });
  await assert.rejects(bad.getBalance(address), /Invalid balance response/);
  const numeric = await createTatumAdapter({
    client: { getBalance: async () => ({ balance: { balance: 1 } }) },
  });
  await assert.rejects(numeric.getBalance(address), /Invalid balance response/);
  await assert.rejects(createTatumAdapter(), /not configured/);
  await assert.rejects(
    createTatumAdapter({ network: 'devnet', client: {} }),
    /Unsupported/,
  );
  const failure = new Error('RPC failed');
  const broken = await createTatumAdapter({
    client: {
      getBalance: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(broken.getBalance(address), failure);
});

test('installed gRPC SDK and transport construct without a network call', async () => {
  const adapter = await createTatumAdapter({
    apiKey: 'test-only',
    network: 'testnet',
  });
  assert.equal(typeof adapter.getBalance, 'function');
});
