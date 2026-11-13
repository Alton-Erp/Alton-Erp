// Meta WhatsApp Cloud API (migration 20261213090000) on top of the Support Centre, telephony and Gmail.
//
//   npm run test:db:whatsapp
//
// Local PGlite database only. Signed-in users call the app functions (RLS applies); the Edge Functions' part is
// played by the service role (webhook ingestion after the signature check, send results, test, templates, media).

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261213090000_whatsapp_cloud'
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
    return { value: Object.values(r.rows[0] ?? {})[0] }
  } catch (e) {
    try { await db.exec('rollback') } catch { /* ended */ }
    return { error: e.message }
  }
}
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${user}: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const op = as('op')
const svc = async (sql, params) => { const r = await request(null, sql, params, 'service_role'); if (r.error) throw new Error(`service: ${sql.slice(0, 90)}… → ${r.error}`); return r.value }
const verdict = (r, pattern) => {
  const good = Boolean(r.error) && (!pattern || pattern.test(r.error))
  if (!good) console.log(`      (got: ${r.error ?? 'not refused'})`)
  return good
}
const refused = async (user, sql, params, pattern) => verdict(await request(user, sql, params), pattern)
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('WA_AGENT_TEST', 'WhatsApp agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'WA_AGENT_TEST' and p.code in ('support.view', 'support.reply')`)
await addUser('w_agent', 'e7e5cf00-0000-4000-8000-0000000000a1', 'WA_AGENT_TEST')
await addUser('w_none', 'e7e5cf00-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER')
const agent = as('w_agent')
const state = () => val(`select setup_state from public.support_whatsapp_config`)
const health = (account) => val(`select status from public.support_channel_accounts where id = $1`, [account])
const IDS = { business_portfolio_id: '1234567890', waba_id: '102030405060', phone_number_id: '109876543210', display_phone_number: '+91 1800 123 4567', app_id: '555666777888', graph_api_version: 'v27.0' }
const check = (key, done = true, note = 'Meta case 123, 2026-11-13') => op(`select public.support_whatsapp_checklist_set($1, $2, $3)`, [key, done, note])
// Order-independent JSON (jsonb sorts object keys).
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x))
const key = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')
let ACCOUNT
const ingest = (value, field = 'messages', entry = IDS.waba_id, k = null) =>
  svc(`select public.support_whatsapp_ingest($1, $2, $3, $4::jsonb, $5)`, [ACCOUNT, entry, field, JSON.stringify(value), k ?? key({ entry, field, value })])
const meta = { display_phone_number: '9118001234567', phone_number_id: IDS.phone_number_id }
const textMsg = (id, from, body, ts = Math.floor(Date.now() / 1000) - 60, extra = {}) => ({ messaging_product: 'whatsapp', metadata: meta,
  contacts: [{ profile: { name: 'Ravi Kumar' }, wa_id: from }], messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body }, ...extra }] })

console.log('\nPreflight settings and setup state')
ok('only support.manage_integrations configures WhatsApp', await refused('w_agent', `select public.support_whatsapp_config_save('{}'::jsonb)`, [], /manage_integrations/))
ok('secrets are never accepted (Edge Function secrets only)', await refused('op', `select public.support_whatsapp_config_save('{"access_token":"EAAG..."}'::jsonb)`, [], /never saved/))
ok('the setup state cannot be set from the app', await refused('op', `select public.support_whatsapp_config_save('{"setup_state":"CONNECTED"}'::jsonb)`, [], /derived by the server/))
ok('ids must be Meta numeric ids', await refused('op', `select public.support_whatsapp_config_save('{"waba_id":"abc"}'::jsonb)`, [], /numeric id/))
ok('Graph API version must look like v27.0 (no version hard-coded)', await refused('op', `select public.support_whatsapp_config_save('{"graph_api_version":"latest"}'::jsonb)`, [], /v27\.0/))
const first = await op(`select public.support_whatsapp_config_save('{"waba_id":"102030405060"}'::jsonb)`)
ACCOUNT = first.config.channel_account_id
ok('partial settings: Not Configured, channel not connected, integration off', first.config.setup_state === 'NOT_CONFIGURED' && first.config.integration_enabled === false
  && first.account.status === 'NOT_CONNECTED', first.config.setup_state)
