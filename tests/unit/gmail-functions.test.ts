// Google Workspace Gmail Edge Functions with fake Supabase clients and a fake Google: OAuth state and callback,
// token encryption, expired / revoked tokens, push webhook validation and replay, history sync (duplicates,
// expired history, failures), Gmail threading, attachment handling, send outcomes (Sent / Failed / Pending),
// watch renewal, HTML sanitising, MIME parsing and building — and that no secret or token is ever logged.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { decryptToken, encryptToken, keyProblem } from '../../supabase/functions/_shared/google/crypto.ts'
import { GOOGLE, appUrl, b64urlToBytes, bytesToB64url, redirectUriProblem, secret, sha256Hex, type Client } from '../../supabase/functions/_shared/google/google.ts'
import { buildMime, decodeEncodedWords, parseAddressList, parseGmailMessage, toRaw } from '../../supabase/functions/_shared/google/mime.ts'
import { buildAuthUrl } from '../../supabase/functions/_shared/google/oauth.ts'
import { resetJwksCache } from '../../supabase/functions/_shared/google/oidc.ts'
import { htmlToText, sanitizeHtml } from '../../supabase/functions/_shared/google/sanitize.ts'
import { syncMailbox } from '../../supabase/functions/_shared/google/sync.ts'
import { handle as oauthStart } from '../../supabase/functions/google-oauth-start/handler.ts'
import { handle as oauthCallback } from '../../supabase/functions/google-oauth-callback/handler.ts'
import { handle as webhook } from '../../supabase/functions/google-gmail-webhook/handler.ts'
import { handle as send } from '../../supabase/functions/google-gmail-send/handler.ts'
import { handle as watchRenew } from '../../supabase/functions/google-gmail-watch-renew/handler.ts'
import { handle as syncFn } from '../../supabase/functions/google-gmail-sync/handler.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111'
const COMPANY = '22222222-2222-4222-8222-222222222222'
const EMAIL_ID = '33333333-3333-4333-8333-333333333333'
const KEY = Buffer.alloc(32, 7).toString('base64')
const CLIENT_SECRET = 'GOCSPX-client-SECRET-value'
const REFRESH = '1//0g-REFRESH-token-VALUE'
const ACCESS = 'ya29.ACCESS-token-VALUE'
const PUSH = 'push-TOKEN-0123456789abcdef'
const SUPA = 'https://proj.supabase.co'
const ENV: Record<string, string> = {
  GOOGLE_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: `${SUPA}/functions/v1/google-oauth-callback`, GOOGLE_TOKEN_ENCRYPTION_KEY: KEY, GOOGLE_APP_URL: 'https://erp.alton.example',
  GMAIL_PUSH_TOKEN: PUSH, GOOGLE_CRON_SECRET: 'cron-1', SUPABASE_SERVICE_ROLE_KEY: 'service-ROLE',
}

let logs: string[] = []
const orig = { log: console.log, warn: console.warn, error: console.error }
beforeEach(() => { logs = []; console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log; resetJwksCache() })
afterEach(() => { Object.assign(console, orig) })
const SECRETS = [CLIENT_SECRET, REFRESH, ACCESS, PUSH, KEY, 'service-ROLE']
const noSecretsLogged = () => logs.every((l) => SECRETS.every((s) => !l.includes(s)))

// ---- fakes ---------------------------------------------------------------------
type Rpc = (fn: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } }
function fakeClient(rpc: Rpc, store = new Map<string, Uint8Array>()) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const client: Client = {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => { calls.push({ fn, args }); const r = rpc(fn, args); return { data: (r.data ?? null) as never, error: r.error ?? null } },
    storage: { from: () => ({
      upload: async (path: string, body: Uint8Array) => { if (store.has(path)) return { error: { message: 'The resource already exists' } }; store.set(path, body); return { error: null } },
      download: async (path: string) => (store.has(path) ? { data: new Blob([store.get(path)!]), error: null } : { data: null, error: { message: 'not found' } }),
    }) },
  }
  return { client, calls, store, called: (fn: string) => calls.filter((c) => c.fn === fn) }
}
interface Hit { url: string; method: string; body: string; headers: Record<string, string> }
function fakeGoogle(routes: (h: Hit) => Response | Promise<Response> | null) {
  const hits: Hit[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const h: Hit = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) }
    hits.push(h)
    const r = await routes(h)
    if (!r) throw new Error(`unexpected fetch ${h.method} ${h.url}`)
    return r
  }) as typeof fetch
  return { fetch: f, hits }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const tokenOk = (h: Hit) => (h.url === GOOGLE.token && new URLSearchParams(h.body).get('grant_type') === 'refresh_token' ? json(200, { access_token: ACCESS, expires_in: 3599, scope: 'x', token_type: 'Bearer' }) : null)
const env = (k: string) => ENV[k]
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

async function storedCreds() {
  const enc = await encryptToken(REFRESH, KEY, ACCOUNT)
  return { ciphertext: enc.ciphertext, iv: enc.iv, key_version: 1 }
}
const RUNTIME = { company_id: COMPANY, account_id: ACCOUNT, mailbox_address: 'support@alton.example', connected_address: 'support@alton.example', display_name: 'Alton Support',
  is_enabled: true, status: 'CONNECTED', pubsub_topic: 'projects/alton-erp-123/topics/gmail', push_enabled: true, mailbox_modify_enabled: false, granted_scopes: [],
  initial_sync_days: 7, max_attachment_mb: 10, last_history_id: '100', last_full_sync_at: '2026-11-01T00:00:00Z', watch_expiration: null, has_credentials: true }

