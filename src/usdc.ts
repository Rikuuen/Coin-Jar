export const USDC_TYPES = {
  mainnet: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  testnet: '0xc028557a1ed49e42ed091e115aedefd70a442b184c18fbec5c48d5b6c0b8c184::usdc::USDC',
} as const;

export function makeUsdcTransfer(sender: string, recipient: string, amount: string, id: string, network: 'mainnet' | 'testnet', budget?: string) {
  const transaction = new Transaction();
  transaction.setSender(sender);
  if (budget) transaction.setGasBudget(budget);
  transaction.pure.string(`coinjar:${id}`);
  transaction.transferObjects([transaction.coin({ balance: BigInt(amount), type: USDC_TYPES[network] })], recipient);
  return transaction;
}

export function parseUsdc(input: string): string {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) throw new Error('Enter a USDC amount with at most 6 decimal places.');
  const amount = BigInt(match[1]) * 1000000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (amount <= 0n || amount > 18446744073709551615n) throw new Error('Enter a valid positive USDC amount.');
  return amount.toString();
}

export function formatUsdc(amount: string): string {
  if (!/^\d+$/.test(amount)) throw new Error('Invalid USDC amount.');
  const digits = amount.padStart(7, '0');
  return `${digits.slice(0, -6)}.${digits.slice(-6)}`.replace(/0+$/, '').replace(/\.$/, '');
}

export function usdcToPhpCentavos(amount: string, usdPerPhp: string): number {
  if (!/^\d+$/.test(amount) || usdPerPhp.length > 64 || !/^\d+(?:\.\d+)?$/.test(usdPerPhp)) throw new Error('Invalid rate.');
  const [whole, fraction = ''] = usdPerPhp.split('.');
  const rate = BigInt(whole + fraction);
  if (!rate) throw new Error('Invalid rate.');
  const divisor = rate * 10000n;
  const cents = (BigInt(amount) * 10n ** BigInt(fraction.length) + divisor / 2n) / divisor;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Value is too large.');
  return Number(cents);
}
import { Transaction } from '@mysten/sui/transactions';

