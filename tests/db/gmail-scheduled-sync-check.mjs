// Automatic Gmail sync, end to end (migration 20261229090000 + google-gmail-sync): the database tick's real request
// (as pg_net would send it) is delivered to the real google-gmail-sync handler, which syncs a simulated Gmail into
// PGlite. Reproduces the production failure (the Vault scheduler secret differs from GOOGLE_CRON_SECRET: every
// scheduled run refused with 401 while pg_cron said "succeeded"), then checks the fix: scheduled runs store new mail
// exactly once (with attachments), several mailboxes, Gmail errors and interrupted items recover, the checkpoint
// never passes unqueued mail, the settings status tells the truth, and no browser or signed-in user is involved.
//
//   npm run test:db:gmail-scheduled

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { encryptToken } from '../../supabase/functions/_shared/google/crypto.ts'
import { GOOGLE } from '../../supabase/functions/_shared/google/google.ts'
import { handle as syncFn } from '../../supabase/functions/google-gmail-sync/handler.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261229090000_gmail_scheduler_health'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }

// ---- service-role client as the Edge Function uses it ----------------------------------------------------------
let chain = Promise.resolve()
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p }
const lit = (v) => (Array.isArray(v) ? `{${v.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}` : v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
async function rpc(fn, args = {}) {
  const keys = Object.keys(args)
  return serial(async () => {
    try {
      const r = await db.transaction(async (tx) => {
        await tx.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role`)
        const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
        const set = (await tx.query(`select bool_or(proretset) as s from pg_proc where proname = $1`, [fn])).rows[0]?.s
        return tx.query(set ? `select coalesce(json_agg(x), '[]') as v from ${call} x` : `select ${call} as v`, keys.map((k) => lit(args[k])))
      })
      return { data: r.rows[0]?.v ?? null, error: null }
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code } }
    }
  })
}
const stored = new Map()
const client = { rpc, storage: { from: () => ({ upload: async (p, bytes) => { if (stored.has(p)) return { error: { message: 'already exists' } }; stored.set(p, bytes.length); return { error: null } } }) } }
const asUser = (user) => async (sql, params) => serial(() => db.transaction(async (tx) => {
  await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: user, role: 'authenticated' })])
  await tx.exec('set local role authenticated')
  return Object.values((await tx.query(sql, params)).rows[0] ?? {})[0]
}))

// ---- two companies, one mailbox each (as the OAuth callback leaves them) ---------------------------------------
const KEY = Buffer.alloc(32, 7).toString('base64')
const FUNCTION_SECRET = 'function-secret-set-on-18-nov-XYZ' // GOOGLE_CRON_SECRET of the Edge Function
const VAULT_SECRET = 'vault-secret-set-on-21-nov-ABCDE' // alton_gmail_cron_secret: a different value, as in production
const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-secret', GOOGLE_TOKEN_ENCRYPTION_KEY: KEY, GOOGLE_CRON_SECRET: FUNCTION_SECRET }
const OP = await val(`select rls_test.id('op')::text`)
const BOP = await val(`select rls_test.id('b_op')::text`)
const connect = async (user, address) => {
  const saved = await asUser(user)(`select public.support_email_config_save($1::jsonb)`, [JSON.stringify({ mailbox_address: address, display_name: 'Support' })])
  const account = saved.config.channel_account_id
  const enc = await encryptToken('1//REFRESH-' + address, KEY, account)
  await asUser(user)(`select public.support_gmail_oauth_begin($1)`, [(user === OP ? '1' : '2').padStart(64, '0')])
  const r = await rpc('support_gmail_connect', { p_account: account, p_user: user, p_address: address, p_ciphertext: enc.ciphertext, p_iv: enc.iv, p_key_version: 1,
    p_scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], p_history_id: '1000' })
  if (r.error) throw new Error(r.error.message)
  return account
}
const ACC_A = await connect(OP, 'support@alton.example')
const ACC_B = await connect(BOP, 'help@other.example')

// ---- simulated Gmail per mailbox (by access token) --------------------------------------------------------------
class Mailbox {
  constructor(addr) { this.addr = addr; this.msgs = new Map(); this.history = []; this.hid = 1000; this.seq = 0; this.gets = new Map(); this.fault = null }
  add(n, atts = []) {
    for (let i = 0; i < n; i++) {
      const id = `${this.addr[0]}m${String(++this.seq).padStart(5, '0')}`
      this.msgs.set(id, { id, at: 1763700000000 + this.seq * 60000, atts })
      this.history.push({ id: String(++this.hid), messagesAdded: [{ message: { id } }] })
    }
  }
  payload(m) {
    const parts = [{ partId: '0', mimeType: 'text/plain', body: { size: 20, data: Buffer.from(`Hello from ${m.id}`).toString('base64url') } }]
    m.atts.forEach((a, i) => parts.push({ partId: String(i + 1), mimeType: a.mime, filename: a.name, headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.name}"` }],
      body: { size: a.size, attachmentId: `ATT-${m.id}-${i + 1}` } }))
    return { id: m.id, threadId: `t${m.id}`, labelIds: ['INBOX', 'UNREAD'], internalDate: String(m.at), sizeEstimate: 900,
      payload: { partId: '', mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Ravi <ravi@customer.example>' }, { name: 'To', value: this.addr },
        { name: 'Subject', value: `Order ${m.id}` }, { name: 'Message-ID', value: `<${m.id}@customer.example>` }], parts } }
  }
  respond(u) {
    const json = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
    const f = this.fault?.(u)
    if (f) return f
    const p = u.pathname.replace('/gmail/v1/users/me', '')
    if (p === '/profile') return json(200, { emailAddress: this.addr, historyId: String(this.hid) })
    if (p === '/history') {
      const start = Number(u.searchParams.get('startHistoryId'))
      return json(200, { history: this.history.filter((h) => Number(h.id) > start), historyId: String(this.hid) })
    }
    if (p === '/messages') return json(200, { messages: [...this.msgs.keys()].map((id) => ({ id, threadId: `t${id}` })) })
    const att = /^\/messages\/([^/]+)\/attachments\/([^/?]+)$/.exec(p)
    if (att) { const m = this.msgs.get(att[1]); const i = Number(att[2].split('-').at(-1)) - 1; return json(200, { size: m.atts[i].size, data: Buffer.alloc(m.atts[i].size, 97).toString('base64url') }) }
    const msg = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(p)
    if (msg) { this.gets.set(msg[1], (this.gets.get(msg[1]) ?? 0) + 1); const m = this.msgs.get(msg[1]); return m ? json(200, this.payload(m)) : json(404, { error: { code: 404, message: 'Not Found' } }) }
    throw new Error(`unexpected ${u}`)
  }
}
const boxes = { 'ACCESS-support@alton.example': new Mailbox('support@alton.example'), 'ACCESS-help@other.example': new Mailbox('help@other.example') }
const gA = boxes['ACCESS-support@alton.example']
const gB = boxes['ACCESS-help@other.example']
const gmailFetch = async (input, init) => {
  const url = String(input)
  if (url === GOOGLE.token) {
    const rt = new URLSearchParams(String(init.body)).get('refresh_token')
    return new Response(JSON.stringify({ access_token: `ACCESS-${rt.replace('1//REFRESH-', '')}`, expires_in: 3599 }), { status: 200 })
  }
  const auth = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '')
  return boxes[auth].respond(new URL(url))
}
const deps = { env: (k) => ENV[k], admin: () => client, caller: () => { throw new Error('no user session in a scheduled run') }, allowedOrigins: [],
  fetch: gmailFetch, sleep: async () => {}, now: () => new Date() }

