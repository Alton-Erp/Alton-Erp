// acefone-click-to-call request handling (no Deno / npm imports; unit-tested in tests/unit/acefone-functions.test.ts).
//
// Actions (POST JSON, signed-in ERP user):
//   { action: 'call', customer_id?, ticket_id?, conversation_id?, number, line_id, idempotency_key }
//   { action: 'status' }   which secrets are configured (true / false only; never values) — support.view
//   { action: 'test' }     test connection (GET /v1/call/records, limit 1) — support.manage_integrations
//
// Security: the caller is checked by the database with the caller's own JWT (support_call_prepare /
// support_phone_admin_check). The API token and support API key are read from Edge Function secrets here,
// sent only to the documented Acefone hosts, and never returned or logged.
// Calls: the request is recorded first (INITIATED / PENDING); a repeated click with the same key — or a second
// click within two minutes to the same number from the same line — returns the existing call and sends nothing.
// Acefone's acceptance keeps the call INITIATED; only webhooks / call records move it to Ringing, Connected, ...
// The request is not retried (Acefone could place the call twice).

import { buildClickToCall, fetchWithTimeout, interpretClickToCall, log, readSecret, type PreparedCall } from '../_shared/acefone/acefone.ts'

export interface RpcResult<T> { data: T | null; error: { code?: string; message?: string } | null }
export interface CallerClient { rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>> }
export interface AdminClient { rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>> }
export interface Deps {
  allowedOrigins: string[]
  configured: boolean
  env(name: string): string | undefined
  caller(authHeader: string): CallerClient
  admin(): AdminClient
  fetch: typeof fetch
}

export function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

const TIMEOUT_MS = 15000

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  if (!deps.configured) return reply(503, { error: 'The function is not configured.' })
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return reply(401, { error: 'Sign in to place calls.' })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const caller = deps.caller(auth)
  const action = String(body.action ?? '')

  if (action === 'status') {
    const { data, error } = await caller.rpc<{ config: Record<string, string> | null }>('support_phone_config_get')
    if (error) return reply(error.code === '42501' ? 403 : 400, { error: error.message ?? 'Not allowed.' })
    const cfg = data?.config
    if (!cfg) return reply(200, { configured: false, secrets: { api_token: false, support_api_key: false, webhook_secret: false } })
    return reply(200, { configured: true, secrets: {
      api_token: Boolean(readSecret(cfg.api_token_secret, deps.env)),
      support_api_key: Boolean(readSecret(cfg.support_api_key_secret, deps.env)),
      webhook_secret: Boolean(readSecret(cfg.webhook_secret_name, deps.env)),
    } })
  }

  if (action === 'test') {
    const { data: cfg, error } = await caller.rpc<{ account_id: string; api_base_url: string; api_token_secret: string } | null>('support_phone_admin_check')
    if (error) return reply(error.code === '42501' ? 403 : 400, { error: error.message ?? 'Not allowed.' })
    if (!cfg) return reply(400, { error: 'Save the phone settings first.' })
    const token = readSecret(cfg.api_token_secret, deps.env)
    let ok = false
    let message: string
    if (!token) message = `Secret ${cfg.api_token_secret} is not set.`
    else {
      try {
        const res = await fetchWithTimeout(deps.fetch, `${cfg.api_base_url}/v1/call/records?limit=1&page=1`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, TIMEOUT_MS)
        ok = res.ok
        message = res.ok ? 'Connected: the API token was accepted.' : res.status === 401 || res.status === 403 ? 'The API token was refused by Acefone.' : `Acefone answered HTTP ${res.status}.`
      } catch (e) {
        message = (e as Error).name === 'AbortError' ? 'Acefone did not answer within 15 seconds.' : 'Acefone could not be reached.'
      }
    }
    const { error: e2 } = await deps.admin().rpc('support_phone_test_result', { p_account: cfg.account_id, p_ok: ok, p_message: message })
    if (e2) log('acefone-click-to-call', 'error', 'test result not stored', { error: e2.message })
    log('acefone-click-to-call', ok ? 'info' : 'warn', 'connection test', { ok })
    return reply(200, { ok, message })
  }

  if (action !== 'call') return reply(400, { error: 'Unknown action.' })
  const { data: prep, error } = await caller.rpc<PreparedCall & { duplicate: boolean; status: string; request_state: string; account_id: string }>('support_call_prepare', { p: {
    customer_id: body.customer_id ?? null, ticket_id: body.ticket_id ?? null, conversation_id: body.conversation_id ?? null,
    number: body.number ?? null, line_id: body.line_id ?? null, idempotency_key: body.idempotency_key ?? null } })
  if (error || !prep) return reply(error?.code === '42501' ? 403 : 400, { error: error?.message ?? 'The call could not be prepared.' })
  if (prep.duplicate) return reply(200, { call_id: prep.call_id, status: prep.status, request_state: prep.request_state, duplicate: true })

  const result = async (accepted: boolean, refId: string | null, message: string, http: number | null) => {
    const { data, error: e } = await deps.admin().rpc<{ status: string; request_state: string }>('support_call_request_result',
      { p_call: prep.call_id, p_accepted: accepted, p_ref_id: refId, p_message: message, p_http: http })
    if (e) log('acefone-click-to-call', 'error', 'request result not stored', { call: prep.call_id, error: e.message })
    return data
  }
  const token = readSecret(prep.api_token_secret, deps.env)
  const supportKey = prep.mode === 'SUPPORT' ? readSecret(prep.support_api_key_secret, deps.env) : null
  if (!token || (prep.mode === 'SUPPORT' && !supportKey)) {
    const msg = !token ? 'The Acefone API token is not configured.' : 'The Click-to-Call Support API key is not configured.'
    const r = await result(false, null, msg, 400)
    log('acefone-click-to-call', 'error', 'missing secret', { call: prep.call_id, mode: prep.mode })
    return reply(503, { call_id: prep.call_id, status: r?.status ?? 'FAILED', error: msg })
  }
  const request = buildClickToCall(prep, token, supportKey)
  let http: number | null = null
  let parsed: unknown = null
  try {
    const res = await fetchWithTimeout(deps.fetch, request.url, request.init, TIMEOUT_MS)
    http = res.status
    parsed = await res.json().catch(() => null)
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Acefone did not answer within 15 seconds; the call may still go through.' : 'Acefone could not be reached.'
    const r = await result(false, null, msg, null)
    log('acefone-click-to-call', 'warn', 'request error', { call: prep.call_id, mode: prep.mode })
    return reply(502, { call_id: prep.call_id, status: r?.status ?? 'INITIATED', request_state: r?.request_state ?? 'ERROR', error: msg })
  }
  const out = interpretClickToCall(http, parsed)
  const r = await result(out.accepted, out.refId, out.message, http)
  log('acefone-click-to-call', out.accepted ? 'info' : 'warn', 'click-to-call', { call: prep.call_id, mode: prep.mode, http, accepted: out.accepted })
  if (!out.accepted) return reply(http >= 500 ? 502 : 422, { call_id: prep.call_id, status: r?.status ?? 'FAILED', request_state: r?.request_state, error: out.message })
  return reply(200, { call_id: prep.call_id, status: r?.status ?? 'INITIATED', request_state: 'ACCEPTED', message: 'Call requested. Acefone is ringing the first leg.' })
}
