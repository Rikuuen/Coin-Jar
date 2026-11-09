import { TrackingConflict, TrackingNotFound, type TrackingStore } from './store';
import { memoryRows, memoryPreferences } from './memory';

type Store = Pick<TrackingStore, 'snapshot' | 'setup' | 'setBalance' | 'addEntry' | 'saveGoal' | 'saveSettings' | 'addBill' | 'payBill' | 'voidEntry' | 'beginMemory' | 'finishMemory'>;
type Options = { store: Store; origin: string; authenticate: (request: Request) => Promise<string | undefined>; backupStatus?: (owner: string) => Promise<{ savedAt: string; revision: string } | null>; walletBalance?: (address: string) => Promise<unknown>; memory?: { remember: (owner: string, text: string) => Promise<unknown>; recall: (owner: string) => Promise<unknown> } };

async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('Expected JSON');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > 4096) { await reader.cancel(); throw new Error('Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request body');
  return value as Record<string, unknown>;
}

export function createTrackingHandler({ store, origin, authenticate, backupStatus, walletBalance, memory }: Options) {
  return async (request: Request): Promise<Response> => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const respond = (status: number, value: unknown) => Response.json(value, { status, headers });
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return respond(403, { error: 'Untrusted origin' });
    let owner: string | undefined;
    try { owner = await authenticate(request); } catch { return respond(503, { error: 'Authentication is unavailable. Try again.' }); }
    if (!owner) return respond(401, { error: 'Sign in required' });
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/api/tracking/backup') return respond(200, { backup: backupStatus ? await backupStatus(owner) : null });
      if (request.method === 'GET' && path === '/api/tracking') return respond(200, { ...(await store.snapshot(owner)), capabilities: { memory: Boolean(memory), wallet: Boolean(walletBalance) } });
      if (request.method === 'GET' && path === '/api/tracking/wallet') {
        const address = (await store.snapshot(owner)).walletAddress;
        if (!address) return respond(404, { error: 'No wallet address saved.' });
        if (!walletBalance) return respond(503, { error: 'Wallet balance is unavailable.' });
        try {
          const balance = await walletBalance(address) as Record<string, unknown>;
          if (!balance || !['mainnet', 'testnet'].includes(String(balance.network)) || balance.coinType !== '0x2::sui::SUI' || typeof balance.balanceMist !== 'string' || !/^\d+$/.test(balance.balanceMist)) throw new Error('Invalid balance response');
          if ((await store.snapshot(owner)).walletAddress !== address) return respond(409, { error: 'Wallet address changed. Check the new address.' });
          return respond(200, { network: balance.network, coinType: balance.coinType, balanceMist: balance.balanceMist, checkedAt: new Date().toISOString() });
        }
        catch { return respond(503, { error: 'Wallet balance is unavailable.' }); }
      }
      if (request.method === 'GET' && path === '/api/tracking/memory') {
        if (!memory) return respond(503, { error: 'Walrus Memory is unavailable.' });
        try { return respond(200, { memories: memoryRows(await memory.recall(owner)) }); }
        catch { return respond(503, { error: 'Walrus Memory is unavailable or incomplete.' }); }
      }
      if (request.method !== 'POST' || !['/api/tracking/setup', '/api/tracking/balance', '/api/tracking/entries', '/api/tracking/goal', '/api/tracking/settings', '/api/tracking/bills', '/api/tracking/bills/pay', '/api/tracking/void', '/api/tracking/memory', '/api/tracking/memory/restore'].includes(path)) return respond(404, { error: 'Not found' });
      if (request.headers.get('origin') !== origin) return respond(403, { error: 'Untrusted origin' });
      const value = await body(request);
      if (path === '/api/tracking/memory/restore') {
        if (!memory) return respond(503, { error: 'Walrus Memory is unavailable.' });
        if (value.consent !== true || typeof value.operationId !== 'string' || typeof value.revision !== 'string' || typeof value.remoteId !== 'string') throw new Error('Invalid memory');
        let rows: ReturnType<typeof memoryRows>;
        try { rows = memoryRows(await memory.recall(owner)); } catch { return respond(503, { error: 'Walrus Memory is unavailable or incomplete.' }); }
        const selected = rows.find(row => row.id === value.remoteId && row.kind === 'preferences');
        if (!selected) return respond(404, { error: 'Memory not found.' });
        const prefs = selected.preferences as Record<string, unknown> | null;
        if (!prefs || typeof prefs !== 'object' || prefs.currency !== 'PHP' || typeof prefs.bufferCents !== 'number' || typeof prefs.dailyLimitCents !== 'number' || typeof prefs.pace !== 'string') throw new Error('Invalid memory');
        const snapshot = await store.snapshot(owner);
        if (snapshot.preferences.currency !== prefs.currency) throw new TrackingConflict('Memory currency does not match your journal');
        return respond(200, await store.saveSettings(owner, value.operationId, value.revision, { bufferCents: prefs.bufferCents, dailyLimitCents: prefs.dailyLimitCents, pace: prefs.pace, walletAddress: snapshot.walletAddress, weekend: prefs.confirmedWeekend === true }, { id: selected.id, preferences: prefs }));
      }
      if (path === '/api/tracking/memory') {
        if (!memory) return respond(503, { error: 'Walrus Memory is unavailable.' });
        if (value.consent !== true || typeof value.operationId !== 'string' || value.kind !== 'preferences' || (value.text !== undefined && value.text !== '')) throw new Error('Invalid memory');
        const snapshot = await store.snapshot(owner);
        const text = 'COINJAR_HOSTED_V1 ' + JSON.stringify({ kind: 'preferences', text: '', preferences: memoryPreferences(snapshot.preferences) });
        const attempt = await store.beginMemory(owner, value.operationId, text);
        if (!attempt.send) return respond(200, { remoteId: attempt.remoteId, status: 'stored' });
        try {
          const result = await memory.remember(owner, text) as Record<string, unknown> | string;
          const remoteId = typeof result === 'string' ? result : String(result?.blob_id ?? result?.blobId ?? result?.id ?? '');
          if (!remoteId || remoteId.length > 256) throw new Error('Missing memory identifier');
          await store.finishMemory(owner, value.operationId, remoteId);
          return respond(200, { remoteId, status: 'stored' });
        } catch { return respond(503, { error: 'Memory upload outcome is unknown. Do not retry until it is reconciled.' }); }
      }
      if (typeof value.operationId !== 'string' || typeof value.revision !== 'string') throw new Error('Invalid request');
      if (path === '/api/tracking/setup') {
        if ((value.currency !== 'PHP' && value.currency !== 'USD') || typeof value.openingCashCents !== 'number' || typeof value.openingCashDate !== 'string') throw new Error('Invalid setup');
        return respond(200, await store.setup(owner, value.operationId, value.revision, { currency: value.currency, openingCashCents: value.openingCashCents, openingCashDate: value.openingCashDate }));
      }
      if (path === '/api/tracking/balance') {
        if (typeof value.balanceCents !== 'number') throw new Error('Invalid amount');
        return respond(200, await store.setBalance(owner, value.operationId, value.revision, value.balanceCents));
      }
      if (path === '/api/tracking/entries') {
        if (typeof value.kind !== 'string' || typeof value.amountCentavos !== 'number' || typeof value.date !== 'string' || typeof value.note !== 'string') throw new Error('Invalid entry');
        return respond(200, await store.addEntry(owner, value.operationId, value.revision, { kind: value.kind as 'income' | 'expense' | 'recorded_saving', amountCentavos: value.amountCentavos, date: value.date, note: value.note }));
      }
      if (path === '/api/tracking/settings') {
        if (typeof value.bufferCents !== 'number' || typeof value.dailyLimitCents !== 'number' || typeof value.pace !== 'string' || !(value.walletAddress === null || typeof value.walletAddress === 'string') || (value.weekend !== undefined && typeof value.weekend !== 'boolean')) throw new Error('Invalid settings');
        return respond(200, await store.saveSettings(owner, value.operationId, value.revision, { bufferCents: value.bufferCents, dailyLimitCents: value.dailyLimitCents, pace: value.pace, walletAddress: value.walletAddress, weekend: value.weekend as boolean | undefined }));
      }
      if (path === '/api/tracking/bills') {
        if (typeof value.title !== 'string' || typeof value.amountCents !== 'number' || typeof value.dueDate !== 'string') throw new Error('Invalid bill');
        return respond(200, await store.addBill(owner, value.operationId, value.revision, { title: value.title, amountCents: value.amountCents, dueDate: value.dueDate }));
      }
      if (path === '/api/tracking/bills/pay') {
        if (typeof value.billId !== 'string' || typeof value.date !== 'string') throw new Error('Invalid bill');
        return respond(200, await store.payBill(owner, value.operationId, value.revision, { billId: value.billId, date: value.date }));
      }
      if (path === '/api/tracking/void') {
        if (typeof value.entryId !== 'string' || typeof value.reason !== 'string') throw new Error('Invalid correction');
        let replacement: { kind: 'income' | 'expense' | 'recorded_saving'; amountCentavos: number; date: string; note: string } | undefined;
        if (value.replacement !== undefined) {
          const r = value.replacement as Record<string, unknown>;
          if (!r || typeof r !== 'object' || typeof r.kind !== 'string' || typeof r.amountCentavos !== 'number' || typeof r.date !== 'string' || typeof r.note !== 'string') throw new Error('Invalid correction');
          replacement = { kind: r.kind as 'income' | 'expense' | 'recorded_saving', amountCentavos: r.amountCentavos, date: r.date, note: r.note };
        }
        return respond(200, await store.voidEntry(owner, value.operationId, value.revision, { entryId: value.entryId, reason: value.reason, replacement }));
      }
      if (typeof value.title !== 'string' || typeof value.targetCentavos !== 'number' || (value.targetDate !== undefined && typeof value.targetDate !== 'string')) throw new Error('Invalid goal');
      return respond(200, await store.saveGoal(owner, value.operationId, value.revision, { title: value.title, targetCentavos: value.targetCentavos, targetDate: value.targetDate as string | undefined }));
    } catch (error) {
      if (error instanceof TrackingConflict) return respond(409, { error: error.message });
      if (error instanceof TrackingNotFound) return respond(404, { error: 'Not found' });
      if (error instanceof SyntaxError || (error instanceof Error && ['Invalid request', 'Invalid entry', 'Invalid entry type', 'Invalid amount', 'Invalid goal', 'Invalid bill', 'Invalid settings', 'Invalid setup', 'Invalid correction', 'Invalid memory', 'Invalid operation ID', 'Invalid revision', 'Expected JSON', 'Missing request body', 'Request too large'].includes(error.message))) return respond(400, { error: 'Check the submitted details.' });
      return respond(503, { error: 'Could not save or load your journal. Try again.' });
    }
  };
}
