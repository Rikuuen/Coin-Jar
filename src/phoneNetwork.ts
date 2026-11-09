// Keep the original mainnet journal and its Walrus namespace on the plain URL.
export const mainnetDemo = true;
export const walrusNetwork = 'mainnet';
export const memoryHeaders: Record<string, string> = { 'x-coinjar-memory-network': 'mainnet' };
export const memoryStorageSuffix = mainnetDemo ? '.mainnet-demo' : '';
export const personalMemoryHeaders: Record<string, string> = { 'x-coinjar-memory-network': 'mainnet', 'x-coinjar-memory-user': '1', ...(mainnetDemo ? { 'x-coinjar-memory-demo': '1' } : {}) };
export function newMemoryCode() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export async function personalStorageSuffix(code: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return '.personal.' + Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
async function memoryNamespaceKey(code: string) { return 'coinjar.phone.memory.namespace.v1' + memoryStorageSuffix + await personalStorageSuffix(code); }
export async function personalHeadersFor(code: string, alternate = false) {
  const saved = localStorage.getItem(await memoryNamespaceKey(code));
  const legacy = saved === 'legacy' ? true : saved === 'regular' ? false : mainnetDemo;
  return { 'x-coinjar-memory-network': 'mainnet', 'x-coinjar-memory-user': '1', ...((alternate ? !legacy : legacy) ? { 'x-coinjar-memory-demo': '1' } : {}) };
}
export async function rememberAlternateNamespace(code: string) {
  const key = await memoryNamespaceKey(code);
  const current = localStorage.getItem(key);
  const legacy = current === 'legacy' ? true : current === 'regular' ? false : mainnetDemo;
  localStorage.setItem(key, legacy ? 'regular' : 'legacy');
}
