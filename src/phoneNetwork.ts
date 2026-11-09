export const mainnetDemo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('walrus') === 'mainnet-demo';
export const walrusNetwork = mainnetDemo ? 'mainnet' : 'testnet';
export const memoryHeaders: Record<string, string> = mainnetDemo ? { 'x-coinjar-memory-network': 'mainnet' } : {};
export const memoryStorageSuffix = mainnetDemo ? '.mainnet-demo' : '';
export const personalMemoryHeaders: Record<string, string> = { 'x-coinjar-memory-network': 'mainnet', 'x-coinjar-memory-user': '1', ...(mainnetDemo ? { 'x-coinjar-memory-demo': '1' } : {}) };
export function newMemoryCode() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export async function personalStorageSuffix(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return '.personal.' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
