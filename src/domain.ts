export interface Valuation {
  usdMicrodollars: string;
  rate: {
    value: string;
    basePair: 'USD';
    symbol: 'PHP';
    timestamp: number;
    source: string;
  };
}
export interface Goal {
  id: string;
  title: string;
  targetCents: number;
  targetDate?: string;
  phoneStartDate?: string;
  phoneBaselineCents?: number;
  status: 'active' | 'paused' | 'completed';
  createdAt: string;
  wallet?: { address: string; balance?: unknown; updatedAt?: string };
  valuation?: Valuation;
}
export interface Entry {
  id: string;
  kind: 'income' | 'expense' | 'contribution' | 'withdrawal';
  amountCents: number;
  note: string;
  date: string;
  createdAt: string;
  category?: string;
  billId?: string;
  voidedAt?: string;
  valuation?: Valuation;
  time?: string;
  scheduleId?: string;
  occurrenceDate?: string;
  scheduleDay?: number;
  autoSavingsDate?: string;
}
export interface Schedule {
  id: string;
  kind: 'income' | 'expense';
  title: string;
  amountCents: number;
  days: number[];
  startDate: string;
  endDate?: string;
  autoRecord?: boolean;
}
export interface OnchainTransfer {
  id: string;
  goalId: string;
  network: 'mainnet' | 'testnet';
  sender: string;
  recipient: string;
  amountMist?: string;
  amountMicroUsdc?: string;
  asset?: 'USDC';
  createdAt: string;
  status: 'awaiting_wallet' | 'unknown' | 'pending' | 'verified' | 'failed' | 'dismissed';
  digest?: string;
  checkpoint?: string;
  phpValuation?: { centavos: number; rate: string; timestamp: number; source: string };
}
export interface Bill {
  id: string;
  title: string;
  amountCents: number;
  dueDate: string;
  paid: boolean;
  valuation?: Valuation;
}
export interface RecommendationFeedback {
  id: string;
  date: string;
  action: 'accept' | 'reduce' | 'skip';
  suggestedCents: number;
  amountCents?: number;
  reason?: string;
  entryId?: string;
  voidedAt?: string;
  suggestedValuation?: Valuation;
  amountValuation?: Valuation;
}
export interface InsightReview {
  id: string;
  status: 'confirmed' | 'dismissed';
  correction?: string;
}
export interface Insight {
  id: string;
  description: string;
  observations: string[];
  transactionCount: number;
  confidence: 'medium' | 'high';
  detectedAt: string;
  status: 'pending' | 'confirmed' | 'dismissed';
  suggestedDailyLimitCents?: number;
  periodStart: string;
  periodEnd: string;
}
export interface LimitProvenance {
  origin: 'manual' | 'confirmed' | 'explicit' | 'unknown';
  observations?: string[];
  restored?: boolean;
  remoteId?: string;
}
export interface RecommendationFactor {
  type: string;
  value: number | string;
  source: 'manual' | 'confirmed' | 'detected' | 'walrus' | 'ledger' | 'goal' | 'unknown';
  affected: boolean;
  observations?: string[];
  origin?: LimitProvenance['origin'];
  remoteId?: string;
}
export interface Preferences {
  bufferCents: number;
  dailyLimitCents: number;
  pace: 'gentle' | 'steady' | 'focused';
  currency: 'PHP' | 'USD';
  bufferValuation?: Valuation;
  dailyLimitValuation?: Valuation;
  limitProvenance?: LimitProvenance;
  bufferProvenance?: { origin: 'manual' | 'unknown'; restored?: boolean };
  paceProvenance?: { origin: 'manual' | 'unknown'; restored?: boolean };
}
export interface Memory {
  id: string;
  text: string;
  kind: 'preference' | 'feedback' | 'observation';
  createdAt: string;
  source: 'local' | 'walrus';
  remoteId?: string;
  approved?: boolean;
  autoSyncRequested?: boolean;
  summarySyncRequested?: boolean;
  syncStatus?: 'pending' | 'syncing' | 'stored' | 'not_sent' | 'unknown';
}
export interface AppState {
  version: 1;
  goal: Goal | null;
  entries: Entry[];
  memories: Memory[];
  preferences: Preferences;
  bills?: Bill[];
  feedback?: RecommendationFeedback[];
  insightReviews?: InsightReview[];
  rememberedWeekendSpending?: boolean;
  rememberedRecentSpendingSpike?: boolean;
  weekendProvenance?: { observations?: string[]; restored?: boolean; remoteId?: string };
  autoMemorySync?: boolean;
  openingCashCents?: number;
  openingCashDate?: string;
  balanceAdjustments?: Array<{ id: string; date: string; deltaCents: number; createdAt: string }>;
  autoSavings?: { dailyCents: number; bufferCents: number; startDate: string };
  summarySync?: { enabled: boolean; lastDate?: string };
  simpleProfile?: { name: string; monthlyIncomeCents: number; walletAddress?: string };
  learnedBudget?: { dailyCents: number; savedAt: string; currency: 'PHP' | 'USD'; remoteId: string };
  lastLearningDate?: string;
  savingsPauses?: Array<{ date: string; reason: 'weekend' | 'other' }>;
  weekendSignal?: boolean;
  weekendPreferenceChangedAt?: string;
  schedules?: Schedule[];
  onboardingComplete?: boolean;
  reminder?: { enabled: boolean; time: string };
  onchainTransfers?: OnchainTransfer[];
}
const DAY = 86400000;
export function validateDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function day(value: string): number {
  if (!validateDate(value)) throw new Error('Invalid date');
  return Date.parse(value + 'T00:00:00Z') / DAY;
}
export function parseMoney(input: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) throw new Error('Invalid amount');
  const cents = BigInt(m[1]) * 100n + BigInt((m[2] || '').padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Amount is too large');
  return Number(cents);
}
export function formatMoney(
  cents: number,
  currency: Preferences['currency'] = 'PHP',
): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Invalid cents');
  const digits = String(Math.abs(cents)).padStart(3, '0');
  return `${cents < 0 ? '-' : ''}${currency === 'PHP' ? '₱' : '$'}${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${digits.slice(-2)}`;
}
export function createInitialState(today: string): AppState {
  day(today);
  return {
    version: 1,
    goal: null,
    entries: [],
    memories: [],
    preferences: {
      bufferCents: 20000,
      dailyLimitCents: 1500,
      pace: 'steady',
      currency: 'PHP',
    },
  };
}
export function createDemoState(today: string): AppState {
  const start = day(today),
    date = (offset: number) =>
      new Date((start + offset) * DAY).toISOString().slice(0, 10),
    state = createInitialState(today);
  state.goal = {
    id: 'demo-goal',
    title: 'Emergency fund',
    targetCents: 100000,
    targetDate: date(90),
    status: 'active',
    createdAt: date(-6),
  };
  const records: [Entry['kind'], number, number, string][] = [
    ['income', 90000, -6, 'Payday'],
    ['expense', 12000, -5, 'Groceries'],
    ['contribution', 1000, -5, 'Daily save'],
    ['expense', 4500, -4, 'Transport'],
    ['contribution', 1000, -3, 'Daily save'],
    ['income', 20000, -2, 'Side work'],
    ['contribution', 1000, -1, 'Daily save'],
  ];
  state.entries = records.map(([kind, amountCents, offset, note], i) => ({
    id: `demo-entry-${i}`,
    kind,
    amountCents,
    note,
    date: date(offset),
    createdAt: date(offset),
  }));
  for (const [i, offset] of [-28, -21, -14].entries()) {
    state.entries.push({
      id: `demo-pay-${i}`,
      kind: 'income',
      amountCents: 20000,
      category: 'Payday',
      note: 'Sample paycheck',
      date: date(offset),
      createdAt: date(offset),
    });
    state.entries.push({
      id: `demo-grocery-${i}`,
      kind: 'expense',
      amountCents: 3000,
      category: 'Groceries',
      note: 'Sample groceries',
      date: date(offset + 1),
      createdAt: date(offset + 1),
    });
  }
  state.feedback = [-7, -3].map((offset, i) => ({
    id: `demo-feedback-${i}`,
    date: date(offset),
    action: 'reduce',
    suggestedCents: 1000,
    amountCents: 500,
    reason: 'Sample feedback',
  }));
  const notes = [
    'Keep a cash buffer.',
    'Small saves feel manageable.',
    'Income varies by week.',
    'Avoid saving rent money.',
    'Steady progress matters.',
    'I prefer a gentle pace on tight weeks.',
    'Unexpected expenses happen.',
    'Review the daily limit when income changes.',
    'I reduced a suggestion after buying groceries.',
    'A visible goal helps me stay motivated.',
  ];
  state.memories = notes.map((text, i) => ({
    id: `demo-memory-${i}`,
    text,
    kind: i === 8 ? 'feedback' : i === 2 ? 'observation' : 'preference',
    createdAt: date(-6 + Math.floor(i / 2)),
    source: 'local',
  }));
  return state;
}
export function getSummary(state: AppState, today: string) {
  const now = day(today),
    days = new Set<number>();
  let savedCents = 0,
    availableCents = state.openingCashCents ?? 0;
  if (!Number.isSafeInteger(availableCents) || availableCents < 0) throw new Error('Invalid opening cash');
  for (const adjustment of state.balanceAdjustments ?? []) {
    if (!Number.isSafeInteger(adjustment.deltaCents)) throw new Error('Invalid balance adjustment');
    if (day(adjustment.date) <= now) availableCents += adjustment.deltaCents;
    if (!Number.isSafeInteger(availableCents)) throw new Error('Total exceeds safe range');
  }
  for (const e of state.entries) {
    if (e.voidedAt) continue;
    if (!Number.isSafeInteger(e.amountCents) || e.amountCents < 0)
      throw new Error('Invalid entry amount');
    const d = day(e.date);
    if (d > now) continue;
    availableCents += e.kind === 'income' || e.kind === 'withdrawal' ? e.amountCents : -e.amountCents;
    if (e.kind === 'contribution') {
      savedCents += e.amountCents;
      if (e.amountCents > 0 && d <= now) days.add(d);
    }
    if (e.kind === 'withdrawal') savedCents -= e.amountCents;
    if (
      !Number.isSafeInteger(availableCents) ||
      !Number.isSafeInteger(savedCents)
    )
      throw new Error('Total exceeds safe range');
  }
  let longestStreak = 0,
    run = 0,
    previous = -Infinity;
  for (const d of [...days].sort((a, b) => a - b)) {
    run = d === previous + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = d;
  }
  let currentStreak = 0;
  for (let d = days.has(now) ? now : now - 1; days.has(d); d--) currentStreak++;
  const target = state.goal?.targetCents ?? 0;
  const onchainEstimateCents = (state.onchainTransfers ?? []).filter((item) => item.status === 'verified' && item.network === 'mainnet' && item.goalId === state.goal?.id && state.preferences.currency === 'PHP' && item.phpValuation).reduce((sum, item) => {
    const value = item.phpValuation!.centavos;
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(sum + value)) throw new Error('Invalid on-chain valuation');
    return sum + value;
  }, 0);
  const totalGoalCents = savedCents + onchainEstimateCents;
  if (!Number.isSafeInteger(totalGoalCents)) throw new Error('Total exceeds safe range');
  const remainingCents = Math.max(0, target - totalGoalCents);
  return {
    savedCents,
    onchainEstimateCents,
    totalGoalCents,
    availableCents,
    remainingCents,
    progress: target > 0 ? Math.min(1, totalGoalCents / target) : 0,
    successfulDays: days.size,
    currentStreak,
    longestStreak,
  };
}
export function scheduleOccurrences(state: AppState, today: string) {
  const end = day(today) + 30;
  const result: Array<{ schedule: Schedule; date: string; scheduledDay: number }> = [];
  for (const schedule of state.schedules ?? []) {
    if (!validateDate(schedule.startDate) || !Number.isSafeInteger(schedule.amountCents) || schedule.amountCents <= 0 || !schedule.days.length || schedule.days.some((n) => !Number.isInteger(n) || n < 1 || n > 31) || (schedule.endDate && !validateDate(schedule.endDate))) throw new Error('Invalid schedule');
    const start = new Date(`${schedule.startDate}T00:00:00Z`);
    for (let i = 0; i < 1200; i++) {
      const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
      if (Math.floor(first.getTime() / DAY) > end) break;
      if (i === 1199) throw new Error('Schedule history exceeds supported range');
      const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      for (const scheduledDay of schedule.days) {
        const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(scheduledDay, lastDay))).toISOString().slice(0, 10);
        if (date < schedule.startDate || day(date) > end || (schedule.endDate && date > schedule.endDate)) continue;
        if (state.entries.some((e) => !e.voidedAt && e.scheduleId === schedule.id && e.occurrenceDate === date && e.scheduleDay === scheduledDay)) continue;
        result.push({ schedule, date, scheduledDay });
      }
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}
export function simpleSavingsAdvice(state: AppState, today: string) {
  const setting = state.autoSavings;
  if (!setting) return { amountCents: 0, learning: true, reason: 'Set your daily limit to get started.' };
  const currentDay = day(today);
  const recent = state.entries.filter((entry) => !entry.voidedAt && day(entry.date) <= currentDay && day(entry.date) >= currentDay - 29);
  const expenses = recent.filter((entry) => entry.kind === 'expense');
  const expenseDays = [...new Set(expenses.map((entry) => entry.date))].sort();
  const scheduledIncome = (state.schedules ?? []).filter((item) => item.kind === 'income' && !item.endDate).reduce((sum, item) => sum + item.amountCents * item.days.length, 0);
  const recordedIncome = recent.filter((entry) => entry.kind === 'income').reduce((sum, entry) => sum + entry.amountCents, 0);
  const monthlyIncome = scheduledIncome || recordedIncome || state.simpleProfile?.monthlyIncomeCents || 0;
  const enough = expenseDays.length >= 3 && currentDay - day(expenseDays[0]) >= 6 && monthlyIncome > 0;
  const spendable = Math.max(0, getSummary(state, today).availableCents - setting.bufferCents);
  let estimate = setting.dailyCents;
  let learnedDailyCents: number | undefined;
  if (enough) {
    const period = Math.min(30, currentDay - day(expenseDays[0]) + 1);
    const expensesTotal = expenses.reduce((sum, item) => sum + BigInt(item.amountCents), 0n);
    const estimatedMonthlySpending = (expensesTotal * 30n + BigInt(period) - 1n) / BigInt(period);
    const surplus = BigInt(monthlyIncome) - estimatedMonthlySpending;
    learnedDailyCents = surplus > 0n ? Number(surplus / 30n) : 0;
    estimate = learnedDailyCents;
  }
  const memory = state.learnedBudget;
  const memoryDate = memory?.savedAt?.slice(0, 10);
  const useMemory = Boolean(state.summarySync?.enabled && memory && memory.currency === state.preferences.currency && memoryDate && validateDate(memoryDate) && day(memoryDate) <= currentDay && currentDay - day(memoryDate) <= 30 && Number.isSafeInteger(memory.dailyCents) && memory.dailyCents >= 0);
  if (useMemory) estimate = Math.min(estimate, memory!.dailyCents);
  let amountCents = Math.min(setting.dailyCents, spendable, estimate);
  const weekend = [5, 6, 0].includes(new Date(currentDay * DAY).getUTCDay());
  if (weekend && state.rememberedWeekendSpending) amountCents = Math.floor(amountCents * 3 / 4);
  return { amountCents, learning: !enough && !useMemory, learnedDailyCents, expenseDays: expenseDays.length, periodDays: expenseDays.length ? Math.min(30, currentDay - day(expenseDays[0]) + 1) : 0, reason: weekend && state.rememberedWeekendSpending ? 'Reduced for your saved weekend preference.' : useMemory && memory!.dailyCents <= estimate ? 'Includes a remembered spending pattern.' : !enough ? 'Still learning from your recorded income and expenses.' : 'Based on your recent recorded income and expenses.' };
}
export function detectInsights(state: AppState, today: string): Insight[] {
  const now = day(today),
    results: Insight[] = [];
  const add = (insight: Omit<Insight, 'detectedAt' | 'status' | 'periodStart' | 'periodEnd'>, dates: string[]) => {
    const review = state.insightReviews?.find((r) => r.id === insight.id);
    const ordered = [...dates].sort();
    results.push({
      ...insight,
      periodStart: ordered[0],
      periodEnd: ordered[ordered.length - 1],
      detectedAt: today,
      status: review?.status ?? 'pending',
    });
  };
  const reductions = (state.feedback ?? []).filter(
    (f) =>
      f.action === 'reduce' &&
      !f.voidedAt &&
      validateDate(f.date) &&
      day(f.date) <= now &&
      Number.isSafeInteger(f.amountCents) &&
      f.amountCents! >= 0 &&
      Number.isSafeInteger(f.suggestedCents) &&
      f.amountCents! < f.suggestedCents,
  );
  if (new Set(reductions.map((f) => f.date)).size >= 3) {
    const amounts = reductions.map((f) => f.amountCents!).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    add({
      id: 'preferred-contribution',
      description: `You often reduce suggestions to around ${formatMoney(median, state.preferences.currency)}.`,
      observations: reductions.map(
        (f) =>
          `${f.date}: ${formatMoney(f.suggestedCents, state.preferences.currency)} suggested, ${formatMoney(f.amountCents!, state.preferences.currency)} chosen`,
      ),
      transactionCount: reductions.length,
      confidence: reductions.length >= 5 ? 'high' : 'medium',
      suggestedDailyLimitCents: median,
    }, reductions.map((f) => f.date));
  }
  const groups = new Map<string, Entry[]>();
  for (const entry of state.entries) {
    if (entry.voidedAt) continue;
    if (
      (entry.kind !== 'income' && entry.kind !== 'expense') ||
      !entry.category?.trim() ||
      !validateDate(entry.date) ||
      day(entry.date) > now
    )
      continue;
    const key = `${entry.kind}:${entry.category.trim().toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, entries] of groups) {
    const ordered = entries.sort((a, b) => a.date.localeCompare(b.date));
    if (ordered.length < 3 || new Set(ordered.map((e) => e.date)).size < 3)
      continue;
    const gaps = ordered
      .slice(1)
      .map((e, i) => day(e.date) - day(ordered[i].date));
    if (
      gaps.some((g) => g < 6 || g > 35) ||
      Math.max(...gaps) - Math.min(...gaps) > 4
    )
      continue;
    add({
      id: `recurring:${key}`,
      description: `Your ${ordered[0].category} ${ordered[0].kind} appears to recur.`,
      observations: ordered.map(
        (e) =>
          `${e.date}: ${formatMoney(e.amountCents, state.preferences.currency)}`,
      ),
      transactionCount: ordered.length,
      confidence: ordered.length >= 5 ? 'high' : 'medium',
    }, ordered.map((e) => e.date));
  }
  const recentExpenses = state.entries.filter(
    (e) =>
      e.kind === 'expense' &&
      !e.voidedAt &&
      validateDate(e.date) &&
      day(e.date) <= now &&
      day(e.date) >= now - 55 &&
      Number.isSafeInteger(e.amountCents) &&
      e.amountCents >= 0,
  );
  const recentWeek = recentExpenses.filter((e) => day(e.date) >= now - 6);
  const previousWeek = recentExpenses.filter(
    (e) => day(e.date) >= now - 13 && day(e.date) <= now - 7,
  );
  if (
    new Set(recentWeek.map((e) => e.date)).size >= 3 &&
    new Set(previousWeek.map((e) => e.date)).size >= 3
  ) {
    const total = (entries: Entry[]) =>
      entries.reduce((sum, e) => sum + BigInt(e.amountCents), 0n);
    const recent = total(recentWeek),
      previous = total(previousWeek);
    if (
      recent !== previous &&
      recent <= BigInt(Number.MAX_SAFE_INTEGER) &&
      previous <= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      const spike = previous > 0n && recent >= previous * 2n;
      add({
        id: spike ? 'recent-spending-spike' : 'recent-spending-change',
        description: `Recorded spending is ${recent > previous ? 'higher' : 'lower'} in the last seven days.`,
        observations: [
          `Last seven days: ${formatMoney(Number(recent), state.preferences.currency)} across ${new Set(recentWeek.map((e) => e.date)).size} recorded expense days; previous seven days: ${formatMoney(Number(previous), state.preferences.currency)} across ${new Set(previousWeek.map((e) => e.date)).size} recorded expense days. Records may be incomplete.`,
        ],
        transactionCount: recentWeek.length + previousWeek.length,
        confidence: 'medium',
      }, [...recentWeek, ...previousWeek].map((e) => e.date));
    }
  }
  const categories = new Map<string, Entry[]>();
  for (const e of recentExpenses) {
    const category = e.category?.trim().toLowerCase();
    if (category)
      categories.set(category, [...(categories.get(category) ?? []), e]);
  }
  const ranked = [...categories.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  );
  if (
    ranked.length &&
    ranked[0][1].length >= 3 &&
    new Set(ranked[0][1].map((e) => e.date)).size >= 3 &&
    (!ranked[1] || ranked[0][1].length > ranked[1][1].length)
  ) {
    const [category, entries] = ranked[0];
    add({
      id: `common-expense:${category}`,
      description: `${entries[0].category} is your most frequently recorded expense category recently.`,
      observations: [
        `${entries.length} expenses on ${new Set(entries.map((e) => e.date)).size} days in the last 56 days; uncategorized expenses are excluded and records may be incomplete.`,
      ],
      transactionCount: entries.length,
      confidence: 'medium',
    }, entries.map((e) => e.date));
  }
  const totals = new Map<number, number>();
  for (const e of recentExpenses)
    totals.set(day(e.date), (totals.get(day(e.date)) ?? 0) + e.amountCents);
  const weekends = [...totals].filter(([d]) =>
    [0, 6].includes(new Date(d * DAY).getUTCDay()),
  );
  const weekdays = [...totals].filter(
    ([d]) => ![0, 6].includes(new Date(d * DAY).getUTCDay()),
  );
  if (
    weekends.length >= 3 &&
    weekdays.length >= 3 &&
    weekends.reduce((sum, [, n]) => sum + BigInt(n), 0n) *
      BigInt(weekdays.length) >=
      weekdays.reduce((sum, [, n]) => sum + BigInt(n), 0n) *
        BigInt(weekends.length) *
        2n
  ) {
    add({
      id: 'higher-weekend-spending',
      description:
        'Spending appears higher on weekend days with recorded expenses.',
      observations: [
        `${weekends.length} weekend days and ${weekdays.length} weekdays with recorded expenses in the last 56 days; days without recorded expenses are excluded.`,
      ],
      transactionCount: recentExpenses.length,
      confidence: 'medium',
    }, recentExpenses.map((e) => e.date));
  }
  return results;
}
export function recommend(state: AppState, today: string) {
  const now = day(today),
    summary = getSummary(state, today),
    daysRemaining = state.goal?.targetDate
      ? Math.max(1, day(state.goal.targetDate) - now + 1)
      : 0,
    baselineCents = daysRemaining
      ? Math.ceil(summary.remainingCents / daysRemaining)
      : state.goal ? state.preferences.dailyLimitCents : 0,
    billCents = scheduleOccurrences(state, today).filter((item) => item.schedule.kind === 'expense').reduce((sum, item) => {
      const total = sum + item.schedule.amountCents;
      if (!Number.isSafeInteger(total)) throw new Error('Total exceeds safe range');
      return total;
    }, (state.bills ?? []).reduce((sum, bill) => {
      if (
        !Number.isSafeInteger(bill.amountCents) ||
        bill.amountCents < 0 ||
        !validateDate(bill.dueDate)
      )
        throw new Error('Invalid bill');
      if (bill.paid) return sum;
      const total = sum + bill.amountCents;
      if (!Number.isSafeInteger(total))
        throw new Error('Total exceeds safe range');
      return total;
    }, 0)),
    safeCents = Math.max(
      0,
      summary.availableCents - state.preferences.bufferCents - billCents,
    ),
    reasons: string[] = [];
  let amountCents = 0;
  let withoutLimitCents = 0;
  const factors: RecommendationFactor[] = [];
  if (!state.goal) reasons.push('Create a goal to receive a suggestion.');
  else if (state.goal.status !== 'active')
    reasons.push(`Your goal is ${state.goal.status}.`);
  else if (!summary.remainingCents) reasons.push('Your goal has been reached.');
  else if (
    state.entries.some(
      (e) =>
        !e.voidedAt &&
        e.kind === 'contribution' &&
        e.amountCents > 0 &&
        e.date === today,
    )
  )
    reasons.push('You already recorded a contribution today.');
  else {
    if (!safeCents) reasons.push('Your available cash is needed for your buffer and unpaid bills.');
    const factor = { gentle: 3, steady: 4, focused: 5 }[state.preferences.pace];
    amountCents = Math.min(
      summary.remainingCents,
      state.preferences.dailyLimitCents,
      safeCents,
      Number((BigInt(baselineCents) * BigInt(factor)) / 4n),
    );
    const weekday = new Date(now * DAY).getUTCDay();
    const weekendDismissed = state.insightReviews?.some(
      (r) => r.id === 'higher-weekend-spending' && r.status === 'dismissed',
    );
    const rememberedWeekend = state.rememberedWeekendSpending === true;
    const insights = detectInsights(state, today);
    const observedWeekend = insights.some(
      (i) => i.id === 'higher-weekend-spending' && i.status !== 'dismissed',
    );
    const observedSpike = insights.some(
      (i) => i.id === 'recent-spending-spike' && i.status !== 'dismissed',
    );
    const spikeDismissed = state.insightReviews?.some((r) => r.id === 'recent-spending-spike' && r.status === 'dismissed');
    const spike = observedSpike || (state.rememberedRecentSpendingSpike === true && !spikeDismissed && !insights.some(i => i.id === 'recent-spending-change'));
    const beforePattern = amountCents;
    let pattern: Insight | undefined;
    let selectedPatternId: 'higher-weekend-spending' | 'recent-spending-spike' | undefined;
    let patternSelected = false;
    let patternSource: RecommendationFactor['source'] = 'detected';
    if (
      [0, 5, 6].includes(weekday) &&
      !weekendDismissed &&
      (rememberedWeekend || observedWeekend)
    ) {
      patternSelected = true;
      selectedPatternId = 'higher-weekend-spending';
      pattern = insights.find((i) => i.id === 'higher-weekend-spending');
      patternSource = rememberedWeekend ? (state.weekendProvenance?.restored ? 'walrus' : 'confirmed') : 'detected';
      amountCents = Number((BigInt(amountCents) * 3n) / 4n);
      reasons.push(
        rememberedWeekend
          ? 'You confirmed that weekend spending is higher, so the suggestion is reduced by 25%.'
          : 'Spending was higher on weekend days with recorded expenses, so the suggestion is reduced by 25%.',
      );
    } else if (spike) {
      patternSelected = true;
      selectedPatternId = 'recent-spending-spike';
      pattern = insights.find((i) => i.id === 'recent-spending-spike');
      patternSource = observedSpike ? 'detected' : 'walrus';
      amountCents = Number((BigInt(amountCents) * 3n) / 4n);
      reasons.push(
        observedSpike ? 'Recorded spending in the last seven days was at least twice the previous seven days, so the suggestion is reduced by 25%; records may be incomplete.' : 'Walrus recalled a recent spending increase, so the suggestion is reduced by 25%; the pattern may change.',
      );
    }
    const patternApplied = amountCents !== beforePattern;
    const adjust = (n: number) => patternSelected ? Number((BigInt(n) * 3n) / 4n) : n;
    const paceCents = Number((BigInt(baselineCents) * BigInt(factor)) / 4n);
    const calculate = (goal: number, limit: number, safe: number, pace: number) => adjust(Math.min(goal, limit, safe, pace));
    withoutLimitCents = calculate(summary.remainingCents, Number.MAX_SAFE_INTEGER, safeCents, paceCents);
    const provenance = state.preferences.limitProvenance;
    factors.push(
      { type: 'goal_remaining', value: summary.remainingCents, source: 'goal', affected: calculate(Number.MAX_SAFE_INTEGER, state.preferences.dailyLimitCents, safeCents, paceCents) > amountCents },
      { type: 'available_cash', value: summary.availableCents, source: 'ledger', affected: calculate(summary.remainingCents, state.preferences.dailyLimitCents, Number.MAX_SAFE_INTEGER, paceCents) > amountCents },
      { type: 'cash_buffer', value: state.preferences.bufferCents, source: state.preferences.bufferProvenance?.restored ? 'walrus' : state.preferences.bufferProvenance?.origin ?? 'unknown', origin: state.preferences.bufferProvenance?.origin ?? 'unknown', affected: calculate(summary.remainingCents, state.preferences.dailyLimitCents, Math.max(0, summary.availableCents - billCents), paceCents) > amountCents },
      { type: 'unpaid_bills', value: billCents, source: 'ledger', affected: calculate(summary.remainingCents, state.preferences.dailyLimitCents, Math.max(0, summary.availableCents - state.preferences.bufferCents), paceCents) > amountCents },
      { type: 'pace', value: state.preferences.pace, source: state.preferences.paceProvenance?.restored ? 'walrus' : state.preferences.paceProvenance?.origin ?? 'unknown', origin: state.preferences.paceProvenance?.origin ?? 'unknown', affected: calculate(summary.remainingCents, state.preferences.dailyLimitCents, safeCents, Number.MAX_SAFE_INTEGER) > amountCents },
      { type: 'daily_limit', value: state.preferences.dailyLimitCents, source: provenance?.restored ? 'walrus' : provenance?.origin === 'confirmed' ? 'confirmed' : provenance?.origin === 'manual' || provenance?.origin === 'explicit' ? 'manual' : 'unknown', affected: withoutLimitCents > amountCents, origin: provenance?.origin ?? 'unknown', observations: provenance?.observations, remoteId: provenance?.remoteId },
    );
    if (pattern || (patternSelected && (rememberedWeekend || spike))) factors.push({
      type: pattern?.id ?? selectedPatternId!, value: '25% reduction', source: patternSource,
      affected: patternApplied, observations: selectedPatternId === 'higher-weekend-spending' && rememberedWeekend ? state.weekendProvenance?.observations : pattern?.observations, origin: selectedPatternId === 'higher-weekend-spending' && rememberedWeekend ? 'confirmed' : undefined, remoteId: selectedPatternId === 'higher-weekend-spending' && rememberedWeekend ? state.weekendProvenance?.remoteId : undefined,
    });
    if (billCents)
      reasons.push(
        `Reserved ${formatMoney(billCents, state.preferences.currency)} for unpaid bills.`,
      );
    reasons.push(
      daysRemaining ? `The ${state.preferences.pace} pace uses a ${formatMoney(baselineCents, state.preferences.currency)} daily baseline over ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.` : `Without a target date, the ${state.preferences.pace} pace uses your daily limit as its baseline.`,
    );
    reasons.push(
      `Your ${formatMoney(state.preferences.bufferCents, state.preferences.currency)} buffer and ${formatMoney(state.preferences.dailyLimitCents, state.preferences.currency)} daily limit protect available cash.`,
    );
  }
  if (state.goal?.targetDate && day(state.goal.targetDate) < now)
    reasons.push(
      'The target date has passed, so the remaining goal uses one day.',
    );
  if (!factors.length && reasons.length) factors.push({
    type: 'eligibility', value: reasons[0], source: reasons[0].startsWith('You already') ? 'ledger' : 'goal', affected: true,
  });
  return {
    amountCents,
    baselineCents,
    safeCents,
    billCents,
    reason: reasons.join(' '),
    reasons,
    daysRemaining,
    factors,
    withoutLimitCents,
  };
}
export function estimateUsdCents(phpCents: number, usdPerPhp: string): number {
  if (!Number.isSafeInteger(phpCents) || phpCents < 0 || usdPerPhp.length > 64 || !/^\d+(?:\.\d+)?$/.test(usdPerPhp)) throw new Error('Invalid exchange rate.');
  const [whole, fraction = ''] = usdPerPhp.split('.');
  const numerator = BigInt(whole + fraction);
  const scale = 10n ** BigInt(fraction.length);
  if (!numerator) throw new Error('Invalid exchange rate.');
  const result = (BigInt(phpCents) * numerator + scale / 2n) / scale;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Estimate is too large.');
  return Number(result);
}
