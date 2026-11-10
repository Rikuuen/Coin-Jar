import { useEffect, useState } from 'react';
import { estimateUsdCents, type AppState, type OnchainTransfer } from './domain';
import { savedRecoveryKey } from './PhoneRecovery';
import { hasTransferAuth, transferAuth } from './phoneTransferAuth';

const actions: Record<string, string> = { '/api/goal/wallet': 'wallet', '/api/onchain/external': 'external-intent', '/api/onchain/detect': 'detect' };
type Quote = { value: string; timestamp: number };
function showUsdc(value: string) { const digits = value.padStart(7, '0'); return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/0+$/, '').replace(/\.$/, ''); }
export default function PhoneTestnetTransfer({ address, goalId, code, personal, suggestionCents, open, recordedDigests, onVerified, onState }: { address?: string; goalId: string; code: string; personal: boolean; suggestionCents: number; open: boolean; recordedDigests: string[]; onVerified: (transfer: OnchainTransfer) => void; onState: (transfers: OnchainTransfer[]) => void }) {
  const [state, setState] = useState<AppState | null>(null), [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const active = state?.onchainTransfers?.find(t => ['awaiting_wallet', 'unknown', 'pending'].includes(t.status));
  async function request(action: string, body: unknown = {}) {
    const auth = await transferAuth(code, personal, savedRecoveryKey());
    const response = await fetch('/api/phone/testnet', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}`, ...auth.headers }, body: JSON.stringify({ ...(body as object), action }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Testnet request failed.');
    if (result.state) setState(result.state);
    return result;
  }
  useEffect(() => {
    if (!hasTransferAuth() && !(personal && code) && !savedRecoveryKey()) return;
    void request('state').catch(() => setError('Testnet transfer service is unavailable.'));
    void request('quote').then(result => setQuote(result.rate)).catch(() => setQuote(null));
  }, [code, personal]);
  useEffect(() => {
    const verified = state?.onchainTransfers?.find(t => !t.external && t.status === 'verified' && t.goalId === goalId && t.digest && !recordedDigests.includes(t.digest) && t.phpValuation);
    if (verified) onVerified(verified);
  }, [state, goalId, onVerified, recordedDigests]);
  useEffect(() => { if (state) onState(state.onchainTransfers ?? []); }, [state, onState]);
  useEffect(() => {
    if (!active?.external || !active.checking) return;
    const timer = window.setInterval(() => void request('detect', { id: active.id }).then(result => {
      if (result.check === 'ambiguous') setMessage('More than one matching receipt found. Check your wallet history.');
      if (result.check === 'verified') { setMessage('Matching testnet wallet receipt confirmed.'); setError(''); }
    }).catch(() => setError('Could not check the network. CoinJar will retry while this page is open.')), 30000);
    return () => window.clearInterval(timer);
  }, [active?.id, active?.external, active?.checking, code, personal]);
  async function post(path: string, body: unknown) {
    if (!actions[path]) return null;
    setBusy(true); setError('');
    try { return await request(actions[path], body); }
    catch (e) { setError(e instanceof Error ? e.message : 'Testnet request failed.'); if (actions[path] === 'detect') await request('state').catch(() => {}); return null; }
    finally { setBusy(false); }
  }
  const estimate = quote && suggestionCents > 0 ? estimateUsdCents(suggestionCents, quote.value) : 0;
  async function prepare() {
    if (!address || !quote || !estimate || quote.timestamp > Date.now() || Date.now() - quote.timestamp > 86400000) { setError('The conversion estimate is unavailable or expired. Refresh and try again.'); return; }
    if (!await post('/api/goal/wallet', { address, goalId })) return;
    await post('/api/onchain/external', { recipient: address, network: 'testnet', amountMicroUsdc: (BigInt(estimate) * 10000n).toString() });
  }
  return <details className="simple-section" open={open || undefined}>
    <summary>Save on-chain</summary>
    <p className="simple-hint">Send test DUSDC to your saved Sui testnet wallet. Test tokens have no monetary value.</p>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!hasTransferAuth() && !(personal && code) && !savedRecoveryKey() ? <p>Set up journal recovery in Profile before using wallet savings.</p>
      : !address && !active ? <p>Link your savings address in Profile first.</p>
      : !active ? <><p className="simple-hint">{estimate > 0 ? `Estimated amount: ${(estimate / 100).toFixed(2)} test DUSDC` : 'Getting a conversion estimate…'}</p><button className="simple-button primary" disabled={!state || !estimate || busy} onClick={() => void prepare()}>Prepare transfer</button></>
      : <><p className="simple-hint">Send {showUsdc(active.amountMicroUsdc ?? '0')} test DUSDC on Sui testnet.</p><label>Wallet address<input readOnly value={active.recipient} onFocus={event => event.currentTarget.select()} /></label>
        <button className="simple-button outline" onClick={() => { if (!navigator.clipboard) { setError('Select the address to copy it.'); return; } void navigator.clipboard.writeText(active.recipient).then(() => setMessage('Address copied.'), () => setError('Select the address to copy it.')); }}>Copy address</button>
        {active.external ? <><button className="simple-button primary" style={{ background: '#2F312D', color: '#fff' }} disabled={busy} onClick={() => { setMessage('Checking for a matching transfer…'); void post('/api/onchain/detect', { id: active.id }).then(result => { if (result?.check === 'waiting') setMessage('Waiting for a matching transfer. CoinJar checks again while this page is open.'); else if (result?.check === 'ambiguous') setMessage('More than one matching receipt found. Check your wallet history.'); else if (result?.check === 'verified') setMessage('Matching testnet wallet receipt confirmed.'); }); }}>I’ve sent it</button><p className="simple-hint">A matching wallet receipt is shown in Activity. It does not change goal progress.</p></> : <p className="simple-hint">This earlier wallet request cannot be checked automatically. Check your wallet history.</p>}
      </>}
    {state?.onchainTransfers?.filter(t => t.status === 'verified' || t.status === 'failed').map(t => <p className="simple-hint" key={t.id}>{t.status === 'verified' ? 'Matching wallet receipt confirmed' : 'Transfer failed'} · {t.amountMicroUsdc ? `${showUsdc(t.amountMicroUsdc)} test DUSDC` : 'SUI'} · {t.external ? 'goal progress unchanged' : 'wallet saving'}</p>)}
  </details>;
}
