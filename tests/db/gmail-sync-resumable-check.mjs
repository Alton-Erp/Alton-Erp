// Resumable Gmail sync (migration 20261224090000 + supabase/functions/_shared/google/sync.ts): the real sync engine
// runs against the real SQL (PGlite with every migration) and a simulated Gmail mailbox, with faults injected:
// 500- and 2,000-message mailboxes, large and multiple attachments, time budget reached mid-batch, a worker that
// dies (HTTP 546) and comes back after another took over, duplicate and concurrent runs (manual + scheduled),
// expired history, expired page tokens, partial attachment failures, Gmail 5xx. Every message must end up stored
// exactly once, each attachment once, and no batch may exceed its limits.
//
//   npm run test:db:gmail-sync
//
// Local PGlite database only; Google is simulated (no network).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { encryptToken } from '../../supabase/functions/_shared/google/crypto.ts'
import { GOOGLE } from '../../supabase/functions/_shared/google/google.ts'
import { runSync, syncLimits } from '../../supabase/functions/_shared/google/sync.ts'
import { handle as syncFn, MAX_CHAIN } from '../../supabase/functions/google-gmail-sync/handler.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261224090000_gmail_sync_jobs'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 900)}`}`)
}
const val = async (sql, params) => Object.values((await db.query(sql, params)).rows[0] ?? {})[0]