const saved = await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'BSP' })])
ok('all ids, number path unconfirmed: Number Eligibility Pending (Setup Required)', saved.config.setup_state === 'NUMBER_ELIGIBILITY_PENDING' && saved.account.status === 'SETUP_REQUIRED'
  && saved.config.display_phone_number === '+9118001234567', saved.config)
ok('switching on is refused before onboarding is confirmed', await refused('op', `select public.support_whatsapp_set_enabled(true)`, [], /cannot be switched on yet/))
ok('eligibility needs evidence', await refused('op', `select public.support_whatsapp_checklist_set('cloud_api_eligibility', true, '')`, [], /evidence/))
ok('unknown checklist item refused', await refused('op', `select public.support_whatsapp_checklist_set('anything', true, 'x')`, [], /Unknown checklist/))
await check('number_path_confirmed')
await check('cloud_api_eligibility')
ok('eligibility confirmed but no connection test yet: still pending', (await state()) === 'NUMBER_ELIGIBILITY_PENDING')
ok('the app cannot record a connection test', await refused('op', `select public.support_whatsapp_test_result($1, true, '{}'::jsonb, 'ok')`, [ACCOUNT]))
await svc(`select public.support_whatsapp_test_result($1, true, '{"platform_type":"CLOUD_API","status":"CONNECTED"}'::jsonb, 'Cloud API, CONNECTED')`, [ACCOUNT])
ok('number via a provider (current Zoho Bigin connection): Migration Required until migration is confirmed', (await state()) === 'MIGRATION_REQUIRED')
await check('migration_completed')
await check('previous_routing_retired')
ok('migration confirmed; token / webhook subscription not confirmed: Webhook Pending', (await state()) === 'WEBHOOK_PENDING')
await check('system_user_token')
await check('webhook_subscribed')
ok('everything confirmed but no verification challenge or signed event: Webhook Pending', (await state()) === 'WEBHOOK_PENDING')
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, number_path: 'COEXISTENCE' })])
ok('coexistence path: evidence reset, test needed again', (await state()) === 'NUMBER_ELIGIBILITY_PENDING')
await svc(`select public.support_whatsapp_test_result($1, true, '{"platform_type":"CLOUD_API","is_on_biz_app":true}'::jsonb, 'ok')`, [ACCOUNT])
ok('coexistence not approved yet: Coexistence Pending', (await state()) === 'COEXISTENCE_PENDING')
await check('coexistence_approved')
await svc(`select public.support_whatsapp_webhook_verified($1)`, [ACCOUNT])
ok('challenge verified, no signed event yet: Webhook Pending', (await state()) === 'WEBHOOK_PENDING')

console.log('\nWebhook ingestion')
ok('the app cannot ingest webhooks', await refused('op', `select public.support_whatsapp_ingest($1, 'x', 'messages', '{}'::jsonb, $2)`, [ACCOUNT, 'a'.repeat(64)]))
ok('another WhatsApp Business Account: rejected', (await ingest(textMsg('wamid.X1', '919876543210', 'hi'), 'messages', '999999999')).result === 'REJECTED')
ok('another phone number id: rejected', (await ingest({ ...textMsg('wamid.X2', '919876543210', 'hi'), metadata: { phone_number_id: '111111111' } })).result === 'REJECTED')
ok('rejected events are no evidence', (await state()) === 'WEBHOOK_PENDING')
const held = await ingest(textMsg('wamid.HELD1', '919876543210', 'Hello before go-live'))
ok('a correctly signed event for this account: Connected (ready); messages held while the integration is off', held.result === 'HELD' && (await state()) === 'CONNECTED'
  && (await health(ACCOUNT)) === 'SETUP_REQUIRED' && (await val(`select count(*)::int from public.support_whatsapp_messages`)) === 0, held)