function gmailMessage(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, threadId: 'thr000001', labelIds: ['INBOX', 'UNREAD'], internalDate: '1762992000000', sizeEstimate: 5000,
    payload: { partId: '', mimeType: 'multipart/mixed', headers: [
      { name: 'From', value: '"Kumar, Ravi" <Ravi@Customer.example>' }, { name: 'To', value: 'Support <support@alton.example>' },
      { name: 'Cc', value: 'boss@customer.example, "A, B" <ab@customer.example>' }, { name: 'Subject', value: '=?UTF-8?B?Q3JhY2tlZCBiYXNpbiDinJM=?=' },
      { name: 'Message-ID', value: `<${id}@customer.example>` }, { name: 'In-Reply-To', value: '<prev@alton.example>' }, { name: 'References', value: '<root@alton.example>\r\n <prev@alton.example>' }],
      parts: [
        { partId: '0', mimeType: 'multipart/alternative', parts: [
          { partId: '0.0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="iso-8859-1"' }], body: { size: 20, data: Buffer.from('Caf\xe9 basin cracked', 'latin1').toString('base64url') } },
          { partId: '0.1', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { size: 80, data: b64u('<p onclick="x()">Basin <b>cracked</b><script>steal()</script><img src="https://t.example/p.gif" alt="logo"></p>') } }] },
        { partId: '1', mimeType: 'image/jpeg', filename: 'photo.jpg', headers: [{ name: 'Content-Disposition', value: 'attachment; filename="photo.jpg"' }], body: { size: 4, attachmentId: 'ATTACH-0001' } },
        { partId: '2', mimeType: 'application/octet-stream', filename: 'setup.exe', body: { size: 4, attachmentId: 'ATTACH-0002' } },
        { partId: '3', mimeType: 'application/pdf', filename: 'big.pdf', body: { size: 50 * 1048576, attachmentId: 'ATTACH-0003' } }],
    },
    ...extra,
  }
}

// ---- helpers -------------------------------------------------------------------------
describe('Gmail helpers', () => {
  it('only the Google secrets can be read', () => {
    assert.equal(secret('GOOGLE_OAUTH_CLIENT_SECRET', env), CLIENT_SECRET)
    assert.equal(secret('SUPABASE_SERVICE_ROLE_KEY' as never, env), null)
  })
  it('redirect URI must be this project callback over https', () => {
    assert.equal(redirectUriProblem(`${SUPA}/functions/v1/google-oauth-callback`, SUPA), null)
    assert.ok(redirectUriProblem('https://evil.example/functions/v1/google-oauth-callback', SUPA))
    assert.ok(redirectUriProblem(`${SUPA}/functions/v1/google-oauth-callback?x=1`, SUPA))
    assert.ok(redirectUriProblem('http://proj.supabase.co/functions/v1/google-oauth-callback', 'http://proj.supabase.co'))
    assert.ok(redirectUriProblem(null, SUPA))
  })
  it('app URL: https (or localhost), no query', () => {
    assert.equal(appUrl(env), 'https://erp.alton.example')
    assert.equal(appUrl((k) => (k === 'GOOGLE_APP_URL' ? 'javascript:alert(1)' : undefined)), null)
    assert.equal(appUrl((k) => (k === 'GOOGLE_APP_URL' ? 'https://erp.example/?next=https://evil' : undefined)), null)
    assert.equal(appUrl((k) => (k === 'GOOGLE_APP_URL' ? 'http://localhost:5173/' : undefined)), 'http://localhost:5173')
  })
  it('refresh tokens are encrypted (AES-GCM) and bound to the account', async () => {
    const enc = await encryptToken(REFRESH, KEY, ACCOUNT)
    assert.ok(!enc.ciphertext.includes('REFRESH') && !enc.ciphertext.startsWith('1//') && /^[A-Za-z0-9_-]+$/.test(enc.ciphertext))
    assert.equal(await decryptToken(enc.ciphertext, enc.iv, KEY, ACCOUNT), REFRESH)
    await assert.rejects(decryptToken(enc.ciphertext, enc.iv, KEY, '99999999-9999-4999-8999-999999999999'))
    await assert.rejects(decryptToken(enc.ciphertext, enc.iv, Buffer.alloc(32, 8).toString('base64'), ACCOUNT))
    assert.ok(keyProblem('c2hvcnQ=') && keyProblem(null) && keyProblem(KEY) === null)
  })
  it('authorisation URL: offline access, consent, state, least-privilege scopes, no client secret', () => {
    const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: ENV.GOOGLE_OAUTH_REDIRECT_URI, scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], state: 'st', loginHint: 'support@alton.example' }))
    assert.equal(u.origin + u.pathname, GOOGLE.authorize)
    assert.equal(u.searchParams.get('access_type'), 'offline')
    assert.equal(u.searchParams.get('prompt'), 'consent')
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('state'), 'st')
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send')
    assert.ok(!u.toString().includes(CLIENT_SECRET))
  })
})

describe('HTML sanitising', () => {
  it('removes scripts, handlers, styles, unsafe links and remote images', () => {
    const out = sanitizeHtml(`<div style="background:url(https://t.example/x)" onclick="evil()">Hi<script>alert(1)</script><style>p{}</style>
      <a href="javascript:alert(1)">x</a><a href="jav&#x09;ascript:alert(2)">y</a><a href="https://ok.example/p?a=1&amp;b=2">ok</a><a href="data:text/html,x">d</a>
      <img src="https://t.example/p.gif" alt="Logo"><svg onload="evil()"><circle/></svg><iframe src="https://e.example"></iframe>
      <scr<script>x</script>ipt>alert(3)</script><!-- <script>bad()</script> --><form action="https://e.example"><input name="pw"></form></div>`)
    for (const bad of ['<script', 'onclick', 'onload', 'style=', 'javascript:', 'data:text', '<img', '<svg', '<iframe', 'src=', '<input', '<form', 'bad()'])
      assert.ok(!out.toLowerCase().includes(bad), `${bad} survived: ${out}`)
    assert.ok(out.includes('<a href="https://ok.example/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">ok</a>'))
    assert.ok(out.includes('[Logo]') && out.includes('<div>Hi'))
  })
  it('text is re-escaped, entities preserved', () => {
    assert.equal(sanitizeHtml('<p>a &lt;b&gt; &amp; c < d</p>'), '<p>a &lt;b&gt; &amp; c &lt; d</p>')
    assert.equal(sanitizeHtml('<td colspan="2" onmouseover="x">t</td>'), '<td colspan="2">t</td>')
  })
  it('plain text from HTML', () => {
    assert.equal(htmlToText('<p>Hello&nbsp;there</p><script>x()</script><ul><li>one</li><li>two</li></ul>'), 'Hello there\n• one\n• two')
  })
})

