// Email workspace (migration 20261222090000): folders (Inbox, Starred, Snoozed, Sent, Important, All mail, Spam,
// Trash, labels), search and filters, mailbox actions on several threads, drafts through the existing form drafts,
// company isolation, read-only listing, and the existing Gmail receive path unchanged.
//
//   npm run test:db:email-mailbox
//
// Local PGlite database only. The Edge Functions' part (mailbox sync after OAuth) is played by the service role.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261222090000_email_mailbox'
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
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('MB_VIEW_TEST', 'Mail viewer (test)', false), ('MB_AGENT_TEST', 'Mail agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where (r.code = 'MB_VIEW_TEST' and p.code = 'support.view') or (r.code = 'MB_AGENT_TEST' and p.code in ('support.view', 'support.reply'))`)
await addUser('mb_view', 'e7e5d100-0000-4000-8000-0000000000a1', 'MB_VIEW_TEST')
await addUser('mb_agent', 'e7e5d100-0000-4000-8000-0000000000a2', 'MB_AGENT_TEST')
await addUser('mb_none', 'e7e5d100-0000-4000-8000-0000000000a3', 'INVENTORY_MANAGER')

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

const r1 = await ingest(mail('aaaa000001', 'thr0000001', { attachments: [{ part_id: '1', attachment_id: 'ANGjdJ1', filename: 'photo.jpg', mime_type: 'image/jpeg', size: 2048 }] }))
await svc(`select public.support_gmail_attachment_result($1, '1', true, $2, 'photo.jpg', 'image/jpeg', 2048)`, [r1.email_id, `${A}/email/${r1.email_id}/1-photo.jpg`])
const r2 = await ingest(mail('bbbb000001', 'thr0000002', { from: { email: 'meera@shop.example', name: 'Meera Shah' }, subject: 'Invoice copy', body_text: 'Please send the GST invoice for March.',
  cc: [{ email: 'accounts@shop.example' }] }))
const r3 = await ingest(mail('cccc000001', 'thr0000003', { from: { email: 'promo@spam.example', name: 'Promo' }, subject: 'You won', body_text: 'Click here.' }))
// An email the ERP sent (Gmail's copy in Sent) that starts a conversation of its own.
const r4 = await ingest(mail('dddd000001', 'thr0000004', { label_ids: ['SENT'], from: { email: 'support@alton.example', name: 'Alton Support' },
  to: [{ email: 'arjun@builder.example', name: 'Arjun' }], subject: 'Quotation', body_text: 'Our quotation is attached.' }))
const C1 = r1.conversation_id
const C2 = r2.conversation_id
const C3 = r3.conversation_id
const C4 = r4.conversation_id

const before = (await request('op', `select public.support_email_mailbox('{}'::jsonb)`)).error
ok('before the migration the mailbox function does not exist (the screen falls back to the unified inbox)', /does not exist/.test(before ?? ''), before)

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log(`✓ ${NAME} applied (twice)`)
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))

const box = (p = {}, user = 'op') => as(user)(`select public.support_email_mailbox($1::jsonb)`, [JSON.stringify(p)])
const act = (ids, action, p = {}, user = 'op') => as(user)(`select public.support_email_mailbox_action($1::uuid[], $2, $3::jsonb)`, [ids, action, JSON.stringify(p)])
const ids = (r) => r.rows.map((x) => x.id)

// ---------------------------------------------------------------------------
console.log('\nFolders')
let inbox = await box()
ok('Inbox: received threads, newest first; the thread started by the ERP is not in the Inbox', ids(inbox).join() === [C3, C2, C1].join() && inbox.total === 3, ids(inbox))
const row = inbox.rows.find((x) => x.id === C1)
ok('row: sender, subject, snippet, time, attachment flag, unread, message count', row.from_name === 'Ravi Kumar' && row.from_address === 'ravi@customer.example'
  && row.subject === 'Cracked basin' && row.snippet === 'The basin arrived cracked.' && row.has_attachment === true && row.unread_count === 1 && row.message_count === 1
  && row.starred === false && row.folder === 'INBOX', row)
ok('counts: unread in the Inbox', inbox.counts.INBOX === 3 && inbox.counts.INBOX_TOTAL === 3, inbox.counts)
ok('Sent: threads with an email sent from the mailbox', ids(await box({ folder: 'SENT' })).join() === C4)
ok('All mail: every thread outside Spam and Trash', (await box({ folder: 'ALL' })).total === 4)
ok('unknown folder refused', await refused('op', `select public.support_email_mailbox('{"folder":"OUTBOX"}'::jsonb)`, [], /Unknown mail folder/))

