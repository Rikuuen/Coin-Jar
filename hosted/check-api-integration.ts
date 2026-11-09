import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { Pool } from 'pg';
import { createTrackingHandler } from './api';
import { TrackingStore } from './store';

const input = createInterface({ input: process.stdin, terminal: false });
const connectionString = await new Promise<string>((resolve) => input.once('line', resolve));
input.close();
const pool = new Pool({ connectionString, max: 4 });
const sessions = new Map<string, string>();
const handler = createTrackingHandler({ store: new TrackingStore(pool), origin: 'https://coinjar.example', authenticate: async (request) => sessions.get(request.headers.get('cookie') ?? '') });
const request = (path: string, session: string, value?: unknown) => handler(new Request(`https://coinjar.example${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { cookie: session, origin: 'https://coinjar.example', ...(value === undefined ? {} : { 'content-type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }));
try {
  const alice = randomUUID(), bob = randomUUID(), expired = randomUUID();
  sessions.set(alice, `test-${randomUUID()}`); sessions.set(bob, `test-${randomUUID()}`);
  assert.equal((await request('/api/tracking', expired)).status, 401);
  const op = randomUUID();
  const entry = { operationId: op, revision: '0', kind: 'income', amountCentavos: 50000, date: '2026-11-06', note: 'Synthetic' };
  assert.equal((await request('/api/tracking/entries', alice, entry)).status, 200);
  assert.equal((await request('/api/tracking/entries', alice, entry)).status, 200);
  assert.equal((await request('/api/tracking/entries', alice, { ...entry, amountCentavos: 1 })).status, 409);
  assert.equal((await request('/api/tracking/entries', alice, { operationId: randomUUID(), revision: '1', kind: 'expense', amountCentavos: 15000, date: '2026-11-06', note: '' })).status, 200);
  assert.equal((await request('/api/tracking/goal', alice, { operationId: randomUUID(), revision: '2', title: 'Emergency', targetCentavos: 100000 })).status, 200);
  const a = await (await request('/api/tracking', alice)).json(), b = await (await request('/api/tracking', bob)).json();
  assert.equal(a.entries.length, 2); assert.equal(a.goal.title, 'Emergency'); assert.equal(b.entries.length, 0); assert.equal(b.goal, null);
  assert.equal((await request('/api/onchain/intent', alice, {})).status, 404);
  console.log('PASS: mocked session adapter, database isolation, replay handling, and tracking-only routes (not real session validation)');
} finally { await pool.end(); }
