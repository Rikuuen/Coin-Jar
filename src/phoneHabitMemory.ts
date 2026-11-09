import { useEffect, useState } from 'react';
import { detectedDailyHabit, detectedSpikeHabit, dailyHabitMemory, spikeMemory, parseDailyHabitMemory, parseSpikeMemory, type DailyHabit, type SpikeHabit } from './phoneHabit';
import type { PhoneJournal } from './phoneJournal';
import { memoryHeaders, memoryStorageSuffix, personalMemoryHeaders, personalStorageSuffix, walrusNetwork } from './phoneNetwork';

type Codec<T> = { pending: string; detect: (journal: PhoneJournal, today: string) => T | null; encode: (habit: T) => string; parse: (text: unknown, today: string) => T | null; score: (habit: T) => number; useful?: (item: T) => boolean };
const daily: Codec<DailyHabit> = { pending: 'coinjar.phone.walrus.days.pending.v1' + memoryStorageSuffix, detect: detectedDailyHabit, encode: dailyHabitMemory, parse: parseDailyHabitMemory, score: item => item.recordedDays, useful: item => item.days.length > 0 };
const spike: Codec<SpikeHabit> = { pending: 'coinjar.phone.walrus.spike.pending.v1' + memoryStorageSuffix, detect: detectedSpikeHabit, encode: spikeMemory, parse: parseSpikeMemory, score: item => item.recentDays + item.previousDays };

function useMemory<T extends { observedThrough: string }>(journal: PhoneJournal | null, today: string, enabled: boolean, code: string, personal: boolean, codec: Codec<T>) {
  const [remembered, setRemembered] = useState<T | null>(null);
  const [status, setStatus] = useState('');
  const [retry, setRetry] = useState(0);
  const detected = journal ? codec.detect(journal, today) : null;
  const candidate = detected ? codec.encode(detected) : '';
  useEffect(() => {
    if (!journal || !enabled) { setRemembered(null); setStatus(''); return; }
    const controller = new AbortController();
    let cancelled = false;
    const online = () => setRetry(n => n + 1);
    window.addEventListener('online', online);
    async function request(payload: object) {
      const response = await fetch('/api/phone/walrus', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${code}`, ...(personal ? personalMemoryHeaders : memoryHeaders) }, body: JSON.stringify({ consent: true, ...payload }) });
      const value = await response.json();
      if (!response.ok) throw new Error('Walrus unavailable');
      return value;
    }
    async function recall(): Promise<T[]> {
      const value = await request({ action: 'recallHabit' });
      if (!Array.isArray(value.memories)) throw new Error('Invalid recall');
      return value.memories.map((text: unknown) => codec.parse(text, today)).filter((item: T | null): item is T => item !== null).sort((a: T, b: T) => b.observedThrough.localeCompare(a.observedThrough) || codec.score(b) - codec.score(a));
    }
    async function run() {
      try {
        if (!navigator.onLine) throw new Error('Offline');
        setStatus('Checking Walrus for remembered spending habits…');
        const pendingKey = codec.pending + (personal ? await personalStorageSuffix(code) : '');
        if (cancelled) return;
        let memories = await recall();
        if (cancelled) return;
        setRemembered(memories[0] ?? null);
        let stored = localStorage.getItem(pendingKey);
        if (stored) {
          const old = JSON.parse(stored);
          const observed = typeof old.memory === 'string' ? JSON.parse(old.memory.slice('COINJAR_PHONE_HABIT_V1 '.length)).observedThrough : null;
          if (typeof observed === 'string' && observed < today && codec.parse(old.memory, observed) && !codec.parse(old.memory, today)) {
            localStorage.removeItem(pendingKey);
            stored = null;
          }
        }
        const pending = stored ? JSON.parse(stored) : candidate ? { memory: candidate, operationId: crypto.randomUUID() } : null;
        if (pending && (!codec.parse(pending.memory, today) || !/^[0-9a-f-]{36}$/.test(pending.operationId))) throw new Error('Invalid pending habit');
        if (pending && !memories.some(item => codec.encode(item) === pending.memory)) {
          if (!stored) localStorage.setItem(pendingKey, JSON.stringify(pending));
          setStatus(`Saving your approved spending pattern to Walrus ${personal ? 'mainnet' : walrusNetwork}…`);
          const result = await request({ action: 'remember', ...pending });
          if (result.saved !== true) throw new Error('Save not confirmed');
          if (cancelled) return;
          memories = await recall();
          if (!memories.some(item => codec.encode(item) === pending.memory)) throw new Error('Recall not confirmed');
        }
        if (cancelled) return;
        if (pending) localStorage.removeItem(pendingKey);
        setRemembered(memories[0] ?? null);
        setStatus(!memories.length ? 'Still learning: more recorded expenses are needed.' : codec.useful && !codec.useful(memories[0]) ? 'No higher-spending day found in your recorded history.' : `Using an approved spending pattern recalled from Walrus ${personal ? 'mainnet' : walrusNetwork}.`);
        if (stored && candidate && pending?.memory !== candidate) setRetry(n => n + 1);
      } catch {
        if (!cancelled) { setRemembered(null); setStatus('Walrus habits unavailable. The suggestion uses your phone data. CoinJar will retry when reopened or online.'); }
      }
    }
    void run();
    return () => { cancelled = true; controller.abort(); window.removeEventListener('online', online); };
  }, [enabled, code, personal, today, candidate, journal !== null, retry, codec]);
  return { remembered: enabled ? remembered : null, status: enabled ? status : '' };
}

export function usePhoneHabitMemory(journal: PhoneJournal | null, today: string, enabled: boolean, code: string, personal = false) { return useMemory(journal, today, enabled, code, personal, daily); }
export function usePhoneSpikeMemory(journal: PhoneJournal | null, today: string, enabled: boolean, code: string, personal = false) { return useMemory(journal, today, enabled, code, personal, spike); }
