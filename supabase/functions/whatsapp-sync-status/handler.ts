// whatsapp-sync-status request handling (no Deno / npm imports; unit-tested in tests/unit/whatsapp-functions.test.ts).
//
// Callers: the scheduler (x-cron-secret = WHATSAPP_CRON_SECRET) or an administrator (JWT). Body { action }:
//   test       GET /{phone-number-id}?fields=… : passes only when Meta reports status CONNECTED, the Cloud API
//              platform (when reported) and the configured display number. Read-only: nothing changes at Meta.
//   templates  GET /{WABA-ID}/message_templates (paged): the catalogue agents may use (APPROVED only).
//   all        (default; scheduler) test + templates + removal of raw webhook payloads older than 30 days.

import { corsHeaders, type Client } from '../_shared/google/google.ts'
import { GRAPH, authorizeWa, graphError, graphFetch, graphUrl, waSecret, type WaDeps, type WaRuntime } from '../_shared/whatsapp/whatsapp.ts'

export interface Deps extends WaDeps {
  allowedOrigins: string[]
  caller(auth: string): Client
}
const FIELDS = 'display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status,name_status,is_on_biz_app,throughput'
const digits = (s: string | null | undefined) => (s ?? '').replace(/[^0-9]/g, '')

export async function testConnection(deps: Deps, rt: WaRuntime, token: string | null): Promise<{ ok: boolean; message: string }> {
  const admin = deps.admin()
  const record = async (ok: boolean, info: Record<string, unknown> | null, message: string) => {
    await admin.rpc('support_whatsapp_test_result', { p_account: rt.account_id, p_ok: ok, p_info: info, p_message: message })
    return { ok, message }
  }
  if (!token) return record(false, null, 'WHATSAPP_ACCESS_TOKEN is not set on the server.')
  let res: Response
  try {
    res = await graphFetch(deps.fetch, graphUrl(rt.graph_api_version, rt.phone_number_id, '', { fields: FIELDS }), token)
  } catch (e) {
    return record(false, null, e instanceof Error && /version|id/i.test(e.message) ? e.message : 'Meta could not be reached.')
  }
  if (!res.ok) {
    const e = await graphError(res)
    return record(false, null, e.code === 190 ? 'Meta refused the access token (190): it expired or is invalid. Replace WHATSAPP_ACCESS_TOKEN.'
      : `Meta answered ${res.status}: ${e.title}${e.code ? ` (${e.code})` : ''}`)
  }
  const info = await res.json().catch(() => ({})) as Record<string, unknown>
  const safe = Object.fromEntries(FIELDS.split(',').filter((k) => k in info).map((k) => [k, info[k]]))
  const problems: string[] = []
  if (String(info.status ?? '').toUpperCase() !== 'CONNECTED') problems.push(`number status is ${info.status ?? 'not reported'} (must be CONNECTED)`)
  if (info.platform_type !== undefined && String(info.platform_type).toUpperCase() !== 'CLOUD_API') problems.push(`platform is ${info.platform_type} (must be CLOUD_API)`)
  if (digits(String(info.display_phone_number ?? '')) !== digits(rt.display_phone_number)) problems.push(`Meta reports ${info.display_phone_number ?? 'no number'}, not the configured ${rt.display_phone_number}`)
  if (problems.length) return record(false, safe, `Not ready: ${problems.join('; ')}.`)
  return record(true, safe, `Connected: ${info.verified_name ?? ''} ${info.display_phone_number ?? ''} on the Cloud API${info.quality_rating ? `, quality ${info.quality_rating}` : ''}.`.replace(/\s+/g, ' '))
}

export async function syncTemplates(deps: Deps, rt: WaRuntime, token: string | null): Promise<{ ok: boolean; message: string }> {
  if (!token) return { ok: false, message: 'WHATSAPP_ACCESS_TOKEN is not set.' }
  const all: unknown[] = []
  let url: string | null = graphUrl(rt.graph_api_version, rt.waba_id, 'message_templates', { fields: 'id,name,language,status,category,components,parameter_format', limit: '100' })
  let complete = true
  for (let page = 0; url; page++) {
    if (page >= 20) { complete = false; break }
    let res: Response
    try {
      res = await graphFetch(deps.fetch, url, token)
    } catch {
      return { ok: false, message: 'Meta could not be reached.' }
    }
    if (!res.ok) {
      const e = await graphError(res)
      return { ok: false, message: `Templates could not be read: ${e.title}${e.code ? ` (${e.code})` : ''}` }
    }
    const j = await res.json().catch(() => ({})) as { data?: unknown[]; paging?: { next?: string } }
    all.push(...(j.data ?? []))
    const next: string | null = j.paging?.next ?? null
    // Follow only Meta's own next page for this account's templates.
    url = next && next.startsWith(`${GRAPH}/`) && new URL(next).pathname.endsWith(`/${rt.waba_id}/message_templates`) ? next : null
    if (next && !url) complete = false
  }
  const { data, error } = await deps.admin().rpc<number>('support_whatsapp_templates_sync', { p_account: rt.account_id, p_templates: all, p_complete: complete })
  if (error) return { ok: false, message: 'Templates could not be stored.' }
  return { ok: true, message: `${data ?? 0} templates synchronised${complete ? '' : ' (partial)'}.` }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const who = await authorizeWa(req, deps)
  if ('status' in who) return reply(who.status, { error: who.error })
  let body: { action?: string } = {}
  try {
    const t = await req.text()
    body = t ? JSON.parse(t) : {}
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const action = body.action ?? 'all'
  if (!['all', 'test', 'templates'].includes(action)) return reply(400, { error: 'Unknown action.' })
  const token = waSecret('WHATSAPP_ACCESS_TOKEN', deps.env)
  const admin = deps.admin()
  const results = []
  for (const account of who.accounts) {
    const { data: rt } = await admin.rpc<WaRuntime | null>('support_whatsapp_runtime', { p_account: account })
    if (!rt || !rt.graph_api_version || !rt.phone_number_id || !rt.waba_id) { results.push({ account, ok: false, message: 'Enter the Meta ids and the Graph API version first.' }); continue }
    const out: Record<string, unknown> = { account }
    if (action === 'all' || action === 'test') out.test = await testConnection(deps, rt, token)
    if (action === 'all' || action === 'templates') out.templates = await syncTemplates(deps, rt, token)
    results.push(out)
  }
  if (action === 'all' && !who.caller) await admin.rpc('support_whatsapp_purge_payloads', { p_days: 30 })
  return reply(200, { results })
}
