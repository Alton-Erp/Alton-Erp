// WhatsApp activation preflight: Meta account verification (supabase/functions/_shared/whatsapp/verify.ts) and its
// use by whatsapp-sync-status "test". Read-only GETs to the right object and edge, one result per check,
// Graph errors classified (#100 invalid request, 190 token, 10/200 permission), never the token in evidence.
// Webhook signatures (valid / invalid / raw body / missing WHATSAPP_APP_SECRET / challenge) are tested in
// tests/unit/whatsapp-functions.test.ts ("whatsapp-webhook").
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { verifyMetaAccount } from '../../supabase/functions/_shared/whatsapp/verify.ts'
import type { WaRuntime } from '../../supabase/functions/_shared/whatsapp/whatsapp.ts'
import { handle as syncFn, type Deps } from '../../supabase/functions/whatsapp-sync-status/handler.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TOKEN = 'EAAG-permanent-SECRET-token-123'
const WABA = '1973917729842030'
const REAL_WABA = '1384691633548975'
const PHONE = '1425662810634514'
const APP = '1684047306664863'
const PORTFOLIO = '3489020898058707'
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const RT: WaRuntime = { company_id: 'c', account_id: ACCOUNT, waba_id: WABA, phone_number_id: PHONE, display_phone_number: '+9118001239722', app_id: APP,
  graph_api_version: 'v23.0', setup_state: 'NUMBER_ELIGIBILITY_PENDING', integration_enabled: false, number_path: 'CLOUD_API' }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const graphErr = (code: number, message: string, status = 400) => () => json(status, { error: { message, type: 'OAuthException', code } })

type Hit = { url: string; method: string; auth: string | undefined }
type Route = (u: URL) => Response
// Routes by "path?fields" so the exact object, edge and fields are part of the contract.
function meta(routes: Record<string, Route>) {
  const hits: Hit[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    hits.push({ url, method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
    const u = new URL(url)
    const k = `${u.pathname}${u.searchParams.get('metadata') ? '?metadata' : u.searchParams.get('fields') ? `?${u.searchParams.get('fields')}` : ''}`
    const r = routes[k] ?? routes[u.pathname]
    if (!r) throw new Error(`unexpected fetch ${url}`) // contains the token for debug_token: must never be copied
    return r(u)
  }) as typeof fetch
  return { f, hits }
}
const P = `/v23.0/${PHONE}?id,display_phone_number,verified_name,quality_rating,status,platform_type,code_verification_status`
const W_TYPE = `/v23.0/${WABA}?metadata`
const W_INFO = `/v23.0/${WABA}?id,name,account_review_status`
const W_OWNER = `/v23.0/${WABA}?owner_business_info`
const W_PHONES = `/v23.0/${WABA}/phone_numbers`
const W_APPS = `/v23.0/${WABA}/subscribed_apps`
const DEBUG = '/v23.0/debug_token'
const good = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [P]: () => json(200, { id: PHONE, display_phone_number: '+91 1800 123 9722', verified_name: 'Alton India', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API' }),
  [W_TYPE]: () => json(200, { id: WABA, metadata: { type: 'whatsapp_business_account' } }),
  [W_INFO]: () => json(200, { id: WABA, name: 'Alton India', account_review_status: 'APPROVED' }),
  [W_OWNER]: () => json(200, { owner_business_info: { id: PORTFOLIO, name: 'Alton Hi-Tech' }, id: WABA }),
  [W_PHONES]: () => json(200, { data: [{ id: PHONE, display_phone_number: '+91 1800 123 9722' }] }),
  [W_APPS]: () => json(200, { data: [{ whatsapp_business_api_data: { id: APP, name: 'Alton ERP' } }] }),
  [DEBUG]: () => json(200, { data: { is_valid: true, type: 'SYSTEM_USER', app_id: APP, expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: [WABA] }, { scope: 'whatsapp_business_management', target_ids: [WABA] }] } }),
  ...over,
})
const run = (routes: Record<string, Route>, appSecretConfigured = true) => { const m = meta(routes); return verifyMetaAccount(m.f, RT, TOKEN, { appSecretConfigured }).then((v) => ({ v, hits: m.hits })) }

