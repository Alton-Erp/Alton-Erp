// Unified Support Centre (migration 20261214090000): one engine for Acefone, Gmail and WhatsApp events,
// ticket automation, business-hours SLA with pause and escalation, notifications, reports and integration health.
//
//   npm run test:db:unified
//
// Local PGlite only. Provider events go through each provider's real ingestion function (service role), exactly as
// the Edge Functions call them; users call the app functions (RLS applies).

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261214090000_support_unified'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
await db.exec('commit')
const defs = async () => Object.fromEntries((await db.query(`select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname in ('support_apply_sla', 'support_sla_status', 'erp_reset_tables')`)).rows.map((r) => [r.proname, r.prosrc]))
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
const exec = async (sql) => { await db.exec('reset role'); await db.exec(sql) }
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
const refused = async (user, sql, params, pattern) => {
  const r = await request(user, sql, params)
  const good = Boolean(r.error) && (!pattern || pattern.test(r.error))
  if (!good) console.log(`      (got: ${r.error ?? 'not refused'})`)
  return good
}
const addUser = async (key, uuid, roleCode) => {
  await exec(`insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await exec(`insert into public.roles (code, name, is_system) values ('UNI_AGENT_TEST', 'Support agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'UNI_AGENT_TEST' and p.code in ('support.view', 'support.reply')`)
await addUser('u_agent', 'e7e5d000-0000-4000-8000-0000000000a1', 'UNI_AGENT_TEST')
await addUser('u_none', 'e7e5d000-0000-4000-8000-0000000000a2', 'INVENTORY_MANAGER')
const OP = await val(`select rls_test.id('op')::text`)
const AGENT_USER = await val(`select rls_test.id('u_agent')::text`)
const COMPANY = await val(`select rls_test.id('company_a')::text`)
const notes = (type, user = AGENT_USER) => val(`select count(*)::int from public.notifications where notification_type = $1 and recipient_user_id = $2`, [type, user])
const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex')

// ---------------------------------------------------------------------------------------------
console.log('\nSetup: three providers on the same company')
const agentId = await op(`select public.support_agent_save(null, jsonb_build_object('user_id', $1::text, 'display_name', 'Uni Agent'))`, [AGENT_USER])
const opAgent = await op(`select public.support_agent_save(null, jsonb_build_object('user_id', $1::text, 'display_name', 'Operator'))`, [OP])
await op(`select public.support_sla_policy_save(null, '{"name":"Normal","priority":"NORMAL","first_response_minutes":60,"resolution_minutes":480}'::jsonb)`).catch(() => null)
await op(`select public.support_sla_policy_save(null, '{"name":"Urgent","priority":"URGENT","first_response_minutes":15,"resolution_minutes":120}'::jsonb)`).catch(() => null)
await op(`select public.support_sla_policy_save(null, '{"name":"High","priority":"HIGH","first_response_minutes":30,"resolution_minutes":240}'::jsonb)`).catch(() => null)
await op(`select public.support_customer_save(null, '{"display_name":"Ravi Kumar","phones":["+91 98765 43210"],"emails":["ravi@customer.example"]}'::jsonb)`)
const phone = await op(`select public.support_phone_config_save('{"toll_free_number":"1800 123 4567","click_to_call_mode":"AGENT"}'::jsonb)`)
const PHONE_ACC = phone.config.channel_account_id
const email = await op(`select public.support_email_config_save('{"mailbox_address":"support@alton.example"}'::jsonb)`)
const MAIL_ACC = email.config.channel_account_id
await svc(`select public.support_gmail_connect($1, $2::uuid, 'support@alton.example', 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ', 'AAAAAAAAAAAAAAAA', 1,
  array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'], '100')`, [MAIL_ACC, OP])
const wa = await op(`select public.support_whatsapp_config_save('{"waba_id":"102030405060","phone_number_id":"109876543210","display_phone_number":"+91 1800 123 4567","app_id":"555666777888","graph_api_version":"v27.0","number_path":"CLOUD_API"}'::jsonb)`)
const WA_ACC = wa.config.channel_account_id
for (const k of ['number_path_confirmed', 'cloud_api_eligibility', 'system_user_token', 'webhook_subscribed']) await op(`select public.support_whatsapp_checklist_set($1, true, 'Meta case 1, 2026-11-13')`, [k])
await svc(`select public.support_whatsapp_test_result($1, true, '{"platform_type":"CLOUD_API"}'::jsonb, 'ok')`, [WA_ACC])
await svc(`select public.support_whatsapp_webhook_verified($1)`, [WA_ACC])
const meta = { display_phone_number: '9118001234567', phone_number_id: '109876543210' }
const waIngest = (value, k) => svc(`select public.support_whatsapp_ingest($1, '102030405060', 'messages', $2::jsonb, $3)`, [WA_ACC, JSON.stringify(value), k ?? sha(value)])
await waIngest({ messaging_product: 'whatsapp', metadata: meta, statuses: [] }, sha('evidence'))
await op(`select public.support_whatsapp_set_enabled(true)`)
ok('three providers configured; WhatsApp switched on after verification', (await val(`select integration_enabled from public.support_whatsapp_config`)) === true)
const acefone = (event, payload, key) => svc(`select public.support_acefone_ingest($1, $2, $3::jsonb, $4, '1.2.3.4')`, [PHONE_ACC, event, JSON.stringify(payload), key])
const gmail = (p) => svc(`select public.support_gmail_ingest($1, $2::jsonb)`, [MAIL_ACC, JSON.stringify(p)])
const mail = (id, extra = {}) => ({ gmail_message_id: id, gmail_thread_id: `thr${id}`, label_ids: ['INBOX'], rfc_message_id: `<${id}@customer.example>`,
  from: { email: 'ravi@customer.example', name: 'Ravi' }, to: [{ email: 'support@alton.example' }], subject: 'Question', body_text: 'Hello', internal_date: String(Date.now() - 60000), ...extra })
const waText = (id, from, body) => ({ messaging_product: 'whatsapp', metadata: meta, contacts: [{ profile: { name: 'Ravi' }, wa_id: from }],
  messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000) - 30), type: 'text', text: { body } }] })

