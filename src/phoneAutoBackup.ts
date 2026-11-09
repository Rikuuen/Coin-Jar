import { useEffect, useRef, useState } from 'react';
import { decryptJournal, encryptJournal, recoveryRequest } from './journalCipher';
import { JOURNAL_KEY, validateJournal, type PhoneJournal } from './phoneJournal';
import { mainnetDemo } from './phoneNetwork';

const PREFIX = 'coinjar.phone.auto-backup.v1' + (mainnetDemo ? '.demo' : '');
const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
const snapshot = (journal: PhoneJournal) => JSON.stringify(validateJournal(journal));

export async function withJournalLock<T>(code: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) return action();
  return navigator.locks.request(`${PREFIX}.${await hash(code)}`, action);
}

export async function markJournalRestored(code: string, journal: PhoneJournal) {
  const suffix = await hash(code);
  localStorage.setItem(`${PREFIX}.last.${suffix}`, await hash(snapshot(journal)));
  localStorage.removeItem(`${PREFIX}.pending.${suffix}`);
}

export async function useCurrentJournalForBackup(code: string) {
  await withJournalLock(code, async () => {
    const result = await recoveryRequest(code, 'backupRestore');
    const remote = await decryptJournal(code, result.envelope);
    if (!window.confirm(`Use this device's journal for future backups? The current Walrus backup contains ${remote.entries.length} activity entries. Restore it first if you want to keep those entries here.`)) return;
    const suffix = await hash(code);
    if (localStorage.getItem(`${PREFIX}.pending.${suffix}`)) throw Error('A previous backup is still pending. Retry it before changing the backup source.');
    localStorage.setItem(`${PREFIX}.last.${suffix}`, await hash(snapshot(remote)));
  });
}

export function usePhoneAutoBackup(journal: PhoneJournal, code: string, enabled: boolean) {
  const [status, setStatus] = useState('');
  const [retry, setRetry] = useState(0);
  const current = useRef({ journal, code, enabled });
  current.current = { journal, code, enabled };
  const value = snapshot(journal);

  useEffect(() => {
    if (!enabled || !code) { setStatus(''); return; }
    let cancelled = false;
    const online = () => setRetry(n => n + 1);
    window.addEventListener('online', online);
    setStatus('Checking whether your journal needs a backup…');
    const timer = window.setTimeout(() => void (async () => {
      try {
        if (!navigator.onLine) throw Error('Offline');
        if (!navigator.locks) throw Error('Automatic backup is unavailable in this browser.');
        const suffix = await hash(code), lastKey = `${PREFIX}.last.${suffix}`, pendingKey = `${PREFIX}.pending.${suffix}`;
        await navigator.locks.request(`${PREFIX}.${suffix}`, async () => {
          if (cancelled || !current.current.enabled || current.current.code !== code) return;
          if (localStorage.getItem(JOURNAL_KEY) !== snapshot(current.current.journal)) {
            setStatus('Automatic backup paused: this journal changed in another tab. Reload CoinJar.');
            return;
          }
          const desired = await hash(snapshot(current.current.journal));
          let pending = JSON.parse(localStorage.getItem(pendingKey) || 'null') as { digest: string; envelope: Awaited<ReturnType<typeof encryptJournal>>['envelope']; operationId: string } | null;
          const last = localStorage.getItem(lastKey);
          setStatus('Checking encrypted journal backup…');
          let remote: string | null;
          try {
            const result = await recoveryRequest(code, 'backupRestore');
            remote = await hash(snapshot(await decryptJournal(code, result.envelope)));
          } catch (error) {
            if (error instanceof Error && error.message === 'No recovery backup found.') remote = null;
            else throw error;
          }
          if (remote !== null && remote === desired) {
            localStorage.setItem(lastKey, desired);
            localStorage.removeItem(pendingKey);
            setStatus('Journal backed up to Walrus.');
            return;
          }
          if (pending && remote === pending.digest) {
            localStorage.setItem(lastKey, pending.digest);
            localStorage.removeItem(pendingKey);
            pending = null;
          } else if (remote !== null && remote !== last && remote !== desired) {
            setStatus('Automatic backup paused: the saved journal is different. Restore or review it before continuing.');
            return;
          } else if (remote === null && last) {
            setStatus('Automatic backup paused: the previous backup could not be found.');
            return;
          }
          if (!pending) {
            const captured = current.current.journal;
            const encrypted = await encryptJournal(code, captured);
            pending = { digest: await hash(snapshot(captured)), envelope: encrypted.envelope, operationId: crypto.randomUUID() };
            localStorage.setItem(pendingKey, JSON.stringify(pending));
          }
          if (cancelled || !current.current.enabled || current.current.code !== code || localStorage.getItem(JOURNAL_KEY) !== snapshot(current.current.journal)) return;
          setStatus('Saving encrypted journal to Walrus…');
          await recoveryRequest(code, 'backupSave', pending.envelope, pending.operationId);
          localStorage.setItem(lastKey, pending.digest);
          localStorage.removeItem(pendingKey);
          if (await hash(snapshot(current.current.journal)) !== pending.digest) setRetry(n => n + 1);
          else setStatus('Journal backed up to Walrus.');
        });
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error && error.message === 'Automatic backup is unavailable in this browser.' ? error.message : 'Backup not confirmed. Your journal stays on this device; retry when online or reopen CoinJar.');
      }
    })(), 700);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener('online', online); };
  }, [code, enabled, value, retry]);
  return { status, retry: () => setRetry(n => n + 1) };
}
