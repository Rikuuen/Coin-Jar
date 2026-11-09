import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { createTrackingHandler } from '../hosted/api';
import { neonSessionAuthenticator } from '../hosted/auth';
import { NEON_AUTH_SESSION_COOKIE_NAME } from '@neon/auth/server';
import { TrackingConflict, type TrackingStore } from '../hosted/store';

test('hosted routes derive the owner from the verified session and reject untrusted requests', async () => {
  const calls: unknown[] = [];
  const store = {
    snapshot: async (owner: string) => { calls.push(owner); return { entries: [], revision: '0', goal: null }; },
    addEntry: async (owner: string, id: string, revision: string, input: unknown) => { calls.push({ owner, id, revision, input }); return { id, revision: '1' }; },
    saveGoal: async () => { throw new TrackingConflict('Journal changed; refresh before saving'); },
  } as unknown as TrackingStore;
  const handler = createTrackingHandler({ store, origin: 'https://coinjar.example', authenticate: async (request) => request.headers.get('cookie') === 'session=valid' ? 'account-a' : undefined });
  const request = (path: string, token?: string, payload?: unknown, origin = 'https://coinjar.example') => new Request(`https://coinjar.example${path}`, {
    method: payload === undefined ? 'GET' : 'POST', headers: { ...(token ? { cookie: `session=${token}` } : {}), origin, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  assert.equal((await handler(request('/api/tracking'))).status, 401);
  assert.equal((await handler(new Request('https://coinjar.example/api/tracking', { headers: { authorization: 'Bearer valid' } }))).status, 401);
  assert.equal((await handler(request('/api/tracking', 'expired'))).status, 401);
  assert.equal((await handler(request('/api/tracking', 'valid', undefined, 'https://evil.example'))).status, 403);
  assert.equal((await handler(request('/api/tracking', 'valid'))).status, 200);
  assert.equal(calls[0], 'account-a');
  const input = { owner: 'account-b', operationId: 'op', revision: '0', kind: 'income', amountCentavos: 50000, date: '2026-11-06', note: '' };
  assert.equal((await handler(request('/api/tracking/entries', 'valid', input))).status, 200);
  assert.equal((calls[1] as { owner: string }).owner, 'account-a');
  assert.equal((await handler(request('/api/tracking/goal', 'valid', { operationId: 'op', revision: '0', title: 'Goal', targetCentavos: 100 }))).status, 409);
  assert.equal((await handler(request('/api/onchain/intent', 'valid', input))).status, 404);
  assert.equal((await handler(new Request('https://coinjar.example/api/tracking/entries', { method: 'DELETE', headers: { cookie: 'session=valid', origin: 'https://coinjar.example' } }))).status, 404);
  assert.equal((await handler(request('/api/tracking/entries', 'valid', { ...input, note: 'x'.repeat(5000) }))).status, 400);
});

test('backup status uses the authenticated account and rejects anonymous requests', async () => {
  const seen: string[] = [];
  const handler = createTrackingHandler({ store: {} as TrackingStore, origin: 'https://coinjar.example', authenticate: async request => request.headers.get('cookie') ?? undefined, backupStatus: async owner => { seen.push(owner); return owner === 'account-a' ? { savedAt: '2026-01-01T00:00:00.000Z', revision: '4' } : null; } });
  const request = (cookie?: string) => new Request('https://coinjar.example/api/tracking/backup?owner=account-a', { headers: cookie ? { cookie } : {} });
  assert.equal((await handler(request())).status, 401);
  assert.deepEqual(await (await handler(request('account-b'))).json(), { backup: null });
  assert.deepEqual(await (await handler(request('account-a'))).json(), { backup: { savedAt: '2026-01-01T00:00:00.000Z', revision: '4' } });
  assert.deepEqual(seen, ['account-b', 'account-a']);
});

test('protected APIs check the provider session on every request and preserve other sessions', async () => {
  const sessions = new Map([['device-a', 'user-a'], ['device-b', 'user-a'], ['other', 'user-b'], ['expired', 'user-a'], ['mismatch', 'user-a']]);
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.ok(req.url?.includes('disableCookieCache=true'));
    const value = (req.headers.cookie ?? '').split('=')[1];
    const owner = sessions.get(value);
    res.setHeader('Content-Type', 'application/json');
    if (value === 'outage') { res.writeHead(503).end(); return; }
    res.end(JSON.stringify(owner ? { user: { id: owner }, session: { userId: value === 'mismatch' ? 'user-b' : owner, expiresAt: new Date(Date.now() + (value === 'expired' ? -60000 : 60000)).toISOString() } } : null));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  try {
    const authenticate = neonSessionAuthenticator(url, 'https://coinjar.example');
    const request = (session?: string) => new Request('https://coinjar.example/api/tracking', { headers: { ...(session ? { cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=${session}` } : {}), authorization: 'Bearer ignored-token' } });
    assert.equal(await authenticate(request()), undefined);
    assert.equal(await authenticate(request('device-a')), 'user-a');
    assert.equal(await authenticate(request('device-b')), 'user-a');
    assert.equal(await authenticate(request('other')), 'user-b');
    assert.equal(await authenticate(request('expired')), undefined);
    assert.equal(await authenticate(request('mismatch')), undefined);
    await assert.rejects(authenticate(request('outage')));
    sessions.delete('device-a');
    assert.equal(await authenticate(request('device-a')), undefined);
    assert.equal(await authenticate(request('device-b')), 'user-a');
    assert.equal(await authenticate(new Request('https://coinjar.example/api/tracking', { headers: { cookie: `${NEON_AUTH_SESSION_COOKIE_NAME}=device-b; ${NEON_AUTH_SESSION_COOKIE_NAME}=device-a` } })), undefined);
  } finally { await new Promise<void>((resolve) => upstream.close(() => resolve())); }
});
