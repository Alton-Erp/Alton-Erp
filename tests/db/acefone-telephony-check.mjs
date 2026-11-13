// Acefone telephony (migration 20261211090000) on top of the Support Centre.
//
//   npm run test:db:acefone
//
// Local PGlite database only. Signed-in users call the app functions (RLS applies); the Edge Functions' part is
// played by the service role (support_call_request_result, support_acefone_ingest, CDR and recording functions).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261211090000_acefone_telephony'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')
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
const refused = async (user, sql, params, pattern) => { const r = await request(user, sql, params); return Boolean(r.error) && (!pattern || pattern.test(r.error)) }
const refusedSvc = async (sql, params) => Boolean((await request('op', sql, params)).error)
const A = await val(`select rls_test.id('company_a')::text`)
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('PHONE_AGENT_TEST', 'Phone agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'PHONE_AGENT_TEST' and p.code in ('support.view', 'support.reply')`)
await addUser('ph_agent', 'e7e5cd00-0000-4000-8000-0000000000a1', 'PHONE_AGENT_TEST')
await addUser('ph_none', 'e7e5cd00-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER')
const agent = as('ph_agent')
const ingest = (event, payload, key) => svc(`select public.support_acefone_ingest($1, $2, $3::jsonb, $4, '1.2.3.4')`, [ACCOUNT, event, JSON.stringify(payload), key ?? `k-${event}-${JSON.stringify(payload)}`])
let ACCOUNT

console.log('\nNumbers')
const e164 = await val(`select jsonb_build_array(private.support_e164('98765 43210'), private.support_e164('09876543210'), private.support_e164('+91-98765-43210'),
  private.support_e164('919876543210'), private.support_e164('1800 123 4567'), private.support_e164('+44 20 7946 0958'), private.support_e164('12'), private.support_acefone_number('+919876543210'))`)
ok('E.164: Indian mobiles, 0 and +91 prefixes, toll-free, foreign; Acefone gets 10 digits', JSON.stringify(e164) ===
  JSON.stringify(['+919876543210', '+919876543210', '+919876543210', '+919876543210', '+9118001234567', '+442079460958', null, '9876543210']), e164)

console.log('\nSettings')
ok('only support.manage_integrations saves phone settings', await refused('ph_agent', `select public.support_phone_config_save('{}'::jsonb)`, [], /manage_integrations/))
ok('secret values are never accepted', await refused('op', `select public.support_phone_config_save('{"api_token":"abc"}'::jsonb)`, [], /never saved/))
ok('only the documented Acefone hosts', await refused('op', `select public.support_phone_config_save('{"api_base_url":"https://169.254.169.254"}'::jsonb)`, [], /documented Acefone API hosts/))
const saved = await op(`select public.support_phone_config_save('{"toll_free_number":"1800 123 4567","click_to_call_mode":"AGENT","default_caller_id":"08069400000"}'::jsonb)`)
ACCOUNT = saved.config.channel_account_id
ok('saved: phone channel account Setup Required (not Connected)', saved.account.status === 'SETUP_REQUIRED' && saved.config.api_token_secret === 'ACEFONE_API_TOKEN', saved.account)
ok('secret names must be ACEFONE_* (a function can never be pointed at another secret)', Boolean((await (async () => { await db.exec('reset role'); try { await db.query(`update public.support_phone_config set api_token_secret = 'SUPABASE_SERVICE_ROLE_KEY'`); return null } catch (e) { return e.message } })())))
const opAgent = await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('op'), 'display_name', 'Operator'))`)
const phAgent = await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('ph_agent'), 'display_name', 'Phone Agent'))`)
const opLine = await op(`select public.support_phone_agent_save(null, jsonb_build_object('agent_id', $1::text, 'agent_number', '050 123 4567', 'label', 'Desk'))`, [opAgent])
const phLine = await op(`select public.support_phone_agent_save(null, jsonb_build_object('agent_id', $1::text, 'agent_number', '0607654321'))`, [phAgent])
ok('agent lines mapped; numbers unique', Boolean(opLine && phLine) && await refused('op', `select public.support_phone_agent_save(null, jsonb_build_object('agent_id', $1::text, 'agent_number', '0501234567'))`, [phAgent], /already mapped/))
const lines = await agent(`select public.support_call_lines()`)
ok('an agent sees only their own line', lines.length === 1 && lines[0].id === phLine && lines[0].mine, lines)
ok('the service-role functions are closed to users', await refusedSvc(`select public.support_acefone_ingest($1, 'received', '{}'::jsonb, 'x')`, [ACCOUNT])
  && await refusedSvc(`select public.support_call_request_result(gen_random_uuid(), true, 'x', 'x', 200)`, []) && await refusedSvc(`select public.support_phone_runtime($1)`, [ACCOUNT]))