ok('sending refused while switched off', await refused('w_agent', `select public.support_whatsapp_send_prepare('{"kind":"TEXT","idempotency_key":"k0000000000000000001","text":"x"}'::jsonb)`, [], /not switched on/))
ok('agents cannot switch WhatsApp on', await refused('w_agent', `select public.support_whatsapp_set_enabled(true)`, [], /manage_integrations/))
await op(`select public.support_customer_save(null, '{"display_name":"Ravi Kumar","phones":["+91 98765 43210"]}'::jsonb)`)
await op(`select public.support_whatsapp_set_enabled(true)`)
ok('switched on: channel Connected', (await health(ACCOUNT)) === 'CONNECTED')
ok('the app cannot read raw webhook payloads', await refused('op', `select count(*) from public.support_whatsapp_webhook_events`))
const replay = await op(`select public.support_whatsapp_event_replay($1)`, [held.event_id])
ok('held event replayed after go-live: processed once', replay.result === 'PROCESSED' && replay.messages === 1, replay)
ok('a second replay of a processed event is refused', await refused('op', `select public.support_whatsapp_event_replay($1)`, [held.event_id], /held or failed/))

const in1 = await ingest(textMsg('wamid.IN1', '919876543210', 'The basin arrived cracked'))
ok('inbound text processed', in1.result === 'PROCESSED' && in1.messages === 1, in1)
const conv = await val(`select conversation_id from public.support_whatsapp_messages where wa_message_id = 'wamid.IN1'`)
const crow = (await request('op', `select to_jsonb(c) from public.support_conversations c where id = $1`, [conv])).value
ok('same contact: same conversation (with the held message), WhatsApp channel, customer linked on its one match', crow.channel === 'WHATSAPP' && crow.customer_id !== null
  && crow.contact_phone === '+919876543210' && (await val(`select count(*)::int from public.support_whatsapp_messages where conversation_id = $1`, [conv])) === 2, crow)
ok('stored: provider message id, WABA, phone number id, timestamp, type', await (async () => {
  const r = (await request('op', `select to_jsonb(m) from public.support_whatsapp_messages m where wa_message_id = 'wamid.IN1'`)).value
  return r.waba_id === IDS.waba_id && r.phone_number_id === IDS.phone_number_id && r.msg_type === 'text' && r.wa_timestamp && r.status === 'RECEIVED'
})())
ok('duplicate delivery (same change): duplicate', (await ingest(textMsg('wamid.IN1', '919876543210', 'The basin arrived cracked'))).result === 'DUPLICATE')
const dup2 = await ingest({ ...textMsg('wamid.IN1', '919876543210', 'The basin arrived cracked'), statuses: [] })
ok('same message in another change: counted as duplicate, not stored twice', dup2.duplicates === 1 && (await val(`select count(*)::int from public.support_whatsapp_messages where wa_message_id = 'wamid.IN1'`)) === 1)
const media = await ingest({ messaging_product: 'whatsapp', metadata: meta, contacts: [{ profile: { name: 'Ravi Kumar' }, wa_id: '919876543210' }], messages: [
  { from: '919876543210', id: 'wamid.IMG1', timestamp: String(Math.floor(Date.now() / 1000) - 30), type: 'image', image: { id: '1234567890123', mime_type: 'image/jpeg', sha256: 'abc', caption: 'Crack photo' } },
  { from: '919876543210', id: 'wamid.DOC1', timestamp: String(Math.floor(Date.now() / 1000) - 20), type: 'document', document: { id: '2234567890123', mime_type: 'application/pdf', filename: 'invoice.pdf' } },
  { from: '919876543210', id: 'wamid.LOC1', timestamp: String(Math.floor(Date.now() / 1000) - 10), type: 'location', location: { latitude: 19.07, longitude: 72.87, name: 'Site', address: 'Mumbai' } },
  { from: '919876543210', id: 'wamid.INT1', timestamp: String(Math.floor(Date.now() / 1000) - 5), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes, replace it' } } },
  { from: '919876543210', id: 'wamid.AUD1', timestamp: String(Math.floor(Date.now() / 1000) - 4), type: 'audio', audio: { id: '3234567890123', mime_type: 'audio/ogg' } },
  { from: '919876543210', id: 'wamid.UNS1', timestamp: String(Math.floor(Date.now() / 1000) - 3), type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] }] })
