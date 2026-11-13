// Support Centre (migration 20261210090000).
//
//   npm run test:db:support
//
// Local PGlite database only (throwaway, in memory): every migration plus the end-to-end business flow, then the
// Support Centre through its own functions as signed-in users (one committed transaction per call, RLS applied).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261210090000_support_centre'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
const snapshotTables = ['customers', 'sales_orders', 'sales_invoices', 'products', 'parties', 'audit_logs']
const snap = async () => {
  const out = {}
  for (const t of snapshotTables) out[t] = Object.values((await db.query(`select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) h from public.${t} x`)).rows[0])[0]
  return out
}
const beforeErp = await snap()
const mig = await read(path.join(migDir, `${NAME}.sql`))
await db.exec(mig)
const afterErp = await snap()
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
const refused = async (user, sql, params, pattern) => { const r = await request(user, sql, params); return Boolean(r.error) && (!pattern || pattern.test(r.error)) }
const A = await val(`select rls_test.id('company_a')::text`)

// Users of company A with other roles.
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await addUser('sup_sales', 'e7e5cc00-0000-4000-8000-0000000000a1', 'SALES_MANAGER')
await addUser('sup_none', 'e7e5cc00-0000-4000-8000-0000000000a3', 'INVENTORY_MANAGER')
// Roles an administrator would set up: a support viewer (view + reports) and a plain agent (view + reply).
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('SUPPORT_VIEWER_TEST', 'Support viewer (test)', false), ('SUPPORT_AGENT_TEST', 'Support agent (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p
  where (r.code = 'SUPPORT_VIEWER_TEST' and p.code in ('support.view', 'support.view_reports', 'sales_orders.read', 'invoices.read', 'customers.read'))
     or (r.code = 'SUPPORT_AGENT_TEST' and p.code in ('support.view', 'support.reply'))`)
await addUser('sup_view', 'e7e5cc00-0000-4000-8000-0000000000a2', 'SUPPORT_VIEWER_TEST')
await addUser('sup_agent', 'e7e5cc00-0000-4000-8000-0000000000a5', 'SUPPORT_AGENT_TEST')
const sales = as('sup_sales')
const viewer = as('sup_view')

console.log('\nDeployment')
ok('existing ERP records unchanged by the migration', JSON.stringify(afterErp) === JSON.stringify(beforeErp), Object.keys(beforeErp).filter((k) => beforeErp[k] !== afterErp[k]))
const perms = await val(`select jsonb_object_agg(r.code, (select coalesce(jsonb_agg(p.code order by p.code), '[]') from public.role_permissions rp join public.permissions p on p.id = rp.permission_id
  where rp.role_id = r.id and p.code like 'support.%')) from public.roles r where r.code in ('SUPER_ADMIN', 'ADMIN', 'SALES_MANAGER', 'MANAGEMENT_VIEWER', 'INVENTORY_MANAGER')`)
ok('7 support permissions; Super Admin and Admin have all', perms.SUPER_ADMIN.length === 7 && perms.ADMIN.length === 7, perms)
ok('Sales Manager: view, manage tickets, assign, reply, reports', JSON.stringify(perms.SALES_MANAGER) === JSON.stringify(['support.assign', 'support.manage_tickets', 'support.reply', 'support.view', 'support.view_reports']), perms.SALES_MANAGER)
ok('read-only and other roles get no support permission (Management Viewer stays read-only; Inventory Manager none)', perms.MANAGEMENT_VIEWER.length === 0 && perms.INVENTORY_MANAGER.length === 0)
ok('read-only roles still hold only *.read permissions', await val(`select not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
  join public.permissions p on p.id = rp.permission_id where r.code in ('MANAGEMENT_VIEWER', 'REPORTS_VIEWER') and p.action <> 'read')`))
const tables = await val(`select jsonb_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'support\\_%'`)
ok('16 support tables', tables.length === 16, tables)
ok('RLS enabled on every support table', await val(`select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'support\\_%'`))
ok('no anonymous access: anon has no table privilege and no policy', await val(`select not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name like 'support\\_%' and grantee = 'anon')
  and not exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname like 'support\\_%' and pol.polroles @> array[(select oid from pg_roles where rolname = 'anon')])`))
ok('signed-in users can only read support tables (no insert / update / delete grants or policies)', await val(`select not exists (select 1 from information_schema.role_table_grants
  where table_schema = 'public' and table_name like 'support\\_%' and grantee = 'authenticated' and privilege_type <> 'SELECT')
  and not exists (select 1 from pg_policy pol join pg_class c on c.oid = pol.polrelid where c.relname like 'support\\_%' and pol.polcmd <> 'r')`))
ok('every support table has company_id, created_at and a company index', await val(`select bool_and(exists (select 1 from information_schema.columns where table_name = t and column_name = 'company_id')
  and exists (select 1 from information_schema.columns where table_name = t and column_name = 'created_at')
  and exists (select 1 from pg_indexes where tablename = t and indexdef like '%(company_id%'))
  from unnest(array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'support\\_%')) t
  where t not in ('support_conversation_tags')`))
ok('anon cannot call the support functions', await refused(null, `select public.support_overview(current_date, current_date)`, [], /permission denied|not allowed/))
ok('the ERP reset allowlist classifies the 16 support tables', await val(`select count(*) from private.erp_reset_tables() where table_name like 'support\\_%'`) === 16)

console.log('\nAgents and presence')
const opAgent = await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('op'), 'display_name', 'Operator', 'department', 'Sales support'))`)
const salesAgent = await op(`select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('sup_sales'), 'display_name', 'Sales Agent'))`)
ok('agents created for users with support access', Boolean(opAgent && salesAgent))
ok('a user without support.view cannot be made an agent', await refused('op', `select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('sup_none'), 'display_name', 'No access'))`, [], /support\.view first/))
ok('only support.manage_settings may add agents', await refused('sup_sales', `select public.support_agent_save(null, jsonb_build_object('user_id', rls_test.id('sup_view'), 'display_name', 'X'))`, [], /support\.manage_settings/))
await sales(`select public.support_agent_set_presence('AVAILABLE')`)
ok('an agent sets their own presence', await val(`select presence from public.support_agents where id = $1`, [salesAgent]) === 'AVAILABLE')
ok('presence values are checked', await refused('sup_sales', `select public.support_agent_set_presence('LUNCH')`, [], /available, busy, away or offline/))
ok('a non-agent gets a clear message for presence', await refused('sup_view', `select public.support_agent_set_presence('BUSY')`, [], /not set up as an active support agent/))

