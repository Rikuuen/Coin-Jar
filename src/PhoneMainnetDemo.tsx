import { useState } from 'react';
import fixture from '../demo/walrus-mainnet-memories.json';
import { memoryHeaders, newMemoryCode, personalMemoryHeaders, personalStorageSuffix } from './phoneNetwork';

type Item = { operationId: string; state: 'pending' | 'done'; memoryId?: string };
const PROGRESS = 'coinjar.phone.mainnet-demo.receipts.v1';
const DEMO_CODE = 'coinjar.phone.mainnet-demo.code.v1';
function read(key: string): Item[] { const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]'); if (!Array.isArray(value)) throw new Error('Demo receipts are unreadable. Check Walrus before retrying.'); return value; }

export default function PhoneMainnetDemo({ savedCode, personal = false, onActivate }: { savedCode: string; personal?: boolean; onActivate: (code: string) => void }) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function run() {
    if (!window.confirm('Write ten fictional demo memories to Walrus mainnet? They are not private financial data. Mainnet operations may have costs.')) return;
    setBusy(true);
    try {
      let token = savedCode || localStorage.getItem(DEMO_CODE) || '';
      const personalMode = !savedCode || personal;
      if (!token && personalMode) { token = newMemoryCode(); localStorage.setItem(DEMO_CODE, token); }
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Enter a valid memory code in Savings settings.');
      const progressKey = PROGRESS + (personalMode ? await personalStorageSuffix(token) : '');
      const items = read(progressKey);
      if (items.length > 10 || items.some(item => item.state !== 'done' || typeof item.memoryId !== 'string')) throw new Error('A previous write has an unknown outcome. Check Walrus before retrying.');
      for (let i = items.length; i < fixture.memories.length; i++) {
        const { kind, ...data } = fixture.memories[i];
        const memory = (kind === 'preferences' ? 'COINJAR_PHONE_PREFERENCES_V1 ' : 'COINJAR_PHONE_HABIT_V1 ') + JSON.stringify(data);
        const item: Item = { operationId: crypto.randomUUID(), state: 'pending' };
        items.push(item); localStorage.setItem(progressKey, JSON.stringify(items));
        setStatus(`Saving fictional memory ${i + 1} of 10…`);
        const response = await fetch('/api/phone/walrus', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(personalMode ? personalMemoryHeaders : memoryHeaders) }, body: JSON.stringify({ consent: true, action: 'remember', memory, operationId: item.operationId }) });
        const result = await response.json();
        if ([400, 401, 413, 503].includes(response.status)) {
          items.pop(); localStorage.setItem(progressKey, JSON.stringify(items));
          throw new Error(response.status === 401 ? 'Check your CoinJar access code.' : 'Mainnet memory is not ready. No write was started.');
        }
        if (!response.ok || result.saved !== true || typeof result.memoryId !== 'string' || typeof result.blobId !== 'string') throw new Error('Write not confirmed. Check Walrus before retrying.');
        item.state = 'done'; item.memoryId = result.memoryId; localStorage.setItem(progressKey, JSON.stringify(items));
      }
      const response = await fetch('/api/phone/walrus', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(personalMode ? personalMemoryHeaders : memoryHeaders) }, body: JSON.stringify({ consent: true, action: 'listDemo' }) });
      const result = await response.json();
      const expected = new Set(items.map(item => item.memoryId));
      if (!response.ok || !Array.isArray(result.memoryIds) || expected.size !== 10 || ![...expected].every(id => result.memoryIds.includes(id))) throw new Error('Writes finished, but the ten memories could not be independently listed yet.');
      if (!savedCode) onActivate(token);
      setStatus('10 fictional memories saved and listed on Walrus mainnet. Save the demo memory code in Savings settings to revisit them.');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Mainnet memory check failed.'); }
    finally { setBusy(false); }
  }
  return <section className="simple-section"><h2>Mainnet demo memories</h2><p className="simple-hint">These ten fictional examples are stored in a separate demo memory space. Do not use real financial data.</p><button className="simple-button outline" disabled={busy} onClick={() => void run()}>Save and verify demo memories</button>{status && <p className="simple-hint" role="status">{status}</p>}</section>;
}
