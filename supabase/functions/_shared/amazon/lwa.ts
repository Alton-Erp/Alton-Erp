// Login with Amazon (LWA): exchanges a refresh token for a short-lived access
// token, cached in memory until 60 s before expiry. Used by both the Selling
// Partner API and the Amazon Ads API (each with its OWN client and refresh token).

import { AmazonApiError, fetchWithRetry, readJson, type FetchFn, type RetryOptions } from './http.ts'

export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
/** Amazon Ads documents region-specific token hosts; the Selling Partner API uses LWA_TOKEN_URL. */
export const ADS_LWA_TOKEN_URLS: Record<string, string> = {
  NA: 'https://api.amazon.com/auth/o2/token', EU: 'https://api.amazon.co.uk/auth/o2/token', FE: 'https://api.amazon.co.jp/auth/o2/token',
}

export interface LwaCredentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

interface CacheEntry { token: string; expiresAt: number }
const cache = new Map<string, CacheEntry>()

export function clearTokenCache() {
  cache.clear()
}

export async function getAccessToken(creds: LwaCredentials, fetchFn: FetchFn, opts: RetryOptions & { now?: () => number; tokenUrl?: string } = {}): Promise<string> {
  const now = opts.now ?? Date.now
  const key = `${creds.clientId}:${creds.refreshToken.slice(-12)}`
  const hit = cache.get(key)
  if (hit && hit.expiresAt > now()) return hit.token
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret })
  const res = await fetchWithRetry(fetchFn, opts.tokenUrl ?? LWA_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: body.toString() }, opts)
  let json: { access_token?: string; expires_in?: number }
  try {
    json = await readJson(res, 'Login with Amazon', [creds.clientSecret, creds.refreshToken])
  } catch (e) {
    if (e instanceof AmazonApiError && (e.code === 'invalid_grant' || e.code === 'invalid_client' || e.code === 'unauthorized_client')) {
      throw new AmazonApiError(
        e.code === 'invalid_grant' ? 'The refresh token is invalid, expired or was revoked. Re-authorise the application and update the refresh token secret.'
          : 'The client id / secret were rejected. Check the application credentials.', e.status, e.code === 'invalid_grant' ? 'AUTH_REVOKED' : 'AUTH_CLIENT', false, e.requestId)
    }
    throw e
  }
  if (!json.access_token) throw new AmazonApiError('Login with Amazon returned no access token.', res.status, 'AUTH_NO_TOKEN', false)
  cache.set(key, { token: json.access_token, expiresAt: now() + Math.max(60, (json.expires_in ?? 3600) - 60) * 1000 })
  return json.access_token
}