describe('MIME parsing', () => {
  it('headers, addresses, charset, sanitised HTML, threading headers, attachment checks', () => {
    const { email, inlineData } = parseGmailMessage(gmailMessage('aaaa000001') as never, 10 * 1048576)
    assert.deepEqual(email.from, { email: 'ravi@customer.example', name: 'Kumar, Ravi' })
    assert.deepEqual(email.cc.map((a) => a.email), ['boss@customer.example', 'ab@customer.example'])
    assert.equal(email.subject, 'Cracked basin ✓')
    assert.equal(email.body_text, 'Café basin cracked')
    assert.ok(email.body_html!.includes('<b>cracked</b>') && !email.body_html!.includes('steal') && !email.body_html!.includes('onclick') && !email.body_html!.includes('t.example'))
    assert.equal(email.rfc_message_id, '<aaaa000001@customer.example>')
    assert.equal(email.in_reply_to, '<prev@alton.example>')
    assert.equal(email.references, '<root@alton.example> <prev@alton.example>')
    assert.equal(email.internal_date, '1762992000000')
    const byName = Object.fromEntries(email.attachments.map((a) => [a.filename, a]))
    assert.equal(byName['photo.jpg'].state, undefined)
    assert.equal(byName['setup.exe'].state, 'BLOCKED')
    assert.equal(byName['big.pdf'].state, 'TOO_LARGE')
    assert.ok(email.mime.parts.length >= 6 && inlineData.size === 0)
  })
  it('address lists and encoded words', () => {
    assert.deepEqual(parseAddressList('"Doe, J" <J@X.example>, y@x.example (Why), undisclosed-recipients:;, bad'), [{ email: 'j@x.example', name: 'Doe, J' }, { email: 'y@x.example', name: 'Why' }])
    assert.equal(decodeEncodedWords('=?ISO-8859-1?Q?Caf=E9_ok?= =?UTF-8?B?4pyT?='), 'Café ok✓')
  })
  it('no text part: text derived from the HTML', () => {
    const m = { id: 'aaaa000009', payload: { mimeType: 'text/html', headers: [{ name: 'From', value: 'a@b.example' }], body: { data: b64u('<p>Only <i>html</i></p>') } } }
    const { email } = parseGmailMessage(m as never, 1048576)
    assert.equal(email.body_text, 'Only html')
  })
})

describe('MIME building', () => {
  it('threading headers, encoded subject, Bcc, attachments; header injection removed', () => {
    const mime = buildMime({
      from: { email: 'support@alton.example', name: 'Alton Support' }, to: [{ email: 'ravi@customer.example', name: 'Ravi\r\nBcc: evil@x.example' }],
      cc: [{ email: 'boss@customer.example', name: null }], bcc: [{ email: 'audit@alton.example', name: null }], subject: 'Re: Cracked basin ✓\r\nX-Evil: 1',
      body: 'Line one\nLine two', messageId: '<abc.alton@alton.example>', inReplyTo: '<m2@customer.example>', references: '<m1@customer.example> <m2@customer.example> junk',
      date: new Date('2026-11-13T10:00:00Z'), attachments: [{ fileName: 'Rechnung ü.pdf', contentType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) }],
    }, 'BOUNDARY')
    const head = mime.split('\r\n\r\n')[0]
    assert.ok(head.includes('From: "Alton Support" <support@alton.example>'))
    assert.ok(head.includes('To: "Ravi Bcc: evil@x.example" <ravi@customer.example>'))
    assert.ok(head.includes('Bcc: audit@alton.example'))
    assert.ok(!/\r\nX-Evil:/.test(mime) && !/\r\nBcc: evil/.test(mime))
    assert.ok(head.includes('Subject: =?UTF-8?B?'))
    assert.ok(head.includes('Message-ID: <abc.alton@alton.example>'))
    assert.ok(head.includes('In-Reply-To: <m2@customer.example>'))
    assert.ok(head.includes('References: <m1@customer.example>\r\n <m2@customer.example>') && !head.includes('junk'))
    assert.ok(head.includes('Date: Fri, 13 Nov 2026 10:00:00 +0000'))
    assert.ok(mime.includes("filename*=UTF-8''Rechnung%20%C3%BC.pdf") && mime.includes('--BOUNDARY--'))
    const raw = toRaw(mime)
    assert.ok(/^[A-Za-z0-9_-]+$/.test(raw))
    assert.equal(Buffer.from(b64urlToBytes(raw)).toString('utf8'), mime)
  })
})