describe('Meta account verification: requests', () => {
  it('1.–3. separate read-only requests to the right object and edge (no field on the wrong object)', async () => {
    const { v, hits } = await run(good())
    const paths = hits.map((h) => { const u = new URL(h.url); return `${u.pathname}${u.search.replace(/input_token=[^&]+/, 'input_token=…')}` })
    assert.ok(paths.includes(`/v23.0/${WABA}?fields=id%2Cname%2Caccount_review_status`), 'WABA info: id,name,account_review_status')
    assert.ok(paths.includes(`/v23.0/${WABA}?fields=owner_business_info`), 'owner requested on its own')
    assert.ok(paths.some((p) => p.startsWith(`/v23.0/${WABA}/phone_numbers?`)), 'phone_numbers as an edge of the WABA')
    assert.ok(paths.includes(`/v23.0/${WABA}/subscribed_apps`), 'subscribed_apps edge')
    assert.ok(!paths.some((p) => /fields=[^&]*phone_numbers/.test(p)), 'phone_numbers never requested as a field')
    assert.ok(!paths.some((p) => p.startsWith(`/v23.0/${PORTFOLIO}`)), 'nothing requested from the business portfolio object')
    assert.ok(hits.every((h) => h.method === 'GET' && h.auth === `Bearer ${TOKEN}`), 'read-only GETs only')
    assert.ok(Object.values(v.checks).filter((c) => 'status' in c).every((c) => (c as { status: string }).status === 'VERIFIED'))
    assert.equal(v.checks.app_secret.configured, true)
    assert.ok(!JSON.stringify(v).includes(TOKEN), 'the evidence never contains the token')
  })
  it('4./5./6. ownership, number match and CONNECTED read from Meta', async () => {
    const { v } = await run(good())
    assert.equal(v.checks.ownership.owner_business_id, PORTFOLIO)
    assert.equal(v.checks.phone_registration.phone_status, 'CONNECTED')
    assert.equal(v.checks.phone_registration.verified, true)
    assert.equal(v.checks.phone_in_waba.verified, true)
  })
  it('7. a status other than CONNECTED: the exact status and its meaning (normalised, not re-registered)', async () => {
    const { v, hits } = await run(good({ [P]: () => json(200, { display_phone_number: '+91 1800 123 9722', status: ' disconnected ', platform_type: 'CLOUD_API' }) }))
    assert.equal(v.checks.phone_registration.status, 'VERIFICATION_FAILED')
    assert.match(v.checks.phone_registration.error_message ?? '', /status DISCONNECTED: not connected/)
    assert.ok(!hits.some((h) => /register|deregister/.test(h.url)))
  })
  it('5b. Meta reports another number for the phone number id: wrong account', async () => {
    const { v } = await run(good({ [P]: () => json(200, { display_phone_number: '+91 98765 00000', status: 'CONNECTED' }) }))
    assert.equal(v.checks.phone_registration.status, 'WRONG_ACCOUNT')
  })
})

