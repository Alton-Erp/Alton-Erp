// Acefone Edge Functions with fake Supabase clients and a fake fetch: webhook validation (token, IP, method,
// body), idempotent ingestion, click-to-call (auth, duplicate clicks, accepted / rejected / timeout, Support mode
// credentials), connection test, call-record sync with retries, recordings, and that no secret is ever logged
// or returned.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import {
  acefoneDate, buildClickToCall, eventKey, interpretClickToCall, ipAllowed, parsePayload, readSecret, recordingUrlAllowed, redactPayload, safeEqual,
} from '../../supabase/functions/_shared/acefone/acefone.ts'
import { handle as webhook, type IngestResult, type WebhookDeps } from '../../supabase/functions/acefone-webhook/handler.ts'
import { handle as clickToCall, type Deps as C2CDeps } from '../../supabase/functions/acefone-click-to-call/handler.ts'
import { handle as syncCdr, type Deps as CdrDeps } from '../../supabase/functions/acefone-sync-cdr/handler.ts'
import { syncRecordings, type Deps as RecDeps } from '../../supabase/functions/acefone-recording-sync/handler.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const CALL = '22222222-2222-4222-8222-222222222222'
const SECRET = 'whsec-0123456789abcdef0123456789abcdef'
const TOKEN = 'tok-SECRET-VALUE-123'
const SUPPORT_KEY = 'support-KEY-VALUE-456'
const ENV: Record<string, string> = { ACEFONE_WEBHOOK_SECRET: SECRET, ACEFONE_API_TOKEN: TOKEN, ACEFONE_C2C_SUPPORT_API_KEY: SUPPORT_KEY, ACEFONE_CRON_SECRET: 'cron-1' }

// Capture every log line to prove that no secret is written.
let logs: string[] = []
const orig = { log: console.log, warn: console.warn, error: console.error }
beforeEach(() => { logs = []; console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log })
afterEach(() => { Object.assign(console, orig) })
const noSecretsLogged = () => logs.every((l) => !l.includes(SECRET) && !l.includes(TOKEN) && !l.includes(SUPPORT_KEY) && !l.includes('rec-token'))

