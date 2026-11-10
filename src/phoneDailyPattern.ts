import type { PhoneJournal } from './phoneJournal';
import { validateDate } from './domain';

export type DailyHabit = { type: 'higher-day-spending'; days: number[]; sampleDays: number[]; recordedDays: number; observedThrough: string };
const DAY = 86400000;

export function dailyEvidence(journal: PhoneJournal, today: string, weekday: number) {
  const end = Date.parse(`${today}T00:00:00Z`), totals = new Map<string, bigint>();
  for (const entry of journal.entries) {
    const when = Date.parse(`${entry.date}T00:00:00Z`);
    if (entry.voidedAt || entry.kind !== 'expense' || when > end || when < end - 55 * DAY) continue;
    totals.set(entry.date, (totals.get(entry.date) ?? 0n) + BigInt(entry.amountCents));
  }
  const selected = [...totals].filter(([date]) => new Date(`${date}T00:00:00Z`).getUTCDay() === weekday);
  const other = [...totals].filter(([date]) => new Date(`${date}T00:00:00Z`).getUTCDay() !== weekday);
  const enough = selected.length >= 3 && other.length >= 3;
  const sum = (items: [string, bigint][]) => items.reduce((n, [, value]) => n + value, 0n);
  const high = enough && sum(other) > 0n && sum(selected) * BigInt(other.length) >= 2n * sum(other) * BigInt(selected.length);
  const previousSelected = selected.filter(([date]) => date < today);
  const previousOther = other.filter(([date]) => date < today);
  const recent = [...totals].filter(([date]) => date < today && Date.parse(`${date}T00:00:00Z`) >= end - 7 * DAY);
  const bounded = (value: bigint) => Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
  const average = (items: [string, bigint][]) => items.length < 3 ? null : bounded((sum(items) + BigInt(items.length) - 1n) / BigInt(items.length));
  return { enough, high, sampleDays: selected.length, recordedDays: totals.size, observedThrough: [...totals.keys()].sort().at(-1) ?? today, weekdayEstimate: average(previousSelected), otherEstimate: average(previousOther), recentEstimate: average(recent), spentToday: bounded(totals.get(today) ?? 0n) };
}

export function detectedDailyHabit(journal: PhoneJournal, today: string): DailyHabit | null {
  if (!validateDate(today)) throw Error('Invalid date');
  const evidence = Array.from({ length: 7 }, (_, day) => ({ day, ...dailyEvidence(journal, today, day) }));
  const high = evidence.filter(item => item.high);
  return evidence[0].recordedDays >= 6 ? { type: 'higher-day-spending', days: high.map(item => item.day), sampleDays: high.map(item => item.sampleDays), recordedDays: evidence[0].recordedDays, observedThrough: evidence[0].observedThrough } : null;
}
