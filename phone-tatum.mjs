import { timingSafeEqual } from 'node:crypto';
import { createTatumAdapter } from './server/integrations/tatum.js';
import { createMemoryAdapter } from './server/integrations/walrus.js';
import { personalNamespace } from './phone-walrus.mjs';
import { testnetAction } from './phone-testnet.mjs';

const validCode = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function createPhoneTatumHandler({ env = process.env, adapterFactory = createTatumAdapter, memoryFactory = createMemoryAdapter, testnetHandler = testnetAction } = {}) {
  return async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
    if (!validCode(env.COINJAR_PHONE_ACCESS_CODE) || !env.COINJAR_PHONE_ORIGIN || !env.TATUM_API_KEY) return send(503, { error: 'Wallet balance is not configured.' });
    const code = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    const personal = req.headers['x-coinjar-memory-user'] === '1';
    if (req.headers.origin !== env.COINJAR_PHONE_ORIGIN || !validCode(code) || (!personal && !timingSafeEqual(Buffer.from(code), Buffer.from(env.COINJAR_PHONE_ACCESS_CODE)))) return send(401, { error: 'Access denied.' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) return send(413, { error: 'Request too large.' }); }
      const input = JSON.parse(body);
      const testnet = req.url?.split('?')[0] === '/api/phone/testnet';
      const transactionLookup = input && Object.keys(input).sort().join(',') === 'address,digest';
      if (testnet && (!personal || !input || typeof input.action !== 'string')) return send(401, { error: 'Enable personal memory before using testnet.' });
      if (!testnet && (!input || (!transactionLookup && Object.keys(input).join(',') !== 'address') || typeof input.address !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.address))) return send(400, { error: 'Enter a valid Sui address.' });
      if (transactionLookup && (typeof input.digest !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(input.digest))) return send(400, { error: 'Enter a valid transaction digest.' });
      if (personal) {
        const key = env.MEMWAL_MAINNET_PRIVATE_KEY || (env.COINJAR_MAINNET_USE_CURRENT_KEY === '1' ? env.MEMWAL_PRIVATE_KEY : undefined);
        if (!key || !env.MEMWAL_MAINNET_ACCOUNT_ID) return send(503, { error: 'Memory verification is unavailable.' });
        const namespace = personalNamespace(code, req.headers['x-coinjar-memory-demo'] === '1');
        const memory = await memoryFactory({ key, accountId: env.MEMWAL_MAINNET_ACCOUNT_ID, serverUrl: 'https://relayer.memory.walrus.xyz', namespace });
        let cursor, verified = false;
        for (let page = 0; page < 20; page++) {
          const result = await memory.list({ namespace, limit: 100, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(result?.memories) || typeof result.has_more !== 'boolean' || result.must_resync) throw Error('Invalid memory response');
          if (result.memories.some(row => row.namespace_id === namespace && row.blob_id)) { verified = true; break; }
          if (!result.has_more) break;
          if (!result.next_cursor || result.next_cursor === cursor || page === 19) throw Error('Invalid memory response');
          cursor = result.next_cursor;
        }
        if (!verified) return send(401, { error: 'Save your Walrus preferences before checking the wallet balance.' });
      }
      if (testnet) return send(200, await testnetHandler(code, input, env));
      const adapter = await adapterFactory({ apiKey: env.TATUM_API_KEY, network: 'mainnet' });
      if (transactionLookup) {
        const tx = await adapter.getTransaction(input.digest);
        if (tx.network !== 'mainnet' || tx.digest !== input.digest || typeof tx.success !== 'boolean' || typeof tx.checkpoint !== 'string' || !/^\d+$/.test(tx.checkpoint) || !Array.isArray(tx.balanceChanges) || tx.balanceChanges.length > 1000) throw Error('Invalid transaction response');
        const changes = new Map();
        for (const change of tx.balanceChanges) {
          if (!change || typeof change.address !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(change.address) || typeof change.coinType !== 'string' || change.coinType.length > 256 || !/^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/.test(change.coinType) || typeof change.amount !== 'string' || !/^-?\d{1,80}$/.test(change.amount)) throw Error('Invalid balance change');
          if (change.address.slice(2).toLowerCase().padStart(64, '0') === input.address.slice(2).toLowerCase()) changes.set(change.coinType, (changes.get(change.coinType) ?? 0n) + BigInt(change.amount));
        }
        const walletChanges = [...changes].filter(([, amount]) => amount !== 0n).map(([coinType, amount]) => ({ coinType, amount: amount.toString() }));
        if (walletChanges.some(change => !/^-?\d{1,80}$/.test(change.amount))) throw Error('Invalid balance change total');
        return send(200, { network: 'mainnet', digest: tx.digest, status: tx.success ? 'success' : 'failed', checkpoint: tx.checkpoint, address: input.address.toLowerCase(), changes: walletChanges });
      }
      const result = await adapter.getBalance(input.address);
      if (result.network !== 'mainnet' || result.coinType !== '0x2::sui::SUI' || typeof result.balanceMist !== 'string' || !/^\d{1,80}$/.test(result.balanceMist)) throw new Error('Invalid provider response');
      return send(200, { balanceMist: result.balanceMist, network: 'mainnet', checkedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof SyntaxError) return send(400, { error: 'Invalid request.' });
      return send(502, { error: 'Wallet balance is unavailable. Try again.' });
    }
  };
}
