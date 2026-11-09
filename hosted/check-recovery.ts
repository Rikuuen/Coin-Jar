import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';

const lines: string[] = [];
const input = createInterface({ input: process.stdin, terminal: false });
for await (const line of input) { lines.push(line); if (lines.length === 2) break; }
if (lines.length !== 2 || lines[0] === lines[1]) throw new Error('Two separate test databases are required');
const source = new Pool({ connectionString: lines[0], max: 1 });
const target = new Pool({ connectionString: lines[1], max: 1 });
const tables = [
  { name: 'coinjar_journals', fields: ['owner_id', 'revision', 'created_at'], order: 'owner_id' },
  { name: 'coinjar_entries', fields: ['id', 'owner_id', 'kind', 'amount_centavos', 'entry_date', 'note', 'created_at'], order: 'id' },
  { name: 'coinjar_goals', fields: ['id', 'owner_id', 'title', 'target_centavos', 'target_date', 'status', 'created_at'], order: 'id' },
  { name: 'coinjar_operations', fields: ['owner_id', 'operation_id', 'request_hash', 'response', 'created_at'], order: 'owner_id, operation_id' },
] as const;
const read = async (pool: Pool) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const records = [];
    for (const table of tables) {
      const fields = table.fields.map((field) => ['entry_date', 'target_date'].includes(field) ? `${field}::text AS ${field}` : field);
      records.push((await client.query(`SELECT ${fields.join(',')} FROM ${table.name} ORDER BY ${table.order}`)).rows);
    }
    await client.query('COMMIT');
    return records;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
try {
  const records = await read(source);
  assert.ok(records[0].length > 0 && records[1].length > 0 && records[2].length > 0);
  const empty = await read(target);
  assert.ok(empty.every((rows) => rows.length === 0), 'Recovery target must be empty');
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()]);
  await mkdir('.data', { recursive: true });
  const path = `.data/recovery-test-${Date.now()}.enc`;
  await writeFile(path, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx' });
  const backup = await readFile(path);
  const decipher = createDecipheriv('aes-256-gcm', key, backup.subarray(0, 12));
  decipher.setAuthTag(backup.subarray(12, 28));
  const recovered = JSON.parse(Buffer.concat([decipher.update(backup.subarray(28)), decipher.final()]).toString('utf8')) as Array<Array<Record<string, unknown>>>;
  const client = await target.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      for (const row of recovered[i]) {
        const fields = table.fields;
        await client.query(`INSERT INTO ${table.name} (${fields.join(',')}) VALUES (${fields.map((_, n) => `$${n + 1}`).join(',')})`, fields.map((field) => row[field]));
      }
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  assert.equal(JSON.stringify(await read(target)), JSON.stringify(records), 'Restored records did not match the backup');
  console.log(`PASS: encrypted synthetic backup restored into separate test branch; ${records.map((rows) => rows.length).join('/')} rows match`);
} finally { await source.end(); await target.end(); }
