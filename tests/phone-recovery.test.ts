import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { encryptJournal, decryptJournal } from '../src/journalCipher';
import { newJournal } from '../src/phoneJournal';

test('encrypted journal recovery authenticates ciphertext and keeps the key separate from the access token', async () => {
  const code = randomBytes(32).toString('base64url'), wrong = randomBytes(32).toString('base64url');
  const journal = newJournal('PHP', 100000, '2026-01-01', 'Fictional');
  journal.goal = { id: 'g', title: 'Fictional goal', targetCents: 50000, targetDate: '2026-01-10', phoneStartDate: '2026-01-01', phoneBaselineCents: 5000, status: 'active', createdAt: '2026-01-01T00:00:00Z', wallet: { address: '0x' + 'a'.repeat(64) } };
  journal.entries.push({ id: 'e1', kind: 'expense', amountCents: 1234, date: '2026-01-02', note: 'fictional lunch', createdAt: '2026-01-02T00:00:00Z' });
  const { token, envelope } = await encryptJournal(code, journal);
  assert.notEqual(token, code);
  assert.ok(!JSON.stringify(envelope).includes('fictional lunch'));
  assert.deepEqual(await decryptJournal(code, envelope), journal);
  await assert.rejects(decryptJournal(wrong, envelope));
  const bytes = Buffer.from(envelope.ciphertext, 'base64url'); bytes[0] ^= 1;
  await assert.rejects(decryptJournal(code, { ...envelope, ciphertext: bytes.toString('base64url') }));
});
