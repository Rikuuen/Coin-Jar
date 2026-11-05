import { test } from 'node:test';
import { estimateUsdCents, simpleSavingsAdvice } from '../src/domain';
import { parseUsdc, formatUsdc, usdcToPhpCentavos, makeUsdcTransfer, USDC_TYPES } from '../src/usdc';
import { bcs } from '@mysten/sui/bcs';
import { strict as assert } from 'node:assert';

test('peso savings convert to a rounded USD estimate', () => {
  assert.equal(estimateUsdCents(15000, '0.015625'), 234);
  assert.throws(() => estimateUsdCents(15000, '0'));
});

test('savings estimate uses recorded spending and never exceeds the daily cap or available cash', () => {
  const state = createInitialState('2026-10-01');
  state.openingCashCents = 100000;
  state.autoSavings = { dailyCents: 100000, bufferCents: 50000, startDate: '2026-10-01' };
  state.schedules = [{ id: 'salary', kind: 'income', title: 'Salary', amountCents: 3000000, days: [30], startDate: '2026-10-01' }];
  state.entries = [
    { id: 'a', kind: 'expense', amountCents: 100000, date: '2026-10-01', note: '', createdAt: '' },
    { id: 'b', kind: 'expense', amountCents: 100000, date: '2026-10-04', note: '', createdAt: '' },
    { id: 'c', kind: 'expense', amountCents: 150000, date: '2026-10-07', note: '', createdAt: '' },
  ];
  state.openingCashCents = 1000000;
  assert.equal(simpleSavingsAdvice(state, '2026-10-07').amountCents, 50000);
  state.autoSavings.dailyCents = 30000;
  assert.equal(simpleSavingsAdvice(state, '2026-10-07').amountCents, 30000);
  state.openingCashCents = 410000;
  assert.equal(simpleSavingsAdvice(state, '2026-10-07').amountCents, 10000);
  state.rememberedWeekendSpending = true;
  assert.equal(simpleSavingsAdvice(state, '2026-10-09').amountCents, 7500);
});

