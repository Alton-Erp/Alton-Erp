// WhatsApp Cloud API Edge Functions with fake Supabase clients and a fake Meta Graph API: webhook verification
// challenge, signatures (missing / invalid / valid), duplicates, inbound text and media, statuses, template and
// text sends (accepted ≠ sent, window refusal, API failures, token expiry), media download (host allowlist, size,
// checksum, expiry), connection test and template sync — and that no token or secret is ever logged.
import assert from 'node:assert/strict'
import { createHmac, createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'node:test'

import type { Client } from '../../supabase/functions/_shared/google/google.ts'
import { eventKey, graphUrl, mediaUrlAllowed, signatureValid, verificationAnswer } from '../../supabase/functions/_shared/whatsapp/whatsapp.ts'
import { handle as webhook } from '../../supabase/functions/whatsapp-webhook/handler.ts'
import { handle as verifyFn } from '../../supabase/functions/whatsapp-webhook-verify/handler.ts'
import { handle as sendMessage } from '../../supabase/functions/whatsapp-send-message/handler.ts'
import { handle as sendTemplate } from '../../supabase/functions/whatsapp-send-template/handler.ts'
import { handle as mediaFn } from '../../supabase/functions/whatsapp-media-download/handler.ts'
import { handle as syncFn } from '../../supabase/functions/whatsapp-sync-status/handler.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const COMPANY = '22222222-2222-4222-8222-222222222222'
const MSG = '33333333-3333-4333-8333-333333333333'
const APP_SECRET = 'app-SECRET-0123456789'
const TOKEN = 'EAAG-ACCESS-TOKEN-value'
const VERIFY = 'verify-TOKEN-xyz'
const ENV: Record<string, string> = { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_ACCESS_TOKEN: TOKEN, WHATSAPP_VERIFY_TOKEN: VERIFY, WHATSAPP_CRON_SECRET: 'cron-wa' }
const SUPA = 'https://proj.supabase.co'
const RT = { company_id: COMPANY, account_id: ACCOUNT, waba_id: '102030405060', phone_number_id: '109876543210', display_phone_number: '+9118001234567', app_id: '555666777888',
  graph_api_version: 'v27.0', setup_state: 'CONNECTED', integration_enabled: true, number_path: 'CLOUD_API' }

let logs: string[] = []
const orig = { log: console.log, warn: console.warn, error: console.error }
beforeEach(() => { logs = []; console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log })
afterEach(() => { Object.assign(console, orig) })
const noSecretsLogged = () => logs.every((l) => ![APP_SECRET, TOKEN, VERIFY].some((s) => l.includes(s)))

type Rpc = (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } }
function fakeClient(rpc: Rpc, store = new Map<string, Uint8Array>()) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client: Client = {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => { calls.push({ fn, args }); const r = rpc(fn, args); return { data: (r.data ?? null) as never, error: r.error ?? null } },
    storage: { from: () => ({
      upload: async (path: string, body: Uint8Array) => { store.set(path, body); return { error: null } },
      download: async (path: string) => (store.has(path) ? { data: new Blob([store.get(path)!]), error: null } : { data: null, error: { message: 'not found' } }),
    }) },
  }
  return { client, calls, store, called: (fn: string) => calls.filter((c) => c.fn === fn) }
}
interface Hit { url: string; method: string; body: unknown; headers: Record<string, string>; redirect?: string }
function fakeMeta(route: (h: Hit) => Response | null) {
  const hits: Hit[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const h: Hit = { url: String(input), method: init?.method ?? 'GET', body: init?.body, headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect }
    hits.push(h)
    const r = route(h)
    if (!r) throw new Error(`unexpected fetch ${h.method} ${h.url}`)
    return r
  }) as typeof fetch
  return { fetch: f, hits }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const base = (c: ReturnType<typeof fakeClient>, f: typeof fetch, e: Record<string, string> = ENV) =>
  ({ allowedOrigins: [], supabaseUrl: SUPA, env: (k: string) => e[k], caller: () => c.client, admin: () => c.client, fetch: f, sleep: async () => {}, now: () => new Date() })

