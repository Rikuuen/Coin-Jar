import { createHash, timingSafeEqual } from 'node:crypto';
import { createMemoryAdapter } from './server/integrations/walrus.js';

const prefix = 'COINJAR_PHONE_PREFERENCES_V1 ';
const preferencesV2 = 'COINJAR_PHONE_PREFERENCES_V2 ';
const habitPrefix = 'COINJAR_PHONE_HABIT_V1 ';
const backupPrefix = 'COINJAR_ENCRYPTED_JOURNAL_V1 ';
const testnet = 'https://relayer.dev.memwal.ai';
const validCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const personalNamespace = (code, demo = false) => `coinjar-user-${createHash('sha256').update(`${demo ? 'coinjar-demo-v1' : 'coinjar-memory-v1'}:${code}`).digest('base64url')}`;
export const recoveryNamespace = (code, demo = false) => `coinjar-user-${createHash('sha256').update(`${demo ? 'coinjar-recovery-demo-v1' : 'coinjar-recovery-v1'}:${code}`).digest('base64url')}`;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
function safeMemory(value) {
  if (typeof value !== 'string' || value.length > 300) throw Error('Invalid memory');
  if (value.startsWith(habitPrefix)) {
    const habit = JSON.parse(value.slice(habitPrefix.length));
    if (habit?.type === 'higher-day-spending') {
      if (Array.isArray(habit) || Object.keys(habit).sort().join(',') !== 'days,observedThrough,recordedDays,sampleDays,type' || !Array.isArray(habit.days) || habit.days.length > 7 || !Array.isArray(habit.sampleDays) || habit.days.length !== habit.sampleDays.length || !Number.isInteger(habit.recordedDays) || habit.recordedDays < 6 || habit.recordedDays > 56 || !validDate(habit.observedThrough) || habit.days.some((day, i) => !Number.isInteger(day) || day < 0 || day > 6 || (i > 0 && day <= habit.days[i - 1]) || !Number.isInteger(habit.sampleDays[i]) || habit.sampleDays[i] < 3 || habit.sampleDays[i] > 8 || habit.recordedDays - habit.sampleDays[i] < 3)) throw Error('Invalid memory');
      if (habit.sampleDays.reduce((sum, n) => sum + n, 0) > habit.recordedDays) throw Error('Invalid memory');
      return habitPrefix + JSON.stringify({ type: habit.type, days: habit.days, sampleDays: habit.sampleDays, recordedDays: habit.recordedDays, observedThrough: habit.observedThrough });
    }
    if (habit?.type === 'recent-spending-spike') {
      if (Array.isArray(habit) || Object.keys(habit).sort().join(',') !== 'observedThrough,previousDays,recentDays,type' || !Number.isInteger(habit.recentDays) || habit.recentDays < 3 || habit.recentDays > 7 || !Number.isInteger(habit.previousDays) || habit.previousDays < 3 || habit.previousDays > 7 || !validDate(habit.observedThrough)) throw Error('Invalid memory');
      return habitPrefix + JSON.stringify({ type: habit.type, recentDays: habit.recentDays, previousDays: habit.previousDays, observedThrough: habit.observedThrough });
    }
    if (!habit || Array.isArray(habit) || Object.keys(habit).sort().join(',') !== 'observedThrough,type,weekdayDays,weekendDays' || habit.type !== 'higher-weekend-spending' || !Number.isInteger(habit.weekendDays) || habit.weekendDays < 3 || habit.weekendDays > 16 || !Number.isInteger(habit.weekdayDays) || habit.weekdayDays < 3 || habit.weekdayDays > 40 || !validDate(habit.observedThrough)) throw Error('Invalid memory');
    return habitPrefix + JSON.stringify({ type: habit.type, weekendDays: habit.weekendDays, weekdayDays: habit.weekdayDays, observedThrough: habit.observedThrough });
  }
  if (value.startsWith(preferencesV2)) {
    const item = JSON.parse(value.slice(preferencesV2.length));
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'currency,origin' || !['PHP', 'USD'].includes(item.currency) || item.origin !== 'manual') throw Error('Invalid memory');
    return preferencesV2 + JSON.stringify({ currency: item.currency, origin: 'manual' });
  }
  if (!value.startsWith(prefix)) throw Error('Invalid memory');
  const item = JSON.parse(value.slice(prefix.length));
  if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'bufferCents,currency,dailyLimitCents,origin' || !['PHP', 'USD'].includes(item.currency) || item.origin !== 'manual' || !Number.isSafeInteger(item.bufferCents) || item.bufferCents < 0 || !Number.isSafeInteger(item.dailyLimitCents) || item.dailyLimitCents < 0) throw Error('Invalid memory');
  return prefix + JSON.stringify({ currency: item.currency, bufferCents: item.bufferCents, dailyLimitCents: item.dailyLimitCents, origin: 'manual' });
}