// ---------------------------------------------------------------------------------------------
console.log('\nUnified engine: incoming events from all three providers (default rules: tickets on agent request only)')
await acefone('received', { call_id: '1714658000.44', caller_id_number: '+91 98765 43210', start_stamp: '2026-11-13 12:00:00' }, 'u:call1:1')
ok('incoming call: agents notified while it rings', (await notes('SUPPORT_CALL_INCOMING')) === 1)
await acefone('hangup_missed', { call_id: '1714658000.44', billsec: '0', duration: '30', end_stamp: '2026-11-13 12:00:30' }, 'u:call1:2')
const callConv = await val(`select conversation_id from public.support_calls where provider_call_id = '1714658000.44'`)
const callRow = (await request('op', `select to_jsonb(c) from public.support_conversations c where id = $1`, [callConv])).value
ok('missed call: conversation (phone, provider), customer, activity and unread updated', callRow.channel === 'PHONE' && callRow.customer_id !== null && callRow.unread_count >= 1 && callRow.ticket_id === null, callRow)
ok('missed call: agents notified', (await notes('SUPPORT_CALL_MISSED')) === 1)
ok('integration event recorded with the provider id', (await val(`select count(*)::int from public.support_integration_events where event_type = 'INBOUND' and channel_account_id = $1 and details ->> 'conversation_id' = $2`, [PHONE_ACC, callConv])) === 1)
await acefone('hangup_missed', { call_id: '1714658000.44', billsec: '0', duration: '30', end_stamp: '2026-11-13 12:00:30' }, 'u:call1:2')
ok('Acefone retry: no second message, notification or event', (await val(`select count(*)::int from public.support_messages where conversation_id = $1 and kind = 'CALL'`, [callConv])) === 1
  && (await notes('SUPPORT_CALL_MISSED')) === 1)
const e1 = await gmail(mail('em000001'))
ok('incoming email: conversation, customer, notification, no ticket by default', e1.result === 'STORED' && (await notes('SUPPORT_EMAIL_RECEIVED')) === 1
  && (await val(`select ticket_id from public.support_conversations where id = $1`, [e1.conversation_id])) === null)
