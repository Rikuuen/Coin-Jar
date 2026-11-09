import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('offline recovery key generation creates a unique key without printing or overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coinjar-key-test-'));
  const path = join(dir, 'synthetic-key.txt');
  try {
    const run = () => spawnSync(process.execPath, ['hosted/generate-recovery-key.mjs', path], { encoding: 'utf8' });
    const first = run();
    assert.equal(first.status, 0);
    const key = (await readFile(path, 'utf8')).trim();
    assert.match(key, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.equal(first.stdout.includes(key), false);
    assert.notEqual(run().status, 0);
    assert.equal((await readFile(path, 'utf8')).trim(), key);
    const unsafe = spawnSync(process.execPath, ['hosted/generate-recovery-key.mjs', join(process.cwd(), 'unsafe-test-key.txt')], { encoding: 'utf8' });
    assert.notEqual(unsafe.status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
