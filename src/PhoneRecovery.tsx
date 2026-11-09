import React, { useState } from 'react';
import { mainnetDemo, newMemoryCode } from './phoneNetwork';
import { decryptJournal, encryptJournal, recoveryRequest } from './journalCipher';
import type { PhoneJournal } from './phoneJournal';

const KEY = 'coinjar.phone.recovery.key.v1' + (mainnetDemo ? '.demo' : '');
export default function PhoneRecovery({ journal, apply, memoryCode }: { journal: PhoneJournal; apply: (value: PhoneJournal) => boolean; memoryCode: string }) {
  const [code, setCode] = useState(() => localStorage.getItem(KEY) ?? '');
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function backup() {
    if (code === memoryCode && code) { setMessage('Generate a separate recovery key. Your memory access code cannot protect a backup.'); return; }
    if (!saved) { setMessage('Save your recovery key somewhere safe first.'); return; }
    setBusy(true); setMessage('Encrypting and saving your journal. This can take a minute.');
    try {
      const { envelope } = await encryptJournal(code, journal);
      localStorage.setItem(KEY, code);
      await recoveryRequest(code, 'backupSave', envelope);
      setMessage('Encrypted journal backup saved. Back up again after changes.');
    } catch { setMessage('Could not confirm the backup. Your journal is unchanged. Check Walrus before retrying.'); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (code === memoryCode && code) { setMessage('Enter your separate recovery key, not your memory access code.'); return; }
    setBusy(true); setMessage('Finding your encrypted journal.');
    try {
      const result = await recoveryRequest(code, 'backupRestore');
      const restored = await decryptJournal(code, result.envelope);
      if (!window.confirm(`Replace this device’s journal with the backup? It contains ${restored.entries.length} activity entries. Your current journal on this device will be replaced.`)) { setMessage('Restore cancelled. Your journal is unchanged.'); return; }
      localStorage.setItem(KEY, code);
      if (apply(restored)) { setMessage('Journal restored on this device.'); }
      else setMessage('Could not restore the journal. Your current data was not changed.');
    } catch { setMessage('Could not restore the backup. Check the recovery key and connection. Your journal is unchanged.'); }
    finally { setBusy(false); }
  }
  return <section className="simple-section"><h2>Journal recovery</h2><p className="simple-hint">Save your recovery key offline. It is separate from your Walrus memory code. Anyone with this key can access your backup; losing it means the backup cannot be recovered.</p><label>Recovery key<input type={showKey ? 'text' : 'password'} autoComplete="off" value={code} onChange={event => { setCode(event.target.value.trim()); setSaved(false); }} /></label><div className="simple-actions"><button type="button" className="simple-button outline" onClick={() => { if (code && !window.confirm('Generate a new recovery key? Keep the old key to restore earlier backups.')) return; setCode(newMemoryCode()); setSaved(false); }}>Generate key</button><button type="button" className="simple-button outline" disabled={!code} onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(code).then(() => setMessage('Recovery key copied.'), () => setMessage('Select the recovery key to copy it.')); }}>Copy key</button></div><label className="simple-check"><input type="checkbox" checked={showKey} onChange={event => setShowKey(event.target.checked)} /> Show recovery key</label><label className="simple-check"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} /> I saved my recovery key</label><p className="simple-hint">Backups are manual. Save a new backup after recording activity. Walrus storage may expire and this experimental recovery is not guaranteed.</p><div className="simple-actions"><button type="button" className="simple-button primary" disabled={busy || !code} onClick={() => void backup()}>Back up journal</button><button type="button" className="simple-button outline" disabled={busy || !code} onClick={() => void restore()}>Restore journal</button></div>{message && <p role="status" className="simple-hint">{message}</p>}</section>;
}