ok('Gmail duplicate (push + reconciliation): nothing repeated', (await gmail(mail('em000001'))).result === 'DUPLICATE' && (await notes('SUPPORT_EMAIL_RECEIVED')) === 1)
const w1 = await waIngest(waText('wamid.U1', '919876543210', 'Hi there'))
const waConv = await val(`select conversation_id from public.support_whatsapp_messages where wa_message_id = 'wamid.U1'`)
ok('incoming WhatsApp: conversation, customer, notification', w1.messages === 1 && (await notes('SUPPORT_WHATSAPP_RECEIVED')) === 1
  && (await val(`select customer_id is not null from public.support_conversations where id = $1`, [waConv])) === true)
ok('WhatsApp retry (same change): duplicate, nothing repeated', (await waIngest(waText('wamid.U1', '919876543210', 'Hi there'))).result === 'DUPLICATE' && (await notes('SUPPORT_WHATSAPP_RECEIVED')) === 1)
ok('one conversation per provider thread across all of it', (await val(`select count(*)::int from public.support_conversations where id in ($1, $2, $3)`, [callConv, e1.conversation_id, waConv])) === 3)

// ---------------------------------------------------------------------------------------------
console.log('\nTicket automation rules')
ok('agents cannot change the rules', await refused('u_agent', `select public.support_ticket_rules_save('{}'::jsonb)`, [], /manage_settings/))
ok('a keyword rule needs keywords', await refused('op', `select public.support_ticket_rules_save('{"email_keywords_enabled":true}'::jsonb)`, [], /at least one email keyword/))
await op(`select public.support_ticket_rules_save($1::jsonb)`, [JSON.stringify({ missed_call_enabled: true, missed_call_priority: 'HIGH', email_keywords_enabled: true,
  email_keywords: ['refund', 'broken'], whatsapp_keywords_enabled: true, whatsapp_keywords: ['urgent', 'damaged'], keyword_priority: 'URGENT', reopen_on_reply_enabled: true })])
await acefone('received', { call_id: '1714659000.55', caller_id_number: '+91 90000 22222', start_stamp: '2026-11-13 13:00:00' }, 'u:call2:1')
await acefone('hangup_missed', { call_id: '1714659000.55', billsec: '0', duration: '20', end_stamp: '2026-11-13 13:00:20' }, 'u:call2:2')
const mc = (await request('op', `select to_jsonb(t) from public.support_tickets t join public.support_conversations c on c.ticket_id = t.id
  join public.support_calls k on k.conversation_id = c.id where k.provider_call_id = '1714659000.55'`)).value
