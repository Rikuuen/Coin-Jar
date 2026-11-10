import { useEffect, useState } from 'react';
import { estimateUsdCents, type AppState, type OnchainTransfer } from './domain';
import { personalHeadersFor } from './phoneNetwork';
import WalletTransfer from './WalletTransfer';

const actions: Record<string, string> = { '/api/goal/wallet': 'wallet', '/api/onchain/intent': 'intent', '/api/onchain/unknown': 'unknown', '/api/onchain/digest': 'digest', '/api/onchain/verify': 'verify', '/api/onchain/dismiss': 'dismiss' };
type Quote = { value: string; timestamp: number };
export default function PhoneTestnetTransfer({ address, goalId, code, personal, suggestionCents, open, recordedDigests, onVerified, onState }: { address?: string; goalId: string; code: string; personal: boolean; suggestionCents: number; open: boolean; recordedDigests: string[]; onVerified: (transfer: OnchainTransfer) => void; onState: (transfers: OnchainTransfer[]) => void }) {
  const [state, setState] = useState<AppState | null>(null), [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function request(action: string, body: unknown = {}) {
    const response = await fetch('/api/phone/testnet', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${code}`, ...await personalHeadersFor(code) }, body: JSON.stringify({ ...(body as object), action }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Testnet request failed.');
    if (result.state) setState(result.state);
    return result;
  }
  useEffect(() => {
    if (!personal || !code) return;
    void request('state').catch(() => setError('Testnet transfer service is unavailable.'));
    void request('quote').then(result => setQuote(result.rate)).catch(() => setQuote(null));
  }, [code, personal]);
  useEffect(() => {
    const verified = state?.onchainTransfers?.find(t => t.status === 'verified' && t.goalId === goalId && t.digest && !recordedDigests.includes(t.digest) && t.phpValuation);
    if (verified) onVerified(verified);
  }, [state, goalId, onVerified, recordedDigests]);
  useEffect(() => { if (state) onState(state.onchainTransfers ?? []); }, [state, onState]);
  async function post(path: string, body: unknown) {
    if (!actions[path]) return null;
    setBusy(true); setError('');
    try { return await request(actions[path], body); }
    catch (e) { setError(e instanceof Error ? e.message : 'Testnet request failed.'); return null; }
    finally { setBusy(false); }
  }
  const matching = Boolean(address && state?.goal?.id === goalId && state.goal.wallet?.address?.toLowerCase() === address.toLowerCase());
  const pending = Boolean(state?.onchainTransfers?.some(t => ['awaiting_wallet', 'unknown', 'pending'].includes(t.status)));
  const estimate = quote && suggestionCents > 0 ? estimateUsdCents(suggestionCents, quote.value) : 0;
  return <details className="simple-section" open={open || undefined}><summary>Save with Slush</summary><p className="simple-hint">Confirm a wallet transfer to update your goal.</p>{error && <p role="alert">{error}</p>}{!personal || !code ? <p>Enable automatic memory in Profile before using this test.</p> : !address && !pending ? <p>Link your test savings address in Profile first.</p> : !matching && !pending ? <button className="simple-button outline" disabled={!state || busy} onClick={() => void post('/api/goal/wallet', { address, goalId })}>Use linked address for test</button> : state && <>{pending && !matching && <p className="simple-hint">Resolve the earlier wallet transfer before changing its destination or goal.</p>}<WalletTransfer state={state} network="testnet" suggestedUsdc={estimate > 0 ? (estimate / 100).toFixed(2) : undefined} quoteTimestamp={quote?.timestamp} busy={busy} post={post} onError={setError} />{state.onchainTransfers?.filter(t => t.status === 'verified' || t.status === 'failed').map(t => <p className="simple-hint" key={t.id}>Test transfer {t.status} · checkpoint {t.checkpoint}</p>)}</>}</details>;
}