test('USDC uses six decimals and the Sui transaction carries the exact asset and intent', () => {
  assert.equal(parseUsdc('2.34'), '2340000');
  assert.equal(formatUsdc('2340000'), '2.34');
  assert.equal(usdcToPhpCentavos('2340000', '0.015625'), 14976);
  assert.throws(() => parseUsdc('0.0000001'));
  assert.throws(() => parseUsdc('0'));
  const data = makeUsdcTransfer(`0x${'a'.repeat(64)}`, `0x${'b'.repeat(64)}`, '2340000', 'example', 'mainnet').getData();
  assert.ok(data.inputs.some((input) => input.$kind === 'Pure' && input.Pure.bytes === bcs.String.serialize('coinjar:example').toBase64()));
  assert.ok(data.commands.some((command) => command.$kind === '$Intent' && command.$Intent.data.type === USDC_TYPES.mainnet && command.$Intent.data.balance === 2340000n));
});
import { parseSui, formatSui, estimateGas, suiToPhpCentavos } from '../src/sui';
import {
  createInitialState,
  createDemoState,
  parseMoney,
  formatMoney,
  validateDate,
  getSummary,
  recommend,
  detectInsights,
  scheduleOccurrences,
} from '../src/domain';
test('SUI amounts use exact base units', () => {
  assert.equal(parseSui('1.000000001'), '1000000001');
  assert.equal(formatSui('1000000001'), '1.000000001');
  for (const value of ['0', '-1', '1.0000000001', '1e2', '18446744074']) assert.throws(() => parseSui(value));
  assert.deepEqual(estimateGas({ computationCost: '100', storageCost: '100', storageRebate: '50' }), { fee: '150', budget: '250' });
  assert.throws(() => estimateGas({ computationCost: '1', storageCost: '-1', storageRebate: '0' }));
  assert.equal(suiToPhpCentavos('1500000000', '123.4567'), 18519);
  assert.throws(() => suiToPhpCentavos('1000000000', '0'));
});
test('only verified mainnet transfers with a peso reference contribute to estimated progress', () => {
  const state = createInitialState('2026-01-01');
  state.goal = { id: 'goal', title: 'Goal', targetCents: 10000, status: 'active', createdAt: '2026-01-01' };
  const common = { goalId: 'goal', network: 'mainnet' as const, sender: 'a', recipient: 'b', amountMist: '1000000000', createdAt: '2026-01-01T00:00:00Z' };
  state.onchainTransfers = [
    { ...common, id: 'pending', status: 'pending', phpValuation: { centavos: 1000, rate: '10', timestamp: 1, source: 'test' } },
    { ...common, id: 'unpriced', status: 'verified' },
    { ...common, id: 'testnet', network: 'testnet', status: 'verified', phpValuation: { centavos: 1000, rate: '10', timestamp: 1, source: 'test' } },
    { ...common, id: 'verified', status: 'verified', phpValuation: { centavos: 2500, rate: '25', timestamp: 1, source: 'test' } },
  ];
  const summary = getSummary(state, '2026-01-01');
  assert.equal(summary.onchainEstimateCents, 2500);
  assert.equal(summary.savedCents, 0);
  assert.equal(summary.progress, 0.25);
  assert.equal(summary.availableCents, 0);
});
test('opening cash and scheduled obligations shape savings without counting expected income', () => {
  const s = createInitialState('2026-01-10');
  s.openingCashCents = 50000;
  s.goal = { id: 'g', title: 'Goal', targetCents: 100000, status: 'active', createdAt: '2026-01-10' };
  s.schedules = [
    { id: 'salary', kind: 'income', title: 'Salary', amountCents: 100000, days: [15, 30], startDate: '2026-01-10' },
    { id: 'rent', kind: 'expense', title: 'Rent', amountCents: 25000, days: [15], startDate: '2026-01-10' },
  ];
  assert.equal(getSummary(s, '2026-01-10').availableCents, 50000);
  assert.equal(recommend(s, '2026-01-10').billCents, 25000);
  assert.equal(recommend(s, '2026-01-10').amountCents, 5000 < s.preferences.dailyLimitCents ? 5000 : s.preferences.dailyLimitCents);
  s.entries.push({ id: 'pay', kind: 'expense', amountCents: 25000, note: 'Rent', date: '2026-01-15', createdAt: '2026-01-15', scheduleId: 'rent', occurrenceDate: '2026-01-15', scheduleDay: 15 });
  assert.equal(recommend(s, '2026-01-16').billCents, 25000);
  assert.equal(getSummary(s, '2026-01-16').availableCents, 25000);
  s.entries[0].voidedAt = '2026-01-15';
  assert.ok(scheduleOccurrences(s, '2026-01-15').some((o) => o.schedule.id === 'rent' && o.date === '2026-01-15'));
});
test('monthly schedules retain distinct 30th and 31st occurrences in short months', () => {
  const s = createInitialState('2026-02-01');
  s.schedules = [{ id: 'p', kind: 'income', title: 'Pay', amountCents: 100, days: [30, 31], startDate: '2026-02-01' }];
  assert.deepEqual(scheduleOccurrences(s, '2026-02-01').filter((x) => x.date === '2026-02-28').map((x) => x.scheduledDay), [30, 31]);
});
test('factors explain binding limits without inventing evidence', () => {
  const s = createInitialState('2026-01-01');
  s.goal = { id: 'g', title: 'Goal', targetCents: 100000, targetDate: '2026-01-01', status: 'active', createdAt: '2026-01-01' };
  s.entries = [{ id: 'i', kind: 'income', amountCents: 50000, note: '', date: '2026-01-01', createdAt: '2026-01-01' }];
  s.preferences.bufferCents = 0;
  s.preferences.dailyLimitCents = 25000;
  s.preferences.limitProvenance = { origin: 'manual' };
  let result = recommend(s, '2026-01-01');
  let cap = result.factors.find((f) => f.type === 'daily_limit')!;
  assert.equal(result.amountCents, 25000);
  assert.equal(result.withoutLimitCents, 50000);
  assert.equal(cap.source, 'manual');
  assert.equal(cap.affected, true);
  assert.equal(cap.observations, undefined);
  s.preferences.limitProvenance = { origin: 'confirmed', restored: true, remoteId: 'remote' };
  result = recommend(s, '2026-01-01');
  cap = result.factors.find((f) => f.type === 'daily_limit')!;
  assert.equal(cap.source, 'walrus');
  assert.equal(cap.origin, 'confirmed');
  assert.equal(cap.observations, undefined);
  s.preferences.dailyLimitCents = 80000;
  result = recommend(s, '2026-01-01');
  assert.equal(result.amountCents, 50000);
  assert.equal(result.factors.find((f) => f.type === 'daily_limit')?.affected, false);
  s.preferences.bufferCents = 50000;
  s.preferences.bufferProvenance = { origin: 'manual', restored: true };
  result = recommend(s, '2026-01-01');
  assert.equal(result.amountCents, 0);
  assert.equal(result.factors.find((f) => f.type === 'cash_buffer')?.affected, true);
  assert.equal(result.factors.find((f) => f.type === 'cash_buffer')?.source, 'walrus');
  assert.equal(result.factors.find((f) => f.type === 'cash_buffer')?.origin, 'manual');
});
test('money and dates', () => {
  assert.equal(parseMoney('12.3'), 1230);
  assert.equal(parseMoney('0'), 0);
  assert.equal(formatMoney(123456), '₱1,234.56');
  assert.equal(formatMoney(123456, 'USD'), '$1,234.56');
  assert.equal(createInitialState('2026-01-01').preferences.currency, 'PHP');
  for (const x of ['-1', '1.001', '1e2', '', '90071992547409.92'])
    assert.throws(() => parseMoney(x));
  assert.equal(validateDate('2024-02-29'), true);
  assert.equal(validateDate('2025-02-29'), false);
  assert.equal(validateDate('2025-2-01'), false);
});
test('unpaid bills are reserved and paid bills are not counted twice', () => {
  const s = createInitialState('2026-01-01');
  s.goal = {
    id: 'g',
    title: 'Goal',
    targetCents: 100000,
    targetDate: '2026-02-01',
    status: 'active',
    createdAt: '2026-01-01',
  };
  s.entries.push({
    id: 'i',
    kind: 'income',
    amountCents: 50000,
    note: '',
    date: '2026-01-01',
    createdAt: '2026-01-01',
  });
  s.bills = [
    {
      id: 'b',
      title: 'Rent',
      amountCents: 29500,
      dueDate: '2026-01-10',
      paid: false,
    },
  ];
  assert.equal(recommend(s, '2026-01-01').amountCents, 500);
  s.bills[0].amountCents = 31000;
  assert.equal(recommend(s, '2026-01-01').amountCents, 0);
  s.bills[0].paid = true;
  assert.equal(recommend(s, '2026-01-01').billCents, 0);
  s.goal.targetDate = '2025-12-31';
  s.bills = [
    {
      id: 'overdue',
      title: 'Overdue',
      amountCents: 10000,
      dueDate: '2025-12-30',
      paid: false,
    },
    {
      id: 'future',
      title: 'Future',
      amountCents: 20000,
      dueDate: '2026-03-01',
      paid: false,
    },
  ];
  assert.equal(recommend(s, '2026-01-01').billCents, 30000);
  assert.equal(recommend(s, '2026-01-01').amountCents, 0);
});
test('patterns need repeated evidence and skips do not imply a preferred amount', () => {
  const s = createInitialState('2026-01-30');
  s.feedback = [0, 1].map((i) => ({
    id: String(i),
    date: '2026-01-01',
    action: 'reduce',
    suggestedCents: 1000,
    amountCents: 500,
  }));
  s.feedback.push({
    id: 'skip',
    date: '2026-01-02',
    action: 'skip',
    suggestedCents: 1000,
  });
  assert.equal(detectInsights(s, '2026-01-30').length, 0);
  s.feedback.push({
    id: 'third',
    date: '2026-01-03',
    action: 'reduce',
    suggestedCents: 1200,
    amountCents: 500,
  });
  assert.equal(detectInsights(s, '2026-01-30').length, 0);
  s.feedback[1].date = '2026-01-02';
  assert.equal(
    detectInsights(s, '2026-01-30')[0].suggestedDailyLimitCents,
    500,
  );
  s.insightReviews = [{ id: 'preferred-contribution', status: 'dismissed' }];
  assert.equal(detectInsights(s, '2026-01-30')[0].status, 'dismissed');
  assert.ok(
    detectInsights(createDemoState('2026-01-30'), '2026-01-30').some(
      (i) => i.id === 'recurring:income:payday',
    ),
  );
});
test('sample feedback needs one more reduction on a distinct day', () => {
  const s = createDemoState('2026-01-30');
  assert.equal(
    detectInsights(s, '2026-01-30').some(
      (i) => i.id === 'preferred-contribution',
    ),
    false,
  );
  s.feedback!.push({
    id: 'today',
    date: '2026-01-30',
    action: 'reduce',
    suggestedCents: 1000,
    amountCents: 500,
  });
  assert.equal(
    detectInsights(s, '2026-01-30').find(
      (i) => i.id === 'preferred-contribution',
    )?.suggestedDailyLimitCents,
    500,
  );
});
test('remembered weekend spending affects a fresh ledger unless dismissed', () => {
  const s = createInitialState('2026-01-02');
  s.goal = {
    id: 'g',
    title: 'Goal',
    targetCents: 100000,
    targetDate: '2026-02-01',
    status: 'active',
    createdAt: '2026-01-02',
  };
  s.entries.push({
    id: 'i',
    kind: 'income',
    amountCents: 100000,
    note: '',
    date: '2026-01-02',
    createdAt: '2026-01-02',
  });
  const baseline = recommend(s, '2026-01-02').amountCents;
  s.rememberedWeekendSpending = true;
  const remembered = recommend(s, '2026-01-02');
  assert.equal(remembered.amountCents, Math.floor((baseline * 3) / 4));
  assert.match(remembered.reason, /confirmed/);
  s.insightReviews = [{ id: 'higher-weekend-spending', status: 'dismissed' }];
  assert.equal(recommend(s, '2026-01-02').amountCents, baseline);
});
test('recent spending and common categories need distinct recorded days', () => {
  const s = createInitialState('2026-01-15');
  s.goal = {
    id: 'g',
    title: 'Goal',
    targetCents: 100000,
    targetDate: '2026-02-01',
    status: 'active',
    createdAt: '2026-01-01',
  };
  s.entries.push({
    id: 'i',
    kind: 'income',
    amountCents: 100000,
    note: '',
    date: '2026-01-01',
    createdAt: '2026-01-01',
  });
  const expense = (date: string, amountCents: number) => ({
    id: date,
    kind: 'expense' as const,
    amountCents,
    category: 'Food',
    note: '',
    date,
    createdAt: date,
  });
  s.entries.push(
    expense('2026-01-03', 100),
    expense('2026-01-04', 100),
    expense('2026-01-05', 100),
    expense('2026-01-10', 300),
    expense('2026-01-11', 300),
  );
  assert.equal(
    detectInsights(s, '2026-01-15').some(
      (i) => i.id === 'recent-spending-spike',
    ),
    false,
  );
  s.entries.push(expense('2026-01-12', 300));
  const insights = detectInsights(s, '2026-01-15');
  assert.ok(
    insights.some(
      (i) =>
        i.id === 'recent-spending-spike' &&
        i.observations[0].includes('incomplete'),
    ),
  );
  assert.ok(
    insights.some(
      (i) => i.id === 'common-expense:food' && i.transactionCount === 6,
    ),
  );
  const reduced = recommend(s, '2026-01-15');
  s.insightReviews = [{ id: 'recent-spending-spike', status: 'dismissed' }];
  assert.equal(
    reduced.amountCents,
    Math.floor((recommend(s, '2026-01-15').amountCents * 3) / 4),
  );
  assert.match(reduced.reason, /incomplete/);
});
test('buffer, cap, status, duplicate and overdue', () => {
  const s = createInitialState('2026-01-01');
  assert.equal(s.goal, null);
  assert.equal(recommend(s, '2026-01-01').amountCents, 0);
  s.goal = {
    id: 'g',
    title: 'Goal',
    targetCents: 10000,
    targetDate: '2026-01-10',
    status: 'active',
    createdAt: '2026-01-01',
  };
  s.entries.push({
    id: 'i',
    kind: 'income',
    amountCents: 20500,
    note: '',
    date: '2026-01-01',
    createdAt: '2026-01-01',
  });
  assert.equal(recommend(s, '2026-01-01').amountCents, 500);
  s.entries.push({
    id: 'c',
    kind: 'contribution',
    amountCents: 500,
    note: '',
    date: '2026-01-01',
    createdAt: '2026-01-01',
  });
  assert.equal(recommend(s, '2026-01-01').amountCents, 0);
  s.entries[0].amountCents = 100000;
  s.goal.status = 'paused';
  assert.equal(recommend(s, '2026-01-02').amountCents, 0);
  s.goal.status = 'completed';
  assert.equal(recommend(s, '2026-01-02').amountCents, 0);
  s.goal.status = 'active';
  const overdue = recommend(s, '2026-01-11');
  assert.equal(overdue.daysRemaining, 1);
  assert.match(overdue.reason, /passed/);
  assert.equal(overdue.amountCents, 1500);
  s.entries[1].amountCents = 12000;
  assert.equal(getSummary(s, '2026-01-11').remainingCents, 0);
  assert.equal(recommend(s, '2026-01-11').amountCents, 0);
});
test('streak counts distinct days and demo contains memories', () => {
  const s = createDemoState('2026-01-07');
  assert.equal(s.memories.length, 10);
  s.entries = [-3, -2, -1].map((offset, i) => ({
    id: String(i),
    kind: 'contribution',
    amountCents: 100,
    note: '',
    date: `2026-01-0${7 + offset}`,
    createdAt: '2026-01-01',
  }));
  s.entries.push({ ...s.entries[2], id: 'duplicate' });
  const result = getSummary(s, '2026-01-07');
  assert.equal(result.successfulDays, 3);
  assert.equal(result.currentStreak, 3);
  assert.equal(result.longestStreak, 3);
});