console.log('\nSearch and filters (server side)')
ok('any field: subject', ids(await box({ q: 'invoice' })).join() === C2)
ok('any field: message text', ids(await box({ q: 'cracked' })).join() === C1)
ok('any field: sender address', ids(await box({ q: 'meera@shop' })).join() === C2)
ok('from: sender name', ids(await box({ from: 'Ravi' })).join() === C1)
ok('to: recipient (cc included)', ids(await box({ folder: 'ALL', to: 'accounts@shop' })).join() === C2 && ids(await box({ folder: 'ALL', to: 'arjun' })).join() === C4)
ok('subject only', ids(await box({ subject: 'won' })).join() === C3 && (await box({ subject: 'arrived' })).total === 0)
ok('words: message text', ids(await box({ words: 'GST invoice' })).join() === C2)
ok('has attachment', ids(await box({ has_attachment: true })).join() === C1 && (await box({ has_attachment: false })).total === 2)
ok('date range (company timezone)', (await box({ after: '2026-11-10', before: '2026-11-10' })).total === 3 && (await box({ after: '2026-11-11' })).total === 0)
ok('a bad date is refused clearly', await refused('op', `select public.support_email_mailbox('{"after":"10/11/2026"}'::jsonb)`, [], /2026-11-20/))

// ---------------------------------------------------------------------------
console.log('\nMailbox actions')
ok('a viewer (support.view only) cannot change the mailbox', await refused('mb_view', `select public.support_email_mailbox_action($1::uuid[], 'STAR')`, [[C1]], /support\.reply/))
ok('a user without support.view sees nothing', await refused('mb_none', `select public.support_email_mailbox('{}'::jsonb)`, [], /support\.view/))
ok('the state table cannot be read or written from the app', await refused('op', `select count(*) from public.support_email_thread_state`)
  && await refused('op', `insert into public.support_email_thread_state (company_id, conversation_id) values ($1, $2)`, [A, C1]))
await act([C1, C2], 'STAR', {}, 'mb_agent')
ok('star several at once (agent with support.reply)', ids(await box({ folder: 'STARRED' })).sort().join() === [C1, C2].sort().join())
await act([C2], 'UNSTAR')
ok('unstar', ids(await box({ folder: 'STARRED' })).join() === C1)
await act([C1], 'IMPORTANT')
ok('important (unread count shown)', ids(await box({ folder: 'IMPORTANT' })).join() === C1 && (await box()).counts.IMPORTANT === 1)
await act([C2], 'MARK_READ')
inbox = await box()
ok('mark as read: unread filter and Inbox count', inbox.counts.INBOX === 2 && ids(await box({ unread: false })).join() === C2 && (await box({ unread: true })).total === 2)
await act([C2], 'MARK_UNREAD')
ok('mark as unread', (await box({ unread: true })).total === 3)
await act([C3], 'SPAM')
ok('report spam: out of the Inbox, in Spam; the email itself is kept', !ids(await box()).includes(C3) && ids(await box({ folder: 'SPAM' })).join() === C3
  && (await val(`select count(*)::int from public.support_email_messages where conversation_id = $1`, [C3])) === 1)
await act([C3], 'INBOX')
ok('not spam: back in the Inbox', ids(await box()).includes(C3))
await act([C3], 'TRASH')
ok('delete moves to Trash (history kept, nothing deleted)', ids(await box({ folder: 'TRASH' })).join() === C3 && (await box({ folder: 'ALL' })).total === 3
  && (await val(`select count(*)::int from public.support_messages where conversation_id = $1`, [C3])) === 1)
ok('Trash and Spam stay out of Starred / labels / All mail', !(await box({ folder: 'ALL' })).rows.some((x) => x.id === C3))
await act([C2], 'ARCHIVE')
ok('archive: out of the Inbox, still in All mail', !ids(await box()).includes(C2) && ids(await box({ folder: 'ALL' })).includes(C2))
await ingest(mail('bbbb000002', 'thr0000002', { from: { email: 'meera@shop.example', name: 'Meera Shah' }, subject: 'Re: Invoice copy', body_text: 'Any update?' }))
ok('a new email from the customer brings an archived thread back to the Inbox', ids(await box()).includes(C2))
const until = new Date(Date.now() + 86400000).toISOString()
ok('snooze needs a future time within a year', await refused('op', `select public.support_email_mailbox_action($1::uuid[], 'SNOOZE', '{"until":"2020-01-01T00:00:00Z"}'::jsonb)`, [[C1]], /future/))
await act([C1], 'SNOOZE', { until })
let sn = await box({ folder: 'SNOOZED' })
ok('snooze: out of the Inbox until the time, listed in Snoozed with the time', !ids(await box()).includes(C1) && ids(sn).join() === C1 && sn.rows[0].snoozed_until !== null && sn.counts.SNOOZED === 1)
await db.exec(`reset role; update public.support_email_thread_state set snoozed_until = now() - interval '1 minute' where conversation_id = '${C1}'`)
ok('when the snooze time passes the thread is back in the Inbox', ids(await box()).includes(C1) && (await box({ folder: 'SNOOZED' })).total === 0)
await act([C1], 'SNOOZE', { until })
await ingest(mail('aaaa000002', 'thr0000001', { subject: 'Re: Cracked basin', body_text: 'Hello?' }))
ok('a new email ends the snooze', ids(await box()).includes(C1))

