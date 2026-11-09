import { validateJournal, type PhoneJournal } from './phoneJournal';

const PREFIX = 'COINJAR_PHONE_PREFERENCES_V2 ';
const LEGACY = 'COINJAR_PHONE_PREFERENCES_V1 ';

export function preferenceMemory(journal: PhoneJournal): string {
  const { currency } = validateJournal(journal);
  return PREFIX + JSON.stringify({ currency, origin: 'manual' });
}

export function applyPreferenceMemory(journal: PhoneJournal, memory: string): PhoneJournal {
  if (typeof memory !== 'string' || (!memory.startsWith(PREFIX) && !memory.startsWith(LEGACY)) || memory.length > 1000) throw new Error('Invalid memory');
  const legacy = memory.startsWith(LEGACY);
  let value: Record<string, unknown>;
  try { value = JSON.parse(memory.slice((legacy ? LEGACY : PREFIX).length)); } catch { throw new Error('Invalid memory'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== (legacy ? 'bufferCents,currency,dailyLimitCents,origin' : 'currency,origin') || value.currency !== journal.currency || value.origin !== 'manual' || (legacy && (!Number.isSafeInteger(value.bufferCents) || Number(value.bufferCents) < 0 || !Number.isSafeInteger(value.dailyLimitCents) || Number(value.dailyLimitCents) < 0))) throw new Error('Invalid memory');
  return validateJournal(journal);
}
