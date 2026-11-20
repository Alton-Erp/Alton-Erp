// Email workspace, per-message tools (migration 20261223090000): attachment chips for the list rows, stars on single
// emails, spam / phishing reports, the "Show original" target, company isolation, attachment visibility, read-only
// reads, no email or attachment row changed, rollback.
//
//   npm run test:db:email-message-tools
//
// Local PGlite database only. The Edge Functions' part (mailbox sync after OAuth) is played by the service role.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261223090000_email_message_tools'
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
async function request(user, sql, params, role = 'authenticated', readOnly = false) {
  await db.exec('reset role')
  await db.exec(readOnly ? 'begin read only' : 'begin')
  try {
    if (user) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role })])
    else await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await db.exec(`set local role ${role}`)
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
const svc = async (sql, params) => { const r = await request(null, sql, params, 'service_role'); if (r.error) throw new Error(`service: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const refused = async (user, sql, params, pattern) => {
  const r = await request(user, sql, params)
  const good = Boolean(r.error) && (!pattern || pattern.test(r.error))
  if (!good) console.log(`      (got: ${r.error ?? 'not refused'})`)
  return good
}
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('MT_VIEW_TEST', 'Mail viewer (test)', false), ('MT_AGENT_TEST', 'Mail agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where (r.code = 'MT_VIEW_TEST' and p.code = 'support.view') or (r.code = 'MT_AGENT_TEST' and p.code in ('support.view', 'support.reply'))`)
await addUser('mt_view', 'e7e5d200-0000-4000-8000-0000000000a1', 'MT_VIEW_TEST')
await addUser('mt_agent', 'e7e5d200-0000-4000-8000-0000000000a2', 'MT_AGENT_TEST')
await addUser('mt_none', 'e7e5d200-0000-4000-8000-0000000000a3', 'INVENTORY_MANAGER')

// Connected support mailbox, as the OAuth callback leaves it.
const H = (n) => n.toString(16).padStart(64, '0')
const CIPHER = 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ'
const SCOPES = `array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']`
const OP = await val(`select rls_test.id('op')::text`)
const A = await val(`select rls_test.id('company_a')::text`)
const saved = await op(`select public.support_email_config_save('{"mailbox_address":"support@alton.example","display_name":"Alton Support"}'::jsonb)`)
const ACCOUNT = saved.config.channel_account_id
await op(`select public.support_gmail_oauth_begin($1)`, [H(1)])
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', $2, 'AAAAAAAAAAAAAAAA', 1, ${SCOPES}, '100')`, [ACCOUNT, CIPHER])

let t0 = Date.parse('2026-11-10T05:00:00Z')
const mail = (id, thread, extra = {}) => ({ gmail_message_id: id, gmail_thread_id: thread, label_ids: ['INBOX', 'UNREAD'], rfc_message_id: `<${id}@customer.example>`,
  from: { email: 'ravi@customer.example', name: 'Ravi Kumar' }, to: [{ email: 'support@alton.example', name: 'Support' }], cc: [],
  subject: 'Cracked basin', body_text: 'The basin arrived cracked.', internal_date: String(t0 += 3600000), mime: { mimeType: 'text/plain' }, attachments: [], ...extra })
const ingest = (p) => svc(`select public.support_gmail_ingest($1, $2::jsonb)`, [ACCOUNT, JSON.stringify(p)])
const stored = (r, part, name, type, size) => svc(`select public.support_gmail_attachment_result($1, $2, true, $3, $4, $5, $6)`,
  [r.email_id, part, `${A}/email/${r.email_id}/${part}-${name}`, name, type, size])

// Thread 1: two emails from the customer, five files in all (one inline image); thread 2: no files.
const att = (part, filename, mime_type, size, extra = {}) => ({ part_id: part, attachment_id: `ANGjdJ${part}xx`, filename, mime_type, size, ...extra })
const e1 = await ingest(mail('aaaa000001', 'thr0000001', { attachments: [att('1', 'photo.jpg', 'image/jpeg', 2048), att('2', 'invoice.pdf', 'application/pdf', 4096)] }))
await stored(e1, '1', 'photo.jpg', 'image/jpeg', 2048)
await stored(e1, '2', 'invoice.pdf', 'application/pdf', 4096)
const e2 = await ingest(mail('aaaa000002', 'thr0000001', { subject: 'Re: Cracked basin', body_text: 'Video and list attached.',
  attachments: [att('1', 'unboxing.mp4', 'video/mp4', 9000), att('2', 'items.csv', 'text/csv', 100), att('3', 'logo.png', 'image/png', 300, { inline: true, content_id: 'logo' })] }))
await stored(e2, '1', 'unboxing.mp4', 'video/mp4', 9000)
await stored(e2, '2', 'items.csv', 'text/csv', 100)
await stored(e2, '3', 'logo.png', 'image/png', 300)
await svc(`update public.support_attachments set email_inline = true where file_name = 'logo.png'`)
const e3 = await ingest(mail('bbbb000001', 'thr0000002', { from: { email: 'meera@shop.example', name: 'Meera Shah' }, subject: 'Invoice copy', body_text: 'Please send the invoice.' }))
const C1 = e1.conversation_id
const C2 = e3.conversation_id
ok('fixture: two emails in one conversation', e2.conversation_id === C1, { e1, e2 })

const before = (await request('op', `select public.support_email_list_attachments(array[$1]::uuid[])`, [C1])).error
ok('before the migration the functions do not exist (the screen keeps the paperclip and the conversation star)', /does not exist/.test(before ?? ''), before)
// updated_at is left out: the test itself marks a file sensitive and back.
const fingerprint = async () => [await val(`select md5(coalesce((select string_agg(m::text, '|' order by m.id) from public.support_email_messages m), ''))`),
  await val(`select md5(coalesce((select string_agg((to_jsonb(a) - 'updated_at')::text, '|' order by a.id) from public.support_attachments a), ''))`)].join(' ')
const fp0 = await fingerprint()

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log(`✓ ${NAME} applied (twice)`)
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))