// ---- database client (service role, one transaction per call, calls serialised like a real connection) --------
let chain = Promise.resolve()
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.then(() => {}, () => {}); return p }
const lit = (v) => (Array.isArray(v) ? `{${v.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}` : v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
let rpcFault = null // (fn, args) => Promise | null: lets a test hang a call (worker death) or fail it
const rpcCounts = new Map()
async function rpc(fn, args = {}) {
  rpcCounts.set(fn, (rpcCounts.get(fn) ?? 0) + 1)
  const hold = rpcFault?.(fn, args)
  if (hold) await hold
  const keys = Object.keys(args)
  return serial(async () => {
    try {
      const r = await db.transaction(async (tx) => {
        await tx.exec(`select set_config('request.jwt.claims', '{"role":"service_role"}', true); set local role service_role`)
        const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`
        // Set-returning functions come back as an array, as PostgREST returns them.
        const set = (await tx.query(`select bool_or(proretset) as s from pg_proc where proname = $1`, [fn])).rows[0]?.s
        return tx.query(set ? `select coalesce(json_agg(x), '[]') as v from ${call} x` : `select ${call} as v`, keys.map((k) => lit(args[k])))
      })
      return { data: r.rows[0]?.v ?? null, error: null }
    } catch (e) {
      return { data: null, error: { message: e.message, code: e.code } }
    }
  })
}
const store = new Map() // storage path -> bytes
const uploads = new Map() // path -> attempts
let uploadFault = null // (path) => error message | null
const client = {
  rpc,
  storage: { from: () => ({
    upload: async (p, bytes) => {
      uploads.set(p, (uploads.get(p) ?? 0) + 1)
      const f = uploadFault?.(p)
      if (f) return { error: { message: f } }
      if (store.has(p)) return { error: { message: 'The resource already exists' } }
      store.set(p, bytes.length)
      return { error: null }
    },
    download: async () => ({ data: null, error: { message: 'not used' } }),
  }) },
}

// ---- mailbox connected as the OAuth callback leaves it -------------------------------------------------------------
const KEY = Buffer.alloc(32, 7).toString('base64')
const ACCESS = 'ya29.ACCESS-token-VALUE'
const REFRESH = '1//0g-REFRESH-token-VALUE'
const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-secret-VALUE', GOOGLE_TOKEN_ENCRYPTION_KEY: KEY, GOOGLE_CRON_SECRET: 'cron-1' }
const env = (k) => ENV[k]
const A = await val(`select rls_test.id('company_a')::text`)
const OP = await val(`select rls_test.id('op')::text`)
const asOp = async (sql, params) => {
  return serial(() => db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OP, role: 'authenticated' })])
    await tx.exec('set local role authenticated')
    return Object.values((await tx.query(sql, params)).rows[0] ?? {})[0]
  }))
}
const saved = await asOp(`select public.support_email_config_save('{"mailbox_address":"support@alton.example","display_name":"Alton Support"}'::jsonb)`)
const ACCOUNT = saved.config.channel_account_id
const enc = await encryptToken(REFRESH, KEY, ACCOUNT)
await asOp(`select public.support_gmail_oauth_begin($1)`, ['1'.padStart(64, '0')])
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
ok('mailbox connected', !(await rpc('support_gmail_connect', { p_account: ACCOUNT, p_user: OP, p_address: 'support@alton.example', p_ciphertext: enc.ciphertext, p_iv: enc.iv,
  p_key_version: 1, p_scopes: SCOPES, p_history_id: '1000' })).error)

// ---- simulated Gmail ------------------------------------------------------------------------------------------
class Mailbox {
  constructor() {
    this.msgs = new Map(); this.order = []; this.history = []; this.hid = 1000; this.minHistory = 0; this.gen = 0; this.seq = 0
    this.gets = new Map(); this.atts = new Map(); this.calls = 0; this.fault = null; this.latency = 50
  }
  /** n new messages (history records added); spec(i) gives attachments [{ name, mime, size, inline? }]. */
  add(prefix, n, spec = () => []) {
    const ids = []
    for (let i = 0; i < n; i++) {
      const id = `${prefix}${String(++this.seq).padStart(6, '0')}`
      this.msgs.set(id, { id, thread: `t${id}`, at: 1762000000000 + this.seq * 60000, atts: spec(i), subject: `Order ${id}` })
      this.order.push(id)
      this.history.push({ id: String(++this.hid), messagesAdded: [{ message: { id } }] })
      ids.push(id)
    }
    return ids
  }
  payload(m) {
    const parts = [{ partId: '0', mimeType: 'text/plain', body: { size: 30, data: Buffer.from(`Body of ${m.id}: please help.`).toString('base64url') } }]
    m.atts.forEach((a, i) => parts.push({ partId: String(i + 1), mimeType: a.mime, filename: a.name, headers: [{ name: 'Content-Disposition', value: `attachment; filename="${a.name}"` }],
      body: a.inline ? { size: a.size, data: Buffer.alloc(a.size, 65 + i).toString('base64url') } : { size: a.size, attachmentId: `ATT-${m.id}-${i + 1}` } }))
    return { id: m.id, threadId: m.thread, labelIds: ['INBOX', 'UNREAD'], internalDate: String(m.at), sizeEstimate: 1000,
      payload: { partId: '', mimeType: 'multipart/mixed', headers: [{ name: 'From', value: 'Ravi <ravi@customer.example>' }, { name: 'To', value: 'support@alton.example' },
        { name: 'Subject', value: m.subject }, { name: 'Message-ID', value: `<${m.id}@customer.example>` }], parts } }
  }
  async fetch(input, init) {
    const url = String(input)
    this.calls++
    clock += this.latency
    const json = (s, b) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
    if (url === GOOGLE.token) return json(200, { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' })
    const f = this.fault?.(url, init)
    if (f) return f
    const u = new URL(url)
    const p = u.pathname.replace('/gmail/v1/users/me', '')
    if (p === '/profile') return json(200, { emailAddress: 'support@alton.example', historyId: String(this.hid) })
    if (p === '/history') {
      const start = Number(u.searchParams.get('startHistoryId'))
      if (start < this.minHistory) return json(404, { error: { code: 404, message: 'Requested entity was not found.' } })
      const recs = this.history.filter((h) => Number(h.id) > start)
      const off = Number(u.searchParams.get('pageToken') ?? 0)
      const page = recs.slice(off, off + 100)
      return json(200, { history: page, historyId: String(this.hid), ...(off + 100 < recs.length ? { nextPageToken: String(off + 100) } : {}) })
    }
    if (p === '/messages') {
      const max = Number(u.searchParams.get('maxResults'))
      const tok = u.searchParams.get('pageToken')
      let off = 0
      if (tok) {
        const [g, o] = tok.split(':').map(Number)
        if (g !== this.gen) return json(400, { error: { code: 400, message: 'Invalid pageToken', errors: [{ reason: 'invalid' }] } })
        off = o
      }
      const newestFirst = [...this.order].reverse()
      const page = newestFirst.slice(off, off + max)
      return json(200, { messages: page.map((id) => ({ id, threadId: `t${id}` })), ...(off + max < newestFirst.length ? { nextPageToken: `${this.gen}:${off + max}` } : {}) })
    }
    const att = /^\/messages\/([^/]+)\/attachments\/([^/?]+)$/.exec(p)
    if (att) {
      this.atts.set(att[2], (this.atts.get(att[2]) ?? 0) + 1)
      const m = this.msgs.get(att[1])
      const i = Number(att[2].split('-').at(-1)) - 1
      return json(200, { size: m.atts[i].size, data: Buffer.alloc(m.atts[i].size, 97 + i).toString('base64url') })
    }
    const msg = /^\/messages\/([A-Za-z0-9_-]+)$/.exec(p)
    if (msg) {
      this.gets.set(msg[1], (this.gets.get(msg[1]) ?? 0) + 1)
      const m = this.msgs.get(msg[1])
      return m ? json(200, this.payload(m)) : json(404, { error: { code: 404, message: 'Not Found' } })
    }
    throw new Error(`unexpected ${url}`)
  }
}

let clock = Date.parse('2026-11-20T10:00:00Z')
const logs = []
const origLog = { log: console.log, warn: console.warn, error: console.error }
const quiet = (on) => {
  if (on) { console.log = (...a) => logs.push(a.join(' ')); console.warn = console.log; console.error = console.log } else Object.assign(console, origLog)
}
let gm
const deps = () => ({ env, admin: () => client, fetch: (i, n) => gm.fetch(i, n), sleep: async () => {}, now: () => new Date(clock) })
const LIMITS = { ...syncLimits(env), cpuBudgetMs: 60000 } // CPU budget off here (machine-dependent); its own test below
const run = async (mode = 'auto', limits = LIMITS, extra = {}) => {
  quiet(true)
  try { return await runSync(deps(), ACCOUNT, { mode, limits, ...extra }) } finally { quiet(false) }
}
/** Runs batches the way the continuation chain does, until no work is left now. Checks each batch's limits. */
async function drain(limits = LIMITS, max = 1000) {
  const out = []
  for (let i = 0; i < max; i++) {
    const r = await run('auto', limits)
    out.push(r)
    if (!r.more || !r.progressed) break
  }
  return out
}
/** Lets backoff timers pass (retry times in the past). */
const timePasses = () => db.exec(`update public.support_email_sync_queue set next_attempt_at = now() - interval '1 second' where state = 'PENDING';
  update public.support_email_messages set attachment_parts = (select jsonb_agg(case when a ? 'retry_at' then jsonb_set(a, '{retry_at}', to_jsonb(now() - interval '1 second')) else a end order by o)
    from jsonb_array_elements(attachment_parts) with ordinality x (a, o)) where attachment_parts::text like '%retry_at%'`)
const stored = (prefix) => val(`select count(*)::int from public.support_email_messages where gmail_message_id like $1`, [`${prefix}%`])
const distinctStored = (prefix) => val(`select count(distinct gmail_message_id)::int from public.support_email_messages where gmail_message_id like $1`, [`${prefix}%`])
const resetSync = async () => {
  await db.exec(`delete from public.support_email_sync_queue; delete from public.support_email_sync_jobs; delete from public.support_email_sync_state;
    update public.support_email_config set last_full_sync_at = null`)
}
const exactlyOnce = async (prefix, n, label) => {
  const [a, b] = [await stored(prefix), await distinctStored(prefix)]
  ok(`${label}: all ${n} messages stored exactly once`, a === n && b === n, { stored: a, distinct: b })
  const extra = [...gm.gets.entries()].filter(([id, c]) => id.startsWith(prefix) && c > 1)
  return extra
}

// =====================================================================================================================
console.log('\n500 messages with attachments (initial full sync)')
gm = new Mailbox()
const big = 8 * 1048576
gm.add('aaa', 500, (i) => (i % 10 === 0 ? [{ name: `photo-${i}.jpg`, mime: 'image/jpeg', size: 20000 }, { name: `invoice-${i}.pdf`, mime: 'application/pdf', size: 50000 },
  { name: 'sig.png', mime: 'image/png', size: 300, inline: true }] : i % 50 === 7 ? [{ name: `scan-${i}.pdf`, mime: 'application/pdf', size: big }] : i === 3 ? [{ name: 'huge.zip', mime: 'application/zip', size: 30 * 1048576 }] : []))
let runs = await drain()
let last = runs.at(-1)
ok('connected mailbox without a full sync: an INITIAL full re-sync job is started and completed', (await val(`select status || '/' || reason from public.support_email_sync_jobs`)) === 'COMPLETED/INITIAL', await val(`select to_jsonb(j) from public.support_email_sync_jobs j`))
ok('every batch within its limits (≤12 messages, ≤4 attachment downloads, byte budget unless a single file)', runs.every((r) => r.fetched <= 12 && r.downloads <= 4
  && (r.bytes <= 15 * 1048576 + 200000 || r.downloads === 1)), runs.map((r) => [r.fetched, r.downloads, r.bytes]).filter(([f, d, b]) => f > 12 || d > 4 || (b > 15 * 1048576 + 200000 && d !== 1)))
ok('the run took many small batches, each reporting whether more is left', runs.length > 40 && runs.slice(0, -1).every((r) => r.more) && !last.more, { runs: runs.length, last })
let dup = await exactlyOnce('aaa', 500, '500-message mailbox')
ok('each message fetched from Gmail exactly once (no duplicate requests)', dup.length === 0 && gm.gets.size === 500, { dup: dup.slice(0, 5), gets: gm.gets.size })
const expectAtt = 50 * 3 + 10 // 50 emails × (2 downloaded + 1 inline) + 10 large scans (huge.zip is over the limit)
ok('every permitted attachment stored once (downloaded parts once each, inline parts without a download)', (await val(`select count(*)::int from public.support_attachments where storage_path like $1`, [`${A}/email/%`])) === expectAtt
  && [...gm.atts.values()].every((c) => c === 1) && gm.atts.size === 110 && store.size === expectAtt, { rows: await val(`select count(*)::int from public.support_attachments`), atts: gm.atts.size, store: store.size })
ok('an attachment over the size limit is recorded as too large and never downloaded', !gm.atts.has('ATT-aaa000004-1')
  && (await val(`select a ->> 'state' from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a where m.gmail_message_id = 'aaa000004'`)) === 'TOO_LARGE')
ok('large files (8 MB) are downloaded within the byte budget', runs.some((r) => r.bytes >= big) && runs.every((r) => r.bytes <= 15 * 1048576 + 200000 || r.downloads === 1))
ok('job counts: everything it found was processed, none failed (history had queued the others: each id is queued once)',
  (await val(`select processed = discovered and failed = 0 from public.support_email_sync_jobs`)) === true
  && (await val(`select count(*)::int from public.support_email_sync_queue where gmail_message_id like 'aaa%'`)) === 500, await val(`select to_jsonb(j) from public.support_email_sync_jobs j`))
ok('full sync completion recorded on the mailbox (last full sync, checkpoint mirrored)', (await val(`select last_full_sync_at is not null and last_history_id = '1500' from public.support_email_config`)) === true,
  await val(`select jsonb_build_object('h', last_history_id, 'f', last_full_sync_at) from public.support_email_config`))
ok('the lock is released after every batch', (await val(`select lock_owner is null from public.support_email_sync_state`)) === true)
ok('diagnostics: batch number, counts, duration and remaining work stored; logs carry no token or body', (await val(`select batch_no from public.support_email_sync_state`)) === runs.length
  && (await val(`select last_batch ? 'duration_ms' and last_batch ? 'remaining' from public.support_email_sync_state`)) === true
  && logs.some((l) => l.includes('"message":"batch"') && l.includes('"fetched"')) && !logs.some((l) => l.includes(ACCESS) || l.includes(REFRESH) || l.includes('please help')))

// =====================================================================================================================
console.log('\n2,000 messages, new mail arriving during the full sync')
await resetSync()
gm = new Mailbox()
gm.hid = 5000
gm.add('bbb', 2000)
await db.exec(`update public.support_email_config set last_history_id = null`)
runs = []
for (let i = 0; i < 2000; i++) {
  const r = await run()
  runs.push(r)
  if (i === 30) gm.add('nnn', 25) // customers keep writing
  if (!r.more || !r.progressed) break
}
await exactlyOnce('bbb', 2000, '2,000-message mailbox')
await exactlyOnce('nnn', 25, 'mail that arrived during the sync')
ok('discovery read 4 pages of 500 ids per batch at most, then completed', runs.filter((r) => r.discovered > 0).every((r) => r.discovered <= 2000) && (await val(`select pages from public.support_email_sync_jobs`)) === 4)
ok('new mail is not held back by the full sync (history first): stored before the full sync finished', (await val(`select max(created_at) from public.support_email_messages where gmail_message_id like 'nnn%'`))
  < (await val(`select max(created_at) from public.support_email_messages where gmail_message_id like 'bbb%'`)))
ok('messages fetched exactly once each', [...gm.gets.values()].every((c) => c === 1) && gm.gets.size === 2025)

// =====================================================================================================================
console.log('\nHistory checkpoint: never past an unread page')
await resetSync()
gm = new Mailbox()
gm.hid = 9000
await db.exec(`update public.support_email_config set last_history_id = '9000', last_full_sync_at = now()`)
gm.add('hhh', 1000)
let r1 = await run('auto', { ...LIMITS, historyPages: 2 })
ok('one batch reads 2 history pages (200 records): the checkpoint stops at the last record queued, not at Gmail\'s current id', (await val(`select history_id from public.support_email_sync_state`)) === '9200' && r1.more, await val(`select history_id from public.support_email_sync_state`))
ok('those 200 ids are durable in the queue before any is fetched (oldest first)', (await val(`select count(*)::int from public.support_email_sync_queue where source = 'HISTORY' and gmail_message_id like 'hhh%'`)) === 200
  && (await val(`select string_agg(gmail_message_id, ',' order by id) from (select * from public.support_email_sync_queue where source = 'HISTORY' order by id limit 3) q`)) === 'hhh000001,hhh000002,hhh000003')
await drain({ ...LIMITS, historyPages: 2 })
await exactlyOnce('hhh', 1000, 'history of 1,000 messages over many batches')
ok('the checkpoint ends at Gmail\'s current id', (await val(`select history_id from public.support_email_sync_state`)) === '10000')

// =====================================================================================================================
console.log('\nTime budget reached in the middle of a batch')
await resetSync()
gm = new Mailbox()
gm.hid = 20000
await db.exec(`update public.support_email_config set last_history_id = '20000', last_full_sync_at = now()`)
gm.add('ttt', 40)
gm.latency = 4000 // each Gmail call takes 4 s of the 30 s budget
r1 = await run()
ok('the batch stops starting new messages before its time budget and says more is left', r1.fetched > 0 && r1.fetched < 12 && r1.more && r1.duration_ms <= LIMITS.timeBudgetMs + 4000, r1)
gm.latency = 50
await drain()
await exactlyOnce('ttt', 40, 'after resuming')
const cpuRun = await (async () => { await resetSync(); gm = new Mailbox(); gm.hid = 30000; await db.exec(`update public.support_email_config set last_history_id = '30000', last_full_sync_at = now()`); gm.add('ccc', 30, () => [{ name: 'a.bin', mime: 'application/octet-stream', size: 3 * 1048576 }]); return run('auto', { ...LIMITS, cpuBudgetMs: 0.001 }) })()
ok('the CPU budget (measured parsing / decoding time) also stops a batch early', cpuRun.fetched === 1 && cpuRun.more, cpuRun)
await drain()
await exactlyOnce('ccc', 30, 'after the CPU-limited batch')

// =====================================================================================================================
console.log('\nWorker killed mid-batch (HTTP 546), restart, and the old worker waking up later')
await resetSync()
gm = new Mailbox()
gm.hid = 40000
await db.exec(`update public.support_email_config set last_history_id = '40000', last_full_sync_at = now()`)
gm.add('kkk', 30)
let release
const gate = new Promise((res) => { release = res })
let killAt = 3
rpcFault = (fn) => (fn === 'support_gmail_sync_item_result' && --killAt === 0 ? gate : null) // dies after storing its 3rd message, before recording it
quiet(true)
const zombie = runSync(deps(), ACCOUNT, { mode: 'auto', limits: LIMITS })
await new Promise((res) => setTimeout(res, 300))
quiet(false)
rpcFault = null
ok('the dead worker still holds the lock: another run is told the mailbox is busy (no double processing)', (await run()).busy === true)
await db.exec(`update public.support_email_sync_state set lock_until = now() - interval '1 second'`) // its lock expires
const rec = await run()
ok('after the lock expires the next run takes over (stale lock recovered) and continues', rec.stale_lock_recovered === true && rec.ok, rec)
ok('the message stored just before the death is not stored twice (found as already stored)', rec.duplicates >= 1, rec)
release()
quiet(true)
const z = await zombie
quiet(false)
ok('the old worker, when it wakes up, is refused (lock lost) and stops without changing progress', z.ok === false && /took over/.test(z.message), z)
await drain()
const dupK = await exactlyOnce('kkk', 30, 'after a worker death')
ok('only the interrupted message was fetched twice', dupK.length === 1, dupK)

// =====================================================================================================================
console.log('\nConcurrent manual and scheduled runs, repeated clicks')
await resetSync()
gm = new Mailbox()
gm.hid = 50000
await db.exec(`update public.support_email_config set last_history_id = '50000', last_full_sync_at = now()`)
gm.add('ppp', 60)
await db.exec(`update public.support_email_config set last_history_id = '50060'`) // only the full re-sync finds these
const both = await Promise.all([run('full'), run('auto'), run('auto')])
ok('three runs at once: one works, the others report a running sync', both.filter((r) => r.busy).length === 2 && both.filter((r) => !r.busy).length === 1, both.map((r) => r.busy))
const again = await run('full')
ok('Full re-sync clicked again resumes the same job (no second job)', (await val(`select count(*)::int from public.support_email_sync_jobs`)) === 1 && again.job_id === both.find((r) => !r.busy).job_id,
  { jobs: await val(`select jsonb_agg(jsonb_build_object('s', status, 'r', reason)) from public.support_email_sync_jobs`), again: again.job_id, first: both.map((r) => [r.busy, r.kind, r.job_id]) })
await db.exec(`update public.support_email_sync_state set lock_owner = gen_random_uuid(), lock_until = now() + interval '1 minute'`)
const busyFull = await run('full')
await db.exec(`update public.support_email_sync_state set lock_owner = null, lock_until = null`)
ok('a Full re-sync asked for while a job runs is answered "busy" without a second request', busyFull.busy && (await val(`select full_requested_at is null from public.support_email_sync_state`)) === true, busyFull)
await drain()
await exactlyOnce('ppp', 60, 'with concurrent runs')
await resetSync()
await db.exec(`update public.support_email_config set last_history_id = '50060', last_full_sync_at = now()`)
await db.exec(`update public.support_email_sync_state set lock_owner = gen_random_uuid(), lock_until = now() + interval '1 minute'`)
await db.exec(`insert into public.support_email_sync_state (channel_account_id, company_id, history_id, lock_owner, lock_until) select channel_account_id, company_id, '50060', gen_random_uuid(), now() + interval '1 minute' from public.support_email_config`)
const req2 = await run('full')
ok('… and when no job runs yet, the request is stored and the next batch starts the job', req2.busy && (await val(`select full_requested_at is not null from public.support_email_sync_state`)) === true)
await db.exec(`update public.support_email_sync_state set lock_owner = null, lock_until = null`)
const started = await run('auto')
ok('the next batch starts the requested full re-sync (MANUAL)', started.kind === 'FULL' && (await val(`select reason from public.support_email_sync_jobs where status = 'RUNNING' or status = 'COMPLETED' order by started_at desc limit 1`)) === 'MANUAL', started)
await drain()

// =====================================================================================================================
console.log('\nExpired history and expired page tokens')
await resetSync()
gm = new Mailbox()
gm.hid = 60000
await db.exec(`update public.support_email_config set last_history_id = '100', last_full_sync_at = now()`)
gm.add('xxx', 700)
gm.minHistory = 59000 // history before this is gone
const ex = await run('auto', { ...LIMITS, discoveryPages: 1 })
ok('Gmail 404 on history: a HISTORY_EXPIRED full re-sync starts and history continues from Gmail\'s current id', ex.kind === 'FULL'
  && (await val(`select reason from public.support_email_sync_jobs`)) === 'HISTORY_EXPIRED' && (await val(`select history_id from public.support_email_sync_state`)) === '60700', ex)
gm.gen++ // every page token handed out so far is now invalid
const ex2 = await run('auto', { ...LIMITS, discoveryPages: 1 })
ok('an expired page token restarts discovery from the first page', (await val(`select discovery_restarts from public.support_email_sync_jobs`)) === 1, { ex2, job: await val(`select to_jsonb(j) from public.support_email_sync_jobs j`) })
await drain()
await exactlyOnce('xxx', 700, 'after history and page-token expiry')
ok('restarted discovery does not queue ids twice; the job completes', (await val(`select count(*)::int from public.support_email_sync_queue where gmail_message_id like 'xxx%'`)) === 700
  && (await val(`select discovered + (select count(*) from public.support_email_sync_queue where source <> 'FULL' and gmail_message_id like 'xxx%') from public.support_email_sync_jobs`)) === 700
  && (await val(`select status from public.support_email_sync_jobs`)) === 'COMPLETED',
  await val(`select to_jsonb(j) from public.support_email_sync_jobs j`))

// =====================================================================================================================
console.log('\nGmail failures and partial attachment failures')
await resetSync()
gm = new Mailbox()
gm.hid = 70000
await db.exec(`update public.support_email_config set last_history_id = '70000', last_full_sync_at = now()`)
gm.add('fff', 20, (i) => (i < 4 ? [{ name: `doc-${i}.pdf`, mime: 'application/pdf', size: 1000 }, { name: `img-${i}.png`, mime: 'image/png', size: 1000 }] : []))
let failGets = { fff000005: 99, fff000006: 2 }
gm.fault = (url) => {
  const id = /\/messages\/([A-Za-z0-9_-]+)$/.exec(new URL(url).pathname)?.[1]
  if (id && failGets[id] > 0) { failGets[id]--; return new Response(JSON.stringify({ error: { message: 'backend' } }), { status: 503 }) }
  return null
}
let failUploads = { 'doc-1.pdf': 2, 'img-2.png': 99 }
uploadFault = (p) => { const k = Object.keys(failUploads).find((x) => p.endsWith(x)); if (k && failUploads[k] > 0) { failUploads[k]--; return 'Storage unavailable' } return null }
const g1 = await run()
ok('a message Gmail keeps refusing (503) is retried later, not lost, and does not block the others', g1.failed >= 1 && g1.stored >= 10, { g1, gets: [...gm.gets.keys()].slice(0, 14) })
for (let i = 0; i < 8; i++) { await drain(); await timePasses() }
await drain()
ok('after 5 attempts a message is FAILED (shown, not retried forever); the one that recovered is stored', (await val(`select state || ':' || attempts from public.support_email_sync_queue where gmail_message_id = 'fff000005'`)) === 'FAILED:5'
  && (await stored('fff000006')) === 1)
ok('a failed attachment is retried with backoff and stored once it works', (await val(`select a ->> 'state' from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a where a ->> 'filename' = 'doc-1.pdf'`)) === 'STORED')
ok('an attachment that keeps failing gives up after 5 attempts with the reason', (await val(`select a ->> 'reason' from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a where a ->> 'filename' = 'img-2.png'`)).startsWith('Gave up after 5 attempts'))
ok('the email of a failed attachment is stored once, with its other attachment', (await stored('fff000003')) === 1
  && (await val(`select count(*)::int from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a where m.gmail_message_id = 'fff000003' and a ->> 'state' = 'STORED'`)) === 1)
const st0 = await asOp(`select public.support_email_sync_status()`)
ok('status screen: failed messages and attachments counted', st0.remaining.failed === 1 && st0.remaining.attachments_failed === 1, st0.remaining)
failGets = {}
failUploads = {}
const rt = await rpc('support_gmail_sync_retry', { p_account: ACCOUNT })
ok('Retry puts failed messages and attachments back', rt.data.messages === 1 && rt.data.emails_with_attachments === 1, rt)
await drain()
await exactlyOnce('fff', 20, 'after Retry')
ok('… and the attachment is stored', (await val(`select a ->> 'state' from public.support_email_messages m, jsonb_array_elements(m.attachment_parts) a where a ->> 'filename' = 'img-2.png'`)) === 'STORED')
gm.fault = null
uploadFault = null

// =====================================================================================================================
console.log('\nHandler: continuation chain, permissions, webhook-size batches')
await resetSync()
gm = new Mailbox()
gm.hid = 80000
await db.exec(`update public.support_email_config set last_history_id = '80000', last_full_sync_at = now()`)
gm.add('ccx', 50)
const continued = []
const hdeps = { ...deps(), allowedOrigins: [], caller: () => client, continueLater: (account, depth) => continued.push({ account, depth }) }
const post = (body, h) => new Request('https://f/google-gmail-sync', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) })
quiet(true)
let res = await syncFn(post({}, { 'x-cron-secret': 'cron-1' }), hdeps)
quiet(false)
let body = await res.json()
ok('scheduled run: one batch, answers 200 with counts and remaining work, and schedules the next batch', res.status === 200 && body.results[0].fetched === 12 && body.results[0].continuing === true
  && continued.length === 1 && continued[0].depth === 1, body)
while (continued.length) {
  const c = continued.shift()
  quiet(true)
  res = await syncFn(post({ action: 'continue', account: c.account, depth: c.depth }, { 'x-cron-secret': 'cron-1' }), hdeps)
  quiet(false)
}
await exactlyOnce('ccx', 50, 'continuation chain')
quiet(true)
const bad = await syncFn(post({ action: 'continue', account: ACCOUNT, depth: 1 }, { 'x-cron-secret': 'wrong' }), hdeps)
quiet(false)
ok('continue needs the scheduler secret', bad.status === 401)
ok('the chain is bounded', MAX_CHAIN > 0 && MAX_CHAIN <= 1000)
gm.add('wbh', 9)
const wl = syncLimits(env, 'webhook')
const w = await run('webhook', { ...wl, cpuBudgetMs: 60000 })
ok('a push notification runs a small batch (≤5 messages, ≤1 attachment) and no discovery', w.fetched === 5 && w.more && w.discovered === 0, w)
await drain()
await exactlyOnce('wbh', 9, 'notification + continuation')

// =====================================================================================================================
console.log('\nData safety and rollback')
ok('credentials untouched and the mailbox still connected', (await val(`select count(*)::int from public.support_email_credentials`)) === 1
  && (await val(`select is_enabled from public.support_email_config`)) === true)
const totalEmails = await val(`select count(*)::int from public.support_email_messages`)
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback removes the sync tables only: emails, attachments and credentials stay; reset allowlist back to 131',
  (await val(`select to_regclass('public.support_email_sync_queue') is null and to_regclass('public.support_email_sync_jobs') is null`)) === true
  && (await val(`select count(*)::int from public.support_email_messages`)) === totalEmails && (await val(`select count(*)::int from public.support_email_credentials`)) === 1
  && Number(await val(`select count(*) from private.erp_reset_tables()`)) === 131)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback (134 tables in the reset allowlist)', Number(await val(`select count(*) from private.erp_reset_tables()`)) === 134)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
