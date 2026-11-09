import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { Pool } from 'pg';
import { TrackingStore } from './store';
import { decryptArchive, encryptArchive, exportJournal, restoreJournal } from './recovery';
import { hostedSavings } from '../src/hostedSavings';
import { backupJournal } from './backup';

const id = randomBytes(6).toString('hex');
const names = [`coinjar_recovery_source_${id}`, `coinjar_recovery_target_${id}`];
const admin = new Pool({ connectionString: 'postgresql://coinjar_test@127.0.0.1:55449/postgres', max: 1 });
const created: string[] = [];
const clients: Pool[] = [];
try {
  const path = String((await admin.query('SHOW data_directory')).rows[0].data_directory);
  assert.equal(resolve(path).toLowerCase(), resolve('.data/hosted-postgres-test').toLowerCase(), 'Wrong local PostgreSQL cluster');
  for (const name of names) {
    assert.match(name, /^coinjar_recovery_(source|target)_[0-9a-f]{12}$/);
    await admin.query(`CREATE DATABASE ${name}`); created.push(name);
    const setup = new Pool({ connectionString: `postgresql://coinjar_test@127.0.0.1:55449/${name}`, max: 1 });
    try {
      for (const migration of ['001_tracking.sql', '002_owner_policies.sql', '003_savings.sql', '004_memory.sql']) await setup.query(await readFile(`hosted/migrations/${migration}`, 'utf8'));
      await setup.query('GRANT SELECT, INSERT, UPDATE ON public.coinjar_journals, public.coinjar_entries, public.coinjar_goals, public.coinjar_operations, public.coinjar_memory_sync TO local_coinjar_runtime');
      await setup.query('GRANT SELECT, INSERT ON public.coinjar_entry_voids TO local_coinjar_runtime');
    } finally { await setup.end(); }
    clients.push(new Pool({ connectionString: `postgresql://local_coinjar_runtime@127.0.0.1:55449/${name}`, max: 1 }));
  }
  const [source, target] = clients;
  const originalOwner = `synthetic-${randomUUID()}`, recoveredOwner = originalOwner;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const store = new TrackingStore(source);
  await store.setup(originalOwner, randomUUID(), '0', { currency: 'USD', openingCashCents: 100000, openingCashDate: today });
  const entry = await store.addEntry(originalOwner, randomUUID(), '1', { kind: 'expense', amountCentavos: 2400, date: today, note: 'synthetic recovery test' });
  await store.saveGoal(originalOwner, randomUUID(), '2', { title: 'synthetic goal', targetCentavos: 200000 });
  await store.voidEntry(originalOwner, randomUUID(), '3', { entryId: entry.id, reason: 'synthetic correction', replacement: { kind: 'expense', amountCentavos: 1200, date: today, note: 'synthetic replacement' } });
  await store.addBill(originalOwner, randomUUID(), '4', { title: 'synthetic bill', amountCents: 3000, dueDate: today });
  const otherOwner = `synthetic-${randomUUID()}`;
  await store.setup(otherOwner, randomUUID(), '0', { currency: 'PHP', openingCashCents: 1234, openingCashDate: today });
  await store.addEntry(otherOwner, randomUUID(), '1', { kind: 'income', amountCentavos: 100, date: today, note: 'other owner private test' });
  const archive = await exportJournal(source, originalOwner);
  assert.equal(JSON.stringify(archive).includes('other owner private test'), false);
  const key = randomBytes(32), encrypted = encryptArchive(archive, key);
  const saved = new Map<string, Buffer>();
  const storage = { async write(path: string, data: Buffer) { saved.set(path, data); }, async read(path: string) { return saved.get(path)!; }, async list() { return []; }, async remove() { throw new Error('Unexpected deletion'); } };
  const backup = await backupJournal(source, originalOwner, key, storage);
  assert.equal(backup.revision, '5');
  assert.equal(backup.path.includes(originalOwner), false);
  assert.deepEqual(decryptArchive(saved.get(backup.path)!, key), archive);
  let removed: string[] = [];
  const retention = { ...storage, async list(prefix: string) { return [{ path: `${prefix}2020-01-01/0b3dfaa2-6fd0-40f3-885d-5439d4982d2a.enc`, uploadedAt: new Date('2020-01-01T00:00:00Z') }, { path: 'other-owner/2020-01-01/0b3dfaa2-6fd0-40f3-885d-5439d4982d2a.enc', uploadedAt: new Date('2020-01-01T00:00:00Z') }]; }, async remove(paths: string[]) { removed = paths; } };
  await backupJournal(source, originalOwner, key, retention);
  assert.equal(removed.length, 1);
  assert.match(removed[0], /^coinjar\//);
  removed = [];
  await assert.rejects(backupJournal(source, originalOwner, key, { ...retention, async read() { return Buffer.from('corrupt'); } }), /verification failed/);
  assert.deepEqual(removed, []);
  await assert.rejects(backupJournal(source, originalOwner, key, { ...storage, async read() { return Buffer.from('corrupt'); } }), /verification failed/);
  await assert.rejects(backupJournal(source, originalOwner, key, { ...storage, async write() { throw new Error('unavailable'); } }), /unavailable/);
  assert.equal(encrypted.includes(Buffer.from('synthetic replacement')), false);
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptArchive(tampered, key));
  assert.throws(() => decryptArchive(encrypted, randomBytes(32)));
  await assert.rejects(restoreJournal(target, archive, `synthetic-${randomUUID()}`), /owner does not match/);
  await restoreJournal(target, decryptArchive(encrypted, key), recoveredOwner);
  const recovered = await exportJournal(target, recoveredOwner);
  assert.equal(recovered.rows.coinjar_journals[0].preferences && (recovered.rows.coinjar_journals[0].preferences as { currency: string }).currency, 'USD');
  assert.equal(recovered.rows.coinjar_entries.length, 2);
  assert.equal(recovered.rows.coinjar_goals.length, 1);
  assert.equal(recovered.rows.coinjar_entry_voids.length, 1);
  assert.equal(recovered.rows.coinjar_operations.length, 5);
  assert.deepEqual(recovered.rows.coinjar_journals[0].bills, archive.rows.coinjar_journals[0].bills);
  for (const table of Object.keys(archive.rows) as Array<keyof typeof archive.rows>) {
    const expected = archive.rows[table].map(row => JSON.stringify({ ...row, owner_id: recoveredOwner })).sort();
    const actual = recovered.rows[table].map(row => JSON.stringify(row)).sort();
    assert.deepEqual(actual, expected, `Restored ${table} must match the original`);
  }
  assert.deepEqual(hostedSavings(await new TrackingStore(target).snapshot(recoveredOwner), today).summary, hostedSavings(await store.snapshot(originalOwner), today).summary);
  await assert.rejects(restoreJournal(target, archive, recoveredOwner), /not empty/);
  assert.deepEqual(await exportJournal(target, recoveredOwner), recovered);
  console.log('PASS: encrypted synthetic journal restored into a separate local database; corrections, settings, bills and operations survived; wrong owner, tampering and overwrite were rejected');
} finally {
  await Promise.all(clients.map(client => client.end()));
  for (const name of created) await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
}
