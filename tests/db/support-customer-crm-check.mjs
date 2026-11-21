// Support customer CRM (migration 20261228090000): customer field builder next to the ticket one (separate
// definitions, layout, values and limits), the configured customer form and save, existing customers' contact
// labels, customer matching (mobile, alternate, landline, email; several matches; company only), tickets and the
// conversation link carried into support_tickets.customer_id, timeline of real records, channel tabs, notes with
// history, activities, workspace metrics, customer report, permissions, isolation, read-only reads, rollback.
//
//   npm run test:db:customer-crm

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261228090000_support_customer_crm'
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
const rows = async (sql, params) => { await db.exec('reset role'); return (await db.query(sql, params)).rows }
async function request(user, sql, params, readOnly = false) {
  await db.exec('reset role')
  await db.exec(readOnly ? 'begin read only' : 'begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    await db.exec('set local role authenticated')
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
const refused = async (user, sql, params, pattern) => { const r = await request(user, sql, params); if (r.error && (!pattern || pattern.test(r.error))) return true; console.log('      got:', r.error ?? 'no error'); return false }
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('CR_VIEW_TEST', 'Support viewer (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'CR_VIEW_TEST' and p.code = 'support.view'`)
await addUser('cr_view', 'e7e5d600-0000-4000-8000-0000000000a1', 'CR_VIEW_TEST')
await addUser('cr_sales', 'e7e5d600-0000-4000-8000-0000000000a2', 'SALES_MANAGER')
await addUser('cr_sales2', 'e7e5d600-0000-4000-8000-0000000000a3', 'SALES_MANAGER')
const A = await val(`select rls_test.id('company_a')::text`)
const OP = await val(`select rls_test.id('op')::text`)

// ---- before the migration: a customer saved by the existing form, a ticket field, a ticket linked only through its conversation
const legacy = (await op(`select public.support_customer_save(null, $1::jsonb)`, [JSON.stringify({ display_name: 'Ravi Kumar', phones: ['+91 98765 43210', '022-4000 1234'], emails: ['Ravi@Customer.example'] })])).id
const legacyBefore = await rows(`select updated_at::text, phones, emails, customer_code from public.support_customers where id = $1`, [legacy])
const tf = await op(`select public.support_ticket_field_save(null, '{"field_label":"Warranty","field_type":"CHECKBOX"}'::jsonb)`)
const orphan = (await op(`select public.support_ticket_create($1::jsonb)`, [JSON.stringify({ subject: 'Phone-only ticket', customer_phone: '+91 98765 43210' })])).id
await db.exec(`reset role; insert into public.support_conversations (company_id, channel, status, subject, contact_phone, customer_id, ticket_id)
  values ('${A}', 'PHONE', 'OPEN', 'Call', '+919876543210', '${legacy}', '${orphan}')`)
const orphanUpdated = await val(`select updated_at::text from public.support_tickets where id = $1`, [orphan])

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)

console.log('\nExisting data')
const lg = (await rows(`select updated_at::text, phones, emails, customer_code, mobile, alternate_phone, email from public.support_customers where id = $1`, [legacy]))[0]
ok('existing customer: same code, phones, emails and updated_at; mobile / alternate / email labelled from its lists', lg.updated_at === legacyBefore[0].updated_at
  && JSON.stringify(lg.phones) === JSON.stringify(legacyBefore[0].phones) && lg.customer_code === legacyBefore[0].customer_code && lg.mobile === lg.phones[0]
  && lg.alternate_phone === lg.phones[1] && lg.email === 'ravi@customer.example', lg)
ok('a ticket linked to the customer only through its conversation now carries the customer id (one source of truth)',
  (await val(`select customer_id::text from public.support_tickets where id = $1`, [orphan])) === legacy
  && (await val(`select updated_at::text from public.support_tickets where id = $1`, [orphan])) === orphanUpdated
  && Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and details ->> 'customer_linked_from' = 'conversation'`, [orphan])) === 1)
ok('the existing ticket field is a TICKET field and still works', (await val(`select module from public.support_ticket_field_definitions where id = $1`, [tf.id])) === 'TICKET'
  && (await op(`select public.support_ticket_fields_admin()`)).definitions.length === 1)

console.log('\nPermissions')
const roleCodes = async (role) => (await rows(`select p.code from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
  where r.code = $1 and p.resource in ('support_customer_fields', 'support_customers') order by p.code`, [role])).map((r) => r.code)
ok('Super Admin / Admin: field builder, notes and activities', (await roleCodes('SUPER_ADMIN')).length === 6 && (await roleCodes('ADMIN')).length === 6)
ok('Sales Manager: notes and activities only (no field builder)', JSON.stringify(await roleCodes('SALES_MANAGER')) === JSON.stringify(['support_customers.manage_activities', 'support_customers.manage_notes']))
ok('a support viewer: none', (await roleCodes('CR_VIEW_TEST')).length === 0)
ok('Sales Manager cannot open the customer field builder', await refused('cr_sales', `select public.support_fields_admin('CUSTOMER')`, [], /support_customer_fields\.view/))

console.log('\nCustomer field builder (separate from ticket fields)')
const csave = (p, id = null, user = 'op') => as(user)(`select public.support_field_save('CUSTOMER', $1::uuid, $2::jsonb)`, [id, JSON.stringify(p)])
const CF = {}
CF.seg = await csave({ field_label: 'Segment', field_type: 'PICKLIST', is_required: true, field_config: { options: ['Retail', 'Project'] } })
CF.limit = await csave({ field_label: 'Credit limit', field_type: 'CURRENCY' })
CF.visits = await csave({ field_label: 'Visits per year', field_type: 'NUMBER', field_config: { number_kind: 'INTEGER' } })
CF.formula = await csave({ field_label: 'Limit per visit', field_type: 'FORMULA', field_config: { expression: 'ROUND({cf_credit_limit} / {cf_visits_per_year}, 2)', result_kind: 'CURRENCY' } })
CF.since = await csave({ field_label: 'Customer since', field_type: 'DATE' })
CF.warranty = await csave({ field_label: 'Warranty', field_type: 'CHECKBOX', default_value: true })
ok('customer fields created with generated keys', CF.seg.field_key === 'cf_segment' && CF.formula.field_key === 'cf_limit_per_visit')
ok('the same label and key can exist in both modules (separate definitions)', CF.warranty.field_key === 'cf_warranty' && tf.field_key === 'cf_warranty')
await op(`select public.support_ticket_field_save(null, '{"field_label":"Ticket units","field_type":"NUMBER"}'::jsonb)`)
ok('a customer formula cannot use a ticket field', await refused('op', `select public.support_field_save('CUSTOMER', null, $1::jsonb)`, [JSON.stringify({ field_label: 'X', field_type: 'FORMULA', field_config: { expression: '{cf_ticket_units} * 2' } })], /not a field of this form/))
ok('ticket builder and ticket form show only ticket fields', (await op(`select public.support_ticket_fields_admin()`)).definitions.every((d) => d.module === undefined || d.module === 'TICKET')
  && (await op(`select public.support_ticket_fields_admin()`)).definitions.length === 2 && !(await op(`select public.support_ticket_form()`)).fields.some((f) => f.field_key === 'cf_segment'))
ok('a customer field cannot be edited through the ticket builder', await refused('op', `select public.support_ticket_field_save($1::uuid, '{"field_label":"Hacked"}'::jsonb)`, [CF.seg.id], /not found/))
ok('type and key stay immutable', await refused('op', `select public.support_field_save('CUSTOMER', $1::uuid, '{"field_type":"TEXT"}'::jsonb)`, [CF.seg.id], /type/))
let adm = await op(`select public.support_fields_admin('CUSTOMER')`)
ok('default customer layout: the standard customer fields (landline and alternate email start unused)', adm.layout.filter((l) => l.is_visible).map((l) => l.standard_key).join(',')
  === 'display_name,company_name,contact_person,mobile,alternate_phone,email,gstin,customer_type,customer_category,address,city,state,pin_code,country,assigned_agent,erp_customer,description', adm.layout)
ok('counter per module', adm.active_custom === 6 && (await op(`select public.support_fields_admin('TICKET')`)).active_custom === 2)
const used = ['display_name', 'mobile', 'alternate_phone', 'landline', 'email', 'alternate_email', 'company_name', { standard_key: 'gstin' }, { standard_key: 'city', is_required: true },
  'pin_code', 'country', 'assigned_agent', 'description'].map((x) => (typeof x === 'string' ? { standard_key: x } : x))
  .concat([{ field_definition_id: CF.seg.id }, { field_definition_id: CF.limit.id }, { field_definition_id: CF.visits.id }, { field_definition_id: CF.formula.id }, { field_definition_id: CF.warranty.id }])
const lay = await op(`select public.support_fields_save_layout('CUSTOMER', $1::jsonb, $2)`, [JSON.stringify(used), adm.stamp])
ok('customer layout saved; a stale save refused; Customer Name always on the form', Boolean(lay.stamp)
  && await refused('op', `select public.support_fields_save_layout('CUSTOMER', $1::jsonb, $2)`, [JSON.stringify(used), adm.stamp], /Someone else/)
  && await refused('op', `select public.support_fields_save_layout('CUSTOMER', $1::jsonb, $2)`, [JSON.stringify(used.slice(1)), lay.stamp], /Customer Name is always/))
ok('the ticket layout is untouched by the customer layout', (await op(`select public.support_ticket_form()`)).fields.map((f) => f.standard_key ?? f.field_key).slice(0, 3).join() === 'subject,customer,products')
const form = await as('cr_sales')(`select public.support_customer_form()`)
ok('customer form: configured order, required flags, customer types', form.fields.map((f) => f.standard_key ?? f.field_key).slice(0, 4).join() === 'display_name,mobile,alternate_phone,landline'
  && form.fields.find((f) => f.standard_key === 'city').required && form.fields.find((f) => f.field_key === 'cf_segment').required && form.customer_types.includes('Dealer'))
for (let i = adm.active_custom; i < 25; i++) await csave({ field_label: `Extra ${i}`, field_type: 'TEXT' })
ok('25 customer fields per company: the 26th is refused; ticket fields have their own 25', await refused('op', `select public.support_field_save('CUSTOMER', null, '{"field_label":"Too many","field_type":"TEXT"}'::jsonb)`, [], /25 active custom customer fields/)
  && Boolean((await op(`select public.support_ticket_field_save(null, '{"field_label":"Still fine","field_type":"TEXT"}'::jsonb)`)).id))

console.log('\nCreating and editing customers')
const save2 = (id, p, allow = false, user = 'cr_sales') => as(user)(`select public.support_customer_save_v2($1::uuid, $2::jsonb, $3)`, [id, JSON.stringify(p), allow])
const SEG = CF.seg.field_config.options[0].id
const AGENT = await val(`insert into public.support_agents (company_id, user_id, display_name) values ($1, $2, 'Op Agent') returning id::text`, [A, OP])
const base = { display_name: 'Meera Shah', company_name: 'Shah Builders', mobile: '98200 11111', alternate_phone: '+91 98200 22222', landline: '022 2345 6789',
  email: ' Meera@Shah.Example ', city: 'Pune', pin_code: '411001', country: 'India', gstin: '27aaacs1234f1z5', customer_type: 'Builder / Architect', assigned_agent_id: AGENT,
  custom_fields: { cf_segment: SEG, cf_credit_limit: '50000', cf_visits_per_year: '4' } }
ok('required custom and standard fields are checked', await refused('cr_sales', `select public.support_customer_save_v2(null, $1::jsonb, false)`, [JSON.stringify({ ...base, city: '' })], /required fields: City/)
  && await refused('cr_sales', `select public.support_customer_save_v2(null, $1::jsonb, false)`, [JSON.stringify({ ...base, custom_fields: {} })], /required fields: Segment/))
ok('invalid GSTIN / PIN / agent refused', await refused('cr_sales', `select public.support_customer_save_v2(null, $1::jsonb, false)`, [JSON.stringify({ ...base, gstin: '27ABC' })], /GSTIN/)
  && await refused('cr_sales', `select public.support_customer_save_v2(null, $1::jsonb, false)`, [JSON.stringify({ ...base, pin_code: '12' })], /PIN code/)
  && await refused('cr_sales', `select public.support_customer_save_v2(null, $1::jsonb, false)`, [JSON.stringify({ ...base, assigned_agent_id: '00000000-0000-4000-8000-000000000000' })], /support agent/))
const n0 = Number(await val(`select count(*) from public.support_customers`))
const m1 = await save2(null, base)
const meera = (await rows(`select * from public.support_customers where id = $1`, [m1.id]))[0]
ok('customer created with standard fields (GSTIN upper-cased, email trimmed, landline among the phones) and SC number', /^SC-\d{6}$/.test(m1.customer_code) && meera.gstin === '27AAACS1234F1Z5'
  && meera.email === 'meera@shah.example' && meera.landline === '022 2345 6789' && meera.phones.length === 3 && meera.assigned_agent_id === AGENT && meera.city === 'Pune', meera)
const vals = Object.fromEntries((await rows(`select d.field_key, v.value_json from public.support_customer_field_values v join public.support_ticket_field_definitions d on d.id = v.field_definition_id where v.customer_id = $1`, [m1.id])).map((r) => [r.field_key, r.value_json]))
ok('custom values saved with the record (defaults applied, formulas never stored)', vals.cf_segment?.label === 'Retail' && vals.cf_credit_limit?.amount === 50000 && vals.cf_warranty === true && !('cf_limit_per_visit' in vals), vals)
const dup = await save2(null, { ...base, display_name: 'Meera S', email: 'other@x.example', custom_fields: { cf_segment: SEG } })
ok('a phone already on another customer is reported, not saved (no duplicate customer)', dup.ok === false && dup.duplicates[0].id === m1.id && Number(await val(`select count(*) from public.support_customers`)) === n0 + 1)
const twin = await save2(null, { display_name: 'Meera (shop)', mobile: '+91 98200 11111', city: 'Pune', custom_fields: { cf_segment: SEG } }, true)
ok('saved as a different customer only when confirmed', twin.ok === true)
await save2(m1.id, { mobile: '98200 33333' })
const meera2 = (await rows(`select * from public.support_customers where id = $1`, [m1.id]))[0]
ok('editing one field keeps everything else (other phones, email, custom values)', meera2.mobile === '98200 33333' && meera2.phones.includes('+91 98200 22222')
  && meera2.phones.includes('022 2345 6789') && !meera2.phones.includes('98200 11111') && meera2.email === 'meera@shah.example'
  && Number(await val(`select count(*) from public.support_customer_field_values where customer_id = $1`, [m1.id])) === 4)
await save2(m1.id, { custom_fields: { cf_visits_per_year: '6' } })
ok('editing a custom value keeps the other custom values', Number(await val(`select (value_json)::text from public.support_customer_field_values v join public.support_ticket_field_definitions d on d.id = v.field_definition_id where v.customer_id = $1 and d.field_key = 'cf_visits_per_year'`, [m1.id])) === 6
  && Number(await val(`select count(*) from public.support_customer_field_values where customer_id = $1`, [m1.id])) === 4)
ok('a support viewer cannot create customers', await refused('cr_view', `select public.support_customer_save_v2(null, $1::jsonb, false)`, [JSON.stringify(base)], /support\.reply/))
const legacy2 = (await op(`select public.support_customer_save(null, '{"display_name":"Old Form","phones":["9123456789"]}'::jsonb)`)).id
ok('customers saved by the earlier form still get their mobile label', (await val(`select mobile from public.support_customers where id = $1`, [legacy2])) === '9123456789')

console.log('\nMatching (New Ticket)')
const look = (phone, email, user = 'cr_sales') => as(user)(`select public.support_customer_lookup($1, $2)`, [phone, email])
let L = await look('09820033333', null)
ok('mobile with 0 prefix and no spaces → found, matched on Mobile', L.length === 1 && L[0].id === m1.id && L[0].matched_on.join() === 'Mobile', L)
L = await look('+91-98200-22222', null)
ok('alternate phone matched', L[0]?.matched_on.join() === 'Alternate phone')
L = await look('022 2345 6789', null)
ok('landline matched', L[0]?.id === m1.id && L[0].matched_on.join() === 'Landline', L)
L = await look(null, '  MEERA@shah.example ')
ok('email trimmed and case-insensitive', L[0]?.id === m1.id && L[0].matched_on.join() === 'Email')
L = await look('9820011111', null)
ok('a number shared by two customers returns the one that has it (no guessing)', L.length === 1 && L[0].id === twin.id, L)
await save2(twin.id, { alternate_phone: '98200 33333' }, true)
L = await look('9820033333', null)
ok('several customers with the same number: all are returned for the agent to choose', L.length === 2 && new Set(L.map((x) => x.id)).size === 2, L)
L = await look('9876543210', null)
ok('existing customers match by their stored numbers', L.some((x) => x.id === legacy))
ok('another company\'s customers are never matched', (await as('b_op')(`select public.support_customer_lookup('9876543210', 'ravi@customer.example')`)).length === 0)
ok('the existing matcher gives the same answer (now through the index)', (await op(`select public.support_customer_matches('9876543210', null)`)).some((x) => x.id === legacy))

console.log('\nTickets of the customer')
const t1 = (await as('cr_sales')(`select public.support_ticket_create_v2($1::jsonb)`, [JSON.stringify({ subject: 'Basin cracked', customer_id: m1.id, priority: 'HIGH', custom_fields: {}, products: [] })])).id
const t2 = (await as('cr_sales')(`select public.support_ticket_create_v2($1::jsonb)`, [JSON.stringify({ subject: 'Tap leaking', customer_id: m1.id, custom_fields: {}, products: [] })])).id
ok('the ticket stores the customer id', (await val(`select customer_id::text from public.support_tickets where id = $1`, [t1])) === m1.id)
const stages = Object.fromEntries((await rows(`select s.stage_name, s.id::text from public.support_pipeline_stages s join public.support_pipelines p on p.id = s.pipeline_id where p.company_id = $1 and p.is_default`, [A])).map((r) => [r.stage_name, r.id]))
await as('cr_sales')(`select public.support_ticket_move_stage($1, $2, $3)`, [t1, stages['In Progress'], stages['New Ticket']])
await as('cr_sales')(`select public.support_ticket_move_stage($1, $2, $3)`, [t2, stages['Closed – Positive'], stages['New Ticket']])
const prod = await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, model_number) values (private.current_company_id(), 'CR-BASIN', 'CRM Basin', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', 'CB-1') returning id::text`)
await op(`select public.support_ticket_products_save($1, $2::jsonb, false)`, [t1, JSON.stringify([{ product_id: prod, quantity: 2 }])])
const tickets = (f) => as('cr_sales')(`select public.support_customer_tickets($1, $2)`, [m1.id, f])
const all = await tickets('ALL')
ok('Tickets tab: every linked ticket with pipeline, stage, agent, SLA and dates', all.length === 2 && all.every((t) => t.pipeline === 'Customer Support' && t.stage && t.sla_status && t.created_at)
  && all.find((t) => t.id === t2).closed_at !== null)
ok('filters: open / in progress / resolved / on hold', (await tickets('OPEN')).map((t) => t.id).join() === t1 && (await tickets('IN_PROGRESS')).length === 1
  && (await tickets('RESOLVED')).map((t) => t.id).join() === t2 && (await tickets('ON_HOLD')).length === 0 && (await tickets('CLOSED')).length === 0)
ok('no copy of the tickets: the same rows as support_tickets', Number(await val(`select count(*) from public.support_tickets where customer_id = $1`, [m1.id])) === all.length)

console.log('\nNotes, activities, calls')
const note = (await as('cr_sales')(`select public.support_customer_note_save($1, null, 'Prefers calls after 5 pm')`, [m1.id])).id
await as('cr_sales')(`select public.support_customer_note_save($1, $2, 'Prefers calls after 6 pm')`, [m1.id, note])
ok('the author edits a note; the earlier text is kept in its history', (await val(`select body from public.support_internal_notes where id = $1`, [note])) === 'Prefers calls after 6 pm'
  && (await as('cr_view')(`select public.support_customer_note_history($1)`, [note]))[0].body === 'Prefers calls after 5 pm')
ok('another agent without manage_notes cannot edit it', await refused('cr_view', `select public.support_customer_note_save($1, $2, 'x')`, [m1.id, note], /support\.reply/))
await db.exec(`reset role; delete from public.role_permissions where role_id = (select id from public.roles where code = 'SALES_MANAGER') and permission_id = (select id from public.permissions where code = 'support_customers.manage_notes')`)
ok('a colleague (no manage_notes) cannot edit or delete someone else\'s note', await refused('cr_sales2', `select public.support_customer_note_delete($1)`, [note], /Only the author/))
await db.exec(`reset role; insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'SALES_MANAGER' and p.code = 'support_customers.manage_notes'`)
const note2 = (await as('cr_sales')(`select public.support_customer_note_save($1, null, 'Temporary note')`, [m1.id])).id
await as('cr_sales2')(`select public.support_customer_note_delete($1)`, [note2])
ok('with manage_notes a note can be deleted: hidden, text kept in history', (await as('cr_sales')(`select public.support_customer_workspace($1)`, [m1.id])).notes.length === 1
  && (await op(`select public.support_customer_note_history($1)`, [note2]))[0].action === 'DELETED')
const act = (await as('cr_sales')(`select public.support_customer_activity_save($1, null, $2::jsonb)`, [m1.id, JSON.stringify({ activity_type: 'VISIT', title: 'Site visit', due_at: '2026-12-01T10:00:00Z', assigned_user_id: OP, priority: 'HIGH', ticket_id: t1 })])).id
const done = await as('cr_sales')(`select public.support_customer_activity_save($1, $2, '{"status":"DONE"}'::jsonb)`, [m1.id, act])
ok('activity created and completed (completion date set)', done.status === 'DONE' && done.completed_at)
ok('activity rules: viewer refused, foreign user refused, ticket of another customer refused',
  await refused('cr_view', `select public.support_customer_activity_save($1, null, '{"title":"x"}'::jsonb)`, [m1.id], /manage_activities/)
  && await refused('cr_sales', `select public.support_customer_activity_save($1, null, $2::jsonb)`, [m1.id, JSON.stringify({ title: 'x', assigned_user_id: await val(`select rls_test.id('b_op')::text`) })], /active employee/)
  && await refused('cr_sales', `select public.support_customer_activity_save($1, null, $2::jsonb)`, [m1.id, JSON.stringify({ title: 'x', ticket_id: orphan })], /belong to this customer/))
const call = await val(`insert into public.support_calls (company_id, direction, status, customer_number_e164, customer_id, created_at, duration_seconds) values ($1, 'INBOUND', 'MISSED', '+919820033333', $2, now(), 0) returning id::text`, [A, m1.id])

console.log('\nTimeline and tabs')
const tl = await as('cr_sales')(`select public.support_customer_timeline($1, 100, null)`, [m1.id])
const types = new Set(tl.map((e) => e.type))
for (const t of ['CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'TICKET_CREATED', 'STAGE_CHANGED', 'TICKET_RESOLVED', 'NOTE_ADDED', 'CALL_MISSED', 'PRODUCT_LINKED', 'ACTIVITY_CREATED', 'ACTIVITY_COMPLETED']) ok(`timeline: ${t}`, types.has(t), [...types])
ok('timeline is newest first and every event links to its record', tl.every((e, i) => i === 0 || e.at <= tl[i - 1].at) && tl.every((e) => e.link_type && e.link_id))
ok('timeline links point at this customer\'s records only', tl.filter((e) => e.link_type === 'TICKET').every((e) => [t1, t2].includes(e.link_id)) && tl.some((e) => e.link_id === call))
ok('the deleted note is not on the timeline', !tl.some((e) => e.link_id === note2))
ok('paging: events before a time', (await as('cr_sales')(`select public.support_customer_timeline($1, 2, $2)`, [m1.id, tl[1].at])).every((e) => e.at < tl[1].at))
const recs = (k, user = 'cr_sales') => as(user)(`select public.support_customer_records($1, $2)`, [m1.id, k])
ok('Calls tab', (await recs('CALLS')).some((c) => c.id === call && c.status === 'MISSED'))
const pr = await recs('PRODUCTS')
ok('Products tab: product, SKU, model, complaints, last complaint, related tickets', pr.length === 1 && pr[0].sku === 'CR-BASIN' && pr[0].model_number === 'CB-1' && pr[0].complaints === 1 && pr[0].tickets[0].id === t1)
ok('Products tab needs the ticket products permission', await refused('cr_view', `select public.support_customer_records($1, 'PRODUCTS')`, [m1.id], /support_ticket_products\.view/))
ok('Emails / WhatsApp / Files tabs answer (empty here)', Array.isArray(await recs('EMAIL')) && Array.isArray(await recs('WHATSAPP')) && Array.isArray(await recs('FILES')))
const ws = await as('cr_sales')(`select public.support_customer_workspace($1)`, [m1.id])
ok('workspace: customer, agent, custom fields in order, metrics', ws.customer.customer_code === m1.customer_code && ws.assigned_agent === undefined && ws.customer.assigned_agent.display_name === 'Op Agent'
  && ws.fields[0].field_key === 'cf_segment' && ws.metrics.total === 2 && ws.metrics.open === 1 && ws.metrics.closed === 1 && Number(ws.metrics.product_complaints) === 1, ws.metrics)
ok('workspace: notes (author can edit), activities, permissions', ws.notes[0].can_edit && ws.activities[0].status === 'DONE' && ws.can.activities && ws.can.edit)
ok('a viewer does not see manager-only custom fields or products', (await as('cr_view')(`select public.support_customer_workspace($1)`, [m1.id])).metrics.product_complaints === null)

console.log('\nCustomer report')
const rep = await as('cr_sales')(`select public.support_customer_report(current_date - 30, current_date)`)
const mr = rep.customers.find((c) => c.customer_id === m1.id)
ok('customer metrics: tickets, open, closed, reopened, product complaints; trend and products by customer', mr?.tickets === 2 && mr.open === 1 && mr.closed === 1 && Number(mr.product_complaints) === 1
  && rep.trend.some((t) => t.customer_id === m1.id) && rep.products_by_customer.some((x) => x.customer_id === m1.id && x.sku === 'CR-BASIN'), rep)
ok('the report needs report access', await refused('cr_view', `select public.support_customer_report(null, null)`, [], /view_reports/))

console.log('\nCompany isolation and read-only')
ok('company B cannot open company A\'s customer, tickets, timeline, records or notes', await refused('b_op', `select public.support_customer_workspace($1)`, [m1.id], /not found in your company/)
  && await refused('b_op', `select public.support_customer_tickets($1, 'ALL')`, [m1.id], /not found/) && await refused('b_op', `select public.support_customer_timeline($1, 10, null)`, [m1.id], /not found/)
  && await refused('b_op', `select public.support_customer_note_save($1, null, 'x')`, [m1.id], /not found/) && await refused('b_op', `select public.support_customer_save_v2($1, '{"city":"X"}'::jsonb, false)`, [m1.id], /not found/))
const rls = await request('b_op', `select (select count(*) from public.support_customer_field_values) + (select count(*) from public.support_customer_activities) + (select count(*) from public.support_note_revisions)`)
ok('RLS: company B reads none of company A\'s customer values, activities or note history', Number(rls.value) === 0, rls)
for (const q of [`select public.support_customer_form()`, `select public.support_fields_admin('CUSTOMER')`, `select public.support_customer_workspace('${m1.id}')`, `select public.support_customer_tickets('${m1.id}', 'OVERDUE')`,
  `select public.support_customer_timeline('${m1.id}', 50, null)`, `select public.support_customer_records('${m1.id}', 'CALLS')`, `select public.support_customer_lookup('9820033333', null)`,
  `select public.support_customer_report(null, null)`, `select public.support_customer_note_history('${note}')`]) {
  const x = await request('op', q, [], true)
  ok(`${q.slice(14, 58)} runs read-only`, !x.error, x.error)
}

console.log('\nReset allowlist and rollback')
ok('reset allowlist has the three new tables, note history before notes', Number(await val(`select count(*) from private.erp_reset_tables() where table_name in ('support_customer_field_values', 'support_customer_activities', 'support_note_revisions')`)) === 3
  && Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_note_revisions'`)) < Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_internal_notes'`)))
const down = await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`))
await db.exec('reset role')
ok('rollback refuses while customer values, activities or note history exist', await db.exec(down).then(() => false, (e) => /Export them/.test(e.message)))
await db.exec(`set app.support_crm_rollback_force = 'on'`)
await db.exec(down)
await db.exec(`reset app.support_crm_rollback_force`)
ok('rollback: customers, tickets and ticket fields kept; customer fields and columns gone', Number(await val(`select count(*) from public.support_customers where id = $1`, [m1.id])) === 1
  && Number(await val(`select count(*) from public.support_ticket_field_definitions`)) === 3 && !(await val(`select exists (select 1 from information_schema.columns where table_name = 'support_customers' and column_name = 'gstin')`))
  && Boolean((await op(`select public.support_ticket_fields_admin()`)).stamp))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback', Boolean((await op(`select public.support_fields_admin('CUSTOMER')`)).stamp))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
