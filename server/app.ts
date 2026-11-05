import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import { isValidPersonalMessageSignature } from '@mysten/sui/verify';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { ClientWithCoreApi } from '@mysten/sui/client';
import { suiToPhpCentavos } from '../src/sui';
import { USDC_TYPES, usdcToPhpCentavos } from '../src/usdc';
import {
  createDemoState,
  createInitialState,
  getSummary,
  detectInsights,
  scheduleOccurrences,
  simpleSavingsAdvice,
  validateDate,
  type AppState,
  type Memory,
  type Preferences,
  type Schedule,
} from '../src/domain';
import { createMemoryAdapter } from './integrations/walrus.js';
import { createTatumAdapter } from './integrations/tatum.js';
import {
  createFxAdapter,
  phpCentavosToUsdMicrodollars,
} from './integrations/fx.js';

type MemoryAdapter = {
  remember(text: string): Promise<unknown>;
  search(query: string, limit?: number): Promise<unknown>;
};
type BalanceAdapter = { getBalance(address: string, coinType?: string): Promise<unknown>; getTransaction?(digest: string): Promise<unknown> };
type FxRate = {
  value: string;
  basePair: 'USD';
  symbol: 'PHP';
  timestamp: number;
  source: string;
};
type FxAdapter = { getRate(): Promise<FxRate>; getSuiPhpRate?(): Promise<{ value: string; basePair: 'PHP'; symbol: 'SUI'; timestamp: number; source: string }> };
type Options = {
  dbPath?: string;
  now?: () => Date;
  memory?: MemoryAdapter;
  balance?: BalanceAdapter;
  fx?: FxAdapter;
  env?: NodeJS.ProcessEnv;
  staticDir?: string;
  configFile?: string;
  walletClient?: ClientWithCoreApi;
};
class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(message: string, status = 400): never {
  throw new RequestError(status, message);
}
const MAX_CENTS = 100_000_000_00;
function money(value: unknown, label: string, min = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > MAX_CENTS
  )
    fail(`${label} must be whole cents between ${min} and ${MAX_CENTS}.`);
  return value;
}
function text(value: unknown, label: string, max = 160): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    fail(`${label} must be 1 to ${max} characters.`);
  return value.trim();
}
function preferences(
  body: Record<string, unknown>,
  currency: Preferences['currency'],
): Preferences {
  if (!['gentle', 'steady', 'focused'].includes(String(body.pace)))
    fail('Choose a valid savings pace.');
  return {
    bufferCents: money(body.bufferCents, 'Cash buffer'),
    dailyLimitCents: money(body.dailyLimitCents, 'Daily limit'),
    pace: body.pace as Preferences['pace'],
    currency,
  };
}
function safeObservations(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length <= 20 && value.every((item) =>
    typeof item === 'string' && item.length <= 160 && !/[\u0000-\u001f]/.test(item))
    ? value : undefined;
}
function scheduleInput(body: Record<string, unknown>, startDate: string): Schedule {
  if (!['income', 'expense'].includes(String(body.kind))) fail('Choose income or expense.');
  if (!Array.isArray(body.days) || !body.days.length || body.days.length > 31 || body.days.some((n) => !Number.isInteger(n) || n < 1 || n > 31) || new Set(body.days).size !== body.days.length) fail('Choose distinct monthly days from 1 to 31.');
  return { id: randomUUID(), kind: body.kind as Schedule['kind'], title: text(body.title, 'Schedule name', 80), amountCents: money(body.amountCents, 'Scheduled amount', 1), days: (body.days as number[]).slice().sort((a, b) => a - b), startDate };
}
export function localDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((p) => p.type === type)!.value)
    .join('-');
}
async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    fail('Send JSON data.', 415);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) fail('Request is too large.', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object')
      fail('Send a JSON object.');
    return body;
  } catch {
    return fail('Invalid JSON request.');
  }
}
function equalToken(value: unknown, expected: string): boolean {
  return (
    typeof value === 'string' &&
    value.length === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}
function recallRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value))
    return value.filter((x) => x && typeof x === 'object');
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    for (const key of ['memories', 'results', 'matches'])
      if (Array.isArray(row[key])) return recallRows(row[key]);
  }
  return [];
}

