import React, { useState } from 'react';
import { applyPreferenceMemory } from './phoneMemory';
import type { PhoneJournal } from './phoneJournal';
import { memoryHeaders, personalHeadersFor, rememberAlternateNamespace, walrusNetwork } from './phoneNetwork';

export default function PhoneWalrus({ journal, apply, personal = false, savedCode = '' }: { journal: PhoneJournal; apply: (value: PhoneJournal) => boolean; personal?: boolean; savedCode?: string }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [memories, setMemories] = useState<string[]>([]);
  const accessCode = savedCode || code.trim();
  const personalRecovery = personal || !savedCode;
  const network = personalRecovery ? 'mainnet' : walrusNetwork;
  async function recall() {
    if (!/^[A-Za-z0-9_-]{43}$/.test(accessCode)) { setMessage('Enter your 43-character memory code.'); return; }
    if (!window.confirm(`Retrieve your saved ${network} preferences from Walrus?`)) return;
    setBusy(true); setMessage('Looking for saved preferences.');
    try {
      const send = async (alternate = false) => fetch('/api/phone/walrus', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${accessCode}`, ...(personalRecovery ? await personalHeadersFor(accessCode, alternate) : memoryHeaders) }, body: JSON.stringify({ consent: true, action: 'recall' }) });
      const response = await send();
      let result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Walrus is unavailable.');
      if (personalRecovery && Array.isArray(result.memories) && result.memories.length === 0) {
        const alternative = await send(true);
        if (!alternative.ok) throw new Error('Walrus is unavailable.');
        const found = await alternative.json();
        if (Array.isArray(found.memories) && found.memories.length) { await rememberAlternateNamespace(accessCode); result = found; }
      }
      setMemories(result.memories); setMessage(result.memories.length ? 'Choose a memory to review and apply.' : 'No compatible memories were found.');
    } catch { setMessage('Could not retrieve memories. Check the connection and memory code.'); }
    finally { setBusy(false); }
  }
  function restore(memory: string) {
    try {
      const value = applyPreferenceMemory(journal, memory);
      if (!window.confirm(`Apply the saved ${value.currency} preference? Your transactions and balance will not change.`)) return;
      if (apply(value)) setMessage('Saved preferences applied on this device.');
    } catch { setMessage('This memory is invalid or uses a different currency.'); }
  }
  return <section className="simple-section"><p className="simple-hint">Find your saved preferences. To restore your journal, use Journal recovery.</p>{!savedCode && <label>Memory code<input type="password" autoComplete="off" value={code} onChange={event => { setCode(event.target.value); setMemories([]); setMessage(''); }} /></label>}<button type="button" className="simple-button outline" disabled={busy} onClick={() => void recall()}>Find preferences</button>{message && <p role="status" className="simple-hint">{message}</p>}{memories.map((memory, index) => <button key={`${index}-${memory}`} className="simple-link" onClick={() => restore(memory)}>Review memory {index + 1}</button>)}</section>;
}