// ---- Supabase's pg_cron / pg_net / Vault, as stand-ins; pg_net's queue is delivered to the handler ----------------
await db.exec(`reset role;
  create schema cron; create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text, active boolean default true);
  create table cron.job_run_details (jobid int, status text, start_time timestamptz default now(), return_message text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
  create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
  create schema net; create table net.http_request_queue (id bigserial primary key, url text, body jsonb, headers jsonb, delivered boolean default false);
  create table net._http_response (id bigint primary key, status_code int, content text, timed_out boolean default false, error_msg text, created timestamptz default now());
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
    language sql as $$ insert into net.http_request_queue (url, body, headers) values (url, body, headers) returning id $$;
  create schema vault; create table vault.decrypted_secrets (name text, decrypted_secret text, updated_at timestamptz default now(), created_at timestamptz default now());
  insert into vault.decrypted_secrets (name, decrypted_secret) values ('alton_project_url', 'https://srpeewjutlyruympdznc.supabase.co'), ('alton_gmail_cron_secret', '${VAULT_SECRET}');`)
await db.exec(await read(path.join(migDir, '20261225090000_support_live_updates.sql'))) // schedules the job now that pg_cron exists

/** One cron tick: run the tick as pg_cron does, then deliver pg_net's request to google-gmail-sync and store its answer. */
async function tick(tamper = null) {
  const outcome = await val(`select private.support_gmail_sync_tick()`)
  if (tamper) await db.query(`update net.http_request_queue set headers = headers || $1::jsonb where not delivered`, [JSON.stringify({ 'x-cron-secret': tamper })])
  await db.exec(`insert into cron.job_run_details (jobid, status, return_message) select jobid, 'succeeded', '1 row' from cron.job where jobname = 'alton-gmail-sync'`)
  const reqs = (await db.query(`select id, url, body, headers from net.http_request_queue where not delivered order by id`)).rows
  const answers = []
  for (const q of reqs) {
    const res = await syncFn(new Request(q.url, { method: 'POST', headers: q.headers, body: JSON.stringify(q.body) }), deps)
    const text = await res.text()
    await db.query(`insert into net._http_response (id, status_code, content) values ($1, $2, $3)`, [q.id, res.status, text])
    await db.query(`update net.http_request_queue set delivered = true where id = $1`, [q.id])
    answers.push({ status: res.status, body: JSON.parse(text) })
  }
  return { outcome, answers }
}
const emails = (acc) => val(`select count(*)::int from public.support_email_messages where channel_account_id = $1`, [acc])
const status = () => asUser(OP)(`select public.support_gmail_schedule_status()`)
const quiet = async (fn) => { const o = { log: console.log, warn: console.warn, error: console.error }; console.log = console.warn = console.error = () => {}; try { return await fn() } finally { Object.assign(console, o) } }

