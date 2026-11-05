import React, { useEffect, useRef, useState } from 'react';
import { formatMoney, getSummary, parseMoney, scheduleOccurrences, simpleSavingsAdvice, type AppState } from './domain';
import './simple.css';
import Welcome from './Welcome';
const WalletConnect = React.lazy(() => import('./WalletConnect'));

type Payload = { state: AppState; today: string; csrfToken: string; setupWalletVerified?: boolean; config: { demoMode?: boolean; walrusConfigured: boolean; suiNetwork: 'mainnet' | 'testnet' } };
type Panel = 'expense' | 'income' | 'balance' | 'schedule' | 'settings' | 'withdraw' | 'pause' | null;
function operationId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}

export default function SimpleApp() {
  const [data, setData] = useState<Payload | null>(null);
  const [gate, setGate] = useState<{ csrfToken: string; hasProfile: boolean; config: { suiNetwork: 'mainnet' | 'testnet' } } | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  const inFlight = useRef(false);

  const load = async () => {
    try {
      const response = await fetch('/api/state');
      if (response.status === 401) {
        const session = await (await fetch('/api/session')).json();
        setData(null); setGate(session); return;
      }
      if (!response.ok) throw new Error('Could not load CoinJar.');
      setGate(null); setData(await response.json());
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load CoinJar.'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const refresh = () => { if (!inFlight.current && document.visibilityState === 'visible') void load(); };
    const timer = setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  async function post(path: string, body: Record<string, unknown>) {
    if (!data || inFlight.current) return null;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CoinJar-Token': data.csrfToken }, body: JSON.stringify(body) });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || 'Could not save.');
      if (result.state) setData(result);
      return result;
    } catch (e) {
      setError(e instanceof TypeError ? 'Connection lost. Retry the same entry or refresh to check.' : e instanceof Error ? e.message : 'Could not save.');
      return null;
    } finally { inFlight.current = false; setBusy(false); }
  }
  if (gate) {
    const gatePost = async (path: string, body: Record<string, unknown>) => {
      try {
        const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CoinJar-Token': gate.csrfToken }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not connect.');
        return result;
      } catch (e) { setError(e instanceof Error ? e.message : 'Could not connect.'); return null; }
    };
    return <main className="welcome-shell"><div className="welcome-top"><span className="simple-brand">coinjar<span>.</span></span></div><div className="welcome-content"><h1>{gate.hasProfile ? 'Welcome back.' : 'Welcome to CoinJar.'}</h1><p className="welcome-lead">Connect your Slush wallet to unlock this local journal.</p>{error && <p className="simple-error" role="alert">{error}</p>}<React.Suspense fallback={<p className="welcome-note">Opening wallet…</p>}><WalletConnect network={gate.config.suiNetwork} post={gatePost} onVerified={() => { setError(''); void load(); }} onError={setError} /></React.Suspense></div></main>;
  }
  if (!data) return <main className="simple-loading">{error || 'Loading CoinJar…'}</main>;
  const { state, today, config } = data;
  const currency = state.preferences.currency;
  const money = (value: number) => formatMoney(value, currency);
  const summary = getSummary(state, today);
  if (!state.simpleProfile && !state.onboardingComplete && !state.goal && !state.entries.length && state.openingCashCents === undefined && !state.balanceAdjustments?.length) return <><div aria-live="polite">{error && <p className="simple-error">{error}</p>}</div><Welcome currency={currency} balance={summary.availableCents} demo={Boolean(config.demoMode)} walrus={config.walrusConfigured} network={config.suiNetwork} walletVerified={Boolean(data.setupWalletVerified)} busy={busy} post={post} onError={setError} /></>;
  const advice = simpleSavingsAdvice(state, today);
  const savedToday = state.entries.find((entry) => !entry.voidedAt && entry.autoSavingsDate === today);
  const pausedToday = state.savingsPauses?.some((item) => item.date === today);
  const weekendDismissed = state.insightReviews?.some((item) => item.id === 'higher-weekend-spending' && item.status === 'dismissed');
  const entries = state.entries.filter((entry) => !entry.voidedAt).slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const schedules = (state.schedules ?? []).filter((schedule) => schedule.kind === 'income' && !schedule.endDate);
  const upcoming = scheduleOccurrences(state, today).filter((item) => item.schedule.kind === 'income');
  const lastSummary = state.memories.filter((item) => item.summarySyncRequested).at(-1);
  const open = (next: Panel) => { attempt.current = null; setError(''); setNotice(''); setPanel(next); };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!panel) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    try {
      const amountCents = ['settings', 'pause'].includes(panel) ? 0 : parseMoney(String(fields.get('amount') ?? ''));
      if (!['balance', 'settings', 'pause'].includes(panel) && amountCents <= 0) throw new Error('Enter an amount above zero.');
      let path: string, body: Record<string, unknown>;
      if (panel === 'pause') {
        path = '/api/simple/pause';
        body = { reason: String(fields.get('reason')) };
      } else if (panel === 'settings') {
        path = '/api/simple/settings';
        body = { dailyCents: parseMoney(String(fields.get('daily') || '0')), bufferCents: parseMoney(String(fields.get('buffer') || '0')), summarySync: fields.has('sync'), consent: fields.has('sync') };
      } else if (panel === 'balance') {
        path = '/api/balance/set';
        body = { amountCents, expectedCents: summary.availableCents };
      } else if (panel === 'withdraw') {
        path = '/api/jar/withdraw';
        body = { amountCents };
      } else if (panel === 'schedule') {
        path = '/api/schedules';
        const days = String(fields.get('day') || '').split(',').map((part) => part.trim());
        if (days.some((day) => !/^\d{1,2}$/.test(day))) throw new Error('Enter days like 15, 30.');
        body = { kind: 'income', title: String(fields.get('note') || 'Income'), amountCents, days: days.map(Number), autoRecord: true };
      } else {
        path = '/api/entries';
        body = { kind: panel, amountCents, note: String(fields.get('note') || ''), date: String(fields.get('date') || today) };
      }
      if (!['settings', 'pause'].includes(panel)) {
        const fingerprint = JSON.stringify(body);
        if (!attempt.current || attempt.current.payload !== fingerprint) attempt.current = { payload: fingerprint, id: operationId() };
        body.operationId = attempt.current.id;
      }
      void post(path, body).then((result) => { if (result) { attempt.current = null; setPanel(null); setNotice(panel === 'pause' ? 'Saving paused for today.' : panel === 'balance' ? 'Balance updated.' : panel === 'schedule' ? 'Income schedule saved.' : panel === 'settings' ? 'Settings saved.' : 'Saved.'); } });
    } catch (e) { setError(e instanceof Error ? e.message : 'Check the amount.'); }
  };

  return <div className="simple-shell">
    <header className="simple-header"><a href="/" className="simple-brand">coinjar<span>.</span></a><button className="simple-link" onClick={() => open('settings')}>Settings</button></header>
    <main className="simple-main">
      {config.demoMode && <div className="simple-sample">Sample journal {state.entries.length === 0 && <button type="button" onClick={() => void post('/api/demo', {}).then((r) => { if (r) setNotice('Sample data loaded.'); })} disabled={busy}>Load sample data</button>}</div>}
      <div aria-live="polite">{error && <p className="simple-error">{error}</p>}{notice && <p className="simple-notice">{notice}</p>}</div>
      <section className="simple-balance" aria-labelledby="balance-title">
        {state.simpleProfile && <p className="simple-greeting">Hello, {state.simpleProfile.name}.</p>}
        <div className="simple-label-row"><h1 id="balance-title">Available balance</h1><button className="simple-link" onClick={() => open('balance')}>Set balance</button></div>
        <p className="simple-amount">{money(summary.availableCents)}</p>
        {state.autoSavings && <p className="simple-balance-note">After money set aside in your jar</p>}
        <div className="simple-actions"><button className="simple-button primary" onClick={() => open('expense')}>Add expense</button><button className="simple-button outline" onClick={() => open('income')}>Add income</button></div>
      </section>
      {panel && <section className="simple-form" aria-labelledby="form-title"><div className="simple-label-row"><h2 id="form-title">{panel === 'pause' ? 'Pause today’s saving' : panel === 'settings' ? 'Settings' : panel === 'withdraw' ? 'Move from jar' : panel === 'balance' ? 'Set available balance' : panel === 'schedule' ? 'Schedule income' : panel === 'expense' ? 'Add expense' : 'Add income'}</h2><button className="simple-link" onClick={() => open(null)}>Cancel</button></div>
        {panel === 'balance' && <p className="simple-hint">Enter what is available to spend{summary.savedCents > 0 ? ', after money in your jar' : ''}.</p>}
        {panel === 'schedule' && <p className="simple-hint">Starts tomorrow so today’s balance isn’t counted twice.</p>}
        {panel === 'pause' && <p className="simple-hint">{savedToday ? 'Today’s jar saving will move back to your available balance.' : 'Nothing will be added to the jar today.'}</p>}
        <form onSubmit={submit} key={panel}>
          {panel === 'pause' ? <label>Reason<select name="reason" defaultValue="other"><option value="other">Something else</option><option value="weekend">I need money for the weekend</option></select></label> : panel === 'settings' ? <><label>Save daily in {currency}<input name="daily" inputMode="decimal" required defaultValue={((state.autoSavings?.dailyCents ?? 0) / 100).toFixed(2)} /></label><label>Keep available in {currency}<input name="buffer" inputMode="decimal" required defaultValue={((state.autoSavings?.bufferCents ?? 0) / 100).toFixed(2)} /></label><p className="simple-hint">Savings start tomorrow. The jar is a tracker; no money is transferred.</p><label className="simple-check"><input type="checkbox" name="sync" disabled={!config.walrusConfigured} defaultChecked={state.summarySync?.enabled ?? config.walrusConfigured} />Remember summaries and spending patterns</label><p className="simple-hint">Balance, jar total, monthly totals and patterns are shared with Walrus. The service processes them as plaintext; individual entries stay here.</p>{!config.walrusConfigured && <p className="simple-hint">Connect Walrus in <a href="/?advanced=1">More settings</a> to enable sync.</p>}<a className="simple-link" href="/?advanced=1">More settings</a>{state.simpleProfile?.walletAddress && <button type="button" className="simple-link" onClick={() => void post('/api/simple/logout', {}).then((result) => { if (result) { setData(null); setPanel(null); void load(); } })}>Lock journal</button>}</> : <label>Amount in {currency}<input name="amount" required inputMode="decimal" placeholder="0.00" defaultValue={panel === 'balance' && summary.availableCents >= 0 ? (summary.availableCents / 100).toFixed(2) : ''} /></label>}
          {['income', 'expense', 'schedule'].includes(panel) && <label>{panel === 'schedule' ? 'Name' : 'Note (optional)'}<input name="note" maxLength={80} placeholder={panel === 'schedule' ? 'Salary' : panel === 'expense' ? 'Groceries' : 'Payday'} /></label>}
          {panel === 'schedule' ? <label>Days of month<input name="day" inputMode="text" required placeholder="15, 30" /></label> : ['income', 'expense'].includes(panel) && <label>Date<input name="date" type="date" max={today} defaultValue={today} required /></label>}
          <button className="simple-button primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </form>
      </section>}
      <section className="simple-insight"><div className="simple-insight-top"><span className="insight-dot" aria-hidden="true" /><span>YOUR SAVINGS INSIGHT</span></div><h2>{pausedToday ? 'Saving paused today' : savedToday ? `${money(savedToday.amountCents)} saved today` : state.autoSavings ? `Up to ${money(advice.amountCents)} today` : 'A little, at your own pace.'}</h2><p>{advice.reason}</p>{state.autoSavings && !advice.learning && <small>Estimate from recorded spending and income. Upcoming bills and missing expenses can change it.</small>}{!state.autoSavings && <button className="simple-link" onClick={() => open('settings')}>Set up savings</button>}{state.autoSavings && !pausedToday && <button className="simple-link" onClick={() => open('pause')}>Pause today</button>}{state.weekendSignal && !state.rememberedWeekendSpending && !weekendDismissed && <div className="weekend-offer"><p>You’ve paused for weekend spending more than once. Save 25% less on Fridays and weekends?</p><div className="simple-actions"><button className="simple-button primary" disabled={busy} onClick={() => void post('/api/simple/weekend', { enabled: true })}>Yes, save less</button><button className="simple-button outline" disabled={busy} onClick={() => void post('/api/simple/weekend', { enabled: false })}>No thanks</button></div></div>}{state.rememberedWeekendSpending && <button className="simple-link" disabled={busy} onClick={() => void post('/api/simple/weekend', { enabled: false })}>Turn off weekend adjustment</button>}</section>
      <section className="simple-section"><div className="simple-label-row"><h2>Savings jar</h2>{summary.savedCents > 0 && <button className="simple-link" onClick={() => open('withdraw')}>Move back</button>}</div><p className="simple-jar-amount">{money(summary.savedCents)}</p><p className="simple-hint">{state.autoSavings ? `${money(state.autoSavings.dailyCents)} a day · keeping ${money(state.autoSavings.bufferCents)} available` : 'Set a daily amount in Settings.'}</p></section>
      <section className="simple-section"><div className="simple-label-row"><h2>Scheduled income</h2><button className="simple-link" onClick={() => open('schedule')}>Add schedule</button></div>
        {schedules.length ? schedules.map((item) => <div className="simple-row" key={item.id}><div><strong>{item.title}</strong><small>Monthly · day {item.days.join(', ')}{!item.autoRecord ? ' · confirmation required' : ''}</small></div><div className="simple-schedule-end"><strong>{money(item.amountCents)}</strong><button className="simple-link" disabled={busy} onClick={() => void post('/api/schedules/stop', { id: item.id }).then((result) => { if (result) setNotice('Schedule stopped.'); })}>Stop</button></div></div>) : <p className="simple-empty">No income scheduled yet.</p>}
        {upcoming.some((item) => !item.schedule.autoRecord && item.date <= today) && <p className="simple-hint">Older income schedules need confirmation in <a href="/?advanced=1">More settings</a>.</p>}
      </section>
      <section className="simple-section"><div className="simple-label-row"><h2>Recent activity</h2><a className="simple-link" href="/?advanced=1">View all</a></div>
        {entries.length ? entries.slice(0, 5).map((entry) => <div className="simple-row" key={entry.id}><div><strong>{entry.note || (entry.kind === 'expense' ? 'Expense' : entry.kind === 'income' ? 'Income' : 'Savings')}</strong><small>{entry.date}</small></div><strong>{entry.kind === 'income' || entry.kind === 'withdrawal' ? '+' : '−'}{money(entry.amountCents)}</strong></div>) : <p className="simple-empty">Your activity will appear here.</p>}
      </section>
      {state.summarySync?.enabled && <p className="simple-sync">{config.demoMode ? 'Preview memory' : 'Walrus memory'}: {lastSummary?.syncStatus === 'stored' ? 'synced' : lastSummary?.syncStatus === 'unknown' ? 'outcome unknown · check More settings' : lastSummary?.syncStatus === 'not_sent' ? 'not sent · check More settings' : 'syncing'}</p>}
    </main>
  </div>;
}