ok('image, document, location, interactive, audio and unsupported messages processed; media queued (not downloaded in the webhook)', media.messages === 6 && media.media === 3, media)
const bodies = await val(`select jsonb_object_agg(wa_message_id, body) from public.support_whatsapp_messages w join public.support_messages m on m.id = w.message_id where wa_message_id like 'wamid.%'`)
ok('readable text for each type', bodies['wamid.IMG1'] === 'Crack photo' && bodies['wamid.DOC1'].includes('invoice.pdf') && bodies['wamid.LOC1'].includes('Mumbai')
  && bodies['wamid.INT1'] === 'Yes, replace it' && bodies['wamid.UNS1'].includes('Unsupported'), bodies)
ok('unsupported message keeps Meta\'s error', (await val(`select error_code from public.support_whatsapp_messages where wa_message_id = 'wamid.UNS1'`)) === 131051)
const due = await svc(`select public.support_whatsapp_media_due(10)`)
ok('media queue lists pending downloads', due.length === 3 && due.every((d) => d.media_id), due)
const img = due.find((d) => d.media_id === '1234567890123')
const companyA = await val(`select company_id::text from public.support_whatsapp_config`)
ok('the app cannot record media', await refused('op', `select public.support_whatsapp_media_result($1, 'STORED', 'x', 'image/jpeg', 10, null)`, [img.id]))
ok('stored media must be under its message folder', (await request(null, `select public.support_whatsapp_media_result($1, 'STORED', 'elsewhere/x.jpg', 'image/jpeg', 10, null)`, [img.id], 'service_role')).error?.includes('Invalid media path'))
await svc(`select public.support_whatsapp_media_result($1, 'STORED', $2, 'image/jpeg', 2048, null)`, [img.id, `${companyA}/whatsapp/${img.id}/photo.jpg`])
await svc(`select public.support_whatsapp_media_result($1, 'EXPIRED', null, null, null, 'Media id expired')`, [due.find((d) => d.media_id === '3234567890123').id])
ok('stored media: attachment linked; expired media recorded; queue shrinks', (await val(`select count(*)::int from public.support_attachments where storage_path like $1`, [`${companyA}/whatsapp/%`])) === 1
  && (await svc(`select public.support_whatsapp_media_due(10)`)).length === 1)
const bsuid = await ingest({ messaging_product: 'whatsapp', metadata: meta, contacts: [{ profile: { name: 'Anon' }, user_id: 'IN.user.abc' }],
  messages: [{ from_user_id: 'IN.user.abc', id: 'wamid.BS1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello' } }] })
ok('user with a username only (BSUID, no phone): own conversation keyed by the user id', bsuid.messages === 1
  && (await val(`select count(*)::int from public.support_whatsapp_threads where user_id = 'IN.user.abc' and wa_id is null`)) === 1)

console.log('\nSending, window and templates')
await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('w_agent'), 'display_name', 'WA Agent'))`)
const K = (n) => `k${String(n).padStart(20, '0')}`
const prep = (p, user = 'w_agent') => request(user, `select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify(p)])
ok('a user without support.reply cannot send', (await prep({ kind: 'TEXT', idempotency_key: K(1), conversation_id: conv, text: 'x' }, 'w_none')).error?.includes('support.reply'))
const t1 = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: K(2), conversation_id: conv, text: 'We are sending a replacement.',
  reply_to: await val(`select id from public.support_whatsapp_messages where wa_message_id = 'wamid.IN1'`) })])
