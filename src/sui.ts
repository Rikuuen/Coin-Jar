export function parseSui(input: string): string {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(input.trim());
  if (!match) throw new Error('Enter a SUI amount with at most 9 decimal places.');
  const amount = BigInt(match[1]) * 1000000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
  if (amount <= 0n || amount > 18446744073709551615n) throw new Error('Enter a valid positive SUI amount.');
  return amount.toString();
}

export function formatSui(mist: string): string {
  if (!/^\d+$/.test(mist)) throw new Error('Invalid SUI amount.');
  const digits = mist.padStart(10, '0');
  return `${digits.slice(0, -9)}.${digits.slice(-9)}`.replace(/0+$/, '').replace(/\.$/, '');
}

export function estimateGas(gas: { computationCost: string; storageCost: string; storageRebate: string }) {
  if (![gas.computationCost, gas.storageCost, gas.storageRebate].every((value) => /^\d+$/.test(value))) throw new Error('A usable fee estimate is unavailable.');
  const gross = BigInt(gas.computationCost) + BigInt(gas.storageCost);
  const fee = gross - BigInt(gas.storageRebate);
  const budget = (gross * 125n + 99n) / 100n;
  if (fee < 0n || budget <= 0n || budget > 18446744073709551615n) throw new Error('A usable gas budget is unavailable.');
  return { fee: fee.toString(), budget: budget.toString() };
}

export function suiToPhpCentavos(mist: string, rate: string): number {
  if (!/^\d+$/.test(mist) || rate.length > 64 || !/^\d+(?:\.\d+)?$/.test(rate)) throw new Error('Invalid SUI quote.');
  const [whole, fraction = ''] = rate.split('.');
  const numerator = BigInt(whole + fraction);
  if (!numerator) throw new Error('Invalid SUI quote.');
  const divisor = 1000000000n * 10n ** BigInt(fraction.length);
  const value = (BigInt(mist) * numerator * 100n + divisor / 2n) / divisor;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Quote is too large.');
  return Number(value);
}
