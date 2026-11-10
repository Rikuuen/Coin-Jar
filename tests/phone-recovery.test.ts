import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { encryptJournal, decryptJournal } from '../src/journalCipher';
import { newJournal, savings, upgradeGoals, validateJournal } from '../src/phoneJournal';

test('encrypted journal recovery authenticates ciphertext and keeps the key separate from the access token', async () => {
  const code = randomBytes(32).toString('base64url'), wrong = randomBytes(32).toString('base64url');
  const journal = newJournal('PHP', 100000, '2026-01-01', 'Fictional');
  journal.walletAddress = '0x' + 'a'.repeat(64);
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

test('encrypted recovery preserves multiple goals and their savings', async () => {
  const legacy = newJournal('PHP', 1000000, '2026-01-01');
  legacy.goal = { id: 'first', title: 'Emergency', targetCents: 500000, targetDate: '2026-01-20', status: 'active', createdAt: '' };
  legacy.entries.push({ id: 'a', kind: 'contribution', amountCents: 120000, date: '2026-01-09', note: '', createdAt: '' });
  const upgraded = upgradeGoals(legacy);
  upgraded.otherGoals!.push({ id: 'second', title: 'Trip', targetCents: 300000, targetDate: '2026-01-20', status: 'active', createdAt: '' });
  upgraded.entries.push({ id: 'b', kind: 'contribution', goalId: 'second', amountCents: 30000, date: '2026-01-09', note: '', createdAt: '' });
  const code = randomBytes(32).toString('base64url');
  const { envelope } = await encryptJournal(code, upgraded);
  const restored = await decryptJournal(code, envelope);
  assert.deepEqual(restored, validateJournal(upgraded));
  assert.equal(savings(restored, '2026-01-09').summary.savedCents, 120000);
  assert.equal(savings(restored, '2026-01-09').summary.availableCents, 850000);
  assert.throws(() => validateJournal({ ...restored, entries: [...restored.entries, { id: 'bad', kind: 'contribution', goalId: 'missing', amountCents: 1, date: '2026-01-09', note: '', createdAt: '' }] }));
});

test('encrypted recovery preserves corrected entries without double counting', async () => {
  const legacy = newJournal('PHP', 100000, '2026-01-01');
  legacy.goal = { id: 'g', title: 'Goal', targetCents: 50000, targetDate: '2026-01-20', status: 'active', createdAt: '' };
  legacy.entries.push({ id: 'a', kind: 'contribution', amountCents: 10000, date: '2026-01-09', note: '', createdAt: '' });
  const upgraded = upgradeGoals(legacy);
  const journal = { ...upgraded, version: 3 as const, entries: [{ ...upgraded.entries[0], voidedAt: '2026-01-10T00:00:00Z' }, { id: 'b', kind: 'contribution' as const, goalId: 'g', correctionOf: 'a', amountCents: 7000, date: '2026-01-09', note: '', createdAt: '2026-01-10T00:00:00Z' }] };
  const code = randomBytes(32).toString('base64url'); const { envelope } = await encryptJournal(code, journal); const restored = await decryptJournal(code, envelope);
  assert.equal(restored.entries.length, 2);
  assert.equal(savings(restored, '2026-01-10').summary.savedCents, 7000);
  assert.equal(savings(restored, '2026-01-10').summary.availableCents, 93000);
  assert.throws(() => validateJournal({ ...restored, entries: [...restored.entries, { ...restored.entries[1], id: 'duplicate' }] }));
});