// ---------------------------------------------------------------------------
console.log('\nBefore the fix (production as found)')
gA.add(2)
let t = await quiet(tick)
ok('the tick sends its request with the Vault secret ("requested"; pg_cron records "succeeded")', t.outcome === 'requested' && (await val(`select status from cron.job_run_details order by start_time desc limit 1`)) === 'succeeded')
ok('google-gmail-sync refuses it: HTTP 401 "Not allowed." (Vault secret ≠ GOOGLE_CRON_SECRET)', t.answers[0]?.status === 401 && t.answers[0].body.error === 'Not allowed.', t.answers)
ok('… so no new email is stored, although the job "succeeded"', (await emails(ACC_A)) === 0)

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)

console.log('\nScheduled sync after the fix (no browser, no signed-in user)')
gA.add(1, [{ name: 'invoice.pdf', mime: 'application/pdf', size: 3000 }])
gB.add(2)
const h0 = await val(`select history_id from public.support_email_sync_state where channel_account_id = $1`, [ACC_A])
t = await quiet(tick)
const resA = t.answers[0]?.body.results?.find((r) => r.account === ACC_A)
ok('the scheduled request is accepted with the Vault secret (HTTP 200) and serves every connected mailbox', t.answers[0]?.status === 200
  && t.answers[0].body.results.length === 2 && t.answers[0].body.results.every((r) => r.ok), t.answers)
ok('mailbox A: the 3 new messages discovered from history, fetched and stored', resA.stored === 3 && (await emails(ACC_A)) === 3, resA)
ok('the attachment is downloaded into the private bucket', [...stored.keys()].some((p) => p.endsWith('invoice.pdf')))
ok('mailbox B: its own 2 messages, in its own company', (await emails(ACC_B)) === 2
  && (await val(`select count(distinct company_id)::int from public.support_email_messages where channel_account_id = $1`, [ACC_B])) === 1)