console.log('\nOutgoing calls')
const cust = await op(`select public.support_customer_save(null, jsonb_build_object('display_name', 'Ravi Kumar', 'phones', jsonb_build_array('+91 98765 43210')))`)
const ticket = await op(`select public.support_ticket_create(jsonb_build_object('customer_id', $1::text, 'subject', 'Cracked basin'))`, [cust.id])
const key1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const prepare = (user, p) => as(user)(`select public.support_call_prepare($1::jsonb)`, [JSON.stringify(p)])
ok('a number that is not the customer’s is refused', await refused('ph_agent', `select public.support_call_prepare($1::jsonb)`,
  [JSON.stringify({ customer_id: cust.id, number: '9000000000', line_id: phLine, idempotency_key: key1 })], /does not belong/))
ok('another agent’s line needs support.assign', await refused('ph_agent', `select public.support_call_prepare($1::jsonb)`,
  [JSON.stringify({ customer_id: cust.id, number: '09876543210', line_id: opLine, idempotency_key: key1 })], /own line/))
ok('no support.reply, no call', await refused('ph_none', `select public.support_call_prepare($1::jsonb)`, [JSON.stringify({ customer_id: cust.id, number: '9876543210', line_id: phLine, idempotency_key: key1 })], /support\.reply/))
const p1 = await prepare('ph_agent', { ticket_id: ticket.id, number: '09876543210', line_id: phLine, idempotency_key: key1 })
ok('prepared: INITIATED / PENDING; request built for Acefone (10-digit number, agent line, our identifier)', p1.status === 'INITIATED' && p1.request_state === 'PENDING'
  && p1.destination_number === '9876543210' && p1.agent_number === '0607654321' && p1.mode === 'AGENT' && /^[0-9a-f]{32}$/.test(p1.custom_identifier.erpcall), p1)
const again = await prepare('ph_agent', { ticket_id: ticket.id, number: '09876543210', line_id: phLine, idempotency_key: key1 })
const quick = await prepare('ph_agent', { ticket_id: ticket.id, number: '+919876543210', line_id: phLine, idempotency_key: 'aaaaaaaa-0000-4000-8000-000000000002' })
ok('repeated clicks (same key, or a new key within 2 minutes) return the same call', again.duplicate && quick.duplicate && again.call_id === p1.call_id && quick.call_id === p1.call_id)
const c1 = await val(`select to_jsonb(c) from public.support_calls c where id = $1`, [p1.call_id])
ok('call linked to customer, ticket and a phone conversation; agent and caller ID recorded', c1.customer_id === cust.id && c1.ticket_id === ticket.id && c1.conversation_id
  && c1.agent_id === phAgent && c1.caller_id_used === '08069400000', c1)
const accepted = await svc(`select public.support_call_request_result($1, true, 'C2C2408011234', 'Call originated successfully.', 200)`, [p1.call_id])
ok('accepted by Acefone: ref_id stored, still INITIATED (never Connected on acceptance)', accepted.status === 'INITIATED' && accepted.request_state === 'ACCEPTED' && accepted.ref_id === 'C2C2408011234')
await ingest('customer_answered', { ref_id: 'C2C2408011234', call_id: '1714657799.11', direction: 'click_to_call', start_stamp: '2026-11-13 10:00:00' })
ok('Connected only after the provider event (customer answered, Agent mode)', await val(`select status from public.support_calls where id = $1`, [p1.call_id]) === 'CONNECTED')
const hang = { call_id: '1714657799.11', ref_id: 'C2C2408011234', direction: 'outbound', start_stamp: '2026-11-13 10:00:00', answer_stamp: '2026-11-13 10:00:12',
  end_stamp: '2026-11-13 10:03:12', billsec: '180', duration: '192', hangup_cause: 'NORMAL_CLEARING', answered_agent_number: '0607654321',
  __recording_url: 'https://customer.servetel.in/file/recording?callId=1714657799.11&type=rec&token=rec-token' }
