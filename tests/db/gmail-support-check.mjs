// Google Workspace Gmail (migration 20261212090000) on top of the Support Centre and telephony.
//
//   npm run test:db:gmail
//
// Local PGlite database only. Signed-in users call the app functions (RLS applies); the Edge Functions' part is
// played by the service role (OAuth consume / connect, ingest, send results, push log, sync state).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261212090000_gmail_support'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')
const defs = async () => Object.fromEntries((await db.query(`select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname = 'support_message_add') or (n.nspname = 'private' and p.proname = 'erp_reset_tables')`)).rows.map((r) => [r.proname, r.prosrc]))
const before = await defs()
const mig = await read(path.join(migDir, `${NAME}.sql`))
await db.exec(mig)
console.log(`✓ migrations applied (${NAME} last), end-to-end business flow`)

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params, role = 'authenticated') {
  await db.exec('reset role')
  await db.exec('begin')
  try {
    if (user) await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role })])
    else await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`)
    await db.exec(`set local role ${role}`)
    const r = await db.query(sql, params)
    await db.exec('commit')
    return { value: Object.values(r.rows[0] ?? {})[0], rows: r.rows }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${user}: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const op = as('op')
const svc = async (sql, params) => { const r = await request(null, sql, params, 'service_role'); if (r.error) throw new Error(`service: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
// true only when refused with the expected error; anything else is printed and counts as false.
const verdict = (r, pattern) => {
  const good = Boolean(r.error) && (!pattern || pattern.test(r.error))
  if (!good) console.log(`      (got: ${r.error ?? 'not refused'})`)
  return good
}
const refused = async (user, sql, params, pattern) => verdict(await request(user, sql, params), pattern)
const refusedSvc = async (sql, params, pattern) => verdict(await request(null, sql, params, 'service_role'), pattern)
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('MAIL_AGENT_TEST', 'Mail agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'MAIL_AGENT_TEST' and p.code in ('support.view', 'support.reply');
  insert into public.roles (code, name, is_system) values ('MAIL_ADMIN_TEST', 'Mail admin (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'MAIL_ADMIN_TEST' and p.code in ('support.view', 'support.manage_integrations')`)
await addUser('m_agent', 'e7e5ce00-0000-4000-8000-0000000000a1', 'MAIL_AGENT_TEST')
await addUser('m_none', 'e7e5ce00-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER')
await addUser('m_admin', 'e7e5ce00-0000-4000-8000-0000000000a3', 'MAIL_ADMIN_TEST')
const agent = as('m_agent')
const H = (n) => n.toString(16).padStart(64, '0')
const CIPHER = 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ'
const SCOPES = `array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']`
let ACCOUNT
const OP = await val(`select rls_test.id('op')::text`)

console.log('\nSettings')
ok('only support.manage_integrations saves email settings', await refused('m_agent', `select public.support_email_config_save('{"mailbox_address":"support@alton.example"}'::jsonb)`, [], /manage_integrations/))
ok('passwords, tokens and status are never accepted', await refused('op', `select public.support_email_config_save('{"mailbox_address":"support@alton.example","refresh_token":"1//abc"}'::jsonb)`, [], /never saved/))
ok('a mailbox address is required', await refused('op', `select public.support_email_config_save('{"mailbox_address":"not-an-address"}'::jsonb)`, [], /mailbox address/))
ok('push needs a valid Pub/Sub topic', await refused('op', `select public.support_email_config_save('{"mailbox_address":"support@alton.example","push_enabled":true,"pubsub_topic":"https://evil.example/x"}'::jsonb)`, [], /projects\//))
const saved = await op(`select public.support_email_config_save('{"mailbox_address":"Support@Alton.example","display_name":"Alton Support","signature":"Alton Support Team","pubsub_topic":"projects/alton-erp-123/topics/gmail-support","push_enabled":true}'::jsonb)`)
ACCOUNT = saved.config.channel_account_id
ok('saved: mailbox normalised, account Setup Required (never Connected from the app)', saved.config.mailbox_address === 'support@alton.example' && saved.account.status === 'SETUP_REQUIRED'
  && saved.has_credentials === false, saved)
ok('least privilege: gmail.readonly and gmail.send only (no gmail.modify unless enabled)', JSON.stringify(saved.requested_scopes) === JSON.stringify(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']), saved.requested_scopes)
ok('channel status for the app is not connected', (await op(`select (select status from jsonb_to_recordset(public.support_channel_status()) as x(channel text, status text) where channel = 'EMAIL')`)) !== 'CONNECTED')

console.log('\nOAuth state')
ok('only an administrator starts the authorisation', await refused('m_agent', `select public.support_gmail_oauth_begin($1)`, [H(1)], /manage_integrations/))
ok('the state must be a SHA-256 hash (plaintext state is never stored)', await refused('op', `select public.support_gmail_oauth_begin('my-plain-state')`, [], /Invalid OAuth state/))
const begun = await op(`select public.support_gmail_oauth_begin($1)`, [H(1)])
ok('begin returns the account, mailbox and requested scopes', begun.account_id === ACCOUNT && begun.mailbox_address === 'support@alton.example' && begun.scopes.length === 2, begun)
ok('the app cannot read OAuth states or credentials', (await refused('op', `select count(*) from public.support_oauth_states`)) === true
  && (await refused('op', `select count(*) from public.support_email_credentials`)) === true)
ok('the app cannot consume a state or store credentials (service role only)', (await refused('op', `select public.support_gmail_oauth_consume($1)`, [H(1)])) === true
  && (await refused('op', `select public.support_gmail_connect($1, null, 'support@alton.example', $2, 'AAAAAAAAAAAAAAAA', 1, ${SCOPES}, '100')`, [ACCOUNT, CIPHER])) === true)
const consumed = await svc(`select public.support_gmail_oauth_consume($1)`, [H(1)])
ok('valid state: consumed with company, account and administrator', consumed.ok === true && consumed.account_id === ACCOUNT && consumed.mailbox_address === 'support@alton.example', consumed)
ok('a state works once (replayed callback refused)', (await svc(`select public.support_gmail_oauth_consume($1)`, [H(1)])).reason === 'USED')
ok('an unknown state is refused', (await svc(`select public.support_gmail_oauth_consume($1)`, [H(999)])).reason === 'UNKNOWN')
ok('a malformed state is refused', (await svc(`select public.support_gmail_oauth_consume('x')`)).reason === 'INVALID')
await op(`select public.support_gmail_oauth_begin($1)`, [H(2)])
await db.exec(`reset role; update public.support_oauth_states set expires_at = now() - interval '1 second' where state_hash = '${H(2)}'`)
ok('an expired state (over 10 minutes) is refused', (await svc(`select public.support_gmail_oauth_consume($1)`, [H(2)])).reason === 'EXPIRED')
await as('m_admin')(`select public.support_gmail_oauth_begin($1)`, [H(3)])
await db.exec(`reset role; delete from public.user_roles where user_id = rls_test.id('m_admin')`)
ok('a state of an administrator who lost the permission is refused', (await svc(`select public.support_gmail_oauth_consume($1)`, [H(3)])).reason === 'NOT_ALLOWED')
const stored = await val(`select count(*)::int from public.support_oauth_states where state_hash !~ '^[0-9a-f]{64}$'`)
ok('only hashes are stored', stored === 0)
for (let i = 10; i < 18; i++) await op(`select public.support_gmail_oauth_begin($1)`, [H(i)])
ok('authorisation attempts are rate limited (10 per 10 minutes per user)', await refused('op', `select public.support_gmail_oauth_begin($1)`, [H(30)], /Too many/))

console.log('\nConnect')
ok('signing in with another account than the support mailbox is refused', await refusedSvc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'someone@gmail.com', $2, 'AAAAAAAAAAAAAAAA', 1, ${SCOPES}, '100')`, [ACCOUNT, CIPHER], /support mailbox is/))
ok('missing Gmail permissions are refused', await refusedSvc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', $2, 'AAAAAAAAAAAAAAAA', 1, array['https://www.googleapis.com/auth/gmail.readonly'], '100')`, [ACCOUNT, CIPHER], /did not grant/))
ok('a plaintext refresh token is refused (only ciphertext is stored)', await refusedSvc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', '1//0gPLAINTEXTrefreshTOKENvalue', 'AAAAAAAAAAAAAAAA', 1, ${SCOPES}, '100')`, [ACCOUNT], /check constraint/))
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'SUPPORT@alton.example', $2, 'AAAAAAAAAAAAAAAA', 1, ${SCOPES}, '100')`, [ACCOUNT, CIPHER])
const cfg = await op(`select public.support_email_config_get()`)
ok('connected: CONNECTED from the server, address, scopes, history position', cfg.account.status === 'CONNECTED' && cfg.config.connected_address === 'support@alton.example'
  && cfg.config.last_history_id === '100' && cfg.has_credentials === true, cfg)
ok('settings never return the encrypted token', !JSON.stringify(cfg).includes(CIPHER))
ok('the app cannot read the credentials function', await refused('op', `select public.support_gmail_credentials($1)`, [ACCOUNT]))
ok('the Edge Functions read the ciphertext with the service role', (await svc(`select public.support_gmail_credentials($1)`, [ACCOUNT])).ciphertext === CIPHER)
ok('connected accounts listed for the scheduler', (await svc(`select count(*)::int from public.support_gmail_accounts() a where a = $1`, [ACCOUNT])) === 1)
ok('the mailbox address cannot change while connected', await refused('op', `select public.support_email_config_save('{"mailbox_address":"other@alton.example"}'::jsonb)`, [], /Disconnect/))

console.log('\nIncoming email')
await op(`select public.support_customer_save(null, '{"display_name":"Ravi Kumar","emails":["ravi@customer.example"]}'::jsonb)`)
const msg = (id, extra = {}) => ({ gmail_message_id: id, gmail_thread_id: 'thr000001', label_ids: ['INBOX', 'UNREAD'], rfc_message_id: `<${id}@customer.example>`,
  from: { email: 'Ravi@Customer.example', name: 'Ravi Kumar' }, to: [{ email: 'support@alton.example', name: 'Support' }], cc: [{ email: 'boss@customer.example' }],
  subject: 'Cracked basin', body_text: 'The basin arrived cracked.', body_html: '<p>The basin arrived <b>cracked</b>.</p>', internal_date: '1762992000000',
  mime: { mimeType: 'multipart/mixed' }, attachments: [], ...extra })
const ingest = (p) => svc(`select public.support_gmail_ingest($1, $2::jsonb)`, [ACCOUNT, JSON.stringify(p)])
ok('the app cannot ingest email', await refused('op', `select public.support_gmail_ingest($1, '{}'::jsonb)`, [ACCOUNT]))
const in1 = await ingest(msg('aaaa000001', { attachments: [
  { part_id: '1', attachment_id: 'ANGjdJ1', filename: 'photo.jpg', mime_type: 'image/jpeg', size: 2048 },
  { part_id: '2', attachment_id: 'ANGjdJ2', filename: 'setup.exe', mime_type: 'application/octet-stream', size: 4096, state: 'BLOCKED', reason: 'File type not permitted' }] }))
ok('new email: stored, new conversation, customer linked on its one exact match', in1.result === 'STORED' && in1.direction === 'INBOUND' && in1.new_conversation === true
  && in1.customer_match === 'MATCHED', in1)
ok('attachment parts: only permitted, pending ones are returned for download', in1.attachments.length === 1 && in1.attachments[0].filename === 'photo.jpg', in1.attachments)
const conv1 = in1.conversation_id
const row1 = (await request('op', `select to_jsonb(m) j from public.support_email_messages m where id = $1`, [in1.email_id])).value
ok('preserved: Gmail ids, From, To, Cc, subject, text, sanitised HTML, time, References headers', row1.gmail_message_id === 'aaaa000001' && row1.gmail_thread_id === 'thr000001'
  && row1.from_address === 'ravi@customer.example' && row1.to_addresses[0].email === 'support@alton.example' && row1.cc_addresses[0].email === 'boss@customer.example'
  && row1.subject === 'Cracked basin' && row1.body_text.includes('cracked') && row1.body_html.includes('<b>') && row1.rfc_message_id === '<aaaa000001@customer.example>'
  && row1.internal_date.startsWith('2025-11-13'), row1)
const conv = (await request('op', `select to_jsonb(c) j from public.support_conversations c where id = $1`, [conv1])).value
ok('conversation: email channel, unread 1, open, Gmail thread id, linked customer', conv.channel === 'EMAIL' && conv.unread_count === 1 && conv.status === 'OPEN'
  && conv.external_thread_id === 'thr000001' && conv.customer_id !== null, conv)
const dup = await ingest(msg('aaaa000001'))
ok('duplicate Gmail message (push + sync, or replay): no second copy', dup.result === 'DUPLICATE' && dup.email_id === in1.email_id
  && (await val(`select count(*)::int from public.support_email_messages where gmail_message_id = 'aaaa000001'`)) === 1
  && (await val(`select count(*)::int from public.support_messages where external_message_id = 'aaaa000001'`)) === 1, dup)
ok('duplicate still returns attachments waiting for download (retried)', dup.attachments.length === 1)
ok('attachment path must be the email folder of this message', await refusedSvc(`select public.support_gmail_attachment_result($1, '1', true, 'elsewhere/photo.jpg', 'photo.jpg', 'image/jpeg', 2048)`, [in1.email_id], /path/))
const companyA = await val(`select company_id::text from public.support_email_config`)
await svc(`select public.support_gmail_attachment_result($1, '1', true, $2, 'photo.jpg', 'image/jpeg', 2048)`, [in1.email_id, `${companyA}/email/${in1.email_id}/1-photo.jpg`])
ok('stored attachment: linked to the message, part marked STORED, not returned again', (await val(`select count(*)::int from public.support_attachments where message_id = $1 and email_part_id = '1'`, [in1.message_id])) === 1
  && (await ingest(msg('aaaa000001'))).attachments.length === 0)
const in2 = await ingest(msg('aaaa000002', { rfc_message_id: '<aaaa000002@customer.example>', in_reply_to: '<aaaa000001@customer.example>', subject: 'Re: Cracked basin', body_html: null }))
ok('same Gmail thread: same conversation, unread 2', in2.conversation_id === conv1 && (await val(`select unread_count from public.support_conversations where id = $1`, [conv1])) === 2)
const in3 = await ingest(msg('aaaa000003', { gmail_thread_id: 'thr000099', rfc_message_id: '<aaaa000003@customer.example>', references: '<aaaa000001@customer.example> <aaaa000002@customer.example>' }))
ok('other Gmail thread but References a known message: threaded into the same conversation', in3.conversation_id === conv1, in3)
ok('spam, drafts and trash are ignored', (await ingest(msg('aaaa000004', { label_ids: ['SPAM'] }))).result === 'IGNORED' && (await ingest(msg('aaaa000005', { label_ids: ['DRAFT'] }))).result === 'IGNORED')
ok('an invalid Gmail id is refused', await refusedSvc(`select public.support_gmail_ingest($1, '{"gmail_message_id":"../../etc"}'::jsonb)`, [ACCOUNT], /Invalid Gmail/))
await op(`select public.support_customer_save(null, '{"display_name":"Shared A","emails":["orders@shared.example"]}'::jsonb)`)
await op(`select public.support_customer_save(null, '{"display_name":"Shared B","emails":["orders@shared.example"]}'::jsonb, true)`)
const amb = await ingest(msg('aaaa000006', { gmail_thread_id: 'thr000006', rfc_message_id: '<aaaa000006@shared.example>', from: { email: 'orders@shared.example' } }))
ok('two customers share the sender address: not linked automatically (no merge)', amb.customer_match === 'AMBIGUOUS'
  && (await val(`select customer_id from public.support_conversations where id = $1`, [amb.conversation_id])) === null, amb)
const unknown = await ingest(msg('aaaa000007', { gmail_thread_id: 'thr000007', rfc_message_id: '<aaaa000007@new.example>', from: { email: 'new@new.example' } }))
ok('unknown sender: new conversation without customer', unknown.customer_match === 'NONE')

console.log('\nSending')
await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('m_agent'), 'display_name', 'Mail Agent'))`)
const KEY = (n) => `k${String(n).padStart(20, '0')}`
const prepare = (user, p) => request(user, `select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify(p)])
ok('a user without support.reply cannot send', (await prepare('m_none', { idempotency_key: KEY(1), to: ['a@b.example'], subject: 's', body: 'b' })).error?.includes('support.reply'))
const reply = await agent(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: KEY(2), mode: 'REPLY', reply_to_email_id: in2.email_id,
  to: [{ email: 'ravi@customer.example', name: 'Ravi' }], subject: 'ignored', body: 'We are sending a replacement.', include_signature: true })])
ok('reply threading: In-Reply-To = replied Message-ID, References chain, same subject, Gmail thread', reply.in_reply_to === '<aaaa000002@customer.example>'
  && reply.references === '<aaaa000002@customer.example>' && reply.subject === 'Re: Cracked basin' && reply.thread_id === 'thr000001' && reply.conversation_id === conv1, reply)
ok('our own Message-ID on the support domain; From = the connected mailbox; signature appended', /^<[0-9a-f]{32}\.alton@alton\.example>$/.test(reply.rfc_message_id)
  && reply.from.email === 'support@alton.example' && reply.body.endsWith('-- \nAlton Support Team'), reply)
const pending = (await request('op', `select jsonb_build_object('state', e.send_state, 'delivery', m.delivery_status) j from public.support_email_messages e join public.support_messages m on m.id = e.message_id where e.id = $1`, [reply.email_id])).value
ok('recorded as Pending (QUEUED), never Sent before Gmail confirms', pending.state === 'PENDING' && pending.delivery === 'QUEUED', pending)
const again = await agent(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: KEY(2), mode: 'REPLY', reply_to_email_id: in2.email_id, to: ['ravi@customer.example'], body: 'x' })])
ok('repeated request key (double click / retry): the same email, not a second one', again.existing === true && again.email_id === reply.email_id)
ok('the app cannot record a send result', await refused('m_agent', `select public.support_gmail_send_result($1, 'SENT', 'gmailid001', null, null, 200)`, [reply.email_id]))
ok('SENT needs the Gmail message id', await refusedSvc(`select public.support_gmail_send_result($1, 'SENT', null, null, null, 200)`, [reply.email_id], /message id/))
await svc(`select public.support_gmail_send_result($1, 'UNCONFIRMED', null, null, 'timeout', null)`, [reply.email_id])
ok('timeout / 5xx: stays Pending', (await val(`select send_state from public.support_email_messages where id = $1`, [reply.email_id])) === 'PENDING')
const confirm = await ingest({ ...msg('bbbb000001'), label_ids: ['SENT'], from: { email: 'support@alton.example' }, to: [{ email: 'ravi@customer.example' }], rfc_message_id: reply.rfc_message_id, subject: 'Re: Cracked basin' })
const afterConfirm = (await request('op', `select jsonb_build_object('state', e.send_state, 'gid', e.gmail_message_id, 'delivery', m.delivery_status) j from public.support_email_messages e join public.support_messages m on m.id = e.message_id where e.id = $1`, [reply.email_id])).value
ok('the next sync confirms it by Message-ID: Sent with Gmail ids, no duplicate row', confirm.result === 'CONFIRMED' && afterConfirm.state === 'SENT' && afterConfirm.gid === 'bbbb000001'
  && afterConfirm.delivery === 'SENT' && (await val(`select count(*)::int from public.support_email_messages where rfc_message_id = $1`, [reply.rfc_message_id])) === 1, { confirm, afterConfirm })
ok('a late Gmail answer after Sent changes nothing', (await svc(`select public.support_gmail_send_result($1, 'FAILED', null, null, 'late', 500)`, [reply.email_id])).changed === false)

const fresh = await agent(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: KEY(3), mode: 'NEW', to: ['ravi@customer.example'], cc: ['boss@customer.example'],
  bcc: ['audit@alton.example'], subject: 'Your replacement', body: 'Dispatched today.', attachments: [{ path: `${companyA}/outbox/${KEY(3)}/invoice.pdf`, file_name: 'invoice.pdf', content_type: 'application/pdf', size_bytes: 1000 }] })])
ok('new email: new conversation linked to the matched customer, Cc / Bcc kept, attachment registered', fresh.thread_id === null && fresh.cc[0].email === 'boss@customer.example'
  && fresh.bcc[0].email === 'audit@alton.example' && fresh.attachments.length === 1 && (await val(`select customer_id is not null from public.support_conversations where id = $1`, [fresh.conversation_id])) === true, fresh)
await svc(`select public.support_gmail_send_result($1, 'SENT', 'cccc000001', 'thr000300', null, 200)`, [fresh.email_id])
ok('Gmail accepted: Sent, Gmail ids stored, conversation gets the Gmail thread', (await val(`select send_state from public.support_email_messages where id = $1`, [fresh.email_id])) === 'SENT'
  && (await val(`select external_thread_id from public.support_conversations where id = $1`, [fresh.conversation_id])) === 'thr000300')
const bad = await agent(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: KEY(4), to: ['x@bounce.example'], subject: 'S', body: 'B' })])
await svc(`select public.support_gmail_send_result($1, 'FAILED', null, null, 'Invalid To header', 400)`, [bad.email_id])
const badRow = (await request('op', `select jsonb_build_object('state', e.send_state, 'err', e.send_error, 'delivery', m.delivery_status) j from public.support_email_messages e join public.support_messages m on m.id = e.message_id where e.id = $1`, [bad.email_id])).value
ok('Gmail refused: Failed with the reason (never Sent)', badRow.state === 'FAILED' && badRow.delivery === 'FAILED' && badRow.err === 'Invalid To header', badRow)
ok('invalid recipient refused', (await prepare('m_agent', { idempotency_key: KEY(5), to: ['not an email'], subject: 's', body: 'b' })).error?.includes('invalid email'))
ok('header injection in a name is removed', (await agent(`select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: KEY(6), to: [{ email: 'a@b.example', name: 'Evil\r\nBcc: x@y.example' }], subject: 's', body: 'b' })])).to[0].name === 'EvilBcc: x@y.example')
ok('attachment not uploaded for this email refused', (await prepare('m_agent', { idempotency_key: KEY(7), to: ['a@b.example'], subject: 's', body: 'b', attachments: [{ path: `${companyA}/outbox/${KEY(3)}/invoice.pdf`, file_name: 'invoice.pdf', size_bytes: 10 }] })).error?.includes('uploaded'))
ok('executable attachment refused', (await prepare('m_agent', { idempotency_key: KEY(8), to: ['a@b.example'], subject: 's', body: 'b', attachments: [{ path: `${companyA}/outbox/${KEY(8)}/run.exe`, file_name: 'run.exe', size_bytes: 10 }] })).error?.includes('not permitted'))
ok('attachments over 10 MB refused', (await prepare('m_agent', { idempotency_key: KEY(9), to: ['a@b.example'], subject: 's', body: 'b', attachments: [{ path: `${companyA}/outbox/${KEY(9)}/a.pdf`, file_name: 'a.pdf', size_bytes: 11 * 1048576 }] })).error?.includes('10 MB'))
const tpl = await op(`select public.support_email_template_save(null, '{"name":"Replacement","subject":"Replacement","body":"We will replace it."}'::jsonb)`)
await op(`select public.support_email_template_save($1, '{"name":"Replacement","body":"We will replace it.","is_active":false}'::jsonb)`, [tpl])
ok('only approved (active) templates can be used', (await prepare('m_agent', { idempotency_key: KEY(10), to: ['a@b.example'], subject: 's', body: 'b', template_id: tpl })).error?.includes('approved'))
ok('agents cannot manage templates', await refused('m_agent', `select public.support_email_template_save(null, '{"name":"X","body":"Y"}'::jsonb)`, [], /manage_settings/))
ok('the generic reply queue refuses email conversations', await refused('m_agent', `select public.support_message_add($1, '{"mode":"REPLY","body":"hi"}'::jsonb)`, [conv1], /support mailbox/))
for (let i = 0; i < 20; i++) await request('m_agent', `select public.support_gmail_send_prepare($1::jsonb)`, [JSON.stringify({ idempotency_key: KEY(100 + i), to: ['a@b.example'], subject: 's', body: 'b' })])
ok('sending is rate limited per user', (await prepare('m_agent', { idempotency_key: KEY(200), to: ['a@b.example'], subject: 's', body: 'b' })).error?.includes('Too many'))

