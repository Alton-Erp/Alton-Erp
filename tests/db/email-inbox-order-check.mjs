// Email Inbox order (migration 20261230090000): a reply sent from Support → Emails stays in its Gmail thread but no
// longer moves the conversation to the top of the Inbox; Sent orders by the latest sent email, All Mail by the latest
// activity; unread counts and the original email are untouched; nothing is stored twice.
//
//   npm run test:db:email-inbox-order

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261230090000_email_inbox_order'
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
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    else await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await db.exec(`set local role ${user ? 'authenticated' : 'service_role'}`)
    const r = await db.query(sql, params)
    await db.exec('commit')
    return Object.values(r.rows[0] ?? {})[0]
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    throw e
  }
}
const op = (sql, params) => request('op', sql, params)
const svc = (sql, params) => request(null, sql, params)

// ---- mailbox connected; mail arrives through the real ingest (as the Gmail sync stores it) ----------------------
const saved = await op(`select public.support_email_config_save('{"mailbox_address":"support@alton.example","display_name":"Alton Support"}'::jsonb)`)
const ACCOUNT = saved.config.channel_account_id
await op(`select public.support_gmail_oauth_begin($1)`, ['1'.padStart(64, '0')])
const OP = await val(`select rls_test.id('op')::text`)
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ', 'AAAAAAAAAAAAAAAA', 1,
  array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'], '100')`, [ACCOUNT])