const chips = (ids, user = 'op') => as(user)(`select public.support_email_list_attachments($1::uuid[])`, [ids])
const state = (c, user = 'op') => as(user)(`select public.support_email_message_state($1)`, [c])
const mact = (e, a, user = 'op') => as(user)(`select public.support_email_message_action($1, $2)`, [e, a])
const target = (e, user = 'op') => as(user)(`select public.support_email_original_target($1)`, [e])

// ---------------------------------------------------------------------------
console.log('\nAttachment chips for the list')
let c = await chips([C1, C2])
ok('one entry per conversation with files; none for a conversation without', c[C1] && !c[C2], Object.keys(c))
ok('count leaves out inline images (as the thread does)', c[C1].count === 4, c[C1])
ok('newest email first; name, type, size, storage path, email id', c[C1].items.map((x) => x.file_name).join() === 'unboxing.mp4,items.csv,photo.jpg,invoice.pdf'
  && c[C1].items[0].content_type === 'video/mp4' && c[C1].items[0].size_bytes === 9000 && c[C1].items[0].storage_path.endsWith('1-unboxing.mp4')
  && c[C1].items[0].email_id === e2.email_id && c[C1].items.every((x) => x.restricted === false), c[C1].items)
ok('no attachment row is created or uploaded again by reading', Number(await val(`select count(*) from public.support_attachments`)) === 5)
ok('at most 100 conversations per call', await refused('op', `select public.support_email_list_attachments(array(select gen_random_uuid() from generate_series(1, 101)))`, [], /At most 100/))
ok('needs support.view', await refused('mt_none', `select public.support_email_list_attachments(array[$1]::uuid[])`, [C1], /support\.view/))
ok('another company sees nothing of company A', Object.keys(await chips([C1], 'b_op')).length === 0)
await db.exec(`reset role; update public.support_attachments set is_sensitive = true where file_name = 'invoice.pdf'`)
const agentView = (await chips([C1], 'mt_agent'))[C1].items.find((x) => x.file_name === 'invoice.pdf')
const opView = (await chips([C1]))[C1].items.find((x) => x.file_name === 'invoice.pdf')
ok('a sensitive file keeps its name but no storage path for users without support.manage_tickets', agentView.restricted === true && agentView.storage_path === null, agentView)
ok('… and is readable for those with it (same rule as support_email_thread)', opView.restricted === false && Boolean(opView.storage_path), opView)
const thr = (await as('mt_agent')(`select public.support_email_thread($1)`, [C1])).flatMap((m) => m.attachments).find((x) => x.file_name === 'invoice.pdf')
ok('the thread agrees for the same user', thr.restricted === true && thr.storage_path === null)

// ---------------------------------------------------------------------------
console.log('\nStars on single emails')
ok('no state yet: not starred', JSON.stringify(await state(C1)) === JSON.stringify({ starred: false, starred_emails: [] }))
let s = await mact(e1.email_id, 'STAR', 'mt_agent')
ok('starring one email stars the conversation (Starred folder)', s.starred === true && s.starred_emails.join() === e1.email_id
  && (await op(`select public.support_email_mailbox('{"folder":"STARRED"}'::jsonb)`)).rows.some((r) => r.id === C1), s)
