import React, { useState } from 'react';
import { parseMoney } from './domain';
const WalletConnect = React.lazy(() => import('./WalletConnect'));

type Props = { currency: 'PHP' | 'USD'; balance: number; demo: boolean; walrus: boolean; network: 'mainnet' | 'testnet'; walletVerified: boolean; busy: boolean; post: (path: string, body: Record<string, unknown>) => Promise<any>; onError: (text: string) => void };

export default function Welcome({ currency, balance, demo, walrus, network, walletVerified, busy, post, onError }: Props) {
  const [step, setStep] = useState(walletVerified ? 1 : 0);
  const [name, setName] = useState('');
  const [income, setIncome] = useState('');
  const [cash, setCash] = useState(balance >= 0 ? (balance / 100).toFixed(2) : '0.00');
  const [payday, setPayday] = useState('');
  const [wallet, setWallet] = useState(walletVerified ? 'verified' : '');
  const [sync, setSync] = useState(walrus && !walletVerified);
  const advance = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      if (step === 1 && !name.trim()) throw new Error('Enter your name.');
      if (step === 2) { parseMoney(income); parseMoney(cash); if (payday && (Number(payday) < 1 || Number(payday) > 31 || parseMoney(income) === 0)) throw new Error('Choose a valid payday and income.'); }
      if (step < 3) { setStep(step + 1); return; }
      void post('/api/simple/onboarding', { name: name.trim(), monthlyIncomeCents: parseMoney(income), balanceCents: parseMoney(cash), expectedCents: balance, payday, summarySync: sync && walrus, consent: sync && walrus, useWallet: Boolean(wallet) });
    } catch (error) { onError(error instanceof Error ? error.message : 'Check your details.'); }
  };
  return <main className="welcome-shell"><div className="welcome-top"><span className="simple-brand">coinjar<span>.</span></span><span>{step + 1} / 4</span></div><div className="welcome-progress" aria-hidden="true"><span style={{ transform: `scaleX(${(step + 1) / 4})` }} /></div>
    <div className="welcome-content">
      {step === 0 ? <><p className="welcome-overline">A little more room to breathe</p><h1>Your money, more understood.</h1><p className="welcome-lead">A clearer view of your day, with a savings habit that grows with you.</p><React.Suspense fallback={<p className="welcome-note">Opening wallet…</p>}><WalletConnect network={network} post={post} onVerified={(address) => { setWallet(address); setStep(1); }} onError={onError} /></React.Suspense><button className={demo ? 'simple-button primary welcome-primary welcome-skip' : 'simple-link welcome-skip'} type="button" onClick={() => { setWallet(''); setStep(1); }}>{demo ? 'Explore the preview' : 'Continue without wallet'}</button>{!demo && <p className="welcome-note">Connecting proves wallet control. This local journal is not a multi-user account.</p>}</> :
      <form onSubmit={advance}>
        {step === 1 && <><p className="welcome-overline">First things first</p><h1>What should we call you?</h1><p className="welcome-lead">Let’s make this yours.</p><label>Your name<input autoFocus required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" /></label></>}
        {step === 2 && <><p className="welcome-overline">Your starting point</p><h1>Let’s start with your income.</h1><p className="welcome-lead">Use estimates. You can change things later.</p><label>Monthly income in {currency}<input autoFocus required value={income} onChange={(event) => setIncome(event.target.value)} inputMode="decimal" placeholder="0.00" /></label><label>Available balance today in {currency}<input required value={cash} onChange={(event) => setCash(event.target.value)} inputMode="decimal" placeholder="0.00" /></label><label>Monthly payday (optional)<input type="number" min="1" max="31" value={payday} onChange={(event) => setPayday(event.target.value)} placeholder="e.g. 15" /></label><p className="welcome-note">Scheduled income starts tomorrow. It is added on its payday.</p></>}
        {step === 3 && <><p className="welcome-overline">A memory that helps</p><h1>A little context goes a long way.</h1><p className="welcome-lead">CoinJar learns from the income and expenses you record to suggest a saving amount.</p><div className="welcome-disclosure"><strong>Your data, your choice.</strong><p>With memory on, aggregate balances and spending patterns are sent to Walrus. Individual entries stay on this device. The memory service processes the summaries as plaintext.</p><label className="simple-check"><input type="checkbox" checked={sync && walrus} disabled={!walrus} onChange={(event) => setSync(event.target.checked)} />Remember my summaries automatically</label>{demo && <small>This preview uses simulated memory. Nothing is sent to Walrus.</small>}{!walrus && <small>Walrus is not configured. You can turn memory on later.</small>}</div></>}
        <div className="welcome-actions"><button className="simple-button primary welcome-primary" disabled={busy}>{step === 3 ? 'Enter CoinJar' : 'Continue'}</button>{(step > 1 || !walletVerified) && <button className="simple-link" type="button" onClick={() => setStep(step - 1)}>Back</button>}</div>
      </form>}
    </div>
  </main>;
}