console.log('\nCustomers and matching')
const c1 = await op(`select public.support_customer_save(null, jsonb_build_object('display_name', 'Ravi Kumar', 'phones', jsonb_build_array('+91 98765 43210'), 'emails', jsonb_build_array('Ravi@Example.com')))`)
ok('customer code generated (SC-000001)', c1.ok && c1.customer_code === 'SC-000001', c1)
const dup = await op(`select public.support_customer_save(null, jsonb_build_object('display_name', 'R. Kumar', 'phones', jsonb_build_array('09876543210')))`)
ok('the same number in another format is detected; nothing created without confirmation', dup.ok === false && dup.duplicates.length === 1 && await val(`select count(*)::int from public.support_customers`) === 1, dup)
const c2 = await op(`select public.support_customer_save(null, jsonb_build_object('display_name', 'Ravi Kumar (shop)', 'phones', jsonb_build_array('9876543210')), true)`)
ok('created only when the agent confirms it is a different customer (never merged)', c2.ok && await val(`select count(*)::int from public.support_customers`) === 2)
const c3 = await op(`select public.support_customer_save(null, jsonb_build_object('display_name', 'Anita Shah', 'emails', jsonb_build_array('anita@shah.example'), 'company_name', 'Shah Traders'))`)
ok('invalid phone and email are refused', await refused('op', `select public.support_customer_save(null, jsonb_build_object('display_name', 'X', 'phones', jsonb_build_array('12')))`, [], /not valid/)
  && await refused('op', `select public.support_customer_save(null, jsonb_build_object('display_name', 'X', 'emails', jsonb_build_array('nope')))`, [], /not valid/))