console.log('\nPush notifications and replay')
ok('the app cannot log push notifications', await refused('op', `select public.support_gmail_push('support@alton.example', 'ps1', '120', '{}'::jsonb)`))
ok('unknown mailbox: ignored', (await svc(`select public.support_gmail_push('someone@else.example', 'ps0', '120', '{}'::jsonb)`)).result === 'UNKNOWN')
const p1 = await svc(`select public.support_gmail_push('Support@alton.example', 'ps1', '120', '{"publish_time":"2026-11-13T10:00:00Z"}'::jsonb)`)
ok('notification logged with its history id', p1.result === 'LOGGED' && p1.account_id === ACCOUNT)
ok('Pub/Sub redelivery of the same message: duplicate', (await svc(`select public.support_gmail_push('support@alton.example', 'ps1', '120', '{}'::jsonb)`)).result === 'DUPLICATE')
ok('an invalid history id is refused', (await svc(`select public.support_gmail_push('support@alton.example', 'ps2', 'abc', '{}'::jsonb)`)).result === 'INVALID')
await svc(`select public.support_gmail_event_done($1, 'ERROR', 'Gmail API unavailable')`, [p1.event_id])
ok('only administrators replay', await refused('m_agent', `select public.support_gmail_replay($1)`, [p1.event_id], /manage_integrations/))
const rp = await op(`select public.support_gmail_replay($1)`, [p1.event_id])
ok('replay returns the history position and counts the replay', rp.history_id === '120' && rp.start_history_id === '120' && (await val(`select replay_count from public.support_integration_events where id = $1`, [p1.event_id])) === 1, rp)
ok('replayed messages are stored once (ingest is idempotent)', (await ingest(msg('aaaa000001'))).result === 'DUPLICATE')