ok('missed call → ticket (HIGH, phone channel, SLA applied, linked)', mc && mc.priority === 'HIGH' && mc.channel === 'PHONE' && mc.due_at !== null && mc.subject.startsWith('Missed call'), mc)
const e2 = await gmail(mail('em000002', { gmail_thread_id: 'thr-refund', subject: 'Refund for broken basin', from: { email: 'shop@other.example' } }))
const t2 = (await request('op', `select to_jsonb(t) from public.support_tickets t join public.support_conversations c on c.ticket_id = t.id where c.id = $1`, [e2.conversation_id])).value
ok('email with a configured subject keyword → ticket with that subject', t2?.subject === 'Refund for broken basin' && t2.priority === 'URGENT' && t2.channel === 'EMAIL', t2)
const e3 = await gmail(mail('em000003', { gmail_thread_id: 'thr-plain', subject: 'Catalogue', body_text: 'my order is broken', from: { email: 'x@other.example' } }))
ok('keyword only in the body: no ticket unless body matching is on', (await val(`select ticket_id from public.support_conversations where id = $1`, [e3.conversation_id])) === null)
await waIngest(waText('wamid.U2', '919811111111', 'The basin arrived DAMAGED'))
const waConv2 = await val(`select conversation_id from public.support_whatsapp_messages where wa_message_id = 'wamid.U2'`)
ok('WhatsApp message with a keyword → ticket', (await val(`select t.channel from public.support_tickets t join public.support_conversations c on c.ticket_id = t.id where c.id = $1`, [waConv2])) === 'WHATSAPP')
await waIngest(waText('wamid.U3', '919811111111', 'Still damaged, urgent'))
ok('one ticket per conversation (a second keyword message adds no ticket)', (await val(`select count(*)::int from public.support_tickets where channel = 'WHATSAPP'`)) === 1)
ok('automatic tickets are logged for troubleshooting', (await val(`select count(*)::int from public.support_integration_events where event_type = 'AUTOMATION'`)) === 3)
await op(`select public.support_ticket_rules_save($1::jsonb)`, [JSON.stringify({ ticket_mode: 'EVERY_NEW_CONVERSATION', new_conversation_priority: 'NORMAL', reopen_on_reply_enabled: true })])
const e4 = await gmail(mail('em000004', { gmail_thread_id: 'thr-new', subject: 'General question', from: { email: 'new@person.example' } }))
ok('every-new-conversation mode: ticket for a new conversation', (await val(`select ticket_id is not null from public.support_conversations where id = $1`, [e4.conversation_id])) === true)
await gmail(mail('em000005', { gmail_thread_id: 'thr000001', in_reply_to: '<em000001@customer.example>', subject: 'Re: Question' }))
ok('existing conversation (not new): no ticket from that mode', (await val(`select ticket_id from public.support_conversations where id = $1`, [e1.conversation_id])) === null)
// Reopen on customer reply
const tk = t2.id
await op(`select public.support_ticket_update($1, '{"status":"RESOLVED"}'::jsonb)`, [tk]).catch(async () => exec(`update public.support_tickets set status = 'RESOLVED', resolved_at = now() where id = '${tk}'`))
await gmail(mail('em000006', { gmail_thread_id: 'thr-refund', subject: 'Re: Refund for broken basin', from: { email: 'shop@other.example' } }))
const reo = (await request('op', `select to_jsonb(t) from public.support_tickets t where id = $1`, [tk])).value
ok('customer reply reopens the resolved ticket (event, count), agents notified', reo.status === 'OPEN' && reo.reopen_count === 1 && reo.resolved_at === null
  && (await val(`select count(*)::int from public.support_ticket_events where ticket_id = $1 and event_type = 'REOPENED'`, [tk])) === 1)
await op(`select public.support_ticket_rules_save('{"reopen_on_reply_enabled":false}'::jsonb)`)
await exec(`update public.support_tickets set status = 'RESOLVED', resolved_at = now() where id = '${tk}'`)
await gmail(mail('em000007', { gmail_thread_id: 'thr-refund', subject: 'Re: Refund', from: { email: 'shop@other.example' } }))
ok('reopen rule switched off: stays resolved', (await val(`select status from public.support_tickets where id = $1`, [tk])) === 'RESOLVED')
ok('customer reply notification', (await val(`select count(*)::int from public.notifications where notification_type = 'SUPPORT_CUSTOMER_REPLY'`)) > 0)

// ---------------------------------------------------------------------------------------------
console.log('\nAssignment rules and assignment notifications')
await op(`select public.support_assignment_rule_save(null, jsonb_build_object('name', 'Urgent to Uni', 'priority', 'URGENT', 'department', 'Quality', 'agent_id', $1::text))`, [agentId])
await op(`select public.support_ticket_rules_save('{"ticket_mode":"AGENT_REQUEST_ONLY","whatsapp_keywords_enabled":true,"whatsapp_keywords":["damaged"],"keyword_priority":"URGENT"}'::jsonb)`)
await waIngest(waText('wamid.U4', '919822222222', 'damaged sink'))
const t4 = (await request('op', `select to_jsonb(t) from public.support_tickets t join public.support_conversations c on c.ticket_id = t.id
  join public.support_whatsapp_messages m on m.conversation_id = c.id where m.wa_message_id = 'wamid.U4'`)).value
ok('assignment rule: agent and department set on a new ticket', t4.assigned_agent_id === agentId && t4.department === 'Quality', t4)
ok('new ticket assignment notified to the agent', (await notes('SUPPORT_TICKET_ASSIGNED')) >= 1)

