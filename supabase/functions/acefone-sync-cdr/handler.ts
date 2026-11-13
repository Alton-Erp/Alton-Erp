// acefone-sync-cdr request handling (no Deno / npm imports; unit-tested in tests/unit/acefone-functions.test.ts).
//
// Fetches Acefone call detail records (GET {base}/v1/call/records, from_date / to_date 'Y-m-d H:i:s',
// page, limit) since the last successful sync (15 minutes overlap; first run: last 24 hours) and passes them
// to public.support_acefone_cdr_upsert, which fills calls the webhooks missed (durations, agent, recording
// link) without moving any call backwards.
//
// Callers: a scheduler with header x-cron-secret = ACEFONE_CRON_SECRET (all enabled accounts), or an
// administrator (support.manage_integrations, own account). GET requests are retried twice on 429 / 5xx.

import { acefoneDate, fetchWithTimeout, log, readSecret, safeEqual } from '../_shared/acefone/acefone.ts'

export interface RpcResult<T> { data: T | null; error: { code?: string; message?: string } | null }
export interface Client { rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>> }
export interface Deps {
  allowedOrigins: string[]
  env(name: string): string | undefined
  caller(authHeader: string): Client
  admin(): Client
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): Date
}
interface Runtime { account_id: string; is_enabled: boolean; api_base_url: string; api_token_secret: string; last_sync_at: string | null; timezone: string }

const PAGE_SIZE = 100
const MAX_PAGES = 20

export async function authorize(req: Request, deps: Deps): Promise<{ accounts: string[] } | { status: number; error: string }> {
  const cron = req.headers.get('x-cron-secret')
  const cronSecret = readSecret('ACEFONE_CRON_SECRET', deps.env)
  if (cron) {
    if (!cronSecret || !safeEqual(cron, cronSecret)) return { status: 401, error: 'Not allowed.' }
    const { data, error } = await deps.admin().rpc<string[] | { support_phone_accounts: string }[]>('support_phone_accounts')
    if (error) return { status: 500, error: 'Accounts could not be read.' }
    return { accounts: (data ?? []).map((x) => (typeof x === 'string' ? x : x.support_phone_accounts)) }
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return { status: 401, error: 'Sign in first.' }
  const { data, error } = await deps.caller(auth).rpc<{ account_id: string } | null>('support_phone_admin_check')
  if (error) return { status: error.code === '42501' ? 403 : 400, error: error.message ?? 'Not allowed.' }
  if (!data) return { status: 400, error: 'Save the phone settings first.' }
  return { accounts: [data.account_id] }
}

async function getWithRetry(deps: Deps, url: string, token: string): Promise<Response> {
  let last: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      last = await fetchWithTimeout(deps.fetch, url, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } }, 20000)
      if (last.status !== 429 && last.status < 500) return last
    } catch (e) {
      if (attempt === 2) throw e
    }
    await deps.sleep(1000 * 2 ** attempt)
  }
  return last!
}

export async function syncAccount(deps: Deps, account: string): Promise<{ account: string; ok: boolean; records: number; message: string }> {
  const admin = deps.admin()
  const { data: rt, error } = await admin.rpc<Runtime | null>('support_phone_runtime', { p_account: account })
  if (error || !rt) return { account, ok: false, records: 0, message: 'Account not found.' }
  if (!rt.is_enabled) return { account, ok: false, records: 0, message: 'Disconnected.' }
  const token = readSecret(rt.api_token_secret, deps.env)
  const done = async (ok: boolean, records: unknown[], message: string) => {
    await admin.rpc('support_acefone_cdr_upsert', { p_account: account, p_records: records, p_sync_ok: ok, p_message: message })
    return { account, ok, records: records.length, message }
  }
  if (!token) return done(false, [], 'The API token secret is not set.')
  const now = deps.now()
  const from = rt.last_sync_at ? new Date(new Date(rt.last_sync_at).getTime() - 15 * 60000) : new Date(now.getTime() - 24 * 3600000)
  const records: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const q = new URLSearchParams({ from_date: acefoneDate(from, rt.timezone || 'Asia/Kolkata'), to_date: acefoneDate(now, rt.timezone || 'Asia/Kolkata'),
      page: String(page), limit: String(PAGE_SIZE) })
    let res: Response
    try {
      res = await getWithRetry(deps, `${rt.api_base_url}/v1/call/records?${q}`, token)
    } catch {
      return done(false, records, 'Acefone could not be reached.')
    }
    if (!res.ok) return done(false, records, res.status === 401 || res.status === 403 ? 'The API token was refused.' : `Acefone answered HTTP ${res.status}.`)
    const body = await res.json().catch(() => null) as { results?: unknown[]; count?: number } | null
    const rows = Array.isArray(body?.results) ? body!.results : []
    records.push(...rows)
    if (rows.length < PAGE_SIZE) break
  }
  log('acefone-sync-cdr', 'info', 'synced', { account, records: records.length })
  return done(true, records, `${records.length} call record(s) read.`)
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { 'Access-Control-Allow-Origin': deps.allowedOrigins[0] ?? '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Use POST.' }), { status: 405, headers })
  const who = await authorize(req, deps)
  if ('status' in who) return new Response(JSON.stringify({ error: who.error }), { status: who.status, headers })
  const results = []
  for (const a of who.accounts) results.push(await syncAccount(deps, a))
  return new Response(JSON.stringify({ results }), { status: 200, headers })
}
