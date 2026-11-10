import { createHash } from 'node:crypto';
import { get, put } from '@vercel/blob';

// Testnet state is isolated from the phone journal and its Walrus recovery.
export function createTestnetStore({ blobs = { get, put } } = {}) {
  const pathFor = code => {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw Error('Invalid testnet account');
    return `testnet-transfers/v1/${createHash('sha256').update(code).digest('hex')}.json`;
  };
  async function read(code) {
    const path = pathFor(code);
    const result = await blobs.get(path, { access: 'private', useCache: false });
    if (!result) return { path, etag: null, value: { version: 1, transfers: [] } };
    if (result.statusCode !== 200 || !result.stream || !result.blob?.etag || result.blob.size > 200000) throw Error('Testnet store unavailable');
    const value = JSON.parse(await new Response(result.stream).text());
    if (value?.version !== 1 || !Array.isArray(value.transfers) || value.transfers.length > 1000) throw Error('Invalid testnet store');
    return { path, etag: result.blob.etag, value };
  }
  async function write(snapshot, value) {
    if (!snapshot || !value || value.version !== 1 || !Array.isArray(value.transfers) || value.transfers.length > 1000) throw Error('Invalid testnet update');
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 200000) throw Error('Testnet store full');
    await blobs.put(snapshot.path, json, { access: 'private', addRandomSuffix: false, contentType: 'application/json', ...(snapshot.etag ? { allowOverwrite: true, ifMatch: snapshot.etag } : { allowOverwrite: false }) });
  }
  async function claim(code, digest, id) {
    if (typeof digest !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(digest) || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid testnet claim');
    const owner = pathFor(code), path = `testnet-transfers/v1/digests/${digest}.json`;
    const existing = await blobs.get(path, { access: 'private', useCache: false });
    if (existing) {
      if (existing.statusCode !== 200 || !existing.stream || existing.blob.size > 1024) throw Error('Testnet claim unavailable');
      const value = JSON.parse(await new Response(existing.stream).text());
      if (value.owner !== owner || value.id !== id) throw Error('Transaction already claimed');
      return;
    }
    await blobs.put(path, JSON.stringify({ owner, id }), { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/json' });
  }
  return { read, write, claim };
}