// ---------------------------------------------------------------------------------------------
console.log('\nBusiness-hours SLA')
ok('agents cannot change business hours', await refused('u_agent', `select public.support_business_calendar_save('{}'::jsonb)`, [], /manage_settings/))
ok('invalid hours refused', await refused('op', `select public.support_business_calendar_save('{"enabled":true,"working_days":[1],"start_time":"18:00","end_time":"09:00"}'::jsonb)`, [], /end after it starts/))
ok('unknown time zone refused', await refused('op', `select public.support_business_calendar_save('{"enabled":true,"working_days":[1],"start_time":"09:00","end_time":"18:00","timezone":"Mars/Base"}'::jsonb)`, [], /time zone/))
await op(`select public.support_business_calendar_save('{"enabled":true,"timezone":"Asia/Kolkata","working_days":[1,2,3,4,5],"start_time":"09:00","end_time":"18:00","pause_when_waiting_customer":true}'::jsonb)`)
await op(`select public.support_holiday_save('2026-11-16', 'Test holiday')`)
const add = (start, mins) => val(`select to_char(private.support_business_add($1::uuid, $2::timestamptz, $3) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`, [COMPANY, start, mins])
ok('within the day: Fri 10:00 + 60 min = Fri 11:00', (await add('2026-11-13 10:00+05:30', 60)) === '2026-11-13 11:00')
ok('across the weekend and a holiday: Fri 17:30 + 60 min = Tue 09:30 (Sat, Sun, Mon holiday skipped)', (await add('2026-11-13 17:30+05:30', 60)) === '2026-11-17 09:30')
ok('outside hours: Fri 20:00 + 30 min = Tue 09:30', (await add('2026-11-13 20:00+05:30', 30)) === '2026-11-17 09:30')
ok('business minutes between Fri 17:00 and Tue 10:00 = 120', (await val(`select private.support_business_minutes($1::uuid, '2026-11-13 17:00+05:30', '2026-11-17 10:00+05:30')`, [COMPANY])) === 120)
await exec(`update public.support_business_calendar set enabled = false`)
ok('calendar off: 24×7 as before', (await add('2026-11-13 17:30+05:30', 60)) === '2026-11-13 18:30')
// Pause while waiting for the customer (24×7 to keep the arithmetic exact).
const pt = await val(`select t.id from public.support_tickets t where t.priority = 'NORMAL' and t.due_at is not null order by created_at limit 1`)
const due0 = await val(`select due_at from public.support_tickets where id = $1`, [pt])
await exec(`update public.support_tickets set status = 'WAITING_CUSTOMER' where id = '${pt}'`)
ok('waiting for the customer: SLA paused', (await val(`select sla_paused_at is not null from public.support_tickets where id = $1`, [pt])) === true
  && (await op(`select (public.support_ticket_sla($1)) ->> 'status'`, [pt])) === 'PAUSED')
await exec(`update public.support_tickets set sla_paused_at = now() - interval '90 minutes' where id = '${pt}'`)
await exec(`update public.support_tickets set status = 'OPEN' where id = '${pt}'`)
const pr = (await request('op', `select jsonb_build_object('m', sla_paused_minutes, 'd', extract(epoch from (due_at - $2::timestamptz)) / 60) from public.support_tickets where id = $1`, [pt, due0])).value
ok('resumed: 90 paused minutes added, resolution due date moved 90 minutes later', pr.m === 90 && Math.round(pr.d) === 90, pr)

// ---------------------------------------------------------------------------------------------
console.log('\nSLA monitor: warning, breach, escalation (each once)')
await op(`select public.support_escalation_level_save(1, jsonb_build_object('after_minutes', 0, 'priorities', '["URGENT"]'::jsonb, 'reassign_agent_id', $1::text, 'set_department', 'Escalations', 'notify_managers', true))`, [opAgent])
ok('agents cannot edit escalation levels or run the monitor', await refused('u_agent', `select public.support_escalation_level_save(2, '{}'::jsonb)`, [], /manage_settings/)
  && await refused('u_agent', `select public.support_sla_run_now()`, [], /manage_settings/) && await refused('u_agent', `select public.support_sla_run(null)`))
await op(`select public.support_ticket_rules_save('{"escalate_on_breach_enabled":true,"escalate_priorities":["URGENT"],"sla_warning_percent":80}'::jsonb)`)
const urgent = t4.id
await exec(`update public.support_tickets set created_at = now() - interval '100 minutes' where id = '${urgent}'`)
await exec(`select private.support_apply_sla('${urgent}')`)
const run1 = await op(`select public.support_sla_run_now()`)
const hist = await op(`select public.support_ticket_sla($1)`, [urgent])
ok('first response passed (15 min target): breach recorded; resolution (120 min) at 83%: warning', hist.first_response.breached === true
  && hist.history.some((h) => h.kind === 'BREACH' && h.target === 'FIRST_RESPONSE') && hist.history.some((h) => h.kind === 'WARNING' && h.target === 'RESOLUTION'), hist.history)