// ---- OAuth start / callback --------------------------------------------------------------
describe('google-oauth-start', () => {
  const deps = (rpc: Rpc, routes: (h: Hit) => Response | null = () => null, e: Record<string, string> = ENV) => {
    const c = fakeClient(rpc)
    const g = fakeGoogle(routes)
    return { c, g, d: { allowedOrigins: [], supabaseUrl: SUPA, env: (k: string) => e[k], caller: () => c.client, admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() } }
  }
  const post = (body: unknown, auth = 'Bearer user-jwt') => new Request('https://f/google-oauth-start', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  it('requires a signed-in user', async () => {
    const { d } = deps(() => ({}))
    assert.equal((await oauthStart(post({ action: 'start' }, ''), d)).status, 401)
  })
  it('start: random state, only its hash goes to the database, URL to Google', async () => {
    const { d, c } = deps((fn) => (fn === 'support_gmail_oauth_begin' ? { data: { scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], mailbox_address: 'support@alton.example' } } : {}))
    const r = await oauthStart(post({ action: 'start' }), d)
    assert.equal(r.status, 200)
    const url = new URL((await r.json()).url)
    const state = url.searchParams.get('state')!
    assert.ok(state.length >= 40)
    const hash = c.called('support_gmail_oauth_begin')[0].args.p_state_hash
    assert.equal(hash, await sha256Hex(state))
    assert.notEqual(hash, state)
    assert.equal(url.searchParams.get('redirect_uri'), ENV.GOOGLE_OAUTH_REDIRECT_URI)
    assert.equal(url.searchParams.get('login_hint'), 'support@alton.example')
  })
  it('start refused when the server is not configured (no invented credentials)', async () => {
    const { d } = deps(() => ({}), () => null, { ...ENV, GOOGLE_OAUTH_CLIENT_SECRET: '', GOOGLE_OAUTH_REDIRECT_URI: 'https://evil.example/cb' })
    const r = await oauthStart(post({ action: 'start' }), d)
    assert.equal(r.status, 503)
    assert.match((await r.json()).error, /GOOGLE_OAUTH_CLIENT_SECRET/)
  })
  it('start refused for non-administrators', async () => {
    const { d } = deps((fn) => (fn === 'support_gmail_oauth_begin' ? { error: { code: '42501', message: 'requires support.manage_integrations' } } : {}))
    assert.equal((await oauthStart(post({ action: 'start' }), d)).status, 403)
  })
  it('status: yes / no per secret, never a value', async () => {
    const { d } = deps((fn) => (fn === 'support_email_admin_check' ? { data: { account_id: ACCOUNT } } : {}))
    const text = await (await oauthStart(post({ action: 'status' }), d)).text()
    const body = JSON.parse(text)
    assert.equal(body.secrets.client_secret, true)
    assert.equal(body.redirect_uri, `${SUPA}/functions/v1/google-oauth-callback`)
    assert.ok(SECRETS.every((s) => !text.includes(s)))
  })
  it('disconnect: stops the watch, revokes at Google, deletes the stored authorisation', async () => {
    const creds = await storedCreds()
    const { d, c, g } = deps((fn) => ({ support_email_admin_check: { data: { account_id: ACCOUNT, user_id: 'u1' } }, support_gmail_runtime: { data: RUNTIME },
      support_gmail_credentials: { data: creds } } as Record<string, { data: unknown }>)[fn] ?? {}, (h) => tokenOk(h) ?? (h.url === `${GOOGLE.gmail}/stop` ? json(204, {}) : h.url === GOOGLE.revoke ? json(200, {}) : null))
    const r = await oauthStart(post({ action: 'disconnect', reason: 'moved' }), d)
    assert.equal(r.status, 200)
    assert.equal((await r.json()).revoked, true)
    assert.equal(new URLSearchParams(g.hits.find((h) => h.url === GOOGLE.revoke)!.body).get('token'), REFRESH)
    assert.equal(c.called('support_gmail_disconnected')[0].args.p_revoked, true)
    assert.ok(noSecretsLogged())
  })
})

