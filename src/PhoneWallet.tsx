import { useEffect, useRef, useState } from 'react';
import { memoryStorageSuffix, personalHeadersFor } from './phoneNetwork';

const ADDRESS_KEY = 'coinjar.phone.sui.address.v1' + memoryStorageSuffix;
const READING_KEY = 'coinjar.phone.sui.test-dusdc.reading.v1' + memoryStorageSuffix;
const validAddress = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value);
type Reading = { balanceBaseUnits: string; checkedAt: string };
function key(goalId: string, address: string) { return `${READING_KEY}.${goalId}.${address.toLowerCase()}`; }
function read(goalId: string, address: string): Reading | null {
  try {
    const reading = JSON.parse(localStorage.getItem(key(goalId, address)) ?? 'null')?.current;
    return typeof reading?.balanceBaseUnits === 'string' && /^\d{1,80}$/.test(reading.balanceBaseUnits) && typeof reading.checkedAt === 'string' && Number.isFinite(Date.parse(reading.checkedAt)) ? reading : null;
  } catch { return null; }
}
function dusdc(value: bigint) {
  const fraction = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${value / 1000000n}${fraction ? `.${fraction}` : ''}`;
}

export default function PhoneWallet({ address, goalId = 'wallet', code, personal = false, link }: { address?: string; goalId?: string; code: string; personal?: boolean; link: (address: string | null) => boolean }) {
  const [input, setInput] = useState(() => address ?? '');
  const [accessCode, setAccessCode] = useState('');
  const [result, setResult] = useState<Reading | null>(() => address ? read(goalId, address) : null);
  const [fresh, setFresh] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  useEffect(() => {
    setInput(address ?? ''); setResult(address ? read(goalId, address) : null); setFresh(false); setBusy(false);
    if (address && code) void checkBalance();
    const refresh = () => { if (address && code && document.visibilityState === 'visible') void checkBalance(); };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { requestId.current++; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [address, goalId, code, personal]);

  function saveAddress(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = input.trim().toLowerCase();
    if (!validAddress(target)) { setStatus('Enter a valid Sui public address.'); return; }
    if (!link(target)) { setStatus('Could not link this wallet. Reload and try again.'); return; }
    try { localStorage.setItem(ADDRESS_KEY, target); } catch { /* The address is already saved in the journal. */ }
    setStatus('Wallet linked.');
  }
  async function checkBalance() {
    if (!address || !validAddress(address)) { setStatus('Link a wallet first.'); return; }
    const id = ++requestId.current;
    const prior = read(goalId, address);
    setBusy(true); setFresh(false); setStatus('Checking Sui testnet…');
    try {
      const response = await fetch('/api/phone/wallet-balance', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code || accessCode.trim()}`, ...(personal ? await personalHeadersFor(code) : {}) }, body: JSON.stringify({ address, asset: 'test-dusdc' }) });
      const value = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? (personal ? 'Save your Walrus preferences first, then try again.' : 'Check your CoinJar access code.') : 'Wallet balance is unavailable. Try again.');
      if (value.network !== 'testnet' || value.asset !== 'test-dusdc' || typeof value.balanceBaseUnits !== 'string' || !/^\d{1,80}$/.test(value.balanceBaseUnits) || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) throw new Error('Wallet balance is unavailable. Try again.');
      if (id !== requestId.current) return;
      const reading = { balanceBaseUnits: value.balanceBaseUnits, checkedAt: value.checkedAt };
      try { localStorage.setItem(key(goalId, address), JSON.stringify({ current: reading, ...(prior ? { previous: prior } : {}) })); } catch { /* The live reading still works. */ }
      setResult(reading); setFresh(true); setStatus('');
    } catch (error) { if (id === requestId.current) setStatus(error instanceof Error ? error.message : 'Wallet balance is unavailable. Try again.'); }
    finally { if (id === requestId.current) setBusy(false); }
  }
  return <section className="simple-section phone-wallet"><div className="phone-card-head"><h2>Savings wallet</h2><span className={`phone-chip${address ? ' on' : ''}`}>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Not linked'}</span></div>
    {address && <><p className="simple-hint">{fresh || !result ? 'Test DUSDC · Sui testnet' : 'Last saved test DUSDC · Sui testnet'}</p><p className="simple-amount">{result ? `${dusdc(BigInt(result.balanceBaseUnits))} DUSDC` : '—'}</p><form className="simple-form" onSubmit={event => { event.preventDefault(); void checkBalance(); }}>{!code && <label>CoinJar access code<input type="password" autoComplete="off" value={accessCode} onChange={event => setAccessCode(event.target.value)} required /></label>}<button className="simple-button outline" disabled={busy}>{busy ? 'Checking…' : result ? 'Refresh balance' : 'Check balance'}</button></form></>}
    <details className="phone-more" open={!address || undefined}><summary>Manage linked wallet</summary><form className="simple-form" onSubmit={saveAddress}><label>Sui public address<input value={input} onChange={event => { setInput(event.target.value); setStatus(''); }} placeholder="0x…" required /></label><button className="simple-button outline">{address ? 'Update linked wallet' : 'Link wallet'}</button></form>
      {address && <button type="button" className="simple-button outline" onClick={() => { if (link(null)) { setInput(''); try { localStorage.removeItem(ADDRESS_KEY); } catch {} setStatus('Wallet unlinked.'); } }}>Unlink wallet</button>}</details>{status && <p className="simple-hint" role="status">{status}</p>}
  </section>;
}
