import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { backupStatus } from '../hosted/backup';
import { encryptArchive, type JournalArchive } from '../hosted/recovery';

test('backup status authenticates the latest owner-scoped archive and fails closed on corruption', async () => {
  const key = randomBytes(32), owner = 'synthetic-owner';
  const archive: JournalArchive = { version: 1, owner, rows: { coinjar_journals: [{ owner_id: owner, revision: '4' }], coinjar_entries: [], coinjar_goals: [], coinjar_operations: [], coinjar_entry_voids: [], coinjar_memory_sync: [] } };
  let data = encryptArchive(archive, key);
  const savedAt = new Date('2026-01-01T00:00:00Z');
  const storage = { async list(prefix: string) { return [{ path: `${prefix}2026-01-01/0b3dfaa2-6fd0-40f3-885d-5439d4982d2a.enc`, uploadedAt: savedAt }]; }, async read() { return data; } };
  assert.deepEqual(await backupStatus(owner, key, storage), { savedAt: savedAt.toISOString(), revision: '4' });
  await assert.rejects(backupStatus('another-owner', key, storage));
  data = Buffer.from('corrupt');
  await assert.rejects(backupStatus(owner, key, storage));
  assert.equal(await backupStatus(owner, key, { ...storage, async list() { return []; } }), null);
});
