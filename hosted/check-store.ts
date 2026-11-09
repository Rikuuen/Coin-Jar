import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { TrackingConflict, TrackingStore } from './store';

const input = createInterface({ input: process.stdin, terminal: false });
const connectionString = await new Promise<string>((resolve) => input.once('line', resolve));
input.close();
const pool = new Pool({ connectionString, max: 4 });
const store = new TrackingStore(pool);
const owner = `test-${randomUUID()}`, other = `test-${randomUUID()}`;
try {
  const id = randomUUID();
  const entry = { kind: 'income' as const, amountCentavos: 50000, date: '2026-11-06', note: 'Synthetic income' };
  const duplicate = await Promise.all([store.addEntry(owner, id, '0', entry), store.addEntry(owner, id, '0', entry)]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  await assert.rejects(store.addEntry(owner, id, '0', { ...entry, amountCentavos: 1 }), TrackingConflict);
  const writes = await Promise.allSettled([
    store.addEntry(owner, randomUUID(), '1', { kind: 'expense', amountCentavos: 15000, date: entry.date, note: '' }),
    store.saveGoal(owner, randomUUID(), '1', { title: 'Emergency', targetCentavos: 100000 }),
  ]);
  assert.equal(writes.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(writes.filter((x) => x.status === 'rejected' && x.reason instanceof TrackingConflict).length, 1);
  const before = await store.snapshot(owner);
  assert.equal(before.revision, '2');
  if (before.goal) await store.addEntry(owner, randomUUID(), '2', { kind: 'expense', amountCentavos: 15000, date: entry.date, note: '' });
  else await store.saveGoal(owner, randomUUID(), '2', { title: 'Emergency', targetCentavos: 100000 });
  const restored = await store.snapshot(owner);
  assert.equal(restored.revision, '3');
  assert.equal(restored.goal.title, 'Emergency');
  assert.deepEqual(restored.entries.map((item) => [item.kind, item.amount_centavos]).sort(), [['expense', '15000'], ['income', '50000']]);
  assert.equal((await store.snapshot(other)).entries.length, 0);
  assert.equal((await store.snapshot(other)).goal, null);
  const db = await pool.connect();
  try {
    const role = await db.query("SELECT rolsuper, rolbypassrls, rolcreaterole, pg_has_role(current_user, 'neon_superuser', 'MEMBER') AS admin_member FROM pg_roles WHERE rolname=current_user");
    assert.equal(role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].rolcreaterole || role.rows[0].admin_member, false);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM coinjar_entries')).rows[0].count, 0);
    await db.query('BEGIN');
    await db.query("SELECT set_config('coinjar.owner', $1, true)", [owner]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM coinjar_entries WHERE owner_id=$1', [other])).rows[0].count, 0);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM coinjar_entries')).rows[0].count, 2);
    await assert.rejects(db.query('INSERT INTO coinjar_entries(id,owner_id,kind,amount_centavos,entry_date) VALUES ($1,$2,$3,$4,$5)', [randomUUID(), other, 'income', 100, entry.date]), (error: unknown) => (error as { code?: string }).code === '42501');
    await db.query('ROLLBACK');
  } finally { db.release(); }
  await assert.rejects(store.addEntry(owner, randomUUID(), '3', { ...entry, amountCentavos: -1 }));
  assert.equal((await store.snapshot(owner)).revision, '3');
  console.log('PASS: idempotent replay, conflicting reuse, concurrent revisions, owner isolation, and invalid amounts');
} finally { await pool.end(); }