export function createPhoneWalrusHandler({ env = process.env, adapterFactory = createMemoryAdapter, network = 'testnet' } = {}) {
  if (!['testnet', 'mainnet'].includes(network)) throw new Error('Invalid Walrus network');
  const mainnet = network === 'mainnet';
  return async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
    const expected = env.COINJAR_PHONE_ACCESS_CODE;
    const sharedMainnetKey = env.COINJAR_MAINNET_USE_CURRENT_KEY === '1';
    if (!mainnet && sharedMainnetKey) return send(503, { error: 'Walrus testnet is paused for the mainnet demo.' });
    const key = mainnet ? (env.MEMWAL_MAINNET_PRIVATE_KEY || (sharedMainnetKey ? env.MEMWAL_PRIVATE_KEY : undefined)) : env.MEMWAL_PRIVATE_KEY;
    const accountId = mainnet ? env.MEMWAL_MAINNET_ACCOUNT_ID : env.MEMWAL_ACCOUNT_ID;
    if (!validCode(expected) || !key || !accountId || !env.COINJAR_PHONE_ORIGIN) return send(503, { error: `Walrus ${network} is not configured.` });
    const authorization = req.headers.authorization;
    const code = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const recovery = mainnet && req.headers['x-coinjar-recovery'] === '1';
    const personal = mainnet && (recovery || req.headers['x-coinjar-memory-user'] === '1');
    if (req.headers.origin !== env.COINJAR_PHONE_ORIGIN || !validCode(code) || (!personal && !timingSafeEqual(Buffer.from(code), Buffer.from(expected)))) return send(401, { error: 'Access denied.' });
    const personalDemo = personal && req.headers['x-coinjar-memory-demo'] === '1';
    const namespace = personal ? recovery ? recoveryNamespace(code, personalDemo) : personalNamespace(code, personalDemo) : mainnet ? 'coinjar-hackathon-demo' : 'coinjar-phone-testnet';
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > (recovery ? 65536 : 2048)) return send(413, { error: 'Request too large.' }); }
      const input = JSON.parse(body);
      if (!input || input.consent !== true || !(recovery ? ['backupSave', 'backupRestore'] : ['remember', 'recall', 'recallHabit', ...(mainnet ? ['listDemo'] : [])]).includes(input.action)) throw Error('Invalid request');
      let memory;
      if (input.action === 'remember') {
        if (typeof input.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.operationId)) throw Error('Invalid request');
        memory = safeMemory(input.memory);
      }
      const adapter = await adapterFactory({ key, accountId, serverUrl: mainnet ? 'https://relayer.memory.walrus.xyz' : testnet, namespace });
      if (recovery) {
        if (input.action === 'backupSave') {
          const envelope = input.envelope;
          if (!envelope || Array.isArray(envelope) || Object.keys(envelope).sort().join(',') !== 'ciphertext,iv,version' || envelope.version !== 1 || typeof envelope.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9_-]{22,60000}$/.test(envelope.ciphertext) || typeof input.operationId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.operationId)) throw Error('Invalid request');
          const result = await adapter.remember(backupPrefix + JSON.stringify(envelope), { idempotencyKey: input.operationId, dedupe: true });
          if (!result?.blob_id || !result?.id) return send(502, { error: 'The backup outcome is unknown. Check before retrying.' });
          return send(200, { saved: true });
        }
        const records = []; let cursor;
        for (let page = 0; page < 20; page++) {
          const result = await adapter.list({ namespace, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(result?.memories) || typeof result.has_more !== 'boolean' || result.must_resync) throw Error('Invalid provider response');
          records.push(...result.memories.filter(row => row.namespace_id === namespace && row.blob_id && typeof row.created_at === 'string'));
          if (!result.has_more) break;
          if (!result.next_cursor || result.next_cursor === cursor || page === 19) throw Error('Invalid provider response');
          cursor = result.next_cursor;
        }
        if (!records.length) return send(404, { error: 'No recovery backup found.' });
        records.sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (records.length > 1 && records[0].created_at === records[1].created_at) throw Error('Ambiguous newest backup');
        const found = await adapter.search(backupPrefix, 100, { sort: 'recent' });
        if (!Array.isArray(found?.results) || found.dropped_count || found.meta?.truncated) throw Error('Invalid provider response');
        const match = found.results.find(row => row.blob_id === records[0].blob_id && typeof row.text === 'string' && row.text.startsWith(backupPrefix));
        if (!match) throw Error('Newest backup is not retrievable');
        return send(200, { envelope: JSON.parse(match.text.slice(backupPrefix.length)) });
      }
      if (input.action === 'remember') {
        const result = await adapter.remember(memory, { idempotencyKey: input.operationId, dedupe: true });
        if (!result?.blob_id) return send(502, { error: 'The write outcome is unknown. Check Walrus before retrying.' });
        if (mainnet && (typeof result.id !== 'string' || !result.id)) throw Error('Invalid provider response');
        return send(200, mainnet ? { saved: true, memoryId: result.id, blobId: result.blob_id } : { saved: true });
      }
      if (input.action === 'listDemo') {
        const ids = []; let cursor;
        for (let page = 0; page < 20; page++) {
          const result = await adapter.list({ namespace, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(result?.memories) || typeof result.has_more !== 'boolean' || result.must_resync) throw Error('Invalid provider response');
          ids.push(...result.memories.filter(row => row.namespace_id === namespace && typeof row.memory_id === 'string' && typeof row.blob_id === 'string' && row.blob_id).map(row => row.memory_id));
          if (!result.has_more) return send(200, { memoryIds: [...new Set(ids)] });
          if (typeof result.next_cursor !== 'string' || !result.next_cursor || result.next_cursor === cursor) throw Error('Invalid provider response');
          cursor = result.next_cursor;
        }
        throw Error('Too many pages');
      }
      const query = input.action === 'recallHabit' ? habitPrefix : 'COINJAR_PHONE_PREFERENCES_';
      const result = await adapter.search(query, 10, input.action === 'recallHabit' ? { sort: 'recent' } : {});
      if (!Array.isArray(result?.results) || result.dropped_count || result.meta?.truncated) throw Error('Invalid provider response');
      const memories = result.results.flatMap(row => { try { const text = safeMemory(row.text); return text.startsWith(query) ? [text] : []; } catch { return []; } });
      return send(200, { memories });
    } catch (error) {
      if (error instanceof SyntaxError || error?.message === 'Invalid request' || error?.message === 'Invalid memory') return send(400, { error: 'Invalid memory request.' });
      return send(502, { error: 'Walrus is unavailable or the write outcome is unknown. Check Walrus before retrying.' });
    }
  };
}