ok('a viewer cannot create customers', await refused('sup_view', `select public.support_customer_save(null, jsonb_build_object('display_name', 'X', 'emails', jsonb_build_array('x@y.example')))`, [], /support\.reply/))
const matches = await op(`select public.support_customer_matches('+919876543210', null)`)
ok('matching by normalised phone finds both customers (ambiguous)', matches.length === 2)

console.log('\nConversations')
const conv1 = await op(`select public.support_conversation_create(jsonb_build_object('channel', 'EMAIL', 'contact_email', 'ANITA@shah.example', 'subject', 'Cracked basin', 'body', 'The basin arrived cracked.'))`)
ok('unique email match links the customer automatically', conv1.match === 'MATCHED' && conv1.customer_id === c3.id, conv1)
const conv2 = await op(`select public.support_conversation_create(jsonb_build_object('channel', 'PHONE', 'contact_phone', '098765 43210', 'call_status', 'MISSED'))`)
ok('ambiguous phone: not linked, both candidates offered', conv2.match === 'AMBIGUOUS' && conv2.customer_id === null && conv2.candidates.length === 2, conv2)
const conv3 = await op(`select public.support_conversation_create(jsonb_build_object('channel', 'WHATSAPP', 'contact_phone', '+91 90000 11111', 'contact_name', 'New Person', 'body', 'Do you deliver to Pune?'))`)
ok('unknown contact: no match, kept with its contact details', conv3.match === 'NO_MATCH' && conv3.customer_id === null)
ok('a call needs its result; a message needs text', await refused('op', `select public.support_conversation_create(jsonb_build_object('channel', 'PHONE', 'contact_phone', '9000011111'))`, [], /call result/)
  && await refused('op', `select public.support_conversation_create(jsonb_build_object('channel', 'WHATSAPP', 'contact_phone', '9000011111'))`, [], /Enter the message/))
await op(`select public.support_conversation_link_customer($1, $2)`, [conv2.id, c1.id])
ok('an agent links the ambiguous call to the right customer', await val(`select customer_id::text from public.support_conversations where id = $1`, [conv2.id]) === c1.id)
await op(`select public.support_conversation_assign($1, $2)`, [conv1.id, salesAgent])
ok('assignment needs support.assign', await refused('sup_view', `select public.support_conversation_assign($1, $2)`, [conv3.id, salesAgent], /support\.assign/))

console.log('\nChannels: never a fake connected status')
const statuses = await op(`select public.support_channel_status()`)
ok('no accounts: every channel is Not Connected', statuses.every((s) => s.status === 'NOT_CONNECTED'), statuses)
ok('reply refused while WhatsApp is not connected', await refused('op', `select public.support_message_add($1, jsonb_build_object('mode', 'REPLY', 'body', 'Yes we do'))`, [conv3.id], /not connected/))
const acct = await op(`select public.support_channel_account_save(null, jsonb_build_object('channel', 'WHATSAPP', 'display_name', 'Alton WhatsApp', 'identifier', '+91 90000 00000', 'credentials_ref', 'WHATSAPP_CLOUD_TOKEN'))`)
ok('a configured account starts as Setup Required (not Connected)', acct.status === 'SETUP_REQUIRED', acct)
ok('the app cannot set the status', await refused('op', `select public.support_channel_account_save($1, jsonb_build_object('display_name', 'X', 'status', 'CONNECTED'))`, [acct.id], /server-side health check/))
ok('a secret value is refused as credentials reference', await refused('op', `select public.support_channel_account_save(null, jsonb_build_object('channel', 'EMAIL', 'display_name', 'Mail', 'credentials_ref', 'sk_live_abc/123=='))`, [], /NAME of a server-side secret/))
ok('only support.manage_integrations sees channel accounts', (await request('sup_sales', `select count(*)::int from public.support_channel_accounts`)).value === 0
  && (await request('op', `select count(*)::int from public.support_channel_accounts`)).value === 1)