s = await mact(e2.email_id, 'STAR', 'mt_agent')
ok('a second email adds to the set', s.starred_emails.length === 2)
s = await mact(e1.email_id, 'UNSTAR', 'mt_agent')
ok('unstarring one keeps the conversation starred while another email is', s.starred === true && s.starred_emails.join() === e2.email_id, s)
s = await mact(e2.email_id, 'UNSTAR', 'mt_agent')
ok('unstarring the last one unstars the conversation', s.starred === false && s.starred_emails.length === 0, s)
await mact(e1.email_id, 'STAR', 'mt_agent')
await as('mt_agent')(`select public.support_email_mailbox_action(array[$1]::uuid[], 'UNSTAR', '{}'::jsonb)`, [C1])
ok('unstarred from the list: no email shows a star', JSON.stringify(await state(C1)) === JSON.stringify({ starred: false, starred_emails: [] }))
s = await mact(e2.email_id, 'STAR', 'mt_agent')
ok('starring again starts a new set (the stale star does not come back)', s.starred_emails.join() === e2.email_id, s)
ok('a viewer without support.reply cannot star', await refused('mt_view', `select public.support_email_message_action($1, 'STAR')`, [e1.email_id], /support\.reply/))
ok('another company cannot act on company A\'s email', await refused('b_op', `select public.support_email_message_action($1, 'STAR')`, [e1.email_id], /not found/))
ok('unknown action refused', await refused('op', `select public.support_email_message_action($1, 'DELETE')`, [e1.email_id], /Unknown email action/))

// ---------------------------------------------------------------------------
console.log('\nSpam and phishing reports')
s = await mact(e3.email_id, 'REPORT_PHISHING', 'mt_agent')
ok('phishing report: the conversation moves to Spam in the ERP', s.folder === 'SPAM'
  && (await op(`select public.support_email_mailbox('{"folder":"SPAM"}'::jsonb)`)).rows.map((r) => r.id).join() === C2, s)
const audit = await val(`select jsonb_agg(jsonb_build_object('action', action, 'entity', entity_id, 'details', details)) from public.support_audit_logs where action like 'email.message_%'`)
ok('each report and star is audited against the single email', audit.some((x) => x.action === 'email.message_report_phishing' && x.entity === e3.email_id && x.details.from === 'meera@shop.example')
  && audit.filter((x) => x.action === 'email.message_star').length >= 3, audit)
await op(`select public.support_email_mailbox_action(array[$1]::uuid[], 'INBOX', '{}'::jsonb)`, [C2])
s = await mact(e3.email_id, 'REPORT_SPAM')
ok('spam report: Spam too; "Not spam" (INBOX) moves it back', s.folder === 'SPAM')

// ---------------------------------------------------------------------------
console.log('\nShow original (target for google-gmail-send)')
let t = await target(e1.email_id)
ok('Gmail message and connected account', t.gmail_message_id === 'aaaa000001' && t.account_id === ACCOUNT && t.raw_allowed === true, t)
t = await target(e1.email_id, 'mt_agent')
ok('the whole original is refused to users who may not open a sensitive attachment of it', t.raw_allowed === false, t)
ok('… the headers stay available to them', t.gmail_message_id === 'aaaa000001')
ok('another company: not found', await refused('b_op', `select public.support_email_original_target($1)`, [e1.email_id], /not found/))
ok('needs support.view', await refused('mt_none', `select public.support_email_original_target($1)`, [e1.email_id], /support\.view/))

// ---------------------------------------------------------------------------
console.log('\nRead-only reads and stored data')
for (const [n, sql, p] of [['list attachments', `select public.support_email_list_attachments(array[$1]::uuid[])`, [C1]],
  ['message state', `select public.support_email_message_state($1)`, [C1]], ['original target', `select public.support_email_original_target($1)`, [e1.email_id]]]) {
  const r = await request('op', sql, p, 'authenticated', true)
  ok(`${n} runs in a read-only transaction (PostgREST GET)`, !r.error, r.error)
}
await db.exec(`reset role; update public.support_attachments set is_sensitive = false where file_name = 'invoice.pdf'`)
const fp1 = await fingerprint()
ok('no email or attachment row changed by any of it', fp1 === fp0, `${fp0} → ${fp1}`)
ok('no app grants on the mailbox state table', (await val(`select count(*)::int from information_schema.role_table_grants where table_name = 'support_email_thread_state' and grantee in ('anon', 'authenticated')`)) === 0)

// ---------------------------------------------------------------------------
console.log('\nRollback')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback drops the functions and the column; conversation stars, folders and emails stay',
  (await val(`select count(*)::int from pg_proc where proname in ('support_email_list_attachments', 'support_email_message_state', 'support_email_message_action', 'support_email_original_target')`)) === 0
  && (await val(`select count(*)::int from information_schema.columns where table_name = 'support_email_thread_state' and column_name = 'starred_emails'`)) === 0
  && (await val(`select starred from public.support_email_thread_state where conversation_id = $1`, [C1])) === true
  && (await val(`select folder from public.support_email_thread_state where conversation_id = $1`, [C2])) === 'SPAM'
  && (await fingerprint()) === fp0)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback', (await chips([C1]))[C1].count === 4)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
