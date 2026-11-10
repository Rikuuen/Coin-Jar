import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findMatchingReceipts } from '../server/integrations/sui-transaction-index.js';

test('index search finds unique matching receipts across pages and rejects incomplete data', async () => {
  const address = '0x' + '2'.repeat(64), coinType = 'coin', since = Date.parse('2026-11-10T10:00:00Z');
  const node = (digest, time, amount, status = 'SUCCESS') => ({ digest: digest.repeat(44), effects: { timestamp: time, status, balanceChangesJson: [{ address, coinType, amount }] } });
  const pages = [
    { nodes: [node('A', '2026-11-10T10:03:00Z', '100'), node('B', '2026-11-10T10:04:00Z', '99')], pageInfo: { hasPreviousPage: true, startCursor: 'page-2' } },
    { nodes: [node('C', '2026-11-10T09:59:00Z', '100')], pageInfo: { hasPreviousPage: true, startCursor: 'page-3' } },
  ];
  let calls = 0;
  const fetcher = async () => ({ ok: true, json: async () => ({ data: { transactions: pages[calls++] } }) });
  assert.deepEqual(await findMatchingReceipts({ address, coinType, amount: '100', since, fetcher }), ['A'.repeat(44)]);
  assert.equal(calls, 2);
  const ambiguous = { nodes: [node('A', '2026-11-10T10:03:00Z', '100'), node('B', '2026-11-10T10:04:00Z', '100')], pageInfo: { hasPreviousPage: false } };
  assert.equal((await findMatchingReceipts({ address, coinType, amount: '100', since, fetcher: async () => ({ ok: true, json: async () => ({ data: { transactions: ambiguous } }) }) })).length, 2);
  await assert.rejects(findMatchingReceipts({ address, coinType, amount: '100', since, fetcher: async () => ({ ok: true, json: async () => ({ errors: [{ message: 'unavailable' }] }) }) }));
  await assert.rejects(findMatchingReceipts({ address, coinType, amount: '100', since, fetcher: async () => ({ ok: true, json: async () => ({ data: { transactions: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: 'same' } } } }) }) }));
});