describe('Acefone helpers', () => {
  it('secrets are read only under ACEFONE_* names', () => {
    const env = (k: string) => ({ ...ENV, SUPABASE_SERVICE_ROLE_KEY: 'service' } as Record<string, string>)[k]
    assert.equal(readSecret('ACEFONE_API_TOKEN', env), TOKEN)
    assert.equal(readSecret('SUPABASE_SERVICE_ROLE_KEY', env), null)
    assert.equal(readSecret('ACEFONE_MISSING', env), null)
  })
  it('constant-time comparison and IPv4 allowlists', () => {
    assert.ok(safeEqual('abc', 'abc') && !safeEqual('abc', 'abd') && !safeEqual('abc', 'abcd'))
    assert.ok(ipAllowed('1.2.3.4', []))
    assert.ok(ipAllowed('10.0.5.9', ['10.0.0.0/16']) && !ipAllowed('10.1.5.9', ['10.0.0.0/16']) && !ipAllowed(null, ['1.1.1.1']))
  })
  it('payloads: JSON, form and GET; "$" names; secrets and recording tokens redacted', () => {
    assert.deepEqual(parsePayload('POST', 'application/json', '{"$call_id":"9","uuid":"u"}', new URLSearchParams()), { call_id: '9', uuid: 'u' })
    assert.deepEqual(parsePayload('POST', 'application/x-www-form-urlencoded', 'call_id=9&billsec=30', new URLSearchParams()), { call_id: '9', billsec: '30' })
    assert.deepEqual(parsePayload('GET', null, '', new URLSearchParams('account=x&event=y&token=z&call_id=7')), { call_id: '7' })
    assert.throws(() => parsePayload('POST', 'application/json', '[1]', new URLSearchParams()))
    const r = redactPayload({ recording_url: 'https://customer.servetel.in/file/recording?callId=1&token=rec-token', api_key: 'k', call_id: '1' })
    assert.deepEqual(r, { recording_url: 'https://customer.servetel.in/file/recording?[redacted]', api_key: '[redacted]', call_id: '1' })
  })
  it('event keys: the same event is the same key; a different event or content is not', async () => {
    const a = await eventKey('hangup', { call_id: '1', billsec: '30' })
    assert.equal(a, await eventKey('hangup', { billsec: '30', call_id: '1' }))
    assert.notEqual(a, await eventKey('agent_answered', { call_id: '1', billsec: '30' }))
    assert.notEqual(a, await eventKey('hangup', { call_id: '1', billsec: '31' }))
  })
  it('click-to-call requests follow the documentation for both modes', () => {
    const base = { call_id: CALL, mode: 'AGENT' as const, api_base_url: 'https://api.acefone.in', api_token_secret: 'ACEFONE_API_TOKEN', support_api_key_secret: 'ACEFONE_C2C_SUPPORT_API_KEY',
      agent_number: '0501234567', destination_number: '9876543210', caller_id: null, custom_identifier: { erpcall: 'abc' } }
    const a = buildClickToCall(base, TOKEN, null)
    assert.equal(a.url, 'https://api.acefone.in/v1/click_to_call')
    assert.equal(a.init.headers.Authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(JSON.parse(a.init.body), { agent_number: '0501234567', destination_number: '9876543210', async: 1, custom_identifier: { erpcall: 'abc' } })
    const s = buildClickToCall({ ...base, mode: 'SUPPORT', caller_id: '918069400000' }, TOKEN, SUPPORT_KEY)
    assert.equal(s.url, 'https://api.acefone.in/v1/click_to_call_support')
    assert.deepEqual(JSON.parse(s.init.body), { customer_number: '9876543210', api_key: SUPPORT_KEY, async: 1, caller_id: '918069400000', custom_identifier: { erpcall: 'abc' } })
    assert.throws(() => buildClickToCall({ ...base, mode: 'SUPPORT' }, TOKEN, null), /Support API key/)
    assert.throws(() => buildClickToCall({ ...base, api_base_url: 'https://evil.example' }, TOKEN, null), /not allowed/)
  })
  it('acceptance needs HTTP 2xx and success: true', () => {
    assert.deepEqual(interpretClickToCall(200, { success: true, message: 'Call originated successfully.', ref_id: 'C2C1' }), { accepted: true, refId: 'C2C1', message: 'Call originated successfully.' })
    assert.equal(interpretClickToCall(200, { success: false, message: 'Agent is Blocked' }).accepted, false)
    assert.equal(interpretClickToCall(400, { customer_number: ['The customer number must be between 10 and 12 digits.'] }).message, 'The customer number must be between 10 and 12 digits.')
  })
  it('call-record dates in the company time zone; recordings only from provider hosts over HTTPS', () => {
    assert.equal(acefoneDate(new Date('2026-11-13T00:30:00Z'), 'Asia/Kolkata'), '2026-11-13 06:00:00')
    assert.ok(recordingUrlAllowed('https://customer.servetel.in/file/recording?callId=1'))
    assert.ok(!recordingUrlAllowed('http://customer.servetel.in/x') && !recordingUrlAllowed('https://169.254.169.254/latest') && !recordingUrlAllowed('https://evil.example/x'))
  })
})

describe('acefone-webhook', () => {
  const url = (q: Record<string, string>) => `https://fn.example/acefone-webhook?${new URLSearchParams(q)}`
  const make = (over: Partial<WebhookDeps> & { result?: IngestResult } = {}) => {
    const calls: { event: string; payload: Record<string, unknown>; key: string }[] = []
    const seen = new Set<string>()
    const deps: WebhookDeps = {
      secret: (n) => readSecret(n, (k) => ENV[k]),
      runtime: async () => ({ is_enabled: true, webhook_secret_name: 'ACEFONE_WEBHOOK_SECRET', webhook_allowed_ips: [] }),
      ingest: async (_a, event, payload, key) => {
        calls.push({ event, payload, key })
        if (over.result) return over.result
        if (seen.has(key)) return { result: 'DUPLICATE' }
        seen.add(key)
        return { result: 'PROCESSED', call_id: CALL, status: 'RINGING' }
      },
      ...over,
    }
    return { deps, calls }
  }
  const post = (q: Record<string, string>, body: unknown, headers: Record<string, string> = {}) =>
    new Request(url(q), { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4', ...headers }, body: JSON.stringify(body) })

  it('valid event: stored with a key, recording token kept out of the log copy', async () => {
    const { deps, calls } = make()
    const res = await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, { call_id: '1714657799.1', billsec: '42', recording_url: 'https://customer.servetel.in/file/recording?callId=1&token=rec-token' }), deps)
    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].payload.recording_url, 'https://customer.servetel.in/file/recording?[redacted]')
    assert.equal(calls[0].payload.__recording_url, 'https://customer.servetel.in/file/recording?callId=1&token=rec-token')
    assert.match(calls[0].key, /^wh:hangup:1714657799\.1:/)
    assert.ok(noSecretsLogged())
  })
  it('duplicate delivery: 200, processed once', async () => {
    const { deps } = make()
    const body = { call_id: '5', billsec: '0' }
    const r1 = await (await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, body), deps)).json()
    const r2 = await (await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, body), deps)).json()
    assert.deepEqual([r1.result, r2.result], ['PROCESSED', 'DUPLICATE'])
  })
  it('invalid token, missing token, unknown event, bad account and wrong method are refused before anything is stored', async () => {
    const { deps, calls } = make()
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: 'wrong' }, {}), deps)).status, 401)
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup' }, {}), deps)).status, 401)
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'nope', token: SECRET }, {}), deps)).status, 400)
    assert.equal((await webhook(post({ account: 'x', event: 'hangup', token: SECRET }, {}), deps)).status, 400)
    assert.equal((await webhook(new Request(url({ account: ACCOUNT, event: 'hangup', token: SECRET }), { method: 'DELETE' }), deps)).status, 405)
    assert.equal(calls.length, 0)
    assert.ok(noSecretsLogged())
  })
  it('unknown account and missing server secret answer like a wrong token (no enumeration)', async () => {
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, {}), make({ runtime: async () => null }).deps)).status, 401)
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, {}), make({ secret: () => null }).deps)).status, 401)
  })
  it('IP allowlist enforced when configured', async () => {
    const { deps, calls } = make({ runtime: async () => ({ is_enabled: true, webhook_secret_name: 'ACEFONE_WEBHOOK_SECRET', webhook_allowed_ips: ['5.6.7.0/24'] }) })
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, {}), deps)).status, 403)
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, {}, { 'x-forwarded-for': '5.6.7.8' }), deps)).status, 200)
    assert.equal(calls.length, 1)
  })
  it('malformed body 400; processing error 500 (Acefone retries); rate limit 429', async () => {
    const bad = new Request(url({ account: ACCOUNT, event: 'hangup', token: SECRET }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    assert.equal((await webhook(bad, make().deps)).status, 400)
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, { call_id: '1' }), make({ result: { result: 'ERROR' } }).deps)).status, 500)
    assert.equal((await webhook(post({ account: ACCOUNT, event: 'hangup', token: SECRET }, { call_id: '1' }), make({ result: { result: 'RATE_LIMITED' } }).deps)).status, 429)
  })
  it('GET webhooks and form bodies are accepted', async () => {
    const { deps, calls } = make()
    assert.equal((await webhook(new Request(url({ account: ACCOUNT, event: 'received', token: SECRET, call_id: '8', caller_id_number: '9876543210' }), { method: 'GET' }), deps)).status, 200)
    assert.equal(calls[0].payload.caller_id_number, '9876543210')
    assert.ok(!('token' in calls[0].payload))
  })
})

