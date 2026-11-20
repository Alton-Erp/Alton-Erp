// WhatsApp Web-style support screen (migration 20261221090000): WhatsApp conversation list with Unread and
// Favourites, personal pin / mute / favourite, and message info with the receipts exactly as Meta reported them.
//
//   npm run test:db:whatsapp-web
//
// Local PGlite database only. The Edge Function's part (webhook ingestion after the signature check) is played
// by the service role.

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261221090000_whatsapp_web_inbox'
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
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('WA_VIEW_TEST', 'WhatsApp viewer (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'WA_VIEW_TEST' and p.code = 'support.view'`)
await addUser('w_view', 'e7e5d000-0000-4000-8000-0000000000a1', 'WA_VIEW_TEST')
await addUser('w_none', 'e7e5d000-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER')

const IDS = { business_portfolio_id: '1234567890', waba_id: '102030405060', phone_number_id: '109876543210', display_phone_number: '+91 1800 123 4567', app_id: '555666777888', graph_api_version: 'v27.0' }
const meta = { display_phone_number: '9118001234567', phone_number_id: IDS.phone_number_id }
const key = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')
const saved = await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'CLOUD_API' })])
const ACCOUNT = saved.config.channel_account_id
// Activation itself is covered by the preflight checks; here the integration is simply on so webhooks are processed.
await db.exec(`reset role; update public.support_whatsapp_config set integration_enabled = true, setup_state = 'CONNECTED', webhook_signed_event_at = now()`)
const ingest = (value) => svc(`select public.support_whatsapp_ingest($1, $2, 'messages', $3::jsonb, $4)`, [ACCOUNT, IDS.waba_id, JSON.stringify(value), key(value)])
let clock = Math.floor(Date.now() / 1000) - 3600
const textMsg = (id, from, name, body) => ({ messaging_product: 'whatsapp', metadata: meta, contacts: [{ profile: { name }, wa_id: from }],
  messages: [{ from, id, timestamp: String(clock += 60), type: 'text', text: { body } }] })
const status = (id, s, extra = {}) => ingest({ messaging_product: 'whatsapp', metadata: meta, statuses: [{ id, status: s, timestamp: String(clock += 60), recipient_id: '919876543210', ...extra }] })

// Three WhatsApp conversations and one phone conversation (must never appear in the WhatsApp list).
await ingest(textMsg('wamid.A1', '919876543210', 'Ravi Kumar', 'The basin arrived cracked'))
await ingest(textMsg('wamid.B1', '919811112222', 'Meera', 'Where is my order?'))
await ingest(textMsg('wamid.C1', '919833334444', 'Arjun', 'Thanks, received'))
await ingest(textMsg('wamid.D1', '919855556666', 'Divya', 'Hello'))
const convOf = (wa) => val(`select conversation_id::text from public.support_whatsapp_threads where wa_id = $1`, [wa])
const ravi = await convOf('919876543210')
const meera = await convOf('919811112222')
const arjun = await convOf('919833334444')
const divya = await convOf('919855556666')
const phoneConv = (await op(`select public.support_conversation_create('{"channel":"PHONE","direction":"INBOUND","contact_name":"Caller","contact_phone":"+919800000000","body":"Called about basin","call_status":"ANSWERED"}'::jsonb)`)).id
await op(`select public.support_conversation_mark_read($1)`, [arjun])

// An outbound reply as the send functions record it (Pending until Meta reports a status), then real webhook statuses.
await db.exec(`reset role;
  insert into public.support_messages (id, company_id, conversation_id, kind, direction, source, body, external_message_id, delivery_status, occurred_at)
  values ('e7e5d000-0000-4000-8000-00000000f001', rls_test.id('company_a'), '${ravi}', 'MESSAGE', 'OUTBOUND', 'CHANNEL', 'We are sending a replacement.', null, 'QUEUED', now());
  insert into public.support_whatsapp_messages (id, company_id, message_id, conversation_id, channel_account_id, direction, wa_message_id, msg_type, status, wa_id)
  values ('e7e5d000-0000-4000-8000-00000000f002', rls_test.id('company_a'), 'e7e5d000-0000-4000-8000-00000000f001', '${ravi}', '${ACCOUNT}', 'OUTBOUND', 'wamid.OUT1', 'text', 'PENDING', '919876543210');`)
const OUT = 'e7e5d000-0000-4000-8000-00000000f002'

const before = (await request('op', `select public.support_whatsapp_inbox()`)).error
ok('before the migration the list function does not exist (the screen falls back to support_inbox)', /does not exist/.test(before ?? ''), before)

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log(`✓ ${NAME} applied (twice)`)
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))

const inbox = (view = 'ALL', search = null, user = 'op') => as(user)(`select public.support_whatsapp_inbox($1, $2, 30, 0)`, [view, search])
const pref = (conv, p, user = 'op') => as(user)(`select public.support_conversation_pref_set($1, $2, $3, $4)`, [conv, p.pinned ?? null, p.muted ?? null, p.favorite ?? null])
const ids = (r) => r.rows.map((x) => x.id)