ok('signed-in users cannot record a health result (service role only)', await refused('op', `select public.support_record_integration_health($1, 'CONNECTED')`, [acct.id], /permission denied/))
await db.exec('reset role'); await db.query(`select public.support_record_integration_health($1, 'CONNECTED', 'Webhook verified')`, [acct.id])
ok('after the server-side check reports it, WhatsApp shows Connected', (await op(`select public.support_channel_status()`)).find((s) => s.channel === 'WHATSAPP').status === 'CONNECTED')
const reply = await op(`select public.support_message_add($1, jsonb_build_object('mode', 'REPLY', 'body', 'Yes, we deliver to Pune.'))`, [conv3.id])
ok('reply accepted while connected and queued for the connector (never shown as sent)', reply.delivery_status === 'QUEUED')
await db.exec('reset role'); await db.query(`select public.support_record_integration_health($1, 'REAUTHORIZATION_REQUIRED', 'Token expired')`, [acct.id])
ok('when the token expires replies are refused again', await refused('op', `select public.support_message_add($1, jsonb_build_object('mode', 'REPLY', 'body', 'Hi'))`, [conv3.id], /reauthorization required/))
ok('integration events recorded', await val(`select count(*)::int from public.support_integration_events where channel_account_id = $1`, [acct.id]) === 3)
await op(`select public.support_message_add($1, jsonb_build_object('mode', 'LOG', 'direction', 'OUTBOUND', 'body', 'Replied from the shop phone'))`, [conv3.id])
ok('activity outside the ERP can be logged and is marked as logged manually', await val(`select source from public.support_messages where conversation_id = $1 order by created_at desc limit 1`, [conv3.id]) === 'MANUAL')

console.log('\nTickets')
await op(`select public.support_sla_policy_save(null, jsonb_build_object('name', 'Standard', 'first_response_minutes', 60, 'resolution_minutes', 1440))`)
await op(`select public.support_sla_policy_save(null, jsonb_build_object('name', 'Urgent', 'priority', 'URGENT', 'first_response_minutes', 15, 'resolution_minutes', 240))`)
ok('only one active policy per priority', await refused('op', `select public.support_sla_policy_save(null, jsonb_build_object('name', 'Dup', 'priority', 'URGENT', 'first_response_minutes', 10, 'resolution_minutes', 100))`, [], /already exists/))
const tagDamage = await op(`select public.support_tag_save(null, 'Damage', 'danger')`)
await op(`select public.support_automation_rule_save(null, jsonb_build_object('name', 'Breakage is urgent', 'trigger', 'TICKET_CREATED', 'conditions', jsonb_build_object('subject_contains', 'cracked'),
  'actions', jsonb_build_object('set_priority', 'URGENT', 'set_department', 'Quality')))`)
await op(`select public.support_automation_rule_save(null, jsonb_build_object('name', 'Tag damage emails', 'trigger', 'CONVERSATION_CREATED', 'conditions', jsonb_build_object('channel', 'EMAIL', 'subject_contains', 'broken'),
  'actions', jsonb_build_object('add_tag_id', $1::text)))`, [tagDamage])