describe('WhatsApp helpers', () => {
  it('Graph URLs use the configured version and numeric ids only', () => {
    assert.equal(graphUrl('v27.0', '109876543210', 'messages'), 'https://graph.facebook.com/v27.0/109876543210/messages')
    assert.throws(() => graphUrl(null, '1', 'messages'), /version/)
    assert.throws(() => graphUrl('latest', '1', 'messages'), /version/)
    assert.throws(() => graphUrl('v27.0', '../me', 'messages'), /id/)
    assert.throws(() => graphUrl('v27.0', '123456', 'messages?x'), /edge/)
  })
  it('verification challenge: mode, token, challenge', () => {
    const q = (o: Record<string, string>) => new URLSearchParams(o)
    assert.deepEqual(verificationAnswer(q({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1158201444' }), VERIFY), { ok: true, challenge: '1158201444' })
    assert.equal((verificationAnswer(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' }), VERIFY) as { status: number }).status, 403)
    assert.equal((verificationAnswer(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1' }), VERIFY) as { status: number }).status, 403)
    assert.equal((verificationAnswer(q({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '<script>' }), VERIFY) as { status: number }).status, 400)
    assert.equal((verificationAnswer(q({}), null) as { status: number }).status, 503)
  })
  it('X-Hub-Signature-256 over the raw body with the app secret', async () => {
    const raw = new TextEncoder().encode('{"a":1}')
    const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`
    assert.equal(await signatureValid(raw, sig, APP_SECRET), true)
    assert.equal(await signatureValid(raw, sig.toUpperCase().replace('SHA256', 'sha256'), APP_SECRET), true)
    assert.equal(await signatureValid(raw, sig, 'other'), false)
    assert.equal(await signatureValid(new TextEncoder().encode('{"a":2}'), sig, APP_SECRET), false)
    assert.equal(await signatureValid(raw, null, APP_SECRET), false)
    assert.equal(await signatureValid(raw, 'sha1=abc', APP_SECRET), false)
  })
  it('media is downloaded only from Meta hosts over https', () => {
    assert.ok(mediaUrlAllowed('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'))
    for (const u of ['http://lookaside.fbsbx.com/x', 'https://evil.example/x', 'https://fbsbx.com.evil.example/x', 'https://169.254.169.254/latest', 'https://user:pw@lookaside.fbsbx.com/x', 'not a url'])
      assert.ok(!mediaUrlAllowed(u), u)
  })
})

describe('whatsapp-webhook', () => {
  const VALUE = { messaging_product: 'whatsapp', metadata: { display_phone_number: '9118001234567', phone_number_id: RT.phone_number_id },
    contacts: [{ profile: { name: 'Ravi' }, wa_id: '919876543210' }], messages: [{ from: '919876543210', id: 'wamid.A', timestamp: '1762992000', type: 'text', text: { body: 'Hi' } }] }
  const payload = (value: unknown = VALUE, field = 'messages') => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: RT.waba_id, changes: [{ field, value }] }] })
  const sign = (body: string, secret = APP_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const post = (body: string, sig: string | null = sign(body), q = `account=${ACCOUNT}`) =>
    new Request(`${SUPA}/functions/v1/whatsapp-webhook?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body })
  const setup = (result: (args: Record<string, unknown>) => unknown = () => ({ result: 'PROCESSED', messages: 1 })) => {
    const c = fakeClient((fn, args) => (fn === 'support_whatsapp_ingest' ? { data: result(args) } : fn === 'support_whatsapp_webhook_verified' ? { data: true } : {}))
    const m = fakeMeta(() => null)
    return { c, m, d: base(c, m.fetch) }
  }
  it('GET verification answers the challenge in plain text and records it', async () => {
    const { d, c } = setup()
    const r = await webhook(new Request(`${SUPA}/functions/v1/whatsapp-webhook?account=${ACCOUNT}&hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=987654`), d)
    assert.equal(r.status, 200)
    assert.equal(await r.text(), '987654')
    assert.equal(c.called('support_whatsapp_webhook_verified')[0].args.p_account, ACCOUNT)
    const bad = await webhook(new Request(`${SUPA}/functions/v1/whatsapp-webhook?account=${ACCOUNT}&hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`), d)
    assert.equal(bad.status, 403)
    assert.equal(c.called('support_whatsapp_webhook_verified').length, 1)
  })
  it('missing or invalid signature: refused, nothing stored', async () => {
    const { d, c } = setup()
    const body = payload()
    assert.equal((await webhook(post(body, null), d)).status, 401)
    assert.equal((await webhook(post(body, sign(body, 'other-secret')), d)).status, 401)
    assert.equal((await webhook(post(body + ' ', sign(body)), d)).status, 401)
    assert.equal(c.called('support_whatsapp_ingest').length, 0)
    assert.ok(noSecretsLogged())
  })
  it('not configured (no app secret): 503; no account: 400; wrong object: 400', async () => {
    const c = fakeClient(() => ({}))
    assert.equal((await webhook(post(payload()), base(c, fakeMeta(() => null).fetch, { ...ENV, WHATSAPP_APP_SECRET: '' }))).status, 503)
    const { d } = setup()
    assert.equal((await webhook(post(payload(), undefined, 'x=1'), d)).status, 400)
    const other = JSON.stringify({ object: 'page', entry: [] })
    assert.equal((await webhook(post(other), d)).status, 400)
  })
  it('valid event: each change stored with a stable key, 200 quickly (no media download here)', async () => {
    const { d, c, m } = setup()
    const r = await webhook(post(payload()), d)
    assert.equal(r.status, 200)
    const args = c.called('support_whatsapp_ingest')[0].args
    assert.equal(args.p_entry_id, RT.waba_id)
    assert.equal(args.p_field, 'messages')
    assert.equal(args.p_event_key, await eventKey(RT.waba_id, 'messages', VALUE))
    assert.equal(m.hits.length, 0)
  })
  it('duplicate delivery acknowledged; a failed change answers 500 so Meta retries; rate limit 429; unknown account 404', async () => {
    assert.equal((await webhook(post(payload()), setup(() => ({ result: 'DUPLICATE' })).d)).status, 200)
    assert.equal((await webhook(post(payload()), setup(() => ({ result: 'ERROR' })).d)).status, 500)
    assert.equal((await webhook(post(payload()), setup(() => ({ result: 'RATE_LIMITED' })).d)).status, 429)
    assert.equal((await webhook(post(payload()), setup(() => ({ result: 'UNKNOWN' })).d)).status, 404)
    assert.equal((await webhook(post(payload()), setup(() => ({ result: 'HELD' })).d)).status, 200)
  })
  it('statuses and media messages pass through unchanged (processed in the database)', async () => {
    const value = { ...VALUE, messages: [{ from: '919876543210', id: 'wamid.I', timestamp: '1762992000', type: 'image', image: { id: '123456789', mime_type: 'image/jpeg' } }],
      statuses: [{ id: 'wamid.O', status: 'delivered', timestamp: '1762992001', recipient_id: '919876543210' }] }
    const { d, c } = setup()
    assert.equal((await webhook(post(payload(value)), d)).status, 200)
    assert.deepEqual(c.called('support_whatsapp_ingest')[0].args.p_value, value)
  })
})

describe('whatsapp-webhook-verify', () => {
  it('administrator check: secrets yes / no, callback URL, read-only subscribed_apps check; never secret values', async () => {
    const c = fakeClient((fn) => (fn === 'support_whatsapp_admin_check' ? { data: { account_id: ACCOUNT } } : fn === 'support_whatsapp_runtime' ? { data: RT } : {}))
    const m = fakeMeta((h) => (h.url === 'https://graph.facebook.com/v27.0/102030405060/subscribed_apps' && h.method === 'GET'
      ? json(200, { data: [{ whatsapp_business_api_data: { id: '555666777888', name: 'Alton ERP' } }] }) : null))
    const r = await verifyFn(new Request('https://f/x', { method: 'POST', headers: { Authorization: 'Bearer admin' } }), base(c, m.fetch))
    const text = await r.text()
    const b = JSON.parse(text)
    assert.equal(b.callback_url, `${SUPA}/functions/v1/whatsapp-webhook?account=${ACCOUNT}`)
    assert.deepEqual(b.secrets, { access_token: true, app_secret: true, verify_token: true, cron_secret: true })
    assert.equal(b.subscription.subscribed, true)
    assert.ok(![APP_SECRET, TOKEN, VERIFY].some((s) => text.includes(s)))
    assert.ok(m.hits.every((h) => h.method === 'GET'))
  })
  it('non-administrators refused', async () => {
    const c = fakeClient((fn) => (fn === 'support_whatsapp_admin_check' ? { error: { code: '42501', message: 'requires support.manage_integrations' } } : {}))
    assert.equal((await verifyFn(new Request('https://f/x', { method: 'POST', headers: { Authorization: 'Bearer agent' } }), base(c, fakeMeta(() => null).fetch))).status, 403)
  })
})

describe('sending', () => {
  const PREP_TEXT = { existing: false, id: MSG, message_id: 'm1', conversation_id: 'c1', account_id: ACCOUNT, phone_number_id: RT.phone_number_id, graph_api_version: 'v27.0',
    kind: 'TEXT', to: '919876543210', user_id: null, text: 'We are sending a replacement.', context_wa_message_id: 'wamid.IN1', media: null, template: null }
  const setup = (o: { prepared?: unknown; prepareError?: { code?: string; message?: string }; route?: (h: Hit) => Response | null; files?: Record<string, Uint8Array>; e?: Record<string, string> } = {}) => {
    const store = new Map(Object.entries(o.files ?? {}))
    const c = fakeClient((fn) => (fn === 'support_whatsapp_send_prepare' ? (o.prepareError ? { error: o.prepareError } : { data: o.prepared ?? PREP_TEXT }) : {}), store)
    const m = fakeMeta(o.route ?? ((h) => (h.url.endsWith('/messages') ? json(200, { messaging_product: 'whatsapp', contacts: [{ input: '919876543210', wa_id: '919876543210' }], messages: [{ id: 'wamid.OUT1' }] }) : null)))
    return { c, m, d: base(c, m.fetch, o.e) }
  }
  const post = (body: unknown) => new Request('https://f/send', { method: 'POST', headers: { Authorization: 'Bearer agent', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = (c: ReturnType<typeof fakeClient>) => c.called('support_whatsapp_send_result')[0]?.args

  it('text accepted by Meta: Pending (not Sent) with the WhatsApp message id; reply context and token header', async () => {
    const { d, c, m } = setup()
    const b = await (await sendMessage(post({ kind: 'text', conversation_id: 'c1', text: 'x', idempotency_key: 'k' }), d)).json()
    assert.equal(b.status, 'PENDING')
    assert.match(b.message, /Accepted by Meta/)
    assert.equal(result(c).p_outcome, 'ACCEPTED')
    assert.equal(result(c).p_wa_message_id, 'wamid.OUT1')
    const sent = JSON.parse(String(m.hits[0].body))
    assert.deepEqual(sent, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876543210', context: { message_id: 'wamid.IN1' }, type: 'text', text: { body: 'We are sending a replacement.', preview_url: false } })
    assert.equal(m.hits[0].url, 'https://graph.facebook.com/v27.0/109876543210/messages')
    assert.equal(m.hits[0].headers.Authorization, `Bearer ${TOKEN}`)
    assert.ok(noSecretsLogged() && !logs.join().includes('replacement'))
  })
  it('window closed: refused by the database, nothing sent to Meta', async () => {
    const { d, m } = setup({ prepareError: { code: 'P0001', message: 'The 24-hour customer service window is closed. Only an approved template can be sent now.' } })
    const r = await sendMessage(post({ kind: 'text', conversation_id: 'c1', text: 'x', idempotency_key: 'k' }), d)
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /window is closed/)
    assert.equal(m.hits.length, 0)
  })
  it('message function refuses templates and the template function refuses free text (no bypass)', async () => {
    const { d, m } = setup()
    assert.equal((await sendMessage(post({ kind: 'template' }), d)).status, 400)
    assert.equal((await sendTemplate(post({ kind: 'text' }), d)).status, 400)
    assert.equal(m.hits.length, 0)
  })
  it('Meta refuses (131047): Failed with the reason and a hint to use a template', async () => {
    const { d, c } = setup({ route: () => json(400, { error: { message: 'Re-engagement message', code: 131047, error_data: { details: 'More than 24 hours have passed' } } }) })
    const b = await (await sendMessage(post({ kind: 'text' }), d)).json()
    assert.equal(b.status, 'FAILED')
    assert.match(b.message, /approved template/)
    assert.equal(result(c).p_error_code, 131047)
  })
  it('expired token (190): Failed; the database marks the integration in error', async () => {
    const { d, c } = setup({ route: () => json(401, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } }) })
    const b = await (await sendMessage(post({ kind: 'text' }), d)).json()
    assert.equal(b.status, 'FAILED')
    assert.equal(result(c).p_error_code, 190)
    assert.match(b.message, /administrator must replace/)
  })
  it('Meta 5xx or timeout: Pending (unconfirmed), never retried automatically', async () => {
    let n = 0
    const t = setup({ route: () => { n++; return json(503, { error: { message: 'Service unavailable', code: 2 } }) } })
    assert.equal((await (await sendMessage(post({ kind: 'text' }), t.d)).json()).status, 'PENDING')
    assert.equal(result(t.c).p_outcome, 'UNCONFIRMED')
    assert.equal(n, 1)
    const u = setup({ route: () => { throw new Error('timeout') } })
    assert.equal((await (await sendMessage(post({ kind: 'text' }), u.d)).json()).status, 'PENDING')
  })
  it('repeated request key: existing message returned, nothing sent', async () => {
    const { d, m } = setup({ prepared: { existing: true, id: MSG, message_id: 'm1', conversation_id: 'c1', status: 'DELIVERED' } })
    assert.equal((await (await sendMessage(post({ kind: 'text' }), d)).json()).status, 'DELIVERED')
    assert.equal(m.hits.length, 0)
  })
  it('document: uploaded to /media first, then sent by media id with filename and caption', async () => {
    const path = `${COMPANY}/outbox/k/quote.pdf`
    const prepared = { ...PREP_TEXT, kind: 'MEDIA', text: null, context_wa_message_id: null, media: { kind: 'document', path, file_name: 'quote.pdf', content_type: 'application/pdf', caption: 'Quote', size_bytes: 3 } }
    const { d, m } = setup({ prepared, files: { [path]: new Uint8Array([37, 80, 68]) }, route: (h) => (h.url.endsWith('/media') ? json(200, { id: '777888999' })
      : h.url.endsWith('/messages') ? json(200, { messages: [{ id: 'wamid.DOC' }] }) : null) })
    assert.equal((await (await sendMessage(post({ kind: 'media' }), d)).json()).status, 'PENDING')
    assert.ok(m.hits[0].url.endsWith('/109876543210/media') && m.hits[0].body instanceof FormData)
    const form = m.hits[0].body as FormData
    assert.equal(form.get('messaging_product'), 'whatsapp')
    assert.equal(form.get('type'), 'application/pdf')
    assert.deepEqual(JSON.parse(String(m.hits[1].body)).document, { id: '777888999', filename: 'quote.pdf', caption: 'Quote' })
  })
  it('template: approved template with its parameters; user with a username is addressed by BSUID', async () => {
    const prepared = { ...PREP_TEXT, kind: 'TEMPLATE', to: null, user_id: 'IN.user.abc', text: null, context_wa_message_id: null,
      template: { name: 'order_update', language: 'en', components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }] }] } }
    const { d, m, c } = setup({ prepared })
    assert.equal((await (await sendTemplate(post({ kind: 'template' }), d)).json()).status, 'PENDING')
    const sent = JSON.parse(String(m.hits[0].body))
    assert.equal(sent.recipient, 'IN.user.abc')
    assert.equal(sent.to, undefined)
    assert.deepEqual(sent.template, { name: 'order_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }] }] })
    assert.equal(result(c).p_outcome, 'ACCEPTED')
  })
  it('template parameter mismatch at Meta (132000): Failed with a hint', async () => {
    const prepared = { ...PREP_TEXT, kind: 'TEMPLATE', template: { name: 't', language: 'en', components: [] } }
    const { d } = setup({ prepared, route: () => json(400, { error: { message: 'Number of parameters does not match', code: 132000 } }) })
    assert.match((await (await sendTemplate(post({ kind: 'template' }), d)).json()).message, /synchronise templates/)
  })
  it('missing access token: Failed without calling Meta', async () => {
    const { d, m, c } = setup({ e: { ...ENV, WHATSAPP_ACCESS_TOKEN: '' } })
    assert.equal((await (await sendMessage(post({ kind: 'text' }), d)).json()).status, 'FAILED')
    assert.equal(m.hits.length, 0)
    assert.equal(result(c).p_outcome, 'FAILED')
  })
})

describe('whatsapp-media-download', () => {
  const BYTES = new TextEncoder().encode('JPEGDATA')
  const SHA_HEX = createHash('sha256').update(BYTES).digest('hex')
  const DUE = { id: MSG, company_id: COMPANY, account_id: ACCOUNT, media_id: '123456789', mime: 'image/jpeg', sha256: SHA_HEX, filename: null, msg_type: 'image' }
  const setup = (route: (h: Hit) => Response | null, due: unknown[] = [DUE]) => {
    const c = fakeClient((fn) => (fn === 'support_whatsapp_accounts' ? { data: [ACCOUNT] } : fn === 'support_whatsapp_media_due' ? { data: due }
      : fn === 'support_whatsapp_runtime' ? { data: RT } : fn === 'support_whatsapp_media_request' ? { data: true } : {}))
    const m = fakeMeta(route)
    return { c, m, d: base(c, m.fetch) }
  }
  const cron = () => new Request('https://f/media', { method: 'POST', headers: { 'x-cron-secret': 'cron-wa' } })
  const info = (o: Record<string, unknown> = {}) => (h: Hit) => (h.url.startsWith('https://graph.facebook.com/v27.0/123456789?')
    ? json(200, { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg', sha256: SHA_HEX, file_size: BYTES.length, id: '123456789', ...o })
    : h.url.startsWith('https://lookaside.fbsbx.com/') ? new Response(BYTES, { status: 200 }) : null)
  const res = (c: ReturnType<typeof fakeClient>) => c.called('support_whatsapp_media_result')[0].args

  it('downloads through the authenticated media endpoint into the private bucket', async () => {
    const { d, c, m } = setup(info())
    assert.equal((await mediaFn(cron(), d)).status, 200)
    assert.equal(res(c).p_state, 'STORED')
    assert.equal(res(c).p_path, `${COMPANY}/whatsapp/${MSG}/image.jpg`)
    assert.ok(m.hits[0].url.includes('phone_number_id=109876543210') && m.hits.every((h) => h.headers.Authorization === `Bearer ${TOKEN}`))
    assert.equal(m.hits[1].redirect, 'manual')
    assert.deepEqual([...c.store.values()][0], BYTES)
    assert.ok(noSecretsLogged())
  })
  it('a download address outside Meta media hosts is never fetched', async () => {
    const { d, c, m } = setup(info({ url: 'https://169.254.169.254/latest/meta-data' }))
    await mediaFn(cron(), d)
    assert.equal(res(c).p_state, 'FAILED')
    assert.equal(m.hits.length, 1)
  })
  it('too large, executable, checksum mismatch, expired media id', async () => {
    let t = setup(info({ file_size: 30 * 1048576 }))
    await mediaFn(cron(), t.d)
    assert.equal(res(t.c).p_state, 'TOO_LARGE')
    t = setup(info({ mime_type: 'application/x-msdownload' }))
    await mediaFn(cron(), t.d)
    assert.equal(res(t.c).p_state, 'BLOCKED')
    t = setup(info({ sha256: 'f'.repeat(64) }))
    await mediaFn(cron(), t.d)
    assert.equal(res(t.c).p_state, 'FAILED')
    t = setup(() => json(404, { error: { message: 'Unsupported get request', code: 100 } }))
    await mediaFn(cron(), t.d)
    assert.equal(res(t.c).p_state, 'EXPIRED')
  })
  it('scheduler needs its secret; an agent can ask for one visible message', async () => {
    const t = setup(info())
    assert.equal((await mediaFn(new Request('https://f/media', { method: 'POST', headers: { 'x-cron-secret': 'nope' } }), t.d)).status, 401)
    const r = await mediaFn(new Request('https://f/media', { method: 'POST', headers: { Authorization: 'Bearer agent' }, body: JSON.stringify({ message_id: MSG }) }), t.d)
    assert.equal(r.status, 200)
    assert.equal(t.c.called('support_whatsapp_media_request')[0].args.p_id, MSG)
  })
})

describe('whatsapp-sync-status', () => {
  const setup = (route: (h: Hit) => Response | null) => {
    const c = fakeClient((fn) => (fn === 'support_whatsapp_admin_check' ? { data: { account_id: ACCOUNT } } : fn === 'support_whatsapp_runtime' ? { data: RT }
      : fn === 'support_whatsapp_accounts' ? { data: [ACCOUNT] } : fn === 'support_whatsapp_templates_sync' ? { data: 2 } : {}))
    const m = fakeMeta(route)
    return { c, m, d: base(c, m.fetch) }
  }
  const admin = (action: string) => new Request('https://f/sync', { method: 'POST', headers: { Authorization: 'Bearer admin' }, body: JSON.stringify({ action }) })
  const phone = (o: Record<string, unknown>) => (h: Hit) => (h.url.startsWith('https://graph.facebook.com/v27.0/109876543210?fields=')
    ? json(200, { display_phone_number: '+91 1800 123 4567', verified_name: 'Alton', quality_rating: 'GREEN', status: 'CONNECTED', platform_type: 'CLOUD_API', id: '109876543210', ...o }) : null)
  it('test passes only for a CONNECTED Cloud API number matching the configuration (read-only)', async () => {
    let t = setup(phone({}))
    await syncFn(admin('test'), t.d)
    assert.equal(t.c.called('support_whatsapp_test_result')[0].args.p_ok, true)
    assert.ok(t.m.hits.every((h) => h.method === 'GET'))
    t = setup(phone({ platform_type: 'ON_PREMISE' }))
    await syncFn(admin('test'), t.d)
    assert.equal(t.c.called('support_whatsapp_test_result')[0].args.p_ok, false)
    t = setup(phone({ status: 'PENDING' }))
    await syncFn(admin('test'), t.d)
    assert.match(String(t.c.called('support_whatsapp_test_result')[0].args.p_message), /must be CONNECTED/)
    t = setup(phone({ display_phone_number: '+91 99999 00000' }))
    await syncFn(admin('test'), t.d)
    assert.match(String(t.c.called('support_whatsapp_test_result')[0].args.p_message), /not the configured/)
  })
  it('expired token reported as such', async () => {
    const t = setup(() => json(401, { error: { message: 'Session has expired', type: 'OAuthException', code: 190 } }))
    await syncFn(admin('test'), t.d)
    const a = t.c.called('support_whatsapp_test_result')[0].args
    assert.equal(a.p_ok, false)
    assert.match(String(a.p_message), /\(190\)/)
    assert.ok(noSecretsLogged())
  })
  it('templates: pages followed only within Meta and this account', async () => {
    const first = 'https://graph.facebook.com/v27.0/102030405060/message_templates?'
    const t = setup((h) => (h.url === 'https://graph.facebook.com/v27.0/102030405060/message_templates?after=X' ? json(200, { data: [{ id: '2', name: 'b', language: 'en', status: 'PENDING' }],
        paging: { next: 'https://evil.example/steal' } })
      : h.url.startsWith(first) ? json(200, { data: [{ id: '1', name: 'a', language: 'en', status: 'APPROVED' }],
        paging: { next: 'https://graph.facebook.com/v27.0/102030405060/message_templates?after=X' } }) : null))
    await syncFn(admin('templates'), t.d)
    const a = t.c.called('support_whatsapp_templates_sync')[0].args
    assert.equal((a.p_templates as unknown[]).length, 2)
    assert.equal(a.p_complete, false)
    assert.ok(!t.m.hits.some((h) => h.url.includes('evil')))
  })
  it('scheduler run also removes old raw payloads; agents are refused', async () => {
    const t = setup((h) => phone({})(h) ?? (h.url.includes('message_templates') ? json(200, { data: [] }) : null))
    await syncFn(new Request('https://f/sync', { method: 'POST', headers: { 'x-cron-secret': 'cron-wa' } }), t.d)
    assert.equal(t.c.called('support_whatsapp_purge_payloads').length, 1)
    const c = fakeClient((fn) => (fn === 'support_whatsapp_admin_check' ? { error: { code: '42501', message: 'no' } } : {}))
    assert.equal((await syncFn(admin('test'), base(c, fakeMeta(() => null).fetch))).status, 403)
  })
})
