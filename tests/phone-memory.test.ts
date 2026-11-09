import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { newJournal } from '../src/phoneJournal';
import { applyPreferenceMemory, preferenceMemory } from '../src/phoneMemory';
import { createMemoryAdapter } from '../server/integrations/walrus.js';
import { detectedDailyHabit, detectedSpikeHabit, dailyHabitMemory, spikeMemory, nextDay, parseDailyHabitMemory, parseSpikeMemory } from '../src/phoneHabit';
import { savings } from '../src/phoneJournal';

test('Walrus preference snapshots exclude transactions and restore only compatible settings', async () => {
  const journal = newJournal('PHP', 100000, '2026-01-01');
  journal.entries.push({ id: 'entry', kind: 'expense', amountCents: 5000, note: 'private lunch', date: '2026-01-01', createdAt: '' });
  journal.bufferCents = 1234; journal.dailyLimitCents = 567;
  const texts: string[] = [];
  const adapter = await createMemoryAdapter({ namespace: 'synthetic-test', client: { rememberAndWait: async (text: string, namespace: string, options: { idempotencyKey: string }) => { assert.equal(namespace, 'synthetic-test'); assert.equal(options.idempotencyKey, 'synthetic-operation'); texts.push(text); return { blobId: 'mock' }; }, recall: async () => texts } });
  await adapter.remember(preferenceMemory(journal), { idempotencyKey: 'synthetic-operation' });
  assert.equal(texts[0].includes('private lunch'), false);
  assert.equal(texts[0].includes('100000'), false);
  assert.equal(texts[0].includes('5000'), false);
  const fresh = newJournal('PHP', 50, '2026-01-01');
  const applied = applyPreferenceMemory(fresh, texts[0]);
  assert.equal(applied.bufferCents, fresh.bufferCents);
  assert.equal(applied.dailyLimitCents, fresh.dailyLimitCents);
  assert.equal(texts[0].includes('bufferCents'), false);
  assert.equal(texts[0].includes('dailyLimitCents'), false);
  assert.equal(applied.openingCents, 50);
  assert.deepEqual(applied.entries, []);
  assert.throws(() => applyPreferenceMemory(newJournal('USD', 0, '2026-01-01'), texts[0]));
  assert.throws(() => applyPreferenceMemory(fresh, 'COINJAR_PHONE_PREFERENCES_V1 {"currency":"PHP","origin":"manual","bufferCents":-1,"dailyLimitCents":0}'));
  assert.throws(() => applyPreferenceMemory(fresh, 'bad'));
});

test('recent spending memory is aggregate and does not invent amounts on a fresh device', () => {
  const journal = newJournal('PHP', 100000, '2026-01-01');
  journal.bufferCents = 0; journal.dailyLimitCents = 10000;
  journal.goal = { id: 'g', title: 'Test goal', targetCents: 100000, targetDate: '2026-01-22', status: 'active', createdAt: '' };
  const dates = ['2026-01-13', '2026-01-14', '2026-01-15', '2026-01-06', '2026-01-07', '2026-01-08'];
  journal.entries = dates.map((date, index) => ({ id: `e${index}`, kind: 'expense', amountCents: index < 3 ? 2000 : 500, note: 'private lunch', date, createdAt: '' }));
  const habit = detectedSpikeHabit(journal, '2026-01-15');
  assert.ok(habit);
  const text = spikeMemory(habit);
  assert.equal(text.includes('private lunch'), false);
  assert.equal(text.includes('2000'), false);
  assert.deepEqual(parseSpikeMemory(text, '2026-01-15'), habit);
  assert.ok(parseSpikeMemory(text, '2026-01-21'));
  assert.equal(parseSpikeMemory(text, '2026-01-22'), null);
  assert.equal(parseSpikeMemory(text.replace('"recentDays":3', '"recentDays":3,"amount":2000'), '2026-01-15'), null);
  const fresh = newJournal('PHP', 100000, '2026-01-01');
  fresh.bufferCents = 0; fresh.dailyLimitCents = 10000; fresh.goal = journal.goal;
  assert.equal(savings(fresh, '2026-01-13').recommendation.amountCents, 10000);
  const result = savings(fresh, '2026-01-13', [], true).recommendation;
  assert.equal(result.amountCents, 10000);
  assert.match(result.reason, /not enough local expense history/);
  assert.equal(savings(fresh, '2026-01-17', [6], true).recommendation.amountCents, savings(fresh, '2026-01-17').recommendation.amountCents);
});