ok('automation rules are validated', await refused('op', `select public.support_automation_rule_save(null, jsonb_build_object('name', 'x', 'trigger', 'TICKET_CREATED', 'actions', jsonb_build_object('delete_all', true)))`, [], /Unknown action/))
const t1 = await sales(`select public.support_ticket_create(jsonb_build_object('conversation_id', $1::text, 'subject', 'Cracked basin on delivery', 'category', 'Damage'))`, [conv1.id])
const t2 = await sales(`select public.support_ticket_create(jsonb_build_object('customer_id', $1::text, 'subject', 'Invoice copy needed', 'priority', 'LOW'))`, [c3.id])
ok('ticket numbers ALT-SUP-000001, -000002', t1.ticket_number === 'ALT-SUP-000001' && t2.ticket_number === 'ALT-SUP-000002', [t1, t2])
const t1row = await val(`select to_jsonb(t) from public.support_tickets t where id = $1`, [t1.id])
ok('automation: subject rule made it Urgent and set the department', t1row.priority === 'URGENT' && t1row.department === 'Quality', t1row)
ok('SLA: urgent policy applied (4 h resolution, 15 min first response)', Math.round((new Date(t1row.due_at) - new Date(t1row.created_at)) / 60000) === 240
  && Math.round((new Date(t1row.first_response_due_at) - new Date(t1row.created_at)) / 60000) === 15)
ok('ticket created from the conversation: channel, customer and link copied', t1row.channel === 'EMAIL' && t1row.customer_id === c3.id
  && await val(`select ticket_id::text from public.support_conversations where id = $1`, [conv1.id]) === t1.id)
ok('a conversation cannot get a second ticket', await refused('op', `select public.support_ticket_create(jsonb_build_object('conversation_id', $1::text, 'subject', 'Again'))`, [conv1.id], /already has ticket/))
ok('a viewer cannot create tickets', await refused('sup_view', `select public.support_ticket_create(jsonb_build_object('customer_id', $1::text, 'subject', 'Nope'))`, [c3.id], /support\.manage_tickets/))
const conv4 = await op(`select public.support_conversation_create(jsonb_build_object('channel', 'EMAIL', 'contact_email', 'anita@shah.example', 'subject', 'Broken tap', 'body', 'Broken tap handle'))`)
ok('conversation automation added the Damage tag', await val(`select count(*)::int from public.support_conversation_tags where conversation_id = $1 and tag_id = $2`, [conv4.id, tagDamage]) === 1)
await sales(`select public.support_message_add($1, jsonb_build_object('mode', 'LOG', 'direction', 'OUTBOUND', 'body', 'Called the customer, replacement arranged'))`, [conv1.id])
ok('first response recorded from the first outbound activity; New → Open', await val(`select (first_response_at is not null and status = 'OPEN') from public.support_tickets where id = $1`, [t1.id]))
await sales(`select public.support_ticket_update($1, '{"status":"RESOLVED","csat_rating":5}'::jsonb)`, [t1.id])
ok('resolved: resolution time and satisfaction rating stored, SLA met', await val(`select (resolved_at is not null and csat_rating = 5 and private.support_sla_status(t) = 'MET') from public.support_tickets t where id = $1`, [t1.id]))
ok('a resolved ticket cannot be moved back without Reopen', await refused('sup_sales', `select public.support_ticket_update($1, '{"status":"OPEN"}'::jsonb)`, [t1.id], /Reopen/))
ok('reopen needs a reason', await refused('sup_sales', `select public.support_ticket_reopen($1, '')`, [t1.id], /reason/))
await sales(`select public.support_ticket_reopen($1, 'Customer says the replacement is also damaged')`, [t1.id])
ok('reopened: open again, resolved date cleared, reopen counted', await val(`select (status = 'OPEN' and resolved_at is null and reopen_count = 1) from public.support_tickets where id = $1`, [t1.id]))
await sales(`select public.support_ticket_update($1, '{"status":"CLOSED"}'::jsonb)`, [t2.id])
ok('closed tickets cannot be edited', await refused('sup_sales', `select public.support_ticket_update($1, '{"subject":"Changed subject"}'::jsonb)`, [t2.id], /closed/))
await sales(`select public.support_ticket_reopen($1, 'Customer asked again')`, [t2.id])
const t3 = await sales(`select public.support_ticket_create(jsonb_build_object('customer_id', $1::text, 'subject', 'Invoice copy needed (duplicate)'))`, [c3.id])
ok('merge needs a reason', await refused('sup_sales', `select public.support_ticket_merge($1, $2, '')`, [t3.id, t2.id], /reason/))
await sales(`select public.support_ticket_merge($1, $2, 'Same request sent twice')`, [t3.id, t2.id])
const merged = await val(`select jsonb_build_object('status', status, 'into', merged_into_ticket_id) from public.support_tickets where id = $1`, [t3.id])
ok('merge: duplicate closed and pointing to the kept ticket; nothing deleted', merged.status === 'CLOSED' && merged.into === t2.id && await val(`select count(*)::int from public.support_tickets`) === 3)
ok('merge events on both tickets', await val(`select count(*)::int from public.support_ticket_events where (ticket_id = $1 and event_type = 'MERGED_INTO') or (ticket_id = $2 and event_type = 'MERGED')`, [t3.id, t2.id]) === 2)
ok('a merged ticket cannot be merged or reopened', await refused('sup_sales', `select public.support_ticket_merge($1, $2, 'again')`, [t3.id, t1.id], /merged/)
  && await refused('sup_sales', `select public.support_ticket_reopen($1, 'x')`, [t3.id], /merged/))
