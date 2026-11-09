import { validateJournal, type PhoneJournal } from './phoneJournal';
import { mainnetDemo, memoryStorageSuffix, personalStorageSuffix } from './phoneNetwork';

type Envelope = { version: 1; iv: string; ciphertext: string };
const encoder = new TextEncoder();
const aad = encoder.encode('coinjar-journal-recovery-v1');
const base64url = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid recovery data');
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  if (base64url(bytes) !== value) throw Error('Invalid recovery data');
  return bytes;
}
async function keys(code: string) {
  const bytes = decode(code);
  if (bytes.length !== 32) throw Error('Invalid recovery key');
  const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const params = (label: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: aad, info: encoder.encode(label) });
  const key = await crypto.subtle.deriveKey(params('encryption'), material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const token = base64url(new Uint8Array(await crypto.subtle.deriveBits(params('access'), material, 256)));
  return { key, token };
}
export async function encryptJournal(code: string, journal: PhoneJournal) {
  const { key, token } = await keys(code);
  const plaintext = encoder.encode(JSON.stringify(validateJournal(journal)));
  if (plaintext.length > 40000) throw Error('Journal is too large for this recovery backup.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
  return { token, envelope: { version: 1 as const, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) } };
}
export async function decryptJournal(code: string, envelope: Envelope) {
  if (!envelope || envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 60000) throw Error('Invalid recovery data');
  const iv = decode(envelope.iv), ciphertext = decode(envelope.ciphertext);
  if (iv.length !== 12) throw Error('Invalid recovery data');
  const { key } = await keys(code);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
  return validateJournal(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
}
export async function recoveryRequest(code: string, action: 'backupSave' | 'backupRestore', envelope?: Envelope, operationId: string = crypto.randomUUID()) {
  const { token } = await keys(code);
  const namespaceKey = 'coinjar.phone.recovery.namespace.v1' + memoryStorageSuffix + await personalStorageSuffix(code);
  const saved = localStorage.getItem(namespaceKey);
  const legacy = saved === 'legacy' ? true : saved === 'regular' ? false : mainnetDemo;
  const send = (demo: boolean) => fetch('/api/phone/walrus', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-coinjar-memory-network': 'mainnet', 'x-coinjar-recovery': '1', ...(demo ? { 'x-coinjar-memory-demo': '1' } : {}) }, body: JSON.stringify({ consent: true, action, ...(envelope ? { envelope, operationId } : {}) }) });
  let response = await send(legacy);
  if (action === 'backupRestore' && response.status === 404 && saved === null) {
    const alternative = await send(!legacy);
    if (alternative.ok) localStorage.setItem(namespaceKey, legacy ? 'regular' : 'legacy');
    if (alternative.status !== 404) response = alternative;
  }
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Recovery unavailable.');
  return result;
}
