import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { newJournal, savings, validateJournal } from '../src/phoneJournal';

test('phone coach recalculates the remaining goal over the remaining days', () => {
  const j = newJournal('PHP', 10000, '2026-01-01');
  j.bufferCents = 0; j.dailyLimitCents = 10000;
  j.openingCents = 1000000;
  j.goal = { id: 'g', title: 'Goal', targetCents: 500000, targetDate: '2026-01-10', phoneStartDate: '2026-01-01', phoneBaselineCents: 50000, status: 'active', createdAt: '' };
  assert.equal(savings(j, '2026-01-01').recommendation.amountCents, 50000);
  j.entries.push({ id: 'c', kind: 'contribution', amountCents: 30000, date: '2026-01-01', note: '', createdAt: '' });
  assert.equal(savings(j, '2026-01-01').recommendation.amountCents, 0);
  assert.equal(savings(j, '2026-01-02').recommendation.amountCents, 52223);
  j.entries.push({ id: 'c2', kind: 'contribution', amountCents: 50000, date: '2026-01-02', note: '', createdAt: '' });
  assert.equal(savings(j, '2026-01-03').recommendation.amountCents, 52500);
  j.entries.push({ id: 'c3', kind: 'contribution', amountCents: 20000, date: '2026-01-03', note: '', createdAt: '' });
  assert.equal(savings(j, '2026-01-03').recommendation.amountCents, 0);
  assert.equal(savings(j, '2026-01-04').recommendation.amountCents, 57143);
  j.entries.push({ id: 'e', kind: 'expense', amountCents: 860000, date: '2026-01-04', note: '', createdAt: '' });
  assert.equal(savings(j, '2026-01-04').recommendation.amountCents, 40000);
  assert.equal(savings(validateJournal(JSON.parse(JSON.stringify(j))), '2026-01-04').summary.availableCents, 40000);
  assert.equal(validateJournal(JSON.parse(JSON.stringify(j))).goal?.phoneBaselineCents, 50000);
  assert.equal(savings(j, '2026-01-11').recommendation.amountCents, 0);
});

test('phone coach needs a goal date and ignores legacy buffer and limit', () => {
  const j = newJournal('PHP', 100000, '2026-01-01');
  j.goal = { id: 'g', title: 'Goal', targetCents: 100000, status: 'active', createdAt: '' };
  assert.match(savings(j, '2026-01-01').recommendation.reason, /target date/);
  j.goal.targetDate = '2026-01-10'; j.bufferCents = 90000; j.dailyLimitCents = 1;
  assert.equal(savings(j, '2026-01-01').recommendation.amountCents, 10000);
});

test('goal pace is reduced only when recorded balance cannot cover estimated spending', () => {
  const j = newJournal('PHP', 123000, '2026-01-01');
  j.goal = { id: 'g', title: 'Goal', targetCents: 500000, targetDate: '2026-02-05', status: 'active', createdAt: '' };
  const dates = ['2026-01-06', '2026-01-13', '2026-01-20', '2026-01-07', '2026-01-14', '2026-01-21'];
  j.entries = dates.map((date, i) => ({ id: `e${i}`, kind: 'expense', amountCents: [10000, 20000, 30000, 1000, 1000, 1000][i], date, note: '', createdAt: '' }));
  const result = savings(j, '2026-01-27').recommendation;
  assert.equal(result.baselineCents, 50000);
  assert.equal(result.amountCents, 40000);
  assert.match(result.reason, /Estimated spending still to come: ₱200\.00/);
  assert.match(result.reason, /short of the remaining goal/);
  j.entries.push({ id: 'today', kind: 'expense', amountCents: 5000, date: '2026-01-27', note: '', createdAt: '' });
  assert.equal(savings(j, '2026-01-27').recommendation.amountCents, 40000);
  j.entries.push({ id: 'income', kind: 'income', amountCents: 30000, date: '2026-01-27', note: '', createdAt: '' });
  assert.equal(savings(j, '2026-01-27').recommendation.amountCents, 50000);
  j.entries.push({ id: 'income2', kind: 'income', amountCents: 430000, date: '2026-01-27', note: '', createdAt: '' });
  const funded = savings(j, '2026-01-27').recommendation;
  assert.equal(funded.amountCents, 50000);
  assert.doesNotMatch(funded.reason, /short of the remaining goal/);
});

test('a recalled high-spending day can use other local days without uploading amounts', () => {
  const j = newJournal('PHP', 90000, '2026-01-01');
  j.goal = { id: 'g', title: 'Goal', targetCents: 500000, targetDate: '2026-02-05', status: 'active', createdAt: '' };
  j.entries = ['2026-01-07', '2026-01-14', '2026-01-21'].map((date, i) => ({ id: `e${i}`, kind: 'expense', amountCents: 10000, date, note: '', createdAt: '' }));
  assert.equal(savings(j, '2026-01-27').recommendation.amountCents, 50000);
  const remembered = savings(j, '2026-01-27', [2]).recommendation;
  assert.equal(remembered.amountCents, 40000);
  assert.match(remembered.reason, /rough estimate from a remembered pattern/);
});

test('restore rejects malformed, duplicate, or unsafe financial records and strips unknown fields', () => {
  const j = newJournal('USD', 500, '2026-01-01');
  j.entries.push({ id: 'a', kind: 'expense', amountCents: 100, date: '2026-01-01', note: '', createdAt: '' });
  assert.throws(() => validateJournal({ ...j, currency: 'EUR' }));
  assert.throws(() => validateJournal({ ...j, entries: [...j.entries, j.entries[0]] }));
  assert.throws(() => validateJournal({ ...j, entries: [{ ...j.entries[0], amountCents: -1 }] }));
  assert.throws(() => validateJournal({ ...j, entries: [{ ...j.entries[0], date: '2025-12-31' }] }));
  assert.throws(() => validateJournal({ ...j, openingCents: Number.MAX_SAFE_INTEGER, entries: [{ ...j.entries[0], kind: 'income' }] }));
  const restored = validateJournal({ ...j, entries: [{ ...j.entries[0], voidedAt: 'untrusted' }] });
  assert.equal(savings(restored, '2026-01-01').summary.availableCents, 400);
});

test('goal wallet survives journal validation without affecting savings', () => {
  const j = newJournal('PHP', 100000, '2026-01-01');
  const address = '0x' + 'a'.repeat(64);
  j.goal = { id: 'g', title: 'Goal', targetCents: 50000, targetDate: '2026-01-10', status: 'active', createdAt: '', wallet: { address, balance: 'untrusted' } };
  const restored = validateJournal(JSON.parse(JSON.stringify(j)));
  assert.deepEqual(restored.goal?.wallet, { address });
  assert.equal(savings(restored, '2026-01-01').summary.savedCents, 0);
  assert.equal(savings(restored, '2026-01-01').summary.availableCents, 100000);
  assert.throws(() => validateJournal({ ...j, goal: { ...j.goal, wallet: { address: 'invalid' } } }));
});
