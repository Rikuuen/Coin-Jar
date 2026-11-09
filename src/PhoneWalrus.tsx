import React, { useState } from 'react';
import { applyPreferenceMemory, preferenceMemory } from './phoneMemory';
import type { PhoneJournal } from './phoneJournal';
import { memoryHeaders, personalMemoryHeaders, walrusNetwork } from './phoneNetwork';

export default function PhoneWalrus({ journal, apply, personal = false, savedCode = '' }: { journal: PhoneJournal; apply: (value: PhoneJournal) => boolean; personal?: boolean; savedCode?: string }) {
  const network = personal ? 'mainnet' : walrusNetwork;
  const [code, setCode] = useState(personal ? savedCode : '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [memories, setMemories] = useState<string[]>([]);
  async function request(action: 'remember' | 'recall') {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) { setMessage('Enter the 43-character access code.'); return; }
    const warning = action === 'remember' ? `Send your currency preference to Walrus ${network}? The Walrus service can read these values. Do not use real financial data during testing.` : `Retrieve your saved ${network} preferences from Walrus?`;
    if (!window.confirm(warning)) return;
    setBusy(true); setMessage(action === 'remember' ? `Saving to Walrus ${network}. This may take a minute.` : 'Looking for saved preferences.');
    try {
      const response = await fetch('/api/phone/walrus', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code}`, ...(personal ? personalMemoryHeaders : memoryHeaders) }, body: JSON.stringify({ consent: true, action, ...(action === 'remember' ? { memory: preferenceMemory(journal), operationId: crypto.randomUUID() } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Walrus is unavailable.');
      if (action === 'remember') setMessage(`${network === 'mainnet' ? 'Mainnet' : 'Testnet'} memory saved. Your journal remains on this device.`);
      else { setMemories(result.memories); setMessage(result.memories.length ? 'Choose a memory to review and apply.' : 'No compatible memories were found.'); }
    } catch { setMessage(action === 'remember' ? 'Could not confirm the write. Check Walrus before retrying.' : 'Could not retrieve memories. Check the connection and access code.'); }
    finally { setBusy(false); }
  }
  function restore(memory: string) {
    try {
      const value = applyPreferenceMemory(journal, memory);
      if (!window.confirm(`Apply the saved ${value.currency} preference? Your transactions and balance will not change.`)) return;
      if (apply(value)) setMessage('Saved preferences applied on this device.');
    } catch { setMessage('This memory is invalid or uses a different currency.'); }
  }
  return <section className="simple-section"><h2>Walrus {network}</h2><p className="simple-hint">Experimental. Use fictional settings only. The code entered below is kept only while this page is open; automatic saving has its own setting. Walrus memory is not a journal backup.</p><label>Access code<input type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} /></label><div className="simple-actions"><button className="simple-button outline" disabled={busy} onClick={() => void request('remember')}>Save preferences</button><button className="simple-button outline" disabled={busy} onClick={() => void request('recall')}>Find preferences</button></div>{message && <p role="status" className="simple-hint">{message}</p>}{memories.map((memory, index) => <button key={`${index}-${memory}`} className="simple-link" onClick={() => restore(memory)}>Review memory {index + 1}</button>)}</section>;
}
