import { useState } from 'react';
import { memoryStorageSuffix, personalHeadersFor } from './phoneNetwork';

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

type Props = { mode: 'profile' | 'goal'; address?: string; goalId?: string; code: string; personal?: boolean; link?: (address: string | null) => boolean; openProfile?: () => void };
export default function PhoneWallet({ mode, address, goalId, code, personal = false, link, openProfile }: Props) {
  const [input, setInput] = useState(() => address ?? savedAddress());
  const [accessCode, setAccessCode] = useState('');
  const [result, setResult] = useState<Readings | null>(() => address && goalId ? read(goalId, address) : null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  function saveAddress(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = input.trim().toLowerCase();
    if (!validAddress(target)) { setStatus('Enter a valid Sui public address.'); return; }
    if (!link?.(target)) { setStatus('Could not link this wallet. Reload and try again.'); return; }
    try { localStorage.setItem(ADDRESS_KEY, target); } catch { /* The linked address is already saved in the journal. */ }
    setStatus('Wallet linked.');
  }
  async function check(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!address || !goalId || !validAddress(address)) { setStatus('Link a wallet in Profile first.'); return; }
    const prior = read(goalId, address);
    setResult(prior); setBusy(true); setStatus('Checking Sui mainnet…');
    try {
      const response = await fetch('/api/phone/wallet-balance', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code || accessCode.trim()}`, ...(personal ? await personalHeadersFor(code) : {}) }, body: JSON.stringify({ address }) });
      const value = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? (personal ? 'Save your Walrus preferences first, then try again.' : 'Check your CoinJar access code.') : 'Wallet balance is unavailable. Try again.');
      if (value.network !== 'mainnet' || !validReading(value)) throw new Error('Wallet balance is unavailable. Try again.');
      const reading: Readings = { current: { balanceMist: value.balanceMist, checkedAt: value.checkedAt }, ...(prior ? { previous: prior.current } : {}) };
      try { localStorage.setItem(key(goalId, address), JSON.stringify(reading)); } catch { /* The lookup still works without storing the reading. */ }
      setResult(reading); setStatus('');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Wallet balance is unavailable. Try again.'); }
    finally { setBusy(false); }
  }
  const difference = result?.previous ? BigInt(result.current.balanceMist) - BigInt(result.previous.balanceMist) : null;
  if (mode === 'profile') return <section className="simple-section"><h2>Linked wallet</h2><p className="simple-hint">Link a public Sui address. CoinJar does not request wallet signing or transfer funds.</p><form className="simple-form" onSubmit={saveAddress}><label>Sui public address<input value={input} onChange={event => { setInput(event.target.value); setStatus(''); }} placeholder="0x…" required /></label><button className="simple-button outline">{address ? 'Update linked wallet' : 'Link wallet'}</button></form>{address && <button type="button" className="simple-link" onClick={() => { if (link?.(null)) { setInput(''); try { localStorage.removeItem(ADDRESS_KEY); } catch {} setStatus('Wallet unlinked.'); } }}>Unlink wallet</button>}{status && <p className="simple-hint" role="status">{status}</p>}</section>;
  return <section className="simple-section"><h2>Savings wallet</h2><p className="simple-hint">Wallet holdings are separate from recorded savings and do not prove a contribution.</p>{!address ? <button type="button" className="simple-button outline" onClick={openProfile}>Set up wallet</button> : <><p className="simple-hint">Linked Sui wallet: {address.slice(0, 8)}…{address.slice(-6)}</p><form className="simple-form" onSubmit={event => void check(event)}>{!code && <label>CoinJar access code<input type="password" autoComplete="off" value={accessCode} onChange={event => setAccessCode(event.target.value)} required /></label>}<button className="simple-button outline" disabled={busy}>{busy ? 'Checking…' : 'Check balance'}</button></form></>}{result && <div role="status"><p>{sui(BigInt(result.current.balanceMist))} SUI · Last checked {new Date(result.current.checkedAt).toLocaleString()}</p>{difference !== null && <p>{difference === 0n ? 'No change' : `${difference > 0n ? 'Increased' : 'Decreased'} by ${sui(difference > 0n ? difference : -difference)} SUI`} since the previous check. A balance change is not a verified savings contribution.</p>}</div>}{status && <p className="simple-hint" role="status">{status}</p>}</section>;
}