ok('text inside the window: prepared with recipient, phone number id, configured API version and reply context', t1.to === '919876543210' && t1.phone_number_id === IDS.phone_number_id
  && t1.graph_api_version === 'v27.0' && t1.context_wa_message_id === 'wamid.IN1', t1)
ok('recorded as Pending (queued), never Sent before Meta reports it', (await val(`select status from public.support_whatsapp_messages where id = $1`, [t1.id])) === 'PENDING'
  && (await val(`select delivery_status from public.support_messages where id = $1`, [t1.message_id])) === 'QUEUED')
ok('repeated request key: the same message', (await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: K(2), conversation_id: conv, text: 'x' })])).existing === true)
ok('the app cannot record send results', await refused('w_agent', `select public.support_whatsapp_send_result($1, 'ACCEPTED', 'wamid.OUT1', null, null, null, null, 200)`, [t1.id]))
// A status that arrives before Meta's API answer is applied when the answer arrives.
await ingest({ messaging_product: 'whatsapp', metadata: meta, statuses: [{ id: 'wamid.OUT1', status: 'sent', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919876543210' }] })
await svc(`select public.support_whatsapp_send_result($1, 'ACCEPTED', 'wamid.OUT1', '919876543210', null, null, null, 200)`, [t1.id])
ok('accepted + early "sent" status: Sent (from the webhook, not from the API answer)', (await val(`select status from public.support_whatsapp_messages where id = $1`, [t1.id])) === 'SENT')
const st = (id, status, extra = {}) => ingest({ messaging_product: 'whatsapp', metadata: meta, statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '919876543210', ...extra }] })
await st('wamid.OUT1', 'delivered')
await st('wamid.OUT1', 'read')
await st('wamid.OUT1', 'delivered', { conversation: { id: 'c2' } })
ok('statuses only move forward: read stays read after a late delivered', (await val(`select status from public.support_whatsapp_messages where id = $1`, [t1.id])) === 'READ'
  && (await val(`select delivery_status from public.support_messages where id = $1`, [t1.message_id])) === 'READ')
ok('last successful outbound recorded', (await val(`select last_outbound_success_at is not null from public.support_whatsapp_config`)) === true)
const t2 = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: K(3), conversation_id: conv, text: 'Second' })])
await svc(`select public.support_whatsapp_send_result($1, 'ACCEPTED', 'wamid.OUT2', null, null, null, null, 200)`, [t2.id])
await st('wamid.OUT2', 'failed', { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'Receiver is incapable of receiving this message' } }] })
const f2 = (await request('op', `select jsonb_build_object('s', w.status, 'c', w.error_code, 'd', m.delivery_status, 'e', m.delivery_error) from public.support_whatsapp_messages w join public.support_messages m on m.id = w.message_id where w.id = $1`, [t2.id])).value
ok('failed status with Meta\'s error details', f2.s === 'FAILED' && f2.c === 131026 && f2.d === 'FAILED' && f2.e.includes('Message undeliverable'), f2)
await db.exec(`reset role; update public.support_whatsapp_threads set last_inbound_at = now() - interval '25 hours' where conversation_id = '${conv}'`)
ok('window closed (25 hours since the customer\'s last message): free-form text refused', (await prep({ kind: 'TEXT', idempotency_key: K(4), conversation_id: conv, text: 'Hello?' })).error?.includes('24-hour customer service window is closed'))
ok('window closed: media refused too', (await prep({ kind: 'MEDIA', idempotency_key: K(5), conversation_id: conv, path: `${companyA}/outbox/${K(5)}/a.pdf`, file_name: 'a.pdf', size_bytes: 10 })).error?.includes('window is closed'))
await svc(`select public.support_whatsapp_templates_sync($1, $2::jsonb, true)`, [ACCOUNT, JSON.stringify([
  { id: '9001', name: 'order_update', language: 'en', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} is on its way.' }] },
  { id: '9002', name: 'promo_offer', language: 'en', category: 'MARKETING', status: 'PENDING', components: [{ type: 'BODY', text: 'Offer' }] },
  { id: '9003', name: 'photo_header', language: 'en', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'See photo' }] },
  { id: '9004', name: 'named_vars', language: 'en_US', category: 'UTILITY', status: 'APPROVED', parameter_format: 'NAMED', components: [{ type: 'HEADER', format: 'TEXT', text: 'Ticket {{ticket}}' }, { type: 'BODY', text: 'Dear {{name}}' }] }])])