await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('op'), 'display_name', 'Op Agent'))`)
const MON = Date.parse('2026-11-16T09:00:00Z') // Monday
const TUE = Date.parse('2026-11-17T09:00:00Z')
const WED = Date.parse('2026-11-18T15:48:00Z')
const THU = Date.parse('2026-11-19T10:00:00Z')
const ingest = (id, thread, at, extra = {}) => svc(`select public.support_gmail_ingest($1, $2::jsonb)`, [ACCOUNT, JSON.stringify({ gmail_message_id: id, gmail_thread_id: thread,
  label_ids: ['INBOX', 'UNREAD'], rfc_message_id: `<${id}@customer.example>`, from: { email: `${thread}@customer.example`, name: thread }, to: [{ email: 'support@alton.example' }],
  subject: `Subject ${thread}`, body_text: 'Hello', internal_date: String(at), mime: {}, attachments: [], ...extra })])
const box = (folder = 'INBOX') => op(`select public.support_email_mailbox($1::jsonb)`, [JSON.stringify({ folder })])
const subjects = (r) => r.rows.map((x) => x.subject.replace(/^Re: /, ''))
const unread = async () => Number((await op(`select public.support_live_summary()`)).email_unread)

const mon = await ingest('mmmm000001', 'monday', MON)
await ingest('tttt000001', 'tuesday', TUE)
await op(`select public.support_conversation_mark_read($1)`, [mon.conversation_id]) // the agent opens Monday's email
const unread0 = await unread()
const monBefore = (await db.query(`select subject, from_address, to_addresses::text, internal_date::text, created_at::text from public.support_email_messages where gmail_message_id = 'mmmm000001'`)).rows[0]

// Wednesday: reply to Monday's email through the real send path (prepare → Gmail answers → the sync sees the sent copy).
const reply = async (key, body, at) => {
  const p = await op(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: key, mode: 'REPLY', reply_to_email_id: mon.email_id,
    to: [{ email: 'monday@customer.example' }], body })])
  await svc(`select public.support_gmail_send_result($1, 'SENT', $2, 'monday', null, 200)`, [p.email_id, `sent${key.slice(-6)}`])
  const c = await ingest(`sent${key.slice(-6)}`, 'monday', at, { label_ids: ['SENT'], from: { email: 'support@alton.example' }, to: [{ email: 'monday@customer.example' }],
    rfc_message_id: p.rfc_message_id, subject: 'Re: Subject monday' })
  return { p, c }
}

console.log('\nBefore the fix (as found)')
const r1 = await reply('k00000000000000000001', 'We are looking into it.', WED)
ok('the reply stays in Monday\'s conversation and Gmail thread (In-Reply-To = Monday\'s Message-ID)', r1.p.conversation_id === mon.conversation_id && r1.p.thread_id === 'monday'
  && r1.p.in_reply_to === '<mmmm000001@customer.example>' && ['CONFIRMED', 'DUPLICATE'].includes(r1.c.result) && r1.c.email_id === r1.p.email_id, r1)
let inbox = await box()
ok('reproduced: Monday\'s conversation jumped above Tuesday\'s in the Inbox', subjects(inbox).join() === 'Subject monday,Subject tuesday', subjects(inbox))

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)

console.log('\nInbox after a reply')
inbox = await box()
ok('Monday\'s conversation no longer moves above Tuesday\'s', subjects(inbox).join() === 'Subject tuesday,Subject monday', subjects(inbox))
const monRow = inbox.rows.find((r) => r.id === mon.conversation_id)
// The reply is timed when it was sent (now); Monday's email keeps its received time.
ok('Inbox time = latest received email (Monday), not the reply', Date.parse(monRow.sort_at) === MON && Date.parse(monRow.last_in_at) === MON
  && Date.parse(monRow.last_out_at) > MON && monRow.last_at === monRow.last_out_at, monRow)
ok('the conversation shows both messages (received and sent) in one thread', monRow.message_count === 2
  && Number(await val(`select count(distinct conversation_id) from public.support_email_messages where gmail_thread_id = 'monday'`)) === 1)
ok('the reply is stored once, as sent', Number(await val(`select count(*) from public.support_email_messages where conversation_id = $1 and direction = 'OUTBOUND'`, [mon.conversation_id])) === 1
  && (await val(`select send_state from public.support_email_messages where id = $1`, [r1.p.email_id])) === 'SENT')
ok('unread count unchanged by the reply (Inbox badge)', (await unread()) === unread0 && inbox.counts.INBOX === 1)
const monAfter = (await db.query(`select subject, from_address, to_addresses::text, internal_date::text, created_at::text from public.support_email_messages where gmail_message_id = 'mmmm000001'`)).rows[0]
ok('the original received email is unchanged (sender, recipient, subject, received time)', JSON.stringify(monAfter) === JSON.stringify(monBefore), { monBefore, monAfter })

console.log('\nSent and All Mail')
const sent = await box('SENT')
ok('Sent lists the reply\'s conversation, ordered by the latest sent email', sent.rows.length === 1 && sent.rows[0].id === mon.conversation_id && sent.rows[0].sort_at === sent.rows[0].last_out_at, sent.rows)
const all = await box('ALL')
ok('All Mail keeps the latest activity order (the reply counts there)', subjects(all).join() === 'Subject monday,Subject tuesday' && all.rows[0].sort_at === all.rows[0].last_at, subjects(all))

console.log('\nMore replies, new mail, sync')
const r2 = await reply('k00000000000000000002', 'Replacement dispatched.', WED + 3600000)
ok('a second reply: still one conversation, two sent messages, nothing duplicated', r2.p.conversation_id === mon.conversation_id
  && Number(await val(`select count(*) from public.support_email_messages where conversation_id = $1`, [mon.conversation_id])) === 3)
const again = await op(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: 'k00000000000000000002', mode: 'REPLY', reply_to_email_id: mon.email_id, to: ['monday@customer.example'], body: 'x' })])
ok('the same send request twice (double click) is one email', again.existing === true)
await ingest('sent000002', 'monday', WED + 3600000, { label_ids: ['SENT'], from: { email: 'support@alton.example' }, to: [{ email: 'monday@customer.example' }], rfc_message_id: r2.p.rfc_message_id })
ok('the sync seeing the sent copy again stores nothing and does not reorder the Inbox', Number(await val(`select count(*) from public.support_email_messages where conversation_id = $1`, [mon.conversation_id])) === 3
  && subjects(await box()).join() === 'Subject tuesday,Subject monday')
await ingest('mmmm000002', 'monday', THU)
inbox = await box()
ok('a genuinely new email from the customer moves the conversation to the top', subjects(inbox).join() === 'Subject monday,Subject tuesday' && Date.parse(inbox.rows[0].sort_at) === THU, subjects(inbox))
ok('… and counts as unread', (await unread()) === unread0 + 1)
await ingest('wwww000001', 'wednesday', THU + 60000)
ok('a newer conversation goes above it', subjects(await box()).join() === 'Subject wednesday,Subject monday,Subject tuesday')

console.log('\nRollback')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback: the earlier function (no sort_at), mail untouched', (await box()).rows[0].sort_at === undefined && Number(await val(`select count(*) from public.support_email_messages`)) === 6)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies', (await box()).rows[0].sort_at !== undefined)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
