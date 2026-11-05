import React, { useEffect, useRef, useState } from 'react';
import {
  detectInsights,
  getSummary,
  recommend,
  parseMoney,
  formatMoney,
  estimateUsdCents,
  scheduleOccurrences,
  type AppState,
} from './domain';
import { formatSui } from './sui';
import { formatUsdc, USDC_TYPES } from './usdc';
const WalletTransfer = React.lazy(() => import('./WalletTransfer'));

type Payload = {
  state: AppState;
  today: string;
  config: {
    walrusConfigured: boolean;
    tatumConfigured: boolean;
    localOnly: boolean;
    demoMode?: boolean;
    suiNetwork: 'mainnet' | 'testnet';
  };
  csrfToken: string;
};
type Tab = 'Today' | 'Activity' | 'Jar' | 'Insights' | 'Memory' | 'Settings';
const decimalAmount = (n: number) => (n / 100).toFixed(2);
const operationId = () => {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const suiBalance = (balance: unknown) => {
  if (
    !balance ||
    typeof balance !== 'object' ||
    !('balanceMist' in balance) ||
    typeof balance.balanceMist !== 'string' ||
    !/^\d+$/.test(balance.balanceMist)
  )
    return 'Unavailable';
  const isUsdc = 'coinType' in balance && (balance.coinType === USDC_TYPES.mainnet || balance.coinType === USDC_TYPES.testnet);
  if (isUsdc) return `${formatUsdc(balance.balanceMist)} ${balance.coinType === USDC_TYPES.testnet ? 'DUSDC' : 'USDC'}${'network' in balance ? ` · ${String(balance.network)}` : ''}`;
  const digits = balance.balanceMist.padStart(10, '0');
  const amount = `${digits.slice(0, -9)}.${digits.slice(-9)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  return `${amount} SUI${'network' in balance ? ` · ${String(balance.network)}` : ''}`;
};
const cents = (s: string) => {
  const n = parseMoney(s);
  if (n == null || !Number.isFinite(n))
    throw new Error('Enter a valid amount.');
  return n;
};
const readable = (text: string, currency: 'PHP' | 'USD') => {
  if (text.startsWith('COINJAR_HABIT_V1 ')) {
    try {
      const observations = JSON.parse(text.slice('COINJAR_HABIT_V1 '.length)).observations;
      return `Confirmed habit: spending is higher on recorded weekend days.${Array.isArray(observations) ? ` Supporting observations: ${observations.join(' | ')}` : ''}`;
    } catch { return 'Confirmed weekend spending habit.'; }
  }
  if (!text.includes('COINJAR_PREFERENCES_V1 ')) return text;
  try {
    const payload = JSON.parse(
      text.slice(text.indexOf('COINJAR_PREFERENCES_V1 ') + 23),
    );
    const p = payload.preferences;
    if (!['PHP', 'USD'].includes(p.currency))
      return 'Saved preference with unknown currency.';
    const money = (n: number) => formatMoney(n, p.currency);
    const observations = p.limitProvenance?.observations;
    return `Saved preferences: ${money(p.bufferCents)} buffer, ${money(p.dailyLimitCents)} daily cap, ${p.pace} pace.${Array.isArray(observations) ? ` Supporting observations: ${observations.join(' | ')}` : ''}`;
  } catch {
    return 'Saved preference snapshot.';
  }
};
const dateLabel = (s: string) =>
  new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
const manilaDate = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export default function App() {
  const [data, setData] = useState<Payload | null>(null);
  const [tab, setTab] = useState<Tab>('Today');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [goalEditing, setGoalEditing] = useState(false);
  const [entryKind, setEntryKind] = useState<
    'income' | 'expense' | 'contribution'
  >('contribution');
  const [entryOpen, setEntryOpen] = useState(false);
  const entryAttempt = useRef<{
    fingerprint: string;
    operationId: string;
  } | null>(null);
  const entryInFlight = useRef(false);
  const entryReturnToToday = useRef(false);
  const [amount, setAmount] = useState('');
  const [feedbackAction, setFeedbackAction] = useState(false);
  const [skipOpen, setSkipOpen] = useState(false);
  const [deferredOccurrences, setDeferredOccurrences] = useState<string[]>([]);
  const [reviewingSavings, setReviewingSavings] = useState(false);
  const [selectedMemories, setSelectedMemories] = useState<string[]>([]);
  const [recall, setRecall] = useState<unknown[]>([]);
  const [balance, setBalance] = useState<{
    balanceMist: string;
    network: string;
    coinType: string;
  } | null>(null);
  const [activityMonth, setActivityMonth] = useState('');
  const [activityKind, setActivityKind] = useState('all');
  const [showWalletTransfer, setShowWalletTransfer] = useState(false);
  const [fxEstimate, setFxEstimate] = useState<{ rate: { value: string; timestamp: number; source: string } } | null>(null);
  useEffect(() => {
    fetch('/api/state')
      .then(async (r) => {
        const x = await r.json();
        if (!r.ok) throw new Error(x.error);
        setData(x);
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!data?.state.goal || data.state.preferences.currency !== 'PHP' || !data.config.tatumConfigured) return;
    let cancelled = false;
    const refresh = () => {
      fetch('/api/fx/estimate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coinjar-token': data.csrfToken }, body: '{}' })
        .then(async (response) => { if (!response.ok) throw new Error(); return response.json(); })
        .then((quote) => { if (!cancelled) setFxEstimate(quote); })
        .catch(() => { if (!cancelled) setFxEstimate(null); });
    };
    refresh();
    const timer = setInterval(refresh, 3600000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [Boolean(data?.state.goal), data?.state.preferences.currency, data?.config.tatumConfigured, data?.csrfToken]);
  useEffect(() => {
    if (busy || !data?.state.memories.some((m) => m.syncStatus === 'pending' || m.syncStatus === 'syncing')) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetch('/api/state').then(async (response) => {
        if (!response.ok) throw new Error('Could not check memory sync.');
        const next = await response.json();
        if (!cancelled) setData(next);
      }).catch(() => { if (!cancelled) setError('Could not check memory sync. Open Memory to check again.'); });
    }, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [data, busy]);
  useEffect(() => {
    if (!data || busy) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (manilaDate(new Date()) === data.today) return;
      fetch('/api/state').then(async (response) => {
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (!cancelled) setData(next);
      }).catch(() => { if (!cancelled) setError('Could not update today’s date. Check the connection and reload.'); });
    }, 60000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [data, busy]);
  useEffect(() => {
    const reminder = data?.state.reminder;
    if (!reminder?.enabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const check = () => {
      const current = new Date();
      const date = manilaDate(current);
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(current);
      const key = `coinjar-review-reminder:${date}`;
      try {
        if (time >= reminder.time && localStorage.getItem(key) !== 'sent') {
          new Notification('Your savings review is ready', { body: 'Open CoinJar to review your recorded activity.' });
          localStorage.setItem(key, 'sent');
        }
      } catch { /* Notification permission or storage may have changed. */ }
    };
    check();
    const timer = setInterval(check, 60000);
    return () => clearInterval(timer);
  }, [data?.state.reminder?.enabled, data?.state.reminder?.time]);
  async function post(path: string, body: unknown) {
    if (!data) return null;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CoinJar-Token': data.csrfToken,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || 'Something went wrong.');
      if (result.state) {
        setData(result);
        setReviewingSavings(false);
        setSkipOpen(false);
      }
      return result;
    } catch (e) {
      setError(
        path === '/api/entries' && e instanceof TypeError
          ? 'The response was lost. The entry may have been saved. Retry this same form safely or refresh to check.'
          : e instanceof Error
            ? e.message
            : 'Something went wrong.',
      );
      return null;
    } finally {
      setBusy(false);
    }
  }
  function handle(fn: () => void) {
    try {
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please check your entries.');
    }
  }
  if (!data)
    return (
      <main className="loading">
        <div className="brand">
          coinjar<span>.</span>
        </div>
        <p role="status">{error || 'Opening your passbook…'}</p>
      </main>
    );
  const { state, today, config } = data;
  const currency = state.preferences.currency;
  const money = (n: number) => formatMoney(n, currency);
  const goal = state.goal;
  const summary = getSummary(state, today);
  const suggestion = recommend(state, today);
  const rememberedFactors = suggestion.factors.filter((factor) =>
    factor.affected && (factor.source === 'walrus' || factor.source === 'confirmed' || factor.type === 'daily_limit' && factor.origin === 'explicit'));
  const suggested = suggestion.amountCents;
  const insights = detectInsights(state, today);
  const recentSpending = state.entries
    .filter(
      (e) =>
        !e.voidedAt &&
        e.kind === 'expense' &&
        e.date <= today &&
        e.date >=
          new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000)
            .toISOString()
            .slice(0, 10),
    )
    .reduce((n, e) => n + e.amountCents, 0);
  const progress = Math.min(100, Math.floor(summary.progress * 100));
  const recent = [...state.entries].sort((a, b) => b.date.localeCompare(a.date) || (b.time ?? '').localeCompare(a.time ?? '') || b.createdAt.localeCompare(a.createdAt));
  const filteredActivity = recent.filter((entry) => (!activityMonth || entry.date.startsWith(activityMonth)) && (activityKind === 'all' || entry.kind === activityKind));
  const todayExpenses = recent.filter((e) => !e.voidedAt && e.kind === 'expense' && e.date === today);
  const todayEntries = recent.filter((e) => !e.voidedAt && e.date === today);
  const monthly = (kind: 'income' | 'expense') => state.entries.filter((e) => !e.voidedAt && e.kind === kind && e.date.startsWith(today.slice(0, 7)) && e.date <= today).reduce((total, entry) => total + entry.amountCents, 0);
  const scheduled = scheduleOccurrences(state, today);
  const verifiedUsdc = (state.onchainTransfers ?? []).filter((item) => item.asset === 'USDC' && item.status === 'verified' && item.goalId === goal?.id && item.network === config.suiNetwork).reduce((sum, item) => sum + BigInt(item.amountMicroUsdc ?? '0'), 0n).toString();
  const valuedOnchain = (state.onchainTransfers ?? []).some((item) => item.status === 'verified' && item.goalId === goal?.id && item.network === 'mainnet' && item.phpValuation && currency === 'PHP');
  const syncStatus = (status: NonNullable<AppState['memories'][number]['syncStatus']>) => ({
    pending: 'Waiting to sync', syncing: 'Syncing to Walrus', stored: 'Synced to Walrus',
    not_sent: 'Not sent. Open Memory to select it for manual sync.',
    unknown: 'Sync outcome unknown. Check the Walrus dashboard before retrying; CoinJar will not retry automatically.',
  })[status];
  const autoSyncControl = <div className="auto-sync-control">
    <h2>Automatically sync confirmed preferences</h2>
    <p>When you confirm or correct a detected preference in Insights, CoinJar can send its summary to Walrus. The summary may include your daily cap, cash buffer, savings pace, exchange-rate metadata, and supporting observations with dates and amounts. Individual expense entries and unconfirmed patterns are not sent automatically. Changes made in Settings require manual sync.</p>
    <p>The Walrus relayer processes this summary as plaintext; provider costs may apply and remote copies can persist. Only future confirmations are synced. If CoinJar closes before a sync starts, it stays local until you select it for manual sync. You can turn this off at any time; a sync already in progress may still finish.</p>
    <button className="button outline" disabled={busy || (!state.autoMemorySync && !config.walrusConfigured)} onClick={() => void post('/api/memory/automatic', { enabled: !state.autoMemorySync, ...(!state.autoMemorySync ? { consent: true } : {}) }).then((r) => { if (r) setMessage(r.state.autoMemorySync ? 'Automatic sync enabled for future confirmed preferences.' : 'Automatic sync is off.'); })}>
      {state.autoMemorySync ? 'Turn off automatic sync' : 'I agree, turn on automatic sync'}
    </button>
    <p>{state.autoMemorySync ? 'Automatic sync is on.' : config.walrusConfigured ? 'Automatic sync is off.' : 'Configure Walrus to enable automatic sync.'}</p>
  </div>;
  const spentToday = todayExpenses.reduce((total, entry) => total + entry.amountCents, 0);
  const openEntry = (kind: typeof entryKind, value = '', returnToToday = false) => {
    if (entryInFlight.current) return;
    entryReturnToToday.current = returnToToday;
    entryAttempt.current = null;
    setFeedbackAction(false);
    setEntryKind(kind);
    setAmount(value);
    setEntryOpen(true);
    setTab('Activity');
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          coinjar<span>.</span>
          <small>YOUR SAVINGS PASSBOOK</small>
        </div>
        <nav aria-label="Main navigation">
          {(
            ['Today', 'Activity', 'Jar', 'Insights', 'Settings'] as Tab[]
          ).map((t) => (
            <button
              key={t}
              className={tab === t ? 'nav-item active' : 'nav-item'}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="side-footer">
          PRIVATE BY DEFAULT
          <br />
          <span>Local, single-user demo</span>
        </div>
      </aside>
      <main className="main" aria-busy={busy}>
        <header className="topbar">
          <span>YOUR SAVINGS</span>
          <span className="date-stamp">{dateLabel(today)}</span>
        </header>
        <div className="mobile-brand">
          coinjar<span>.</span>
        </div>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          {(
            ['Today', 'Activity', 'Jar', 'Insights', 'Settings'] as Tab[]
          ).map((t) => (
            <button
              key={t}
              className={tab === t ? 'selected' : ''}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        {config.demoMode && (
          <p className="sample-banner">
            SAMPLE DATA MODE · Separate local journal and Walrus namespace from
            your real records.
          </p>
        )}
        {!config.demoMode && goal?.id === 'demo-goal' && (
          <p className="sample-banner">
            This journal contains sample data from the earlier CoinJar demo. It
            has been preserved.
          </p>
        )}
        {currency === 'USD' && (
          <p className="sample-banner">
            Previous USD journal. Your amounts remain in USD and have not been
            converted. Your peso journal is separate.
          </p>
        )}
        <div className="notice" aria-live="polite">
          {busy && <p>Please wait…</p>}
          {error && <p className="error">{error}</p>}
          {message && <p className="success">{message}</p>}
        </div>
        {tab === 'Today' && !state.goal && !state.entries.length && !state.onboardingComplete && state.openingCashCents === undefined ? (
          <Onboarding currency={currency} busy={busy} demoMode={Boolean(config.demoMode)} onFinish={(body) => void post('/api/onboarding', body).then((r) => { if (r) setMessage('Your starting balance and goal are ready.'); })} onSample={() => void post('/api/demo', {}).then((r) => { if (r) setMessage('Sample data loaded. All entries are synthetic.'); })} onError={setError} />
        ) : tab === 'Today' && (
          <>
            <div className="page-intro">
              <section className="today-spending" aria-labelledby="today-spending-heading">
                <div className="available-money"><span>Available money</span><strong>{money(summary.availableCents)}</strong><small>Based on what you’ve recorded.</small></div>
                <div className="monthly-totals"><span>Income this month <b>{money(monthly('income'))}</b></span><span>Expenses this month <b>{money(monthly('expense'))}</b></span></div>
                <div className="today-spending-head">
                  <div>
                    <h2 id="today-spending-heading">Today’s spending</h2>
                    <p>{todayExpenses.length ? `${todayExpenses.length} ${todayExpenses.length === 1 ? 'expense' : 'expenses'} recorded today` : 'Start with what you spent today.'}</p>
                  </div>
                  <strong>{money(spentToday)}</strong>
                </div>
                <div className="quick-actions"><button className="button primary expense-action" aria-label="Add an expense" onClick={() => openEntry('expense', '', true)}>− Expense</button><button className="button outline income-action" aria-label="Add income" onClick={() => openEntry('income', '', true)}>+ Income</button></div>
                {todayEntries.length > 0 && <div className="today-expenses">
                  {todayEntries.slice(0, 5).map((entry) => <div className="today-expense" key={entry.id}>
                    <div><strong>{entry.note || entry.category || (entry.kind === 'contribution' ? 'Savings' : entry.kind)}</strong><small>{entry.time ? `${entry.time} · ` : ''}{entry.category && entry.note ? entry.category : entry.kind === 'income' ? 'Income' : entry.kind === 'contribution' ? 'Recorded savings' : 'Expense'}</small></div>
                    <span>{entry.kind === 'income' ? '+' : '−'}{money(entry.amountCents)}</span>
                  </div>)}
                  <button className="text-button" onClick={() => setTab('Activity')}>View all activity</button>
                </div>}
                {!todayEntries.length && <p className="today-empty">A coffee, a commute, or groceries: add each expense as it happens.</p>}
              </section>
              <div className="recommendation-intro">
                <h1>
                  {goal ? (
                    <>
                      {reviewingSavings ? 'You could set aside ' : 'You could save up to '}<em>{money(suggested)}</em> today.
                    </>
                  ) : (
                    <>
                      Make a little room for <em>saving.</em>
                    </>
                  )}
                </h1>
                {goal ? <p className="recommendation-context">{reviewingSavings ? 'Based on what you’ve recorded.' : 'Based on what you’ve recorded so far.'} Add any remaining expenses before deciding what to save.</p> : <p>Set a goal, then record income and expenses to get a savings suggestion.</p>}
                {goal && currency === 'PHP' && suggested > 0 && (fxEstimate ? <div className="fx-estimate"><strong>About {(estimateUsdCents(suggested, fxEstimate.rate.value) / 100).toFixed(2)} USDC</strong><span>Assuming 1 USDC = $1 · ₱{(1 / Number(fxEstimate.rate.value)).toFixed(2)} per USD</span><small>{fxEstimate.rate.source} · {new Date(fxEstimate.rate.timestamp).toLocaleString()}</small><small>Actual USDC price and fees may differ. USDC is sent on the Sui network.</small></div> : <p>USD and USDC estimate unavailable until a rate is retrieved.</p>)}
                {goal && !reviewingSavings && <button className="button outline review-savings" onClick={() => setReviewingSavings(true)}>Review today’s savings</button>}
                {goal && <details className="recommendation-reasons"><summary>Why this amount?</summary><p>{suggestion.reasons.map((reason) => readable(reason, currency)).join(' ')}</p></details>}
                {rememberedFactors.length > 0 && (
                  <div className="memory-explanation">
                    {rememberedFactors.some((factor) => factor.type === 'daily_limit') && <p>Without your saved cap, today’s recommendation would be {money(suggestion.withoutLimitCents)}. Your saved cap helps set it to {money(suggested)}.</p>}
                    {rememberedFactors.some((factor) => factor.type === 'higher-weekend-spending') && <p>Your saved weekend spending preference also affects today’s recommendation.</p>}
                    {rememberedFactors.some((factor) => factor.type === 'cash_buffer' || factor.type === 'pace') && <p>A restored savings setting also affects today’s recommendation.</p>}
                    <details>
                    <summary>Personalized using your saved preferences</summary>
                    {rememberedFactors.map((factor) => (
                      <div key={factor.type}>
                        {factor.type === 'daily_limit' ? (
                          <p>Without your saved daily cap, the recommendation would be {money(suggestion.withoutLimitCents)}. Your {money(Number(factor.value))} cap {factor.source === 'walrus' ? 'was restored from Walrus and ' : ''}{factor.origin === 'confirmed' ? 'came from a pattern you confirmed.' : factor.origin === 'explicit' ? 'was explicitly provided by you.' : factor.origin === 'manual' ? 'came from your settings.' : 'has no recorded original source.'}</p>
                        ) : factor.type === 'higher-weekend-spending' ? (
                          <p>Your confirmed weekend spending preference{factor.source === 'walrus' ? ', restored from Walrus,' : ''} reduced this recommendation by 25%.</p>
                        ) : (
                          <p>Your {factor.type === 'cash_buffer' ? `${money(Number(factor.value))} cash buffer` : `${factor.value} savings pace`} was restored from Walrus. {factor.origin === 'manual' ? 'It came from your settings.' : 'Its original source was not recorded.'}</p>
                        )}
                        {factor.observations?.length ? <ul>{factor.observations.map((observation, i) => <li key={i}>{observation}</li>)}</ul> : <p>No supporting observations were saved.</p>}
                      </div>
                    ))}
                    <button className="text-button" onClick={() => setTab('Memory')}>Inspect saved memories</button>{' · '}
                    <button className="text-button" onClick={() => setTab('Settings')}>Correct daily cap</button>{' · '}
                    <button className="text-button" onClick={() => setTab('Insights')}>Review insights</button>
                    </details>
                  </div>
                )}
                {goal ? (
                  <>
                    {reviewingSavings && <dl className="review-summary"><div><dt>Spent today</dt><dd>{money(spentToday)}</dd></div><div><dt>Upcoming and overdue bills</dt><dd>{money(suggestion.billCents)}</dd></div><div><dt>Cash buffer</dt><dd>{money(state.preferences.bufferCents)}</dd></div><div><dt>Next expected income</dt><dd>{scheduled.find((item) => item.schedule.kind === 'income' && item.date >= today) ? dateLabel(scheduled.find((item) => item.schedule.kind === 'income' && item.date >= today)!.date) : 'None scheduled'}</dd></div></dl>}
                    {reviewingSavings && suggested > 0 && (
                      <div className="actions">
                        <button
                          className="button primary"
                          disabled={busy || suggested <= 0}
                          onClick={() => {
                            openEntry('contribution', decimalAmount(suggested));
                            setFeedbackAction(true);
                          }}
                        >
                          Save this amount
                        </button>
                        <button
                          className="button outline"
                          disabled={busy || suggested <= 0}
                          onClick={() => {
                            openEntry('contribution', decimalAmount(suggested));
                            setFeedbackAction(true);
                          }}
                        >
                          Adjust
                        </button>
                        <button
                          className="button outline"
                          disabled={busy || suggested <= 0}
                          onClick={() => setSkipOpen(!skipOpen)}
                        >
                          Skip today
                        </button>
                      </div>
                    )}
                    {reviewingSavings && suggested <= 0 && summary.availableCents <= 0 && (
                      <button
                        className="button primary"
                        onClick={() => openEntry('income')}
                      >
                        Add income
                      </button>
                    )}
                    {reviewingSavings && <small>
                      Recording a contribution does not transfer money.
                    </small>}
                    {skipOpen && (
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = e.currentTarget;
                          void post('/api/feedback', {
                            action: 'skip',
                            suggestedCents: suggested,
                            reason: String(
                              new FormData(form).get('reason') || '',
                            ),
                          }).then((r) => {
                            if (r) {
                              setSkipOpen(false);
                              setMessage(
                                'Skipped today. Feedback saved locally.',
                              );
                            }
                          });
                        }}
                      >
                        <label>
                          Why are you skipping? <span>(optional)</span>
                          <input name="reason" maxLength={160} />
                        </label>
                        <button className="button outline" disabled={busy}>
                          Confirm skip
                        </button>
                      </form>
                    )}
                  </>
                ) : (
                  <button
                    className="button primary"
                    onClick={() => setGoalEditing(true)}
                  >
                    Start a savings goal <span></span>
                  </button>
                )}
              </div>
            </div>
            {scheduled.some((item) => item.date <= today && !deferredOccurrences.includes(`${item.schedule.id}:${item.date}:${item.scheduledDay}`)) && <section className="section expected-items">
              <h2>Waiting for confirmation</h2>
              <p>Expected income is not available cash until you confirm it. Confirm only money received after your opening balance, so it is not counted twice. Scheduled expenses remain reserved until you record payment.</p>
              {scheduled.filter((item) => item.date <= today && !deferredOccurrences.includes(`${item.schedule.id}:${item.date}:${item.scheduledDay}`)).slice(0, 5).map((item) => {
                const key = `${item.schedule.id}:${item.date}:${item.scheduledDay}`;
                return <div className="expected-row" key={key}><div><strong>{item.schedule.title} · {money(item.schedule.amountCents)}</strong><small>Expected {dateLabel(item.date)} · monthly day {item.scheduledDay}</small></div><div className="actions"><button className="button outline" disabled={busy} onClick={() => void post('/api/schedules/confirm', { id: item.schedule.id, date: item.date, scheduledDay: item.scheduledDay }).then((r) => { if (r) setMessage(item.schedule.kind === 'income' ? 'Income recorded as received.' : 'Payment recorded as an expense.'); })}>{item.schedule.kind === 'income' ? 'Confirm received' : 'Record payment'}</button><button className="text-button" onClick={() => setDeferredOccurrences((items) => [...items, key])}>Not yet</button></div></div>;
              })}
            </section>}
            {!goal && !goalEditing && config.demoMode && (
              <div className="start-strip">
                <div>
                  <span className="tiny-label">NEW HERE?</span>
                  <h2>Every journey starts somewhere.</h2>
                  <p>
                    Create a goal, or explore with clearly labeled sample data.
                  </p>
                </div>
                <button
                  className="button outline"
                  disabled={busy}
                  onClick={async () => {
                    const r = await post('/api/demo', {});
                    if (r)
                      setMessage(
                        'Sample data loaded. All entries are synthetic.',
                      );
                  }}
                >
                  Load sample data <span></span>
                </button>
              </div>
            )}
            {goalEditing && (
              <GoalForm
                goal={goal}
                currency={currency}
                busy={busy}
                onCancel={() => setGoalEditing(false)}
                onSave={(body) =>
                  handle(() => {
                    void post('/api/goal', body).then((r) => {
                      if (r) {
                        setGoalEditing(false);
                        setMessage('Goal saved.');
                      }
                    });
                  })
                }
                onError={setError}
              />
            )}
            {goal && (
              <>
                <section className="section goal-section">
                  <div className="section-head">
                    <div>
                      <span className="tiny-label">
                        THE THING YOU’RE SAVING FOR
                      </span>
                      <h2>{goal.title}</h2>
                    </div>
                    <div className="actions"><button className="text-button" onClick={() => setTab('Jar')}>Open jar</button><button className="text-button" onClick={() => setGoalEditing(true)}>Edit goal</button></div>
                  </div>
                  <div className="goal-progress">
                    <div>
                      <span>{valuedOnchain ? 'Goal progress, including historical transfer estimates' : 'Recorded savings'}<br /></span>
                      <strong>{money(summary.totalGoalCents)}</strong>
                      <span> of {money(goal.targetCents)}</span>
                    </div>
                    <span>{progress}% there</span>
                  </div>
                  <div className="progress-track">
                    <div style={{ width: progress + '%' }} />
                  </div>
                  <div className="goal-meta">
                    <span>TARGET DATE &nbsp; {goal.targetDate ? dateLabel(goal.targetDate) : 'No deadline'}</span>
                    <span>STATUS &nbsp; {goal.status.toUpperCase()}</span>
                  </div>
                  <div className="goal-wallet">
                    <div>
                      <span className="tiny-label">OPTIONAL SUI NETWORK WALLET</span>
                      <p>
                        {goal.wallet?.balance
                          ? `${suiBalance(goal.wallet.balance)} · last checked ${goal.wallet.updatedAt || 'unknown'}${!goal.wallet.updatedAt || !Number.isFinite(Date.parse(goal.wallet.updatedAt)) || Date.now() - Date.parse(goal.wallet.updatedAt) > 86400000 ? ' · stale' : ''}`
                          : goal.wallet ? 'Balance not yet checked.' : 'No wallet added.'}
                      </p>
                      <small>Wallet funds are not automatically allocated to this goal. USDC and {currency} have different values.</small>
                    </div>
                    <div className="actions">
                      {goal.wallet && <button className="button outline" disabled={busy || !config.tatumConfigured} onClick={() => void post('/api/goal/wallet/refresh', {}).then((r) => { if (r) setMessage('Wallet balance refreshed.'); else setError('Wallet refresh failed. The last checked balance may be stale.'); })}>Refresh balance</button>}
                      <button className="text-button" onClick={() => setTab('Settings')}>{goal.wallet ? 'Review wallet' : 'Add wallet'}</button>
                    </div>
                  </div>
                </section>
                <section className="section snapshot">
                  <span className="tiny-label">THE BIG PICTURE</span>
                  <h2>Your financial snapshot</h2>
                  <div className="snapshot-grid">
                    <div>
                      <span>Available cash</span>
                      <strong>{money(summary.availableCents)}</strong>
                    </div>
                    <div>
                      <span>Reserved bills and scheduled expenses</span>
                      <strong>
                        {money(suggestion.billCents)}
                      </strong>
                    </div>
                    <div>
                      <span>Cash buffer</span>
                      <strong>{money(state.preferences.bufferCents)}</strong>
                    </div>
                    <div>
                      <span>Spending, last 7 days</span>
                      <strong>{money(recentSpending)}</strong>
                    </div>
                  </div>

                  {state.rememberedWeekendSpending && (
                    <p>
                      You confirmed higher spending on recorded weekend days.
                    </p>
                  )}
                  <button
                    className="text-button"
                    onClick={() => setTab('Memory')}
                  >
                    Review what CoinJar remembers
                  </button>
                </section>
              </>
            )}
          </>
        )}
        {tab === 'Activity' && (
          <>
            <PageTitle
              n="02"
              eyebrow="YOUR PASSBOOK"
              title="Your activity"
              text="Track what you spend, what comes in, and what you set aside."
            />
            <div className="actions">
              <button
                className="button primary"
                onClick={() => openEntry('expense')}
              >
                Add expense +
              </button>
              <button
                className="button outline"
                onClick={() => openEntry('income')}
              >
                Add income +
              </button>
              <button
                className="button outline"
                onClick={() => openEntry('contribution')}
              >
                Record contribution{' '}
              </button>
            </div>
            {entryOpen && (
              <form
                className="form-panel"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  handle(() => {
                    if (entryInFlight.current) return;
                    const payload = {
                      kind: entryKind,
                      amountCents: cents(amount),
                      note: String(f.get('note')),
                      date: String(f.get('date')),
                      time: String(f.get('time') || ''),
                      category: String(f.get('category') || ''),
                      ...(feedbackAction && cents(amount) <= suggested
                        ? {
                            feedback: {
                              action:
                                cents(amount) < suggested ? 'reduce' : 'accept',
                              suggestedCents: suggested,
                              reason: String(f.get('reason') || ''),
                            },
                          }
                        : {}),
                    };
                    const fingerprint = JSON.stringify(payload);
                    if (entryAttempt.current?.fingerprint !== fingerprint)
                      entryAttempt.current = {
                        fingerprint,
                        operationId: operationId(),
                      };
                    entryInFlight.current = true;
                    void post('/api/entries', {
                      ...payload,
                      operationId: entryAttempt.current.operationId,
                    })
                      .then((r) => {
                        if (r) {
                          setFeedbackAction(false);
                          entryAttempt.current = null;
                          setEntryOpen(false);
                          if (entryReturnToToday.current) setTab('Today');
                          entryReturnToToday.current = false;
                          setMessage(entryKind === 'expense' ? (r.state.goal ? 'Expense recorded. Your savings suggestion is up to date.' : 'Expense recorded. Set a goal when you are ready to see a savings suggestion.') : 'Entry recorded locally. No money was moved.');
                        }
                      })
                      .finally(() => {
                        entryInFlight.current = false;
                      });
                  });
                }}
              >
                <div className="section-head">
                  <h2>Record {entryKind}</h2>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => setEntryOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <p>
                  Confirm the amount below. This is a personal record, not a
                  transfer.
                </p>
                <div className="form-grid">
                  <label>
                    Amount in {currency}
                    <input
                      required
                      autoFocus
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  </label>
                  <label>
                    Date
                    <input
                      name="date"
                      type="date"
                      defaultValue={today}
                      max={today}
                      required
                    />
                  </label>
                  <label>
                    Time
                    <input name="time" type="time" defaultValue={new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())} />
                  </label>
                  <label>
                    Category <span>(optional)</span>
                    <input
                      name="category"
                      list="entry-categories"
                      maxLength={60}
                      placeholder="e.g. Groceries"
                    />
                    <datalist id="entry-categories"><option value="Food" /><option value="Groceries" /><option value="Transport" /><option value="Bills" /><option value="Shopping" /><option value="Health" /><option value="Other" /></datalist>
                  </label>
                  {feedbackAction && (
                    <label>
                      Why this amount? <span>(optional)</span>
                      <input name="reason" maxLength={160} />
                    </label>
                  )}
                  <label className="wide">
                    Note <span>(optional)</span>
                    <input
                      name="note"
                      maxLength={160}
                      placeholder="What would you like to remember?"
                    />
                  </label>
                </div>
                <button className="button primary" disabled={busy}>
                  {entryKind === 'expense' ? 'Save expense' : entryKind === 'income' ? 'Save income' : 'Record savings'}
                </button>
              </form>
            )}
            <section className="section bills">
              <span className="tiny-label">PLAN AHEAD</span>
              <h2>Upcoming bills</h2>
              <form
                className="form-panel"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const f = new FormData(form);
                  handle(() => {
                    void post('/api/bills', {
                      title: String(f.get('title')),
                      amountCents: cents(String(f.get('billAmount'))),
                      dueDate: String(f.get('dueDate')),
                    }).then((r) => {
                      if (r) {
                        form.reset();
                        setMessage('Bill saved locally.');
                      }
                    });
                  });
                }}
              >
                <div className="form-grid">
                  <label>
                    Bill name
                    <input name="title" required maxLength={80} />
                  </label>
                  <label>
                    Bill amount in {currency}
                    <input name="billAmount" inputMode="decimal" required />
                  </label>
                  <label>
                    Due date
                    <input name="dueDate" type="date" required />
                  </label>
                </div>
                <button className="button outline" disabled={busy}>
                  Add bill
                </button>
              </form>
              {(state.bills || []).map((bill) => (
                <div className="ledger-row" key={bill.id}>
                  <span className="ledger-date">{dateLabel(bill.dueDate)}</span>
                  <div>
                    <strong>{bill.title}</strong>
                    <small>{bill.paid ? 'PAID' : 'UPCOMING'}</small>
                  </div>
                  <div>
                    <b>{money(bill.amountCents)}</b>{' '}
                    {!bill.paid && (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void post('/api/bills/pay', { id: bill.id })
                        }
                      >
                        Record payment
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <p>
                Recording payment adds an expense to your ledger. It does not
                transfer money.
              </p>
            </section>
            <section className="section ledger">
              <div className="section-head">
                <div>
                  <span className="tiny-label">A RECORD OF YOUR PROGRESS</span>
                  <h2>Activity</h2>
                </div>
                <span className="count">{filteredActivity.length} ENTRIES</span>
              </div>
              <div className="activity-filters"><label>Month<input type="month" value={activityMonth} onChange={(event) => setActivityMonth(event.target.value)} /></label><label>Type<select value={activityKind} onChange={(event) => setActivityKind(event.target.value)}><option value="all">All activity</option><option value="income">Income</option><option value="expense">Expenses</option><option value="contribution">Savings</option></select></label></div>
              {filteredActivity.length ? (
                filteredActivity.map((e) => (
                  <div className="ledger-row" key={e.id}>
                    <div className="ledger-date">{dateLabel(e.date)}{e.time ? ` · ${e.time}` : ''}</div>
                    <div>
                      <strong>
                        {e.note ||
                          (e.kind === 'contribution'
                            ? 'Set aside for your goal'
                            : e.kind)}
                      </strong>
                      <small>
                        {e.kind.toUpperCase()}{' '}
                        {e.category
                          ? '· ' + e.category.toUpperCase() + ' '
                          : ''}
                        · {e.voidedAt ? 'VOIDED' : 'SELF-REPORTED'}
                      </small>
                    </div>
                    <div>
                      <b>
                        {e.kind === 'expense' ? '−' : '+'}
                        {money(e.amountCents)}
                      </b>
                      {!e.voidedAt && (
                        <button
                          className="text-button"
                          disabled={busy}
                          aria-label={`Void entry: ${e.note || e.kind}, ${money(e.amountCents)}`}
                          onClick={() => {
                            if (
                              window.confirm(
                                'Void this entry? It will stop counting toward your totals. You can record a corrected entry afterward. No money is moved.',
                              )
                            )
                              void post('/api/entries/void', { id: e.id }).then(
                                (r) => {
                                  if (r)
                                    setMessage(
                                      'Entry voided. Record a new entry if needed.',
                                    );
                                },
                              );
                          }}
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">
                  {recent.length ? 'No entries match these filters.' : 'Your passbook is blank for now. Record your first entry to start.'}
                </div>
              )}
            </section>
          </>
        )}
        {tab === 'Jar' && <>
          <PageTitle n="03" eyebrow="YOUR GOAL" title="Your savings jar" text="A little progress, one recorded contribution at a time." />
          {goal ? <section className="jar-page">
            <div className="jar-visual" role="img" aria-label={`Savings jar ${progress}% full, based on recorded savings${valuedOnchain ? ' and estimated on-chain value' : ''}`}><div className="jar-water" style={{ height: `${progress}%` }} /><strong>{progress}%</strong></div>
            <div><h2>{goal.title}</h2><p><strong>{money(summary.totalGoalCents)}</strong> of {money(goal.targetCents)} {valuedOnchain ? 'estimated progress' : 'recorded'}</p><p>Manually recorded: {money(summary.savedCents)}. Verified transfers: {formatUsdc(verifiedUsdc)} {config.suiNetwork === 'testnet' ? 'DUSDC' : 'USDC'} on Sui {config.suiNetwork}.{valuedOnchain ? ` Historical reference value at price check: ${money(summary.onchainEstimateCents)}. It is an estimate and does not update with the market.` : ' Transfers without a current price remain separate from goal progress.'}</p><p>A wallet balance is separate and does not count automatically. Do not manually record the same transfer as well.</p><div className="milestones" aria-label="Goal milestones">{[25, 50, 75, 100].map((value) => <span className={progress >= value ? 'reached' : ''} key={value}>{value}%</span>)}</div><div className="actions"><button className="button primary" disabled={goal.status !== 'active'} onClick={() => openEntry('contribution')}>Record savings</button><button className="button outline" onClick={() => { setGoalEditing(true); setTab('Today'); }}>Edit goal</button><button className="text-button" onClick={() => setTab('Settings')}>View wallet settings</button></div></div>
          </section> : <div className="empty">Finish setup to start your first savings goal.</div>}
          {goal && <section className="section"><h2>USDC savings on Sui</h2><p>Connect an optional wallet to send USDC on Sui to the saved savings address. The wallet asks you to approve; CoinJar checks the transaction through Tatum before marking it verified. Network fees may require SUI.</p>{!config.tatumConfigured && <p>Configure Tatum in Settings before using transaction verification.</p>}<button className="button outline" disabled={!config.tatumConfigured} onClick={() => setShowWalletTransfer(!showWalletTransfer)}>{showWalletTransfer ? 'Close wallet transfer' : 'Open wallet transfer'}</button>{showWalletTransfer && <React.Suspense fallback={<p>Opening wallet tools…</p>}><WalletTransfer state={state} network={config.suiNetwork} busy={busy} post={post} onError={setError} /></React.Suspense>}
            {(state.onchainTransfers ?? []).filter((item) => item.goalId === goal.id).map((item) => <div className="transfer-record" key={item.id}><strong>{item.asset === 'USDC' ? `${formatUsdc(item.amountMicroUsdc!)} ${item.network === 'testnet' ? 'DUSDC' : 'USDC'}` : `${formatSui(item.amountMist!)} SUI`} · Sui {item.network}</strong><small>{item.status.replace('_', ' ')}{item.checkpoint ? ` · checkpoint ${item.checkpoint}` : ''}{item.phpValuation ? ` · historical ${money(item.phpValuation.centavos)} estimate, ${item.phpValuation.source}, ${new Date(item.phpValuation.timestamp).toLocaleString()}${item.asset === 'USDC' ? ' · assumes 1 USDC = $1' : ''}` : ''}{item.digest ? ` · ${item.digest}` : ''}</small>{item.status === 'verified' && item.network === 'mainnet' && currency === 'PHP' && !item.phpValuation && <button className="text-button" disabled={busy} onClick={() => void post('/api/onchain/valuation', { id: item.id }).then((r) => { if (r) setMessage('A reference price was saved. Prices can change.'); })}>Get a PHP reference price</button>}</div>)}
          </section>}
        </>}
        {tab === 'Insights' && (
          <>
            <PageTitle
              n="03"
              eyebrow="WHAT WE NOTICED"
              title="Insights"
              text="Review patterns found in your records."
            />
            {autoSyncControl}
            {state.memories.filter((m) => m.autoSyncRequested && m.syncStatus && m.syncStatus !== 'stored').map((m) => <p className="sync-notice" key={m.id} role="status">{syncStatus(m.syncStatus!)}</p>)}
            <section className="section">
              {insights.length ? (
                insights.map((insight) => (
                  <div className="insight-card" key={insight.id}>
                    <div className="section-head">
                      <h2>{insight.description}</h2>
                      <span className="count">
                        {insight.confidence.toUpperCase()} CONFIDENCE ·{' '}
                        {insight.status.toUpperCase()}
                      </span>
                    </div>
                    <p>
                      {insight.transactionCount} relevant records · Detected{' '}
                      {dateLabel(insight.detectedAt)} · Observations {dateLabel(insight.periodStart)} to {dateLabel(insight.periodEnd)}
                    </p>
                    <ul>
                      {insight.observations.map((observation, i) => (
                        <li key={i}>{observation}</li>
                      ))}
                    </ul>
                    <>
                      <div className="actions">
                        {insight.status !== 'confirmed' && (
                          <button
                            className="button primary"
                            disabled={busy}
                            onClick={() =>
                              void post('/api/insights/review', {
                                id: insight.id,
                                action: 'confirm',
                              }).then((r) => {
                                if (r) setMessage(r.state.autoMemorySync ? 'Insight confirmed. Eligible preferences sync automatically.' : 'Insight confirmed locally.');
                              })
                            }
                          >
                            Confirm
                          </button>
                        )}
                        {insight.status !== 'dismissed' && (
                          <button
                            className="button outline"
                            disabled={busy}
                            onClick={() =>
                              void post('/api/insights/review', {
                                id: insight.id,
                                action: 'dismiss',
                              })
                            }
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const form = e.currentTarget;
                          handle(() => {
                            const value = String(new FormData(form).get('correction'));
                            void post('/api/insights/review', {
                              id: insight.id,
                              action: 'correct',
                              ...(insight.id === 'preferred-contribution'
                                ? { dailyLimitCents: cents(value) }
                                : { correction: value }),
                            }).then((r) => {
                              if (r) setMessage(insight.id === 'preferred-contribution' ? 'Daily cap updated.' : 'Correction saved locally.');
                            });
                          });
                        }}
                      >
                        <label>
                          {insight.id === 'preferred-contribution' ? `Correct daily cap in ${currency}` : 'Correct this assumption'}
                          <small>{insight.id === 'preferred-contribution' ? 'This sets your daily savings cap.' : 'This saves a note and dismisses the insight. To change your daily cap, use Settings.'}</small>
                          <input name="correction" required maxLength={160} inputMode={insight.id === 'preferred-contribution' ? 'decimal' : 'text'} />
                        </label>
                        <button className="button outline" disabled={busy}>
                          Save correction
                        </button>
                      </form>
                    </>
                  </div>
                ))
              ) : (
                <div className="empty">
                  Not enough data to identify a reliable pattern yet.
                </div>
              )}
            </section>
          </>
        )}
        {tab === 'Memory' && (
          <>
            <PageTitle
              n="03"
              eyebrow="THINGS WORTH REMEMBERING"
              title="Memory"
              text="Review the notes and preferences that shape your suggestions."
            />
            <p>
              Daily cap: {money(state.preferences.dailyLimitCents)} · Current
              suggestion: {money(suggested)}.{' '}
              <button
                className="text-button"
                onClick={() => setTab('Settings')}
              >
                Adjust preferences
              </button>
            </p>
            {autoSyncControl}
            <section className="section">
              <div className="section-head">
                <div>
                  <span className="tiny-label">YOUR NOTES</span>
                  <h2>Memory journal</h2>
                </div>
              </div>
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const text = String(new FormData(form).get('text'));
                  void post('/api/memories', { text, kind: 'feedback' }).then(
                    (r) => {
                      if (r) {
                        form.reset();
                        setMessage('Note saved locally.');
                      }
                    },
                  );
                }}
              >
                <label className="sr-only" htmlFor="memory-text">
                  Add a memory
                </label>
                <input
                  id="memory-text"
                  name="text"
                  required
                  maxLength={500}
                  placeholder="What should CoinJar remember?"
                />
                <button className="button primary" disabled={busy}>
                  Save note +
                </button>
              </form>
              {state.memories.length ? (
                state.memories.map((m) => (
                  <div className="memory-row" key={m.id}>
                    <p>{readable(m.text, currency)}</p>
                    <span>
                      {m.kind.toUpperCase()} ·{' '}
                      {m.source === 'walrus' ? 'REMOTE' : 'LOCAL'}
                    </span>
                    {m.syncStatus && <p role="status">{syncStatus(m.syncStatus)}</p>}
                    <div className="actions">
                      {!m.text.startsWith('COINJAR_PREFERENCES_V1 ') &&
                        !m.text.startsWith('COINJAR_HABIT_V1 ') && (
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              const text = window.prompt(
                                'Edit local memory',
                                m.text,
                              );
                              if (text !== null)
                                void post('/api/memories/update', {
                                  id: m.id,
                                  text,
                                });
                            }}
                          >
                            Edit locally
                          </button>
                        )}
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          void post('/api/memories/delete', { id: m.id })
                        }
                      >
                        Remove locally
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty">
                  No notes yet. Add a reason or preference you want to remember.
                </div>
              )}
            </section>
            <section className="remote-section">
              <div>
                <span className="tiny-label">OPTIONAL</span>
                <h2>Sync with Walrus</h2>
                <p>
                  Removing a note here does not erase its Walrus copy. Removed
                  notes are not restored to this journal.
                </p>
                <p>
                  Manually selected notes and, if enabled, newly confirmed preferences are uploaded. Check them for sensitive
                  data. Individual expense entries are not uploaded automatically. The relayer
                  sees plaintext and provider costs may apply.
                </p>
                <p className="availability">
                  {config.walrusConfigured
                    ? '● Walrus is configured'
                    : '○ Walrus is not configured. Add server credentials to use remote memory.'}
                </p>
              </div>
              <div className="remote-actions">
                <div>
                  {state.memories
                    .filter((m) => m.approved)
                    .map((m) => (
                      <label className="memory-choice" key={m.id}>
                        <input
                          type="checkbox"
                          checked={selectedMemories.includes(m.id)}
                          onChange={(e) =>
                            setSelectedMemories(
                              e.target.checked
                                ? [...selectedMemories, m.id]
                                : selectedMemories.filter((id) => id !== m.id),
                            )
                          }
                        />{' '}
                        {readable(m.text, currency)}
                      </label>
                    ))}
                </div>
                <button
                  className="button outline"
                  disabled={
                    busy || !config.walrusConfigured || !selectedMemories.length
                  }
                  onClick={async () => {
                    const r = await post('/api/memory/sync', {
                      consent: true,
                      ids: selectedMemories,
                    });
                    if (r)
                      setMessage(
                        r.result?.message ||
                          r.message ||
                          'Memory sync complete.',
                      );
                  }}
                >
                  I consent, sync memory{' '}
                </button>
                <button
                  className="text-button"
                  disabled={busy || !config.walrusConfigured}
                  onClick={async () => {
                    const r = await post('/api/memory/restore', {
                      consent: true,
                    });
                    if (r)
                      setMessage(
                        r.message ||
                          'Preferences restored. Check your settings.',
                      );
                  }}
                >
                  Restore recalled preferences
                </button>
                <p>
                  Restore uses the strictest boundaries from the snapshots
                  found. Recall may miss some snapshots.
                </p>
              </div>
              <form
                className="inline-form remote-search"
                onSubmit={(e) => {
                  e.preventDefault();
                  const query = String(
                    new FormData(e.currentTarget).get('query'),
                  );
                  void post('/api/memory/recall', { query }).then((r) => {
                    if (r) {
                      setRecall(r.memories || []);
                      if (r.warning) setMessage(r.warning);
                    }
                  });
                }}
              >
                <label className="sr-only" htmlFor="query">
                  Search remote memory
                </label>
                <input
                  id="query"
                  name="query"
                  required
                  placeholder="Search remote memory"
                />
                <button
                  className="button outline"
                  disabled={busy || !config.walrusConfigured}
                >
                  Recall{' '}
                </button>
              </form>
              {recall.map((m, i) => (
                <p className="recall" key={i}>
                  REMOTE RESULT ·{' '}
                  {typeof m === 'string' ? m : JSON.stringify(m)}
                </p>
              ))}
            </section>
          </>
        )}
        {tab === 'Settings' && (
          <>
            <PageTitle
              n="04"
              eyebrow="MAKE IT YOURS"
              title="Your pace, your rules."
              text="Set the boundaries that help you save without losing sight of today."
            />
            <section className="section"><div className="section-head"><div><h2>Memory and privacy</h2><p>Review saved preferences and optional Walrus sync.</p></div><button className="text-button" onClick={() => setTab('Memory')}>Memory</button></div></section>
            <section className="section"><h2>Income and bills on a schedule</h2><p>Expected income counts only after you confirm receipt. Scheduled expenses due within 30 days and overdue payments are reserved; recording a payment adds an expense. Avoid adding the same bill twice.</p>
              <form className="form-panel" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); handle(() => {
                const daysText = String(fields.get('days'));
                if (!/^\s*(?:[1-9]|[12]\d|3[01])(?:\s*,\s*(?:[1-9]|[12]\d|3[01]))*\s*$/.test(daysText)) throw new Error('Enter monthly days from 1 to 31, separated by commas.');
                void post('/api/schedules', { kind: String(fields.get('kind')), title: String(fields.get('title')), amountCents: cents(String(fields.get('amount'))), days: daysText.split(',').map((part) => Number(part.trim())) }).then((r) => { if (r) { form.reset(); setMessage('Schedule saved.'); } });
              }); }}><div className="form-grid">
                <label>Schedule type<select name="kind"><option value="income">Expected income</option><option value="expense">Recurring expense</option></select></label>
                <label>Name<input name="title" required maxLength={80} placeholder="Salary or rent" /></label>
                <label>Amount per occurrence in {currency}<input name="amount" required inputMode="decimal" placeholder="0.00" /></label>
                <label>Days of each month<input name="days" required placeholder="15, 30" /><small>Dates beyond a month’s length occur on its last day.</small></label>
              </div><button className="button outline" disabled={busy}>Add schedule</button></form>
              {(state.schedules ?? []).map((item) => <div className="schedule-row" key={item.id}><div><strong>{item.title} · {money(item.amountCents)}</strong><small>{item.kind === 'income' ? 'Expected income' : 'Recurring expense'} · day {item.days.join(', ')}{item.endDate ? ` · stopped ${dateLabel(item.endDate)}` : ''}</small></div>{!item.endDate && <button className="text-button" disabled={busy} onClick={() => void post('/api/schedules/stop', { id: item.id }).then((r) => { if (r) setMessage('Schedule stopped. Existing overdue items remain until recorded.'); })}>Stop future schedule</button>}</div>)}
            </section>
            <section className="section"><h2>Daily savings reminder</h2><p>Choose a time in Manila time. Notifications require permission and a supported secure browser. They only run while CoinJar is open; they may be delayed in a background tab.</p>
              <form className="inline-form" onSubmit={(event) => { event.preventDefault(); const fields = new FormData(event.currentTarget); const enabled = fields.get('enabled') === 'on'; const time = String(fields.get('reminderTime')); void (async () => { if (enabled) { if (!('Notification' in window) || !window.isSecureContext) { setError('Notifications need a supported secure browser. You can still review your savings manually.'); return; } const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission; if (permission !== 'granted') { setError('Notification permission was not granted. You can still review your savings manually.'); return; } } const result = await post('/api/reminder', { enabled, time }); if (result) setMessage(enabled ? 'Reminder saved for when CoinJar is open.' : 'Reminder turned off.'); })(); }}>
                <label>Review time<input name="reminderTime" type="time" defaultValue={state.reminder?.time ?? '20:00'} required /></label>
                <label className="reminder-toggle"><input name="enabled" type="checkbox" defaultChecked={state.reminder?.enabled ?? false} /> Remind me while CoinJar is open</label>
                <button className="button outline" disabled={busy}>Save reminder</button>
              </form>
            </section>
            <section className="section">
              <div className="section-head">
                <div>
                  <span className="tiny-label">YOUR SAVING BOUNDARIES</span>
                  <h2>Preferences</h2>
                  <p>
                    {currency === 'PHP'
                      ? 'Amounts are saved in pesos. A USD conversion is included when a current rate is available.'
                      : 'This previous journal uses USD.'}
                  </p>
                </div>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  handle(() => {
                    void post('/api/preferences', {
                      bufferCents: cents(String(f.get('buffer'))),
                      dailyLimitCents: cents(String(f.get('limit'))),
                      pace: String(f.get('pace')),
                    }).then((r) => {
                      if (r)
                        setMessage(
                          'Preferences saved. Your next suggestion has been updated.',
                        );
                    });
                  });
                }}
              >
                <div className="form-grid">
                  <label>
                    Cash buffer in {currency}
                    <input
                      name="buffer"
                      defaultValue={decimalAmount(
                        state.preferences.bufferCents,
                      )}
                      inputMode="decimal"
                      required
                    />
                    <small>
                      Keep this much available before suggesting savings.
                    </small>
                  </label>
                  <label>
                    Daily savings cap in {currency}
                    <input
                      name="limit"
                      defaultValue={decimalAmount(
                        state.preferences.dailyLimitCents,
                      )}
                      inputMode="decimal"
                      required
                    />
                    <small>The most to suggest in a day.</small>
                  </label>
                  <label>
                    Saving pace
                    <select name="pace" defaultValue={state.preferences.pace}>
                      <option value="gentle">Gentle</option>
                      <option value="steady">Steady</option>
                      <option value="focused">Focused</option>
                    </select>
                  </label>
                </div>
                <button className="button primary" disabled={busy}>
                  Save preferences{' '}
                </button>
              </form>
            </section>
            <section className="section wallet">
              <span className="tiny-label">OPTIONAL / TATUM</span>
              <h2>A read-only view of your wallet.</h2>
              <p>
                Look up a Sui address balance. This does not connect a wallet or
                move funds, and is separate from your {currency} savings.
              </p>
              {!config.tatumConfigured && (
                <form
                  className="form-panel"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const apiKey = String(new FormData(form).get('apiKey'));
                    void post('/api/setup/tatum', { apiKey }).then((r) => {
                      if (r) {
                        form.reset();
                        setMessage('Tatum key saved locally.');
                      }
                    });
                  }}
                >
                  <label>
                    Tatum Mainnet API key
                    <input
                      name="apiKey"
                      type="password"
                      autoComplete="off"
                      placeholder="Paste your API key"
                      required
                    />
                  </label>
                  <p>
                    Saved only in this local app’s ignored .env file. Used for
                    read-only balance lookups.
                  </p>
                  <button className="button primary" disabled={busy}>
                    Save API key
                  </button>
                </form>
              )}
              <p className="availability">
                {config.tatumConfigured
                  ? '● Tatum is configured'
                  : '○ Tatum is not configured. Add server credentials to use balance lookup.'}
              </p>
              {goal ? (
                <>
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const address = String(
                        new FormData(e.currentTarget).get('goalAddress'),
                      );
                      void post('/api/goal/wallet', { address }).then((r) => {
                        if (r) setMessage('Goal wallet saved.');
                      });
                    }}
                  >
                    <label>
                      Goal Sui wallet address
                      <input
                        name="goalAddress"
                        defaultValue={goal.wallet?.address || ''}
                        placeholder="Sui wallet address"
                      />
                    </label>
                    <button className="button outline" disabled={busy}>
                      Save goal wallet
                    </button>
                  </form>
                  {goal.wallet?.address && (
                    <>
                      <p>
                        Goal: {goal.title} · Recorded savings and goal progress:{' '}
                        {money(summary.savedCents)} of {money(goal.targetCents)}
                        .
                      </p>
                      <p>Wallet: {goal.wallet.address}</p>
                      <p>
                        {goal.wallet.balance
                          ? `Last verified balance: ${suiBalance(goal.wallet.balance)}. Updated ${goal.wallet.updatedAt || 'unknown'}${!goal.wallet.updatedAt || !Number.isFinite(Date.parse(goal.wallet.updatedAt)) || Date.now() - Date.parse(goal.wallet.updatedAt) > 86400000 ? ' · stale' : ''}.`
                          : 'No verified goal wallet balance yet.'}
                      </p>
                      <p>
                        Wallet funds are not automatically allocated to this goal. A
                        saved balance may be stale if a refresh fails.
                      </p>
                      <div className="actions">
                        <button
                          className="button outline"
                          disabled={busy || !config.tatumConfigured}
                          onClick={() =>
                            void post('/api/goal/wallet/refresh', {}).then(
                              (r) => {
                                if (r) setMessage('Wallet balance refreshed.');
                                else setError('Wallet refresh failed. The last checked balance may be stale.');
                              },
                            )
                          }
                        >
                          Refresh goal wallet
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            void post('/api/goal/wallet', { address: '' })
                          }
                        >
                          Remove goal wallet
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p>Create a goal to associate a wallet.</p>
              )}
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const address = String(
                    new FormData(e.currentTarget).get('address'),
                  );
                  void post('/api/balance', { address }).then((r) => {
                    if (r) setBalance(r);
                  });
                }}
              >
                <label className="sr-only" htmlFor="address">
                  Sui wallet address
                </label>
                <input
                  id="address"
                  name="address"
                  required
                  placeholder="Sui wallet address"
                />
                <button
                  className="button outline"
                  disabled={busy || !config.tatumConfigured}
                >
                  Check USDC balance{' '}
                </button>
              </form>
              {balance && (
                <p>
                  Balance: {suiBalance(balance)}
                </p>
              )}
            </section>
            <div className="bottom-note">
              <span>YOUR DATA</span>
              <p>
                CoinJar is a local single-user demo. Financial records are
                stored locally. Selected memories are sent remotely only when
                you explicitly select and sync them.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
function Onboarding({ currency, busy, demoMode, onFinish, onSample, onError }: {
  currency: 'PHP' | 'USD'; busy: boolean; demoMode: boolean;
  onFinish: (body: unknown) => void; onSample: () => void; onError: (message: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [opening, setOpening] = useState('');
  const [regular, setRegular] = useState(false);
  const [incomeAmount, setIncomeAmount] = useState('');
  const [paydays, setPaydays] = useState('15, 30');
  const [title, setTitle] = useState('Emergency fund');
  const [target, setTarget] = useState('');
  const [date, setDate] = useState('');
  const [buffer, setBuffer] = useState('200.00');
  const [limit, setLimit] = useState('15.00');
  const [address, setAddress] = useState('');
  return <section className="onboarding">
    <p className="setup-progress">SETUP · {step + 1} OF 4</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      try {
        if (step === 1) { cents(opening); if (regular) { cents(incomeAmount); if (!/^\s*(?:[1-9]|[12]\d|3[01])(?:\s*,\s*(?:[1-9]|[12]\d|3[01]))*\s*$/.test(paydays)) throw new Error('Enter paydays from 1 to 31, separated by commas.'); } }
        if (step === 2) { cents(target); cents(buffer); cents(limit); }
        if (step < 3) { setStep(step + 1); return; }
        onFinish({ openingCashCents: cents(opening), title, targetCents: cents(target), targetDate: date, bufferCents: cents(buffer), dailyLimitCents: cents(limit), pace: 'steady', walletAddress: address, ...(regular ? { incomeSchedule: { kind: 'income', title: 'Expected income', amountCents: cents(incomeAmount), days: paydays.split(',').map((part) => Number(part.trim())) } } : {}) });
      } catch (error) { onError(error instanceof Error ? error.message : 'Check your information.'); }
    }}>
      {step === 0 && <><h1>Save for tomorrow, without losing sight of today.</h1><p>Record what comes in and goes out. CoinJar helps you decide what you can set aside after your everyday expenses.</p></>}
      {step === 1 && <><h1>Start with your money today.</h1><p>Your records stay in this local journal. Only notes you select or confirmed preferences you opt in to sync are sent to Walrus; its relayer processes them as plaintext.</p><div className="form-grid">
        <label>Available cash right now in {currency}<input required inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0.00" /><small>This is your balance as of today, not income for this month. Only add transactions that are not already included in it.</small></label>
        <label>Income pattern<select value={regular ? 'regular' : 'irregular'} onChange={(e) => setRegular(e.target.value === 'regular')}><option value="irregular">Irregular or enter manually</option><option value="regular">Expected monthly paydays</option></select></label>
        {regular && <><label>Expected amount per payday in {currency}<input required inputMode="decimal" value={incomeAmount} onChange={(e) => setIncomeAmount(e.target.value)} placeholder="0.00" /></label><label>Days of each month<input required value={paydays} onChange={(e) => setPaydays(e.target.value)} /><small>For example: 15, 30. The schedule starts tomorrow; record income arriving today separately. Expected income counts only when confirmed.</small></label></>}
      </div></>}
      {step === 2 && <><h1>Give your savings a purpose.</h1><div className="form-grid">
        <label>Goal name<input required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>Goal amount in {currency}<input required inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="0.00" /></label>
        <label>Target date <span>(optional)</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Cash buffer in {currency}<input required inputMode="decimal" value={buffer} onChange={(e) => setBuffer(e.target.value)} /><small>Money to keep available for everyday life.</small></label>
        <label>Daily savings limit in {currency}<input required inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
      </div></>}
      {step === 3 && <><h1>Add a Sui address, if you have one.</h1><p>Optional. A wallet balance stays separate from your peso journal. Adding an address does not connect a wallet or move funds.</p><label>Sui savings address <span>(optional)</span><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" /></label></>}
      <div className="actions setup-actions">{step > 0 && <button type="button" className="button outline" onClick={() => setStep(step - 1)}>Back</button>}<button className="button primary" disabled={busy}>{step === 3 ? 'Finish setup' : 'Continue'}</button></div>
    </form>
    {demoMode && <button className="text-button" disabled={busy} onClick={onSample}>Load sample data</button>}
  </section>;
}

function PageTitle({
  title,
  text,
}: {
  n: string;
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="subpage-intro">
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}
function GoalForm({
  goal,
  currency,
  busy,
  onCancel,
  onSave,
  onError,
}: {
  goal: AppState['goal'];
  currency: 'PHP' | 'USD';
  busy: boolean;
  onCancel: () => void;
  onSave: (body: unknown) => void;
  onError: (s: string) => void;
}) {
  return (
    <form
      className="form-panel"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        try {
          onSave({
            title: String(f.get('title')),
            targetCents: cents(String(f.get('target'))),
            targetDate: String(f.get('date')),
            ...(goal ? { status: String(f.get('status')) } : {}),
          });
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Check your goal.');
        }
      }}
    >
      <div className="section-head">
        <h2>{goal ? 'Edit your goal' : 'Start with a goal'}</h2>
        <button type="button" className="text-button" onClick={onCancel}>
          Close
        </button>
      </div>
      <div className="form-grid">
        <label className="wide">
          What are you saving for?
          <input
            name="title"
            required
            maxLength={80}
            defaultValue={goal?.title || ''}
            placeholder="A little escape, a big dream…"
          />
        </label>
        <label>
          Target in {currency}
          <input
            name="target"
            required
            inputMode="decimal"
            defaultValue={goal ? decimalAmount(goal.targetCents) : ''}
            placeholder="0.00"
          />
        </label>
        <label>
          Target date <span>(optional)</span>
          <input
            name="date"
            type="date"
            defaultValue={goal?.targetDate || ''}
          />
        </label>
        {goal && (
          <label>
            Status
            <select name="status" defaultValue={goal.status}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
            </select>
          </label>
        )}
      </div>
      <button className="button primary" disabled={busy}>
        Save goal{' '}
      </button>
    </form>
  );
}