console.log('\nSync state and health')
await svc(`select public.support_gmail_sync_state($1, '150', true, 'History sync: 3 new', 'HISTORY')`, [ACCOUNT])
await svc(`select public.support_gmail_sync_state($1, '140', true, 'older', 'HISTORY')`, [ACCOUNT])
ok('history position only moves forward', (await val(`select last_history_id from public.support_email_config`)) === '150')
await svc(`select public.support_gmail_sync_state($1, '90', true, 'Full re-sync after expired history', 'FULL')`, [ACCOUNT])
ok('a full re-sync (expired history, Gmail 404) resets the position', (await val(`select last_history_id from public.support_email_config`)) === '90'
  && (await val(`select last_full_sync_at is not null from public.support_email_config`)) === true)
await svc(`select public.support_gmail_sync_state($1, null, false, 'Gmail API 503', 'HISTORY')`, [ACCOUNT])
ok('a failed sync shows Error', (await val(`select status from public.support_channel_accounts where id = $1`, [ACCOUNT])) === 'ERROR')
await svc(`select public.support_gmail_sync_state($1, '160', true, 'ok', 'HISTORY')`, [ACCOUNT])
ok('the next good sync shows Connected again', (await val(`select status from public.support_channel_accounts where id = $1`, [ACCOUNT])) === 'CONNECTED')
await svc(`select public.support_gmail_watch_state($1, true, '1763596800000', 'Watching INBOX until …')`, [ACCOUNT])
ok('watch expiry recorded', (await val(`select watch_expiration::text from public.support_email_config`)).startsWith('2025-11-20'))
ok('the app cannot set sync or watch state', (await refused('op', `select public.support_gmail_sync_state($1, '999', true, 'x', 'FULL')`, [ACCOUNT])) === true
  && (await refused('op', `select public.support_gmail_watch_state($1, true, '1', 'x')`, [ACCOUNT])) === true)

