import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createAuthClient } from '@neon/auth';
import { BetterAuthReactAdapter } from '@neon/auth/react/adapters';
import { formatMoney, parseMoney } from './domain';
import { hostedSavings, type HostedSnapshot } from './hostedSavings';
import './simple.css';

const auth = createAuthClient(`${window.location.origin}/api/auth`, { adapter: BetterAuthReactAdapter() });
class RequestFailure extends Error { constructor(message: string, readonly status: number) { super(message); } }

export default function HostedApp() {
  return <Journal />;
}

function Journal() {
  const client = auth!;
  const session = client.useSession();
  const userId = session.data?.user?.id;
  const activeUser = useRef(userId);
  activeUser.current = userId;
  const [snapshot, setSnapshot] = useState<HostedSnapshot | null>(null);
  const [snapshotOwner, setSnapshotOwner] = useState<string | undefined>();
  const [backup, setBackup] = useState<{ savedAt: string; revision: string } | null | 'loading' | 'unavailable'>('loading');
  const [panel, setPanel] = useState<'setup' | 'balance' | 'income' | 'expense' | 'recorded_saving' | 'goal' | 'settings' | 'bill' | 'pay' | 'void' | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<HostedSnapshot['entries'][number] | null>(null);
  const [selectedBill, setSelectedBill] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<{ payload: string; id: string; path: string; data: Record<string, unknown>; revision: string } | null>(null);
  const pendingPrefix = session.data?.user?.id ? `coinjar.pending.${session.data.user.id}.` : '';
  const restorePending = useCallback(() => {
    const key = Object.keys(localStorage).find((item) => item.startsWith(pendingPrefix));
    if (!key) { setUncertain(false); return false; }
    try {
      const pending = JSON.parse(localStorage.getItem(key) || 'null');
      if (!pending || !['/api/tracking/setup', '/api/tracking/balance', '/api/tracking/entries', '/api/tracking/goal', '/api/tracking/settings', '/api/tracking/bills', '/api/tracking/bills/pay', '/api/tracking/void'].includes(pending.path) || typeof pending.id !== 'string' || key !== pendingPrefix + pending.id || typeof pending.revision !== 'string' || !pending.data || typeof pending.data !== 'object') throw new Error('Invalid pending request');
      const nextPanel = pending.path.endsWith('/setup') ? 'setup' : pending.path.endsWith('/balance') ? 'balance' : pending.path.endsWith('/goal') ? 'goal' : pending.path.endsWith('/settings') ? 'settings' : pending.path.endsWith('/bills') ? 'bill' : pending.path.endsWith('/bills/pay') ? 'pay' : pending.path.endsWith('/void') ? 'void' : pending.data.kind;
      if (!['setup', 'balance', 'goal', 'income', 'expense', 'recorded_saving', 'settings', 'bill', 'pay', 'void'].includes(nextPanel)) throw new Error('Invalid pending request');
      attempt.current = pending; setPanel(nextPanel); setUncertain(true);
    } catch { setError('Could not recover a pending save. Contact support before making another change.'); setUncertain(true); }
    return true;
  }, [pendingPrefix]);
  const call = useCallback(async (path: string, data?: Record<string, unknown>) => {
    const owner = activeUser.current;
    const response = await fetch(path, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, ...(data ? { body: JSON.stringify(data) } : {}) });
    const body = await response.json();
    if (activeUser.current !== owner) throw new RequestFailure('Session changed.', 401);
    if (!response.ok) throw new RequestFailure(body.error || 'Could not load your journal.', response.status);
    return body;
  }, [client]);
  const refresh = useCallback(async () => { const owner = userId; try { const data = await call('/api/tracking'); if (activeUser.current === owner) { setSnapshot(data); setSnapshotOwner(owner); setError(''); } } catch (e) { if (activeUser.current === owner) setError(e instanceof Error ? e.message : 'Connection lost.'); } }, [call, userId]);
  useEffect(() => {
    if (!session.data?.user) { setSnapshot(null); attempt.current = null; setUncertain(false); return; }
    void refresh();
    restorePending();
  }, [session.data?.user?.id, refresh, restorePending]);
  useEffect(() => {
    if (!userId || !snapshot || snapshot.setupRequired) { setBackup('loading'); return; }
    let active = true;
    setBackup('loading');
    void call('/api/tracking/backup').then(({ backup: value }) => {
      if (!active) return;
      if (value === null) { setBackup(null); return; }
      if (!value || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt)) || typeof value.revision !== 'string' || !/^\d+$/.test(value.revision)) throw new Error('Invalid backup status');
      setBackup(value);
    }).catch(() => { if (active) setBackup('unavailable'); });
    return () => { active = false; };
  }, [userId, snapshot?.revision, snapshot?.setupRequired, call]);
  if (session.isPending) return <main className="simple-loading">Checking your session…</main>;
  if (!session.data?.user) return <main className="welcome-shell"><div className="welcome-top"><span className="simple-brand">coinjar<span>.</span></span></div><div className="welcome-content"><h1>Your money, more understood.</h1><p className="welcome-lead">A clearer view of your day, with a savings habit that grows with you.</p><button className="simple-button primary welcome-primary" onClick={() => void client.signIn.social({ provider: 'google', callbackURL: window.location.origin }).then(({ error: e }) => { if (e) setError(e.message || 'Could not sign in.'); }).catch(() => setError('Could not sign in.'))}>Continue with Google</button>{error && <p className="simple-error" role="alert">{error}</p>}</div></main>;
  if (snapshotOwner && snapshotOwner !== userId) return <main className="simple-loading">Loading your journal…</main>;
  const save = async (event: React.FormEvent<HTMLFormElement>, requestedPanel = panel) => {
    event.preventDefault();
    const panel = requestedPanel;
    if (!panel || !snapshot || busy) return;
    if (!uncertain && Object.keys(localStorage).some((key) => key.startsWith(pendingPrefix))) { restorePending(); setError('Resolve the existing pending save first.'); return; }
    const fields = new FormData(event.currentTarget);
    let sent = false;
    try {
      if (!uncertain) {
        const cents = ['settings', 'void', 'pay'].includes(panel) ? 0 : parseMoney(String(fields.get('amount') ?? ''));
        if (!cents && !['setup', 'balance', 'settings', 'void', 'pay'].includes(panel)) throw new Error('Enter an amount above zero.');
        const data = panel === 'setup' ? { currency: String(fields.get('currency')), openingCashCents: cents, openingCashDate: today } : panel === 'balance' ? { balanceCents: cents } : panel === 'goal' ? { title: String(fields.get('title') ?? ''), targetCentavos: cents, ...(fields.get('date') ? { targetDate: String(fields.get('date')) } : {}) } : panel === 'settings' ? { bufferCents: parseMoney(String(fields.get('buffer') ?? '')), dailyLimitCents: parseMoney(String(fields.get('limit') ?? '')), pace: String(fields.get('pace')), walletAddress: snapshot.walletAddress ?? null, weekend: fields.has('weekend') } : panel === 'bill' ? { title: String(fields.get('title') ?? ''), amountCents: cents, dueDate: String(fields.get('date')) } : panel === 'pay' ? { billId: selectedBill, date: String(fields.get('date')) } : panel === 'void' ? { entryId: selectedEntry?.id, reason: String(fields.get('reason') ?? ''), ...(fields.get('replacement') ? { replacement: { kind: selectedEntry?.kind, amountCentavos: parseMoney(String(fields.get('replacement'))), date: String(fields.get('date')), note: String(fields.get('note') ?? '') } } : {}) } : { kind: panel, amountCentavos: cents, date: String(fields.get('date')), note: String(fields.get('note') ?? '') };
        const path = panel === 'setup' ? '/api/tracking/setup' : panel === 'balance' ? '/api/tracking/balance' : panel === 'goal' ? '/api/tracking/goal' : panel === 'settings' ? '/api/tracking/settings' : panel === 'bill' ? '/api/tracking/bills' : panel === 'pay' ? '/api/tracking/bills/pay' : panel === 'void' ? '/api/tracking/void' : '/api/tracking/entries';
        const payload = JSON.stringify({ path, data });
        if (!attempt.current || attempt.current.payload !== payload) attempt.current = { payload, id: crypto.randomUUID(), path, data, revision: snapshot.revision };
      }
      if (!attempt.current) throw new Error('No pending entry to retry.');
      setBusy(true); setError('');
      localStorage.setItem(pendingPrefix + attempt.current.id, JSON.stringify(attempt.current));
      sent = true;
      await call(attempt.current.path, { ...attempt.current.data, operationId: attempt.current.id, revision: attempt.current.revision });
      localStorage.removeItem(pendingPrefix + attempt.current.id);
      attempt.current = null; if (!restorePending()) setPanel(null); await refresh();
    } catch (e) {
      if (sent && attempt.current && (!(e instanceof RequestFailure) || e.status >= 500)) { setUncertain(true); setError('The save outcome is uncertain. Retry this same entry before making another change.'); }
      else {
        if (attempt.current && e instanceof RequestFailure && (e.status !== 401 || !uncertain)) { localStorage.removeItem(pendingPrefix + attempt.current.id); attempt.current = null; }
        setUncertain(e instanceof RequestFailure && e.status === 401 && uncertain);
        if (e instanceof RequestFailure && e.status === 409) await refresh();
        setError(e instanceof Error ? e.message : 'Could not save.');
      }
    }
    finally { setBusy(false); }
  };
  const pendingData = uncertain ? attempt.current?.data : undefined;
  const pendingAmount = Number(pendingData?.balanceCents ?? pendingData?.amountCentavos ?? pendingData?.targetCentavos);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const savings = snapshot ? hostedSavings(snapshot, today) : null;
  const currency = snapshot?.preferences?.currency ?? 'PHP';
  const money = (amount: number) => formatMoney(amount, currency);
  if (snapshot && (snapshot.setupRequired || (uncertain && panel === 'setup'))) return <div className="simple-shell hosted-savings"><header className="simple-header"><span className="simple-brand">coinjar<span>.</span></span><button className="simple-link" onClick={() => void client.signOut()}>Sign out</button></header><main className="simple-main"><section className="simple-balance"><p className="simple-greeting">A fresh start</p><h1>Your money, your way.</h1><p className="simple-balance-note">Choose your currency and enter the money you have available today.</p>{error && <p className="simple-error" role="alert">{error}</p>}{uncertain && <p className="simple-notice" role="status">Your setup may have been saved. Retry the same setup to confirm.</p>}<form className="simple-form" onSubmit={event => void save(event, 'setup')}><fieldset disabled={uncertain} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 15 }}><label>Currency<select name="currency" required defaultValue={String(pendingData?.currency ?? '')}><option value="" disabled>Choose a currency</option><option value="PHP">Philippine peso (PHP)</option><option value="USD">US dollar (USD)</option></select></label><label>Current balance<input name="amount" inputMode="decimal" required defaultValue={typeof pendingData?.openingCashCents === 'number' ? (pendingData.openingCashCents / 100).toFixed(2) : ''} /></label><p className="simple-hint">This is your starting balance as of today. Add transactions from today onward so earlier spending is not counted twice. Currency cannot be changed after setup.</p></fieldset><button className="simple-button primary" disabled={busy}>{busy ? 'Saving…' : uncertain ? 'Retry setup' : 'Continue'}</button></form></section></main></div>;
  return <div className="simple-shell hosted-savings"><header className="simple-header"><span className="simple-brand">coinjar<span>.</span></span><button className="simple-link" onClick={() => void client.signOut().then((result) => { if (result.error) { setError('Could not sign out. Try again.'); return; } setSnapshot(null); setPanel(null); }).catch(() => setError('Could not sign out. Try again.'))}>Sign out</button></header><main className="simple-main">
    {error && <p className="simple-error" role="alert">{error}</p>}
    {snapshot && !snapshot.setupRequired && <p className="simple-notice" role="status">{backup === 'loading' ? 'Checking your backup…' : backup === 'unavailable' ? 'Backup status is unavailable. Your latest changes may not be protected.' : !backup ? 'No verified backup yet. Your journal is not protected against data loss.' : BigInt(backup.revision) < BigInt(snapshot.revision) || Date.now() - Date.parse(backup.savedAt) > 48 * 60 * 60 * 1000 ? 'Your latest changes may not be backed up yet.' : `Backup checked: ${new Date(backup.savedAt).toLocaleString()}.`}</p>}
    {uncertain && attempt.current && <p className="simple-notice" role="status">A previous save may have completed. Retry the same {attempt.current.path.endsWith('/goal') ? 'goal' : 'entry'} to resolve it safely.</p>}
    {!snapshot ? <div className="simple-loading"><p>{error ? 'Your journal could not be loaded.' : 'Loading your journal…'}</p>{error && <button className="simple-button outline" onClick={() => void refresh()}>Try again</button>}</div> : <><section className="simple-balance"><p className="simple-greeting">Hello, {session.data.user.name}.</p><div className="simple-label-row"><h1>Recorded balance</h1><button className="simple-link" disabled={uncertain} onClick={() => setPanel('balance')}>Update balance</button></div><p className="simple-amount">{money(savings!.summary.availableCents)}</p><p className="simple-balance-note">Your recorded balance in {currency}. This is not a bank balance.</p><div className="simple-actions"><button className="simple-button primary" disabled={uncertain} onClick={() => { attempt.current = null; setPanel('expense'); }}>Add expense</button><button className="simple-button outline" disabled={uncertain} onClick={() => { attempt.current = null; setPanel('income'); }}>Add income</button></div></section>
    {panel && <section className="simple-form"><div className="simple-label-row"><h2>{{ setup: 'Set up', balance: 'Update balance', goal: 'Savings goal', income: 'Add income', expense: 'Add expense', recorded_saving: 'Record savings', settings: 'Savings settings', bill: 'Upcoming expense', pay: 'Record paid expense', void: 'Correct or void entry' }[panel]}</h2><button className="simple-link" disabled={uncertain} onClick={() => { setPanel(null); attempt.current = null; }}>Cancel</button></div><form onSubmit={(event) => void save(event)} key={`${panel}-${uncertain}`}><fieldset disabled={uncertain} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 15 }}>
      {(panel === 'goal' || panel === 'bill') && <label>{panel === 'goal' ? 'Goal name' : 'Expense name'}<input name="title" maxLength={80} required defaultValue={String(pendingData?.title ?? (panel === 'goal' ? snapshot.goal?.title : '') ?? '')} /></label>}
      {!['settings', 'void', 'pay'].includes(panel) && <label>{panel === 'goal' ? `Target in ${currency}` : `Amount in ${currency}`}<input name="amount" inputMode="decimal" required defaultValue={Number.isSafeInteger(pendingAmount) ? (pendingAmount / 100).toFixed(2) : ''} /></label>}
      {panel === 'balance' && <p>This adjusts your recorded balance without adding income or an expense.</p>}
      {panel === 'pay' && <><p>Record this bill as paid and add its amount to your expenses. No payment is made.</p><label>Payment date<input name="date" type="date" min={snapshot.preferences?.openingCashDate} max={today} defaultValue={today} required /></label></>}
      {panel === 'settings' && <><label>Minimum cash buffer<input name="buffer" inputMode="decimal" required defaultValue={((snapshot.preferences?.bufferCents ?? 20000) / 100).toFixed(2)} /></label><label>Daily savings limit<input name="limit" inputMode="decimal" required defaultValue={((snapshot.preferences?.dailyLimitCents ?? 1500) / 100).toFixed(2)} /></label><label>Savings pace<select name="pace" defaultValue={snapshot.preferences?.pace ?? 'steady'}><option value="gentle">Gentle</option><option value="steady">Steady</option><option value="focused">Focused</option></select></label><label className="simple-check"><input type="checkbox" name="weekend" defaultChecked={snapshot.preferences?.confirmedWeekend ?? false} />I confirm that I usually spend more on weekends.</label></>}
      {panel === 'void' && <><p>Original entries remain in your history. Enter a replacement amount only if correcting this entry.</p><label>Reason<input name="reason" maxLength={200} required /></label><label>Replacement amount (optional)<input name="replacement" inputMode="decimal" /></label><label>Replacement note<input name="note" maxLength={80} defaultValue={selectedEntry?.note ?? ''} /></label><label>Replacement date<input name="date" type="date" min={snapshot.preferences?.openingCashDate} max={today} defaultValue={selectedEntry?.entry_date ?? today} /></label></>}
      {panel === 'goal' ? <label>Target date (optional)<input name="date" type="date" defaultValue={String(pendingData?.targetDate ?? snapshot.goal?.target_date ?? '')} /></label> : panel === 'bill' ? <label>Due date<input name="date" type="date" required defaultValue={today} /></label> : !['settings', 'void', 'pay', 'balance'].includes(panel) && <><label>Note (optional)<input name="note" maxLength={80} defaultValue={String(pendingData?.note ?? '')} /></label><label>Date<input name="date" type="date" min={snapshot.preferences?.openingCashDate} max={today} defaultValue={String(pendingData?.date ?? today)} required /></label></>}
    </fieldset><button className="simple-button primary" disabled={busy}>{busy ? 'Saving…' : uncertain ? 'Retry same entry' : 'Save'}</button></form></section>}
    <section className="simple-section"><div className="simple-label-row"><h2>Savings goal</h2><button className="simple-link" disabled={uncertain} onClick={() => { attempt.current = null; setPanel('goal'); }}>{snapshot.goal ? 'Edit goal' : 'Create goal'}</button></div>{snapshot.goal ? <><p className="simple-jar-amount">{snapshot.goal.title}</p><p className="simple-hint">Target: {money(Number(snapshot.goal.target_centavos))}</p></> : <p className="simple-empty">Choose something you’re saving for.</p>}</section>
    <section className="simple-section"><h2>Daily savings suggestion</h2><p className="simple-jar-amount">{money(savings!.recommendation.amountCents)}</p><p className="simple-hint">{savings!.recommendation.reasons.join(' ') || 'Based on your goal, available cash, buffer and upcoming expenses.'}</p><details><summary>Why this suggestion?</summary>{savings!.recommendation.factors.filter(factor => factor.affected || factor.observations?.length).map(factor => <div key={factor.type}><p className="simple-hint">{factor.type.replaceAll('_', ' ')} · source: {factor.source}</p>{factor.observations?.map(observation => <p className="simple-hint" key={observation}>{observation}</p>)}</div>)}</details><button className="simple-link" disabled={uncertain} onClick={() => setPanel('settings')}>Savings settings</button> <button className="simple-link" disabled={uncertain} onClick={() => setPanel('bill')}>Add upcoming expense</button> <button className="simple-link" disabled={uncertain} onClick={() => setPanel('recorded_saving')}>Record savings</button><p className="simple-hint">Recorded savings: {money(savings!.summary.savedCents)}.</p><p className="simple-hint">{snapshot.goal ? `${Math.round(savings!.summary.progress * 100)}% of your recorded savings goal` : 'Create a goal to track progress.'}</p>{snapshot.bills?.map((bill) => <div className="simple-row" key={bill.id}><p className="simple-hint">{bill.title}: {money(bill.amountCents)} due {bill.dueDate} {bill.paid ? '· Paid' : ''}</p>{!bill.paid && <button className="simple-link" disabled={uncertain} onClick={() => { setSelectedBill(bill.id); setPanel('pay'); }}>Record paid</button>}</div>)}</section>
    <section className="simple-section"><h2>Recent activity</h2>{snapshot.preferences?.balanceAdjustments?.map(adjustment => <p className="simple-hint" key={adjustment.id}>Balance adjustment on {adjustment.date}: {adjustment.deltaCents < 0 ? '−' : '+'}{money(Math.abs(adjustment.deltaCents))}</p>)}{snapshot.entries.length ? snapshot.entries.map((entry) => <div className="simple-row" key={entry.id}><div><strong>{entry.note || (entry.kind === 'income' ? 'Income' : entry.kind === 'expense' ? 'Expense' : 'Recorded saving')}</strong><small>{entry.entry_date}{entry.voided_at ? ` · Voided: ${entry.void_reason}` : ''}</small>{!entry.voided_at && <button className="simple-link" disabled={uncertain} onClick={() => { setSelectedEntry(entry); setPanel('void'); }}>Correct or void</button>}</div><strong>{entry.kind === 'income' ? '+' : '−'}{money(Number(entry.amount_centavos))}</strong></div>) : <p className="simple-empty">Your activity will appear here.</p>}</section><p className="simple-hint">Your savings suggestion is a guide. You decide what to save.</p></>}
  </main></div>;
}