ok('urgent breach escalated: level 1 reassigns and sets the department', hist.history.some((h) => h.kind === 'ESCALATION' && h.level === 1)
  && (await val(`select assigned_agent_id from public.support_tickets where id = $1`, [urgent])) === opAgent && (await val(`select department from public.support_tickets where id = $1`, [urgent])) === 'Escalations')
ok('SLA warning and breach notifications', (await val(`select count(*)::int from public.notifications where notification_type = 'SUPPORT_SLA_WARNING'`)) >= 1
  && (await val(`select count(*)::int from public.notifications where notification_type = 'SUPPORT_SLA_BREACH'`)) >= 1)
const run2 = await op(`select public.support_sla_run_now()`)
ok('running again changes nothing (idempotent)', run1.breaches >= 1 && run2.breaches === 0 && run2.warnings === 0 && run2.escalations === 0, { run1, run2 })
ok('remaining time is negative once breached; escalation history listed', hist.first_response.remaining_minutes < 0 && hist.history.length >= 3)
ok('ticket events: SLA warning / breach / escalated', (await val(`select count(distinct event_type)::int from public.support_ticket_events where ticket_id = $1 and event_type in ('SLA_WARNING','SLA_BREACHED','ESCALATED')`, [urgent])) === 3)

// ---------------------------------------------------------------------------------------------
console.log('\nReports and integration health')
const today = await val(`select current_date::text`)
const rep = await op(`select public.support_reports_unified($1::date - 7, $1::date + 1)`, [today])
ok('channel volume, calls, response times, tickets, agents, SLA, CSAT', rep.channel_totals.phone >= 2 && rep.channel_totals.email >= 5 && rep.channel_totals.whatsapp >= 4
  && rep.calls.missed >= 2 && rep.calls.missed_rate === 100 && rep.tickets.created >= 4 && Array.isArray(rep.agents) && rep.sla.tickets >= 1 && 'email' in rep.response_times, rep)
ok('reports need support.view_reports', await refused('u_agent', `select public.support_reports_unified(current_date, current_date)`, [], /view_reports/))
const h = await op(`select public.support_integration_health()`)
const by = Object.fromEntries(h.map((x) => [x.provider, x]))
ok('health: three providers with last webhook, failed events, retry queue', h.length === 3 && by.ACEFONE.last_webhook_at && by.META_WHATSAPP.last_webhook_at && 'retry_queue' in by.GOOGLE_WORKSPACE, h)
ok('not shown Connected without a provider API test (Acefone never tested)', by.ACEFONE.status !== 'CONNECTED' && by.ACEFONE.verified_by_test_at === null)
await svc(`select public.support_gmail_reauth_required($1, 'invalid_grant')`, [MAIL_ACC])
const t5 = await request('u_agent', `select public.support_whatsapp_send_prepare('{"kind":"TEXT","idempotency_key":"k0000000000000000099","conversation_id":"${waConv}","text":"hi"}'::jsonb)`)
await svc(`select public.support_whatsapp_send_result($1, 'FAILED', null, null, 190, 'Error validating access token', 'Session has expired', 401)`, [t5.value.id])
const h2 = Object.fromEntries((await op(`select public.support_integration_health()`)).map((x) => [x.provider, x]))
ok('token expiry shown as expired credentials (Gmail revoked, WhatsApp 190)', h2.GOOGLE_WORKSPACE.expired_credentials === true && h2.META_WHATSAPP.expired_credentials === true
  && h2.META_WHATSAPP.status !== 'CONNECTED', { g: h2.GOOGLE_WORKSPACE.status, w: h2.META_WHATSAPP.status })
await svc(`select public.support_gmail_connect($1, $2::uuid, 'support@alton.example', 'q83vEjRWeJAbzd7wEjRWeJCrze8SNFZ4kKvN7xI0VniQ', 'AAAAAAAAAAAAAAAA', 1,
  array['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send'], '100')`, [MAIL_ACC, OP])
