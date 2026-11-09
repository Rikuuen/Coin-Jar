import { useState } from 'react';
import { memoryStorageSuffix, personalMemoryHeaders } from './phoneNetwork';

const ADDRESS_KEY = 'coinjar.phone.sui.address.v1' + memoryStorageSuffix;
const READING_KEY = 'coinjar.phone.sui.reading.v1' + memoryStorageSuffix;
const validAddress = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value);
type Reading = { balanceMist: string; checkedAt: string };
type Readings = { current: Reading; previous?: Reading };
function validReading(value: unknown): value is Reading {
  if (!value || typeof value !== 'object') return false;
  const r = value as Reading;
  return typeof r.balanceMist === 'string' && /^\d{1,80}$/.test(r.balanceMist) && typeof r.checkedAt === 'string' && Number.isFinite(Date.parse(r.checkedAt));
}
function savedAddress() { try { return localStorage.getItem(ADDRESS_KEY) ?? ''; } catch { return ''; } }
function key(goalId: string, address: string) { return `${READING_KEY}.${goalId}.${address.toLowerCase()}`; }
function read(goalId: string, address: string): Readings | null {
  try {
    const data = JSON.parse(localStorage.getItem(key(goalId, address)) ?? 'null');
    return validReading(data?.current) && (!data.previous || validReading(data.previous)) ? data : null;
  } catch { return null; }
}
function sui(value: bigint) {
  const fraction = (value % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${value / 1000000000n}${fraction ? `.${fraction}` : ''}`;
}

export default function PhoneWallet({ code, personal = false, goal, link }: { code: string; personal?: boolean; goal?: { id: string; wallet?: { address: string } }; link?: (address: string | null) => boolean }) {
  const [address, setAddress] = useState(() => goal?.wallet?.address ?? savedAddress());
  const [accessCode, setAccessCode] = useState('');
  const [result, setResult] = useState<Readings | null>(() => goal?.wallet ? read(goal.id, goal.wallet.address) : null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function check(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = address.trim().toLowerCase();
    if (!validAddress(target)) { setStatus('Enter a valid Sui public address.'); return; }
    if (goal && link && goal.wallet?.address !== target && !link(target)) { setStatus('Could not link this wallet. Reload and try again.'); return; }
    const prior = goal ? read(goal.id, target) : null;
    setResult(prior); setBusy(true); setStatus('Checking Sui mainnet…');
    try {
      const response = await fetch('/api/phone/wallet-balance', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code || accessCode.trim()}`, ...(personal ? personalMemoryHeaders : {}) }, body: JSON.stringify({ address: target }) });
      const value = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? (personal ? 'Save your Walrus preferences first, then try again.' : 'Check your CoinJar access code.') : 'Wallet balance is unavailable. Try again.');
      if (value.network !== 'mainnet' || !validReading(value)) throw new Error('Wallet balance is unavailable. Try again.');
      const reading: Readings = { current: { balanceMist: value.balanceMist, checkedAt: value.checkedAt }, ...(prior ? { previous: prior.current } : {}) };
      try { localStorage.setItem(ADDRESS_KEY, target); if (goal) localStorage.setItem(key(goal.id, target), JSON.stringify(reading)); } catch { /* The lookup still works without storing the reading. */ }
      setResult(reading); setStatus('');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Wallet balance is unavailable. Try again.'); }
    finally { setBusy(false); }
  }
  const difference = result?.previous ? BigInt(result.current.balanceMist) - BigInt(result.previous.balanceMist) : null;
  return <section className="simple-section"><h2>{goal ? 'Savings wallet' : 'Sui wallet balance'}</h2><p className="simple-hint">{goal ? 'Link a public Sui address to this goal. Wallet holdings are separate from recorded savings and do not prove a contribution.' : 'Read-only SUI on mainnet. Your public address is sent to Tatum. This is separate from your recorded savings.'}</p><form className="simple-form" onSubmit={event => void check(event)}><label>Sui public address<input value={address} onChange={event => { setAddress(event.target.value); setResult(null); setStatus(''); }} placeholder="0x…" disabled={busy} required /></label>{!code && <label>CoinJar access code<input type="password" autoComplete="off" value={accessCode} onChange={event => setAccessCode(event.target.value)} required /></label>}<button className="simple-button outline" disabled={busy}>{busy ? 'Checking…' : goal && goal.wallet?.address !== address.trim().toLowerCase() ? 'Link wallet and check' : 'Check balance'}</button></form>{goal?.wallet && link && <button type="button" className="simple-link" disabled={busy} onClick={() => { if (link(null)) { setAddress(''); setResult(null); setStatus('Wallet unlinked from this goal.'); } }}>Unlink wallet</button>}{result && <div role="status"><p>{sui(BigInt(result.current.balanceMist))} SUI · Last checked {new Date(result.current.checkedAt).toLocaleString()}</p>{difference !== null && <p>{difference === 0n ? 'No change' : `${difference > 0n ? 'Increased' : 'Decreased'} by ${sui(difference > 0n ? difference : -difference)} SUI`} since the previous check. A balance change is not a verified savings contribution.</p>}</div>}{status && <p className="simple-hint" role="status">{status}</p>}</section>;
}
