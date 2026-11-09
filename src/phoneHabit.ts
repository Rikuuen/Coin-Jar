import { detectInsights, validateDate } from './domain';
import { journalState, type PhoneJournal } from './phoneJournal';
export { detectedDailyHabit } from './phoneDailyPattern';
export type { DailyHabit } from './phoneDailyPattern';
import type { DailyHabit } from './phoneDailyPattern';

export const HABIT_PREFIX = 'COINJAR_PHONE_HABIT_V1 ';
export type WeekendHabit = { type: 'higher-weekend-spending'; weekendDays: number; weekdayDays: number; observedThrough: string };
export type SpikeHabit = { type: 'recent-spending-spike'; recentDays: number; previousDays: number; observedThrough: string };

export function nextDay(date: string): string {
  if (!validateDate(date)) throw new Error('Invalid date');
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

export function detectedWeekendHabit(journal: PhoneJournal, today: string): WeekendHabit | null {
  const insight = detectInsights(journalState(journal), today).find(item => item.id === 'higher-weekend-spending');
  const match = insight?.observations[0]?.match(/^(\d+) weekend days and (\d+) weekdays/);
  if (!match || !insight?.periodEnd) return null;
  return { type: 'higher-weekend-spending', weekendDays: Number(match[1]), weekdayDays: Number(match[2]), observedThrough: insight.periodEnd };
}

export function habitMemory(habit: WeekendHabit): string { return HABIT_PREFIX + JSON.stringify(habit); }
export function dailyHabitMemory(habit: DailyHabit): string { return HABIT_PREFIX + JSON.stringify(habit); }

export function parseDailyHabitMemory(text: unknown, today: string): DailyHabit | null {
  if (typeof text !== 'string' || !text.startsWith(HABIT_PREFIX) || text.length > 400 || !validateDate(today)) return null;
  try {
    const item = JSON.parse(text.slice(HABIT_PREFIX.length));
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'days,observedThrough,recordedDays,sampleDays,type' || item.type !== 'higher-day-spending' || !Array.isArray(item.days) || item.days.length > 7 || !Array.isArray(item.sampleDays) || item.days.length !== item.sampleDays.length || !Number.isInteger(item.recordedDays) || item.recordedDays < 6 || item.recordedDays > 56 || !validateDate(item.observedThrough)) return null;
    if (item.days.some((day: unknown, i: number) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6 || (i > 0 && Number(day) <= item.days[i - 1]) || !Number.isInteger(item.sampleDays[i]) || item.sampleDays[i] < 3 || item.sampleDays[i] > 8 || item.recordedDays - item.sampleDays[i] < 3)) return null;
    if (item.sampleDays.reduce((sum: number, n: number) => sum + n, 0) > item.recordedDays) return null;
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${item.observedThrough}T00:00:00Z`)) / 86400000;
    if (age < 0 || age > 55) return null;
    return { type: item.type, days: item.days, sampleDays: item.sampleDays, recordedDays: item.recordedDays, observedThrough: item.observedThrough };
  } catch { return null; }
}

export function detectedSpikeHabit(journal: PhoneJournal, today: string): SpikeHabit | null {
  const insight = detectInsights(journalState(journal), today).find(item => item.id === 'recent-spending-spike');
  const counts = [...(insight?.observations[0] ?? '').matchAll(/across (\d+) recorded expense days/g)].map(match => Number(match[1]));
  if (counts.length !== 2 || !insight?.periodEnd) return null;
  return { type: 'recent-spending-spike', recentDays: counts[0], previousDays: counts[1], observedThrough: insight.periodEnd };
}

export function spikeMemory(habit: SpikeHabit): string { return HABIT_PREFIX + JSON.stringify(habit); }

export function parseSpikeMemory(text: unknown, today: string): SpikeHabit | null {
  if (typeof text !== 'string' || !text.startsWith(HABIT_PREFIX) || text.length > 400 || !validateDate(today)) return null;
  try {
    const item = JSON.parse(text.slice(HABIT_PREFIX.length));
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'observedThrough,previousDays,recentDays,type' || item.type !== 'recent-spending-spike' || !Number.isInteger(item.recentDays) || item.recentDays < 3 || item.recentDays > 7 || !Number.isInteger(item.previousDays) || item.previousDays < 3 || item.previousDays > 7 || !validateDate(item.observedThrough)) return null;
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${item.observedThrough}T00:00:00Z`)) / 86400000;
    if (age < 0 || age > 6) return null;
    return { type: item.type, recentDays: item.recentDays, previousDays: item.previousDays, observedThrough: item.observedThrough };
  } catch { return null; }
}

export function parseHabitMemory(text: unknown, today: string): WeekendHabit | null {
  if (typeof text !== 'string' || !text.startsWith(HABIT_PREFIX) || text.length > 400 || !validateDate(today)) return null;
  try {
    const item = JSON.parse(text.slice(HABIT_PREFIX.length));
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'observedThrough,type,weekdayDays,weekendDays' || item.type !== 'higher-weekend-spending' || !Number.isInteger(item.weekendDays) || item.weekendDays < 3 || item.weekendDays > 16 || !Number.isInteger(item.weekdayDays) || item.weekdayDays < 3 || item.weekdayDays > 40 || !validateDate(item.observedThrough)) return null;
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${item.observedThrough}T00:00:00Z`)) / 86400000;
    if (age < 0 || age > 55) return null;
    return { type: item.type, weekendDays: item.weekendDays, weekdayDays: item.weekdayDays, observedThrough: item.observedThrough };
  } catch { return null; }
}