export function createApp(options: Options = {}) {
  const env = options.env ?? process.env,
    now = options.now ?? (() => new Date());
  const dbPath = options.dbPath ?? env.COINJAR_DB ?? '.data/coinjar-php.sqlite';
  if (dbPath !== ':memory:')
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memory_sync (id TEXT PRIMARY KEY, status TEXT NOT NULL, remote_id TEXT);',
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS suppressed_memories (remote_id TEXT PRIMARY KEY)',
  );
  db.prepare("UPDATE memory_sync SET status='not_sent' WHERE status='pending'").run();
  db.prepare('INSERT OR IGNORE INTO app_state VALUES (1, ?)').run(
    JSON.stringify(createInitialState(localDate(now()))),
  );
  const token = randomUUID(),
    today = () => localDate(now());
  const walletChallenges = new Map<string, { address: string; message: string; expires: number }>();
  const walletSessions = new Map<string, { address: string; expires: number }>();
  if (env.COINJAR_OWNER_ADDRESS && !/^0x[0-9a-fA-F]{64}$/.test(env.COINJAR_OWNER_ADDRESS)) throw new Error('Invalid configured owner address');
  const configuredOwner = env.COINJAR_OWNER_ADDRESS ? normalizeSuiAddress(env.COINJAR_OWNER_ADDRESS) : undefined;
  if (env.SUI_NETWORK && !['mainnet', 'testnet'].includes(env.SUI_NETWORK)) throw new Error('Unsupported Sui network');
  const config = {
    walrusConfigured: Boolean(
      options.memory || (env.MEMWAL_PRIVATE_KEY && env.MEMWAL_ACCOUNT_ID),
    ),
    tatumConfigured: Boolean(options.balance || env.TATUM_API_KEY),
    fxConfigured: Boolean(options.fx || env.TATUM_API_KEY),
    localOnly: true as const,
    demoMode: env.COINJAR_MODE === 'demo',
    suiNetwork: env.SUI_NETWORK === 'testnet' ? 'testnet' as const : 'mainnet' as const,
  };
  const read = (): AppState =>
    JSON.parse(
      (
        db.prepare('SELECT json FROM app_state WHERE id=1').get() as {
          json: string;
        }
      ).json,
    );
  const save = (state: AppState) =>
    db
      .prepare('UPDATE app_state SET json=? WHERE id=1')
      .run(JSON.stringify(state));
  function mutate(action: (state: AppState) => void) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const state = read();
      action(state);
      if (getSummary(state, today()).savedCents < 0) fail('The savings jar cannot be negative.', 409);
      save(state);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function remember(state: AppState, content: string, kind: Memory['kind']) {
    const id = randomUUID();
    state.memories.push({
      id,
      text: content,
      kind,
      approved: kind !== 'observation',
      createdAt: now().toISOString(),
      source: 'local',
    });
    return id;
  }
  const autoInFlight = new Set<string>();
  const payload = () => {
    const state = read();
    for (const item of state.memories.filter((m) => m.autoSyncRequested || m.summarySyncRequested)) {
      const row = db.prepare('SELECT status FROM memory_sync WHERE id=?').get(item.id) as { status: Memory['syncStatus'] } | undefined;
      item.syncStatus = row?.status === 'unknown' && autoInFlight.has(item.id) ? 'syncing' : row?.status;
    }
    return { state, today: today(), config, csrfToken: token };
  };
  let memoryClient: Promise<MemoryAdapter> | undefined,
    balanceClient: Promise<BalanceAdapter> | undefined;
  async function rateFor(state: AppState): Promise<FxRate | undefined> {
    if (state.preferences.currency === 'USD') return undefined;
    if (!config.fxConfigured) return undefined;
    try {
      const rate = await (
        options.fx ??
        createFxAdapter({
          apiKey: env.TATUM_API_KEY,
          now: () => now().getTime(),
        })
      ).getRate();
      if (
        !rate ||
        rate.basePair !== 'USD' ||
        rate.symbol !== 'PHP' ||
        typeof rate.value !== 'string' ||
        !/^\d+(?:\.\d+)?$/.test(rate.value) ||
        !Number.isFinite(rate.timestamp) ||
        rate.timestamp > now().getTime() ||
        now().getTime() - rate.timestamp > 86400000 ||
        !rate.source
      )
        throw new Error('Invalid rate');
      phpCentavosToUsdMicrodollars('1', rate.value);
      return rate;
    } catch {
      return undefined;
    }
  }
  const valuation = (amount: number, rate?: FxRate) =>
    rate
      ? {
          usdMicrodollars: phpCentavosToUsdMicrodollars(
            String(amount),
            rate.value,
          ),
          rate,
        }
      : undefined;
  let estimateRate: { rate: FxRate; fetchedAt: number } | undefined;
  let estimateRequest: Promise<typeof estimateRate> | undefined;
  async function hourlyEstimateRate() {
    if (estimateRate && now().getTime() - estimateRate.fetchedAt < 3600000 && now().getTime() - estimateRate.rate.timestamp <= 86400000) return estimateRate;
    if (!estimateRequest) estimateRequest = rateFor(read()).then((rate) => {
      if (rate) estimateRate = { rate, fetchedAt: now().getTime() };
      return rate ? estimateRate : undefined;
    }).finally(() => { estimateRequest = undefined; });
    return estimateRequest;
  }
  const memory = () => {
    if (!config.walrusConfigured)
      fail(
        'Walrus Memory is not configured. Set the server-side account and delegate key.',
        503,
      );
    return (memoryClient ??= options.memory
      ? Promise.resolve(options.memory)
      : createMemoryAdapter({
          key: env.MEMWAL_PRIVATE_KEY,
          accountId: env.MEMWAL_ACCOUNT_ID,
          serverUrl:
            env.MEMWAL_SERVER_URL ?? 'https://relayer.memory.walrus.xyz',
          namespace: env.MEMWAL_NAMESPACE ?? 'coinjar-php',
        }));
  };
  const balance = () => {
    if (!config.tatumConfigured)
      fail('Tatum is not configured. Set TATUM_API_KEY on the server.', 503);
    return (balanceClient ??= options.balance
      ? Promise.resolve(options.balance)
      : createTatumAdapter({
          apiKey: env.TATUM_API_KEY,
          network: config.suiNetwork,
        }));
  };
  async function suiQuote() {
    if (config.suiNetwork !== 'mainnet') fail('Testnet SUI has no market value.', 400);
    if (!config.fxConfigured) fail('Configure Tatum for a SUI price quote.', 503);
    const provider = options.fx ?? createFxAdapter({ apiKey: env.TATUM_API_KEY, now: () => now().getTime() });
    if (!provider.getSuiPhpRate) fail('SUI price is unavailable.', 503);
    const quote = await provider.getSuiPhpRate();
    if (!quote || quote.basePair !== 'PHP' || quote.symbol !== 'SUI' || typeof quote.value !== 'string' || quote.value.length > 64 || !/^\d+(?:\.\d+)?$/.test(quote.value) || !/[1-9]/.test(quote.value) || !Number.isSafeInteger(quote.timestamp) || quote.timestamp > now().getTime() || now().getTime() - quote.timestamp > 600000 || typeof quote.source !== 'string' || !quote.source.trim() || quote.source.length > 80 || /[\u0000-\u001f]/.test(quote.source)) fail('SUI price is stale or invalid.', 503);
    return quote;
  }
  async function transferValuation(transfer: NonNullable<AppState['onchainTransfers']>[number]) {
    if (transfer.asset === 'USDC') {
      const quote = await rateFor(read());
      if (!quote || !transfer.amountMicroUsdc) throw new Error('Rate unavailable');
      return { centavos: usdcToPhpCentavos(transfer.amountMicroUsdc, quote.value), rate: quote.value, timestamp: quote.timestamp, source: quote.source };
    }
    if (!transfer.amountMist) throw new Error('Amount unavailable');
    const quote = await suiQuote();
    return { centavos: suiToPhpCentavos(transfer.amountMist, quote.value), rate: quote.value, timestamp: quote.timestamp, source: quote.source };
  }
  let syncing = false;
  let automaticQueue: Promise<void> = Promise.resolve();
  async function uploadMemory(item: Memory, client: MemoryAdapter) {
    // shortcut: single-owner sync, use a durable job worker before multi-user hosting.
    db.prepare('INSERT INTO memory_sync (id,status) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status').run(item.id, 'unknown');
    const result = (await client.remember(item.text)) as Record<string, unknown> | string;
    const remoteId = typeof result === 'string' ? result : String(result?.blobId ?? result?.blob_id ?? result?.id ?? '');
    if (!remoteId) throw new Error('Memory storage did not return an identifier.');
    mutate((current) => {
      const target = current.memories.find((m) => m.id === item.id);
      if (target) target.remoteId = remoteId;
      else db.prepare('INSERT OR IGNORE INTO suppressed_memories (remote_id) VALUES (?)').run(remoteId);
      db.prepare('UPDATE memory_sync SET status=?,remote_id=? WHERE id=?').run('stored', remoteId, item.id);
    });
  }
  async function autoUpload(id: string) {
    if (syncing) {
      db.prepare("UPDATE memory_sync SET status='not_sent' WHERE id=? AND status='pending'").run(id);
      return;
    }
    syncing = true;
    autoInFlight.add(id);
    try {
      const client = await memory();
      const state = read();
      const item = state.memories.find((m) => m.id === id);
      if (!item || (item.summarySyncRequested ? !state.summarySync?.enabled : !state.autoMemorySync) || item.remoteId) {
        db.prepare("UPDATE memory_sync SET status='not_sent' WHERE id=? AND status='pending'").run(id);
        return;
      }
      await uploadMemory(item, client);
    } catch {
      db.prepare("UPDATE memory_sync SET status='not_sent' WHERE id=? AND status='pending'").run(id);
    } finally {
      autoInFlight.delete(id);
      syncing = false;
    }
  }
  function runAutomations() {
    const queuedIds: string[] = [];
    mutate((state) => {
      const date = today();
      for (const occurrence of scheduleOccurrences(state, date).filter((item) => item.schedule.autoRecord && item.schedule.kind === 'income' && item.date <= date)) {
        if (state.entries.some((entry) => entry.scheduleId === occurrence.schedule.id && entry.occurrenceDate === occurrence.date && entry.scheduleDay === occurrence.scheduledDay)) continue;
        if (state.entries.length >= 10000) fail('Journal limit reached.', 409);
        state.entries.push({ id: randomUUID(), kind: 'income', amountCents: occurrence.schedule.amountCents, note: occurrence.schedule.title, date: occurrence.date, createdAt: now().toISOString(), scheduleId: occurrence.schedule.id, occurrenceDate: occurrence.date, scheduleDay: occurrence.scheduledDay });
      }
      const setting = state.autoSavings;
      if (setting && setting.startDate <= date && !state.entries.some((entry) => entry.autoSavingsDate === date) && !state.savingsPauses?.some((item) => item.date === date)) {
        const amountCents = simpleSavingsAdvice(state, date).amountCents;
        if (amountCents > 0) {
          if (state.entries.length >= 10000) fail('Journal limit reached.', 409);
          state.entries.push({ id: randomUUID(), kind: 'contribution', amountCents, note: 'Automatic jar savings', date, createdAt: now().toISOString(), autoSavingsDate: date });
        }
      }
      if (state.summarySync?.enabled && state.summarySync.lastDate !== date) {
        const summary = getSummary(state, date);
        const month = date.slice(0, 7);
        const entries = state.entries.filter((entry) => !entry.voidedAt && entry.date.startsWith(month) && entry.date <= date);
        const totals = { income: entries.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amountCents, 0), expenses: entries.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amountCents, 0) };
        if (!Number.isSafeInteger(totals.income) || !Number.isSafeInteger(totals.expenses)) fail('Summary is too large.');
        const summaryId = randomUUID();
        state.memories.push({ id: summaryId, text: `COINJAR_DAILY_SUMMARY_V1 ${JSON.stringify({ date, currency: state.preferences.currency, availableCents: summary.availableCents, savedCents: summary.savedCents, monthlyIncomeCents: totals.income, monthlyExpenseCents: totals.expenses })}`, kind: 'observation', source: 'local', approved: true, summarySyncRequested: true, createdAt: now().toISOString() });
        state.summarySync.lastDate = date;
        db.prepare('INSERT INTO memory_sync (id,status) VALUES (?,?)').run(summaryId, 'pending');
        queuedIds.push(summaryId);
      }
      const advice = simpleSavingsAdvice(state, date);
      if (state.summarySync?.enabled && 'learnedDailyCents' in advice && advice.learnedDailyCents !== undefined && (!state.lastLearningDate || Date.parse(`${date}T00:00:00Z`) - Date.parse(`${state.lastLearningDate}T00:00:00Z`) >= 7 * 86400000)) {
        const id = randomUUID();
        const pattern = { savedAt: now().toISOString(), currency: state.preferences.currency, dailyCents: advice.learnedDailyCents, expenseDays: advice.expenseDays, periodDays: advice.periodDays };
        state.memories.push({ id, text: `COINJAR_SPENDING_PATTERN_V1 ${JSON.stringify(pattern)}`, kind: 'observation', source: 'local', approved: true, summarySyncRequested: true, createdAt: now().toISOString() });
        state.lastLearningDate = date;
        db.prepare('INSERT INTO memory_sync (id,status) VALUES (?,?)').run(id, 'pending');
        queuedIds.push(id);
      }
    });
    for (const id of queuedIds) automaticQueue = automaticQueue.then(() => autoUpload(id));
  }
  let lastRecall = '';
  let recallJob: Promise<void> | undefined;
  function recallLearning(): Promise<void> {
    const date = today();
    if (recallJob) return recallJob;
    if (lastRecall === date || !read().summarySync?.enabled || !config.walrusConfigured) return Promise.resolve();
    lastRecall = date;
    recallJob = (async () => { try {
      const client = await memory();
      const [result, habitResult] = await Promise.all([client.search('COINJAR_SPENDING_PATTERN_V1 spending pattern savings', 30), client.search('COINJAR_HABIT_V1 COINJAR_WEEKEND_SIGNAL_V1 weekend saving', 30)]);
      if (result && typeof result === 'object' && 'dropped_count' in result && Number(result.dropped_count) > 0) return;
      const candidates = recallRows(result).flatMap((row) => {
        const remoteId = String(row.blob_id ?? row.blobId ?? row.id ?? '');
        const content = String(row.text ?? row.content ?? '');
        if (!remoteId || !content.startsWith('COINJAR_SPENDING_PATTERN_V1 ') || db.prepare('SELECT remote_id FROM suppressed_memories WHERE remote_id=?').get(remoteId)) return [];
        try {
          const pattern = JSON.parse(content.slice('COINJAR_SPENDING_PATTERN_V1 '.length));
          const age = now().getTime() - Date.parse(pattern.savedAt);
          if (!Number.isFinite(age) || age < 0 || age > 30 * 86400000 || !Number.isSafeInteger(pattern.dailyCents) || pattern.dailyCents < 0 || pattern.dailyCents > MAX_CENTS || !Number.isInteger(pattern.expenseDays) || pattern.expenseDays < 3 || pattern.expenseDays > 30 || !Number.isInteger(pattern.periodDays) || pattern.periodDays < 7 || pattern.periodDays > 30 || !['PHP', 'USD'].includes(pattern.currency)) return [];
          return [{ ...pattern, remoteId }];
        } catch { return []; }
      }).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
      const latest = candidates[0];
      if (latest) mutate((state) => { if (state.summarySync?.enabled && latest.currency === state.preferences.currency) state.learnedBudget = { dailyCents: latest.dailyCents, savedAt: latest.savedAt, currency: latest.currency, remoteId: latest.remoteId }; });
      if (!(habitResult && typeof habitResult === 'object' && 'dropped_count' in habitResult && Number(habitResult.dropped_count) > 0)) {
        const habits = recallRows(habitResult).flatMap((row) => {
          const remoteId = String(row.blob_id ?? row.blobId ?? row.id ?? '');
          const content = String(row.text ?? row.content ?? '');
          if (!remoteId || db.prepare('SELECT remote_id FROM suppressed_memories WHERE remote_id=?').get(remoteId)) return [];
          const signal = content.startsWith('COINJAR_WEEKEND_SIGNAL_V1 ');
          const prefix = signal ? 'COINJAR_WEEKEND_SIGNAL_V1 ' : 'COINJAR_HABIT_V1 ';
          if (!content.startsWith(prefix)) return [];
          try {
            const item = JSON.parse(content.slice(prefix.length));
            const age = now().getTime() - Date.parse(item.savedAt);
            if (!Number.isFinite(age) || age < 0 || age > 90 * 86400000 || (signal ? !Number.isSafeInteger(item.count) || item.count < 3 || item.count > 10000 : item.type !== 'higher-weekend-spending')) return [];
            return [{ savedAt: item.savedAt as string, signal, remoteId }];
          } catch { return []; }
        }).sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
        if (habits.length) mutate((state) => {
          if (!state.summarySync?.enabled) return;
          if (habits.some((item) => item.signal)) state.weekendSignal = true;
          const confirmed = habits.find((item) => !item.signal);
          if (confirmed && (!state.weekendPreferenceChangedAt || Date.parse(confirmed.savedAt) > Date.parse(state.weekendPreferenceChangedAt)) && !state.insightReviews?.some((review) => review.id === 'higher-weekend-spending' && review.status === 'dismissed')) {
            state.rememberedWeekendSpending = true;
            state.weekendProvenance = { restored: true, remoteId: confirmed.remoteId };
          }
        });
      }
    } catch { /* Local recommendations continue when recall is unavailable. */ }
    finally { recallJob = undefined; } })();
    return recallJob;
  }
  const automationTimer = setInterval(() => { void recallLearning().then(() => runAutomations()).catch(() => { /* State remains unchanged; the next request reports the issue. */ }); }, 60000);
  automationTimer.unref();
  function json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://fullnode.mainnet.sui.io https://fullnode.testnet.sui.io https://api.slush.app https://my.slush.app; frame-src https://my.slush.app; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
        fail('This demo only accepts localhost requests.', 403);
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (
          !['127.0.0.1', 'localhost'].includes(origin.hostname) ||
          !['http:', 'https:'].includes(origin.protocol)
        )
          fail('Untrusted request origin.', 403);
      }
      const path = new URL(req.url ?? '/', `http://${host}`).pathname;
      const sessionId = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith('coinjar_session='))?.slice('coinjar_session='.length);
      const session = sessionId ? walletSessions.get(sessionId) : undefined;
      const sessionAddress = session && session.expires > now().getTime() ? session.address : undefined;
      const profile = read().simpleProfile;
      if (configuredOwner && profile?.walletAddress && configuredOwner !== profile.walletAddress) fail('Configured wallet does not match this journal.', 403);
      const owner = configuredOwner ?? profile?.walletAddress;
      const locked = Boolean(!config.demoMode && owner && sessionAddress !== owner);
      if (req.method === 'GET' && path === '/api/session') return json(res, 200, { locked, hasProfile: Boolean(profile), csrfToken: token, config });
      if (locked && path.startsWith('/api/') && !['/api/health', '/api/simple/wallet/challenge', '/api/simple/wallet/verify'].includes(path)) fail('Connect your wallet to unlock CoinJar.', 401);
      if (req.method === 'GET' && path === '/api/state') {
        await recallLearning();
        runAutomations();
        return json(res, 200, { ...payload(), setupWalletVerified: Boolean(configuredOwner && sessionAddress) });
      }
      if (req.method === 'GET' && path === '/api/health')
        return json(res, 200, {
          ok: true,
          mode: 'local-single-user',
          ...config,
        });
      if (path.startsWith('/api/')) {
        if (req.method !== 'POST') fail('Route not found.', 404);
        if (!equalToken(req.headers['x-coinjar-token'], token))
          fail('Session changed. Reload CoinJar and try again.', 403);
        const body = await bodyOf(req);
        if (path === '/api/fx/estimate') {
          const quote = await hourlyEstimateRate();
          if (!quote) fail('Exchange rate unavailable.', 503);
          return json(res, 200, quote);
        } else if (path === '/api/setup/tatum') {
          if (!options.configFile)
            fail('Credential setup is disabled for this instance.', 403);
          if (config.tatumConfigured)
            fail(
              'Tatum is already configured. Use the local configuration file to rotate credentials.',
              409,
            );
          if (
            typeof body.apiKey !== 'string' ||
            !/^[A-Za-z0-9_-]{16,256}$/.test(body.apiKey.trim())
          )
            fail('Paste a valid Tatum API key.');
          const key = body.apiKey.trim();
          const existing = existsSync(options.configFile)
            ? readFileSync(options.configFile, 'utf8')
            : '';
          const line = `TATUM_API_KEY=${key}`;
          const updated = /^TATUM_API_KEY=.*$/m.test(existing)
            ? existing.replace(/^TATUM_API_KEY=.*$/m, line)
            : `${existing}\n${line}\n`;
          writeFileSync(options.configFile + '.tmp', updated, { mode: 0o600 });
          renameSync(options.configFile + '.tmp', options.configFile);
          env.TATUM_API_KEY = key;
          config.tatumConfigured = true;
          config.fxConfigured = true;
          balanceClient = undefined;
          return json(res, 200, {
            ...payload(),
            message:
              'Tatum key saved locally. No credential is returned to your browser.',
          });
        } else if (path === '/api/demo') {
          if (!config.demoMode)
            fail('Sample data is available only in demo mode.', 403);
          const demoRate = await rateFor(read());
          mutate((state) => {
            if (state.goal || state.entries.length || state.memories.length)
              fail('Demo data can only be loaded into an empty journal.', 409);
            if (state.preferences.currency !== 'PHP')
              fail('Sample data requires a new PHP journal.', 409);
            const sample = createDemoState(today());
            if (sample.goal)
              sample.goal.valuation = valuation(
                sample.goal.targetCents,
                demoRate,
              );
            Object.assign(state, sample);
            for (const entry of state.entries)
              entry.valuation = valuation(entry.amountCents, demoRate);
            for (const bill of state.bills ?? [])
              bill.valuation = valuation(bill.amountCents, demoRate);
            for (const feedback of state.feedback ?? []) {
              feedback.suggestedValuation = valuation(
                feedback.suggestedCents,
                demoRate,
              );
              if (feedback.amountCents !== undefined)
                feedback.amountValuation = valuation(
                  feedback.amountCents,
                  demoRate,
                );
            }
            state.preferences.bufferValuation = valuation(
              state.preferences.bufferCents,
              demoRate,
            );
            state.preferences.dailyLimitValuation = valuation(
              state.preferences.dailyLimitCents,
              demoRate,
            );
          });
        } else if (path === '/api/onboarding') {
          const openingCashCents = money(body.openingCashCents, 'Available cash');
          const title = text(body.title, 'Goal name', 80);
          const targetCents = money(body.targetCents, 'Target', 1);
          const targetDate = body.targetDate === '' || body.targetDate === undefined ? undefined : body.targetDate;
          if (targetDate !== undefined && (typeof targetDate !== 'string' || !validateDate(targetDate))) fail('Choose a valid target date.');
          const prefs = preferences(body, read().preferences.currency);
          const address = body.walletAddress === '' || body.walletAddress === undefined ? '' : text(body.walletAddress, 'Sui address', 66);
          if (address && !/^0x[0-9a-fA-F]{64}$/.test(address)) fail('Enter a full Sui address: 0x followed by 64 hexadecimal characters.');
          if (body.incomeSchedule !== undefined && (!body.incomeSchedule || typeof body.incomeSchedule !== 'object' || Array.isArray(body.incomeSchedule))) fail('Invalid income schedule.');
          const scheduleStart = new Date(Date.parse(`${today()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
          const schedule = body.incomeSchedule === undefined ? undefined : scheduleInput(body.incomeSchedule as Record<string, unknown>, scheduleStart);
          if (schedule && schedule.kind !== 'income') fail('The initial schedule must be income.');
          const rate = await rateFor(read());
          mutate((state) => {
            if (state.goal || state.entries.length || state.onboardingComplete || state.openingCashCents !== undefined) fail('Setup is only available for an empty journal.', 409);
            state.openingCashCents = openingCashCents;
            state.openingCashDate = today();
            state.preferences = { ...prefs, bufferProvenance: { origin: 'manual' }, paceProvenance: { origin: 'manual' }, limitProvenance: { origin: 'manual' }, bufferValuation: valuation(prefs.bufferCents, rate), dailyLimitValuation: valuation(prefs.dailyLimitCents, rate) };
            state.goal = { id: randomUUID(), title, targetCents, targetDate, status: 'active', createdAt: now().toISOString(), valuation: valuation(targetCents, rate), ...(address ? { wallet: { address } } : {}) };
            if (schedule) state.schedules = [schedule];
            state.onboardingComplete = true;
          });
        } else if (path === '/api/goal') {
          const title = text(body.title, 'Goal name', 80),
            targetCents = money(body.targetCents, 'Target', 1);
          if (body.targetDate !== undefined && body.targetDate !== '' && (typeof body.targetDate !== 'string' || !validateDate(body.targetDate)))
            fail('Choose a valid target date.');
          const status = body.status ?? 'active';
          if (!['active', 'paused', 'completed'].includes(String(status)))
            fail('Invalid goal status.');
          const oldGoal = read().goal;
          const goalRate =
            !oldGoal ||
            oldGoal.targetCents !== targetCents ||
            (read().preferences.currency === 'PHP' && !oldGoal.valuation)
              ? await rateFor(read())
              : undefined;
          mutate((state) => {
            if (
              state.goal?.targetCents !== oldGoal?.targetCents
            )
              fail('Goal changed during the request. Retry.', 409);
            if (goalRate) {
              state.preferences.bufferValuation ??= valuation(
                state.preferences.bufferCents,
                goalRate,
              );
              state.preferences.dailyLimitValuation ??= valuation(
                state.preferences.dailyLimitCents,
                goalRate,
              );
            }
            state.goal = {
              id: state.goal?.id ?? randomUUID(),
              title,
              targetCents,
              targetDate: body.targetDate ? body.targetDate as string : undefined,
              status: status as 'active',
              createdAt: state.goal?.createdAt ?? now().toISOString(),
              wallet: state.goal?.wallet,
              valuation: state.goal?.targetCents === targetCents && state.goal.valuation
                ? state.goal.valuation
                : valuation(targetCents, goalRate),
            };
          });
        } else if (path === '/api/simple/wallet/challenge') {
          const address = text(body.address, 'Wallet address', 66);
          if (!/^0x[0-9a-fA-F]{64}$/.test(address)) fail('Enter a valid Sui address.');
          for (const [id, challenge] of walletChallenges) if (challenge.expires <= now().getTime()) walletChallenges.delete(id);
          if (walletChallenges.size >= 20) fail('Too many pending wallet requests.', 429);
          const id = randomUUID();
          const message = `CoinJar wallet connection\nAddress: ${normalizeSuiAddress(address)}\nRequest: ${id}\nThis does not authorize a transaction.`;
          walletChallenges.set(id, { address: normalizeSuiAddress(address), message, expires: now().getTime() + 300000 });
          return json(res, 200, { id, message });
        } else if (path === '/api/simple/wallet/verify') {
          const id = text(body.id, 'Request ID', 80);
          const signature = text(body.signature, 'Signature', 4096);
          const challenge = walletChallenges.get(id);
          walletChallenges.delete(id);
          if (!challenge || challenge.expires <= now().getTime()) fail('Wallet request expired. Connect again.', 409);
          if (owner && owner !== challenge.address) fail('This wallet does not match this journal.', 403);
          let valid: boolean;
          try {
            const client = options.walletClient ?? new SuiGraphQLClient({ network: config.suiNetwork, url: `https://graphql.${config.suiNetwork}.sui.io/graphql` });
            valid = await isValidPersonalMessageSignature(new TextEncoder().encode(challenge.message), signature, { address: challenge.address, client });
          } catch { fail('Wallet verification service is unavailable. Connect and try again.', 503); }
          if (!valid) fail('Wallet signature could not be verified.', 403);
          const newSession = randomUUID();
          walletSessions.set(newSession, { address: challenge.address, expires: now().getTime() + 12 * 3600000 });
          res.setHeader('Set-Cookie', `coinjar_session=${newSession}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
          return json(res, 200, { address: challenge.address });
        } else if (path === '/api/simple/logout') {
          if (sessionId) walletSessions.delete(sessionId);
          res.setHeader('Set-Cookie', 'coinjar_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
          return json(res, 200, { ok: true });
        } else if (path === '/api/simple/onboarding') {
          const name = text(body.name, 'Name', 50);
          const monthlyIncomeCents = money(body.monthlyIncomeCents, 'Monthly income');
          const balanceCents = money(body.balanceCents, 'Available balance');
          const expected = body.expectedCents;
          if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) fail('Invalid balance.');
          if (typeof body.summarySync !== 'boolean') fail('Choose a memory setting.');
          if (body.summarySync && !config.walrusConfigured) fail('Walrus is not configured.', 503);
          if (body.summarySync && body.consent !== true) fail('Confirm the memory disclosure.');
          if (configuredOwner && body.useWallet !== true) fail('Connect your wallet to complete setup.', 403);
          if (body.useWallet === true && !sessionAddress) fail('Connect and verify your wallet first.', 403);
          const payday = body.payday === undefined || body.payday === '' ? undefined : Number(body.payday);
          if (payday !== undefined && (!Number.isInteger(payday) || payday < 1 || payday > 31 || monthlyIncomeCents === 0)) fail('Choose a valid monthly payday and income.');
          mutate((state) => {
            if (state.simpleProfile) fail('Setup has already been completed.', 409);
            const current = getSummary(state, today()).availableCents;
            if (current !== expected) fail('Balance changed. Refresh and try again.', 409);
            const deltaCents = balanceCents - current;
            if (!Number.isSafeInteger(deltaCents)) fail('Balance adjustment is too large.');
            state.balanceAdjustments ??= [];
            state.balanceAdjustments.push({ id: randomUUID(), date: today(), deltaCents, createdAt: now().toISOString() });
            state.simpleProfile = { name, monthlyIncomeCents, ...(body.useWallet === true && sessionAddress ? { walletAddress: sessionAddress } : {}) };
            state.onboardingComplete = true;
            if (payday !== undefined) {
              const start = new Date(Date.parse(`${today()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
              state.schedules ??= [];
              state.schedules.push({ ...scheduleInput({ kind: 'income', title: 'Income', amountCents: monthlyIncomeCents, days: [payday] }, start), autoRecord: true });
            }
            state.summarySync = { ...state.summarySync, enabled: body.summarySync as boolean };
          });
          await recallLearning();
          runAutomations();
        } else if (path === '/api/simple/pause') {
          if (!['weekend', 'other'].includes(String(body.reason))) fail('Choose a reason.');
          let signalId: string | undefined;
          mutate((state) => {
            if (!state.autoSavings) fail('Set up automatic savings first.', 409);
            state.savingsPauses ??= [];
            if (state.savingsPauses.some((pause) => pause.date === today())) return;
            const saved = state.entries.find((entry) => entry.autoSavingsDate === today() && !entry.voidedAt);
            if (saved) {
              if (getSummary(state, today()).savedCents < saved.amountCents) fail('Some of today’s savings has already been moved back.', 409);
              saved.voidedAt = now().toISOString();
            }
            state.savingsPauses.push({ date: today(), reason: body.reason as 'weekend' | 'other' });
            const weekendCount = state.savingsPauses.filter((pause) => pause.reason === 'weekend').length;
            if (weekendCount >= 3 && !state.weekendSignal) {
              state.weekendSignal = true;
              if (state.summarySync?.enabled) {
                signalId = randomUUID();
                state.memories.push({ id: signalId, text: `COINJAR_WEEKEND_SIGNAL_V1 ${JSON.stringify({ count: weekendCount, savedAt: now().toISOString() })}`, kind: 'observation', source: 'local', approved: true, summarySyncRequested: true, createdAt: now().toISOString() });
                db.prepare('INSERT INTO memory_sync (id,status) VALUES (?,?)').run(signalId, 'pending');
              }
            }
          });
          if (signalId) { const id = signalId; automaticQueue = automaticQueue.then(() => autoUpload(id)); }
        } else if (path === '/api/simple/weekend') {
          if (typeof body.enabled !== 'boolean') fail('Choose a weekend preference.');
          let memoryId: string | undefined;
          mutate((state) => {
            state.rememberedWeekendSpending = body.enabled as boolean;
            state.weekendPreferenceChangedAt = now().toISOString();
            state.insightReviews ??= [];
            state.insightReviews = state.insightReviews.filter((item) => item.id !== 'higher-weekend-spending');
            state.insightReviews.push({ id: 'higher-weekend-spending', status: body.enabled ? 'confirmed' : 'dismissed' });
            if (body.enabled && state.summarySync?.enabled) {
              memoryId = randomUUID();
              state.memories.push({ id: memoryId, text: `COINJAR_HABIT_V1 ${JSON.stringify({ type: 'higher-weekend-spending', savedAt: now().toISOString() })}`, kind: 'preference', source: 'local', approved: true, summarySyncRequested: true, createdAt: now().toISOString() });
              db.prepare('INSERT INTO memory_sync (id,status) VALUES (?,?)').run(memoryId, 'pending');
            }
          });
          if (memoryId) { const id = memoryId; automaticQueue = automaticQueue.then(() => autoUpload(id)); }
        } else if (path === '/api/simple/settings') {
          const dailyCents = money(body.dailyCents, 'Daily savings');
          const bufferCents = money(body.bufferCents, 'Keep available');
          if (typeof body.summarySync !== 'boolean') fail('Choose whether to sync summaries.');
          if (body.summarySync && !config.walrusConfigured) fail('Connect Walrus before enabling summary sync.', 503);
          if (body.summarySync && body.consent !== true) fail('Confirm the summary sync disclosure.');
          mutate((state) => {
            const startDate = new Date(Date.parse(`${today()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
            state.autoSavings = dailyCents ? { dailyCents, bufferCents, startDate: state.autoSavings?.dailyCents === dailyCents && state.autoSavings.bufferCents === bufferCents ? state.autoSavings.startDate : startDate } : undefined;
            state.summarySync = { ...state.summarySync, enabled: body.summarySync as boolean };
            state.autoMemorySync = false;
            for (const item of state.memories.filter((m) => m.autoSyncRequested)) db.prepare("UPDATE memory_sync SET status='not_sent' WHERE id=? AND status='pending'").run(item.id);
          });
          await recallLearning();
          runAutomations();
        } else if (path === '/api/jar/withdraw') {
          const amountCents = money(body.amountCents, 'Amount', 1);
          const operationId = text(body.operationId, 'Operation ID', 80);
          const canonical = JSON.stringify({ action: 'jar-withdraw', amountCents });
          mutate((state) => {
            const previous = db.prepare('SELECT payload FROM operations WHERE id=?').get(operationId) as { payload: string } | undefined;
            if (previous) { if (previous.payload !== canonical) fail('This operation was already used for different data.', 409); return; }
            if (getSummary(state, today()).savedCents < amountCents) fail('Amount exceeds the jar balance.', 409);
            if (state.entries.length >= 10000) fail('Journal limit reached.', 409);
            state.entries.push({ id: randomUUID(), kind: 'withdrawal', amountCents, note: 'Moved from jar', date: today(), createdAt: now().toISOString() });
            db.prepare('INSERT INTO operations VALUES (?,?)').run(operationId, canonical);
          });
        } else if (path === '/api/balance/set') {
          const desired = money(body.amountCents, 'Current balance');
          const expected = body.expectedCents;
          if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) fail('Invalid current balance.');
          const operationId = text(body.operationId, 'Operation ID', 80);
          const canonical = JSON.stringify({ action: 'balance-set', desired, expected });
          mutate((state) => {
            const previous = db.prepare('SELECT payload FROM operations WHERE id=?').get(operationId) as { payload: string } | undefined;
            if (previous) { if (previous.payload !== canonical) fail('This operation was already used for different data.', 409); return; }
            const current = getSummary(state, today()).availableCents;
            if (current !== expected) fail('Balance changed. Refresh and try again.', 409);
            const deltaCents = desired - current;
            if (!Number.isSafeInteger(deltaCents)) fail('Balance adjustment is too large.');
            state.balanceAdjustments ??= [];
            if (state.balanceAdjustments.length >= 10000) fail('Balance adjustment limit reached.', 409);
            state.balanceAdjustments.push({ id: randomUUID(), date: today(), deltaCents, createdAt: now().toISOString() });
            state.onboardingComplete = true;
            db.prepare('INSERT INTO operations VALUES (?,?)').run(operationId, canonical);
          });
        } else if (path === '/api/entries') {
          if (
            !['income', 'expense', 'contribution'].includes(String(body.kind))
          )
            fail('Choose income, expense or contribution.');
          const amountCents = money(body.amountCents, 'Amount', 1),
            operationId = text(body.operationId, 'Operation ID', 80);
          const note =
            body.note === '' || body.note === undefined
              ? ''
              : text(body.note, 'Note', 160);
          const category =
            body.category === undefined || body.category === ''
              ? undefined
              : text(body.category, 'Category', 80);
          const entryTime = body.time === undefined || body.time === '' ? undefined : body.time;
          if (entryTime !== undefined && (typeof entryTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(entryTime))) fail('Choose a valid time.');
          let entryFeedback:
            | {
                action: 'accept' | 'reduce';
                suggestedCents: number;
                reason?: string;
              }
            | undefined;
          if (body.feedback !== undefined) {
            if (
              body.kind !== 'contribution' ||
              !body.feedback ||
              typeof body.feedback !== 'object' ||
              Array.isArray(body.feedback)
            )
              fail('Feedback requires a contribution.');
            const input = body.feedback as Record<string, unknown>;
            if (!['accept', 'reduce'].includes(String(input.action)))
              fail('Choose a valid response.');
            const suggestedCents = money(
              input.suggestedCents,
              'Suggested amount',
            );
            if (
              (input.action === 'reduce' && amountCents >= suggestedCents) ||
              (input.action === 'accept' && amountCents !== suggestedCents)
            )
              fail('Contribution does not match the response.');
            const reason =
              input.reason === undefined || input.reason === ''
                ? undefined
                : text(input.reason, 'Reason', 500);
            entryFeedback = {
              action: input.action as 'accept' | 'reduce',
              suggestedCents,
              ...(reason ? { reason } : {}),
            };
          }
          if (
            typeof body.date !== 'string' ||
            !validateDate(body.date) ||
            body.date > today()
          )
            fail('Choose a valid date today or earlier.');
          const canonical = JSON.stringify({
            ...(category ? { category } : {}),
            ...(entryFeedback ? { feedback: entryFeedback } : {}),
            kind: body.kind,
            amountCents,
            note,
            date: body.date,
            ...(entryTime ? { time: entryTime } : {}),
          });
          const prior = db
            .prepare('SELECT payload FROM operations WHERE id=?')
            .get(operationId) as { payload: string } | undefined;
          if (prior && prior.payload !== canonical)
            fail('This operation was already used for different data.', 409);
          const entryRate = prior ? undefined : await rateFor(read());
          mutate((state) => {
            const previous = db
              .prepare('SELECT payload FROM operations WHERE id=?')
              .get(operationId) as { payload: string } | undefined;
            if (previous) {
              if (previous.payload !== canonical)
                fail(
                  'This operation was already used for different data.',
                  409,
                );
              return;
            }
            if (state.openingCashDate && (body.date as string) < state.openingCashDate) fail('This date is before your opening balance. Earlier transactions are already included in that balance.');
            if (
              body.kind === 'contribution' &&
              (!state.goal || state.goal.status !== 'active')
            )
              fail(
                'Create or resume your goal before recording a contribution.',
              );
            if (state.entries.length >= 10_000)
              fail('This demo journal has reached its record limit.', 409);
            const entryId = randomUUID();
            state.entries.push({
              id: entryId,
              kind: body.kind as 'income',
              amountCents,
              note,
              ...(category ? { category } : {}),
              date: body.date as string,
              ...(entryTime ? { time: entryTime as string } : {}),
              createdAt: now().toISOString(),
              valuation: valuation(amountCents, entryRate),
            });
            if (entryFeedback) {
              state.feedback ??= [];
              if (state.feedback.length >= 10000)
                fail('Feedback limit reached.', 409);
              state.feedback.push({
                id: randomUUID(),
                entryId,
                date: body.date as string,
                ...entryFeedback,
                amountCents,
                suggestedValuation: valuation(
                  entryFeedback.suggestedCents,
                  entryRate,
                ),
                amountValuation: valuation(amountCents, entryRate),
              });
            }
            db.prepare('INSERT INTO operations VALUES (?,?)').run(
              operationId,
              canonical,
            );
            if (body.kind === 'contribution')
              remember(
                state,
                `Recorded a self-reported contribution of ${amountCents} ${state.preferences.currency === 'PHP' ? 'centavos' : 'cents'} (${state.preferences.currency}) on ${body.date}. No transfer was made.`,
                'observation',
              );
          });
        } else if (path === '/api/schedules') {
          if (body.autoRecord !== undefined && typeof body.autoRecord !== 'boolean') fail('Invalid schedule option.');
          if (body.autoRecord && body.kind !== 'income') fail('Only income can be recorded automatically.');
          const start = body.autoRecord ? new Date(Date.parse(`${today()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10) : today();
          const schedule = { ...scheduleInput(body, start), ...(body.autoRecord ? { autoRecord: true } : {}) };
          const operationId = body.operationId === undefined ? undefined : text(body.operationId, 'Operation ID', 80);
          const canonical = JSON.stringify({ action: 'schedule', kind: schedule.kind, title: schedule.title, amountCents: schedule.amountCents, days: schedule.days, autoRecord: Boolean(schedule.autoRecord) });
          mutate((state) => {
            if (operationId) {
              const previous = db.prepare('SELECT payload FROM operations WHERE id=?').get(operationId) as { payload: string } | undefined;
              if (previous) { if (previous.payload !== canonical) fail('This operation was already used for different data.', 409); return; }
            }
            state.schedules ??= [];
            if (state.schedules.length >= 100) fail('Schedule limit reached.', 409);
            state.schedules.push(schedule);
            if (operationId) db.prepare('INSERT INTO operations VALUES (?,?)').run(operationId, canonical);
          });
        } else if (path === '/api/schedules/stop') {
          const id = text(body.id, 'Schedule ID', 80);
          mutate((state) => {
            const schedule = state.schedules?.find((item) => item.id === id);
            if (!schedule) fail('Schedule not found.', 404);
            schedule.endDate ??= today();
          });
        } else if (path === '/api/schedules/confirm') {
          const id = text(body.id, 'Schedule ID', 80);
          if (typeof body.date !== 'string' || !validateDate(body.date) || body.date > today() || !Number.isInteger(body.scheduledDay)) fail('Choose a due occurrence.');
          const occurrenceDate = body.date;
          const scheduledDay = body.scheduledDay as number;
          const rate = await rateFor(read());
          mutate((state) => {
            if (state.entries.some((e) => !e.voidedAt && e.scheduleId === id && e.occurrenceDate === occurrenceDate && e.scheduleDay === scheduledDay)) return;
            const occurrence = scheduleOccurrences(state, today()).find((item) => item.schedule.id === id && item.date === occurrenceDate && item.scheduledDay === scheduledDay);
            if (!occurrence) fail('This occurrence is not available.', 409);
            if (state.entries.length >= 10_000) fail('This demo journal has reached its record limit.', 409);
            state.entries.push({ id: randomUUID(), kind: occurrence.schedule.kind, amountCents: occurrence.schedule.amountCents, note: occurrence.schedule.title, date: today(), createdAt: now().toISOString(), scheduleId: id, occurrenceDate, scheduleDay: scheduledDay, valuation: valuation(occurrence.schedule.amountCents, rate) });
          });
        } else if (path === '/api/entries/void') {
          const id = text(body.id, 'Entry ID', 80);
          mutate((state) => {
            const entry = state.entries.find((item) => item.id === id);
            if (!entry) fail('Entry not found.', 404);
            if (entry.voidedAt) return;
            if (
              !entry.billId &&
              entry.kind === 'expense' &&
              state.bills?.some(
                (bill) =>
                  bill.paid &&
                  bill.title === entry.note &&
                  bill.amountCents === entry.amountCents,
              )
            )
              fail(
                'This older entry may be a bill payment and cannot be safely voided.',
                409,
              );
            if (
              entry.kind === 'contribution' &&
              state.feedback?.some(
                (feedback) =>
                  !feedback.entryId &&
                  feedback.date === entry.date &&
                  feedback.amountCents === entry.amountCents,
              )
            )
              fail(
                'This older entry may have linked feedback and cannot be safely voided.',
                409,
              );
            if (entry.billId) {
              const bill = state.bills?.find(
                (item) => item.id === entry.billId,
              );
              if (!bill || !bill.paid)
                fail('The linked bill cannot be safely restored.', 409);
              bill.paid = false;
            }
            entry.voidedAt = now().toISOString();
            for (const feedback of state.feedback ?? []) {
              if (feedback.entryId === entry.id)
                feedback.voidedAt = entry.voidedAt;
            }
          });
        } else if (path === '/api/preferences') {
          const previousPrefs = read().preferences;
          const proposed = preferences(body, previousPrefs.currency);
          const prefsRate =
            previousPrefs.bufferCents !== proposed.bufferCents ||
            previousPrefs.dailyLimitCents !== proposed.dailyLimitCents ||
            (previousPrefs.currency === 'PHP' &&
              (!previousPrefs.bufferValuation ||
                !previousPrefs.dailyLimitValuation))
              ? await rateFor(read())
              : undefined;
          mutate((state) => {
            const prefs = preferences(body, state.preferences.currency);
            if (
              state.preferences.bufferCents !== previousPrefs.bufferCents ||
              state.preferences.dailyLimitCents !== previousPrefs.dailyLimitCents
            )
              fail('Preferences changed during the request. Retry.', 409);
            prefs.bufferValuation = (prefs.bufferCents !== state.preferences.bufferCents || !state.preferences.bufferValuation)
              ? valuation(prefs.bufferCents, prefsRate)
              : state.preferences.bufferValuation;
            prefs.dailyLimitValuation = (prefs.dailyLimitCents !== state.preferences.dailyLimitCents || !state.preferences.dailyLimitValuation)
              ? valuation(prefs.dailyLimitCents, prefsRate)
              : state.preferences.dailyLimitValuation;
            prefs.limitProvenance = prefs.dailyLimitCents === state.preferences.dailyLimitCents
              ? state.preferences.limitProvenance ?? { origin: 'manual' }
              : { origin: 'manual' };
            prefs.bufferProvenance = prefs.bufferCents === state.preferences.bufferCents
              ? state.preferences.bufferProvenance ?? { origin: 'manual' } : { origin: 'manual' };
            prefs.paceProvenance = prefs.pace === state.preferences.pace
              ? state.preferences.paceProvenance ?? { origin: 'manual' } : { origin: 'manual' };
            state.preferences = prefs;
            remember(
              state,
              `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: now().toISOString(), preferences: prefs })}`,
              'preference',
            );
          });
        } else if (path === '/api/reminder') {
          if (typeof body.enabled !== 'boolean' || typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) fail('Choose a valid reminder time.');
          mutate((state) => { state.reminder = { enabled: body.enabled as boolean, time: body.time as string }; });
        } else if (path === '/api/memories') {
          const content = text(body.text, 'Memory', 500);
          mutate((state) => {
            if (state.memories.length >= 1_000)
              fail('Memory limit reached.', 409);
            remember(state, content, 'feedback');
          });
        } else if (path === '/api/bills') {
          const title = text(body.title, 'Bill name', 80);
          const amountCents = money(body.amountCents, 'Bill amount', 1);
          if (typeof body.dueDate !== 'string' || !validateDate(body.dueDate))
            fail('Choose a valid bill date.');
          const billRate = await rateFor(read());
          mutate((state) => {
            state.bills ??= [];
            if (state.bills.length >= 1000) fail('Bill limit reached.', 409);
            state.bills.push({
              id: randomUUID(),
              title,
              amountCents,
              dueDate: body.dueDate as string,
              paid: false,
              valuation: valuation(amountCents, billRate),
            });
          });
        } else if (path === '/api/bills/pay') {
          const id = text(body.id, 'Bill ID', 80);
          const existingBill = read().bills?.find((item) => item.id === id);
          if (!existingBill) fail('Bill not found.', 404);
          const paymentRate = existingBill.paid
            ? undefined
            : await rateFor(read());
          mutate((state) => {
            const bill = state.bills?.find((item) => item.id === id);
            if (!bill) fail('Bill not found.', 404);
            if (bill.paid) return;
            if (bill.amountCents !== existingBill.amountCents)
              fail('Bill changed during the request. Retry.', 409);
            if (state.entries.length >= 10_000)
              fail('This demo journal has reached its record limit.', 409);
            state.entries.push({
              id: randomUUID(),
              kind: 'expense',
              billId: bill.id,
              amountCents: bill.amountCents,
              note: bill.title,
              date: today(),
              createdAt: now().toISOString(),
              valuation: valuation(bill.amountCents, paymentRate),
            });
            bill.paid = true;
          });
        } else if (path === '/api/bills/update') {
          const id = text(body.id, 'Bill ID', 80);
          if (body.paid !== false)
            fail('Use the record payment action to pay a bill.');
          mutate((state) => {
            const bill = state.bills?.find((item) => item.id === id);
            if (!bill) fail('Bill not found.', 404);
            if (bill.paid)
              fail('A recorded bill payment cannot be reversed here.', 409);
          });
        } else if (path === '/api/feedback') {
          if (!['accept', 'reduce', 'skip'].includes(String(body.action)))
            fail('Choose a valid response.');
          const suggestedCents = money(body.suggestedCents, 'Suggested amount');
          const amountCents =
            body.amountCents === undefined
              ? undefined
              : money(body.amountCents, 'Chosen amount');
          if (
            body.action === 'reduce' &&
            (amountCents === undefined || amountCents >= suggestedCents)
          )
            fail('A reduced amount must be less than the suggestion.');
          const reason =
            body.reason === undefined || body.reason === ''
              ? undefined
              : text(body.reason, 'Reason', 500);
          const feedbackRate = await rateFor(read());
          mutate((state) => {
            state.feedback ??= [];
            if (state.feedback.length >= 10000)
              fail('Feedback limit reached.', 409);
            state.feedback.push({
              id: randomUUID(),
              date: today(),
              action: body.action as 'accept' | 'reduce' | 'skip',
              suggestedCents,
              ...(amountCents === undefined ? {} : { amountCents }),
              ...(reason ? { reason } : {}),
              suggestedValuation: valuation(suggestedCents, feedbackRate),
              ...(amountCents === undefined
                ? {}
                : { amountValuation: valuation(amountCents, feedbackRate) }),
            });
          });
        } else if (path === '/api/memory/automatic') {
          if (typeof body.enabled !== 'boolean') fail('Choose whether automatic memory sync is on.');
          if (body.enabled && body.consent !== true) fail('Confirm automatic sync and its privacy disclosure.');
          if (body.enabled && !config.walrusConfigured) fail('Configure Walrus before enabling automatic sync.', 503);
          mutate((state) => {
            state.autoMemorySync = body.enabled as boolean;
            if (!body.enabled) for (const item of state.memories.filter((m) => m.autoSyncRequested)) db.prepare("UPDATE memory_sync SET status='not_sent' WHERE id=? AND status='pending'").run(item.id);
          });
        } else if (path === '/api/insights/review') {
          const id = text(body.id, 'Insight ID', 120);
          if (!['confirm', 'dismiss', 'correct'].includes(String(body.action)))
            fail('Choose a valid insight response.');
          const correctedLimit = body.action === 'correct' && id === 'preferred-contribution' && body.dailyLimitCents !== undefined
            ? money(body.dailyLimitCents, 'Daily limit') : undefined;
          const correction =
            body.action === 'correct' && correctedLimit === undefined
              ? text(body.correction, 'Correction', 500)
              : undefined;
          const existingInsight = detectInsights(read(), today()).find(
            (item) => item.id === id,
          );
          const insightRate =
            (correctedLimit !== undefined && correctedLimit !== read().preferences.dailyLimitCents) ||
            (body.action === 'confirm' &&
            existingInsight?.suggestedDailyLimitCents !== undefined &&
            existingInsight.suggestedDailyLimitCents < read().preferences.dailyLimitCents)
              ? await rateFor(read())
              : undefined;
          let automaticId: string | undefined;
          mutate((state) => {
            const insight = detectInsights(state, today()).find(
              (item) => item.id === id,
            );
            if (!insight) fail('Insight not found.', 404);
            if (insight.suggestedDailyLimitCents !== existingInsight?.suggestedDailyLimitCents)
              fail('Insight changed during the request. Retry.', 409);
            state.insightReviews ??= [];
            state.insightReviews = state.insightReviews.filter(
              (item) => item.id !== id,
            );
            state.insightReviews.push({
              id,
              status: body.action === 'confirm' || correctedLimit !== undefined ? 'confirmed' : 'dismissed',
              ...(correction ? { correction } : {}),
            });
            if (id === 'higher-weekend-spending') {
              state.rememberedWeekendSpending = body.action === 'confirm';
              state.weekendProvenance = body.action === 'confirm'
                ? { observations: insight.observations.slice(0, 20) } : undefined;
              if (body.action !== 'confirm') {
                for (const item of state.memories.filter((m) =>
                  m.text.startsWith('COINJAR_HABIT_V1 '),
                )) {
                  if (item.remoteId)
                    db.prepare(
                      'INSERT OR IGNORE INTO suppressed_memories (remote_id) VALUES (?)',
                    ).run(item.remoteId);
                }
                state.memories = state.memories.filter(
                  (m) => !m.text.startsWith('COINJAR_HABIT_V1 '),
                );
              }
            }
            if (body.action === 'confirm' || correctedLimit !== undefined) {
              if (insight.suggestedDailyLimitCents !== undefined) {
                const newLimit = correctedLimit ?? Math.min(state.preferences.dailyLimitCents, insight.suggestedDailyLimitCents);
                if (
                  newLimit !== state.preferences.dailyLimitCents
                )
                  state.preferences.dailyLimitValuation = valuation(
                    newLimit,
                    insightRate,
                  );
                state.preferences.dailyLimitCents = newLimit;
                if (correctedLimit !== undefined) {
                  state.preferences.limitProvenance = { origin: 'explicit' };
                } else if (insight.suggestedDailyLimitCents <= newLimit) {
                  state.preferences.limitProvenance = {
                    origin: 'confirmed',
                    observations: insight.observations.slice(0, 20),
                  };
                }
                automaticId = remember(
                  state,
                  `COINJAR_PREFERENCES_V1 ${JSON.stringify({ savedAt: now().toISOString(), preferences: state.preferences })}`,
                  'preference',
                );
                if (correctedLimit === undefined && insight.suggestedDailyLimitCents > newLimit) automaticId = undefined;
              } else if (id === 'higher-weekend-spending')
                automaticId = remember(
                  state,
                  `COINJAR_HABIT_V1 ${JSON.stringify({ type: id, savedAt: now().toISOString(), observations: state.weekendProvenance?.observations })}`,
                  'preference',
                );
              else remember(state, insight.description, 'preference');
            } else if (correction) remember(state, correction, 'feedback');
            if (automaticId && state.autoMemorySync) {
              const item = state.memories.find((m) => m.id === automaticId)!;
              item.autoSyncRequested = true;
              db.prepare('INSERT INTO memory_sync (id,status) VALUES (?,?)').run(automaticId, 'pending');
            } else automaticId = undefined;
          });
          if (automaticId) {
            const id = automaticId;
            automaticQueue = automaticQueue.then(() => autoUpload(id));
          }
        } else if (
          path === '/api/memories/update' ||
          path === '/api/memories/delete'
        ) {
          const id = text(body.id, 'Memory ID', 80);
          const content = path.endsWith('/update')
            ? text(body.text, 'Memory', 500)
            : undefined;
          mutate((state) => {
            const index = state.memories.findIndex((item) => item.id === id);
            if (index < 0) fail('Memory not found.', 404);
            const existing = state.memories[index];
            if (
              content !== undefined &&
              (existing.text.startsWith('COINJAR_PREFERENCES_V1 ') ||
                existing.text.startsWith('COINJAR_HABIT_V1 '))
            )
              fail(
                'Review the associated settings or insight instead of editing a structured memory.',
              );
            if (existing.remoteId)
              db.prepare(
                'INSERT OR IGNORE INTO suppressed_memories (remote_id) VALUES (?)',
              ).run(existing.remoteId);
            if (existing.text.startsWith('COINJAR_HABIT_V1 ')) {
              state.rememberedWeekendSpending = false;
              state.weekendProvenance = undefined;
              state.insightReviews ??= [];
              state.insightReviews = state.insightReviews.filter(
                (r) => r.id !== 'higher-weekend-spending',
              );
              state.insightReviews.push({
                id: 'higher-weekend-spending',
                status: 'dismissed',
              });
            }
            if (content === undefined) state.memories.splice(index, 1);
            else {
              state.memories.splice(index, 1);
              remember(state, content, 'feedback');
            }
          });
        } else if (path === '/api/goal/wallet') {
          const address =
            body.address === '' ? '' : text(body.address, 'Sui address', 66);
          if (address && !/^0x[0-9a-fA-F]{64}$/.test(address))
            fail(
              'Enter a full Sui address: 0x followed by 64 hexadecimal characters.',
            );
          mutate((state) => {
            if (!state.goal) fail('Create a goal first.');
            if (state.onchainTransfers?.some((item) => ['awaiting_wallet', 'unknown', 'pending'].includes(item.status))) fail('Resolve the pending wallet transfer before changing the savings address.', 409);
            state.goal.wallet = address ? { address } : undefined;
          });
        } else if (path === '/api/onchain/quote') {
          return json(res, 200, { quote: await suiQuote() });
        } else if (path === '/api/onchain/intent') {
          const sender = text(body.sender, 'Sender', 66);
          const recipient = text(body.recipient, 'Savings address', 66);
          const amountMicroUsdc = text(body.amountMicroUsdc, 'USDC amount', 20);
          if (!/^0x[0-9a-fA-F]{64}$/.test(sender) || !/^0x[0-9a-fA-F]{64}$/.test(recipient) || normalizeSuiAddress(sender) === normalizeSuiAddress(recipient)) fail('Choose a different valid sender and savings address.');
          if (!/^[1-9]\d{0,19}$/.test(amountMicroUsdc) || BigInt(amountMicroUsdc) > 18446744073709551615n) fail('Enter a valid USDC amount.');
          if (body.network !== config.suiNetwork) fail('Wallet and server networks do not match.', 409);
          if (!config.tatumConfigured) fail('Configure Tatum before creating a wallet transfer.', 503);
          mutate((state) => {
            if (!state.goal || state.goal.status !== 'active' || !state.goal.wallet?.address || normalizeSuiAddress(state.goal.wallet.address) !== normalizeSuiAddress(recipient)) fail('Save an active goal and matching savings address first.', 409);
            state.onchainTransfers ??= [];
            if (state.onchainTransfers.length >= 1000) fail('Transfer history limit reached.', 409);
            if (state.onchainTransfers.some((item) => ['awaiting_wallet', 'unknown', 'pending'].includes(item.status))) fail('Resolve the existing transfer before starting another.', 409);
            state.onchainTransfers.push({ id: randomUUID(), goalId: state.goal.id, network: config.suiNetwork, sender: normalizeSuiAddress(sender), recipient: normalizeSuiAddress(recipient), asset: 'USDC', amountMicroUsdc, createdAt: now().toISOString(), status: 'awaiting_wallet' });
          });
        } else if (path === '/api/onchain/digest') {
          const id = text(body.id, 'Transfer ID', 80);
          const digest = text(body.digest, 'Transaction digest', 64);
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(digest)) fail('Enter a valid transaction digest.');
          mutate((state) => {
            const transfer = state.onchainTransfers?.find((item) => item.id === id);
            if (!transfer || !['awaiting_wallet', 'unknown', 'pending'].includes(transfer.status)) fail('Transfer is not awaiting a digest.', 409);
            if (transfer.digest && transfer.digest !== digest && (body.replace !== true || body.acknowledged !== true)) fail('Confirm replacing the pending digest after checking your wallet.', 409);
            if (state.onchainTransfers?.some((item) => item.id !== id && item.digest === digest)) fail('This transaction is already recorded.', 409);
            transfer.digest = digest;
            transfer.status = 'pending';
          });
        } else if (path === '/api/onchain/unknown' || path === '/api/onchain/dismiss') {
          const id = text(body.id, 'Transfer ID', 80);
          const dismiss = path.endsWith('/dismiss');
          if (dismiss && body.acknowledged !== true) fail('Confirm you checked the wallet.');
          mutate((state) => {
            const transfer = state.onchainTransfers?.find((item) => item.id === id);
            if (!transfer || !['awaiting_wallet', 'unknown', 'pending'].includes(transfer.status)) fail('Transfer is not pending.', 409);
            if (!dismiss && transfer.status !== 'awaiting_wallet') fail('Transfer already has a status.', 409);
            transfer.status = dismiss ? 'dismissed' : 'unknown';
          });
        } else if (path === '/api/onchain/valuation') {
          const id = text(body.id, 'Transfer ID', 80);
          const before = read().onchainTransfers?.find((item) => item.id === id);
          if (!before || before.status !== 'verified' || before.network !== 'mainnet' || read().preferences.currency !== 'PHP') fail('Only a verified mainnet transfer can receive a peso reference.', 409);
          if (!before.phpValuation) {
            const valuation = await transferValuation(before);
            mutate((state) => {
              const transfer = state.onchainTransfers?.find((item) => item.id === id);
              if (!transfer || transfer.status !== 'verified' || transfer.amountMist !== before.amountMist || transfer.amountMicroUsdc !== before.amountMicroUsdc || transfer.asset !== before.asset) fail('Transfer changed during valuation.', 409);
              transfer.phpValuation ??= valuation;
            });
          }
        } else if (path === '/api/onchain/verify') {
          const id = text(body.id, 'Transfer ID', 80);
          const before = read().onchainTransfers?.find((item) => item.id === id);
          if (!before || before.status !== 'pending' || !before.digest) fail('Add a transaction digest first.', 409);
          const adapter = await balance();
          if (!adapter.getTransaction) fail('Transaction verification is unavailable.', 503);
          const result = await adapter.getTransaction(before.digest) as { network?: unknown; digest?: unknown; success?: unknown; checkpoint?: unknown; timestampMs?: unknown; sender?: unknown; inputs?: unknown; balanceChanges?: unknown };
          const intentTime = Date.parse(before.createdAt);
          if (result.network !== before.network || result.digest !== before.digest || typeof result.checkpoint !== 'string' || !/^\d+$/.test(result.checkpoint) || !Number.isSafeInteger(result.timestampMs) || !Number.isFinite(intentTime) || (result.timestampMs as number) < intentTime - 30000 || (result.timestampMs as number) > now().getTime() + 30000 || typeof result.sender !== 'string' || normalizeSuiAddress(result.sender) !== before.sender || typeof result.success !== 'boolean') fail('Transaction is not confirmed in a matching checkpoint yet.', 409);
          const marker = bcs.String.serialize(`coinjar:${before.id}`).toBase64();
          if (!Array.isArray(result.inputs) || !result.inputs.some((input: { Pure?: { bytes?: unknown } }) => input?.Pure?.bytes === marker)) fail('Transaction does not match this CoinJar intent.', 409);
          if (result.success) {
            if (!Array.isArray(result.balanceChanges)) fail('Transaction balance changes are unavailable.', 409);
            const expectedCoin = before.asset === 'USDC' ? USDC_TYPES[before.network] : '0x2::sui::SUI';
            const changes = result.balanceChanges.filter((item: { coinType?: unknown; address?: unknown; amount?: unknown }) => typeof item.coinType === 'string' && item.coinType.replace(/^0x0*2::/, '0x2::') === expectedCoin && typeof item.address === 'string' && typeof item.amount === 'string' && /^-?\d+$/.test(item.amount));
            const total = (address: string) => changes.filter((item: { address: string }) => normalizeSuiAddress(item.address) === address).reduce((sum: bigint, item: { amount: string }) => sum + BigInt(item.amount), 0n);
            const amount = before.asset === 'USDC' ? before.amountMicroUsdc : before.amountMist;
            if (!amount || total(before.recipient) !== BigInt(amount) || total(before.sender) > -BigInt(amount)) fail('Transaction does not match the intended transfer.', 409);
          }
          let phpValuation: { centavos: number; rate: string; timestamp: number; source: string } | undefined;
          if (result.success && before.network === 'mainnet' && read().preferences.currency === 'PHP') {
            try {
              phpValuation = await transferValuation(before);
            } catch { /* A confirmed transfer remains unvalued when a current quote is unavailable. */ }
          }
          mutate((state) => {
            const transfer = state.onchainTransfers?.find((item) => item.id === id);
            if (!transfer || transfer.status !== 'pending' || transfer.digest !== before.digest) fail('Transfer changed during verification.', 409);
            transfer.status = result.success ? 'verified' : 'failed';
            transfer.checkpoint = result.checkpoint as string;
            if (phpValuation) transfer.phpValuation = phpValuation;
          });
        } else if (path === '/api/goal/wallet/refresh') {
          const wallet = read().goal?.wallet;
          if (!wallet) fail('Connect a wallet first.');
          const result = await (await balance()).getBalance(wallet.address, USDC_TYPES[config.suiNetwork]);
          if (
            !result ||
            typeof result !== 'object' ||
            !('balanceMist' in result) ||
            typeof result.balanceMist !== 'string' ||
            !/^\d+$/.test(result.balanceMist) ||
            !('coinType' in result) ||
            result.coinType !== USDC_TYPES[config.suiNetwork] ||
            !('network' in result) ||
            result.network !== config.suiNetwork
          )
            fail('Tatum returned an invalid balance.', 502);
          mutate((state) => {
            if (state.goal?.wallet?.address !== wallet.address)
              fail('Wallet changed during refresh.', 409);
            state.goal.wallet = {
              address: wallet.address,
              balance: result,
              updatedAt: now().toISOString(),
            };
          });
        } else if (path === '/api/memory/sync') {
          if (body.consent !== true)
            fail('Confirm that you want to upload these summaries to Walrus.');
          if (
            !Array.isArray(body.ids) ||
            !body.ids.length ||
            body.ids.length > 100 ||
            body.ids.some((id) => typeof id !== 'string')
          )
            fail('Choose the approved memories to upload.');
          const client = await memory();
          if (syncing) fail('A memory sync is already running.', 409);
          syncing = true;
          try {
            const state = read();
            if (!state.memories.length)
              fail('Add a memory or save your preferences first.');
            const selected = state.memories.filter(
              (item) => body.ids instanceof Array && body.ids.includes(item.id),
            );
            if (
              selected.length !== new Set(body.ids).size ||
              selected.some((item) => item.approved !== true)
            )
              fail('Only approved memories can be uploaded.');
            const pending = selected.filter((item) => !item.remoteId);
            if (
              pending.some((item) =>
                db
                  .prepare('SELECT id FROM memory_sync WHERE id=? AND status=?')
                  .get(item.id, 'unknown'),
              )
            )
              fail(
                'A previous upload has an unknown outcome. Check the Walrus dashboard before retrying; automatic retries could duplicate memories.',
                409,
              );
            let stored = 0;
            for (const item of pending) {
              await uploadMemory(item, client);
              stored++;
            }
            return json(res, 200, {
              ...payload(),
              message: `${stored} memories acknowledged by the relayer. Mainnet evidence must still be verified in the dashboard.`,
            });
          } finally {
            syncing = false;
          }
        } else if (
          path === '/api/memory/recall' ||
          path === '/api/memory/restore'
        ) {
          const restoring = path.endsWith('/restore');
          if (restoring && body.consent !== true)
            fail('Confirm replacement of your current savings preferences.');
          const query = restoring
            ? 'COINJAR_PREFERENCES_V1 COINJAR_HABIT_V1 savings preferences weekend spending'
            : text(body.query, 'Search', 500);
          const recalled = await (await memory()).search(query, 30);
          const rows = recallRows(recalled);
          const dropped =
            recalled &&
            typeof recalled === 'object' &&
            'dropped_count' in recalled
              ? Number(recalled.dropped_count)
              : 0;
          const warning =
            dropped > 0
              ? `${dropped} matching memories could not be retrieved. Results are incomplete.`
              : '';
          if (!restoring)
            return json(res, 200, {
              warning,
              memories: rows.map((row) => ({
                text: String(row.text ?? row.content ?? ''),
                id: String(row.blob_id ?? row.blobId ?? row.id ?? ''),
                source: 'walrus',
              })),
            });
          if (dropped > 0)
            fail(
              `${warning} Your settings were kept. Retry recall after checking the provider.`,
              503,
            );
          const snapshots: Array<{
            savedAt: string;
            preferences: Preferences;
            remoteId: string;
            text: string;
          }> = [];
          const habits: Array<{
            savedAt: string;
            remoteId: string;
            text: string;
            observations?: string[];
          }> = [];
          for (const row of rows) {
            const remoteId = String(row.blob_id ?? row.blobId ?? row.id ?? '');
            // A result without an ID cannot be checked against locally deleted memories.
            if (
              !remoteId ||
              db
                .prepare(
                  'SELECT remote_id FROM suppressed_memories WHERE remote_id=?',
                )
                .get(remoteId)
            )
              continue;
            const content = String(row.text ?? row.content ?? '');
            if (content.startsWith('COINJAR_HABIT_V1 ')) {
              try {
                const habit = JSON.parse(
                  content.slice('COINJAR_HABIT_V1 '.length),
                );
                const age = now().getTime() - Date.parse(habit.savedAt);
                if (
                  habit.type === 'higher-weekend-spending' &&
                  typeof habit.savedAt === 'string' &&
                  Number.isFinite(age) &&
                  age >= 0 &&
                  age <= 90 * 86400000
                )
                  habits.push({
                    savedAt: habit.savedAt,
                    remoteId,
                    text: content,
                    observations: safeObservations(habit.observations),
                  });
              } catch {
                /* Ignore untrusted remote content. */
              }
              continue;
            }
            if (!content.startsWith('COINJAR_PREFERENCES_V1 ')) continue;
            try {
              const snapshot = JSON.parse(content.slice(23));
              if (
                typeof snapshot.savedAt !== 'string' ||
                !Number.isFinite(Date.parse(snapshot.savedAt)) ||
                Date.parse(snapshot.savedAt) > now().getTime()
              )
                continue;
              if (
                !['PHP', 'USD'].includes(snapshot.preferences?.currency) ||
                snapshot.preferences.currency !== read().preferences.currency
              )
                continue;
              const provenance = snapshot.preferences.limitProvenance;
              const origin = ['manual', 'confirmed', 'explicit'].includes(provenance?.origin)
                ? provenance.origin : 'unknown';
              const observations = origin === 'confirmed' ? safeObservations(provenance?.observations) : undefined;
              snapshots.push({
                savedAt: snapshot.savedAt,
                preferences: { ...preferences(
                  snapshot.preferences,
                  snapshot.preferences.currency,
                ), limitProvenance: { origin, ...(observations ? { observations } : {}) },
                bufferProvenance: { origin: snapshot.preferences.bufferProvenance?.origin === 'manual' ? 'manual' : 'unknown' },
                paceProvenance: { origin: snapshot.preferences.paceProvenance?.origin === 'manual' ? 'manual' : 'unknown' } },
                remoteId,
                text: content,
              });
            } catch {
              /* Untrusted remote memory is advisory and must pass the local schema. */
            }
          }
          snapshots.sort(
            (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt),
          );
          if (!snapshots.length && !habits.length)
            fail(
              'No valid CoinJar preference snapshot was recalled. Your current settings were kept.',
              404,
            );
          const snapshot = snapshots[0];
          const beforeRestore = read();
          const restoreRate =
            snapshot &&
            (snapshot.preferences.bufferCents >
              beforeRestore.preferences.bufferCents ||
              snapshot.preferences.dailyLimitCents <
                beforeRestore.preferences.dailyLimitCents)
              ? await rateFor(beforeRestore)
              : undefined;
          mutate((state) => {
            if (snapshot) {
              if (
                state.preferences.bufferCents !== beforeRestore.preferences.bufferCents ||
                state.preferences.dailyLimitCents !== beforeRestore.preferences.dailyLimitCents
              )
                fail('Preferences changed during restore. Retry.', 409);
              const buffer = Math.max(
                state.preferences.bufferCents,
                snapshot.preferences.bufferCents,
              );
              const limit = Math.min(
                state.preferences.dailyLimitCents,
                snapshot.preferences.dailyLimitCents,
              );
              state.preferences = {
                ...snapshot.preferences,
                bufferCents: buffer,
                dailyLimitCents: limit,
                limitProvenance: limit < state.preferences.dailyLimitCents
                  ? { ...snapshot.preferences.limitProvenance!, restored: true, remoteId: snapshot.remoteId }
                  : state.preferences.limitProvenance,
                bufferProvenance: buffer > state.preferences.bufferCents
                  ? { ...snapshot.preferences.bufferProvenance!, restored: true }
                  : state.preferences.bufferProvenance,
                paceProvenance: snapshot.preferences.pace !== state.preferences.pace
                  ? { ...snapshot.preferences.paceProvenance!, restored: true }
                  : state.preferences.paceProvenance,
                bufferValuation:
                  buffer !== state.preferences.bufferCents
                    ? valuation(buffer, restoreRate)
                    : state.preferences.bufferValuation,
                dailyLimitValuation:
                  limit !== state.preferences.dailyLimitCents
                    ? valuation(limit, restoreRate)
                    : state.preferences.dailyLimitValuation,
              };
            }
            if (
              snapshot &&
              !state.memories.some(
                (item) => item.remoteId === snapshot.remoteId,
              )
            )
              state.memories.push({
                id: randomUUID(),
                text: snapshot.text,
                kind: 'preference',
                createdAt: snapshot.savedAt,
                source: 'walrus',
                remoteId: snapshot.remoteId,
              });
            const habit = habits.sort(
              (a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt),
            )[0];
            if (
              habit &&
              !state.insightReviews?.some(
                (review) =>
                  review.id === 'higher-weekend-spending' &&
                  review.status === 'dismissed',
              )
            ) {
              state.rememberedWeekendSpending = true;
              state.weekendProvenance = { observations: habit.observations, restored: true, remoteId: habit.remoteId };
              if (
                !state.memories.some((item) => item.remoteId === habit.remoteId)
              )
                state.memories.push({
                  id: randomUUID(),
                  text: habit.text,
                  kind: 'preference',
                  createdAt: habit.savedAt,
                  source: 'walrus',
                  remoteId: habit.remoteId,
                });
            }
          });
          return json(res, 200, {
            ...payload(),
            message:
              'Applied valid recalled memories and kept the safest savings limits. Recall is not an exhaustive backup.',
          });
        } else if (path === '/api/balance') {
          const address = text(body.address, 'Sui address', 66);
          if (!/^0x[0-9a-fA-F]{64}$/.test(address))
            fail(
              'Enter a full Sui address: 0x followed by 64 hexadecimal characters.',
            );
          return json(res, 200, await (await balance()).getBalance(address, USDC_TYPES[config.suiNetwork]));
        } else fail('Route not found.', 404);
        return json(res, 200, payload());
      }
      if (req.method !== 'GET') fail('Route not found.', 404);
      const staticDir = resolve(options.staticDir ?? 'dist');
      const requested = resolve(staticDir, `.${decodeURIComponent(path)}`);
      if (
        requested !== staticDir &&
        !requested.startsWith(staticDir + '\\') &&
        !requested.startsWith(staticDir + '/')
      )
        fail('Route not found.', 404);
      const file = path.includes('.')
        ? requested
        : resolve(staticDir, 'index.html');
      if (!existsSync(file))
        fail(
          'Build the frontend with npm run build, or open the Vite dev URL.',
          404,
        );
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      res.writeHead(200, {
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(readFileSync(file));
    } catch (error) {
      // Provider error bodies can contain credentials or private text. Keep them off the wire.
      const status = error instanceof RequestError ? error.status : 502;
      json(res, status, {
        error:
          error instanceof RequestError
            ? error.message
            : 'The operation could not be completed. Local records are safe. Check configuration and service availability; an interrupted upload may need dashboard reconciliation.',
      });
    }
  });
  return {
    server,
    db,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        clearInterval(automationTimer);
        server.close((error) => {
          void Promise.allSettled([automaticQueue, recallJob]).finally(() => {
            db.close();
            error ? reject(error) : resolveClose();
          });
        });
      }),
  };
}
