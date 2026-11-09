import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { backupCron } from '../hosted/backup-cron';

test('backup cron requires a secret and a valid backup key, and reports failures', async () => {
  const secret = 'a'.repeat(32), key = randomBytes(32);
  const env = { CRON_SECRET: secret, COINJAR_BACKUP_OWNER: 'synthetic-owner', COINJAR_BACKUP_KEY: key.toString('base64') };
  const request = (token: string) => new Request('https://coinjar.example/api/backup-cron', { headers: { authorization: token } });
  let calls = 0;
  const run = async (owner: string, supplied: Buffer) => { calls++; assert.equal(owner, env.COINJAR_BACKUP_OWNER); assert.deepEqual(supplied, key); };
  assert.equal((await backupCron(request(''), env, run)).status, 401);
  assert.equal((await backupCron(request(`Bearer ${secret}`), { ...env, COINJAR_BACKUP_KEY: 'invalid' }, run)).status, 503);
  assert.equal(calls, 0);
  assert.equal((await backupCron(request(`Bearer ${secret}`), env, run)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await backupCron(request(`Bearer ${secret}`), env, async () => { throw new Error('secret provider detail'); })).status, 503);
});