const h1 = await ingest('hangup', hang, 'wh:hangup:1')
const done = await val(`select to_jsonb(c) - 'provider_recording_ref' || jsonb_build_object('rec', provider_recording_ref is not null) from public.support_calls c where id = $1`, [p1.call_id])
ok('answered hangup: Completed with talk, ring and total durations, times and cause', h1.result === 'PROCESSED' && done.status === 'COMPLETED' && done.talk_seconds === 180
  && done.duration_seconds === 192 && done.ring_seconds === 12 && done.hangup_cause === 'NORMAL_CLEARING' && done.rec, done)
const msg = await val(`select to_jsonb(m) from public.support_messages m where id = $1`, [done.message_id])
ok('the call is one CALL message on the conversation (outbound, answered, 180 s)', msg?.kind === 'CALL' && msg.direction === 'OUTBOUND' && msg.call_status === 'ANSWERED' && msg.call_duration_seconds === 180, msg)
ok('first response recorded on the ticket', await val(`select first_response_at is not null from public.support_tickets where id = $1`, [ticket.id]))
ok('duplicate webhook: no change', (await ingest('hangup', hang, 'wh:hangup:1')).result === 'DUPLICATE'
  && await val(`select count(*)::int from public.support_messages where conversation_id = $1 and kind = 'CALL'`, [done.conversation_id]) === 1)
await ingest('agent_answered', { ref_id: 'C2C2408011234', call_id: '1714657799.11' }, 'wh:late-answer')
ok('late / out-of-order event never moves a finished call back', await val(`select status from public.support_calls where id = $1`, [p1.call_id]) === 'COMPLETED')
ok('each transition recorded once', await val(`select count(*)::int from public.support_call_events where call_id = $1`, [p1.call_id]) === 4)
ok('the provider recording link cannot be read by app users', await refused('op', `select provider_recording_ref from public.support_calls limit 1`, [], /permission denied/)
  && !JSON.stringify(await op(`select public.support_call_detail($1)`, [p1.call_id])).includes('rec-token'))
ok('the logged webhook keeps no recording token', !JSON.stringify(await val(`select jsonb_agg(details) from public.support_integration_events`)).includes('rec-token'))
// Rejected and timed-out requests.
const p2 = await prepare('op', { customer_id: cust.id, number: '9876543210', line_id: opLine, idempotency_key: 'aaaaaaaa-0000-4000-8000-000000000003' })
const rej = await svc(`select public.support_call_request_result($1, false, null, 'Agent is Blocked', 400)`, [p2.call_id])
ok('failed API request: Failed with Acefone’s message', rej.status === 'FAILED' && rej.request_state === 'REJECTED'
  && await val(`select request_message from public.support_calls where id = $1`, [p2.call_id]) === 'Agent is Blocked')
const p3 = await prepare('op', { customer_id: cust.id, number: '9876543210', line_id: opLine, idempotency_key: 'aaaaaaaa-0000-4000-8000-000000000004' })
const tmo = await svc(`select public.support_call_request_result($1, false, null, 'Acefone did not answer within 15 seconds', null)`, [p3.call_id])
ok('no answer from Acefone: left Initiated (the call may still happen), request marked as error', tmo.status === 'INITIATED' && tmo.request_state === 'ERROR')
await ingest('customer_missed', { custom_identifier: '', erpcall: p3.custom_identifier.erpcall, call_id: '1714657800.22', billsec: '0' }, 'wh:miss-p3')
ok('…and our identifier in the webhook still settles it (customer missed → Missed)', await val(`select status from public.support_calls where id = $1`, [p3.call_id]) === 'MISSED')

console.log('\nIncoming calls')
await ingest('received', { call_id: '1714657900.33', uuid: 'u-33', caller_id_number: '09000011111', call_to_number: '18001234567', start_stamp: '2026-11-13 11:00:00' }, 'wh:in:1')
const inbound = await val(`select to_jsonb(c) from public.support_calls c where provider_call_id = '1714657900.33'`)
ok('unknown caller: call Ringing, number in E.164, new phone conversation, no customer', inbound.status === 'RINGING' && inbound.direction === 'INBOUND'
  && inbound.customer_number_e164 === '+919000011111' && inbound.conversation_id && inbound.customer_id === null, inbound)