await sales(`select public.support_ticket_assign($1, $2)`, [t1.id, opAgent])
ok('assign records the event', await val(`select count(*)::int from public.support_ticket_events where ticket_id = $1 and event_type = 'ASSIGNED'`, [t1.id]) === 1)
const noteId = await sales(`select public.support_note_add('TICKET', $1, 'Checked stock for a replacement')`, [t1.id])
ok('internal note on the ticket (with event)', Boolean(noteId) && await val(`select count(*)::int from public.support_ticket_events where ticket_id = $1 and event_type = 'NOTE_ADDED'`, [t1.id]) === 1)

console.log('\nLists, search and pagination')
const inbox = await op(`select public.support_inbox('ALL', null, null, 2, 0)`)
ok('inbox: total, first page of 2', inbox.total === 4 && inbox.rows.length === 2, [inbox.total, inbox.rows.length])
const page2 = await op(`select public.support_inbox('ALL', null, null, 2, 2)`)
ok('inbox: second page has the rest, no overlap', page2.rows.length === 2 && !page2.rows.some((r) => inbox.rows.some((x) => x.id === r.id)))
ok('inbox views: phone, unassigned', (await op(`select public.support_inbox('PHONE')`)).total === 1 && (await op(`select public.support_inbox('UNASSIGNED')`)).total === 3)
ok('inbox "My conversations" for the sales agent', (await sales(`select public.support_inbox('MINE')`)).total === 1)
ok('search finds text inside the message history', (await op(`select public.support_inbox('ALL', null, 'replacement arranged')`)).rows.map((r) => r.id).join() === conv1.id)
ok('search by ticket number and by phone in any format', (await op(`select public.support_inbox('ALL', null, 'ALT-SUP-000001')`)).total === 1 && (await op(`select public.support_inbox('ALL', null, '+91-90000-11111')`)).total === 1)
const detail = await op(`select public.support_conversation_detail($1)`, [conv1.id])
const kinds = detail.timeline.map((e) => e.type)
ok('conversation timeline in order with email, notes and ticket events', kinds.includes('email') && kinds.includes('note') && kinds.includes('event')
  && detail.timeline.every((e, i, a) => i === 0 || a[i - 1].at <= e.at), kinds)
const tlist = await op(`select public.support_ticket_list('{"statuses":["NEW","OPEN"],"limit":10}'::jsonb)`)
ok('ticket list filters by status', tlist.total === 2 && tlist.rows.every((r) => ['NEW', 'OPEN'].includes(r.status)), tlist.rows.map((r) => r.status))
ok('ticket list search (customer name)', (await op(`select public.support_ticket_list('{"search":"Anita"}'::jsonb)`)).total === 3)
ok('exporting more than 200 rows needs support.manage_tickets', await refused('sup_view', `select public.support_ticket_list('{"limit":5000}'::jsonb)`, [], /manage_tickets/)
  && !(await request('sup_sales', `select public.support_ticket_list('{"limit":5000}'::jsonb)`)).error)