describe('google-oauth-callback', () => {
  const STATE = 'S'.repeat(43)
  const PROFILE = { emailAddress: 'support@alton.example', historyId: '500' }
  const setup = async (o: { consume?: unknown; token?: unknown; profile?: unknown } = {}) => {
    const c = fakeClient((fn) => {
      if (fn === 'support_gmail_oauth_consume') return { data: o.consume ?? { ok: true, account_id: ACCOUNT, user_id: 'u1', scopes: [], mailbox_address: 'support@alton.example' } }
      if (fn === 'support_gmail_connect') return { data: { push_enabled: true, pubsub_topic: 'projects/alton-erp-123/topics/gmail' } }
      return {}
    })
    const g = fakeGoogle((h) => {
      if (h.url === GOOGLE.token) return json(200, o.token ?? { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' })
      if (h.url === `${GOOGLE.gmail}/profile`) return json(200, o.profile ?? PROFILE)
      if (h.url === `${GOOGLE.gmail}/watch`) return json(200, { historyId: '500', expiration: '1763596800000' })
      if (h.url === GOOGLE.revoke) return json(200, {})
      return null
    })
    return { c, g, d: { supabaseUrl: SUPA, env, admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() } }
  }
  const get = (q: string) => new Request(`${SUPA}/functions/v1/google-oauth-callback?${q}`)
  const reason = (r: Response) => new URL(r.headers.get('Location')!).searchParams.get('reason')

  it('success: code exchanged with the registered redirect URI, token encrypted, watch started, back to the ERP', async () => {
    const { d, c, g } = await setup()
    const r = await oauthCallback(get(`state=${STATE}&code=4/0AUTH-CODE`), d)
    assert.equal(r.status, 303)
    assert.equal(r.headers.get('Location'), 'https://erp.alton.example/support/settings?tab=email&gmail=connected')
    const ex = new URLSearchParams(g.hits.find((h) => h.url === GOOGLE.token)!.body)
    assert.equal(ex.get('redirect_uri'), ENV.GOOGLE_OAUTH_REDIRECT_URI)
    assert.equal(ex.get('grant_type'), 'authorization_code')
    assert.equal(c.called('support_gmail_oauth_consume')[0].args.p_state_hash, await sha256Hex(STATE))
    const stored = c.called('support_gmail_connect')[0].args
    assert.ok(!JSON.stringify(stored).includes(REFRESH) && !JSON.stringify(stored).includes(ACCESS))
    assert.equal(await decryptToken(String(stored.p_ciphertext), String(stored.p_iv), KEY, ACCOUNT), REFRESH)
    assert.equal(stored.p_history_id, '500')
    assert.equal(c.called('support_gmail_watch_state')[0].args.p_ok, true)
    assert.ok(noSecretsLogged() && !logs.join().includes('4/0AUTH-CODE'))
  })
  it('replayed, expired or unknown state: refused before any Google call', async () => {
    for (const why of ['USED', 'EXPIRED', 'UNKNOWN']) {
      const { d, g } = await setup({ consume: { ok: false, reason: why } })
      const r = await oauthCallback(get(`state=${STATE}&code=c`), d)
      assert.equal(reason(r), `state_${why.toLowerCase()}`)
      assert.equal(g.hits.length, 0)
    }
    const { d } = await setup()
    assert.equal(reason(await oauthCallback(get('code=c'), d)), 'state_invalid')
  })
  it('consent denied at Google', async () => {
    const { d, c } = await setup()
    assert.equal(reason(await oauthCallback(get(`state=${STATE}&error=access_denied`), d)), 'denied')
    assert.equal(c.called('support_gmail_oauth_failed').length, 1)
  })
  it('missing Gmail permission: tokens revoked, not stored', async () => {
    const { d, c, g } = await setup({ token: { access_token: ACCESS, refresh_token: REFRESH, scope: 'https://www.googleapis.com/auth/gmail.readonly' } })
    assert.equal(reason(await oauthCallback(get(`state=${STATE}&code=c`), d)), 'scopes_missing')
    assert.ok(g.hits.some((h) => h.url === GOOGLE.revoke) && c.called('support_gmail_connect').length === 0)
  })
  it('signed in with another account than the support mailbox: revoked, not stored', async () => {
    const { d, c, g } = await setup({ profile: { emailAddress: 'someone@gmail.com', historyId: '1' } })
    assert.equal(reason(await oauthCallback(get(`state=${STATE}&code=c`), d)), 'wrong_mailbox')
    assert.ok(g.hits.some((h) => h.url === GOOGLE.revoke) && c.called('support_gmail_connect').length === 0)
  })
  it('no refresh token returned', async () => {
    const { d } = await setup({ token: { access_token: ACCESS, scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' } })
    assert.equal(reason(await oauthCallback(get(`state=${STATE}&code=c`), d)), 'no_refresh_token')
  })
})

// ---- webhook, sync, replay ---------------------------------------------------------------------------
function mailboxDb(o: { known?: string[]; push?: unknown; runtime?: unknown; creds?: unknown; ingest?: (p: Record<string, unknown>) => unknown } = {}) {
  const ingested: Record<string, unknown>[] = []
  return {
    ingested,
    rpc: (async () => { const creds = o.creds === undefined ? await storedCreds() : o.creds
      return ((fn: string, args: Record<string, unknown>) => {
        switch (fn) {
          case 'support_gmail_runtime': return { data: o.runtime ?? RUNTIME }
          case 'support_gmail_credentials': return { data: creds }
          case 'support_gmail_known': return { data: (args.p_ids as string[]).filter((x) => (o.known ?? []).includes(x)) }
          case 'support_gmail_push': return { data: o.push ?? { result: 'LOGGED', account_id: ACCOUNT, event_id: '44444444-4444-4444-8444-444444444444' } }
          case 'support_gmail_ingest': {
            const p = args.p as Record<string, unknown>
            ingested.push(p)
            return { data: o.ingest ? o.ingest(p) : { result: 'STORED', email_id: EMAIL_ID, conversation_id: 'c1',
              attachments: (p.attachments as { state?: string }[]).filter((a) => !a.state) } }
          }
          default: return {}
        }
      }) as Rpc })(),
  }
}
const gmailRoutes = (o: { history?: (h: Hit) => Response; messages?: Record<string, unknown>; list?: string[]; send?: (h: Hit) => Response } = {}) => (h: Hit) => {
  const t = tokenOk(h)
  if (t) return t
  const u = h.url
  if (u.startsWith(`${GOOGLE.gmail}/history`)) return o.history ? o.history(h) : json(200, { history: [{ id: '101', messagesAdded: [{ message: { id: 'aaaa000001' } }] }], historyId: '105' })
  if (u === `${GOOGLE.gmail}/profile`) return json(200, { emailAddress: 'support@alton.example', historyId: '900' })
  if (u.startsWith(`${GOOGLE.gmail}/messages?`)) return json(200, { messages: (o.list ?? []).map((id) => ({ id, threadId: 't' })) })
  const att = /\/messages\/([^/]+)\/attachments\/([^/?]+)$/.exec(u)
  if (att) return json(200, { size: 4, data: Buffer.from('JPEG').toString('base64url') })
  const msg = /\/messages\/([A-Za-z0-9_-]+)\?format=full$/.exec(u)
  if (msg) return o.messages?.[msg[1]] ? json(200, o.messages[msg[1]]) : json(200, gmailMessage(msg[1]))
  if (u === `${GOOGLE.gmail}/messages/send`) return o.send ? o.send(h) : json(200, { id: 'sent000001', threadId: 'thr000001', labelIds: ['SENT'] })
  if (u === `${GOOGLE.gmail}/watch`) return json(200, { historyId: '1', expiration: '1763596800000' })
  return null
}

describe('google-gmail-webhook', () => {
  const push = (data: unknown, q = `token=${PUSH}`, auth?: string) => new Request(`${SUPA}/functions/v1/google-gmail-webhook?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify({ message: { data: Buffer.from(JSON.stringify(data)).toString('base64'), messageId: '136969346945', publishTime: '2026-11-13T10:00:00Z' }, subscription: 'projects/p/subscriptions/s' }),
  })
  const deps = async (o: Parameters<typeof mailboxDb>[0] = {}, e: Record<string, string> = ENV) => {
    const db = mailboxDb(o)
    const c = fakeClient(await db.rpc)
    const g = fakeGoogle(gmailRoutes())
    return { db, c, g, d: { env: (k: string) => e[k], admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() } }
  }
  const NOTE = { emailAddress: 'support@alton.example', historyId: 105 }
  it('rejects a missing or wrong token, and refuses when not configured', async () => {
    const { d } = await deps()
    assert.equal((await webhook(push(NOTE, ''), d)).status, 401)
    assert.equal((await webhook(push(NOTE, 'token=wrong'), d)).status, 401)
    const { d: d2 } = await deps({}, { ...ENV, GMAIL_PUSH_TOKEN: '' })
    assert.equal((await webhook(push(NOTE), d2)).status, 503)
  })
  it('rejects malformed and oversized bodies', async () => {
    const { d } = await deps()
    assert.equal((await webhook(new Request(`${SUPA}/x?token=${PUSH}`, { method: 'POST', body: '{"message":{"data":"!!"}}' }), d)).status, 400)
    assert.equal((await webhook(push({ emailAddress: 'a@b.example', historyId: 'x1' }), d)).status, 400)
    assert.equal((await webhook(new Request(`${SUPA}/x?token=${PUSH}`, { method: 'POST', body: 'x'.repeat(70000) }), d)).status, 413)
  })
  it('valid notification: logged, the mail is fetched from Gmail (not taken from the notification), stored', async () => {
    const { d, c, g, db } = await deps()
    const r = await webhook(push(NOTE), d)
    assert.equal(r.status, 200)
    assert.equal(c.called('support_gmail_push')[0].args.p_pubsub_id, '136969346945')
    assert.ok(g.hits.some((h) => h.url.includes('/history?startHistoryId=100')) && g.hits.some((h) => h.url.endsWith('/messages/aaaa000001?format=full')))
    assert.equal(db.ingested.length, 1)
    assert.equal(c.called('support_gmail_event_done')[0].args.p_result, 'PROCESSED')
    assert.ok(noSecretsLogged())
  })
  it('duplicate delivery (Pub/Sub retry): acknowledged without touching Gmail', async () => {
    const { d, g } = await deps({ push: { result: 'DUPLICATE', account_id: ACCOUNT } })
    const r = await webhook(push(NOTE), d)
    assert.equal(r.status, 200)
    assert.equal(g.hits.length, 0)
  })
  it('unknown mailbox acknowledged; burst rate-limited with 429 so Pub/Sub retries', async () => {
    assert.equal((await webhook(push(NOTE), (await deps({ push: { result: 'UNKNOWN' } })).d)).status, 200)
    assert.equal((await webhook(push(NOTE), (await deps({ push: { result: 'RATE_LIMITED', account_id: ACCOUNT } })).d)).status, 429)
  })
  it('optional Pub/Sub OIDC check: signature, audience and service account', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const sign = async (claims: Record<string, unknown>) => {
      const h = bytesToB64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })))
      const p = bytesToB64url(new TextEncoder().encode(JSON.stringify(claims)))
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`)))
      return `Bearer ${h}.${p}.${bytesToB64url(sig)}`
    }
    const now = Math.floor(Date.now() / 1000)
    const good = { iss: 'https://accounts.google.com', aud: 'https://proj.supabase.co/functions/v1/google-gmail-webhook', exp: now + 600, iat: now, email: 'push@p.iam.gserviceaccount.com', email_verified: true }
    const e2 = { ...ENV, GMAIL_PUSH_AUDIENCE: good.aud, GMAIL_PUSH_SERVICE_ACCOUNT: good.email }
    const mk = async () => {
      const db = mailboxDb()
      const c = fakeClient(await db.rpc)
      const g = fakeGoogle((h) => (h.url === GOOGLE.certs ? json(200, { keys: [{ ...jwk, kid: 'k1', alg: 'RS256' }] }) : gmailRoutes()(h)))
      return { env: (k: string) => e2[k], admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() }
    }
    assert.equal((await webhook(push(NOTE), await mk())).status, 401)
    assert.equal((await webhook(push(NOTE, `token=${PUSH}`, await sign(good)), await mk())).status, 200)
    assert.equal((await webhook(push(NOTE, `token=${PUSH}`, await sign({ ...good, aud: 'other' })), await mk())).status, 401)
    assert.equal((await webhook(push(NOTE, `token=${PUSH}`, await sign({ ...good, email: 'x@y.example' })), await mk())).status, 401)
    assert.equal((await webhook(push(NOTE, `token=${PUSH}`, await sign({ ...good, exp: now - 3600 })), await mk())).status, 401)
  })
})