const tid = async (name) => val(`select id from public.support_whatsapp_templates where name = $1`, [name])
ok('agents see approved templates only', (await agent(`select public.support_whatsapp_templates_list()`)).map((t) => t.name).sort().join() === 'named_vars,order_update,photo_header')
ok('a template not approved by Meta is refused', (await prep({ kind: 'TEMPLATE', idempotency_key: K(6), conversation_id: conv, template_id: await tid('promo_offer'), parameters: {} })).error?.includes('approved by Meta'))
ok('every placeholder needs a value', (await prep({ kind: 'TEMPLATE', idempotency_key: K(7), conversation_id: conv, template_id: await tid('order_update'), parameters: { 1: 'Ravi' } })).error?.includes('{{2}}'))
ok('values cannot contain line breaks', (await prep({ kind: 'TEMPLATE', idempotency_key: K(8), conversation_id: conv, template_id: await tid('order_update'), parameters: { 1: 'Ravi', 2: 'A\nB' } })).error?.includes('line breaks'))
ok('values for unknown placeholders refused', (await prep({ kind: 'TEMPLATE', idempotency_key: K(9), conversation_id: conv, template_id: await tid('order_update'), parameters: { 1: 'a', 2: 'b', 3: 'c' } })).error?.includes('does not have'))
ok('templates needing a media header are refused (not sent half-filled)', (await prep({ kind: 'TEMPLATE', idempotency_key: K(10), conversation_id: conv, template_id: await tid('photo_header'), parameters: {} })).error?.includes('media header'))
const tp = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEMPLATE', idempotency_key: K(11), conversation_id: conv, template_id: await tid('order_update'), parameters: { 1: 'Ravi', 2: 'SO-000011' } })])
ok('approved template allowed outside the window, with positional body parameters in order', tp.template.name === 'order_update' && tp.template.language === 'en'
  && canon(tp.template.components) === canon([{ type: 'body', parameters: [{ type: 'text', text: 'Ravi' }, { type: 'text', text: 'SO-000011' }] }]), tp.template)
ok('timeline shows the rendered template text', (await val(`select body from public.support_messages where id = $1`, [tp.message_id])) === '[Template order_update] Hi Ravi, your order SO-000011 is on its way.')
const named = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEMPLATE', idempotency_key: K(12), conversation_id: conv, template_id: await tid('named_vars'), parameters: { ticket: 'ALT-1', name: 'Ravi' } })])
ok('named parameters (header and body)', canon(named.template.components) === canon([{ type: 'header', parameters: [{ type: 'text', parameter_name: 'ticket', text: 'ALT-1' }] },
  { type: 'body', parameters: [{ type: 'text', parameter_name: 'name', text: 'Ravi' }] }]), named.template.components)
const fresh = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEMPLATE', idempotency_key: K(13), to: '+91 99887 76655', template_id: await tid('order_update'), parameters: { 1: 'A', 2: 'B' } })])
ok('business-initiated template to a new number: new conversation without an open window', fresh.to === '919988776655'
  && (await val(`select last_inbound_at from public.support_whatsapp_threads where conversation_id = $1`, [fresh.conversation_id])) === null)