// ---------------------------------------------------------------------------
console.log('\nWhatsApp conversation list')
let all = await inbox()
ok('only WhatsApp conversations (the phone conversation is not listed)', all.total === 4 && !ids(all).includes(phoneConv) && all.rows.every((r) => r.channel === 'WHATSAPP'), ids(all))
ok('same row fields as the unified inbox plus WhatsApp name, number and the 24-hour window', ['customer_name', 'phone', 'last_message_preview', 'last_activity_at', 'unread_count',
  'assigned_agent', 'ticket_number', 'tags', 'pinned', 'muted', 'favorite', 'profile_name', 'wa_id', 'window_open', 'last_message'].every((k) => k in all.rows[0]), Object.keys(all.rows[0]))
ok('newest activity first', ids(all).indexOf(divya) < ids(all).indexOf(arjun) && ids(all).indexOf(arjun) < ids(all).indexOf(meera), ids(all))
const rRow = () => inbox().then((x) => x.rows.find((r) => r.id === ravi))
let r = await rRow()
ok('list tick: last message outbound and still Pending (no tick invented from the insert)', r.last_message.direction === 'OUTBOUND' && r.last_message.status === 'PENDING', r.last_message)
await status('wamid.OUT1', 'sent')
await status('wamid.OUT1', 'delivered')
r = await rRow()
ok('list tick follows Meta\'s webhook: Delivered after the delivered status, not Read', r.last_message.status === 'DELIVERED', r.last_message)
ok('profile name and number from the WhatsApp thread', r.profile_name === 'Ravi Kumar' && r.wa_id === '919876543210' && r.window_open === true, r)
ok('unknown view refused', await refused('op', `select public.support_whatsapp_inbox('GROUPS')`, [], /Unknown WhatsApp inbox view/))

console.log('\nUnread, search and counts on the server')
let unread = await inbox('UNREAD')
ok('Unread: only conversations with unread messages', unread.total === 3 && !ids(unread).includes(arjun), ids(unread))
ok('counts: all and unread conversations', all.counts.ALL === 4 && all.counts.UNREAD === 3, all.counts)
await op(`select public.support_conversation_mark_read($1)`, [meera])
unread = await inbox('UNREAD')
ok('marking read removes it from Unread', unread.total === 2 && !ids(unread).includes(meera), ids(unread))
ok('search through the message history', ids(await inbox('ALL', 'cracked')).join() === ravi)
ok('search by phone number', ids(await inbox('ALL', '98111 12222')).join() === meera)
ok('search by contact name', ids(await inbox('ALL', 'Arjun')).join() === arjun)

// ---------------------------------------------------------------------------
console.log('\nPin, mute and favourite (personal)')
ok('the preferences table cannot be read or written directly from the app', await refused('op', `select count(*) from public.support_conversation_prefs`)
  && await refused('op', `insert into public.support_conversation_prefs (company_id, conversation_id, user_id) values (rls_test.id('company_a'), $1, rls_test.id('op'))`, [ravi]))
let res = await pref(meera, { favorite: true })
ok('favourite set', res.favorite === true && res.pinned === false && res.muted === false, res)
let fav = await inbox('FAVORITES')
ok('Favourites view lists it, count 1', ids(fav).join() === meera && fav.counts.FAVORITES === 1, fav)
await pref(ravi, { pinned: true })
all = await inbox()
ok('pinned conversations come first, before newer ones', ids(all)[0] === ravi && all.rows[0].pinned === true, ids(all))
await pref(arjun, { pinned: true })
await pref(divya, { pinned: true })
ok('at most three pinned conversations', await refused('op', `select public.support_conversation_pref_set($1, true)`, [meera], /up to 3/))
res = await pref(ravi, { muted: true })
ok('changing one preference keeps the others (mute keeps the pin)', res.muted === true && res.pinned === true, res)
res = await pref(ravi, { pinned: false })
ok('unpin', res.pinned === false && res.muted === true, res)
ok('pinning again after an unpin is allowed', (await pref(meera, { pinned: true })).pinned === true)
const theirs = await inbox('ALL', null, 'w_view')
ok('preferences are personal: another user sees none of them', theirs.rows.every((x) => !x.pinned && !x.muted && !x.favorite) && theirs.counts.FAVORITES === 0, theirs.rows)
ok('a user with support.view only (no reply) can keep their own preferences', (await pref(divya, { favorite: true }, 'w_view')).favorite === true)
ok('a user without support.view cannot', await refused('w_none', `select public.support_conversation_pref_set($1, null, null, true)`, [ravi], /support\.view/)
  && await refused('w_none', `select public.support_whatsapp_inbox()`, [], /support\.view/))
