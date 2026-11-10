import { recoveryTransferAuth } from './journalCipher';
import { personalHeadersFor } from './phoneNetwork';

const STORAGE = 'coinjar.phone.testnet.auth.v1';
type Auth = { token: string; headers: Record<string, string> };
function valid(value: unknown): value is Auth {
  if (!value || typeof value !== 'object') return false;
  const auth = value as Auth;
  const headers = auth.headers;
  return typeof auth.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(auth.token) && !!headers && typeof headers === 'object' &&
    (headers['x-coinjar-recovery'] === '1' || headers['x-coinjar-memory-user'] === '1') &&
    Object.keys(headers).every(key => ['x-coinjar-recovery', 'x-coinjar-memory-user', 'x-coinjar-memory-network', 'x-coinjar-memory-demo'].includes(key)) &&
    Object.values(headers).every(value => typeof value === 'string');
}
export function hasTransferAuth() { try { return localStorage.getItem(STORAGE) !== null; } catch { return false; } }
let resolving: Promise<Auth> | undefined;
export function transferAuth(code: string, personal: boolean, recoveryKey: string): Promise<Auth> {
  if (resolving) return resolving;
  resolving = resolveAuth(code, personal, recoveryKey).finally(() => { resolving = undefined; });
  return resolving;
}
async function resolveAuth(code: string, personal: boolean, recoveryKey: string): Promise<Auth> {
  const saved = localStorage.getItem(STORAGE);
  if (saved !== null) {
    const auth: unknown = JSON.parse(saved);
    if (!valid(auth)) throw Error('Saved wallet access is invalid.');
    return auth;
  }
  const auth = personal && code ? { token: code, headers: await personalHeadersFor(code) } : await recoveryTransferAuth(recoveryKey);
  if (!valid(auth)) throw Error('Wallet access is unavailable.');
  // Keep the transfer identity stable so a settings change cannot hide a pending transfer.
  localStorage.setItem(STORAGE, JSON.stringify(auth));
  return auth;
}