await svc(`select public.support_gmail_sync_state($1, null, false, 'Gmail API 503', 'HISTORY')`, [MAIL_ACC])
ok('provider downtime: shown as Error with the reason', Object.fromEntries((await op(`select public.support_integration_health()`)).map((x) => [x.provider, x])).GOOGLE_WORKSPACE.status === 'ERROR')
ok('health needs support.manage_integrations', await refused('u_agent', `select public.support_integration_health()`, [], /manage_integrations/))

// ---------------------------------------------------------------------------------------------
console.log('\nRobustness')
await exec(`create or replace function private.support_ticket_auto(p_conversation uuid, p_reason text, p_priority text, p_subject text) returns uuid language plpgsql as $f$ begin raise exception 'boom'; end $f$`)
await op(`select public.support_ticket_rules_save('{"ticket_mode":"EVERY_NEW_CONVERSATION"}'::jsonb)`)
const e9 = await gmail(mail('em000009', { gmail_thread_id: 'thr-boom', subject: 'Anything', from: { email: 'boom@x.example' } }))
ok('a failing rule never loses the provider message (stored; error logged for the health dashboard)', e9.result === 'STORED'
  && (await val(`select count(*)::int from public.support_integration_events where event_type = 'ERROR' and message like 'Support automation failed%'`)) === 1)
await exec(mig) // restore the real function

// ---------------------------------------------------------------------------------------------
console.log('\nSecurity: RLS, grants, company isolation, RBAC, storage')
const tables = (await db.query(`select c.relname, c.relrowsecurity rls from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'support\\_%' order by 1`)).rows
ok(`all ${tables.length} support tables have RLS`, tables.length >= 37 && tables.every((t) => t.rls), tables.filter((t) => !t.rls).map((t) => t.relname))
const writable = (await db.query(`select table_name, privilege_type, grantee from information_schema.role_table_grants
  where table_schema = 'public' and table_name like 'support\\_%' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'`)).rows
ok('no insert / update / delete for anon or authenticated on any support table (writes only through checked functions)', writable.length === 0, writable)
const anonSel = (await db.query(`select distinct table_name from information_schema.role_table_grants where table_schema = 'public' and table_name like 'support\\_%' and grantee = 'anon'`)).rows
ok('anon can read no support table', anonSel.length === 0, anonSel)
const hidden = ['support_email_credentials', 'support_oauth_states', 'support_whatsapp_webhook_events']
const hiddenGrants = (await db.query(`select table_name from information_schema.role_table_grants where table_schema = 'public' and table_name = any ($1) and grantee = 'authenticated'`, [hidden])).rows
ok('credentials, OAuth states and raw webhook payloads are not readable by the app at all', hiddenGrants.length === 0, hiddenGrants)
const unscoped = (await db.query(`select tablename, policyname, qual from pg_policies where schemaname = 'public' and tablename like 'support\\_%'
  and cmd in ('SELECT', 'ALL') and (qual is null or qual not like '%company_id%')`)).rows
ok('every support select policy is scoped by company (and permission)', unscoped.length === 0, unscoped)
const fns = (await db.query(`select p.proname, p.prosecdef sd, p.proconfig cfg, has_function_privilege('anon', p.oid, 'execute') anon_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'support\\_%'`)).rows
ok(`all ${fns.length} public support functions: security definer with a fixed search_path, none executable by anon`,
  fns.every((f) => f.sd && (f.cfg ?? []).some((c) => c.startsWith('search_path='))) && fns.every((f) => !f.anon_exec), fns.filter((f) => !f.sd || f.anon_exec).map((f) => f.proname))
const serviceOnly = ['support_record_integration_health', 'support_acefone_ingest', 'support_call_request_result', 'support_phone_runtime', 'support_gmail_ingest', 'support_gmail_connect',
  'support_gmail_credentials', 'support_gmail_send_result', 'support_gmail_push', 'support_whatsapp_ingest', 'support_whatsapp_send_result', 'support_whatsapp_test_result',
  'support_whatsapp_media_result', 'support_sla_run']
