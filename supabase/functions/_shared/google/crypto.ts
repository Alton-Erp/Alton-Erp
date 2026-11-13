// Refresh-token encryption at rest: AES-256-GCM with GOOGLE_TOKEN_ENCRYPTION_KEY (32 random bytes, base64),
// a random 96-bit IV per encryption, and the channel account id as additional data so a ciphertext cannot be
// moved to another account. Only the Edge Functions hold the key; the database stores ciphertext and IV.

import { b64ToBytes, b64urlToBytes, bytesToB64url } from './google.ts'

export const KEY_VERSION = 1

export function keyProblem(keyB64: string | null): string | null {
  if (!keyB64) return 'GOOGLE_TOKEN_ENCRYPTION_KEY is not set.'
  try {
    if (b64ToBytes(keyB64.replace(/-/g, '+').replace(/_/g, '/')).length !== 32) return 'GOOGLE_TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).'
  } catch {
    return 'GOOGLE_TOKEN_ENCRYPTION_KEY is not valid base64.'
  }
  return null
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64.replace(/-/g, '+').replace(/_/g, '/'))
  if (raw.length !== 32) throw new Error('Invalid encryption key length.')
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptToken(plain: string, keyB64: string, account: string): Promise<{ ciphertext: string; iv: string; keyVersion: number }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(account) }, await importKey(keyB64), new TextEncoder().encode(plain))
  return { ciphertext: bytesToB64url(new Uint8Array(ct)), iv: bytesToB64url(iv), keyVersion: KEY_VERSION }
}

/** Throws when the key, IV, account or ciphertext do not match (GCM authentication). */
export async function decryptToken(ciphertext: string, iv: string, keyB64: string, account: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64urlToBytes(iv), additionalData: new TextEncoder().encode(account) }, await importKey(keyB64),
    b64urlToBytes(ciphertext))
  return new TextDecoder().decode(pt)
}