const live = await agent(`select public.support_live_calls()`)
ok('incoming-call panel: the ringing call with no customer match', live.length === 1 && live[0].id === inbound.id && live[0].customer === null && live[0].candidates === 0, live)
ok('the panel needs support.reply', await refused('ph_none', `select public.support_live_calls()`, [], /support\.reply/))
await ingest('agent_answered', { call_id: '1714657900.33', uuid: 'u-33', answered_agent_number: '0501234567' }, 'wh:in:2')
await ingest('hangup', { call_id: '1714657900.33', uuid: 'u-33', billsec: '0', duration: '25', end_stamp: '2026-11-13 11:00:25' }, 'wh:in:3')
const inb2 = await val(`select to_jsonb(c) - 'provider_recording_ref' from public.support_calls c where id = $1`, [inbound.id])
ok('agent mapped from the answering number', inb2.agent_id === opAgent, inb2)
ok('a hangup after the agent answered is Completed, even with 0 s billed', inb2.status === 'COMPLETED', inb2.status)
await ingest('received', { call_id: '1714658000.44', caller_id_number: '+91 98765 43210', start_stamp: '2026-11-13 12:00:00' }, 'wh:in2:1')
await ingest('hangup_missed', { call_id: '1714658000.44', billsec: '0', duration: '30', end_stamp: '2026-11-13 12:00:30' }, 'wh:in2:2')
const missed = await val(`select to_jsonb(c) from public.support_calls c where provider_call_id = '1714658000.44'`)
ok('known caller matched to the customer; missed call → Missed', missed.customer_id === cust.id && missed.status === 'MISSED', missed)
ok('missed call: MISSED call message, conversation unread and open', await val(`select (m.call_status = 'MISSED' and s.unread_count >= 1 and s.status = 'OPEN')
  from public.support_calls c join public.support_messages m on m.id = c.message_id join public.support_conversations s on s.id = c.conversation_id where c.id = $1`, [missed.id]))
ok('unknown events are ignored, not errors', (await ingest('dtmf_unknown', { call_id: 'x' }, 'wh:odd')).result === 'IGNORED')

console.log('\nDisconnect, replay and call records')
await op(`select public.support_phone_disconnect('Testing')`)
const blocked = await ingest('received', { call_id: '1714658100.55', caller_id_number: '9000022222' }, 'wh:dis:1')
ok('disconnected: events logged as rejected, nothing processed', blocked.result === 'REJECTED'
  && await val(`select count(*)::int from public.support_calls where provider_call_id = '1714658100.55'`) === 0)
ok('disconnected: no calls can be placed', await refused('op', `select public.support_call_prepare($1::jsonb)`,
  [JSON.stringify({ customer_id: cust.id, number: '9876543210', line_id: opLine, idempotency_key: 'aaaaaaaa-0000-4000-8000-000000000005' })], /disconnected/))
const evId = await val(`select id::text from public.support_integration_events where event_key = 'wh:dis:1'`)
ok('replay refused while disconnected and for non-administrators', await refused('op', `select public.support_acefone_replay($1)`, [evId], /Reconnect/)
  && await refused('ph_agent', `select public.support_acefone_replay($1)`, [evId], /manage_integrations/))
await op(`select public.support_phone_config_save('{"toll_free_number":"1800 123 4567","click_to_call_mode":"AGENT","default_caller_id":"08069400000"}'::jsonb)`)
const rep1 = await op(`select public.support_acefone_replay($1)`, [evId])
const rep2 = await op(`select public.support_acefone_replay($1)`, [evId])
ok('reconnected: an administrator replays the event; replaying again changes nothing', rep1.result === 'PROCESSED' && rep1.changed === true && rep2.changed === false
  && await val(`select replay_count from public.support_integration_events where id = $1`, [evId]) === 2)
ok('reconnecting returns the account to Setup Required until the next successful test', await val(`select status from public.support_channel_accounts where id = $1`, [ACCOUNT]) === 'SETUP_REQUIRED')
const cdr = await svc(`select public.support_acefone_cdr_upsert($1, $2::jsonb, true, 'ok')`, [ACCOUNT, JSON.stringify([
  { call_id: '1714657799.11', direction: 'Outbound', status: 'answered', answered_seconds: 180, call_duration: 192, client_number: '9876543210' },
  { call_id: '1714659000.66', uuid: 'u-66', direction: 'Inbound', status: 'missed', answered_seconds: 0, call_duration: 20, client_number: '9000033333', did_number: '18001234567',
    date: '2026-11-13', time: '13:00:00', agent_ring_time: 20, recording_url: 'https://customer.servetel.in/file/recording?callId=66&token=rec-token' }])])