console.log('\nLabels (the existing support tags)')
const TAG = await op(`select public.support_tag_save(null, 'Warranty', 'info')::text`)
await act([C1, C2], 'LABEL_ADD', { label: TAG })
let lab = await box({ folder: 'LABEL', label: TAG })
ok('label several threads; the label folder lists them', ids(lab).sort().join() === [C1, C2].sort().join() && lab.rows[0].labels[0].name === 'Warranty', lab.rows.map((x) => x.labels))
ok('labels with unread counts for the sidebar', lab.labels.find((l) => l.id === TAG)?.unread === 2, lab.labels)
await act([C2], 'LABEL_REMOVE', { label: TAG })
ok('remove a label', ids(await box({ folder: 'LABEL', label: TAG })).join() === C1)
ok('an unknown label is refused', await refused('op', `select public.support_email_mailbox_action($1::uuid[], 'LABEL_ADD', '{"label":"e7e5d100-0000-4000-8000-000000000999"}'::jsonb)`, [[C1]], /Label not found/))

console.log('\nIsolation and safety')
ok('company B sees no threads and cannot act on company A threads', (await as('b_op')(`select public.support_email_mailbox('{"folder":"ALL"}'::jsonb)`)).total === 0
  && await refused('b_op', `select public.support_email_mailbox_action($1::uuid[], 'TRASH')`, [[C1]], /not found/))
const phone = (await op(`select public.support_conversation_create('{"channel":"PHONE","direction":"INBOUND","contact_phone":"+919800000000","body":"x","call_status":"ANSWERED"}'::jsonb)`)).id
ok('only email conversations can be changed here', await refused('op', `select public.support_email_mailbox_action($1::uuid[], 'STAR')`, [[phone]], /not found/))
ok('at most 200 threads per action; unknown actions refused', await refused('op', `select public.support_email_mailbox_action(array(select gen_random_uuid() from generate_series(1, 201)), 'STAR')`, [], /200/)
  && await refused('op', `select public.support_email_mailbox_action($1::uuid[], 'DELETE_FOREVER')`, [[C1]], /Unknown mailbox action/))
ok('every action is audited per thread', Number(await val(`select count(*) from public.support_audit_logs where action like 'email.mailbox_%'`)) >= 15)
ok('listing runs in a read-only transaction (PostgREST runs STABLE functions read-only)', !(await request('op', `select public.support_email_mailbox('{"folder":"ALL","q":"basin"}'::jsonb)`, [], 'authenticated', true)).error)
ok('no email was changed or removed by the mailbox', (await val(`select count(*)::int from public.support_email_messages`)) === 6)

console.log('\nDrafts (existing form drafts, form key support.email)')
const draft = { mode: 'NEW', to: 'ravi@customer.example', cc: '', bcc: '', subject: 'Replacement', body: 'Dispatched **today**.' }
const sv = await as('mb_agent')(`select public.erp_form_draft_save('support.email', null, 'd-1', $1::jsonb, null, 0)`, [JSON.stringify(draft)])
ok('an agent saves an email draft', sv.status === 'SAVED', sv)
ok('drafts are private: listed for their author only', (await as('mb_agent')(`select public.erp_form_drafts_mine()`)).some((d) => d.form_key === 'support.email' && d.scope === 'd-1')
  && !(await op(`select public.erp_form_drafts_mine()`)).some((d) => d.form_key === 'support.email'))
ok('a viewer without support.reply cannot keep email drafts', await refused('mb_view', `select public.erp_form_draft_save('support.email', null, 'd-2', '{}'::jsonb, null, 0)`))

console.log('\nReset allowlist and rollback')
ok('ERP reset allowlist: 131 tables or more (later migrations add their own) including the mailbox state (before conversations)', Number(await val(`select count(*) from private.erp_reset_tables()`)) >= 131
  && Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_email_thread_state'`)) < Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_conversations'`)))
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback drops the functions and the mailbox state only; emails, labels and drafts stay', (await val(`select to_regclass('public.support_email_thread_state') is null`)) === true
  && (await val(`select count(*)::int from pg_proc where proname like 'support_email_mailbox%'`)) === 0
  && (await val(`select count(*)::int from public.support_email_messages`)) === 6 && (await val(`select count(*)::int from public.support_conversation_tags`)) === 1
  && Number(await val(`select count(*) from private.erp_reset_tables()`)) === 130
  && !(await val(`select count(*)::int from private.erp_form_draft_registry() where form_key = 'support.email'`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback', (await box({ folder: 'ALL' })).total === 4)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
