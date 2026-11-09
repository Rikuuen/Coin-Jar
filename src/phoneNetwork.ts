const MODE = 'coinjar.phone.journal-space.v1';
function storageState() {
  try {
    const choice = localStorage.getItem(MODE);
    const regular = localStorage.getItem('coinjar.phone.journal.v1') !== null;
    const legacy = localStorage.getItem('coinjar.phone.demo.journal.v1') !== null;
    return { choice, regular, legacy };
  } catch { return { choice: null, regular: false, legacy: false }; }
}
const state = storageState();
export const needsJournalChoice = state.choice !== 'regular' && state.choice !== 'legacy' && state.regular && state.legacy;
export const mainnetDemo = state.choice === 'legacy' || (state.choice !== 'regular' && !state.regular);
export const hasBothJournals = state.regular && state.legacy;
export function chooseJournalSpace(value: 'regular' | 'legacy') { localStorage.setItem(MODE, value); window.location.reload(); }
export function switchJournalSpace() { localStorage.removeItem(MODE); window.location.reload(); }
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
