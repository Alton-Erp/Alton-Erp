// Supabase Edge Function: amazon-spapi
//
// Read-only Selling Partner API synchronisation for the ERP company named in
// AMAZON_COMPANY_CODE. Actions (POST JSON { action, ... }):
//   config   which secrets are set (names only) - amazon.read / amazon_integration.manage
//   test     LWA token + marketplace participations + permission diagnostics
//   sync     { kind: LISTINGS | SALES_TRAFFIC | INVENTORY | FINANCES, from?, to?, key }
//   resume   { job_id } continue a job waiting for Amazon reports
// Secrets (Supabase > Edge Functions > Secrets; never in the browser or database):
//   AMAZON_SPAPI_LWA_CLIENT_ID, AMAZON_SPAPI_LWA_CLIENT_SECRET, AMAZON_SPAPI_REFRESH_TOKEN,
//   AMAZON_SPAPI_REGION (NA | EU | FE; Amazon.in = EU), AMAZON_SPAPI_MARKETPLACE_IDS (comma list, e.g. A21TJRUUN4KGV),
//   AMAZON_COMPANY_CODE (the ERP company these credentials belong to), optional AMAZON_SPAPI_SANDBOX=true,
//   ALLOWED_ORIGINS, AMAZON_TIMEZONE_OFFSET_MINUTES (default 330 = India).
// Deploy: supabase functions deploy amazon-spapi

import { authenticate, configStatus, daysBetween, env, isIsoDate, isUuid, json, logApiError, pollUntil, rpcOrThrow, secretValues, type Caller } from '../_shared/amazon/edge.ts'
import { AmazonApiError, redact } from '../_shared/amazon/http.ts'
import { getAccessToken } from '../_shared/amazon/lwa.ts'
import { feeRows, inventoryRows, listingRows, salesTrafficRows, SPAPI_HOSTS, SPAPI_SANDBOX_HOSTS, SpApiClient } from '../_shared/amazon/spapi.ts'

const SECRET_NAMES = ['AMAZON_SPAPI_LWA_CLIENT_ID', 'AMAZON_SPAPI_LWA_CLIENT_SECRET', 'AMAZON_SPAPI_REFRESH_TOKEN']
const CONFIG_NAMES = [...SECRET_NAMES, 'AMAZON_SPAPI_REGION', 'AMAZON_SPAPI_MARKETPLACE_IDS', 'AMAZON_COMPANY_CODE']
const MAX_DAYS_PER_CALL = 7
const POLL_BUDGET_MS = 45_000

function client(): SpApiClient | null {
  if (SECRET_NAMES.some((n) => !env(n))) return null
  const region = (env('AMAZON_SPAPI_REGION') || 'EU').toUpperCase()
  const host = (env('AMAZON_SPAPI_SANDBOX') === 'true' ? SPAPI_SANDBOX_HOSTS : SPAPI_HOSTS)[region]
  if (!host) return null
  const creds = { clientId: env('AMAZON_SPAPI_LWA_CLIENT_ID'), clientSecret: env('AMAZON_SPAPI_LWA_CLIENT_SECRET'), refreshToken: env('AMAZON_SPAPI_REFRESH_TOKEN') }
  return new SpApiClient({ host, fetchFn: fetch, secrets: secretValues(SECRET_NAMES), accessToken: () => getAccessToken(creds, fetch), retry: { maxAttempts: 5 } })
}
const marketplaces = () => env('AMAZON_SPAPI_MARKETPLACE_IDS').split(',').map((m) => m.trim()).filter(Boolean)
const tzOffset = () => Number(env('AMAZON_TIMEZONE_OFFSET_MINUTES') || 330)
const tzSuffix = () => {
  const m = tzOffset()
  const sign = m >= 0 ? '+' : '-'
  const a = Math.abs(m)
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

async function diagnostics(c: Caller, sp: SpApiClient, mp: string) {
  const checks: { name: string; status: 'PASS' | 'FAIL'; detail: string }[] = []
  const probe = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      checks.push({ name, status: 'PASS', detail: 'Accessible' })
    } catch (e) {
      checks.push({ name, status: 'FAIL', detail: redact((e as Error).message, secretValues(SECRET_NAMES)).slice(0, 200) })
      await logApiError(c, null, 'SP_API', `diagnostics: ${name}`, e, secretValues(SECRET_NAMES))
    }
  }
  const day = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
  await probe('FBA inventory (Amazon Fulfillment role)', () => sp.request('GET', '/fba/inventory/v1/summaries', 'diagnostics', { granularityType: 'Marketplace', granularityId: mp, marketplaceIds: mp }))
  await probe('Finances (Finance and Accounting role)', () => sp.request('GET', '/finances/v0/financialEvents', 'diagnostics', { PostedAfter: `${day}T00:00:00Z`, MaxResultsPerPage: '1' }))
  await probe('Reports (Brand Analytics role, for the Sales & Traffic report)', () => sp.request('GET', '/reports/2021-06-30/reports', 'diagnostics', { reportTypes: 'GET_SALES_AND_TRAFFIC_REPORT', pageSize: '1' }))
  return checks
}

