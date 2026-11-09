import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const tables = ['coinjar_journals', 'coinjar_entries', 'coinjar_goals', 'coinjar_operations', 'coinjar_entry_voids', 'coinjar_memory_sync'] as const;
type Row = Record<string, unknown> & { owner_id: string };
export type JournalArchive = { version: 1; owner: string; rows: Record<(typeof tables)[number], Row[]> };

function validateArchive(value: unknown): asserts value is JournalArchive {
  if (!value || typeof value !== 'object') throw new Error('Invalid archive');
  const archive = value as JournalArchive;
  if (archive.version !== 1 || typeof archive.owner !== 'string' || !archive.owner || archive.owner.length > 255 || !archive.rows || typeof archive.rows !== 'object') throw new Error('Invalid archive');
  if (Object.keys(archive.rows).sort().join(',') !== [...tables].sort().join(',')) throw new Error('Invalid archive');
  for (const table of tables) {
    if (!Array.isArray(archive.rows[table]) || archive.rows[table].some(row => !row || typeof row !== 'object' || row.owner_id !== archive.owner)) throw new Error('Invalid archive');
  }
  if (archive.rows.coinjar_journals.length !== 1) throw new Error('Invalid archive');
}

export function encryptArchive(archive: JournalArchive, key: Buffer): Buffer {
  validateArchive(archive);
  if (key.length !== 32) throw new Error('Invalid backup key');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(archive), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('CJ01'), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptArchive(data: Buffer, key: Buffer): JournalArchive {
  if (key.length !== 32 || data.length < 33 || data.subarray(0, 4).toString() !== 'CJ01') throw new Error('Invalid backup');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  const archive: unknown = JSON.parse(Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString('utf8'));
  validateArchive(archive);
  return archive;
}

export async function exportJournal(pool: Pool, owner: string): Promise<JournalArchive> {
  if (!owner || owner.length > 255) throw new Error('Invalid owner');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SELECT set_config('coinjar.owner', $1, true)", [owner]);
    const rows = {} as JournalArchive['rows'];
    for (const table of tables) {
      const value = table === 'coinjar_journals' ? "to_jsonb(t) || jsonb_build_object('revision', t.revision::text)" : 'to_jsonb(t)';
      rows[table] = (await client.query(`SELECT ${value} AS row FROM public.${table} t WHERE owner_id=$1`, [owner])).rows.map(item => item.row as Row);
    }
    await client.query('COMMIT');
    const result: JournalArchive = { version: 1, owner, rows };
    validateArchive(result);
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function restoreJournal(pool: Pool, archive: JournalArchive, targetOwner: string): Promise<void> {
  validateArchive(archive);
  if (!targetOwner || targetOwner.length > 255) throw new Error('Invalid owner');
  if (targetOwner !== archive.owner) throw new Error('Archive owner does not match target');
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('coinjar.owner', $1, true)", [targetOwner]);
    if ((await client.query('SELECT 1 FROM public.coinjar_journals WHERE owner_id=$1', [targetOwner])).rowCount) throw new Error('Restore target is not empty');
    for (const table of tables) {
      const rows = archive.rows[table].map(row => ({ ...row, owner_id: targetOwner }));
      if (rows.length) await client.query(`INSERT INTO public.${table} SELECT * FROM jsonb_populate_recordset(NULL::public.${table}, $1::jsonb)`, [JSON.stringify(rows)]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