const custs = await op(`select public.support_customer_list('shah', 25, 0)`)
ok('customer list search', custs.total === 1 && custs.rows[0].open_tickets === 2, custs)

console.log('\nCustomer profile and ERP data')
const erpCustomer = await val(`select id::text from public.customers where company_id = $1 order by created_at limit 1`, [A])
await op(`select public.support_customer_save($1, jsonb_build_object('display_name', 'Anita Shah', 'company_name', 'Shah Traders', 'emails', jsonb_build_array('anita@shah.example'), 'erp_customer_id', $2::text))`, [c3.id, erpCustomer])
const prof = await op(`select public.support_customer_profile($1)`, [c3.id])
ok('profile: tickets, conversations, emails, notes and the linked ERP customer', prof.tickets.length === 3 && prof.conversations.length === 2 && prof.emails.length >= 2 && prof.erp_customer?.id === erpCustomer, Object.keys(prof))
ok('profile shows order and invoice history to users who may see it', Array.isArray(prof.orders) && Array.isArray(prof.invoices))
await db.exec(`reset role; delete from public.role_permissions rp using public.roles r, public.permissions p where rp.role_id = r.id and rp.permission_id = p.id and r.code = 'SUPPORT_VIEWER_TEST'
  and p.code in ('sales_orders.read', 'invoices.read', 'customers.read', 'ledger.read')`)
const prof2 = await as('sup_view')(`select public.support_customer_profile($1)`, [c3.id])
ok('…and hides them from users without sales / invoice / customer access', prof2.orders === null && prof2.invoices === null && prof2.erp_customer === null, [prof2.orders, prof2.invoices])

console.log('\nAttachments and recordings')
ok('files must be in the company folder', await refused('op', `select public.support_attachment_register(jsonb_build_object('ticket_id', $1::text, 'file_name', 'x.pdf', 'storage_path', 'other/x.pdf'))`, [t1.id], /company/))
await sales(`select public.support_attachment_register(jsonb_build_object('ticket_id', $1::text, 'file_name', 'photo.jpg', 'storage_path', $2::text, 'content_type', 'image/jpeg', 'size_bytes', 1000))`, [t1.id, `${A}/t1/photo.jpg`])
await op(`select public.support_attachment_register(jsonb_build_object('conversation_id', $1::text, 'file_name', 'call.mp3', 'storage_path', $2::text, 'is_recording', true))`, [conv2.id, `${A}/c2/call.mp3`])
ok('adding a recording needs support.manage_tickets', await refused('sup_view', `select public.support_attachment_register(jsonb_build_object('conversation_id', $1::text, 'file_name', 'r.mp3', 'storage_path', $2::text, 'is_recording', true))`, [conv2.id, `${A}/c2/r.mp3`]))
ok('recordings are sensitive: hidden from users without support.manage_tickets', (await request('sup_view', `select count(*)::int from public.support_attachments`)).value === 1
  && (await request('sup_sales', `select count(*)::int from public.support_attachments`)).value === 2)
const tl = (await viewer(`select public.support_conversation_detail($1)`, [conv2.id])).timeline.find((e) => e.type === 'attachment')
ok('…and the timeline shows them as restricted without a path', tl?.restricted === true && tl.storage_path === null, tl)

console.log('\nIsolation and access')
ok('company B sees no support rows', (await request('b_op', `select (select count(*) from public.support_tickets) + (select count(*) from public.support_conversations) + (select count(*) from public.support_customers)`)).value === 0)
ok('company B cannot open company A records by id', await refused('b_op', `select public.support_ticket_detail($1)`, [t1.id], /not found/)
  && await refused('b_op', `select public.support_message_add($1, '{"mode":"LOG","direction":"INBOUND","body":"x"}'::jsonb)`, [conv1.id], /not found/))