async function ingest(c: Caller, jobId: string, kind: string, rows: unknown[]) {
  for (let i = 0; i < rows.length; i += 5000) await rpcOrThrow(c.admin, 'amazon_service_ingest', { p_company: c.companyId, p_job: jobId, p_kind: kind, p_rows: rows.slice(i, i + 5000) })
}

/** Processes pending report requests; returns those still pending. */
async function processReports(c: Caller, sp: SpApiClient, jobId: string, pending: { reportId: string; kind: string; date?: string; marketplace: string }[], deadline: number) {
  const still: typeof pending = []
  for (const p of pending) {
    const done = await pollUntil(async () => {
      const r = await sp.getReport(p.reportId)
      if (r.processingStatus === 'DONE') return r
      if (r.processingStatus === 'CANCELLED' || r.processingStatus === 'FATAL') throw new AmazonApiError(`Report ${p.kind} ${p.date ?? ''} ended as ${r.processingStatus}`, null, `REPORT_${r.processingStatus}`, false)
      return null
    }, deadline)
    if (!done) { still.push(p); continue }
    if (!done.reportDocumentId) continue
    const text = await sp.downloadReportDocument(done.reportDocumentId)
    if (p.kind === 'SALES_TRAFFIC') await ingest(c, jobId, 'SKU_SALES', salesTrafficRows(text, p.date!, p.marketplace))
    else await ingest(c, jobId, 'LISTINGS', listingRows(text, p.marketplace))
  }
  return still
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
  if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed' })
  let body: { action?: string; kind?: string; from?: string; to?: string; key?: string; job_id?: string }
  try {
    body = await req.json()
  } catch {
    return json(req, 400, { error: 'Invalid request body' })
  }
  const caller = await authenticate(req, body.action === 'config' ? ['amazon.read', 'amazon_integration.manage'] : ['amazon_integration.manage'])
  if (caller instanceof Response) return caller
  const c = caller
  const secrets = secretValues(SECRET_NAMES)

  if (body.action === 'config') return json(req, 200, { api: 'SP_API', variables: configStatus(CONFIG_NAMES), marketplaces: marketplaces(), region: env('AMAZON_SPAPI_REGION') || null })

  const sp = client()
  if (!sp || !marketplaces().length) {
    await rpcOrThrow(c.admin, 'amazon_service_connection_update', { p_company: c.companyId, p_api: 'SP_API', p_patch: { status: 'NOT_CONFIGURED', last_test_ok: false,
      last_test_message: 'Credentials or marketplace ids are not configured.' } })
    return json(req, 412, { error: 'Selling Partner API credentials are not configured.', variables: configStatus(CONFIG_NAMES) })
  }
  const mp = marketplaces()[0]

  try {
    if (body.action === 'test') {
      const parts = await sp.marketplaceParticipations()
      const ours = parts.filter((p) => marketplaces().includes(p.id))
      const checks = await diagnostics(c, sp, mp)
      const ok = ours.length > 0
      await rpcOrThrow(c.admin, 'amazon_service_connection_update', { p_company: c.companyId, p_api: 'SP_API', p_patch: {
        status: ok ? 'CONNECTED' : 'ERROR', region: (env('AMAZON_SPAPI_REGION') || 'EU').toUpperCase(), marketplace_ids: ours.map((p) => p.id),
        account_name: ours.map((p) => p.name).join(', ') || null, permissions: checks, last_test_ok: ok,
        last_test_message: ok ? `Connected. Participating in ${ours.map((p) => p.name).join(', ')}.` : 'Authorised, but not participating in the configured marketplace(s).' } })
      return json(req, 200, { ok, marketplaces: parts, diagnostics: checks })
    }

    if (body.action === 'sync') {
      const kind = body.kind ?? ''
      if (!['LISTINGS', 'SALES_TRAFFIC', 'INVENTORY', 'FINANCES'].includes(kind)) return json(req, 400, { error: 'Unknown sync kind' })
      if (!isUuid(body.key)) return json(req, 400, { error: 'A request key (UUID) is required' })
      const today = new Date(Date.now() + tzOffset() * 60000).toISOString().slice(0, 10)
      const from = isIsoDate(body.from) ? body.from : today
      const to = isIsoDate(body.to) ? body.to : today
      const days = daysBetween(from, to)
      if ((kind === 'SALES_TRAFFIC' || kind === 'FINANCES') && (days.length === 0 || days.length > MAX_DAYS_PER_CALL)) {
        return json(req, 400, { error: `Choose 1 to ${MAX_DAYS_PER_CALL} days per synchronisation call (Amazon report and runtime limits).` })
      }
      const job = await rpcOrThrow<{ id: string; duplicate: boolean; status: string }>(c.admin, 'amazon_service_job_start', {
        p_company: c.companyId, p_api: 'SP_API', p_job_type: `SP_${kind}`, p_requested_by: c.userId, p_from: from, p_to: to, p_key: body.key })
      if (job.duplicate) return json(req, 200, { job_id: job.id, duplicate: true, status: job.status })
      const deadline = Date.now() + POLL_BUDGET_MS
      try {
        if (kind === 'INVENTORY') {
          const r = await sp.inventorySummaries(mp)
          await ingest(c, job.id, 'INVENTORY', inventoryRows(r.items, mp, new Date().toISOString()))
          await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: r.complete ? 'SUCCEEDED' : 'PARTIAL',
            p_state: { complete: r.complete }, p_error_code: r.complete ? null : 'PAGE_LIMIT', p_error_message: r.complete ? null : 'Stopped at the page limit; run again to continue.' })
        } else if (kind === 'FINANCES') {
          const r = await sp.financialEvents(`${from}T00:00:00${tzSuffix()}`, `${to}T23:59:59${tzSuffix()}`)
          await ingest(c, job.id, 'SKU_FEES', feeRows(r.items, mp, tzOffset()))
          await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: r.complete ? 'SUCCEEDED' : 'PARTIAL', p_state: { complete: r.complete } })
        } else {
          const pending = kind === 'LISTINGS'
            ? [{ reportId: await sp.createReport('GET_MERCHANT_LISTINGS_ALL_DATA', [mp]), kind, marketplace: mp }]
            : await Promise.all(days.map(async (d) => ({ reportId: await sp.createReport('GET_SALES_AND_TRAFFIC_REPORT', [mp], `${d}T00:00:00${tzSuffix()}`, `${d}T23:59:59${tzSuffix()}`,
                { dateGranularity: 'DAY', asinGranularity: 'SKU' }), kind, date: d, marketplace: mp })))
          const still = await processReports(c, sp, job.id, pending, deadline)
          await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', p_state: { pending: still } })
          return json(req, 200, { job_id: job.id, status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', pending: still.length })
        }
        return json(req, 200, { job_id: job.id, status: 'DONE' })
      } catch (e) {
        await logApiError(c, job.id, 'SP_API', `sync ${kind}`, e, secrets)
        await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: 'FAILED', p_error_code: e instanceof AmazonApiError ? e.code : 'ERROR',
          p_error_message: redact((e as Error).message, secrets) })
        return json(req, 502, { job_id: job.id, status: 'FAILED', error: redact((e as Error).message, secrets) })
      }
    }

    if (body.action === 'resume') {
      const { data: job } = await c.admin.from('amazon_sync_jobs').select('id, status, state, api').eq('id', body.job_id ?? '').eq('company_id', c.companyId).maybeSingle()
      if (!job || job.api !== 'SP_API' || job.status !== 'WAITING_REPORT') return json(req, 400, { error: 'No waiting Selling Partner job with this id.' })
      const still = await processReports(c, sp, job.id, (job.state?.pending ?? []) as { reportId: string; kind: string; date?: string; marketplace: string }[], Date.now() + POLL_BUDGET_MS)
      await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', p_state: { pending: still } })
      return json(req, 200, { job_id: job.id, status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', pending: still.length })
    }
    return json(req, 400, { error: 'Unknown action' })
  } catch (e) {
    await logApiError(c, null, 'SP_API', body.action ?? 'unknown', e, secrets)
    if (body.action === 'test') {
      await c.admin.rpc('amazon_service_connection_update', { p_company: c.companyId, p_api: 'SP_API', p_patch: { status: 'ERROR', last_test_ok: false, last_test_message: redact((e as Error).message, secrets) } })
    }
    const status = e instanceof AmazonApiError && e.status ? (e.status === 401 || e.status === 403 ? 403 : 502) : 502
    return json(req, status, { error: redact((e as Error).message, secrets), code: e instanceof AmazonApiError ? e.code : 'ERROR' })
  }
})
