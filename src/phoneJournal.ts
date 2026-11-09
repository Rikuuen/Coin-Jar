import { createInitialState, detectInsights, formatMoney, getSummary, validateDate, type AppState, type Entry, type Goal } from './domain';
import { mainnetDemo } from './phoneNetwork';
import { dailyEvidence } from './phoneDailyPattern';

export const JOURNAL_KEY = mainnetDemo ? 'coinjar.phone.demo.journal.v1' : 'coinjar.phone.journal.v1';
export type PhoneJournal = { version: 1; nickname?: string; currency: 'PHP' | 'USD'; openingCents: number; openingDate: string; bufferCents: number; dailyLimitCents: number; entries: Entry[]; goal: Goal | null; adjustments: { id: string; date: string; deltaCents: number; createdAt: string }[] };
const amount = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const text = (s: unknown, max: number) => typeof s === 'string' && s.length <= max;
const date = (d: unknown): d is string => typeof d === 'string' && validateDate(d);

export function validateJournal(value: unknown): PhoneJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup file.');
  const j = value as PhoneJournal;
  if (j.nickname !== undefined && (!text(j.nickname, 40) || !j.nickname.trim())) throw new Error('Invalid backup file.');
  if (j.version !== 1 || !['PHP', 'USD'].includes(j.currency) || !amount(j.openingCents) || !date(j.openingDate) || !amount(j.bufferCents) || !amount(j.dailyLimitCents) || !Array.isArray(j.entries) || j.entries.length > 10000 || !Array.isArray(j.adjustments) || j.adjustments.length > 10000) throw new Error('Invalid backup file.');
  if (j.entries.some(e => !e || !text(e.id, 100) || !e.id || !['income', 'expense', 'contribution'].includes(e.kind) || !amount(e.amountCents) || !e.amountCents || !date(e.date) || e.date < j.openingDate || !text(e.note, 80) || !text(e.createdAt, 100))) throw new Error('Invalid backup file.');
  if (j.adjustments.some(a => !a || !text(a.id, 100) || !a.id || !date(a.date) || a.date < j.openingDate || !Number.isSafeInteger(a.deltaCents) || !text(a.createdAt, 100))) throw new Error('Invalid backup file.');
  if (j.goal !== null && (!j.goal || !text(j.goal.id, 100) || !j.goal.id || !text(j.goal.title, 80) || !j.goal.title.trim() || !amount(j.goal.targetCents) || !j.goal.targetCents || (j.goal.targetDate !== undefined && !date(j.goal.targetDate)) || (j.goal.phoneStartDate !== undefined && !date(j.goal.phoneStartDate)) || (j.goal.phoneBaselineCents !== undefined && !amount(j.goal.phoneBaselineCents)) || j.goal.status !== 'active' || !text(j.goal.createdAt, 100))) throw new Error('Invalid backup file.');
  if (j.goal && ((j.goal.phoneBaselineCents !== undefined && j.goal.phoneBaselineCents > j.goal.targetCents) || (j.goal.phoneStartDate && j.goal.targetDate && j.goal.phoneStartDate > j.goal.targetDate))) throw new Error('Invalid backup file.');
  const ids = [...j.entries.map(e => e.id), ...j.adjustments.map(a => a.id)];
  if (new Set(ids).size !== ids.length) throw new Error('Invalid backup file.');
  const normalized: PhoneJournal = { version: 1, ...(j.nickname ? { nickname: j.nickname.trim() } : {}), currency: j.currency, openingCents: j.openingCents, openingDate: j.openingDate, bufferCents: j.bufferCents, dailyLimitCents: j.dailyLimitCents, entries: j.entries.map(({ id, kind, amountCents, date, note, createdAt }) => ({ id, kind, amountCents, date, note, createdAt })), adjustments: j.adjustments.map(({ id, date, deltaCents, createdAt }) => ({ id, date, deltaCents, createdAt })), goal: j.goal ? { id: j.goal.id, title: j.goal.title, targetCents: j.goal.targetCents, ...(j.goal.targetDate ? { targetDate: j.goal.targetDate } : {}), ...(j.goal.phoneStartDate ? { phoneStartDate: j.goal.phoneStartDate } : {}), ...(j.goal.phoneBaselineCents !== undefined ? { phoneBaselineCents: j.goal.phoneBaselineCents } : {}), status: 'active', createdAt: j.goal.createdAt } : null };
  const state = journalState(normalized);
  getSummary(state, '9999-12-31');
  return normalized;
}

