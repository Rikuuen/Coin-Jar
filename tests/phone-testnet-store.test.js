import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createTestnetStore } from '../phone-testnet-store.mjs';

test('testnet store isolates accounts and refuses stale or concurrent writes', async () => {
  const data = new Map(); let revision = 0;
  const blobs = {
    async get(path) {
      const item = data.get(path);
      return item ? { statusCode: 200, stream: new Response(item.json).body, blob: { etag: item.etag, size: item.json.length } } : null;
    },
    async put(path, json, options) {
      const old = data.get(path);
      if (old && (!options.allowOverwrite || options.ifMatch !== old.etag)) throw Error('Conflict');
      if (!old && options.ifMatch) throw Error('Conflict');
      data.set(path, { json, etag: String(++revision) });
    },
  };
  const store = createTestnetStore({ blobs }), first = 'a'.repeat(43), second = 'b'.repeat(43);
  const initial = await store.read(first), competing = await store.read(first);
  await store.write(initial, { version: 1, transfers: [{ id: 'one' }] });
  await assert.rejects(store.write(competing, { version: 1, transfers: [{ id: 'two' }] }), /Conflict/);
  const current = await store.read(first), stale = await store.read(first);
  await store.write(current, { version: 1, transfers: [{ id: 'one', status: 'pending' }] });
  await assert.rejects(store.write(stale, { version: 1, transfers: [] }), /Conflict/);
  assert.deepEqual((await store.read(second)).value.transfers, []);
  assert.equal((await store.read(first)).value.transfers[0].status, 'pending');
  await assert.rejects(store.read('bad'), /Invalid testnet account/);
  const digest = 'A'.repeat(44), id = '12345678-1234-1234-1234-123456789abc';
  await store.claim(first, digest, id);
  await store.claim(first, digest, id);
  await assert.rejects(store.claim(second, digest, id), /already claimed/);
});
