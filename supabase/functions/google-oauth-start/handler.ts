// google-oauth-start request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Administrator actions (JWT; support.manage_integrations is checked by the database functions):
//   start       random state (only its SHA-256 hash is stored, single use, 10 minutes) → Google authorisation URL
//   status      which secrets are configured (yes / no only, never values), the redirect URI and webhook URL
//   test        refreshes the access token and reads the mailbox profile
//   disconnect  stops the push watch, revokes the refresh token at Google, deletes the stored credentials

import { keyProblem } from '../_shared/google/crypto.ts'
import { Gmail } from '../_shared/google/gmail.ts'
import { appUrl, corsHeaders, log, randomToken, redirectUriProblem, secret, sha256Hex, type Client } from '../_shared/google/google.ts'
import { buildAuthUrl, revokeToken } from '../_shared/google/oauth.ts'
import { accessToken } from '../_shared/google/sync.ts'

export interface Deps {
  allowedOrigins: string[]
  supabaseUrl: string
  env(name: string): string | undefined
  caller(authHeader: string): Client
  admin(): Client
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): Date
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return reply(401, { error: 'Sign in first.' })
  let body: { action?: string; reason?: string }
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const caller = deps.caller(auth)
  const env = deps.env
  const clientId = secret('GOOGLE_OAUTH_CLIENT_ID', env)
  const redirectUri = secret('GOOGLE_OAUTH_REDIRECT_URI', env)
  const redirectProblem = redirectUriProblem(redirectUri, deps.supabaseUrl)

  if (body.action === 'status') {
    const check = await caller.rpc('support_email_admin_check')
    if (check.error) return reply(check.error.code === '42501' ? 403 : 400, { error: check.error.message ?? 'Not allowed.' })
    const base = deps.supabaseUrl.replace(/\/+$/, '')
    return reply(200, {
      secrets: {
        client_id: Boolean(clientId),
        client_secret: Boolean(secret('GOOGLE_OAUTH_CLIENT_SECRET', env)),
        redirect_uri: redirectProblem === null,
        encryption_key: keyProblem(secret('GOOGLE_TOKEN_ENCRYPTION_KEY', env)) === null,
        app_url: appUrl(env) !== null,
        push_token: Boolean(secret('GMAIL_PUSH_TOKEN', env)),
        push_oidc: Boolean(secret('GMAIL_PUSH_AUDIENCE', env)),
        cron_secret: Boolean(secret('GOOGLE_CRON_SECRET', env)),
      },
      problems: [redirectProblem, keyProblem(secret('GOOGLE_TOKEN_ENCRYPTION_KEY', env))].filter(Boolean),
      // Non-secret values the administrator copies into Google Cloud.
      redirect_uri: `${base}/functions/v1/google-oauth-callback`,
      webhook_url: `${base}/functions/v1/google-gmail-webhook?token=<GMAIL_PUSH_TOKEN>`,
    })
  }

  if (body.action === 'start') {
    const problems = [!clientId && 'GOOGLE_OAUTH_CLIENT_ID is not set.', !secret('GOOGLE_OAUTH_CLIENT_SECRET', env) && 'GOOGLE_OAUTH_CLIENT_SECRET is not set.', redirectProblem,
      keyProblem(secret('GOOGLE_TOKEN_ENCRYPTION_KEY', env)), !appUrl(env) && 'GOOGLE_APP_URL is not set (https address of the ERP).'].filter(Boolean)
    if (problems.length) return reply(503, { error: `Google Workspace is not configured on the server: ${problems.join(' ')}` })
    const state = randomToken(32)
    const begun = await caller.rpc<{ scopes: string[]; mailbox_address: string }>('support_gmail_oauth_begin', { p_state_hash: await sha256Hex(state) })
    if (begun.error || !begun.data) return reply(begun.error?.code === '42501' ? 403 : 400, { error: begun.error?.message ?? 'Could not start the authorisation.' })
    return reply(200, { url: buildAuthUrl({ clientId: clientId!, redirectUri: redirectUri!, scopes: begun.data.scopes, state, loginHint: begun.data.mailbox_address }) })
  }

  if (body.action === 'test' || body.action === 'disconnect') {
    const check = await caller.rpc<{ account_id: string; user_id: string } | null>('support_email_admin_check')
    if (check.error) return reply(check.error.code === '42501' ? 403 : 400, { error: check.error.message ?? 'Not allowed.' })
    if (!check.data) return reply(400, { error: 'Save the email settings first.' })
    const account = check.data.account_id
    const admin = deps.admin()

    if (body.action === 'test') {
      const t = await accessToken(deps, account)
      if (!t.ok) return reply(t.reauth ? 409 : 502, { ok: false, error: t.error, reauthorize: t.reauth })
      try {
        const p = await new Gmail(deps.fetch, t.token, deps.sleep).profile()
        await admin.rpc('support_gmail_sync_state', { p_account: account, p_history_id: null, p_ok: true, p_message: `Connection test: signed in as ${p.emailAddress}.`, p_kind: 'TEST' })
        return reply(200, { ok: true, message: `Connected: Gmail answered for ${p.emailAddress}.` })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Gmail did not answer.'
        await admin.rpc('support_gmail_sync_state', { p_account: account, p_history_id: null, p_ok: false, p_message: `Connection test failed: ${msg}`, p_kind: 'TEST' })
        return reply(502, { ok: false, error: msg })
      }
    }

    // Disconnect: best effort at Google, then always remove the stored authorisation.
    let revoked = false
    const t = await accessToken(deps, account, { requireEnabled: false })
    if (t.ok) {
      try { await new Gmail(deps.fetch, t.token, deps.sleep).stop() } catch { /* watch may not exist */ }
      revoked = await revokeToken(deps.fetch, t.refreshToken)
    }
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 300) : null
    const done = await admin.rpc('support_gmail_disconnected', { p_account: account, p_reason: reason, p_revoked: revoked, p_by: check.data.user_id })
    if (done.error) return reply(500, { error: 'The connection could not be removed.' })
    log('google-oauth-start', 'info', 'disconnected', { account, revoked })
    return reply(200, { ok: true, revoked })
  }
  return reply(400, { error: 'Unknown action.' })
}