console.log('\nReading')
const thread = await agent(`select public.support_email_thread($1)`, [conv1])
ok('thread: emails in order with headers, attachments and skipped (blocked) files', thread.length >= 4 && thread[0].from_address === 'ravi@customer.example'
  && thread[0].attachments.length === 1 && thread[0].skipped_attachments.some((x) => x.state === 'BLOCKED') && thread.some((t) => t.send_state === 'SENT'), thread.map((t) => t.subject))
ok('sanitised HTML only on request', (await agent(`select public.support_email_html($1)`, [in1.email_id])).includes('<b>cracked</b>'))
ok('no email access without support.view', (await refused('m_none', `select public.support_email_thread($1)`, [conv1])) === true
  && (await refused('m_none', `select public.support_email_html($1)`, [in1.email_id])) === true)
ok('compose context: mailbox, signature, templates; no secrets', await (async () => {
  const c = await agent(`select public.support_email_compose_context()`)
  return c.can_send === true && c.mailbox === 'support@alton.example' && c.signature === 'Alton Support Team' && !JSON.stringify(c).includes(CIPHER)
})())
ok('mark-read mirroring off by default (no gmail.modify)', (await agent(`select public.support_gmail_mark_read_targets($1)`, [conv1])).enabled === false)
await op(`select public.support_email_config_save('{"mailbox_address":"support@alton.example","mailbox_modify_enabled":true,"signature":"Alton Support Team"}'::jsonb)`)
ok('turning on mailbox changes asks for reauthorisation (gmail.modify not granted yet)', (await val(`select status from public.support_channel_accounts where id = $1`, [ACCOUNT])) === 'REAUTHORIZATION_REQUIRED'
  && (await op(`select public.support_email_config_get()`)).requested_scopes.includes('https://www.googleapis.com/auth/gmail.modify'))
