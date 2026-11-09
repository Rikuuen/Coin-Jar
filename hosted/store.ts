import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { validateDate } from '../src/domain';

export class TrackingConflict extends Error {}
export class TrackingNotFound extends Error {}
type EntryInput = { kind: 'income' | 'expense' | 'recorded_saving'; amountCentavos: number; date: string; note: string };
type GoalInput = { title: string; targetCentavos: number; targetDate?: string };
type Result = { id: string; revision: string };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function amount(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000_000_000) throw new Error('Invalid amount');
}
function principal(value: string) {
  if (!value || value.length > 255) throw new Error('Invalid authenticated principal');
}
function operation(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid operation ID');
}
async function ensureAfterOpening(client: PoolClient, owner: string, date: string) {
  const journal = await client.query('SELECT preferences FROM coinjar_journals WHERE owner_id=$1', [owner]);
  const openingDate = journal.rows[0]?.preferences?.openingCashDate;
  if (openingDate && date < openingDate) throw new TrackingConflict('Entries must be on or after your starting balance date');
}

export class TrackingStore {
  constructor(private pool: Pool) {}

  async snapshot(owner: string) {
    principal(owner);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('coinjar.owner', $1, true)", [owner]);
      const journal = await client.query('SELECT revision::text, preferences, bills, wallet_address FROM coinjar_journals WHERE owner_id=$1', [owner]);
      const entries = await client.query('SELECT e.id, e.kind, e.amount_centavos::text, e.entry_date::text, e.note, e.created_at, v.created_at AS voided_at, v.reason AS void_reason, v.replacement_id FROM coinjar_entries e LEFT JOIN coinjar_entry_voids v ON v.owner_id=e.owner_id AND v.entry_id=e.id WHERE e.owner_id=$1 ORDER BY e.entry_date DESC, e.created_at DESC, e.id DESC', [owner]);
      const goal = await client.query('SELECT id, title, target_centavos::text, target_date::text, status, created_at FROM coinjar_goals WHERE owner_id=$1', [owner]);
      await client.query('COMMIT');
      const saved = journal.rows[0];
      const preferences = saved?.preferences ?? { bufferCents: 20000, dailyLimitCents: 1500, pace: 'steady', currency: 'PHP' };
      const setupRequired = !preferences.setupComplete && (!saved || saved.revision === '0') && entries.rows.length === 0 && goal.rows.length === 0;
      return { revision: saved?.revision ?? '0', preferences, setupRequired, bills: saved?.bills ?? [], walletAddress: saved?.wallet_address ?? null, entries: entries.rows, goal: goal.rows[0] ?? null };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async setup(owner: string, operationId: string, revision: string, input: { currency: 'PHP' | 'USD'; openingCashCents: number; openingCashDate: string }) {
    if (!['PHP', 'USD'].includes(input.currency) || !Number.isSafeInteger(input.openingCashCents) || input.openingCashCents < 0 || input.openingCashCents > 10_000_000_000 || !validateDate(input.openingCashDate) || input.openingCashDate > today()) throw new Error('Invalid setup');
    return this.write(owner, operationId, revision, { type: 'setup', ...input }, async (client) => {
      const prior = await client.query("SELECT preferences, revision::text AS revision, EXISTS (SELECT 1 FROM coinjar_entries WHERE owner_id=$1) AS has_entries, EXISTS (SELECT 1 FROM coinjar_goals WHERE owner_id=$1) AS has_goal FROM coinjar_journals WHERE owner_id=$1", [owner]);
      if (prior.rows[0].revision !== '0' || prior.rows[0].preferences?.setupComplete || prior.rows[0].has_entries || prior.rows[0].has_goal) throw new TrackingConflict('This journal is already set up');
      const preferences = { ...prior.rows[0].preferences, currency: input.currency, openingCashCents: input.openingCashCents, openingCashDate: input.openingCashDate, setupComplete: true };
      await client.query('UPDATE coinjar_journals SET preferences=$2::jsonb WHERE owner_id=$1', [owner, JSON.stringify(preferences)]);
      return owner;
    });
  }

  async setBalance(owner: string, operationId: string, revision: string, value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000_000) throw new Error('Invalid amount');
    const date = today();
    return this.write(owner, operationId, revision, { type: 'balance', value }, async (client) => {
      const journal = await client.query('SELECT preferences FROM coinjar_journals WHERE owner_id=$1', [owner]);
      const preferences = journal.rows[0].preferences;
      const adjustments = preferences.balanceAdjustments ?? [];
      if (!Array.isArray(adjustments)) throw new Error('Invalid balance history');
      const current = await client.query("SELECT COALESCE(SUM(CASE WHEN e.kind='income' THEN e.amount_centavos ELSE -e.amount_centavos END),0)::text AS total FROM coinjar_entries e LEFT JOIN coinjar_entry_voids v ON v.owner_id=e.owner_id AND v.entry_id=e.id WHERE e.owner_id=$1 AND e.entry_date <= $2 AND v.entry_id IS NULL", [owner, date]);
      let balance = BigInt(preferences.openingCashCents ?? 0) + BigInt(current.rows[0].total);
      for (const adjustment of adjustments) {
        if (!Number.isSafeInteger(adjustment.deltaCents) || !validateDate(adjustment.date)) throw new Error('Invalid balance history');
        if (adjustment.date <= date) balance += BigInt(adjustment.deltaCents);
      }
      const delta = BigInt(value) - balance;
      if (delta > BigInt(Number.MAX_SAFE_INTEGER) || delta < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Invalid amount');
      const id = randomUUID();
      preferences.balanceAdjustments = [...adjustments, { id, date, deltaCents: Number(delta), createdAt: new Date().toISOString() }];
      await client.query('UPDATE coinjar_journals SET preferences=$2::jsonb WHERE owner_id=$1', [owner, JSON.stringify(preferences)]);
      return id;
    });
  }

  private async write(owner: string, operationId: string, expectedRevision: string, payload: unknown, action: (client: PoolClient) => Promise<string>): Promise<Result> {
    principal(owner); operation(operationId);
    if (!/^(0|[1-9]\d{0,18})$/.test(expectedRevision)) throw new Error('Invalid revision');
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('coinjar.owner', $1, true)", [owner]);
      await client.query('INSERT INTO coinjar_journals(owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
      const journal = await client.query('SELECT revision::text FROM coinjar_journals WHERE owner_id=$1 FOR UPDATE', [owner]);
      const prior = await client.query('SELECT request_hash, response FROM coinjar_operations WHERE owner_id=$1 AND operation_id=$2', [owner, operationId]);
      if (prior.rows.length) {
        if (prior.rows[0].request_hash !== hash) throw new TrackingConflict('Operation ID already used for different input');
        await client.query('COMMIT');
        return prior.rows[0].response as Result;
      }
      if (journal.rows[0].revision !== expectedRevision) throw new TrackingConflict('Journal changed; refresh before saving');
      const id = await action(client);
      const updated = await client.query('UPDATE coinjar_journals SET revision=revision+1 WHERE owner_id=$1 RETURNING revision::text', [owner]);
      const result = { id, revision: updated.rows[0].revision as string };
      await client.query('INSERT INTO coinjar_operations(owner_id, operation_id, request_hash, response) VALUES ($1,$2,$3,$4::jsonb)', [owner, operationId, hash, JSON.stringify(result)]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async addEntry(owner: string, operationId: string, revision: string, input: EntryInput) {
    if (!['income', 'expense', 'recorded_saving'].includes(input.kind)) throw new Error('Invalid entry type');
    amount(input.amountCentavos);
    if (!validateDate(input.date) || input.date > today() || typeof input.note !== 'string' || input.note.length > 80) throw new Error('Invalid entry');
    const value = { type: 'entry', kind: input.kind, amountCentavos: input.amountCentavos, date: input.date, note: input.note.trim() };
    return this.write(owner, operationId, revision, value, async (client) => {
      await ensureAfterOpening(client, owner, input.date);
      const id = randomUUID();
      await client.query('INSERT INTO coinjar_entries(id,owner_id,kind,amount_centavos,entry_date,note) VALUES ($1,$2,$3,$4,$5,$6)', [id, owner, value.kind, value.amountCentavos, value.date, value.note]);
      return id;
    });
  }

  async saveGoal(owner: string, operationId: string, revision: string, input: GoalInput) {
    amount(input.targetCentavos);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 80 || (input.targetDate && !validateDate(input.targetDate))) throw new Error('Invalid goal');
    const value = { type: 'goal', title: input.title.trim(), targetCentavos: input.targetCentavos, targetDate: input.targetDate ?? null };
    return this.write(owner, operationId, revision, value, async (client) => {
      const id = randomUUID();
      const row = await client.query('INSERT INTO coinjar_goals(id,owner_id,title,target_centavos,target_date) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id) DO UPDATE SET title=EXCLUDED.title,target_centavos=EXCLUDED.target_centavos,target_date=EXCLUDED.target_date RETURNING id', [id, owner, value.title, value.targetCentavos, value.targetDate]);
      return row.rows[0].id as string;
    });
  }

  async saveSettings(owner: string, operationId: string, revision: string, input: { bufferCents: number; dailyLimitCents: number; pace: string; walletAddress: string | null; weekend?: boolean }, restored?: { id: string; preferences: Record<string, unknown> }) {
    for (const n of [input.bufferCents, input.dailyLimitCents]) if (!Number.isSafeInteger(n) || n < 0 || n > 10_000_000_000) throw new Error('Invalid amount');
    if (!['gentle', 'steady', 'focused'].includes(input.pace) || (input.walletAddress !== null && !/^0x[0-9a-fA-F]{64}$/.test(input.walletAddress))) throw new Error('Invalid settings');
    if (input.weekend !== undefined && typeof input.weekend !== 'boolean') throw new Error('Invalid settings');
    const source = restored?.preferences.limitProvenance as { origin?: string; observations?: unknown } | undefined;
    const origin = restored ? (['manual', 'confirmed', 'explicit'].includes(source?.origin ?? '') ? source!.origin : 'unknown') : 'manual';
    const observations = Array.isArray(source?.observations) ? source.observations.filter((v: unknown): v is string => typeof v === 'string' && v.length <= 200).slice(0, 20) : undefined;
    const bufferSource = restored?.preferences.bufferProvenance as { origin?: string } | undefined;
    const paceSource = restored?.preferences.paceProvenance as { origin?: string } | undefined;
    return this.write(owner, operationId, revision, { type: 'settings', ...input, restoredFrom: restored?.id ?? null }, async (client) => {
      const prior = await client.query('SELECT preferences FROM coinjar_journals WHERE owner_id=$1', [owner]);
      const preferences = { ...prior.rows[0].preferences, bufferCents: input.bufferCents, dailyLimitCents: input.dailyLimitCents, pace: input.pace, confirmedWeekend: input.weekend ?? false, bufferProvenance: { origin: restored && bufferSource?.origin !== 'manual' ? 'unknown' : 'manual', ...(restored ? { restored: true } : {}) }, limitProvenance: { origin, ...(restored ? { restored: true, remoteId: restored.id } : {}), ...(observations ? { observations } : {}) }, paceProvenance: { origin: restored && paceSource?.origin !== 'manual' ? 'unknown' : 'manual', ...(restored ? { restored: true } : {}) } };
      await client.query('UPDATE coinjar_journals SET preferences=$2::jsonb, wallet_address=$3 WHERE owner_id=$1', [owner, JSON.stringify(preferences), input.walletAddress]);
      return owner;
    });
  }

  async addBill(owner: string, operationId: string, revision: string, input: { title: string; amountCents: number; dueDate: string }) {
    amount(input.amountCents);
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 80 || !validateDate(input.dueDate)) throw new Error('Invalid bill');
    const value = { type: 'bill', title: input.title.trim(), amountCents: input.amountCents, dueDate: input.dueDate };
    return this.write(owner, operationId, revision, value, async (client) => {
      const id = randomUUID();
      await client.query("UPDATE coinjar_journals SET bills=bills || $2::jsonb WHERE owner_id=$1", [owner, JSON.stringify([{ id, title: value.title, amountCents: value.amountCents, dueDate: value.dueDate, paid: false }])]);
      return id;
    });
  }

  async payBill(owner: string, operationId: string, revision: string, input: { billId: string; date: string }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.billId) || !validateDate(input.date) || input.date > today()) throw new Error('Invalid bill');
    return this.write(owner, operationId, revision, { type: 'bill-payment', ...input }, async (client) => {
      await ensureAfterOpening(client, owner, input.date);
      const journal = await client.query('SELECT bills FROM coinjar_journals WHERE owner_id=$1', [owner]);
      const bills = journal.rows[0].bills as Array<{ id: string; title: string; amountCents: number; paid: boolean; paidEntryId?: string }>;
      const bill = bills.find(item => item.id === input.billId);
      if (!bill) throw new TrackingNotFound('Bill not found');
      if (bill.paid) throw new TrackingConflict('Bill already paid');
      const id = randomUUID();
      await client.query('INSERT INTO coinjar_entries(id,owner_id,kind,amount_centavos,entry_date,note) VALUES ($1,$2,$3,$4,$5,$6)', [id, owner, 'expense', bill.amountCents, input.date, bill.title]);
      bill.paid = true; bill.paidEntryId = id;
      await client.query('UPDATE coinjar_journals SET bills=$2::jsonb WHERE owner_id=$1', [owner, JSON.stringify(bills)]);
      return id;
    });
  }

