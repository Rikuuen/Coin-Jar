import { randomUUID } from 'node:crypto';
import { bcs } from '@mysten/sui/bcs';
import { createTatumAdapter } from './server/integrations/tatum.js';
import { createFxAdapter } from './server/integrations/fx.js';
import { createTestnetStore } from './phone-testnet-store.mjs';

const coin = '0xc028557a1ed49e42ed091e115aedefd70a442b184c18fbec5c48d5b6c0b8c184::usdc::USDC';
const address = x => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x);
const digest = x => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(x);
const active = x => ['awaiting_wallet', 'unknown', 'pending'].includes(x.status);
const state = value => ({ goal: value.goal ?? null, onchainTransfers: value.transfers });

export async function testnetAction(code, input, env, store = createTestnetStore(), adapters = { createTatumAdapter, createFxAdapter }) {
  if (!env.BLOB_READ_WRITE_TOKEN || !env.TATUM_API_KEY) throw Error('Testnet transfer service is unavailable.');
  if (input.action === 'quote') return { rate: await adapters.createFxAdapter({ apiKey: env.TATUM_API_KEY }).getRate() };
  const snapshot = await store.read(code), value = snapshot.value;
  if (input.action === 'state') return { state: state(value) };
  const transfer = value.transfers.find(t => t.id === input.id);
  if (input.action === 'wallet') {
    if (!address(input.address) || typeof input.goalId !== 'string' || !input.goalId || input.goalId.length > 100 || value.transfers.some(active)) throw Error('Resolve any pending test transfer first.');
    value.goal = { id: input.goalId, wallet: { address: input.address.toLowerCase() } };
  } else if (input.action === 'intent') {
    if (!address(input.sender) || !address(input.recipient) || input.sender.toLowerCase() === input.recipient.toLowerCase() || value.goal?.wallet?.address !== input.recipient.toLowerCase() || input.network !== 'testnet' || typeof input.amountMicroUsdc !== 'string' || !/^[1-9]\d{0,19}$/.test(input.amountMicroUsdc) || BigInt(input.amountMicroUsdc) > 18446744073709551615n || value.transfers.some(active)) throw Error('Invalid or pending test transfer.');
    value.transfers.push({ id: randomUUID(), goalId: value.goal.id, network: 'testnet', asset: 'USDC', sender: input.sender.toLowerCase(), recipient: input.recipient.toLowerCase(), amountMicroUsdc: input.amountMicroUsdc, status: 'awaiting_wallet', createdAt: new Date().toISOString() });
  } else if (input.action === 'unknown') {
    if (!transfer || transfer.status !== 'awaiting_wallet') throw Error('Transfer is not awaiting wallet approval.');
    transfer.status = 'unknown';
  } else if (input.action === 'digest') {
    if (!transfer || !['unknown', 'pending'].includes(transfer.status) || !digest(input.digest) || (transfer.digest && transfer.digest !== input.digest) || value.transfers.some(t => t.id !== transfer.id && t.digest === input.digest)) throw Error('Invalid or already used transaction.');
    transfer.digest = input.digest; transfer.status = 'pending';
  } else if (input.action === 'dismiss') {
    if (!transfer || !active(transfer) || input.acknowledged !== true) throw Error('Check your wallet before dismissing this test.');
    transfer.status = 'dismissed';
  } else if (input.action === 'verify') {
    if (!transfer || transfer.status !== 'pending' || !digest(transfer.digest)) throw Error('Transaction is not ready for verification.');
    const tx = await (await adapters.createTatumAdapter({ apiKey: env.TATUM_API_KEY, network: 'testnet' })).getTransaction(transfer.digest);
    const marker = bcs.String.serialize(`coinjar:${transfer.id}`).toBase64();
    if (tx.network !== 'testnet' || tx.digest !== transfer.digest || typeof tx.success !== 'boolean' || typeof tx.checkpoint !== 'string' || !/^\d+$/.test(tx.checkpoint) || tx.sender?.toLowerCase() !== transfer.sender || !Array.isArray(tx.inputs) || !tx.inputs.some(x => x?.Pure?.bytes === marker) || !Array.isArray(tx.balanceChanges)) throw Error('Transaction confirmation is unavailable or does not match.');
    if (tx.success) {
      const total = who => tx.balanceChanges.filter(c => typeof c.address === 'string' && c.address.toLowerCase() === who && c.coinType === coin && typeof c.amount === 'string' && /^-?\d{1,80}$/.test(c.amount)).reduce((a, c) => a + BigInt(c.amount), 0n);
      if (total(transfer.recipient) !== BigInt(transfer.amountMicroUsdc) || total(transfer.sender) > -BigInt(transfer.amountMicroUsdc)) throw Error('Test transfer does not match the reviewed amount and recipient.');
      const rate = await adapters.createFxAdapter({ apiKey: env.TATUM_API_KEY }).getRate();
      const [whole, fraction = ''] = rate.value.split('.');
      const denominator = BigInt(whole + fraction) * 10000n;
      if (!denominator) throw Error('Exchange rate is unavailable.');
      const cents = (BigInt(transfer.amountMicroUsdc) * 10n ** BigInt(fraction.length) + denominator / 2n) / denominator;
      if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Test transfer value is invalid.');
      transfer.phpValuation = { centavos: Number(cents), rate: rate.value, timestamp: rate.timestamp, source: rate.source };
      await store.claim(code, transfer.digest, transfer.id);
    }
    transfer.status = tx.success ? 'verified' : 'failed'; transfer.checkpoint = tx.checkpoint;
  } else throw Error('Unsupported testnet request.');
  await store.write(snapshot, value);
  return { state: state(value) };
}
