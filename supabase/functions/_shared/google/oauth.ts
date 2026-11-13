// OAuth 2.0 for web server applications (https://developers.google.com/identity/protocols/oauth2/web-server):
// authorization endpoint, code exchange, refresh, revoke. access_type=offline and prompt=consent so Google
// returns a refresh token; the state parameter protects the callback.

import { GOOGLE, fetchWithTimeout } from './google.ts'

export function buildAuthUrl(p: { clientId: string; redirectUri: string; scopes: string[]; state: string; loginHint?: string | null }): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: p.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: p.state,
  })
  if (p.loginHint) q.set('login_hint', p.loginHint)
  return `${GOOGLE.authorize}?${q}`
}

export interface TokenResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  scopes?: string[]
  expiresIn?: number
  /** invalid_grant: the refresh token was revoked or expired; the mailbox must be reconnected. */
  revoked?: boolean
  error?: string
}

async function tokenRequest(fetcher: typeof fetch, form: Record<string, string>): Promise<TokenResult> {
  let res: Response
  try {
    res = await fetchWithTimeout(fetcher, GOOGLE.token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form).toString(),
    }, 15000)
  } catch {
    return { ok: false, error: 'Google could not be reached.' }
  }
  const json = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!res.ok || !json || typeof json.access_token !== 'string') {
    const code = typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`
    return { ok: false, revoked: code === 'invalid_grant', error: `Google refused the request (${code}).` }
  }
  return {
    ok: true,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    scopes: typeof json.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : [],
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
  }
}

export const exchangeCode = (fetcher: typeof fetch, p: { code: string; clientId: string; clientSecret: string; redirectUri: string }) =>
  tokenRequest(fetcher, { code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code' })

export const refreshAccessToken = (fetcher: typeof fetch, p: { refreshToken: string; clientId: string; clientSecret: string }) =>
  tokenRequest(fetcher, { refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'refresh_token' })

/** Revokes a refresh (or access) token. True when Google confirmed it. */
export async function revokeToken(fetcher: typeof fetch, token: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(fetcher, GOOGLE.revoke, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(),
    }, 15000)
    return res.ok
  } catch {
    return false
  }
}

export function missingScopes(granted: string[], required: string[]): string[] {
  return required.filter((s) => !granted.includes(s))
}