  async voidEntry(owner: string, operationId: string, revision: string, input: { entryId: string; reason: string; replacement?: EntryInput }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.entryId) || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200) throw new Error('Invalid correction');
    const replacement = input.replacement;
    if (replacement) {
      if (!['income', 'expense', 'recorded_saving'].includes(replacement.kind)) throw new Error('Invalid entry type');
      amount(replacement.amountCentavos);
      if (!validateDate(replacement.date) || replacement.date > today() || typeof replacement.note !== 'string' || replacement.note.length > 80) throw new Error('Invalid entry');
    }
    const payload = { type: 'void', entryId: input.entryId, reason: input.reason.trim(), replacement: replacement ?? null };
    return this.write(owner, operationId, revision, payload, async (client) => {
      const original = await client.query('SELECT e.id, v.entry_id AS voided FROM coinjar_entries e LEFT JOIN coinjar_entry_voids v ON v.owner_id=e.owner_id AND v.entry_id=e.id WHERE e.owner_id=$1 AND e.id=$2', [owner, input.entryId]);
      if (!original.rows.length) throw new TrackingNotFound('Entry not found');
      if (original.rows[0].voided) throw new TrackingConflict('Entry already voided');
      const journal = await client.query('SELECT bills FROM coinjar_journals WHERE owner_id=$1', [owner]);
      const bills = journal.rows[0].bills as Array<{ paid: boolean; paidEntryId?: string }>;
      const linked = bills.find(bill => bill.paidEntryId === input.entryId);
      if (linked && replacement && replacement.kind !== 'expense') throw new TrackingConflict('A bill payment must remain an expense');
      let replacementId: string | null = null;
      if (replacement) {
        await ensureAfterOpening(client, owner, replacement.date);
        replacementId = randomUUID();
        await client.query('INSERT INTO coinjar_entries(id,owner_id,kind,amount_centavos,entry_date,note) VALUES ($1,$2,$3,$4,$5,$6)', [replacementId, owner, replacement.kind, replacement.amountCentavos, replacement.date, replacement.note.trim()]);
      }
      await client.query('INSERT INTO coinjar_entry_voids(owner_id,entry_id,reason,replacement_id) VALUES ($1,$2,$3,$4)', [owner, input.entryId, payload.reason, replacementId]);
      if (linked) {
        linked.paid = Boolean(replacementId);
        if (replacementId) linked.paidEntryId = replacementId; else delete linked.paidEntryId;
        await client.query('UPDATE coinjar_journals SET bills=$2::jsonb WHERE owner_id=$1', [owner, JSON.stringify(bills)]);
      }
      return input.entryId;
    });
  }

  async beginMemory(owner: string, operationId: string, text: string) {
    principal(owner); operation(operationId);
    const hash = createHash('sha256').update(text).digest('hex');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('coinjar.owner', $1, true)", [owner]);
      await client.query('INSERT INTO coinjar_journals(owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
      await client.query('SELECT owner_id FROM coinjar_journals WHERE owner_id=$1 FOR UPDATE', [owner]);
      const prior = await client.query('SELECT request_hash,status,remote_id FROM coinjar_memory_sync WHERE owner_id=$1 AND operation_id=$2', [owner, operationId]);
      if (prior.rows.length) {
        if (prior.rows[0].request_hash !== hash) throw new TrackingConflict('Operation ID already used for different input');
        if (prior.rows[0].status !== 'stored') throw new TrackingConflict('Memory upload outcome is unknown; do not retry automatically');
        await client.query('COMMIT');
        return { send: false, remoteId: String(prior.rows[0].remote_id) };
      }
      const unknown = await client.query("SELECT 1 FROM coinjar_memory_sync WHERE owner_id=$1 AND status='unknown' LIMIT 1", [owner]);
      if (unknown.rowCount) throw new TrackingConflict('Memory upload outcome is unknown; do not retry automatically');
      await client.query("INSERT INTO coinjar_memory_sync(owner_id,operation_id,request_hash,status) VALUES ($1,$2,$3,'unknown')", [owner, operationId, hash]);
      await client.query('COMMIT');
      return { send: true };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async finishMemory(owner: string, operationId: string, remoteId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('coinjar.owner', $1, true)", [owner]);
      const result = await client.query("UPDATE coinjar_memory_sync SET status='stored',remote_id=$3 WHERE owner_id=$1 AND operation_id=$2 AND status='unknown'", [owner, operationId, remoteId]);
      if (result.rowCount !== 1) throw new Error('Memory operation is unavailable');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