ok('free-form text to that new number is refused (window never opened)', (await prep({ kind: 'TEXT', idempotency_key: K(14), conversation_id: fresh.conversation_id, text: 'hi' })).error?.includes('window is closed'))
await ingest(textMsg('wamid.IN9', '919876543210', 'Thanks'))
ok('a new customer message reopens the window', !(await prep({ kind: 'TEXT', idempotency_key: K(15), conversation_id: conv, text: 'You are welcome' })).error)
ok('media: unsupported type refused', (await prep({ kind: 'MEDIA', idempotency_key: K(16), conversation_id: conv, path: `${companyA}/outbox/${K(16)}/run.exe`, file_name: 'run.exe', size_bytes: 10 })).error?.includes('accepts images'))
ok('media: images over 5 MB refused', (await prep({ kind: 'MEDIA', idempotency_key: K(17), conversation_id: conv, path: `${companyA}/outbox/${K(17)}/a.jpg`, file_name: 'a.jpg', size_bytes: 6 * 1048576 })).error?.includes('5 MB'))
ok('media: file not uploaded for this message refused', (await prep({ kind: 'MEDIA', idempotency_key: K(18), conversation_id: conv, path: `${companyA}/outbox/${K(2)}/a.pdf`, file_name: 'a.pdf', size_bytes: 10 })).error?.includes('Upload'))
const md = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'MEDIA', idempotency_key: K(19), conversation_id: conv, path: `${companyA}/outbox/${K(19)}/quote.pdf`, file_name: 'quote.pdf', content_type: 'application/pdf', size_bytes: 1000, caption: 'Quote' })])
ok('document inside the window: prepared with its stored file', md.media.kind === 'document' && md.media.path.endsWith('quote.pdf'))
const t3 = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: K(20), conversation_id: conv, text: 'x' })])
await svc(`select public.support_whatsapp_send_result($1, 'FAILED', null, null, 131047, 'Re-engagement message', 'More than 24 hours have passed since the recipient last replied', 400)`, [t3.id])
ok('Meta refuses (131047 re-engagement): Failed with the reason', (await val(`select delivery_error from public.support_messages where id = $1`, [t3.message_id])).includes('131047'))
const t4 = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: K(21), conversation_id: conv, text: 'y' })])
await svc(`select public.support_whatsapp_send_result($1, 'UNCONFIRMED', null, null, null, null, 'timeout', null)`, [t4.id])
ok('timeout / 5xx: stays Pending (unconfirmed), never Sent', (await val(`select status from public.support_whatsapp_messages where id = $1`, [t4.id])) === 'PENDING')
ok('generic reply queue refuses WhatsApp', await refused('w_agent', `select public.support_message_add($1, '{"mode":"REPLY","body":"hi"}'::jsonb)`, [conv], /WhatsApp Cloud API panel/))
const t5 = await agent(`select public.support_whatsapp_send_prepare($1::jsonb)`, [JSON.stringify({ kind: 'TEXT', idempotency_key: K(22), conversation_id: conv, text: 'z' })])
await svc(`select public.support_whatsapp_send_result($1, 'FAILED', null, null, 190, 'Error validating access token', 'Session has expired', 401)`, [t5.id])
ok('expired access token (190): Error state, integration switched off, channel Error, sending blocked', (await state()) === 'ERROR'
  && (await val(`select integration_enabled from public.support_whatsapp_config`)) === false && (await health(ACCOUNT)) === 'ERROR'
  && (await prep({ kind: 'TEXT', idempotency_key: K(23), conversation_id: conv, text: 'z' })).error?.includes('not switched on'))
await svc(`select public.support_whatsapp_test_result($1, true, '{"platform_type":"CLOUD_API"}'::jsonb, 'ok')`, [ACCOUNT])
ok('after a passing test with a new token: Connected (ready); an administrator switches it on again', (await state()) === 'CONNECTED' && (await val(`select integration_enabled from public.support_whatsapp_config`)) === false)
await op(`select public.support_whatsapp_set_enabled(true)`)

