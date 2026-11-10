import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { transferAuth } from '../src/phoneTransferAuth';

test('pending wallet identity survives memory setting changes without storing the recovery key', async () => {
  const items = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) } });
  const recoveryKey = 'A'.repeat(43);
  const [first, concurrent] = await Promise.all([transferAuth('', false, recoveryKey), transferAuth('p'.repeat(43), true, recoveryKey)]);
  assert.deepEqual(first, concurrent);
  assert.notEqual(first.token, recoveryKey);
  assert.equal(first.headers['x-coinjar-recovery'], '1');
  const after = await transferAuth('p'.repeat(43), true, recoveryKey);
  assert.deepEqual(after, first);
  assert.equal([...items.values()].some(value => value.includes(recoveryKey)), false);
  items.set('coinjar.phone.testnet.auth.v1', '{bad');
  await assert.rejects(transferAuth('p'.repeat(43), true, recoveryKey));
});
