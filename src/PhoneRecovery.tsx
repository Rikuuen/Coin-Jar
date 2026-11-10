import React, { useEffect, useState } from 'react';
import { mainnetDemo, newMemoryCode } from './phoneNetwork';
import { decryptJournal, recoveryRequest } from './journalCipher';
import type { PhoneJournal } from './phoneJournal';
import { markJournalRestored, useCurrentJournalForBackup, usePhoneAutoBackup, withJournalLock } from './phoneAutoBackup';

const KEY = 'coinjar.phone.recovery.key.v1' + (mainnetDemo ? '.demo' : '');
const AUTO = KEY + '.automatic';
const validKey = (code: string) => /^[A-Za-z0-9_-]{43}$/.test(code);
export function hasRecoveryKey() { try { return validKey(localStorage.getItem(KEY) ?? ''); } catch { return false; } }

export default function PhoneRecovery({ journal, apply, memoryCode, onStatusChange }: { journal: PhoneJournal; apply: (value: PhoneJournal) => boolean; memoryCode: string; onStatusChange?: (status: string) => void }) {
  const [code, setCode] = useState(() => localStorage.getItem(KEY) ?? '');
  const [automatic, setAutomatic] = useState(() => hasRecoveryKey() && localStorage.getItem(KEY) !== memoryCode);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const autoBackup = usePhoneAutoBackup(journal, code, automatic);
  useEffect(() => { onStatusChange?.(automatic ? (autoBackup.status || 'Checking backup…') : 'Backup not set up'); }, [automatic, autoBackup.status, onStatusChange]);
  useEffect(() => {
    if (automatic) localStorage.setItem(AUTO, '1');
  }, [automatic]);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === KEY || event.key === null) {
        const next = localStorage.getItem(KEY) ?? '';
        setCode(next); setAutomatic(validKey(next) && next !== memoryCode);
      }
      if (event.key === AUTO && event.newValue === null) setAutomatic(false);
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [memoryCode]);

  function confirmKey() {
    if (!validKey(code) || code === memoryCode) { setMessage('Save a separate valid recovery key first.'); return; }
    try { localStorage.setItem(KEY, code); localStorage.setItem(AUTO, '1'); setAutomatic(true); setMessage(''); }
    catch { setMessage('Could not save the recovery key on this device.'); }
  }
  async function restore() {
    if (!validKey(code) || code === memoryCode) { setMessage('Enter your separate recovery key, not your memory access code.'); return; }
    const wasAutomatic = automatic;
    localStorage.removeItem(AUTO); setAutomatic(false);
    setBusy(true); setMessage('Finding your encrypted journal.');
    let restoredSuccessfully = false;
    try {
      await withJournalLock(code, async () => {
        const result = await recoveryRequest(code, 'backupRestore');
        const restored = await decryptJournal(code, result.envelope);
        if (!window.confirm(`Replace this device’s journal with the backup? It contains ${restored.entries.length} activity entries. Your current journal on this device will be replaced.`)) { setMessage('Restore cancelled. Your journal is unchanged.'); return; }
        if (apply(restored)) {
          await markJournalRestored(code, restored);
          localStorage.setItem(KEY, code); localStorage.setItem(AUTO, '1');
          restoredSuccessfully = true; setAutomatic(true);
          setMessage('Journal restored on this device. Automatic backup is on.');
        } else setMessage('Could not restore the journal. Your current data was not changed.');
      });
    } catch { setMessage('Could not restore the backup. Check the recovery key and connection. Your journal is unchanged.'); }
    finally { if (!restoredSuccessfully && wasAutomatic) { localStorage.setItem(AUTO, '1'); setAutomatic(true); } setBusy(false); }
  }
  return <section className="simple-section"><div className="phone-card-head"><h2>Journal recovery</h2><span className={`phone-chip${automatic ? ' on' : ''}`}>{automatic ? 'Backup on' : 'Not set up'}</span></div><p className="simple-hint">CoinJar backs up your journal automatically, encrypted with a recovery key only you keep.</p><p className="phone-warning">Keep the key offline and separate from your memory code. Anyone with it can open your backup, and if you lose it the backup can’t be recovered.</p><label>Recovery key<input type={showKey ? 'text' : 'password'} autoComplete="off" value={code} onChange={event => { localStorage.removeItem(AUTO); setAutomatic(false); setCode(event.target.value.trim()); }} /></label><div className="simple-actions"><button type="button" className="simple-button outline" onClick={() => { if (code && !window.confirm('Generate a new recovery key? Keep the old key to restore earlier backups.')) return; localStorage.removeItem(AUTO); setAutomatic(false); setCode(newMemoryCode()); }}>Generate key</button><button type="button" className="simple-button outline" disabled={!code} onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(code).then(() => setMessage('Recovery key copied.'), () => setMessage('Select the recovery key to copy it.')); }}>Copy key</button></div><label className="simple-check"><input type="checkbox" checked={showKey} onChange={event => setShowKey(event.target.checked)} /> Show recovery key</label>{!automatic && <button type="button" className="simple-button primary" disabled={busy || !code} onClick={confirmKey}>I saved my recovery key</button>}{autoBackup.status && <p role="status" className="phone-status">{autoBackup.status}</p>}{automatic && <button type="button" className="simple-button outline" onClick={autoBackup.retry}>Retry backup</button>}{automatic && autoBackup.status.startsWith('Automatic backup paused: the saved journal is different') && <button type="button" className="simple-button outline" onClick={() => void useCurrentJournalForBackup(code).then(autoBackup.retry, error => setMessage(error instanceof Error ? error.message : 'Could not review the backup.'))}>Use this journal for backups</button>}<div className="simple-actions"><button type="button" className="simple-button outline" disabled={busy || !code} onClick={() => void restore()}>Restore journal</button></div>{message && <p role="status" className="simple-hint">{message}</p>}<details className="phone-more"><summary>How backups work</summary><p className="simple-hint">Backups run while CoinJar is open. If another device has a different backup, restore it before continuing. Simultaneous edits on separate devices can conflict. Walrus storage may expire.</p></details></section>;
}
