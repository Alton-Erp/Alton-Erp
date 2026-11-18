// WhatsApp activation preflight: Meta account verification (supabase/functions/_shared/whatsapp/verify.ts) and its
// use by whatsapp-sync-status "test". Read-only GETs, evidence without the token, errors never copied from fetch().
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
const PHONE = '1425662810634514'
const APP = '1684047306664863'
const PORTFOLIO = '3489020898058707'
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const RT: WaRuntime = { company_id: 'c', account_id: ACCOUNT, waba_id: WABA, phone_number_id: PHONE, display_phone_number: '+9118001239722', app_id: APP,
  graph_api_version: 'v23.0', setup_state: 'NUMBER_ELIGIBILITY_PENDING', integration_enabled: false, number_path: 'CLOUD_API' }
const G = 'https://graph.facebook.com/v23.0'
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Hit = { url: string; method: string; auth: string | undefined }
function meta(routes: Record<string, (u: URL) => Response>) {
  const hits: Hit[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    hits.push({ url, method: init?.method ?? 'GET', auth: (init?.headers as Record<string, string> | undefined)?.Authorization })
    const u = new URL(url)
    const r = Object.entries(routes).find(([p]) => u.pathname === p)
    if (!r) throw new Error(`unexpected fetch ${url}`) // contains the token for debug_token: must never be copied
    return r[1](u)
  }) as typeof fetch
  return { f, hits }
}
const good = (over: Partial<Record<string, (u: URL) => Response>> = {}) => ({
  [`/v23.0/${PHONE}`]: () => json(200, { display_phone_number: '+91 1800 123 9722', verified_name: 'Alton India', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API' }),
  [`/v23.0/${WABA}/phone_numbers`]: () => json(200, { data: [{ id: PHONE, display_phone_number: '+91 1800 123 9722' }] }),
  [`/v23.0/${WABA}`]: () => json(200, { id: WABA, name: 'Alton India', account_review_status: 'APPROVED', owner_business_info: { id: PORTFOLIO, name: 'Alton Hi-Tech' } }),
  [`/v23.0/${WABA}/subscribed_apps`]: () => json(200, { data: [{ whatsapp_business_api_data: { id: APP, name: 'Alton ERP' } }] }),
  '/v23.0/debug_token': () => json(200, { data: { is_valid: true, type: 'SYSTEM_USER', app_id: APP, expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'],
    granular_scopes: [{ scope: 'whatsapp_business_messaging', target_ids: [WABA] }, { scope: 'whatsapp_business_management', target_ids: [WABA] }] } }),
  ...over,
})

describe('Meta account verification', () => {
  it('happy path: number under the WABA, owner portfolio, subscribed app, permanent token with both permissions', async () => {
    const m = meta(good())
    const v = await verifyMetaAccount(m.f, RT, TOKEN)
    assert.equal(v.phone_in_waba, true)
    assert.equal(v.owner_business_id, PORTFOLIO)
    assert.equal(v.account_review_status, 'APPROVED')
    assert.deepEqual(v.subscribed_app_ids, [APP])
    assert.deepEqual(v.token?.scopes, ['whatsapp_business_messaging', 'whatsapp_business_management'])
    assert.deepEqual(v.token?.targets, { whatsapp_business_messaging: [WABA], whatsapp_business_management: [WABA] })
    assert.equal(v.token?.expires_at, 0)
    assert.ok(m.hits.every((h) => h.method === 'GET' && h.auth === `Bearer ${TOKEN}`), 'read-only GETs with the bearer token')
    assert.ok(!JSON.stringify(v).includes(TOKEN), 'the evidence never contains the token')
  })
  it('wrong WABA: the number is not listed (Meta pages followed only for this WABA)', async () => {
    const m = meta(good({ [`/v23.0/${WABA}/phone_numbers`]: (u) => (u.searchParams.get('after')
      ? json(200, { data: [{ id: '999999999999' }], paging: { next: 'https://evil.example/steal' } })
      : json(200, { data: [{ id: '1384691633548975' }], paging: { next: `${G}/${WABA}/phone_numbers?after=X` } })) }))
    const v = await verifyMetaAccount(m.f, RT, TOKEN)
    assert.equal(v.phone_in_waba, false)
    assert.equal(v.waba_phone_count, 2)
    assert.ok(!m.hits.some((h) => h.url.includes('evil')))
  })
  it('owner not returned, another owner, app not subscribed are reported as found', async () => {
    let v = await verifyMetaAccount(meta(good({ [`/v23.0/${WABA}`]: () => json(200, { id: WABA }) })).f, RT, TOKEN)
    assert.equal(v.owner_business_id, null)
    assert.match(v.owner_error ?? '', /did not return the owning business portfolio/)
    v = await verifyMetaAccount(meta(good({ [`/v23.0/${WABA}`]: () => json(200, { owner_business_info: { id: '1384691633548975' } }) })).f, RT, TOKEN)
    assert.equal(v.owner_business_id, '1384691633548975')
    v = await verifyMetaAccount(meta(good({ [`/v23.0/${WABA}/subscribed_apps`]: () => json(200, { data: [] }) })).f, RT, TOKEN)
    assert.deepEqual(v.subscribed_app_ids, [])
  })
  it('expired token (190) and missing permission are evidence, not crashes', async () => {
    const err = () => json(401, { error: { message: 'Session has expired', type: 'OAuthException', code: 190 } })
    let v = await verifyMetaAccount(meta({ [`/v23.0/${WABA}/phone_numbers`]: err, [`/v23.0/${WABA}`]: err, [`/v23.0/${WABA}/subscribed_apps`]: err, '/v23.0/debug_token': err }).f, RT, TOKEN)
    assert.equal(v.phone_in_waba, null)
    assert.match(v.waba_error ?? '', /\(190\)/)
    assert.match(v.token_error ?? '', /\(190\)/)
    v = await verifyMetaAccount(meta(good({ '/v23.0/debug_token': () => json(200, { data: { is_valid: true, type: 'SYSTEM_USER', expires_at: 0, scopes: ['whatsapp_business_messaging'] } }) })).f, RT, TOKEN)
    assert.deepEqual(v.token?.scopes, ['whatsapp_business_messaging'])
    assert.equal(v.token?.targets.whatsapp_business_management, null)
  })
  it('a failed request is never copied (its URL can contain the token)', async () => {
    const v = await verifyMetaAccount(meta({}).f, RT, TOKEN)
    assert.equal(v.token_error, 'Meta could not be reached.')
    assert.ok(!JSON.stringify(v).includes(TOKEN))
  })
})

describe('whatsapp-sync-status test action stores the evidence', () => {
  const run = async (verificationError = false) => {
    const calls: { fn: string; args: Record<string, unknown> }[] = []
    const client = {
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        calls.push({ fn, args })
        if (fn === 'support_whatsapp_admin_check') return { data: { account_id: ACCOUNT }, error: null }
        if (fn === 'support_whatsapp_runtime') return { data: RT, error: null }
        if (fn === 'support_whatsapp_verification_result' && verificationError) return { data: null, error: { code: 'PGRST202', message: 'not found' } }
        return { data: null, error: null }
      },
    }
    const m = meta(good())
    const deps = { allowedOrigins: [], env: (k: string) => ({ WHATSAPP_ACCESS_TOKEN: TOKEN } as Record<string, string>)[k], admin: () => client, caller: () => client,
      fetch: m.f, sleep: async () => {} } as unknown as Deps
    const res = await syncFn(new Request('https://f/sync', { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({ action: 'test' }) }), deps)
    return { res, calls, body: await res.json() as { results: { test?: { ok: boolean; message: string } }[] } }
  }
  it('phone test recorded first, then the account verification; the message is unchanged', async () => {
    const { calls, body } = await run()
    const order = calls.map((c) => c.fn).filter((f) => f.startsWith('support_whatsapp_test_result') || f === 'support_whatsapp_verification_result')
    assert.deepEqual(order, ['support_whatsapp_test_result', 'support_whatsapp_verification_result'])
    assert.equal(body.results[0].test?.ok, true)
    assert.match(body.results[0].test?.message ?? '', /Connected: Alton India \+91 1800 123 9722 on the Cloud API, quality GREEN/)
    const ev = calls.find((c) => c.fn === 'support_whatsapp_verification_result')!.args.p_verification as Record<string, unknown>
    assert.equal(ev.phone_in_waba, true)
    assert.ok(!JSON.stringify(calls).includes(TOKEN), 'the token never reaches the database')
  })
  it('before the migration is applied the verification call fails harmlessly', async () => {
    const { res, body } = await run(true)
    assert.equal(res.status, 200)
    assert.equal(body.results[0].test?.ok, true)
  })
})

describe('one gate in the settings screen', () => {
  it('the Switch on button and status come from the server preflight, not a separate frontend rule', () => {
    const ui = readFileSync(path.join(root, 'src/features/support/whatsapp-settings.tsx'), 'utf8')
    assert.match(ui, /pre\.can_activate/)
    assert.ok(!/setup_state !== 'CONNECTED'/.test(ui), 'no frontend-only activation rule')
    assert.match(ui, /useAsync\(\(\) => fetchWaConfig\(\), \[refresh\]\)/, 'the page reloads after Test connection / checklist / Switch on')
  })
  it('the migration never changes Meta or message history', () => {
    const sql = readFileSync(path.join(root, 'supabase/migrations/20261219090000_whatsapp_activation_preflight.sql'), 'utf8')
    assert.ok(!/delete from public\.support_whatsapp_(messages|statuses|threads|webhook_events)/i.test(sql))
    assert.ok(!/update public\.support_whatsapp_(messages|statuses|threads)/i.test(sql))
    assert.ok(!/method:\s*'(POST|DELETE)'/.test(readFileSync(path.join(root, 'supabase/functions/_shared/whatsapp/verify.ts'), 'utf8')))
  })
})
