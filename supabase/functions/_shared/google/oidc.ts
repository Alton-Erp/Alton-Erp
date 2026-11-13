// Optional second check for Pub/Sub push: with "authentication" enabled on the push subscription, Pub/Sub sends
// a Google-signed OIDC token (Authorization: Bearer <JWT>). It is verified here against Google's published keys
// (fixed URL), the configured audience and the subscription's service account.

import { GOOGLE, b64urlToBytes, fetchWithTimeout } from './google.ts'

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let cache: { keys: Jwk[]; at: number } | null = null

export function resetJwksCache() { cache = null }

async function keys(fetcher: typeof fetch, now: number): Promise<Jwk[]> {
  if (cache && now - cache.at < 3600000) return cache.keys
  const res = await fetchWithTimeout(fetcher, GOOGLE.certs, { method: 'GET', headers: { Accept: 'application/json' } }, 10000)
  if (!res.ok) throw new Error('Google signing keys unavailable.')
  const json = await res.json() as { keys?: Jwk[] }
  cache = { keys: (json.keys ?? []).filter((k) => k.kty === 'RSA'), at: now }
  return cache.keys
}

export async function verifyGoogleOidc(authHeader: string | null, p: { audience: string; serviceAccount: string | null; fetch: typeof fetch; now: Date }):
  Promise<{ ok: true } | { ok: false; reason: string }> {
  const m = /^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authHeader ?? '')
  if (!m) return { ok: false, reason: 'missing token' }
  let header: { alg?: string; kid?: string }
  let claims: { iss?: string; aud?: string; exp?: number; iat?: number; email?: string; email_verified?: boolean }
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[1])))
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(m[2])))
  } catch {
    return { ok: false, reason: 'malformed token' }
  }
  if (header.alg !== 'RS256' || !header.kid) return { ok: false, reason: 'unsupported algorithm' }
  const nowS = Math.floor(p.now.getTime() / 1000)
  let jwk: Jwk | undefined
  try {
    jwk = (await keys(p.fetch, p.now.getTime())).find((k) => k.kid === header.kid)
  } catch {
    return { ok: false, reason: 'keys unavailable' }
  }
  if (!jwk) return { ok: false, reason: 'unknown key' }
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`))
  if (!valid) return { ok: false, reason: 'bad signature' }
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') return { ok: false, reason: 'issuer' }
  if (claims.aud !== p.audience) return { ok: false, reason: 'audience' }
  if (typeof claims.exp !== 'number' || claims.exp < nowS - 60) return { ok: false, reason: 'expired' }
  if (typeof claims.iat === 'number' && claims.iat > nowS + 300) return { ok: false, reason: 'issued in the future' }
  if (p.serviceAccount && (claims.email !== p.serviceAccount || claims.email_verified !== true)) return { ok: false, reason: 'service account' }
  return { ok: true }
}