ok('company B cannot set preferences on company A conversations or see them', await refused('b_op', `select public.support_conversation_pref_set($1, null, null, true)`, [ravi], /not found/)
  && (await as('b_op')(`select public.support_whatsapp_inbox()`)).total === 0)
const anon = await request(null, `select public.support_whatsapp_inbox()`, [], 'anon')
ok('anon role refused', Boolean(anon.error), anon)

// ---------------------------------------------------------------------------
console.log('\nMessage info: receipts exactly as Meta reported them')
const info = (id, user = 'op') => as(user)(`select public.support_whatsapp_message_info($1)`, [id])
let mi = await info(OUT)
ok('sent and delivered receipts with their times; no Read receipt invented', mi.receipts.map((x) => x.status).join() === 'SENT,DELIVERED' && mi.receipts.every((x) => x.at)
  && mi.status === 'DELIVERED' && mi.accepted_by_meta === true, mi)
await status('wamid.OUT1', 'read')
mi = await info(OUT)
ok('Read only after Meta\'s read receipt', mi.status === 'READ' && mi.receipts.map((x) => x.status).join() === 'SENT,DELIVERED,READ', mi.receipts)
r = await rRow()
ok('list tick becomes Read only now', r.last_message.status === 'READ', r.last_message)
const inId = await val(`select id::text from public.support_whatsapp_messages where wa_message_id = 'wamid.A1'`)
ok('incoming message: received time, no receipts', (await info(inId)).receipts.length === 0 && (await info(inId)).direction === 'INBOUND')
ok('company B cannot read company A message info', (await as('b_op')(`select public.support_whatsapp_message_info($1)`, [OUT])) === null)
// Failed after acceptance: the error is shown with Meta's code.
await db.exec(`reset role;
  insert into public.support_messages (id, company_id, conversation_id, kind, direction, source, body, delivery_status, occurred_at)
  values ('e7e5d000-0000-4000-8000-00000000f003', rls_test.id('company_a'), '${meera}', 'MESSAGE', 'OUTBOUND', 'CHANNEL', 'Are you there?', 'QUEUED', now());
  insert into public.support_whatsapp_messages (id, company_id, message_id, conversation_id, channel_account_id, direction, wa_message_id, msg_type, status, wa_id)
  values ('e7e5d000-0000-4000-8000-00000000f004', rls_test.id('company_a'), 'e7e5d000-0000-4000-8000-00000000f003', '${meera}', '${ACCOUNT}', 'OUTBOUND', 'wamid.OUT2', 'text', 'PENDING', '919811112222');`)
await status('wamid.OUT2', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver is incapable of receiving this message' } }] })
mi = await info('e7e5d000-0000-4000-8000-00000000f004')
ok('failed receipt with Meta\'s code and reason', mi.status === 'FAILED' && mi.error_code === 131026 && mi.receipts[0].status === 'FAILED' && /incapable/.test(mi.receipts[0].error_detail), mi)

// ---------------------------------------------------------------------------
console.log('\nRead-only, history untouched')
ok('list and message info run in a read-only transaction (PostgREST runs STABLE functions read-only)',
  !(await request('op', `select public.support_whatsapp_inbox('ALL')`, [], 'authenticated', true)).error && !(await request('op', `select public.support_whatsapp_message_info($1)`, [OUT], 'authenticated', true)).error)
ok('no message, status or conversation was changed by reading', (await val(`select count(*)::int from public.support_whatsapp_messages`)) === 6
  && (await val(`select count(*)::int from public.support_whatsapp_statuses`)) === 4)
await ingest({ messaging_product: 'whatsapp', metadata: meta, contacts: [{ profile: { name: 'Ravi Kumar' }, wa_id: '919876543210' }],
  messages: [{ from: '919876543210', id: 'wamid.A1', timestamp: String(clock), type: 'text', text: { body: 'The basin arrived cracked' } }], statuses: [] })
ok('webhook processing unchanged: the same message delivered again is stored once', (await val(`select count(*)::int from public.support_whatsapp_messages where wa_message_id = 'wamid.A1'`)) === 1)
ok('ERP reset allowlist: 130 tables including the preferences (before conversations)', Number(await val(`select count(*) from private.erp_reset_tables()`)) === 130
  && Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_conversation_prefs'`)) < Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_conversations'`)))

// ---------------------------------------------------------------------------
console.log('\nRollback')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback drops the functions and the preferences only', (await val(`select to_regclass('public.support_conversation_prefs') is null`)) === true
  && (await val(`select count(*)::int from pg_proc where proname in ('support_whatsapp_inbox', 'support_conversation_pref_set', 'support_whatsapp_message_info')`)) === 0
  && (await val(`select count(*)::int from public.support_whatsapp_messages`)) === 6 && Number(await val(`select count(*) from private.erp_reset_tables()`)) === 129)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback', (await inbox()).total === 4)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
