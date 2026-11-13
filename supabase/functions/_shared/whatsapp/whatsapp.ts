// Shared helpers for the WhatsApp Cloud API Edge Functions (no Deno / npm imports; unit-tested in
// tests/unit/whatsapp-functions.test.ts).
//
// Every Meta request goes to https://graph.facebook.com/<version>/<numeric id>/...; the version is the one the
// administrator configured (never hard-coded). Media is downloaded only from Meta's media hosts, with the token.

import { fetchWithTimeout, safeEqual, type Client } from '../google/google.ts'

export const GRAPH = 'https://graph.facebook.com'
export const WA_SECRETS = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_CRON_SECRET'] as const
export type WaSecret = typeof WA_SECRETS[number]

export function waSecret(name: WaSecret, env: (k: string) => string | undefined): string | null {
  if (!(WA_SECRETS as readonly string[]).includes(name)) return null
  const v = env(name)
  return v && v.trim() ? v.trim() : null
}

const VERSION = /^v[0-9]{1,3}\.[0-9]$/
const NUMERIC = /^[0-9]{5,25}$/

/** https://graph.facebook.com/<version>/<id>[/<edge>]; refuses anything that is not a configured version and numeric id. */
export function graphUrl(version: string | null | undefined, id: string | null | undefined, edge = '', query?: Record<string, string>): string {
  if (!version || !VERSION.test(version)) throw new Error('The Graph API version is not configured (Support Settings → WhatsApp).')
  if (!id || !/^[0-9A-Za-z_-]{1,64}$/.test(id)) throw new Error('Invalid Meta id.')
  if (edge && !/^[a-z_]{2,40}$/.test(edge)) throw new Error('Invalid Graph edge.')
  const q = query ? `?${new URLSearchParams(query)}` : ''
  return `${GRAPH}/${version}/${id}${edge ? `/${edge}` : ''}${q}`
}
export const isNumericId = (v: unknown): v is string => typeof v === 'string' && NUMERIC.test(v)

/** X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with the app secret>. */
export async function signatureValid(raw: Uint8Array, header: string | null, appSecret: string): Promise<boolean> {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header?.trim() ?? '')
  if (!m) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw as Uint8Array<ArrayBuffer>))
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')
  return safeEqual(hex, m[1].toLowerCase())
}

/** GET verification: hub.mode=subscribe and the verify token → answer with hub.challenge (plain text). */
export function verificationAnswer(params: URLSearchParams, verifyToken: string | null): { ok: true; challenge: string } | { ok: false; status: number } {
  if (!verifyToken) return { ok: false, status: 503 }
  const challenge = params.get('hub.challenge') ?? ''
  if (params.get('hub.mode') !== 'subscribe' || !safeEqual(params.get('hub.verify_token') ?? '', verifyToken)) return { ok: false, status: 403 }
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(challenge)) return { ok: false, status: 400 }
  return { ok: true, challenge }
}

export async function eventKey(entryId: string, field: string, value: unknown): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ entryId, field, value }))))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface GraphError { status: number; code: number | null; title: string; detail: string | null }
export async function graphError(res: Response): Promise<GraphError> {
  const j = await res.json().catch(() => null) as { error?: { message?: string; code?: number; error_data?: { details?: string } } } | null
  return { status: res.status, code: typeof j?.error?.code === 'number' ? j.error.code : null, title: (j?.error?.message ?? `Meta answered HTTP ${res.status}`).slice(0, 300),
    detail: j?.error?.error_data?.details?.slice(0, 1000) ?? null }
}

/** Meta's media download URLs (lookaside.fbsbx.com and Meta CDN hosts) — nothing else is fetched. */
export function mediaUrlAllowed(u: string): boolean {
  try {
    const x = new URL(u)
    if (x.protocol !== 'https:' || x.username || x.password || (x.port && x.port !== '443')) return false
    return ['fbsbx.com', 'whatsapp.net', 'fbcdn.net', 'facebook.com'].some((d) => x.hostname === d || x.hostname.endsWith(`.${d}`))
  } catch {
    return false
  }
}

export async function graphFetch(fetcher: typeof fetch, url: string, token: string, init: RequestInit = {}, ms = 20000): Promise<Response> {
  return fetchWithTimeout(fetcher, url, { ...init, headers: { Accept: 'application/json', ...(init.headers as Record<string, string> ?? {}), Authorization: `Bearer ${token}` } }, ms)
}

export interface WaDeps {
  env(name: string): string | undefined
  admin(): Client
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): Date
}
export interface WaRuntime {
  company_id: string; account_id: string; waba_id: string | null; phone_number_id: string | null; display_phone_number: string | null; app_id: string | null
  graph_api_version: string | null; setup_state: string; integration_enabled: boolean; number_path: string
}

/** Scheduler (x-cron-secret = WHATSAPP_CRON_SECRET) or an administrator (JWT, support.manage_integrations). */
export async function authorizeWa(req: Request, deps: WaDeps & { caller(auth: string): Client }): Promise<{ accounts: string[]; caller: Client | null } | { status: number; error: string }> {
  const cron = req.headers.get('x-cron-secret')
  if (cron) {
    const expected = waSecret('WHATSAPP_CRON_SECRET', deps.env)
    if (!expected || !safeEqual(cron, expected)) return { status: 401, error: 'Not allowed.' }
    const { data, error } = await deps.admin().rpc<(string | { support_whatsapp_accounts: string })[]>('support_whatsapp_accounts')
    if (error) return { status: 500, error: 'Accounts could not be read.' }
    return { accounts: (data ?? []).map((x) => (typeof x === 'string' ? x : x.support_whatsapp_accounts)), caller: null }
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return { status: 401, error: 'Sign in first.' }
  const caller = deps.caller(auth)
  const { data, error } = await caller.rpc<{ account_id: string } | null>('support_whatsapp_admin_check')
  if (error) return { status: error.code === '42501' ? 403 : 400, error: error.message ?? 'Not allowed.' }
  if (!data) return { status: 400, error: 'Save the WhatsApp settings first.' }
  return { accounts: [data.account_id], caller }
}

/** Meta's GET verification request for the callback URL (?account=<channel account id>&hub.mode=…). */
export async function answerVerification(req: Request, deps: WaDeps): Promise<Response> {
  const url = new URL(req.url)
  const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  const account = url.searchParams.get('account') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(account)) return text(400, 'Missing account.')
  const v = verificationAnswer(url.searchParams, waSecret('WHATSAPP_VERIFY_TOKEN', deps.env))
  if (!v.ok) return text(v.status, v.status === 503 ? 'Not configured.' : 'Forbidden.')
  const { data, error } = await deps.admin().rpc<boolean>('support_whatsapp_webhook_verified', { p_account: account })
  if (error || data !== true) return text(404, 'Unknown account.')
  return text(200, v.challenge)
}