ok('while reauthorisation is required, sending is refused', (await prepare('m_agent', { idempotency_key: KEY(300), to: ['a@b.example'], subject: 's', body: 'b' })).error?.includes('not connected'))

console.log('\nRevoked consent and disconnect')
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', $2, 'AAAAAAAAAAAAAAAA', 1, ${SCOPES.slice(0, -1)},'https://www.googleapis.com/auth/gmail.modify'], '170')`, [ACCOUNT, CIPHER])
ok('reconnected with gmail.modify: mark-read mirroring available', (await agent(`select public.support_gmail_mark_read_targets($1)`, [conv1])).enabled === true)
await svc(`select public.support_gmail_reauth_required($1, 'invalid_grant: Token has been expired or revoked.')`, [ACCOUNT])
ok('revoked consent: credentials deleted, Reauthorization required', (await val(`select count(*)::int from public.support_email_credentials`)) === 0
  && (await val(`select status from public.support_channel_accounts where id = $1`, [ACCOUNT])) === 'REAUTHORIZATION_REQUIRED')
await svc(`select public.support_gmail_connect($1, '${OP}'::uuid, 'support@alton.example', $2, 'AAAAAAAAAAAAAAAA', 1, ${SCOPES}, '180')`, [ACCOUNT, CIPHER])
await svc(`select public.support_gmail_disconnected($1, 'Mailbox moved', true, '${OP}'::uuid)`, [ACCOUNT])
const disc = await op(`select public.support_email_config_get()`)
ok('disconnect: credentials deleted, not connected, watch cleared, history kept for audit', disc.has_credentials === false && disc.account.status === 'NOT_CONNECTED'
  && disc.config.is_enabled === false && disc.config.watch_expiration === null && disc.events.some((e) => e.event_type === 'DISCONNECTED'), disc.account)