ok('call records: unseen missed call created; known completed call untouched', cdr.records === 2
  && await val(`select status from public.support_calls where provider_call_id = '1714659000.66'`) === 'MISSED'
  && await val(`select status from public.support_calls where id = $1`, [p1.call_id]) === 'COMPLETED')
ok('last sync recorded', await val(`select last_sync_at is not null and last_sync_status = 'ok' from public.support_phone_config where company_id = $1`, [A]))

console.log('\nRecordings')
ok('recording retrieval off: nothing to fetch', (await svc(`select public.support_recordings_due($1)`, [ACCOUNT])).fetch.length === 0)
await op(`select public.support_phone_config_save('{"toll_free_number":"1800 123 4567","click_to_call_mode":"AGENT","recording_retrieval":true,"recording_retention_days":30}'::jsonb)`)
const due = await svc(`select public.support_recordings_due($1)`, [ACCOUNT])
ok('retrieval on: calls with a provider recording are listed for the function only', due.fetch.length === 2 && due.fetch.every((f) => f.url.includes('servetel.in')))
const attId = await svc(`select public.support_recording_stored($1, $2, 'audio/mpeg', 1000)`, [p1.call_id, `${A}/calls/${p1.call_id}.mp3`])
ok('stored privately as a sensitive recording; provider link dropped', await val(`select (a.is_recording and a.is_sensitive and c.provider_recording_ref is null)
  from public.support_calls c join public.support_attachments a on a.id = c.recording_attachment_id where c.id = $1`, [p1.call_id]) && Boolean(attId))
const det = await agent(`select public.support_call_detail($1)`, [p1.call_id])
ok('call detail: all fields; recording restricted for users without support.manage_tickets', det.call.direction === 'OUTBOUND' && det.call.talk_seconds === 180
  && det.recording.state === 'STORED' && det.recording.restricted === true && det.recording.storage_path === null && det.ticket?.id === ticket.id, det.recording)
await db.exec(`reset role; update public.support_calls set ended_at = now() - interval '40 days' where id = '${p1.call_id}'`)
const purge = (await svc(`select public.support_recordings_due($1)`, [ACCOUNT])).purge
await svc(`select public.support_recording_purged($1)`, [p1.call_id])
ok('past the company’s retention: listed for deletion and removed', purge.length === 1 && await val(`select recording_attachment_id is null and recording_purged_at is not null from public.support_calls where id = $1`, [p1.call_id]))

console.log('\nCall log and access')
const list = await agent(`select public.support_call_list('{"limit":10}'::jsonb)`)
ok('call log with direction, status, customer, agent, durations', list.total >= 5 && list.rows.some((r) => r.id === p1.call_id && r.direction === 'OUTBOUND' && r.talk_seconds === 180))
ok('filters: missed inbound', (await agent(`select public.support_call_list('{"status":"MISSED","direction":"INBOUND"}'::jsonb)`)).total === 2)
ok('company B sees no calls or settings', (await request('b_op', `select (select count(*) from public.support_calls) + (select count(*) from public.support_phone_config)`)).value === 0
  && await refused('b_op', `select public.support_call_detail($1)`, [p1.call_id], /not found/))
ok('users without support access see nothing', (await request('ph_none', `select count(*)::int from public.support_calls`)).value === 0)
ok('the ERP reset allowlist includes the 4 phone tables', await val(`select count(*)::int from private.erp_reset_tables() where table_name in ('support_calls', 'support_call_events', 'support_phone_config', 'support_phone_agents')`) === 4)

console.log('\nRollback and re-apply')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback removes the phone tables and functions; Support Centre intact', await val(`select (select count(*) from pg_class where relname in ('support_calls', 'support_call_events', 'support_phone_config', 'support_phone_agents')) = 0
  and (select count(*) from pg_proc where proname in ('support_acefone_ingest', 'support_call_prepare')) = 0 and (select count(*) from pg_class where relname = 'support_tickets') = 1
  and (select count(*) from private.erp_reset_tables()) = 104`))
await db.exec(mig)
ok('re-applies cleanly after rollback', await val(`select count(*)::int from pg_class where relname in ('support_calls', 'support_call_events', 'support_phone_config', 'support_phone_agents')`) === 4)

console.log(`\n${failed ? '✗' : '✓'} acefone telephony: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