describe('Meta account verification: errors classified, one result per check', () => {
  it('8. the production #100 errors: invalid request with code and explanation; other checks keep their own result', async () => {
    const { v } = await run(good({
      [W_TYPE]: graphErr(100, 'Unsupported get request'),
      [W_INFO]: graphErr(100, '(#100) Tried accessing nonexisting field (name)'),
      [W_OWNER]: graphErr(100, '(#100) Tried accessing nonexisting field (owner_business_info)'),
      [W_PHONES]: graphErr(100, '(#100) Tried accessing nonexisting field (phone_numbers)'),
      [W_APPS]: graphErr(100, '(#100) Tried accessing nonexisting field (subscribed_apps)'),
    }))
    assert.equal(v.checks.waba.status, 'INVALID_REQUEST')
    assert.equal(v.checks.waba.error_code, 100)
    assert.match(String(v.checks.waba.hint), /probably not a WABA id/)
    assert.equal(v.checks.phone_in_waba.status, 'INVALID_REQUEST')
    assert.match(v.checks.phone_in_waba.error_message ?? '', /nonexisting field \(phone_numbers\)/)
    assert.equal(v.checks.phone_registration.status, 'VERIFIED', 'the number itself is still verified')
    assert.equal(v.checks.token.status, 'VERIFIED')
  })
  it('9. the configured id is another object type: wrong account; the WABA that holds the number is suggested (never applied)', async () => {
    const { v, hits } = await run(good({
      [W_TYPE]: () => json(200, { id: WABA, metadata: { type: 'whatsapp_business_phone_number' } }),
      [DEBUG]: () => json(200, { data: { is_valid: true, type: 'SYSTEM_USER', expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
        granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [REAL_WABA] }, { scope: 'whatsapp_business_messaging', target_ids: [REAL_WABA] }] } }),
      [`/v23.0/${REAL_WABA}/phone_numbers`]: () => json(200, { data: [{ id: PHONE }] }),
    }))
    assert.equal(v.checks.waba.status, 'WRONG_ACCOUNT')
    assert.match(v.checks.waba.error_message ?? '', /is a whatsapp business phone number, not a WhatsApp Business Account/)
    assert.equal(v.checks.phone_in_waba.suggested_waba_id, REAL_WABA)
    assert.equal(v.checks.token.status, 'PERMISSION_DENIED', `the token covers ${REAL_WABA}, not ${WABA}`)
    assert.ok(!hits.some((h) => [`/v23.0/${WABA}?fields=id%2Cname`, `/v23.0/${WABA}/phone_numbers`].some((x) => h.url.includes(x))), 'no further requests to a non-WABA object')
  })
  it('10. invalid phone number id: invalid request', async () => {
    const { v } = await run(good({ [P]: graphErr(100, "Unsupported get request. Object with ID '1425662810634514' does not exist") }))
    assert.equal(v.checks.phone_registration.status, 'INVALID_REQUEST')
  })
  it('11. missing permission (code 200 / scope) and a token limited to another WABA: permission denied', async () => {
    let { v } = await run(good({ [W_OWNER]: graphErr(200, '(#200) Permissions error', 403) }))
    assert.equal(v.checks.ownership.status, 'PERMISSION_DENIED')
    ;({ v } = await run(good({ [DEBUG]: () => json(200, { data: { is_valid: true, type: 'SYSTEM_USER', expires_at: 0, scopes: ['whatsapp_business_messaging'] } }) })))
    assert.equal(v.checks.token.status, 'PERMISSION_DENIED')
    assert.match(v.checks.token.error_message ?? '', /whatsapp_business_management/)
  })
  it('12. expired token (190): verification failed with code 190; not describable', async () => {
    const e = graphErr(190, 'Session has expired', 401)
    const { v } = await run({ [P]: e, [W_TYPE]: e, [W_INFO]: e, [W_OWNER]: e, [W_PHONES]: e, [W_APPS]: e, [DEBUG]: e })
    assert.equal(v.checks.token.error_code, 190)
    assert.equal(v.checks.token.describable, false)
    assert.ok(Object.values(v.checks).filter((c) => 'status' in c).every((c) => (c as { status: string }).status === 'VERIFICATION_FAILED'))
  })
  it('a token that expires is not permanent: verification failed', async () => {
    const { v } = await run(good({ [DEBUG]: () => json(200, { data: { is_valid: true, type: 'SYSTEM_USER', expires_at: 1900000000,
      scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } }) }))
    assert.match(v.checks.token.error_message ?? '', /permanent/)
  })
  it('app not subscribed: wrong account with the subscribed list', async () => {
    const { v } = await run(good({ [W_APPS]: () => json(200, { data: [] }) }))
    assert.equal(v.checks.subscription.status, 'WRONG_ACCOUNT')
  })
  it('13. WHATSAPP_APP_SECRET missing is recorded (presence only)', async () => {
    const { v } = await run(good(), false)
    assert.equal(v.checks.app_secret.configured, false)
  })
  it('a failed request is never copied (its URL can contain the token)', async () => {
    const { v } = await run({})
    assert.equal(v.checks.token.error_message, 'Meta could not be reached.')
    assert.ok(!JSON.stringify(v).includes(TOKEN))
  })
})