ok('the history checkpoint moved to Gmail\'s current position', (await val(`select history_id from public.support_email_sync_state where channel_account_id = $1`, [ACC_A])) === String(gA.hid)
  && h0 !== String(gA.hid))
const live = await asUser(OP)(`select public.support_live_summary()`)
ok('Support → Emails and the sidebar badge see the new mail (live summary: unread inbox emails)', Number(live.email_unread) >= 3, live)
let st = await status()
ok('status: health OK, last scheduled success, last email stored, never a secret', st.health === 'OK' && st.last_scheduled_success_at && st.last_email_stored_at
  && Number(st.emails_stored_24h) === 3 && !JSON.stringify(st).includes(VAULT_SECRET) && !JSON.stringify(st).includes(FUNCTION_SECRET), st)

console.log('\nExactly once')
await quiet(tick)
await quiet(tick)
ok('more scheduled runs store nothing twice', (await emails(ACC_A)) === 3 && (await emails(ACC_B)) === 2)
await quiet(() => syncFn(new Request('https://f/google-gmail-sync', { method: 'POST', headers: { 'x-cron-secret': FUNCTION_SECRET }, body: '{"action":"sync"}' }), deps))
ok('a run with the function\'s own secret (continuations) also works and stores nothing twice', (await emails(ACC_A)) === 3)
ok('each Gmail message was fetched once', [...gA.gets.values()].every((n) => n === 1), [...gA.gets.entries()])

console.log('\nGmail errors and recovery')
gA.add(2)
const hBefore = await val(`select history_id from public.support_email_sync_state where channel_account_id = $1`, [ACC_A])
gA.fault = (u) => (u.pathname.endsWith('/history') ? new Response(JSON.stringify({ error: { code: 503, message: 'Backend Error' } }), { status: 503 }) : null)
t = await quiet(tick)
st = await status()
ok('Gmail 503 (after the client\'s own retries): the run reports the failure, nothing is lost', t.answers[0].status === 200 && t.answers[0].body.results.find((r) => r.account === ACC_A).ok === false)
ok('… the checkpoint did not move past the unread history', (await val(`select history_id from public.support_email_sync_state where channel_account_id = $1`, [ACC_A])) === hBefore)
ok('… status: FAILING "reached Gmail but failed", not "Up to date"', st.health === 'FAILING' && /reached Gmail but failed/.test(st.diagnosis) && /503/.test(st.diagnosis), st)
gA.fault = null
await quiet(tick)
ok('the next scheduled run recovers: both messages stored once', (await emails(ACC_A)) === 5 && (await status()).health === 'OK')
gA.add(1)
const flaky = [...gA.msgs.keys()].at(-1)
gA.fault = (u) => (u.pathname.endsWith(`/messages/${flaky}`) ? new Response('{}', { status: 500 }) : null)
await quiet(tick)
ok('a message Gmail fails to return stays queued for retry (never dropped)', (await val(`select state from public.support_email_sync_queue where gmail_message_id = $1`, [flaky])) === 'PENDING'
  && Number(await val(`select attempts from public.support_email_sync_queue where gmail_message_id = $1`, [flaky])) === 1)
gA.fault = null
await db.exec(`update public.support_email_sync_queue set next_attempt_at = now() - interval '1 second' where gmail_message_id = '${flaky}'`)
await quiet(tick)
ok('… and is stored by a later scheduled run after its backoff, once', (await emails(ACC_A)) === 6 && (await val(`select state from public.support_email_sync_queue where gmail_message_id = $1`, [flaky])) === 'DONE')

console.log('\nInterrupted worker')
gA.add(1)
await db.exec(`update public.support_email_sync_state set lock_owner = gen_random_uuid(), lock_until = now() + interval '1 hour' where channel_account_id = '${ACC_A}'`)
t = await quiet(tick)
ok('while another worker holds the lock the run steps aside (busy, nothing duplicated)', t.answers[0].body.results.find((r) => r.account === ACC_A).busy === true && (await emails(ACC_A)) === 6)
await db.exec(`update public.support_email_sync_state set lock_until = now() - interval '1 second' where channel_account_id = '${ACC_A}'`)
await quiet(tick)
ok('the worker died (lock expired): the next scheduled run takes over and stores the message', (await emails(ACC_A)) === 7)

