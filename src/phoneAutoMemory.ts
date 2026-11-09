import { useEffect, useRef, useState } from 'react';
import { preferenceMemory } from './phoneMemory';
import type { PhoneJournal } from './phoneJournal';
import { memoryHeaders, memoryStorageSuffix, personalHeadersFor, personalStorageSuffix, walrusNetwork } from './phoneNetwork';

const CONFIG = 'coinjar.phone.walrus.auto.v1' + memoryStorageSuffix;
const PENDING = 'coinjar.phone.walrus.pending.v1' + memoryStorageSuffix;
const SAVED = 'coinjar.phone.walrus.saved.v1' + memoryStorageSuffix;
const validCode = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
type Config = { enabled: boolean; code: string; habits: boolean; recentHabits: boolean; personal: boolean; restorePending: boolean };

function load(): Config {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIG) ?? 'null');
    return value?.enabled === true && typeof value.code === 'string' && validCode(value.code) ? { enabled: true, code: value.code, habits: value.habits === true, recentHabits: value.recentHabits === true, personal: value.personal === true, restorePending: value.restorePending === true } : { enabled: false, code: '', habits: false, recentHabits: false, personal: false, restorePending: false };
  } catch { return { enabled: false, code: '', habits: false, recentHabits: false, personal: false, restorePending: false }; }
}

export function usePhoneAutoMemory(journal: PhoneJournal | null) {
  const [config, setConfig] = useState(load);
  const [status, setStatus] = useState('');
  const [retry, setRetry] = useState(0);
  const running = useRef(false);
  const enabledRef = useRef(config.enabled);
  const desired = journal ? preferenceMemory(journal) : '';

  function configure(enabled: boolean, code: string, habits = false, recentHabits = false, personal = config.personal, restorePending = config.restorePending) {
    if (enabled && !validCode(code)) throw new Error('Enter the 43-character Walrus access code.');
    const next = enabled ? { enabled: true, code, habits, recentHabits, personal, restorePending } : { enabled: false, code: '', habits: false, recentHabits: false, personal: false, restorePending: false };
    if (enabled) localStorage.setItem(CONFIG, JSON.stringify(next));
    else localStorage.removeItem(CONFIG);
    enabledRef.current = enabled;
    setConfig(next);
    setStatus(enabled ? 'Preparing to save preferences to Walrus.' : 'Automatic Walrus saving is off.');
    setRetry(n => n + 1);
  }

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== CONFIG && event.key !== null) return;
      const next = load();
      enabledRef.current = next.enabled;
      setConfig(next);
      if (!next.enabled) setStatus('Automatic Walrus saving is off.');
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);

  useEffect(() => {
    if (!journal || !config.enabled || !desired) return;
    if (config.restorePending) { setStatus('Review your saved preferences in Profile before syncing.'); return; }
    let cancelled = false;
    const online = () => setRetry(n => n + 1);
    window.addEventListener('online', online);
    const timer = window.setTimeout(async () => {
      if (running.current) return;
      let pending: { memory: string; operationId: string };
      let pendingKey = PENDING, savedKey = SAVED;
      try {
        if (config.personal) { const suffix = await personalStorageSuffix(config.code); pendingKey += suffix; savedKey += suffix; }
        if (cancelled) return;
        const stored = localStorage.getItem(pendingKey);
        if (!stored && localStorage.getItem(savedKey) === desired) { setStatus(`Preferences saved to Walrus ${config.personal ? 'mainnet' : walrusNetwork}.`); return; }
        pending = stored ? JSON.parse(stored) : { memory: desired, operationId: crypto.randomUUID() };
        if (typeof pending.memory !== 'string' || !/^COINJAR_PHONE_PREFERENCES_V[12] /.test(pending.memory) || !/^[0-9a-f-]{36}$/.test(pending.operationId)) throw new Error('Invalid pending memory');
        if (!stored) localStorage.setItem(pendingKey, JSON.stringify(pending));
      } catch { setStatus('Walrus sync paused. Check device storage.'); return; }
      if (!navigator.onLine) { setStatus('Offline. Preferences remain on this device and will sync when online.'); return; }
      running.current = true;
      setStatus(`Saving preferences to Walrus ${config.personal ? 'mainnet' : walrusNetwork}…`);
      try {
      const response = await fetch('/api/phone/walrus', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.code}`, ...(config.personal ? await personalHeadersFor(config.code) : memoryHeaders) }, body: JSON.stringify({ consent: true, action: 'remember', memory: pending.memory, operationId: pending.operationId }) });
        const result = await response.json();
        if (!response.ok || result.saved !== true) throw new Error('Not confirmed');
        localStorage.setItem(savedKey, pending.memory);
        localStorage.removeItem(pendingKey);
        if (enabledRef.current) { setStatus(`Preferences saved to Walrus ${config.personal ? 'mainnet' : walrusNetwork}.`); setRetry(n => n + 1); }
      } catch { if (enabledRef.current) setStatus('Could not confirm Walrus sync. Your preferences remain on this device; CoinJar will retry when reopened or back online.'); }
      finally { running.current = false; }
    }, 400);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('online', online); };
  }, [config.enabled, config.code, config.personal, config.restorePending, desired, journal !== null, retry]);

  function finishRecovery() { configure(true, config.code, config.habits, config.recentHabits, config.personal, false); }
  return { config, status, configure, finishRecovery };
}
