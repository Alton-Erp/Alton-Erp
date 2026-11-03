// Supabase Edge Function: amazon-ads
//
// Amazon Ads API for the ERP company named in AMAZON_COMPANY_CODE (separate
// application and refresh token from the Selling Partner API).
// Actions (POST JSON { action, ... }):
//   config           which secrets are set (names only)
//   test             token + advertising profiles; stores the selected profile
//   sync_entities    { key } campaigns, ad groups, keywords, targets, negatives
//   request_reports  { from, to, key } daily campaign / advertised product / search term reports
//   resume           { job_id } download reports that were still being generated
//   execute_change   { id } apply ONE approved change request (amazon_ads.approve);
//                    refused unless automation = APPROVAL_REQUIRED, kill switch OFF,
//                    connection CONNECTED and the limits / current value still hold.
// Secrets: AMAZON_ADS_CLIENT_ID, AMAZON_ADS_CLIENT_SECRET, AMAZON_ADS_REFRESH_TOKEN,
//   AMAZON_ADS_REGION (NA | EU | FE; Amazon.in = EU), AMAZON_ADS_PROFILE_ID, AMAZON_COMPANY_CODE, ALLOWED_ORIGINS.
// Deploy: supabase functions deploy amazon-ads

import { adGroupRows, ADS_HOSTS, AdsClient, campaignRows, reportRows, reportSpecs, targetRows, type ReportSpec } from '../_shared/amazon/ads.ts'
import { authenticate, configStatus, daysBetween, env, isIsoDate, isUuid, json, logApiError, pollUntil, rpcOrThrow, secretValues, type Caller } from '../_shared/amazon/edge.ts'
import { AmazonApiError, redact } from '../_shared/amazon/http.ts'
import { ADS_LWA_TOKEN_URLS, getAccessToken } from '../_shared/amazon/lwa.ts'

const SECRET_NAMES = ['AMAZON_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_SECRET', 'AMAZON_ADS_REFRESH_TOKEN']
const CONFIG_NAMES = [...SECRET_NAMES, 'AMAZON_ADS_REGION', 'AMAZON_ADS_PROFILE_ID', 'AMAZON_COMPANY_CODE']
const MAX_REPORT_DAYS = 31
const POLL_BUDGET_MS = 45_000

function ads(profileId: string | null): AdsClient | null {
  if (SECRET_NAMES.some((n) => !env(n))) return null
  const region = (env('AMAZON_ADS_REGION') || 'EU').toUpperCase()
  const host = ADS_HOSTS[region]
  if (!host) return null
  const creds = { clientId: env('AMAZON_ADS_CLIENT_ID'), clientSecret: env('AMAZON_ADS_CLIENT_SECRET'), refreshToken: env('AMAZON_ADS_REFRESH_TOKEN') }
  return new AdsClient({ host, clientId: creds.clientId, profileId, fetchFn: fetch, secrets: secretValues(SECRET_NAMES), accessToken: () => getAccessToken(creds, fetch, { tokenUrl: ADS_LWA_TOKEN_URLS[region] }), retry: { maxAttempts: 5 } })
}

async function ingest(c: Caller, jobId: string, kind: string, rows: unknown[]) {
  for (let i = 0; i < rows.length; i += 5000) await rpcOrThrow(c.admin, 'amazon_service_ingest', { p_company: c.companyId, p_job: jobId, p_kind: kind, p_rows: rows.slice(i, i + 5000) })
}