ok('a user without support access sees nothing and can do nothing', (await request('sup_none', `select count(*)::int from public.support_tickets`)).value === 0
  && await refused('sup_none', `select public.support_inbox()`, [], /support\.view/))

console.log('\nOverview, reports and audit')
const today = await val(`select private.company_today($1)::text`, [A])
const ov = await op(`select public.support_overview($1::date, $1::date)`, [today])
ok('overview counts', ov.kpis.total_tickets === 3 && ov.kpis.open_tickets === 2 && ov.kpis.missed_calls === 1 && ov.kpis.whatsapp_conversations === 1
  && ov.kpis.incoming_emails === 2 && ov.kpis.csat_average === 5, ov.kpis)
ok('overview charts: channel, status, SLA and agents', ov.by_channel.length >= 1 && ov.by_status.length >= 1 && ov.sla && Array.isArray(ov.agents))
const ovViewer = await viewer(`select public.support_overview($1::date, $1::date)`, [today])
const ovAgent = await as('sup_agent')(`select public.support_overview($1::date, $1::date)`, [today])
ok('agent performance only with support.view_reports', Array.isArray(ovViewer.agents) && ovAgent.agents === null && ovAgent.kpis.total_tickets === 3)
ok('reports need support.view_reports', !(await request('sup_view', `select public.support_reports($1::date, $1::date)`, [today])).error
  && await refused('sup_agent', `select public.support_reports($1::date, $1::date)`, [today], /view_reports/))
const ws = await sales(`select public.support_agent_workspace($1::date, $1::date)`, [today])
ok('agent workspace: own conversations, workload, performance and activity', ws.agent?.id === salesAgent && ws.workload.open_conversations === 1 && ws.activity.length > 0, ws.workload)
const audit = await val(`select count(*)::int from public.support_audit_logs where company_id = $1`, [A])
ok('audit entries written for support changes', audit > 20, audit)
ok('audit log is append-only', await refused('op', `update public.support_audit_logs set action = 'x'`, [])
  && await val(`select (select count(*) from public.support_audit_logs where action = 'x') = 0`))
ok('audit details never contain phone numbers or emails', await val(`select not exists (select 1 from public.support_audit_logs where details::text ~ '9876543210|@example|@shah')`))
await as('sup_agent')(`select public.support_note_add('CUSTOMER', $1, 'Prefers WhatsApp')`, [c1.id])
const own = (await request('sup_agent', `select jsonb_build_object('n', count(*), 'others', count(*) filter (where actor_user_id <> rls_test.id('sup_agent'))) from public.support_audit_logs`)).value
ok('a plain agent sees only their own activity; managers see everyone', own.n >= 1 && own.others === 0
  && (await request('sup_view', `select count(distinct actor_user_id)::int from public.support_audit_logs`)).value >= 2, own)

console.log('\nRollback and re-apply')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
ok('rollback removes support tables, functions and permissions', await val(`select (select count(*) from pg_class where relname like 'support\\_%' and relkind = 'r') = 0
  and (select count(*) from pg_proc where proname like 'support\\_%') = 0 and (select count(*) from public.permissions where code like 'support.%') = 0
  and (select count(*) from private.erp_reset_tables() where table_name like 'support\\_%') = 0`))
ok('rollback leaves the ERP records untouched', JSON.stringify(await snap()).length > 0 && (await snap()).customers === beforeErp.customers && (await snap()).sales_invoices === beforeErp.sales_invoices)
await db.exec(mig)
ok('re-applies cleanly after rollback', await val(`select count(*)::int from pg_class where relname like 'support\\_%' and relkind = 'r'`) === 16)

console.log(`\n${failed ? '✗' : '✓'} support centre: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
