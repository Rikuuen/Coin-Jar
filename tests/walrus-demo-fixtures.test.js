import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createPhoneWalrusHandler } from '../phone-walrus.mjs';

test('ten fictional demo memories match the existing phone memory schema', async () => {
  const fixture = JSON.parse(await readFile(new URL('../demo/walrus-mainnet-memories.json', import.meta.url), 'utf8'));
  assert.match(fixture.description, /Fictional/);
  assert.equal(fixture.memories.length, 10);
  let writes = 0;
  const code = 'a'.repeat(43), origin = 'https://coinjar.example';
  const handler = createPhoneWalrusHandler({ env: { COINJAR_PHONE_ACCESS_CODE: code, COINJAR_PHONE_ORIGIN: origin, MEMWAL_PRIVATE_KEY: 'mock', MEMWAL_ACCOUNT_ID: 'mock' }, adapterFactory: async () => ({ remember: async () => { writes++; return { blob_id: 'mock' }; } }) });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const payloads = fixture.memories.map(({ kind, ...data }) => (kind === 'preferences' ? 'COINJAR_PHONE_PREFERENCES_V1 ' : 'COINJAR_PHONE_HABIT_V1 ') + JSON.stringify(data));
    assert.equal(new Set(payloads).size, 10);
    for (const memory of payloads) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { authorization: `Bearer ${code}`, origin }, body: JSON.stringify({ action: 'remember', consent: true, operationId: randomUUID(), memory }) });
      assert.equal(response.status, 200);
    }
    assert.equal(writes, 10);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