type Pending = { reportId: string; kind: ReportSpec['kind'] }
async function processReports(c: Caller, client: AdsClient, jobId: string, pending: Pending[], profileId: string, window: number, deadline: number) {
  const still: Pending[] = []
  for (const p of pending) {
    const done = await pollUntil(async () => {
      const r = await client.getReport(p.reportId)
      if (r.status === 'COMPLETED' && r.url) return r
      if (r.status === 'FAILED') throw new AmazonApiError(`Report ${p.kind} failed: ${r.failureReason ?? 'no reason given'}`, null, 'REPORT_FAILED', false)
      return null
    }, deadline)
    if (!done) { still.push(p); continue }
    await ingest(c, jobId, p.kind, reportRows(p.kind, await client.downloadReport(done.url!), profileId, window))
  }
  return still
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
  if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed' })
  let body: { action?: string; from?: string; to?: string; key?: string; job_id?: string; id?: string }
  try {
    body = await req.json()
  } catch {
    return json(req, 400, { error: 'Invalid request body' })
  }
  const needs = body.action === 'config' ? ['amazon.read', 'amazon_integration.manage'] : body.action === 'execute_change' ? ['amazon_ads.approve'] : ['amazon_integration.manage']
  const caller = await authenticate(req, needs)
  if (caller instanceof Response) return caller
  const c = caller
  const secrets = secretValues(SECRET_NAMES)
  if (body.action === 'config') return json(req, 200, { api: 'ADS_API', variables: configStatus(CONFIG_NAMES), region: env('AMAZON_ADS_REGION') || null, profile_id: env('AMAZON_ADS_PROFILE_ID') || null })

  const profileId = env('AMAZON_ADS_PROFILE_ID') || null
  const noProfile = ads(null)
  if (!noProfile) {
    await rpcOrThrow(c.admin, 'amazon_service_connection_update', { p_company: c.companyId, p_api: 'ADS_API', p_patch: { status: 'NOT_CONFIGURED', last_test_ok: false,
      last_test_message: 'Amazon Ads credentials are not configured.' } })
    return json(req, 412, { error: 'Amazon Ads API credentials are not configured.', variables: configStatus(CONFIG_NAMES) })
  }

  try {
    if (body.action === 'test') {
      const profiles = await noProfile.profiles()
      const selected = profiles.find((p) => p.profileId === profileId) ?? null
      const ok = Boolean(selected)
      await rpcOrThrow(c.admin, 'amazon_service_connection_update', { p_company: c.companyId, p_api: 'ADS_API', p_patch: {
        status: ok ? 'CONNECTED' : 'ERROR', region: (env('AMAZON_ADS_REGION') || 'EU').toUpperCase(), profile_id: selected?.profileId ?? null,
        account_identifier: selected?.accountId ?? null, account_name: selected?.accountName ?? null, marketplace_ids: selected?.marketplaceId ? [selected.marketplaceId] : [],
        permissions: profiles.map((p) => ({ name: `Profile ${p.profileId} (${p.countryCode}, ${p.accountType ?? 'account'})`, status: p.profileId === profileId ? 'PASS' : 'INFO',
          detail: p.accountName ?? '' })), last_test_ok: ok,
        last_test_message: ok ? `Connected to profile ${selected!.profileId} (${selected!.countryCode}).`
          : profileId ? `Profile ${profileId} is not available to this login. Available: ${profiles.map((p) => `${p.profileId} (${p.countryCode})`).join(', ') || 'none'}.`
          : `Set AMAZON_ADS_PROFILE_ID to one of: ${profiles.map((p) => `${p.profileId} (${p.countryCode})`).join(', ') || 'none'}.` } })
      return json(req, 200, { ok, profiles })
    }

    const client = ads(profileId)!
    const { data: conn } = await c.admin.from('amazon_connections').select('status, profile_id').eq('company_id', c.companyId).eq('api', 'ADS_API').maybeSingle()
    if (!profileId || conn?.status !== 'CONNECTED' || conn.profile_id !== profileId) return json(req, 412, { error: 'Run "Test connection" for the Ads API first (profile not confirmed).' })
    const { data: settings } = await c.admin.from('amazon_settings').select('attribution_window_days').eq('company_id', c.companyId).maybeSingle()
    const window = settings?.attribution_window_days ?? 7

    if (body.action === 'sync_entities') {
      if (!isUuid(body.key)) return json(req, 400, { error: 'A request key (UUID) is required' })
      const job = await rpcOrThrow<{ id: string; duplicate: boolean; status: string }>(c.admin, 'amazon_service_job_start', {
        p_company: c.companyId, p_api: 'ADS_API', p_job_type: 'ADS_ENTITIES', p_requested_by: c.userId, p_from: null, p_to: null, p_key: body.key })
      if (job.duplicate) return json(req, 200, { job_id: job.id, duplicate: true, status: job.status })
      try {
        const [camps, groups, kws, tgts, negs] = await Promise.all([client.campaigns(), client.adGroups(), client.keywords(), client.targets(), client.negativeKeywords()])
        await ingest(c, job.id, 'CAMPAIGNS', campaignRows(camps.items, profileId))
        await ingest(c, job.id, 'AD_GROUPS', adGroupRows(groups.items, profileId))
        await ingest(c, job.id, 'TARGETS', targetRows(kws.items, tgts.items, negs.items, profileId))
        const complete = [camps, groups, kws, tgts, negs].every((x) => x.complete)
        await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: complete ? 'SUCCEEDED' : 'PARTIAL', p_state: { complete } })
        return json(req, 200, { job_id: job.id, status: complete ? 'SUCCEEDED' : 'PARTIAL' })
      } catch (e) {
        await logApiError(c, job.id, 'ADS_API', 'sync_entities', e, secrets)
        await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: 'FAILED', p_error_code: e instanceof AmazonApiError ? e.code : 'ERROR', p_error_message: redact((e as Error).message, secrets) })
        return json(req, 502, { job_id: job.id, status: 'FAILED', error: redact((e as Error).message, secrets) })
      }
    }

    if (body.action === 'request_reports') {
      if (!isUuid(body.key) || !isIsoDate(body.from) || !isIsoDate(body.to)) return json(req, 400, { error: 'from, to (YYYY-MM-DD) and a request key (UUID) are required' })
      const days = daysBetween(body.from, body.to).length
      if (days < 1 || days > MAX_REPORT_DAYS) return json(req, 400, { error: `Choose 1 to ${MAX_REPORT_DAYS} days per report request.` })
      const job = await rpcOrThrow<{ id: string; duplicate: boolean; status: string }>(c.admin, 'amazon_service_job_start', {
        p_company: c.companyId, p_api: 'ADS_API', p_job_type: 'ADS_REPORTS', p_requested_by: c.userId, p_from: body.from, p_to: body.to, p_key: body.key })
      if (job.duplicate) return json(req, 200, { job_id: job.id, duplicate: true, status: job.status })
      try {
        const pending: Pending[] = []
        for (const spec of reportSpecs(window)) pending.push({ reportId: await client.createReport(spec, body.from, body.to), kind: spec.kind })
        const still = await processReports(c, client, job.id, pending, profileId, window, Date.now() + POLL_BUDGET_MS)
        await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', p_state: { pending: still, window } })
        return json(req, 200, { job_id: job.id, status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', pending: still.length })
      } catch (e) {
        await logApiError(c, job.id, 'ADS_API', 'request_reports', e, secrets)
        await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: 'FAILED', p_error_code: e instanceof AmazonApiError ? e.code : 'ERROR', p_error_message: redact((e as Error).message, secrets) })
        return json(req, 502, { job_id: job.id, status: 'FAILED', error: redact((e as Error).message, secrets) })
      }
    }

    if (body.action === 'resume') {
      const { data: job } = await c.admin.from('amazon_sync_jobs').select('id, status, state, api').eq('id', body.job_id ?? '').eq('company_id', c.companyId).maybeSingle()
      if (!job || job.api !== 'ADS_API' || job.status !== 'WAITING_REPORT') return json(req, 400, { error: 'No waiting Ads job with this id.' })
      const still = await processReports(c, client, job.id, (job.state?.pending ?? []) as Pending[], profileId, job.state?.window ?? window, Date.now() + POLL_BUDGET_MS)
      await rpcOrThrow(c.admin, 'amazon_service_job_update', { p_company: c.companyId, p_job: job.id, p_status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', p_state: { pending: still, window } })
      return json(req, 200, { job_id: job.id, status: still.length ? 'WAITING_REPORT' : 'SUCCEEDED', pending: still.length })
    }

    if (body.action === 'execute_change') {
      const claim = await rpcOrThrow<{ ok: boolean; reason?: string; request?: { id: string; change_type: string; campaign_id: string; ad_group_id: string | null; target_id: string | null;
        proposed_value: Record<string, unknown> } }>(c.admin, 'amazon_service_change_claim', { p_company: c.companyId, p_id: body.id, p_executor: c.userId })
      if (!claim.ok || !claim.request) return json(req, 409, { error: claim.reason ?? 'The change cannot be executed.' })
      const r = claim.request
      let result: { ok: boolean; error: string | null; requestId: string | null; response: unknown }
      try {
        const v = r.proposed_value
        if (r.change_type === 'CAMPAIGN_BUDGET') result = await client.updateCampaign(r.campaign_id, { budget: Number(v.daily_budget) })
        else if (r.change_type === 'CAMPAIGN_STATE') result = await client.updateCampaign(r.campaign_id, { state: v.state as 'ENABLED' | 'PAUSED' })
        else if (r.change_type === 'NEGATIVE_KEYWORD') {
          if (!v.ad_group_id && !r.ad_group_id) throw new Error('An ad group is required for a negative keyword.')
          result = await client.createNegativeKeyword(r.campaign_id, String(v.ad_group_id ?? r.ad_group_id), String(v.keyword), v.match_type as 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE')
        } else {
          const { data: t } = await c.admin.from('amazon_targets').select('target_type').eq('company_id', c.companyId).eq('target_id', r.target_id ?? '').maybeSingle()
          const kind = t?.target_type === 'KEYWORD' ? 'KEYWORD' : 'TARGET'
          result = await client.updateBid(kind, String(r.target_id), r.change_type === 'TARGET_BID' ? { bid: Number(v.bid) } : { state: v.state as 'ENABLED' | 'PAUSED' })
        }
      } catch (e) {
        await logApiError(c, null, 'ADS_API', `execute_change ${r.change_type}`, e, secrets)
        result = { ok: false, error: redact((e as Error).message, secrets), requestId: e instanceof AmazonApiError ? e.requestId : null, response: null }
      }
      await rpcOrThrow(c.admin, 'amazon_service_change_result', { p_company: c.companyId, p_id: r.id, p_success: result.ok, p_request_id: result.requestId,
        p_response: result.response === undefined ? null : JSON.parse(redact(JSON.stringify(result.response ?? null), secrets)), p_error: result.error })
      return json(req, result.ok ? 200 : 502, { ok: result.ok, status: result.ok ? 'SUCCEEDED' : 'FAILED', error: result.error, request_id: result.requestId })
    }
    return json(req, 400, { error: 'Unknown action' })
  } catch (e) {
    await logApiError(c, null, 'ADS_API', body.action ?? 'unknown', e, secrets)
    if (body.action === 'test') {
      await c.admin.rpc('amazon_service_connection_update', { p_company: c.companyId, p_api: 'ADS_API', p_patch: { status: 'ERROR', last_test_ok: false, last_test_message: redact((e as Error).message, secrets) } })
    }
    return json(req, e instanceof AmazonApiError && (e.status === 401 || e.status === 403) ? 403 : 502, { error: redact((e as Error).message, secrets), code: e instanceof AmazonApiError ? e.code : 'ERROR' })
  }
})