console.log('\nReading, templates, privacy')
const th = await agent(`select public.support_whatsapp_thread($1)`, [conv])
ok('thread: contact, window, statuses, media states, attachment, errors', th.window_open === true && th.contact.wa_id === '919876543210' && th.can_send === true
  && th.messages.some((m) => m.status === 'READ') && th.messages.some((m) => m.status === 'FAILED' && m.error_code === 131026)
  && th.messages.some((m) => m.attachment?.file_name) && th.messages.some((m) => m.media_state === 'EXPIRED'), th.messages.map((m) => [m.type, m.status, m.media_state]))
ok('no WhatsApp access without support.view', await refused('w_none', `select public.support_whatsapp_thread($1)`, [conv]))
await ingest({ message_template_id: '9002', message_template_name: 'promo_offer', message_template_language: 'en', event: 'APPROVED' }, 'message_template_status_update')
ok('template status webhook updates the catalogue', (await val(`select status from public.support_whatsapp_templates where meta_template_id = '9002'`)) === 'APPROVED')
await svc(`select public.support_whatsapp_templates_sync($1, $2::jsonb, true)`, [ACCOUNT, JSON.stringify([{ id: '9001', name: 'order_update', language: 'en', status: 'APPROVED', components: [] }])])
ok('templates no longer at Meta are marked removed (cannot be sent)', (await val(`select status from public.support_whatsapp_templates where meta_template_id = '9004'`)) === 'REMOVED')
await db.exec(`reset role; update public.support_whatsapp_webhook_events set received_at = now() - interval '40 days' where result = 'PROCESSED'`)
ok('raw payloads purged after 30 days (metadata kept)', (await svc(`select public.support_whatsapp_purge_payloads(30)`)) > 0
  && (await val(`select count(*)::int from public.support_whatsapp_webhook_events where payload is null`)) > 0)
const cfgView = await op(`select public.support_whatsapp_config_get()`)
ok('settings view: checklist with who / when, events without message content', Boolean(cfgView.checklist_items.find((i) => i.key === 'cloud_api_eligibility').by) && Boolean(cfgView.checklist_items.find((i) => i.key === 'cloud_api_eligibility').at)
  && !JSON.stringify(cfgView.events).includes('The basin arrived cracked'))
await op(`select public.support_whatsapp_config_save($1::jsonb)`, [JSON.stringify({ ...IDS, phone_number_id: '109876543299', number_path: 'COEXISTENCE' })])
ok('changing the phone number id switches the integration off and needs new evidence', (await val(`select integration_enabled from public.support_whatsapp_config`)) === false
  && (await state()) === 'NUMBER_ELIGIBILITY_PENDING')

console.log('\nReset allowlist and rollback')
ok('reset allowlist: the 6 WhatsApp tables', (await val(`select count(*)::int from private.erp_reset_tables() where table_name like 'support_whatsapp%'`)) === 6
  && (await val(`select count(*)::int from private.erp_reset_tables()`)) === 119)
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const leftovers = await val(`select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'private') and p.proname like 'support_whatsapp%'`)
const tablesLeft = await val(`select count(*)::int from pg_class where relname like 'support_whatsapp%' and relkind = 'r'`)
ok('rollback: no WhatsApp function or table remains', leftovers === 0 && tablesLeft === 0, { leftovers, tablesLeft })
const after = await defs()
ok('rollback: support_message_add and the reset allowlist are byte-identical to before', after.support_message_add === before.support_message_add && after.erp_reset_tables === before.erp_reset_tables)
ok('rollback: WhatsApp account shown as not connected; timeline messages kept', (await health(ACCOUNT)) === 'NOT_CONNECTED'
  && (await val(`select count(*)::int from public.support_messages m join public.support_conversations c on c.id = m.conversation_id where c.channel = 'WHATSAPP'`)) > 5)
await db.exec(mig)
ok('roll forward: the migration applies again', (await val(`select count(*)::int from private.erp_reset_tables()`)) === 119)

console.log(`\n${failed === 0 ? '✓' : '✗'} whatsapp cloud: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
