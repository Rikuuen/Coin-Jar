const endpoint =
  'https://api.tatum.io/v4/data/rate/symbol?symbol=PHP&basePair=USD';

function rateParts(value) {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^\d+(?:\.\d+)?$/.test(value)
  )
    throw new Error('Invalid exchange rate');
  const [whole, fraction = ''] = value.split('.');
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) throw new Error('Invalid exchange rate');
  return { numerator, scale: 10n ** BigInt(fraction.length) };
}

export function phpCentavosToUsdMicrodollars(centavos, rate) {
  if (
    (typeof centavos !== 'string' && typeof centavos !== 'bigint') ||
    !/^\d+$/.test(String(centavos))
  )
    throw new Error('Invalid PHP amount');
  const { numerator, scale } = rateParts(rate);
  const dividend = BigInt(centavos) * 10000n * numerator;
  return ((dividend + scale / 2n) / scale).toString();
}

/** @param {{apiKey?: string, fetch?: typeof globalThis.fetch, now?: () => number}} options */
export function createFxAdapter({
  apiKey,
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!apiKey) throw new Error('Tatum is not configured');
  return {
    async getSuiPhpRate() {
      let data;
      try {
        const response = await fetch('https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=PHP', {
          headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error();
        data = await response.json();
      } catch { throw new Error('SUI price unavailable'); }
      if (data?.basePair !== 'PHP' || data?.symbol !== 'SUI') throw new Error('Invalid SUI price pair');
      rateParts(data.value);
      if (!Number.isSafeInteger(data.timestamp) || data.timestamp > now() || now() - data.timestamp > 600000 || typeof data.source !== 'string' || !data.source.trim() || data.source.length > 80) throw new Error('SUI price is stale or invalid');
      return { value: data.value, basePair: 'PHP', symbol: 'SUI', timestamp: data.timestamp, source: data.source };
    },
    async getRate() {
      let data;
      try {
        const response = await fetch(endpoint, {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error();
        data = await response.json();
      } catch {
        throw new Error('Exchange rate service unavailable');
      }
      if (data?.basePair !== 'USD' || data?.symbol !== 'PHP')
        throw new Error('Invalid exchange rate pair');
      rateParts(data.value);
      if (
        !Number.isSafeInteger(data.timestamp) ||
        data.timestamp > now() ||
        now() - data.timestamp > 86400000
      )
        throw new Error('Exchange rate is stale or invalid');
      return {
        value: data.value,
        basePair: data.basePair,
        symbol: data.symbol,
        timestamp: data.timestamp,
        source: data.source,
      };
    },
  };
}