describe('mailbox sync', () => {
  const run = async (o: Parameters<typeof mailboxDb>[0] = {}, routes: Parameters<typeof gmailRoutes>[0] = {}, opts = { mode: 'auto' as const, maxMessages: 50, reconcile: false }) => {
    const db = mailboxDb(o)
    const c = fakeClient(await db.rpc)
    const g = fakeGoogle(gmailRoutes(routes))
    const out = await syncMailbox({ env, admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() }, ACCOUNT, opts)
    return { out, c, g, db }
  }
  it('history sync: new message stored, permitted attachment copied to the private bucket, blocked / oversized ones not downloaded', async () => {
    const { out, c, g } = await run()
    assert.equal(out.ok, true)
    assert.equal(out.stored, 1)
    const res = c.called('support_gmail_attachment_result')
    assert.equal(res.length, 1)
    assert.equal(res[0].args.p_path, `${COMPANY}/email/${EMAIL_ID}/1-photo.jpg`)
    assert.equal(c.store.size, 1)
    assert.ok(!g.hits.some((h) => h.url.includes('ATTACH-0002') || h.url.includes('ATTACH-0003')))
    assert.equal(c.called('support_gmail_sync_state')[0].args.p_history_id, '105')
  })
  it('already stored messages are not fetched again (duplicates)', async () => {
    const { out, g } = await run({ known: ['aaaa000001'] })
    assert.equal(out.stored, 0)
    assert.ok(!g.hits.some((h) => h.url.includes('/messages/aaaa000001')))
  })
  it('expired history (Gmail 404): full re-sync of recent mail from a fresh position', async () => {
    const { out, c, g } = await run({}, { history: () => json(404, { error: { code: 404, message: 'Requested entity was not found.' } }), list: ['bbbb000002', 'bbbb000001'] })
    assert.equal(out.kind, 'FULL')
    assert.equal(out.stored, 2)
    assert.ok(g.hits.some((h) => h.url.includes('/messages?') && new URL(h.url).searchParams.get('q') === 'newer_than:7d (in:inbox OR in:sent)'))
    const st = c.called('support_gmail_sync_state')[0].args
    assert.equal(st.p_kind, 'FULL')
    assert.equal(st.p_history_id, '900')
  })
  it('a failed message stops the position before it (read again next time)', async () => {
    const { out, c } = await run({ ingest: (p) => (p.gmail_message_id === 'aaaa000002' ? null : { result: 'STORED', email_id: EMAIL_ID, attachments: [] }) },
      { history: () => json(200, { history: [{ id: '101', messagesAdded: [{ message: { id: 'aaaa000001' } }] }, { id: '102', messagesAdded: [{ message: { id: 'aaaa000002' } }] },
        { id: '103', messagesAdded: [{ message: { id: 'aaaa000003' } }] }], historyId: '110' }) })
    assert.equal(out.failed, 1)
    assert.equal(c.called('support_gmail_sync_state')[0].args.p_history_id, '101')
  })
  it('budget reached: position stays before the first unprocessed message', async () => {
    const { out, c } = await run({}, { history: () => json(200, { history: [{ id: '101', messagesAdded: [{ message: { id: 'aaaa000001' } }] }, { id: '102', messagesAdded: [{ message: { id: 'aaaa000002' } }] }], historyId: '110' }) },
      { mode: 'auto', maxMessages: 1, reconcile: false })
    assert.equal(out.remaining, 1)
    assert.equal(c.called('support_gmail_sync_state')[0].args.p_history_id, '101')
  })
  it('expired / revoked refresh token (invalid_grant): mailbox marked for reauthorisation, nothing fetched', async () => {
    const db = mailboxDb()
    const c = fakeClient(await db.rpc)
    const g = fakeGoogle((h) => (h.url === GOOGLE.token ? json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) : null))
    const out = await syncMailbox({ env, admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() }, ACCOUNT, { mode: 'auto', maxMessages: 5, reconcile: false })
    assert.equal(out.ok, false)
    assert.equal(c.called('support_gmail_reauth_required').length, 1)
    assert.equal(g.hits.length, 1)
    assert.ok(noSecretsLogged())
  })
  it('a ciphertext from another key cannot be used (reauthorisation required)', async () => {
    const enc = await encryptToken(REFRESH, Buffer.alloc(32, 9).toString('base64'), ACCOUNT)
    const { out, c } = await run({ creds: { ciphertext: enc.ciphertext, iv: enc.iv } })
    assert.equal(out.ok, false)
    assert.equal(c.called('support_gmail_reauth_required').length, 1)
  })
  it('Gmail 5xx is retried, then reported as a failed sync', async () => {
    let n = 0
    const { out, c } = await run({}, { history: () => { n++; return json(503, { error: { message: 'backend' } }) } })
    assert.equal(n, 3)
    assert.equal(out.ok, false)
    assert.equal(c.called('support_gmail_sync_state')[0].args.p_ok, false)
  })
  it('replay (administrator) re-reads history from the previous notification; scheduler needs its secret', async () => {
    const db = mailboxDb({ known: ['aaaa000001'] })
    const c = fakeClient(() => ({}))
    const rpc = await db.rpc
    const client = { ...c.client, rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      c.calls.push({ fn, args })
      if (fn === 'support_email_admin_check') return { data: { account_id: ACCOUNT } as never, error: null }
      if (fn === 'support_gmail_replay') return { data: { account_id: ACCOUNT, event_id: '44444444-4444-4444-8444-444444444444', start_history_id: '90' } as never, error: null }
      const r = rpc(fn, args); return { data: (r.data ?? null) as never, error: r.error ?? null }
    } } as Client
    const g = fakeGoogle(gmailRoutes())
    const d = { allowedOrigins: [], env, caller: () => client, admin: () => client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() }
    const req = (body: unknown, h: Record<string, string>) => new Request('https://f/google-gmail-sync', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) })
    const r = await syncFn(req({ action: 'replay', event_id: '44444444-4444-4444-8444-444444444444' }, { Authorization: 'Bearer admin' }), d)
    assert.equal(r.status, 200)
    assert.ok(g.hits.some((h) => h.url.includes('startHistoryId=90')))
    assert.equal(db.ingested.length, 0) // already stored: replay is idempotent
    assert.equal(c.calls.filter((x) => x.fn === 'support_gmail_event_done')[0].args.p_result, 'PROCESSED')
    assert.equal((await syncFn(req({}, { 'x-cron-secret': 'wrong' }), d)).status, 401)
    assert.equal((await syncFn(req({ action: 'replay', event_id: '44444444-4444-4444-8444-444444444444' }, { 'x-cron-secret': 'cron-1' }), d)).status, 403)
  })
})

