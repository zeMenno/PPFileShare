// App-level crypto: AES-256-GCM via WebCrypto. The key travels in the URL
// fragment (#k=...), which browsers never send to any server.

const enc = new TextEncoder();
const dec = new TextDecoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function toB64u(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Bytes {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Random URL-safe id. 12 bytes = 96 bits = 16 characters. */
export function randomId(bytes = 12): string {
  return toB64u(randomBytes(bytes));
}

/** A fresh 256-bit link key, base64url encoded. */
export function newLinkKey(): string {
  return toB64u(randomBytes(32));
}

const PBKDF2_ITERATIONS = 600_000;

/**
 * Turn the link key (and optional password) into the AES-GCM key used for everything.
 * With a password, the link key acts as a secret salt for PBKDF2, so you need both.
 */
export async function deriveRoomKey(linkKey: string, password?: string): Promise<CryptoKey> {
  let raw: Bytes;
  try {
    raw = fromB64u(linkKey);
  } catch {
    throw new Error('The key in this link is damaged.');
  }
  if (raw.length !== 32) throw new Error('The key in this link is incomplete.');
  if (!password) {
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: raw, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt bytes; output = 12-byte IV || ciphertext+tag. */
export async function seal(key: CryptoKey, data: Bytes, aad: string): Promise<Bytes> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, data);
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return out;
}

export async function open(key: CryptoKey, sealed: Bytes, aad: string): Promise<Bytes> {
  if (sealed.length < 12 + 16) throw new Error('ciphertext too short');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: enc.encode(aad) },
    key,
    sealed.subarray(12),
  );
  return new Uint8Array(pt);
}

export async function sealJson(key: CryptoKey, value: unknown, aad: string): Promise<Bytes> {
  return seal(key, enc.encode(JSON.stringify(value)), aad);
}

export async function openJson<T>(key: CryptoKey, sealed: Bytes, aad: string): Promise<T> {
  return JSON.parse(dec.decode(await open(key, sealed, aad))) as T;
}
