// Support Centre live updates (migration 20261225090000): sidebar badge counts (WhatsApp unread conversations,
// unread received emails in the Inbox, missed calls not handled), change stamps, marking missed calls handled,
// permissions and company isolation, read-only summary, and the automatic Gmail sync job (pg_cron + pg_net +
// Vault, stood in for here by small local schemas: the real ones exist only on Supabase).
//
//   npm run test:db:support-live

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261225090000_support_live_updates'
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
async function request(user, sql, params, readOnly = false) {
  await db.exec('reset role')
  await db.exec(readOnly ? 'begin read only' : 'begin')
  try {
    if (user) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    else await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await db.exec(`set local role ${user ? 'authenticated' : 'service_role'}`)
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${user}: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const op = as('op')
const svc = as(null)
const refused = async (user, sql, pattern) => { const r = await request(user, sql); return Boolean(r.error) && (!pattern || pattern.test(r.error)) }
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('LV_VIEW_TEST', 'Support viewer (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'LV_VIEW_TEST' and p.code = 'support.view'`)
await addUser('lv_view', 'e7e5d300-0000-4000-8000-0000000000a1', 'LV_VIEW_TEST')
await addUser('lv_none', 'e7e5d300-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER')
const A = await val(`select rls_test.id('company_a')::text`)
const B = await val(`select rls_test.id('company_b')::text`)

const before = await request('op', `select public.support_live_summary()`)
ok('before the migration the summary does not exist (the sidebar shows no badges)', /does not exist/.test(before.error ?? ''), before)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)
const sum = (user = 'op') => as(user)(`select public.support_live_summary()`)

// ---- fixtures: conversations of both companies, emails through the real Gmail ingest, calls -------------------
const conv = async (company, channel, unread) => val(`insert into public.support_conversations (company_id, channel, status, unread_count, subject, contact_phone)
  values ($1, $2, 'OPEN', $3, 'c', '+919876543210') returning id::text`, [company, channel, unread])
for (const n of [2, 1, 0]) await conv(A, 'WHATSAPP', n)
await conv(B, 'WHATSAPP', 7)

const saved = await op(`select public.support_email_config_save('{"mailbox_address":"support@alton.example","display_name":"Alton Support"}'::jsonb)`)
const ACCOUNT = saved.config.channel_account_id
await op(`select public.support_gmail_oauth_begin($1)`, ['1'.padStart(64, '0')])
const OP = await val(`select rls_test.id('op')::text`)
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ', 'AAAAAAAAAAAAAAAA', 1,
  array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'], '100')`, [ACCOUNT])
let t0 = Date.parse('2026-11-20T05:00:00Z')
const ingest = (id, thread, extra = {}) => svc(`select public.support_gmail_ingest($1, $2::jsonb)`, [ACCOUNT, JSON.stringify({ gmail_message_id: id, gmail_thread_id: thread,
  label_ids: ['INBOX', 'UNREAD'], rfc_message_id: `<${id}@c.example>`, from: { email: 'ravi@customer.example', name: 'Ravi' }, to: [{ email: 'support@alton.example' }],
  subject: 'Cracked basin', body_text: 'x', internal_date: String(t0 += 60000), mime: {}, attachments: [], ...extra })])
const e1 = await ingest('eeee000001', 'thr0000001')
await ingest('eeee000002', 'thr0000001') // same thread: 2 unread
const e3 = await ingest('eeee000003', 'thr0000003')
const e4 = await ingest('eeee000004', 'thr0000004')
const e5 = await ingest('eeee000005', 'thr0000005')
await ingest('ffff000001', 'thr0000009', { label_ids: ['SENT'], from: { email: 'support@alton.example' }, to: [{ email: 'meera@shop.example' }] }) // sent: never counts
await op(`select public.support_email_mailbox_action(array[$1]::uuid[], 'ARCHIVE', '{}'::jsonb)`, [e3.conversation_id])
await op(`select public.support_email_mailbox_action(array[$1]::uuid[], 'TRASH', '{}'::jsonb)`, [e4.conversation_id])
await op(`select public.support_email_mailbox_action(array[$1]::uuid[], 'SNOOZE', $2::jsonb)`, [e5.conversation_id, JSON.stringify({ until: new Date(Date.now() + 86400000).toISOString() })])

const call = (company, status, number, minutesAgo, extra = {}) => val(`insert into public.support_calls (company_id, direction, status, customer_number_e164, created_at, answered_at)
  values ($1, $2, $3, $4, now() - make_interval(mins => $5), $6) returning id::text`, [company, extra.direction ?? 'INBOUND', status, number, minutesAgo, extra.answered ?? null])
const c1 = await call(A, 'MISSED', '+919800000001', 60)
await call(A, 'MISSED', '+919800000002', 50)
await call(A, 'MISSED', '+919800000003', 40)
await call(A, 'COMPLETED', '+919800000003', 30, { direction: 'OUTBOUND', answered: new Date().toISOString() }) // called back and answered
await call(A, 'COMPLETED', '+919800000004', 20, { answered: new Date().toISOString() }) // answered: never counts
await call(B, 'MISSED', '+919800000005', 10)

// ---------------------------------------------------------------------------
console.log('\nCounts')
let s = await sum()
ok('WhatsApp: conversations with unread messages (conversation-level, as the WhatsApp screen shows them)', s.whatsapp_unread === 2, s)
ok('Emails: unread received emails in the Inbox only (archived, trashed, snoozed and sent excluded)', Number(s.email_unread) === 2, s)
ok('Calls: missed incoming calls not called back, not answered later', Number(s.missed_calls) === 2, s)
ok('another company\'s conversations and calls are never counted', s.whatsapp_unread === 2 && Number(s.missed_calls) === 2)
ok('change stamps for each area', s.stamps.whatsapp && s.stamps.email && s.stamps.calls, s.stamps)
ok('a support viewer gets the same counts', JSON.stringify((await sum('lv_view')).whatsapp_unread) === JSON.stringify(s.whatsapp_unread))
ok('without support.view: refused', await refused('lv_none', `select public.support_live_summary()`, /support\.view/))
const ro = await request('op', `select public.support_live_summary()`, [], true)
ok('the summary runs in a read-only transaction (PostgREST GET)', !ro.error, ro.error)
ok('company B sees only its own counts', (await as('b_op')(`select public.support_live_summary()`))?.whatsapp_unread === 1)

console.log('\nCounts follow reading and new mail')
const stamp0 = s.stamps.email
await op(`select public.support_conversation_mark_read($1)`, [e1.conversation_id])
s = await sum()
ok('reading the email thread clears its unread emails from the badge', Number(s.email_unread) === 0, s)
await ingest('eeee000006', 'thr0000003') // the customer writes again on the archived thread: back in the Inbox
s = await sum()
ok('a new email on an archived thread counts again (it returns to the Inbox)', Number(s.email_unread) === 2, s)
ok('the email stamp moves when mail arrives', s.stamps.email > stamp0, { before: stamp0, after: s.stamps.email })

console.log('\nMissed calls handled')
ok('a viewer cannot mark calls handled', await refused('lv_view', `select public.support_calls_mark_handled(null)`, /support\.reply/))
const sig0 = await val(`select updated_at from public.support_call_signals where call_id = $1`, [c1])
const h1 = await op(`select public.support_calls_mark_handled(array[$1]::uuid[])`, [c1])
ok('one call marked handled: count drops by one, the signal row changes (Realtime listeners update)', h1.handled === 1 && Number((await sum()).missed_calls) === 1
  && (await val(`select updated_at from public.support_call_signals where call_id = $1`, [c1])) > sig0, h1)
ok('marking another company\'s call does nothing', (await op(`select public.support_calls_mark_handled(array[(select id from public.support_calls where company_id = $1::uuid limit 1)])`, [B])).handled === 0)
await call(A, 'MISSED', '+919800000006', 5)
const h2 = await op(`select public.support_calls_mark_handled(null)`)
ok('"mark all handled" clears every missed call needing attention', h2.handled === 2 && Number((await sum()).missed_calls) === 0, h2)
ok('handled calls keep their history (status, numbers unchanged)', (await val(`select count(*)::int from public.support_calls where status = 'MISSED' and company_id = $1`, [A])) === 4)
ok('the handled time is readable by the app (column grant), the recording link still is not',
  !(await request('op', `select handled_at from public.support_calls limit 1`)).error && Boolean((await request('op', `select provider_recording_ref from public.support_calls limit 1`)).error))

// ---------------------------------------------------------------------------
console.log('\nAutomatic Gmail sync job')
ok('without pg_cron / pg_net nothing is scheduled and the tick says so', (await val(`select private.support_gmail_sync_tick()`)) === 'pg_net / vault not available')
const st0 = await op(`select public.support_gmail_schedule_status()`)
ok('settings: scheduler not available here', st0.scheduler_available === false && st0.scheduled === false, st0)
// Stand-ins for Supabase's pg_cron, pg_net and Vault.
await db.exec(`reset role;
  create schema cron; create table cron.job (jobid serial primary key, jobname text unique, schedule text, command text, active boolean default true);
  create table cron.job_run_details (jobid int, status text, start_time timestamptz default now(), return_message text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as $$ insert into cron.job (jobname, schedule, command) values (n, s, c) returning jobid $$;
  create function cron.unschedule(n text) returns boolean language sql as $$ delete from cron.job where jobname = n returning true $$;
  create schema net; create table net.requests (url text, body jsonb, headers jsonb, timeout int);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint
    language sql as $$ insert into net.requests values (url, body, headers, timeout_milliseconds) returning 1::bigint $$;
  create schema vault; create table vault.decrypted_secrets (name text, decrypted_secret text);`)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('with pg_cron: one job "alton-gmail-sync" every 2 minutes (re-applying keeps one)', (await val(`select count(*)::int from cron.job where jobname = 'alton-gmail-sync' and schedule = '*/2 * * * *'`)) === 1)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('… still one job after another apply', (await val(`select count(*)::int from cron.job`)) === 1)
ok('without the Vault secrets the tick sends nothing', (await val(`select private.support_gmail_sync_tick()`)) === 'not configured' && (await val(`select count(*)::int from net.requests`)) === 0)
await db.exec(`insert into vault.decrypted_secrets values ('alton_project_url', 'https://srpeewjutlyruympdznc.supabase.co'), ('alton_gmail_cron_secret', 'cron-secret-1')`)
ok('configured: the tick posts { action: sync } to google-gmail-sync with the scheduler secret header', (await val(`select private.support_gmail_sync_tick()`)) === 'requested'
  && (await val(`select url from net.requests`)) === 'https://srpeewjutlyruympdznc.supabase.co/functions/v1/google-gmail-sync'
  && (await val(`select headers ->> 'x-cron-secret' from net.requests`)) === 'cron-secret-1' && (await val(`select body ->> 'action' from net.requests`)) === 'sync')
const st1 = await op(`select public.support_gmail_schedule_status()`)
ok('settings: scheduled and configured, never the secret itself', st1.scheduled === true && st1.secrets_configured === true && !JSON.stringify(st1).includes('cron-secret-1'), st1)
ok('settings status needs support.manage_integrations', await refused('lv_view', `select public.support_gmail_schedule_status()`, /manage_integrations/))
await db.exec(`update vault.decrypted_secrets set decrypted_secret = 'https://evil.example/' where name = 'alton_project_url'`)
ok('a project URL that is not a Supabase project is refused', (await val(`select private.support_gmail_sync_tick()`)) === 'not configured' && (await val(`select count(*)::int from net.requests`)) === 1)
await db.exec(`update public.support_email_config set is_enabled = false`)
ok('no connected mailbox: the tick does nothing', (await val(`select private.support_gmail_sync_tick()`)) === 'no connected mailbox')
await db.exec(`update public.support_email_config set is_enabled = true`)
ok('app users cannot call the tick', await refused('op', `select private.support_gmail_sync_tick()`))

console.log('\nRollback')
const emails = await val(`select count(*)::int from public.support_email_messages`)
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback: job unscheduled, functions and the handled columns removed; calls, emails and conversations stay',
  (await val(`select count(*)::int from cron.job`)) === 0 && (await val(`select to_regprocedure('public.support_live_summary()') is null`)) === true
  && (await val(`select count(*)::int from information_schema.columns where table_name = 'support_calls' and column_name = 'handled_at'`)) === 0
  && (await val(`select count(*)::int from public.support_email_messages`)) === emails && (await val(`select count(*)::int from public.support_calls where company_id = $1`, [A])) === 6)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback', Number((await sum()).missed_calls) >= 0 && (await val(`select count(*)::int from cron.job`)) === 1)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