export function journalState(j: PhoneJournal): AppState {
  const state = createInitialState(j.openingDate);
  state.openingCashCents = j.openingCents;
  state.openingCashDate = j.openingDate;
  state.preferences = { ...state.preferences, currency: j.currency, bufferCents: j.bufferCents, dailyLimitCents: j.dailyLimitCents };
  state.entries = j.entries;
  state.goal = j.goal;
  state.balanceAdjustments = j.adjustments;
  return state;
}

export function savings(j: PhoneJournal, today: string, rememberedDays: number[] = [], rememberedSpike = false) {
  const state = journalState(j);
  const summary = getSummary(state, today), goal = j.goal, reasons: string[] = [];
  let amountCents = 0, baselineCents = 0;
  const dayNumber = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86400000);
  if (!goal) reasons.push('Create a goal to receive a suggestion.');
  else if (!summary.remainingCents) reasons.push('Your goal has been reached.');
  else if (!goal.targetDate) reasons.push('Add a target date to get a daily suggestion.');
  else {
    const daysLeft = dayNumber(goal.targetDate) - dayNumber(today) + 1;
    baselineCents = daysLeft > 0 ? Math.ceil(summary.remainingCents / daysLeft) : 0;
    const savedToday = j.entries.some(e => e.kind === 'contribution' && e.date === today);
    if (daysLeft <= 0) reasons.push('The target date has passed. Update your goal date to make a new plan.');
    else if (savedToday) reasons.push('You already recorded savings today.');
    else {
      const insights = detectInsights(state, today);
      const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
      const evidence = dailyEvidence(j, today, weekday);
      const rememberedHighDay = !evidence.enough && rememberedDays.includes(weekday);
      const highDay = evidence.enough ? evidence.high : rememberedHighDay;
      const spike = insights.some(i => i.id === 'recent-spending-spike' && i.status !== 'dismissed') || (rememberedSpike && !insights.some(i => i.id === 'recent-spending-change'));
      const recalledEstimate = rememberedHighDay && evidence.otherEstimate !== null ? Number((BigInt(evidence.otherEstimate) * 2n) > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(evidence.otherEstimate) * 2n) : null;
      const estimate = evidence.weekdayEstimate ?? recalledEstimate ?? (spike ? evidence.recentEstimate : null);
      const reserve = estimate === null ? 0 : Math.max(0, estimate - evidence.spentToday);
      const available = Math.max(0, summary.availableCents - reserve);
      amountCents = Math.min(summary.remainingCents, available, baselineCents);
      if (estimate !== null) reasons.push(`Estimated spending still to come: ${formatMoney(reserve, j.currency)}, ${recalledEstimate !== null && evidence.weekdayEstimate === null ? 'a rough estimate from a remembered pattern and other recorded days' : 'based on recorded expense days'}.`);
      else if (highDay || spike) reasons.push('A higher-spending pattern was found, but there is not enough local expense history to estimate an amount.');
      else reasons.push('Not enough recorded expenses to estimate spending for this day.');
      if (amountCents < baselineCents) reasons.push('Your recorded balance after estimated spending is below the daily goal pace.');
      const gap = Math.max(0, summary.remainingCents - available);
      if (gap) reasons.push(`Your recorded balance after estimated spending is ${formatMoney(gap, j.currency)} short of the remaining goal. Future income and expenses are not included.`);
      reasons.push(`To reach your goal by the target date, the remaining amount is about ${formatMoney(baselineCents, j.currency)} per day for ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`);
    }
    if (daysLeft === 1 && savedToday && summary.remainingCents) reasons.push('Your target date is today and your goal is not yet complete.');
  }
  return { summary, recommendation: { amountCents, baselineCents, reasons, reason: reasons.join(' ') } };
}

export function newJournal(currency: 'PHP' | 'USD', openingCents: number, today: string, nickname?: string): PhoneJournal {
  return validateJournal({ version: 1, ...(nickname ? { nickname } : {}), currency, openingCents, openingDate: today, bufferCents: 20000, dailyLimitCents: 1500, entries: [], adjustments: [], goal: null });
}