test('a validated weekday habit works on its matching day without exposing transactions', () => {
  const journal = newJournal('PHP', 100000, '2026-01-01');
  journal.bufferCents = 0; journal.dailyLimitCents = 10000;
  journal.goal = { id: 'g', title: 'Test goal', targetCents: 100000, targetDate: '2026-02-05', status: 'active', createdAt: '' };
  const dates = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-07', '2026-01-14', '2026-01-21'];
  journal.entries = dates.map((date, index) => ({ id: `e${index}`, kind: 'expense', amountCents: index < 3 ? 200 : 50, note: 'private note', date, createdAt: '' }));
  const habit = detectedDailyHabit(journal, '2026-01-21');
  assert.ok(habit);
  const text = dailyHabitMemory(habit);
  assert.equal(text.includes('private note'), false);
  assert.equal(text.includes('200'), false);
  assert.deepEqual(habit.days, [2]);
  assert.deepEqual(parseDailyHabitMemory(text, '2026-01-21'), habit);
  assert.equal(parseDailyHabitMemory(text, '2026-03-20'), null);
  assert.equal(parseDailyHabitMemory(text, '2026-01-01'), null);
  assert.equal(parseDailyHabitMemory(text.replace('"sampleDays":[3]', '"sampleDays":[2]'), '2026-01-21'), null);
  assert.equal(parseDailyHabitMemory(text.replace('"recordedDays":6', '"recordedDays":6,"note":"secret"'), '2026-01-21'), null);
  const restored = newJournal('PHP', 100000, '2026-01-01');
  restored.bufferCents = 0; restored.dailyLimitCents = 10000; restored.goal = journal.goal;
  const tomorrow = nextDay('2026-01-26');
  assert.equal(tomorrow, '2026-01-27');
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
  const base = savings(restored, tomorrow).recommendation.amountCents;
  const remembered = savings(restored, tomorrow, habit.days).recommendation;
  assert.equal(remembered.amountCents, base);
  assert.match(remembered.reason, /not enough local expense history/i);
  assert.equal(savings(restored, '2026-01-28', habit.days).recommendation.amountCents, savings(restored, '2026-01-28').recommendation.amountCents);
  const corrected = { ...journal, entries: journal.entries.map(entry => ({ ...entry, amountCents: 50 })) };
  const cleared = detectedDailyHabit(corrected, '2026-01-21');
  assert.deepEqual(cleared?.days, []);
  assert.deepEqual(parseDailyHabitMemory(dailyHabitMemory(cleared!), '2026-01-21'), cleared);
  assert.equal(savings(corrected, tomorrow, habit.days).recommendation.amountCents, savings(corrected, tomorrow).recommendation.amountCents);
});

test('day-specific memories can be recalled on every day without fabricating amounts', () => {
  const journal = newJournal('PHP', 1000000, '2026-01-01');
  journal.goal = { id: 'g', title: 'Goal', targetCents: 100000, targetDate: '2026-02-28', status: 'active', createdAt: '' };
  for (let day = 0; day < 7; day++) {
    const date = `2026-01-${25 + day}`;
    const base = savings(journal, date).recommendation.amountCents;
    assert.equal(savings(journal, date, [day]).recommendation.amountCents, base);
    assert.match(savings(journal, date, [day]).recommendation.reason, /not enough local expense history/);
    assert.equal(savings(journal, date, [(day + 1) % 7]).recommendation.amountCents, base);
  }
  const old = 'COINJAR_PHONE_HABIT_V1 {"type":"higher-weekend-spending","weekendDays":3,"weekdayDays":4,"observedThrough":"2026-01-20"}';
  assert.equal(parseDailyHabitMemory(old, '2026-01-25'), null);
});