const exposed = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any ($1) and has_function_privilege('authenticated', p.oid, 'execute')`, [serviceOnly])).rows
ok('provider / scheduler functions are service-role only', exposed.length === 0, exposed)
// Company B administrator with every support permission sees nothing of company A.
const leaks = []
for (const t of tables.map((x) => x.relname)) {
  if (hidden.includes(t)) continue
  const r = await request('b_op', `select count(*)::int from public.${t} where company_id = $1`, [COMPANY])
  if (r.error || r.value !== 0) leaks.push(`${t}: ${r.error ?? r.value}`)
}
ok('company B administrator: 0 rows of company A in every readable support table', leaks.length === 0, leaks)
const anyTicket = await val(`select id from public.support_tickets order by created_at limit 1`)
const anyCall = await val(`select id from public.support_calls order by created_at limit 1`)
ok('company B cannot open company A records through functions', await refused('b_op', `select public.support_conversation_detail($1)`, [e1.conversation_id], /not found/)
  && await refused('b_op', `select public.support_email_thread($1)`, [e1.conversation_id], /not found/)
  && await refused('b_op', `select public.support_call_detail($1)`, [anyCall], /not found/)
  && await refused('b_op', `select public.support_ticket_sla($1)`, [anyTicket], /not found/)
  && (await as('b_op')(`select public.support_whatsapp_thread($1)`, [waConv])) === null)
ok('company B sees its own (empty) integration health only', (await as('b_op')(`select public.support_integration_health()`)).every((p) => !p.configured))
await exec(`insert into public.support_attachments (company_id, conversation_id, file_name, storage_path, content_type, size_bytes)
  values ('${COMPANY}', '${e1.conversation_id}', 'x.pdf', '${COMPANY}/email/sec/x.pdf', 'application/pdf', 10)`)
ok('storage: company A file readable by A\'s agent, not by company B', (await as('u_agent')(`select private.support_object_readable($1)`, [`${COMPANY}/email/sec/x.pdf`])) === true
  && (await as('b_op')(`select private.support_object_readable($1)`, [`${COMPANY}/email/sec/x.pdf`])) === false
  && (await as('b_op')(`select private.support_object_writable($1)`, [`${COMPANY}/outbox/k/x.pdf`])) === false)
ok('agent permission limits: no ticket creation, provider settings or integrations', await refused('u_agent', `select public.support_ticket_create('{"subject":"abc","customer_email":"a@b.example"}'::jsonb)`, [], /manage_tickets/)
  && await refused('u_agent', `select public.support_phone_config_save('{}'::jsonb)`, [], /manage_integrations/)
  && await refused('u_agent', `select public.support_email_config_save('{"mailbox_address":"a@b.example"}'::jsonb)`, [], /manage_integrations/)
  && await refused('u_agent', `select public.support_whatsapp_config_save('{}'::jsonb)`, [], /manage_integrations/))
ok('users without support access are refused everywhere', await refused('u_none', `select public.support_inbox('ALL')`, [], /support.view/)
  && await refused('u_none', `select public.support_automation_settings_get()`, [], /support.view/) && await refused('u_none', `select public.support_ticket_sla($1)`, [anyTicket], /support.view/))

// ---------------------------------------------------------------------------------------------
console.log('\nReset allowlist and rollback')
ok('reset allowlist: 125 tables', (await val(`select count(*)::int from private.erp_reset_tables()`)) === 125)
await exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const left = await val(`select count(*)::int from pg_class where relname in ('support_ticket_rules','support_business_calendar','support_holidays','support_sla_escalation_levels','support_assignment_rules','support_ticket_escalations')`)
const trig = await val(`select count(*)::int from pg_trigger where tgname in ('support_messages_on_inbound','support_tickets_sla_pause','support_tickets_assigned_notify','support_tickets_assign_rules','support_calls_incoming_notify')`)
ok('rollback: tables and triggers removed', left === 0 && trig === 0, { left, trig })
const after = await defs()
ok('rollback: SLA functions and reset allowlist byte-identical to before', after.support_apply_sla === before.support_apply_sla && after.support_sla_status === before.support_sla_status
  && after.erp_reset_tables === before.erp_reset_tables)
await exec(mig)
ok('roll forward: the migration applies again', (await val(`select count(*)::int from private.erp_reset_tables()`)) === 125)

console.log(`\n${failed === 0 ? '✓' : '✗'} support unified: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
