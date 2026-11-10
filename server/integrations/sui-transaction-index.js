const endpoint = 'https://graphql.testnet.sui.io/graphql';
const query = `query FindTransactions($address: SuiAddress!, $before: String) {
  transactions(last: 25, before: $before, filter: { affectedAddress: $address }) {
    nodes { digest effects { timestamp status balanceChangesJson } }
    pageInfo { hasPreviousPage startCursor }
  }
}`;

export async function findMatchingReceipts({ address, coinType, amount, since, fetcher = fetch }) {
  if (!/^0x[0-9a-f]{64}$/.test(address) || !/^[1-9]\d{0,19}$/.test(amount) || !Number.isFinite(since)) throw Error('Invalid receipt search');
  const matches = []; let before = null;
  for (let page = 0; page < 4; page++) {
    const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables: { address, before } }), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw Error('Transaction index unavailable');
    const data = await response.json(), transactions = data?.data?.transactions;
    if (data.errors || !Array.isArray(transactions?.nodes) || typeof transactions.pageInfo?.hasPreviousPage !== 'boolean') throw Error('Invalid transaction index response');
    let reachedOlder = false;
    for (const node of transactions.nodes) {
      const timestamp = Date.parse(node?.effects?.timestamp);
      if (!Number.isFinite(timestamp) || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(node?.digest ?? '') || !Array.isArray(node.effects.balanceChangesJson) || node.effects.balanceChangesJson.length > 1000) throw Error('Invalid indexed transaction');
      if (timestamp < since) { reachedOlder = true; continue; }
      if (node.effects.status !== 'SUCCESS') continue;
      let total = 0n;
      for (const change of node.effects.balanceChangesJson) {
        if (change?.address?.toLowerCase() === address && change.coinType === coinType) {
          if (typeof change.amount !== 'string' || !/^-?\d{1,80}$/.test(change.amount)) throw Error('Invalid indexed balance change');
          total += BigInt(change.amount);
        }
      }
      if (total === BigInt(amount)) matches.push(node.digest);
    }
    if (reachedOlder || !transactions.pageInfo.hasPreviousPage) return [...new Set(matches)];
    const next = transactions.pageInfo.startCursor;
    if (!next || next === before) throw Error('Invalid transaction cursor');
    before = next;
  }
  throw Error('Too many transactions to check safely');
}
