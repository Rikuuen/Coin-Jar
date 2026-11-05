import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createApp } from '../server/app';
import { recommend } from '../src/domain';

test('approved learned preference changes a fresh session after memory restore', async () => {
  let remoteText = '';
  const memory = {
    remember: async (text: string) => {
      remoteText = text;
      return { blob_id: 'test-blob' };
    },
    search: async () => ({
      results: remoteText ? [{ blob_id: 'test-blob', text: remoteText }] : [],
    }),
  };
  async function start() {
    const app = createApp({
      dbPath: ':memory:',
      env: { COINJAR_MODE: 'demo' },
      now: () => new Date('2026-10-30T12:00:00Z'),
      memory,
      fx: { getRate: async () => ({ value: '0.017', basePair: 'USD', symbol: 'PHP', timestamp: Date.parse('2026-10-30T12:00:00Z'), source: 'test' }) },
    });
    await new Promise<void>((resolve) =>
      app.server.listen(0, '127.0.0.1', resolve),
    );
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const initial = await (await fetch(base + '/api/state')).json();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-coinjar-token': initial.csrfToken,
        },
        body: JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, 200, value.error);
      return value;
    };
    return { app, post };
  }
  const first = await start();
  try {
    const demo = await first.post('/api/demo', {});
    assert.ok(recommend(demo.state, demo.today).amountCents > 500);
    await first.post('/api/feedback', {
      action: 'reduce',
      suggestedCents: 1000,
      amountCents: 500,
    });
    const corrected = await first.post('/api/insights/review', {
      id: 'preferred-contribution',
      action: 'correct',
      correction: 'I prefer a different amount.',
    });
    assert.equal(corrected.state.preferences.dailyLimitCents, demo.state.preferences.dailyLimitCents);
    assert.ok(corrected.state.memories.some((m: { text: string; kind: string }) =>
      m.text === 'I prefer a different amount.' && m.kind === 'feedback',
    ));
    assert.equal(remoteText, '');
    const confirmed = await first.post('/api/insights/review', {
      id: 'preferred-contribution',
      action: 'confirm',
    });
    assert.equal(confirmed.state.preferences.dailyLimitCents, 500);
    assert.equal(confirmed.state.preferences.limitProvenance.origin, 'confirmed');
    assert.equal(confirmed.state.preferences.limitProvenance.observations.length, 3);
    const snapshot = confirmed.state.memories.findLast((m: { text: string }) =>
      m.text.startsWith('COINJAR_PREFERENCES_V1 '),
    );
    assert.ok(snapshot && snapshot.approved);
    await first.post('/api/memory/sync', { consent: true, ids: [snapshot.id] });
    assert.ok(remoteText.startsWith('COINJAR_PREFERENCES_V1 '));
  } finally {
    await first.app.close();
  }
  const second = await start();
  try {
    const before = await second.post('/api/demo', {});
    assert.ok(recommend(before.state, before.today).amountCents > 500);
    const restored = await second.post('/api/memory/restore', {
      consent: true,
    });
    assert.equal(restored.state.preferences.dailyLimitCents, 500);
    const recommendation = recommend(restored.state, restored.today);
    assert.equal(recommendation.amountCents, 500);
    assert.match(recommendation.reason, /daily limit/);
    const cap = recommendation.factors.find((factor) => factor.type === 'daily_limit');
    assert.equal(cap?.source, 'walrus');
    assert.equal(cap?.origin, 'confirmed');
    assert.equal(cap?.affected, true);
    assert.equal(cap?.observations?.length, 3);
    assert.ok(recommendation.withoutLimitCents > recommendation.amountCents);
  } finally {
    await second.app.close();
  }
});
