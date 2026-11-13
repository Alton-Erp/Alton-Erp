// google-oauth-callback request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Google redirects the administrator's browser here (GET ?code&state, or ?error&state). No JWT: the single-use
// state proves the request started from the ERP. Steps: consume the state → exchange the code at the token
// endpoint with the registered redirect URI → require the Gmail read and send scopes and a refresh token → read
// the mailbox profile and require the configured support mailbox → encrypt the refresh token (AES-256-GCM) →
// store it → start the push watch when configured → send the browser back to the ERP (GOOGLE_APP_URL only).
// The code, tokens and state are never logged or shown.

import { encryptToken, keyProblem } from '../_shared/google/crypto.ts'
import { Gmail } from '../_shared/google/gmail.ts'
import { SCOPE_MODIFY, SCOPE_READ, SCOPE_SEND, appUrl, log, redirectUriProblem, secret, sha256Hex, type Client } from '../_shared/google/google.ts'
import { exchangeCode, missingScopes, revokeToken } from '../_shared/google/oauth.ts'

export interface Deps {
  supabaseUrl: string
  env(name: string): string | undefined
  admin(): Client
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): Date
}

const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }

function page(status: number, text: string): Response {
  const esc = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return new Response(`<!doctype html><meta charset="utf-8"><title>Google Workspace</title><p>${esc}</p>`, {
    status, headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" },
  })
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'GET') return page(405, 'Method not allowed.')
  const url = new URL(req.url)
  const state = url.searchParams.get('state') ?? ''
  const code = url.searchParams.get('code')
  const oauthError = url.searchParams.get('error')
  const app = appUrl(deps.env)
  const back = (result: 'connected' | 'error', reason?: string) => {
    if (!app) return page(result === 'connected' ? 200 : 400, result === 'connected' ? 'Google Workspace connected. You can close this window.' : `Google Workspace was not connected (${reason}).`)
    const q = new URLSearchParams({ tab: 'email', gmail: result, ...(reason ? { reason } : {}) })
    return new Response(null, { status: 303, headers: { ...HEADERS, Location: `${app}/support/settings?${q}` } })
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(state)) return back('error', 'state_invalid')

  const admin = deps.admin()
  const consumed = await admin.rpc<{ ok: boolean; reason?: string; account_id?: string; user_id?: string; scopes?: string[]; mailbox_address?: string }>(
    'support_gmail_oauth_consume', { p_state_hash: await sha256Hex(state) })
  if (consumed.error || !consumed.data) return back('error', 'state_check_failed')
  const s = consumed.data
  if (!s.ok || !s.account_id) return back('error', `state_${(s.reason ?? 'invalid').toLowerCase()}`)
  const account = s.account_id
  const fail = async (reason: string, detail: string) => {
    await admin.rpc('support_gmail_oauth_failed', { p_account: account, p_reason: detail })
    log('google-oauth-callback', 'warn', 'authorisation failed', { account, reason })
    return back('error', reason)
  }
  if (oauthError) return fail(oauthError === 'access_denied' ? 'denied' : 'google_error', `Google returned ${oauthError.slice(0, 60)}.`)
  if (!code || code.length > 2048) return fail('no_code', 'Google returned no authorisation code.')

  const clientId = secret('GOOGLE_OAUTH_CLIENT_ID', deps.env)
  const clientSecret = secret('GOOGLE_OAUTH_CLIENT_SECRET', deps.env)
  const redirectUri = secret('GOOGLE_OAUTH_REDIRECT_URI', deps.env)
  const key = secret('GOOGLE_TOKEN_ENCRYPTION_KEY', deps.env)
  if (!clientId || !clientSecret || redirectUriProblem(redirectUri, deps.supabaseUrl) || keyProblem(key)) return fail('not_configured', 'Server OAuth configuration incomplete.')

  const t = await exchangeCode(deps.fetch, { code, clientId, clientSecret, redirectUri: redirectUri! })
  if (!t.ok || !t.accessToken) return fail('exchange_failed', t.error ?? 'Code exchange failed.')
  const required = [SCOPE_READ, SCOPE_SEND, ...((s.scopes ?? []).includes(SCOPE_MODIFY) ? [SCOPE_MODIFY] : [])]
  const missing = missingScopes(t.scopes ?? [], required)
  if (missing.length) {
    await revokeToken(deps.fetch, t.refreshToken ?? t.accessToken)
    return fail('scopes_missing', `Permissions not granted: ${missing.map((x) => x.split('/').pop()).join(', ')}.`)
  }
  if (!t.refreshToken) {
    await revokeToken(deps.fetch, t.accessToken)
    return fail('no_refresh_token', 'Google returned no refresh token.')
  }
  let profile: { emailAddress: string; historyId: string }
  try {
    profile = await new Gmail(deps.fetch, t.accessToken, deps.sleep).profile()
  } catch {
    await revokeToken(deps.fetch, t.refreshToken)
    return fail('profile_failed', 'The Gmail profile could not be read.')
  }
  if (profile.emailAddress.toLowerCase() !== (s.mailbox_address ?? '').toLowerCase()) {
    // Signed in with another account: do not keep any access to it.
    await revokeToken(deps.fetch, t.refreshToken)
    return fail('wrong_mailbox', `Signed in as ${profile.emailAddress.slice(0, 120)}, not the support mailbox ${s.mailbox_address}.`)
  }
  const enc = await encryptToken(t.refreshToken, key!, account)
  const connected = await admin.rpc<{ push_enabled: boolean; pubsub_topic: string | null }>('support_gmail_connect', {
    p_account: account, p_user: s.user_id, p_address: profile.emailAddress, p_ciphertext: enc.ciphertext, p_iv: enc.iv, p_key_version: enc.keyVersion,
    p_scopes: t.scopes ?? [], p_history_id: /^[0-9]{1,20}$/.test(profile.historyId ?? '') ? profile.historyId : null,
  })
  if (connected.error || !connected.data) {
    await revokeToken(deps.fetch, t.refreshToken)
    return fail('store_failed', connected.error?.message?.slice(0, 200) ?? 'The authorisation could not be stored.')
  }
  if (connected.data.push_enabled && connected.data.pubsub_topic) {
    try {
      const w = await new Gmail(deps.fetch, t.accessToken, deps.sleep).watch(connected.data.pubsub_topic)
      await admin.rpc('support_gmail_watch_state', { p_account: account, p_ok: true, p_expiration_ms: w.expiration ?? null, p_message: 'Push notifications started.' })
    } catch (e) {
      await admin.rpc('support_gmail_watch_state', { p_account: account, p_ok: false, p_expiration_ms: null,
        p_message: `Push notifications could not start: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}. Scheduled sync still runs.` })
    }
  }
  log('google-oauth-callback', 'info', 'connected', { account })
  return back('connected')
}