ok('after disconnect: notifications ignored, sending refused', (await svc(`select public.support_gmail_push('support@alton.example', 'ps9', '200', '{}'::jsonb)`)).result === 'UNKNOWN'
  && (await prepare('m_agent', { idempotency_key: KEY(301), to: ['a@b.example'], subject: 's', body: 'b' })).error?.includes('not connected'))
ok('stored emails remain on the conversations', (await val(`select count(*)::int from public.support_email_messages`)) > 5)

console.log('\nReset allowlist and rollback')
ok('reset allowlist: the 5 email tables, children before parents', (await val(`select count(*)::int from private.erp_reset_tables() where table_name like 'support_email%' or table_name = 'support_oauth_states'`)) === 5
  && (await val(`select count(*)::int from private.erp_reset_tables()`)) === 113)
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const leftovers = await val(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private')
  and (p.proname like 'support_gmail%' or p.proname like 'support_email%')`)
const tablesLeft = await val(`select count(*)::int from pg_class where relname in ('support_email_config', 'support_email_credentials', 'support_oauth_states', 'support_email_templates', 'support_email_messages')`)
ok('rollback: no Gmail function or table remains', leftovers === 0 && tablesLeft === 0, { leftovers, tablesLeft })
const after = await defs()
ok('rollback: support_message_add and the reset allowlist are byte-identical to before', after.support_message_add === before.support_message_add && after.erp_reset_tables === before.erp_reset_tables)
ok('rollback: email account no longer shown as connected; timeline messages kept', (await val(`select status from public.support_channel_accounts where id = $1`, [ACCOUNT])) === 'NOT_CONNECTED'
  && (await val(`select count(*)::int from public.support_messages where kind = 'EMAIL'`)) > 5)
await db.exec(mig)
ok('roll forward: the migration applies again', (await val(`select count(*)::int from private.erp_reset_tables()`)) === 113)

console.log(`\n${failed === 0 ? '✓' : '✗'} gmail support: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