describe('whatsapp-sync-status test action stores the evidence', () => {
  const runTest = async (env: Record<string, string>, verificationError = false) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = []
    const client = {
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        calls.push({ fn, args })
        if (fn === 'support_whatsapp_admin_check') return { data: { account_id: ACCOUNT }, error: null }
        if (fn === 'support_whatsapp_runtime') return { data: RT, error: null }
        if (fn === 'support_whatsapp_verification_result' && verificationError) return { data: null, error: { code: 'P0001', message: 'version 2 expected' } }
        return { data: null, error: null }
      },
    }
    const m = meta(good({ [`/v23.0/${PHONE}?display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,status,name_status,is_on_biz_app,throughput`]:
      () => json(200, { display_phone_number: '+91 1800 123 9722', verified_name: 'Alton India', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API' }) }))
    const deps = { allowedOrigins: [], env: (k: string) => env[k], admin: () => client, caller: () => client, fetch: m.f, sleep: async () => {} } as unknown as Deps
    const res = await syncFn(new Request('https://f/sync', { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({ action: 'test' }) }), deps)
    return { res, calls, body: await res.json() as { results: { test?: { ok: boolean; message: string } }[] } }
  }
  it('phone test first, then the version-2 verification with the app-secret presence; message unchanged; no token stored', async () => {
    const { calls, body } = await runTest({ WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_APP_SECRET: 'app-secret-value' })
    assert.deepEqual(calls.map((c) => c.fn).filter((f) => f === 'support_whatsapp_test_result' || f === 'support_whatsapp_verification_result'),
      ['support_whatsapp_test_result', 'support_whatsapp_verification_result'])
    assert.match(body.results[0].test?.message ?? '', /Connected: Alton India \+91 1800 123 9722 on the Cloud API, quality GREEN/)
    const ev = calls.find((c) => c.fn === 'support_whatsapp_verification_result')!.args.p_verification as { version: number; checks: { app_secret: { configured: boolean } } }
    assert.equal(ev.version, 2)
    assert.equal(ev.checks.app_secret.configured, true)
    assert.ok(!JSON.stringify(calls).includes(TOKEN) && !JSON.stringify(calls).includes('app-secret-value'), 'neither the token nor the app secret reaches the database')
  })
  it('13b. without WHATSAPP_APP_SECRET the evidence says so (the access token is never used instead)', async () => {
    const { calls } = await runTest({ WHATSAPP_ACCESS_TOKEN: TOKEN })
    const ev = calls.find((c) => c.fn === 'support_whatsapp_verification_result')!.args.p_verification as { checks: { app_secret: { configured: boolean } } }
    assert.equal(ev.checks.app_secret.configured, false)
  })
  it('if the database refuses the evidence, the test result still stands', async () => {
    const { res, body } = await runTest({ WHATSAPP_ACCESS_TOKEN: TOKEN }, true)
    assert.equal(res.status, 200)
    assert.equal(body.results[0].test?.ok, true)
  })
})

describe('one gate in the settings screen', () => {
  const ui = readFileSync(path.join(root, 'src/features/support/whatsapp-settings.tsx'), 'utf8')
  it('Switch on and the status come from the server preflight', () => {
    assert.match(ui, /pre\.can_activate/)
    assert.ok(!/setup_state !== 'CONNECTED'/.test(ui), 'no frontend-only activation rule')
    assert.match(ui, /useAsync\(\(\) => fetchWaConfig\(\), \[refresh\]\)/, 'the page reloads after Test connection / checklist / Switch on')
  })
  it('18. blocker lines are keyed by position, so identical texts never leave stale lines; each check shows its own reason', () => {
    assert.ok(!/blockers\.map\(\(b\) => <li key=\{b\}>/.test(ui))
    assert.match(ui, /blockers\.map\(\(b, i\) =>/)
    assert.match(ui, /WA_CHECK_REASON\[k\.reason\]/)
  })
  it('read-only at Meta and no message history touched', () => {
    const verify = readFileSync(path.join(root, 'supabase/functions/_shared/whatsapp/verify.ts'), 'utf8')
    assert.ok(!/method:\s*'(POST|DELETE)'/.test(verify) && !/\/register|deregister/.test(verify))
    const sql = readFileSync(path.join(root, 'supabase/migrations/20261220090000_whatsapp_preflight_checks.sql'), 'utf8')
    assert.ok(!/delete from public\.support_whatsapp_/i.test(sql) && !/update public\.support_whatsapp_(messages|statuses|threads|webhook_events)/i.test(sql))
  })
})