// ---- sending ------------------------------------------------------------------------------
describe('google-gmail-send', () => {
  const PREPARED = { existing: false, email_id: EMAIL_ID, message_id: 'm1', conversation_id: 'c1', account_id: ACCOUNT,
    from: { email: 'support@alton.example', name: 'Alton Support' }, to: [{ email: 'ravi@customer.example', name: 'Ravi' }], cc: [], bcc: [{ email: 'audit@alton.example', name: null }],
    subject: 'Re: Cracked basin', body: 'Replacement on its way.', rfc_message_id: '<abc.alton@alton.example>', in_reply_to: '<aaaa000002@customer.example>',
    references: '<aaaa000001@customer.example> <aaaa000002@customer.example>', thread_id: 'thr000001',
    attachments: [{ id: 'a1', path: `${COMPANY}/outbox/k/invoice.pdf`, file_name: 'invoice.pdf', content_type: 'application/pdf', size_bytes: 3 }] }
  const setup = async (o: { prepared?: unknown; prepareError?: { code?: string; message?: string }; send?: (h: Hit) => Response; noFile?: boolean; token?: (h: Hit) => Response | null } = {}) => {
    const creds = await storedCreds()
    const store = new Map<string, Uint8Array>()
    if (!o.noFile) store.set(PREPARED.attachments[0].path, new Uint8Array([37, 80, 68]))
    const c = fakeClient((fn) => {
      if (fn === 'support_gmail_send_prepare') return o.prepareError ? { error: o.prepareError } : { data: o.prepared ?? PREPARED }
      if (fn === 'support_gmail_runtime') return { data: RUNTIME }
      if (fn === 'support_gmail_credentials') return { data: creds }
      return {}
    }, store)
    const g = fakeGoogle((h) => (o.token ? o.token(h) : null) ?? gmailRoutes({ send: o.send })(h))
    return { c, g, d: { allowedOrigins: [], env, caller: () => c.client, admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date('2026-11-13T10:00:00Z') } }
  }
  const post = (body: unknown) => new Request('https://f/google-gmail-send', { method: 'POST', headers: { Authorization: 'Bearer agent', 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const outcome = (c: ReturnType<typeof fakeClient>) => c.called('support_gmail_send_result')[0]?.args
  const BODY = { action: 'send', mode: 'REPLY', reply_to_email_id: 'e2', to: ['ravi@customer.example'], body: 'x', idempotency_key: 'k0000000000000000001' }

  it('accepted by Gmail: Sent with Gmail ids; reply threaded (threadId, In-Reply-To, References, subject); attachment included', async () => {
    const { d, c, g } = await setup()
    const r = await send(post(BODY), d)
    const body = await r.json()
    assert.equal(body.send_state, 'SENT')
    const o = outcome(c)
    assert.equal(o.p_outcome, 'SENT')
    assert.equal(o.p_gmail_id, 'sent000001')
    const req = JSON.parse(g.hits.find((h) => h.url.endsWith('/messages/send'))!.body)
    assert.equal(req.threadId, 'thr000001')
    const mime = Buffer.from(b64urlToBytes(req.raw)).toString('utf8')
    assert.ok(mime.includes('In-Reply-To: <aaaa000002@customer.example>') && mime.includes('References: <aaaa000001@customer.example>\r\n <aaaa000002@customer.example>'))
    assert.ok(mime.includes('Subject: Re: Cracked basin') && mime.includes('From: "Alton Support" <support@alton.example>') && mime.includes('Bcc: audit@alton.example'))
    assert.ok(mime.includes('filename="invoice.pdf"'))
    assert.ok(noSecretsLogged() && !logs.join().includes('Replacement on its way'))
  })
  it('Gmail refuses (4xx): Failed with the reason, never Sent', async () => {
    const { d, c } = await setup({ send: () => json(400, { error: { code: 400, message: 'Invalid To header' } }) })
    const body = await (await send(post(BODY), d)).json()
    assert.equal(body.send_state, 'FAILED')
    assert.equal(outcome(c).p_outcome, 'FAILED')
    assert.match(String(outcome(c).p_error), /Invalid To header/)
  })
  it('Gmail 5xx or timeout: Pending (unconfirmed), not retried automatically', async () => {
    let n = 0
    const { d, c } = await setup({ send: () => { n++; return json(503, { error: { message: 'backend' } }) } })
    const body = await (await send(post(BODY), d)).json()
    assert.equal(body.send_state, 'PENDING')
    assert.equal(outcome(c).p_outcome, 'UNCONFIRMED')
    assert.equal(n, 1)
    const t = await setup({ send: () => { throw new Error('network') } })
    assert.equal((await (await send(post(BODY), t.d)).json()).send_state, 'PENDING')
  })
  it('accepted without a message id: Pending, not Sent', async () => {
    const { d, c } = await setup({ send: () => json(200, {}) })
    assert.equal((await (await send(post(BODY), d)).json()).send_state, 'PENDING')
    assert.equal(outcome(c).p_outcome, 'UNCONFIRMED')
  })
  it('repeated request key: the existing email is returned, nothing sent again', async () => {
    const { d, g } = await setup({ prepared: { existing: true, email_id: EMAIL_ID, message_id: 'm1', conversation_id: 'c1', send_state: 'SENT' } })
    const body = await (await send(post(BODY), d)).json()
    assert.equal(body.send_state, 'SENT')
    assert.equal(g.hits.length, 0)
  })
  it('validation and permission errors from the database are passed on', async () => {
    const { d } = await setup({ prepareError: { code: '42501', message: 'requires support.reply' } })
    assert.equal((await send(post(BODY), d)).status, 403)
    const v = await setup({ prepareError: { code: 'P0001', message: 'File type not permitted: run.exe.' } })
    const r = await send(post(BODY), v.d)
    assert.equal(r.status, 400)
    assert.match((await r.json()).error, /not permitted/)
  })
  it('missing uploaded file: Failed, nothing sent', async () => {
    const { d, g, c } = await setup({ noFile: true })
    assert.equal((await (await send(post(BODY), d)).json()).send_state, 'FAILED')
    assert.ok(!g.hits.some((h) => h.url.endsWith('/messages/send')) && outcome(c).p_outcome === 'FAILED')
  })
  it('revoked authorisation: Failed and the mailbox is marked for reauthorisation', async () => {
    const { d, c } = await setup({ token: (h) => (h.url === GOOGLE.token ? json(400, { error: 'invalid_grant' }) : null) })
    const body = await (await send(post(BODY), d)).json()
    assert.equal(body.send_state, 'FAILED')
    assert.equal(c.called('support_gmail_reauth_required').length, 1)
  })
})

describe('google-gmail-watch-renew', () => {
  it('renews the watch on INBOX with the configured topic, records the expiry; scheduler secret required', async () => {
    const creds = await storedCreds()
    const c = fakeClient((fn) => ({ support_gmail_accounts: { data: [ACCOUNT] }, support_gmail_runtime: { data: RUNTIME }, support_gmail_credentials: { data: creds } } as Record<string, { data: unknown }>)[fn] ?? {})
    const g = fakeGoogle(gmailRoutes())
    const d = { allowedOrigins: [], env, caller: () => c.client, admin: () => c.client, fetch: g.fetch, sleep: async () => {}, now: () => new Date() }
    const req = (secretValue: string) => new Request('https://f/google-gmail-watch-renew', { method: 'POST', headers: { 'x-cron-secret': secretValue } })
    assert.equal((await watchRenew(req('nope'), d)).status, 401)
    const r = await watchRenew(req('cron-1'), d)
    assert.equal(r.status, 200)
    const w = JSON.parse(g.hits.find((h) => h.url.endsWith('/watch'))!.body)
    assert.deepEqual(w, { topicName: RUNTIME.pubsub_topic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' })
    assert.equal(c.called('support_gmail_watch_state')[0].args.p_expiration_ms, '1763596800000')
    assert.ok(noSecretsLogged())
  })
})