console.log('\nScheduler problems are shown')
t = await quiet(() => tick('some-unrelated-secret-value-123')) // a header neither GOOGLE_CRON_SECRET nor the Vault secret
st = await status()
ok('a secret neither function nor Vault accepts: 401 → health FAILING with the exact diagnosis', t.answers[0].status === 401 && st.health === 'FAILING' && /HTTP 401/.test(st.diagnosis), st)
ok('… pg_cron still says "succeeded" — the status no longer trusts it', st.last_run?.status === 'succeeded')
await db.query(`select private.support_gmail_sync_tick()`)
st = await status()
ok('a request still in flight does not hide the previous answer', st.health === 'FAILING' && st.calls[0].answered === false)
await quiet(async () => { const reqs = (await db.query(`select id, url, body, headers from net.http_request_queue where not delivered`)).rows; for (const q of reqs) { const r = await syncFn(new Request(q.url, { method: 'POST', headers: q.headers, body: JSON.stringify(q.body) }), deps); await db.query(`insert into net._http_response (id, status_code, content) values ($1, $2, $3)`, [q.id, r.status, await r.text()]); await db.query(`update net.http_request_queue set delivered = true where id = $1`, [q.id]) } })
ok('answered: OK again', (await status()).health === 'OK')
await db.exec(`insert into net._http_response (id, status_code, timed_out, error_msg) select max(id) + 1000, null, true, 'Timeout of 60000 ms reached' from net.http_request_queue`)
await db.exec(`insert into net.http_request_queue (id, url, body, headers, delivered) select max(id) + 1000, 'x', '{}', '{}', true from net.http_request_queue`)
await db.exec(`insert into private.support_gmail_scheduler_calls (outcome, request_id, called_at) select 'requested', max(id), now() + interval '1 second' from net.http_request_queue`)
ok('a timed-out request: FAILING "timed out"', /timed out/.test((await status()).diagnosis ?? ''))
await db.exec(`delete from vault.decrypted_secrets where name = 'alton_gmail_cron_secret'`)
await quiet(tick)
ok('missing Vault secret: NOT_CONFIGURED', (await status()).health === 'NOT_CONFIGURED')
await db.exec(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('alton_gmail_cron_secret', '${VAULT_SECRET}')`)

console.log('\nSecurity')
ok('app users cannot test scheduler secrets', Boolean(await asUser(OP)(`select public.support_gmail_scheduler_secret_ok('${VAULT_SECRET}')`).then(() => null, (e) => e.message)))
ok('the secret check: exact Vault value only; short or empty refused', (await rpc('support_gmail_scheduler_secret_ok', { p_secret: VAULT_SECRET })).data === true
  && (await rpc('support_gmail_scheduler_secret_ok', { p_secret: VAULT_SECRET + 'x' })).data === false && (await rpc('support_gmail_scheduler_secret_ok', { p_secret: 'short' })).data === false)
ok('status needs support.manage_integrations; company B sees only its own mailbox result', (await asUser(BOP)(`select public.support_gmail_schedule_status()`)).calls.find((c) => c.result)?.result.account === ACC_B)
await db.exec(`insert into private.support_gmail_scheduler_calls (outcome, called_at) values ('requested', now() - interval '4 days')`)
await db.query(`select private.support_gmail_sync_tick()`)
ok('the call log keeps 3 days', Number(await val(`select count(*) from private.support_gmail_scheduler_calls where called_at < now() - interval '3 days'`)) === 0)

console.log('\nRollback')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback: the 20261225 tick and status; emails untouched', (await val(`select to_regprocedure('public.support_gmail_scheduler_secret_ok(text)') is null`)) === true
  && (await val(`select private.support_gmail_sync_tick()`)) === 'requested' && (await emails(ACC_A)) === 7)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies', (await val(`select to_regprocedure('public.support_gmail_scheduler_secret_ok(text)') is not null`)) === true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