describe('acefone-click-to-call', () => {
  const prep = (over: Record<string, unknown> = {}) => ({ call_id: CALL, duplicate: false, status: 'INITIATED', request_state: 'PENDING', account_id: ACCOUNT, mode: 'AGENT',
    api_base_url: 'https://api.acefone.in', api_token_secret: 'ACEFONE_API_TOKEN', support_api_key_secret: 'ACEFONE_C2C_SUPPORT_API_KEY', agent_number: '0501234567',
    destination_number: '9876543210', caller_id: null, custom_identifier: { erpcall: 'abc' }, ...over })
  const make = (o: { prepare?: { data: unknown; error: unknown }; fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; env?: Record<string, string> } = {}) => {
    const sent: { url: string; init: RequestInit }[] = []
    const results: Record<string, unknown>[] = []
    const deps: C2CDeps = {
      allowedOrigins: ['https://erp.example'], configured: true, env: (k) => (o.env ?? ENV)[k],
      caller: () => ({ rpc: async (fn: string) => (fn === 'support_call_prepare' ? (o.prepare ?? { data: prep(), error: null })
        : fn === 'support_phone_config_get' ? { data: { config: { api_token_secret: 'ACEFONE_API_TOKEN', support_api_key_secret: 'ACEFONE_C2C_SUPPORT_API_KEY', webhook_secret_name: 'ACEFONE_WEBHOOK_SECRET' } }, error: null }
        : { data: { account_id: ACCOUNT, api_base_url: 'https://api.acefone.in', api_token_secret: 'ACEFONE_API_TOKEN' }, error: null }) as never }),
      admin: () => ({ rpc: async (fn: string, args?: Record<string, unknown>) => {
        results.push({ fn, ...args })
        const accepted = args?.p_accepted
        return { data: { status: accepted ? 'INITIATED' : (args?.p_http && Number(args.p_http) < 500 ? 'FAILED' : 'INITIATED'), request_state: accepted ? 'ACCEPTED' : 'REJECTED' }, error: null } as never
      } }),
      fetch: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return o.fetchImpl ? o.fetchImpl(url, init) : new Response(JSON.stringify({ success: true, message: 'Call originated successfully.', ref_id: 'C2C99' }), { status: 200 }) }) as typeof fetch,
    }
    return { deps, sent, results }
  }
  const req = (body: unknown, auth = 'Bearer user-jwt') => new Request('https://fn.example/acefone-click-to-call', { method: 'POST', headers: { Authorization: auth, 'content-type': 'application/json', Origin: 'https://erp.example' }, body: JSON.stringify(body) })
  const call = { action: 'call', customer_id: 'c', number: '+919876543210', line_id: 'l', idempotency_key: '33333333-3333-4333-8333-333333333333' }

  it('unauthorised: no JWT, or the database refuses the caller', async () => {
    const { deps, sent } = make({ prepare: { data: null, error: { code: '42501', message: 'You are not allowed to perform this action (requires support.reply).' } } })
    assert.equal((await clickToCall(req(call, ''), deps)).status, 401)
    assert.equal((await clickToCall(req(call), deps)).status, 403)
    assert.equal(sent.length, 0)
  })
  it('accepted: INITIATED (never Connected), ref_id stored, token only in the request header', async () => {
    const { deps, sent, results } = make()
    const res = await clickToCall(req(call), deps)
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.status, 'INITIATED')
    assert.ok(!JSON.stringify(body).includes(TOKEN))
    assert.equal(sent.length, 1)
    assert.equal((sent[0].init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`)
    assert.deepEqual(results.find((r) => r.fn === 'support_call_request_result'), { fn: 'support_call_request_result', p_call: CALL, p_accepted: true, p_ref_id: 'C2C99', p_message: 'Call originated successfully.', p_http: 200 })
    assert.ok(noSecretsLogged())
  })
  it('repeated click: the existing call is returned and nothing is sent to Acefone', async () => {
    const { deps, sent } = make({ prepare: { data: prep({ duplicate: true, status: 'RINGING', request_state: 'ACCEPTED' }), error: null } })
    const body = await (await clickToCall(req(call), deps)).json()
    assert.deepEqual([body.duplicate, body.status, sent.length], [true, 'RINGING', 0])
  })
  it('failed API request: rejected with Acefone’s message; the call is Failed', async () => {
    const { deps, results } = make({ fetchImpl: async () => new Response(JSON.stringify({ success: false, message: 'Agent is Blocked' }), { status: 400 }) })
    const res = await clickToCall(req(call), deps)
    const body = await res.json()
    assert.deepEqual([res.status, body.status, body.error], [422, 'FAILED', 'Agent is Blocked'])
    assert.equal(results.at(-1)!.p_accepted, false)
  })
  it('timeout: reported, not retried, call left Initiated for the webhooks to settle', async () => {
    let n = 0
    const { deps } = make({ fetchImpl: async () => { n++; const e = new Error('aborted'); e.name = 'AbortError'; throw e } })
    const res = await clickToCall(req(call), deps)
    const body = await res.json()
    assert.deepEqual([res.status, body.status, n], [502, 'INITIATED', 1])
    assert.match(body.error, /may still go through/)
  })
  it('Support mode needs the separate Support API key', async () => {
    const { deps, sent } = make({ prepare: { data: prep({ mode: 'SUPPORT' }), error: null }, env: { ACEFONE_API_TOKEN: TOKEN } })
    const res = await clickToCall(req(call), deps)
    assert.equal(res.status, 503)
    assert.match((await res.json()).error, /Support API key/)
    assert.equal(sent.length, 0)
  })
  it('status shows only whether each secret is set', async () => {
    const { deps } = make({ env: { ACEFONE_API_TOKEN: TOKEN } })
    const body = await (await clickToCall(req({ action: 'status' }), deps)).json()
    assert.deepEqual(body.secrets, { api_token: true, support_api_key: false, webhook_secret: false })
    assert.ok(!JSON.stringify(body).includes(TOKEN))
  })
  it('test connection: token refused by Acefone is reported as an error', async () => {
    const { deps, results } = make({ fetchImpl: async () => new Response('{}', { status: 401 }) })
    const body = await (await clickToCall(req({ action: 'test' }), deps)).json()
    assert.deepEqual(body, { ok: false, message: 'The API token was refused by Acefone.' })
    assert.equal(results.at(-1)!.fn, 'support_phone_test_result')
  })
})

describe('acefone-sync-cdr and recordings', () => {
  const runtime = { account_id: ACCOUNT, is_enabled: true, api_base_url: 'https://api.acefone.in', api_token_secret: 'ACEFONE_API_TOKEN', last_sync_at: null, timezone: 'Asia/Kolkata',
    recording_retrieval: true }
  const make = (fetchImpl: (url: string) => Promise<Response>) => {
    const upserts: Record<string, unknown>[] = []
    const urls: string[] = []
    const deps: CdrDeps = {
      allowedOrigins: [], env: (k) => ENV[k],
      caller: () => ({ rpc: async () => ({ data: null, error: { code: '42501', message: 'requires support.manage_integrations' } }) as never }),
      admin: () => ({ rpc: async (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'support_phone_accounts') return { data: [ACCOUNT], error: null } as never
        if (fn === 'support_phone_runtime') return { data: runtime, error: null } as never
        upserts.push({ fn, ...args })
        return { data: { records: 0 }, error: null } as never
      } }),
      fetch: (async (url: string) => { urls.push(url); return fetchImpl(url) }) as typeof fetch,
      sleep: async () => {}, now: () => new Date('2026-11-13T06:30:00Z'),
    }
    return { deps, upserts, urls }
  }
  const cron = (secret: string) => new Request('https://fn.example/acefone-sync-cdr', { method: 'POST', headers: { 'x-cron-secret': secret } })

  it('scheduler with a wrong secret and a non-administrator are refused', async () => {
    const { deps } = make(async () => new Response('{}'))
    assert.equal((await syncCdr(cron('nope'), deps)).status, 401)
    assert.equal((await syncCdr(new Request('https://fn.example/x', { method: 'POST', headers: { Authorization: 'Bearer u' } }), deps)).status, 403)
  })
  it('pages through records and retries 5xx before giving up safely', async () => {
    let n = 0
    const { deps, upserts, urls } = make(async () => {
      n++
      if (n === 1) return new Response('busy', { status: 503 })
      return new Response(JSON.stringify({ results: n === 2 ? Array.from({ length: 100 }, (_, i) => ({ call_id: `c${i}` })) : [{ call_id: 'last' }] }), { status: 200 })
    })
    const body = await (await syncCdr(cron('cron-1'), deps)).json()
    assert.equal(body.results[0].records, 101)
    assert.equal(upserts[0].p_sync_ok, true)
    assert.match(urls[0], /from_date=2026-11-12\+12%3A00%3A00|from_date=2026-11-12\+12:00:00/)
    assert.ok(noSecretsLogged())
  })
  it('refused token: sync recorded as failed', async () => {
    const { deps, upserts } = make(async () => new Response('{}', { status: 401 }))
    const body = await (await syncCdr(cron('cron-1'), deps)).json()
    assert.deepEqual([body.results[0].ok, upserts[0].p_sync_ok, upserts[0].p_message], [false, false, 'The API token was refused.'])
  })
  it('recordings: provider host only, stored privately, purged after retention', async () => {
    const stored: string[] = []
    const removed: string[] = []
    const rpcs: string[] = []
    const deps: RecDeps = {
      allowedOrigins: [], env: (k) => ENV[k], caller: () => ({ rpc: async () => ({ data: null, error: null }) as never }),
      admin: () => ({ rpc: async (fn: string) => {
        rpcs.push(fn)
        if (fn === 'support_phone_runtime') return { data: runtime, error: null } as never
        if (fn === 'support_recordings_due') return { data: { fetch: [
          { call_id: 'a', company_id: 'co', url: 'https://customer.servetel.in/file/recording?callId=1&token=rec-token' },
          { call_id: 'b', company_id: 'co', url: 'http://169.254.169.254/latest/meta-data' }],
          purge: [{ call_id: 'old', storage_path: 'co/calls/old.mp3' }] }, error: null } as never
        return { data: null, error: null } as never
      } }),
      storage: () => ({ upload: async (p) => { stored.push(p); return { error: null } }, remove: async (p) => { removed.push(...p); return { error: null } } }),
      fetch: (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch,
      sleep: async () => {}, now: () => new Date(),
    }
    const r = await syncRecordings(deps, ACCOUNT)
    assert.deepEqual([r.stored, r.failed, r.purged], [1, 1, 1])
    assert.deepEqual(stored, ['co/calls/a.mp3'])
    assert.deepEqual(removed, ['co/calls/old.mp3'])
    assert.ok(rpcs.includes('support_recording_stored') && rpcs.includes('support_recording_purged'))
    assert.ok(noSecretsLogged())
  })
})
