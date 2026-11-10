import React, { useEffect, useRef, useState } from 'react';
import { formatMoney, parseMoney, validateDate } from './domain';
import { JOURNAL_KEY, goalSaved, newJournal, savings, upgradeGoals, validateJournal, type PhoneJournal } from './phoneJournal';
import PhoneWalrus from './PhoneWalrus';
import PhoneRecovery, { hasRecoveryKey } from './PhoneRecovery';
import PhoneWallet from './PhoneWallet';
import { newMemoryCode } from './phoneNetwork';
import { usePhoneAutoMemory } from './phoneAutoMemory';
import { usePhoneHabitMemory, usePhoneSpikeMemory } from './phoneHabitMemory';
import { dailyHabitMemory, nextDay, parseDailyHabitMemory, parseSpikeMemory, spikeMemory } from './phoneHabit';
import './simple.css';
import './phone.css';

type Panel = 'income' | 'expense' | 'contribution' | 'goal' | 'goal-new' | 'balance' | 'settings' | null;
function localDate() { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function load() {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return { raw, journal: raw === null ? null : validateJournal(JSON.parse(raw)), error: '' };
  } catch { return { raw: null, journal: null, error: 'Could not read the journal on this device. Do not clear your browser data.' }; }
}

export default function PhoneApp() {
  const [initial] = useState(load);
  const [journal, setJournal] = useState(initial.journal);
  const [raw, setRaw] = useState(initial.raw);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [backupStatus, setBackupStatus] = useState('');
  const [reminders, setReminders] = useState(() => { try { return localStorage.getItem('coinjar.phone.reminder.enabled.v1') === '1'; } catch { return false; } });
  const [reminderVisible, setReminderVisible] = useState(false);
  const [tab, setTab] = useState<'home' | 'goals' | 'activity' | 'profile'>('home');
  const explanation = useRef<HTMLDialogElement>(null);
  const [memoryToolsOpen, setMemoryToolsOpen] = useState(false);
  const autoMemory = usePhoneAutoMemory(journal);
  const [onboardAuto, setOnboardAuto] = useState(false);
  const [onboardHabits, setOnboardHabits] = useState(false);
  const [onboardRecent, setOnboardRecent] = useState(false);
  const [onboardCode, setOnboardCode] = useState('');
  const [onboardExisting, setOnboardExisting] = useState(false);
  const [onboardSaved, setOnboardSaved] = useState(false);
  const [setupDone, setSetupDone] = useState({ nickname: false, currency: false, amount: false });
  const [settingsAuto, setSettingsAuto] = useState(false);
  const [settingsHabits, setSettingsHabits] = useState(false);
  const [settingsRecent, setSettingsRecent] = useState(false);
  const [settingsCode, setSettingsCode] = useState('');
  const [settingsPersonal, setSettingsPersonal] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsRestoring, setSettingsRestoring] = useState(false);
  const [today, setToday] = useState(localDate);
  const habit = usePhoneHabitMemory(journal, today, autoMemory.config.enabled && !autoMemory.config.restorePending && autoMemory.config.habits, autoMemory.config.code, autoMemory.config.personal);
  const recent = usePhoneSpikeMemory(journal, today, autoMemory.config.enabled && !autoMemory.config.restorePending && autoMemory.config.recentHabits, autoMemory.config.code, autoMemory.config.personal);
  const summary = journal ? savings(journal, today, habit.remembered?.days ?? [], Boolean(recent.remembered)) : null;
  const tomorrowDate = nextDay(today);
  const tomorrow = journal ? savings({ ...journal, entries: journal.entries.filter(entry => entry.date <= today), adjustments: journal.adjustments.filter(item => item.date <= today) }, tomorrowDate, habit.remembered ? parseDailyHabitMemory(dailyHabitMemory(habit.remembered), tomorrowDate)?.days ?? [] : [], Boolean(recent.remembered && parseSpikeMemory(spikeMemory(recent.remembered), tomorrowDate))) : null;
  const money = (cents: number) => formatMoney(cents, journal?.currency ?? 'PHP');
  const habitStatuses = [...new Set([habit.status, recent.status].filter(status => status && status !== 'Still learning: more recorded expenses are needed.'))];
  const walletAddress = journal?.walletAddress ?? journal?.goal?.wallet?.address;
  const goal = journal?.goal ?? null;
  const savedToday = journal?.entries.filter(entry => !entry.voidedAt && entry.kind === 'contribution' && entry.date === today && (journal.version === 1 || entry.goalId === goal?.id)).reduce((total, entry) => total + entry.amountCents, 0) ?? 0;
  const savedTodayText = `You saved ${money(savedToday)} today!`;
  const progress = summary ? Math.min(1, Math.max(0, summary.summary.progress)) : 0;
  const daysLeft = goal?.targetDate ? Math.floor((Date.parse(`${goal.targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) + 1 : null;
  useEffect(() => {
    let timer: number;
    const refreshDay = () => {
      setToday(localDate());
      window.clearTimeout(timer);
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      timer = window.setTimeout(refreshDay, midnight.getTime() - Date.now() + 50);
    };
    refreshDay();
    window.addEventListener('focus', refreshDay);
    document.addEventListener('visibilitychange', refreshDay);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', refreshDay); document.removeEventListener('visibilitychange', refreshDay); };
  }, []);
  useEffect(() => {
    if (panel === 'settings') document.getElementById('phone-savings-settings')?.scrollIntoView({ block: 'start' });
  }, [panel]);

  useEffect(() => {
    if (!reminders) { setReminderVisible(false); return; }
    let timer: number;
    const check = () => {
      window.clearTimeout(timer);
      const now = new Date(), scheduled = new Date(now);
      scheduled.setHours(20, 0, 0, 0);
      let dismissed = false;
      try { dismissed = localStorage.getItem('coinjar.phone.reminder.dismissed.v1') === localDate(); } catch { /* Keep the reminder visible if storage is unavailable. */ }
      setReminderVisible(now >= scheduled && !dismissed);
      if (now < scheduled) timer = window.setTimeout(check, scheduled.getTime() - now.getTime() + 50);
    };
    check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [reminders, today]);

  function save(next: PhoneJournal, expected = raw) {
    try {
      const current = localStorage.getItem(JOURNAL_KEY);
      if (current !== expected) throw new Error('This journal changed in another tab. Reload before saving.');
      const value = JSON.stringify(validateJournal(next));
      localStorage.setItem(JOURNAL_KEY, value);
      if (hasRecoveryKey() && value !== current) setBackupStatus('Checking backup…');
      setRaw(value); setJournal(JSON.parse(value)); setError(''); setPanel(null);
      return true;
    } catch (e) { setError(e instanceof Error && e.message.includes('another tab') ? e.message : 'Could not save on this device. Check browser storage and try again.'); return false; }
  }

  function linkWallet(address: string | null) {
    if (!journal) return false;
    const { walletAddress: _address, ...rest } = journal;
    let goal = journal.goal;
    if (goal) { const { wallet: _wallet, ...existing } = goal; goal = { ...existing, ...(address ? { wallet: { address } } : {}) }; }
    return save({ ...rest, goal, ...(address ? { walletAddress: address } : {}) });
  }

  function exportBackup() {
    if (!journal) return;
    const blob = new Blob([JSON.stringify(journal, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `coinjar-backup-${today}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('Backup download started. Keep the file somewhere safe. It contains your financial details.');
  }

  async function restore(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('This backup is too large.');
      const restored = validateJournal(JSON.parse(await file.text()));
      const current = localStorage.getItem(JOURNAL_KEY);
      if (current !== null && !window.confirm('This will replace the journal on this device. Download a backup of your current journal first if you want to keep it. Continue?')) return;
      if (save(restored, current)) setNotice('Backup restored on this device.');
    } catch { setError('This backup could not be read. Your current journal was not changed.'); }
  }

  function trackSetup(event: React.FormEvent<HTMLFormElement>) {
    const f = new FormData(event.currentTarget);
    let amount = false;
    try { parseMoney(String(f.get('amount') ?? '')); amount = true; } catch { amount = false; }
    setSetupDone({ nickname: Boolean(String(f.get('nickname') ?? '').trim()), currency: Boolean(f.get('currency')), amount });
  }

  function setup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const f = new FormData(event.currentTarget), currency = String(f.get('currency'));
      if (currency !== 'PHP' && currency !== 'USD') throw new Error('Choose a currency.');
      const nickname = String(f.get('nickname') ?? '').trim();
      if (!nickname) throw new Error('Enter your nickname.');
      if (onboardAuto && !/^[A-Za-z0-9_-]{43}$/.test(onboardCode)) throw new Error('Enter a valid memory code.');
      if (onboardAuto && !onboardSaved) throw new Error('Save your memory code before continuing.');
      const j = newJournal(currency, parseMoney(String(f.get('amount') ?? '')), today, nickname);
      if (save(j)) {
        if (onboardAuto) {
          try { autoMemory.configure(true, onboardCode, onboardHabits, onboardRecent, true, onboardExisting); setOnboardAuto(false); }
          catch { setError('Journal saved, but memory setup could not be completed.'); return; }
        }
        setNotice('');
      }
    } catch (e) { setError(e instanceof Error && (e.message.includes('memory code') || e.message.includes('nickname')) ? e.message : 'Choose a currency and enter a valid balance.'); }
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!journal || !panel || !summary) return;
    try {
      const f = new FormData(event.currentTarget), now = new Date().toISOString();
      let next: PhoneJournal = { ...journal };
      if (panel === 'settings') {
        const code = settingsCode.trim();
        if (settingsAuto && !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Enter the 43-character Walrus access code.');
        if (settingsAuto && settingsPersonal && !settingsSaved) throw new Error('Save your memory code before continuing.');
      }
      else if (panel === 'goal' || panel === 'goal-new') {
        const title = String(f.get('title') ?? '').trim(), targetCents = parseMoney(String(f.get('amount') ?? '')), targetDate = String(f.get('date') ?? '');
        if (!title || !targetCents) throw new Error('Enter a goal name and an amount above zero.');
        if (!validateDate(targetDate) || targetDate < today) throw new Error('Choose a target date today or later.');
        const existing = panel === 'goal-new' ? null : journal.goal;
        const changedPlan = !existing || existing.targetCents !== targetCents || existing.targetDate !== targetDate;
        const days = Math.floor((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) + 1;
        const newGoal = { id: existing?.id ?? crypto.randomUUID(), title, targetCents, targetDate, ...(changedPlan ? { phoneStartDate: today, phoneBaselineCents: Math.ceil(Math.max(0, targetCents - (existing ? summary.summary.savedCents : 0)) / days) } : { ...(existing?.phoneStartDate ? { phoneStartDate: existing.phoneStartDate } : {}), ...(existing?.phoneBaselineCents !== undefined ? { phoneBaselineCents: existing.phoneBaselineCents } : {}) }), ...(existing?.wallet ? { wallet: existing.wallet } : {}), status: 'active' as const, createdAt: existing?.createdAt ?? now };
        if (panel === 'goal-new' && journal.goal) { const upgraded = upgradeGoals(journal); next = { ...upgraded, otherGoals: [...upgraded.otherGoals!, newGoal] }; }
        else {
          next.goal = newGoal;
          if (!journal.goal && journal.version >= 2) next.entries = journal.entries.map(entry => entry.kind === 'contribution' && !entry.goalId ? { ...entry, goalId: newGoal.id } : entry);
        }
      } else if (panel === 'balance') {
        const value = parseMoney(String(f.get('amount') ?? '')), deltaCents = value - summary.summary.availableCents;
        if (!Number.isSafeInteger(deltaCents)) throw new Error('Amount is too large.');
        next.adjustments = [...journal.adjustments, { id: crypto.randomUUID(), date: today, deltaCents, createdAt: now }];
      } else {
        const amountCents = parseMoney(String(f.get('amount') ?? '')), date = String(f.get('date') ?? ''), note = String(f.get('note') ?? '').trim();
        if (!amountCents) throw new Error('Enter an amount above zero.');
        if (date < journal.openingDate || date > today) throw new Error('Choose a date from your opening balance through today.');
        if (panel === 'contribution' && amountCents > Math.max(0, summary.summary.availableCents)) throw new Error('Recorded savings cannot exceed your available balance.');
        next.entries = [...journal.entries, { id: crypto.randomUUID(), kind: panel, amountCents, date, note, createdAt: now, ...(panel === 'contribution' && journal.version >= 2 && journal.goal ? { goalId: journal.goal.id } : {}) }];
      }
      if (save(next)) {
        if (panel === 'settings') {
          try { autoMemory.configure(settingsAuto, settingsCode.trim(), settingsHabits, settingsRecent, settingsPersonal, settingsRestoring); setOnboardAuto(false); } catch { setError('Settings saved, but automatic Walrus saving could not be changed. Check browser storage.'); return; }
        }
        setNotice('');
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Check the details and try again.'); }
  }

  const backup = <section hidden data-testid="backup-controls" className="simple-section"><h2>Backup and restore</h2><p className="simple-hint">Your journal stays in this browser on this device. Clearing browser data or losing your phone can erase it. Download a backup after making changes and keep it somewhere safe.</p><p className="simple-hint">Anyone who can open this browser can see your journal. Backup files are not encrypted, so anyone with a copy can read them.</p>{journal && <button className="simple-button outline" onClick={exportBackup}>Download backup</button>}<label className="simple-file-label">Restore backup<input type="file" accept=".json,application/json" onChange={event => void restore(event)} /></label></section>;
  const panelForm = journal && panel && <section className="simple-form"><div className="simple-label-row"><h2 id={panel === 'settings' ? 'phone-savings-settings' : undefined}>{({ income: 'Add income', expense: 'Add expense', contribution: 'Add savings', goal: 'Savings goal', 'goal-new': 'Create goal', balance: 'Update balance', settings: 'Savings settings' })[panel]}</h2><button className="simple-link" onClick={() => setPanel(null)}>Cancel</button></div><form onSubmit={submit} key={panel}>
    {(panel === 'goal' || panel === 'goal-new') && <label>Goal name<input name="title" required maxLength={80} defaultValue={panel === 'goal' ? journal.goal?.title ?? '' : ''} /></label>}
    {panel === 'settings' ? <AutoMemoryFields enabled={settingsAuto} onChange={enabled => { setSettingsAuto(enabled); if (enabled && !settingsCode) { setSettingsCode(newMemoryCode()); setSettingsPersonal(true); setSettingsSaved(false); setSettingsRestoring(false); } }} code={settingsCode} onCodeChange={value => { setSettingsCode(value); if (settingsPersonal) setSettingsRestoring(true); }} personal={settingsPersonal} saved={settingsSaved} onSavedChange={setSettingsSaved} habits={settingsHabits} onHabitsChange={setSettingsHabits} recent={settingsRecent} onRecentChange={setSettingsRecent} /> : <label>{(panel === 'goal' || panel === 'goal-new') ? 'Goal target' : 'Amount'} in {journal.currency}<input name="amount" inputMode="decimal" required defaultValue={panel === 'goal' && journal.goal ? (journal.goal.targetCents / 100).toFixed(2) : ''} /></label>}
    {(panel === 'goal' || panel === 'goal-new') && <><label>Target date<input name="date" type="date" min={today} required defaultValue={panel === 'goal' ? journal.goal?.targetDate ?? '' : ''} /></label><p className="simple-hint">Your daily plan includes today and your target date.</p></>}
    {['income', 'expense', 'contribution'].includes(panel) && <><label>Note (optional)<input name="note" maxLength={80} /></label><label>Date<input name="date" type="date" min={journal.openingDate} max={today} defaultValue={today} required /></label></>}
    {panel === 'contribution' && <p className="simple-hint">This records money you set aside. CoinJar does not move money.</p>}<button className="simple-button primary">Save</button></form></section>;
  return <div className="simple-shell hosted-savings phone-app"><header className="simple-header"><span className="simple-brand">coinjar<span>.</span></span>{journal?.nickname && <span className="phone-hello"><span>Hi, {journal.nickname}</span><span className="phone-avatar" aria-hidden="true">{journal.nickname.slice(0, 1)}</span></span>}</header><main className="simple-main">{error && <p className="simple-error" role="alert">{error}</p>}{notice && <p className="simple-notice" role="status">{notice}</p>}
    {!journal ? <><section className="phone-setup">
      <div className="phone-setup-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={3} aria-valuenow={Object.values(setupDone).filter(Boolean).length}>{(['nickname', 'currency', 'amount'] as const).map(key => <span key={key} className={setupDone[key] ? 'done' : undefined} />)}</div>
      <p className="phone-setup-kicker">Let’s set up your jar</p>
      <h1>Your money, your way.</h1>
      <p className="phone-setup-lead">Three quick answers and CoinJar starts coaching you. Your journal stays on this phone.</p>
      <form className="phone-setup-form" onSubmit={setup} onChange={trackSetup}>
        <div className={`phone-step${setupDone.nickname ? ' done' : ''}`}><StepBadge n={1} done={setupDone.nickname} /><div className="phone-step-body"><p className="phone-step-q">What should we call you?</p><label>Nickname<input name="nickname" maxLength={40} autoComplete="nickname" placeholder="e.g. Kle" required /></label></div></div>
        <div className={`phone-step${setupDone.currency ? ' done' : ''}`}><StepBadge n={2} done={setupDone.currency} /><div className="phone-step-body"><p className="phone-step-q">Which currency do you use?</p><label>Currency<select name="currency" required defaultValue=""><option value="" disabled>Choose a currency</option><option value="PHP">Philippine peso (PHP)</option><option value="USD">US dollar (USD)</option></select></label></div></div>
        <div className={`phone-step${setupDone.amount ? ' done' : ''}`}><StepBadge n={3} done={setupDone.amount} /><div className="phone-step-body"><p className="phone-step-q">How much money do you have right now?</p><label>Current balance<input name="amount" inputMode="decimal" placeholder="0.00" required /></label><p className="simple-hint">Your starting point. CoinJar doesn’t connect to your bank.</p></div></div>
        <div className="phone-step optional"><span className="phone-step-badge" aria-hidden="true">+</span><div className="phone-step-body"><p className="phone-step-q">Want CoinJar to remember your habits?</p><fieldset className="simple-memory-settings"><legend>Optional</legend><label className="simple-check"><input type="checkbox" checked={onboardAuto} onChange={event => { const enabled = event.target.checked; setOnboardAuto(enabled); setOnboardSaved(false); if (enabled && !onboardCode) setOnboardCode(newMemoryCode()); }} /> Automatically save preferences</label>{onboardAuto && <><label>Memory access code<input value={onboardCode} readOnly={!onboardExisting} onChange={event => { setOnboardCode(event.target.value.trim()); setOnboardSaved(false); }} autoComplete="off" /></label><button type="button" className="simple-link" onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(onboardCode).then(() => setNotice('Memory code copied.'), () => setNotice('Select the code to copy it.')); else setNotice('Select the code to copy it.'); }}>Copy code</button><button type="button" className="simple-link" onClick={() => { setOnboardExisting(!onboardExisting); setOnboardCode(onboardExisting ? newMemoryCode() : ''); setOnboardSaved(false); }}>{onboardExisting ? 'Generate a new code' : 'Use an existing code'}</button><label className="simple-check"><input type="checkbox" checked={onboardSaved} onChange={event => setOnboardSaved(event.target.checked)} required /> I saved my memory code</label><p className="simple-hint">Keep this code safe. You’ll need it to find your memories on another device.</p><label className="simple-check"><input type="checkbox" checked={onboardHabits || onboardRecent} onChange={event => { setOnboardHabits(event.target.checked); setOnboardRecent(event.target.checked); }} /> Remember spending patterns</label></>}</fieldset></div></div>
        <div className="phone-setup-submit"><button className="simple-button primary">Continue</button></div>
      </form></section>{backup}</> : <>
      <nav className="phone-nav" aria-label="Main navigation">{(['home', 'goals', 'activity', 'profile'] as const).map(item => <button key={item} type="button" aria-current={tab === item ? 'page' : undefined} onClick={() => { setTab(item); setPanel(null); setError(''); }}><NavIcon name={item} />{item === 'home' ? 'Home' : item === 'goals' ? 'Goals' : item === 'activity' ? 'Activity' : 'Profile'}</button>)}</nav>
      {reminderVisible && <section className="simple-section phone-banner" role="status"><p>It’s time to review today’s savings.</p><button type="button" className="simple-button outline" onClick={() => { try { localStorage.setItem('coinjar.phone.reminder.dismissed.v1', today); } catch {} setReminderVisible(false); setTab('home'); }}>Got it</button></section>}
      {tab === 'home' && <>
        {hasRecoveryKey() && <button type="button" className="phone-backup-indicator" onClick={() => setTab('profile')}>{backupStatus === 'Journal backed up to Walrus.' ? 'Journal backed up' : /paused|not confirmed|unavailable|not set up/i.test(backupStatus) ? 'Backup needs attention' : 'Checking backup…'}</button>}
        {!hasRecoveryKey() && <section className="simple-section phone-banner"><p>Set up a recovery key to automatically back up your journal.</p><button className="simple-button outline" onClick={() => setTab('profile')}>Set up recovery</button></section>}
        {autoMemory.config.restorePending && <p className="simple-hint" role="status">Review your saved preferences in Profile before syncing.</p>}
        <section className="simple-section phone-hero">
          <div className="phone-today"><h3>Daily savings suggestion</h3>{!goal ? <p className="simple-hint">Create a goal to see your daily suggestion.</p> : savedToday > 0 ? <p className="phone-today-value phone-saved-today" style={{ '--saved-length': savedTodayText.length } as React.CSSProperties}>{savedTodayText}</p> : !summary!.summary.remainingCents ? <p className="phone-today-value">Goal reached!</p> : summary!.recommendation.amountCents === 0 ? <p className="phone-today-value">No savings suggested today</p> : <p className="phone-today-value">Save {money(summary!.recommendation.amountCents)} today!</p>}</div>
          <button className="simple-button phone-save-button" onClick={() => setPanel('contribution')}>Add savings</button>
          {goal && <><div className="phone-tomorrow"><p className="phone-tomorrow-amount">Tomorrow, consider saving around <strong>{money(tomorrow!.recommendation.amountCents)}</strong>.</p><button type="button" className="phone-explain-button" onClick={() => explanation.current?.showModal()}>How is this calculated?</button></div><dialog ref={explanation} className="phone-explanation" aria-labelledby="explanation-title"><h2 id="explanation-title">Savings insights</h2><p>Suggestions use your goal, time remaining, recorded balance and available spending patterns. They can change when you add an entry.</p><h3>Today</h3>{summary!.recommendation.reasons.map(reason => <p key={reason}>{reason}</p>)}<h3>Tomorrow</h3>{tomorrow!.recommendation.reasons.map(reason => <p key={reason}>{reason}</p>)}{Boolean(habit.remembered?.days.length) && <p>Walrus remembers your spending patterns across the week.</p>}{recent.remembered && <p>Walrus remembers a recent spending increase.</p>}{habitStatuses.map(status => <p key={status} role="status">{status}</p>)}<form method="dialog"><button className="simple-button primary">Close</button></form></dialog></>}
        </section>
        {panel === 'contribution' && panelForm}
        <section className="simple-balance phone-card"><div className="simple-label-row"><h1>Balance</h1><button className="simple-link" onClick={() => setPanel('balance')}>Update balance</button></div><p className="simple-amount">{money(summary!.summary.availableCents)}</p><div className="simple-actions"><button className="simple-button primary" onClick={() => setPanel('expense')}>Add expense</button><button className="simple-button outline" onClick={() => setPanel('income')}>Add income</button></div></section>
        {(panel === 'expense' || panel === 'income' || panel === 'balance') && panelForm}
        <section className="simple-section phone-card phone-goal"><div className="simple-label-row"><h2>Savings goal</h2>{goal && <button className="simple-link" onClick={() => setPanel('goal')}>Edit goal</button>}</div>{goal ? <><p className="simple-jar-amount">{goal.title}</p><div className="phone-progress" role="progressbar" aria-label="Goal progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}><span style={{ width: `${progress * 100}%` }} /></div><p className="simple-hint">{money(summary!.summary.savedCents)} saved of {money(goal.targetCents)} · {Math.round(summary!.summary.progress * 100)}%</p>{daysLeft !== null && <p className={`phone-goal-meta${daysLeft < 1 ? ' late' : ''}`}>{daysLeft > 1 ? `${daysLeft} days left` : daysLeft === 1 ? 'Last day' : 'Target date passed'}</p>}{summary!.summary.remainingCents > 0 && daysLeft !== null && daysLeft > 0 && <p className="simple-hint">{savedToday > 0 && daysLeft === 1 ? 'Your target date is today and the goal is not yet complete.' : savedToday > 0 ? `Tomorrow’s goal pace: ${money(tomorrow!.recommendation.baselineCents)} per day.` : `Goal pace: ${money(summary!.recommendation.baselineCents)} per day.`}{!(savedToday > 0 && daysLeft === 1) && (savedToday > 0 ? tomorrow!.recommendation.amountCents < tomorrow!.recommendation.baselineCents : summary!.recommendation.amountCents < summary!.recommendation.baselineCents) && ' Your suggested amount is below this pace based on your recorded balance and spending.'}</p>}</> : <><p className="simple-empty">Create your first savings goal.</p><div className="simple-actions goal-actions"><button className="simple-button primary" onClick={() => setPanel('goal')}>Create goal</button></div></>}</section>
        {panel === 'goal' && panelForm}
        {goal && <PhoneWallet mode="goal" code={autoMemory.config.code} personal={autoMemory.config.enabled && autoMemory.config.personal} address={walletAddress} goalId={goal.id} openProfile={() => setTab('profile')} />}
      </>}
      {tab === 'goals' && <><section className="simple-section phone-goals"><h1>Goals</h1>{goal ? <div className="phone-goal-list">{[goal, ...(journal.otherGoals ?? [])].map(item => { const saved = goalSaved(journal, item.id, today); const percent = item.targetCents ? Math.min(100, Math.round(saved / item.targetCents * 100)) : 0; return <div className="phone-goal-item" key={item.id}><div className="simple-label-row"><h2>{item.title}</h2>{item.id === goal.id && <span className="phone-chip on">Active</span>}</div><p className="simple-hint">{money(saved)} saved of {money(item.targetCents)} · {percent}%</p><div className="phone-progress" role="progressbar" aria-label={`${item.title} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>{item.targetDate && <p className="simple-hint">Target: {item.targetDate}</p>}{item.id !== goal.id && <button type="button" className="simple-button outline" onClick={() => { const next = upgradeGoals(journal); save({ ...next, goal: item, otherGoals: [next.goal!, ...next.otherGoals!.filter(g => g.id !== item.id)] }); }}>Save for this goal</button>}</div>; })}</div> : <p className="simple-empty">Create your first savings goal.</p>}<button type="button" className="simple-button primary phone-create-goal" onClick={() => setPanel('goal-new')}>Create goal</button></section>{panel === 'goal-new' && panelForm}</>}
      {tab === 'activity' && <ActivityList journal={journal} today={today} money={money} />}
      {tab === 'profile' && <><section className="simple-section phone-profile"><span className="phone-avatar large" aria-hidden="true">{(journal.nickname || 'C').slice(0, 1)}</span><div><h1>{journal.nickname || 'Your profile'}</h1><p className="simple-hint">Saving in {journal.currency} · since {journal.openingDate}</p></div></section><section className="simple-section"><h2>Daily reminder</h2><label className="simple-check"><input type="checkbox" checked={reminders} onChange={event => { try { if (event.target.checked) localStorage.setItem('coinjar.phone.reminder.enabled.v1', '1'); else localStorage.removeItem('coinjar.phone.reminder.enabled.v1'); setReminders(event.target.checked); } catch { setError('Could not save reminder settings on this device.'); } }} /> Remind me at 8 PM</label><p className="simple-hint">Appears in CoinJar while it is open. No notification is sent when the app is closed.</p></section><section className="simple-section profile-settings"><div className="phone-card-head"><h2>Memory settings</h2><span className={`phone-chip${autoMemory.config.enabled ? ' on' : ''}`}>{autoMemory.config.enabled ? 'On' : 'Off'}</span></div><p className="simple-hint">Choose how CoinJar remembers your spending patterns.</p><button className="simple-button outline" onClick={() => { setSettingsAuto(autoMemory.config.enabled); setSettingsHabits(autoMemory.config.habits); setSettingsRecent(autoMemory.config.recentHabits); setSettingsCode(autoMemory.config.code); setSettingsPersonal(autoMemory.config.personal || !autoMemory.config.enabled); setSettingsSaved(autoMemory.config.enabled); setSettingsRestoring(autoMemory.config.restorePending); setPanel('settings'); }}>Savings settings</button>{autoMemory.status && <p className="simple-hint" role="status">{autoMemory.status}</p>}{panel === 'settings' && panelForm}</section></>}<div hidden={tab !== 'profile'}><PhoneRecovery journal={journal} memoryCode={autoMemory.config.code} apply={value => save(value)} onStatusChange={setBackupStatus} /></div>{tab === 'profile' && <><PhoneWallet mode="profile" code={autoMemory.config.code} address={walletAddress} link={linkWallet} /><details className="simple-section" open={memoryToolsOpen || autoMemory.config.restorePending} onToggle={event => setMemoryToolsOpen(event.currentTarget.open)}><summary>Restore preferences</summary><PhoneWalrus journal={journal} apply={value => { const applied = save(value); if (applied && autoMemory.config.restorePending) autoMemory.finishRecovery(); return applied; }} personal={autoMemory.config.personal} savedCode={autoMemory.config.code} /></details></>}{backup}</>}
  </main></div>;
}

type Entry = PhoneJournal['entries'][number];
const KIND_LABEL: Record<Entry['kind'], string> = { income: 'Income', expense: 'Expense', contribution: 'Recorded saving', withdrawal: 'Savings withdrawal' };
const addsToBalance = (kind: Entry['kind']) => kind === 'income' || kind === 'withdrawal';
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

function dayLabel(date: string, today: string) {
  const diff = Math.round((dayMs(today) - dayMs(date)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(dayMs(date)));
}

function entryRecordedAt(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return 'Recorded time unavailable';
  return `Recorded ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))}`;
}

function ActivityList({ journal, today, money }: { journal: PhoneJournal; today: string; money: (cents: number) => string }) {
  const entries = journal.entries.filter(entry => !entry.voidedAt).reverse();
  if (!entries.length) return <section className="simple-section phone-activity"><h1>Recent activity</h1><div className="phone-activity-empty"><EntryIcon kind="contribution" /><p className="simple-empty">Your activity will appear here. Add income, an expense or savings from Home.</p></div></section>;
  const weekStart = dayMs(today) - 6 * 86400000;
  const week = { income: 0, expense: 0, contribution: 0 };
  for (const entry of entries) if (!entry.voidedAt && dayMs(entry.date) >= weekStart && entry.date <= today) {
    if (entry.kind === 'withdrawal') week.contribution -= entry.amountCents; else week[entry.kind] += entry.amountCents;
  }
  const days = [...new Set(entries.map(entry => entry.date))].sort().reverse();
  return <section className="simple-section phone-activity"><h1>Recent activity</h1>
    <div className="phone-week" aria-label="Last 7 days"><p className="phone-week-title">Last 7 days</p><div className="phone-week-stats">
      <div><small>Money in</small><strong>{money(week.income)}</strong></div>
      <div><small>Money out</small><strong>{money(week.expense)}</strong></div>
      <div className="saved"><small>Saved</small><strong>{money(week.contribution)}</strong></div>
    </div></div>
    {days.map(date => {
      const items = entries.filter(entry => entry.date === date);
      return <div className="phone-day" key={date}><div className="phone-day-head"><h2>{dayLabel(date, today)}</h2><span>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(dayMs(date)))}</span></div>
        <div className="phone-day-list">{items.map(entry => <div className={`simple-row phone-entry ${entry.kind}`} key={entry.id}><EntryIcon kind={entry.kind} /><div className="phone-entry-text"><strong>{entry.note || KIND_LABEL[entry.kind]}</strong>{entry.note && <small>{KIND_LABEL[entry.kind]}</small>}<small>{entryRecordedAt(entry.createdAt)}</small></div><strong className="phone-entry-amount">{addsToBalance(entry.kind) ? '+' : entry.kind === 'expense' ? '−' : ''}{money(entry.amountCents)}</strong></div>)}</div>
      </div>;
    })}
  </section>;
}

function EntryIcon({ kind }: { kind: Entry['kind'] }) {
  const path = addsToBalance(kind) ?'M17 7 7 17M7 9v8h8' : kind === 'expense' ? 'M7 17 17 7M9 7h8v8' : 'M6 9h12v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM8 9V6h8v3M12 12v5';
  return <span className={`phone-entry-icon ${kind}`} aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg></span>;
}

function StepBadge({ n, done }: { n: number; done: boolean }) {
  return <span className="phone-step-badge" aria-hidden="true">{done ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg> : n}</span>;
}

function NavIcon({ name }: { name: 'home' | 'goals' | 'activity' | 'profile' }) {
  const paths = { goals: 'M12 3 14.5 8.5 20.5 9.2 16 13.4 17 19.5 12 16.5 7 19.5 8 13.4 3.5 9.2 9.5 8.5z', home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z', activity: 'M4 6h16M4 12h16M4 18h10', profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7.5 8.5a7.5 7.5 0 0 1 15 0' };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function AutoMemoryFields({ enabled, onChange, code, onCodeChange, personal, saved, onSavedChange, habits, onHabitsChange, recent, onRecentChange }: { enabled: boolean; onChange: (value: boolean) => void; code: string; onCodeChange: (value: string) => void; personal: boolean; saved: boolean; onSavedChange: (value: boolean) => void; habits: boolean; onHabitsChange: (value: boolean) => void; recent: boolean; onRecentChange: (value: boolean) => void }) {
  return <fieldset className="simple-memory-settings"><legend>Optional</legend><label className="simple-check"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked)} /> Automatically save preferences</label>{enabled && <><label>Walrus access code<input name="walrusCode" type={personal ? 'text' : 'password'} autoComplete="off" required value={code} onChange={event => { onCodeChange(event.target.value.trim()); if (personal) onSavedChange(false); }} /></label>{personal && <><button type="button" className="simple-link" onClick={() => { if (navigator.clipboard) void navigator.clipboard.writeText(code); }}>Copy code</button><label className="simple-check"><input type="checkbox" checked={saved} onChange={event => onSavedChange(event.target.checked)} required /> I saved my memory code</label></>}<label className="simple-check"><input type="checkbox" checked={habits || recent} onChange={event => { onHabitsChange(event.target.checked); onRecentChange(event.target.checked); }} /> Remember spending patterns</label><p className="simple-hint">Includes spending increases and patterns on any day of the week. Amounts and notes stay on your phone.</p></>}</fieldset>;
}
