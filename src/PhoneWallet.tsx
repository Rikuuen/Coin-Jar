import { useState } from 'react';
import { memoryStorageSuffix, personalHeadersFor } from './phoneNetwork';

const ADDRESS_KEY = 'coinjar.phone.sui.address.v1' + memoryStorageSuffix;
const READING_KEY = 'coinjar.phone.sui.reading.v1' + memoryStorageSuffix;
const validAddress = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value);
type Reading = { balanceMist: string; checkedAt: string };
type Readings = { current: Reading; previous?: Reading };
type TransactionResult = { digest: string; status: 'success' | 'failed'; checkpoint: string; address: string; changes: { coinType: string; amount: string }[] };
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
  const [digest, setDigest] = useState('');
  const [transaction, setTransaction] = useState<TransactionResult | null>(null);
  const [transactionStatus, setTransactionStatus] = useState('');
  const [transactionBusy, setTransactionBusy] = useState(false);

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
  async function checkTransaction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const transactionDigest = digest.trim();
    if (!address || !validAddress(address)) { setTransactionStatus('Link a wallet in Profile first.'); return; }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(transactionDigest)) { setTransactionStatus('Enter a valid transaction digest.'); return; }
    if (!code && !accessCode.trim()) { setTransactionStatus('Enter your CoinJar access code above first.'); return; }
    setTransaction(null); setTransactionBusy(true); setTransactionStatus('Checking Sui mainnet…');
    try {
      const response = await fetch('/api/phone/wallet-balance', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code || accessCode.trim()}`, ...(personal ? await personalHeadersFor(code) : {}) }, body: JSON.stringify({ address, digest: transactionDigest }) });
      const value = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? 'Check your CoinJar access or save your Walrus preferences first.' : 'Transaction could not be checked. It may be unavailable or too old.');
      if (value.network !== 'mainnet' || value.digest !== transactionDigest || value.address !== address.toLowerCase() || !['success', 'failed'].includes(value.status) || !/^\d+$/.test(value.checkpoint) || !Array.isArray(value.changes) || value.changes.some((c: { coinType?: unknown; amount?: unknown }) => typeof c.coinType !== 'string' || typeof c.amount !== 'string' || !/^-?\d{1,81}$/.test(c.amount))) throw Error('Invalid transaction response.');
      setTransaction(value); setTransactionStatus('');
    } catch (error) { setTransactionStatus(error instanceof Error ? error.message : 'Transaction could not be checked.'); }
    finally { setTransactionBusy(false); }
  }
  const difference = result?.previous ? BigInt(result.current.balanceMist) - BigInt(result.previous.balanceMist) : null;
  if (mode === 'profile') return <section className="simple-section"><div className="phone-card-head"><h2>Linked wallet</h2><span className={`phone-chip${address ? ' on' : ''}`}>{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Not linked'}</span></div><p className="simple-hint">Link a public Sui address. CoinJar does not request wallet signing or transfer funds.</p><form className="simple-form" onSubmit={saveAddress}><label>Sui public address<input value={input} onChange={event => { setInput(event.target.value); setStatus(''); }} placeholder="0x…" required /></label><button className="simple-button outline">{address ? 'Update linked wallet' : 'Link wallet'}</button></form>{address && <button type="button" className="simple-link" onClick={() => { if (link?.(null)) { setInput(''); try { localStorage.removeItem(ADDRESS_KEY); } catch {} setStatus('Wallet unlinked.'); } }}>Unlink wallet</button>}{status && <p className="simple-hint" role="status">{status}</p>}</section>;
  return <section className="simple-section"><h2>Savings wallet</h2><p className="simple-hint">Wallet holdings are separate from recorded savings and do not prove a contribution.</p>{!address ? <button type="button" className="simple-button outline" onClick={openProfile}>Set up wallet</button> : <><p className="simple-hint">Linked Sui wallet: {address.slice(0, 8)}…{address.slice(-6)}</p><form className="simple-form" onSubmit={event => void check(event)}>{!code && <label>CoinJar access code<input type="password" autoComplete="off" value={accessCode} onChange={event => setAccessCode(event.target.value)} required /></label>}<button className="simple-button outline" disabled={busy}>{busy ? 'Checking…' : 'Check balance'}</button></form></>}{result && <div role="status"><p className="simple-hint">{sui(BigInt(result.current.balanceMist))} SUI · Last checked {new Date(result.current.checkedAt).toLocaleString()}</p>{difference !== null && <p className="simple-hint">{difference === 0n ? 'No change' : `${difference > 0n ? 'Increased' : 'Decreased'} by ${sui(difference > 0n ? difference : -difference)} SUI`} since the previous check. A balance change is not a verified savings contribution.</p>}</div>}{status && <p className="simple-hint" role="status">{status}</p>}{address && <details><summary>Check a transaction</summary><p className="simple-hint">Look up a Sui mainnet transaction for your linked wallet. This does not change goal progress.</p><form className="simple-form" onSubmit={event => void checkTransaction(event)}><label>Transaction digest<input value={digest} onChange={event => { setDigest(event.target.value); setTransaction(null); }} autoComplete="off" required /></label><button className="simple-button outline" disabled={transactionBusy}>{transactionBusy ? 'Checking…' : 'Check transaction'}</button></form>{transactionStatus && <p className="simple-hint" role="status">{transactionStatus}</p>}{transaction && transaction.address === address.toLowerCase() && <div role="status"><p>Status: {transaction.status === 'success' ? 'Successful' : 'Failed'} · Checkpoint {transaction.checkpoint}</p><p className="simple-hint" style={{ overflowWrap: 'anywhere' }}>Digest: {transaction.digest}</p><p className="simple-hint" style={{ overflowWrap: 'anywhere' }}>Wallet: {transaction.address}</p><p>Net wallet changes</p>{transaction.changes.length ? transaction.changes.map(change => { const units = BigInt(change.amount); const isSui = /^0x0*2::sui::SUI$/.test(change.coinType); return <p className="simple-hint" key={change.coinType} style={{ overflowWrap: 'anywhere' }}>{units > 0n ? '+' : '-'}{isSui ? `${sui(units > 0n ? units : -units)} SUI` : `${(units > 0n ? units : -units).toString()} base units · ${change.coinType}`}</p>; }) : <p className="simple-hint">No net token balance change for this wallet.</p>}<p className="simple-hint">Net changes can include fees or other activity. They do not prove a savings transfer or wallet ownership.</p></div>}</details>}</section>;
}
