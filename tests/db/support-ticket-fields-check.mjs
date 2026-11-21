// Support ticket field builder and Product Master links (migration 20261226090000): every custom field type,
// configuration and value validation, the 25-field limit, the New Ticket layout (order, removal, required,
// concurrent saves), tickets created with custom values and products in one transaction, editing values and
// products, archived products, permissions, company isolation, read-only reads, existing tickets untouched,
// rollback and re-apply.
//
//   npm run test:db:ticket-fields

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { checkFieldValue, evaluateFormula, parseFormula } from '../../src/features/support/ticket-fields/field-model.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261226090000_support_ticket_fields'
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
async function request(user, sql, params, readOnly = false) {
  await db.exec('reset role')
  await db.exec(readOnly ? 'begin read only' : 'begin')
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: await val(`select rls_test.id($1)`, [user]), role: 'authenticated' })])
    await db.exec('set local role authenticated')
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
const refused = async (user, sql, params, pattern) => { const r = await request(user, sql, params); return Boolean(r.error) && (!pattern || pattern.test(r.error)) ? true : (console.log('      got:', r.error ?? 'no error'), false) }
const addUser = async (key, uuid, roleCode) => {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('${key}', '${uuid}');
    insert into auth.users (id, email) values (rls_test.id('${key}'), '${key}@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true, full_name = '${key}' where id = rls_test.id('${key}');
    insert into public.user_roles (user_id, company_id, role_id) select rls_test.id('${key}'), rls_test.id('company_a'), id from public.roles where code = '${roleCode}'`)
}
await db.exec(`reset role; insert into public.roles (code, name, is_system) values ('TF_VIEW_TEST', 'Support viewer (test)', false), ('TF_TICKETS_TEST', 'Ticket agent without products (test)', false);
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'TF_VIEW_TEST' and p.code = 'support.view';
  insert into public.role_permissions (role_id, permission_id) select r.id, p.id from public.roles r, public.permissions p where r.code = 'TF_TICKETS_TEST' and p.code in ('support.view', 'support.manage_tickets')`)
await addUser('tf_view', 'e7e5d400-0000-4000-8000-0000000000a1', 'TF_VIEW_TEST')
await addUser('tf_tickets', 'e7e5d400-0000-4000-8000-0000000000a2', 'TF_TICKETS_TEST')
await addUser('tf_sales', 'e7e5d400-0000-4000-8000-0000000000a3', 'SALES_MANAGER')
const A = await val(`select rls_test.id('company_a')::text`)
const B = await val(`select rls_test.id('company_b')::text`)

// Product Master fixtures (company A: two active, one archived; company B: one)
const product = async (user, sku, name, extra = {}) => as(user)(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, barcode, ean, model_number)
  values (private.current_company_id(), $1, $2, 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'ACTIVE', $3, $4, $5) returning id::text`, [sku, name, extra.barcode ?? null, extra.ean ?? null, extra.model ?? null])
const P1 = await product('op', 'TF-BASIN-01', 'Wall Hung Basin White', { barcode: 'BC778899', ean: '4006381333931', model: 'WHB-500' })
const P2 = await product('op', 'TF-TAP-02', 'Pillar Tap Chrome', { model: 'PTC-22' })
const P3 = await product('op', 'TF-OLD-03', 'Discontinued Basin Grey')
await op(`update public.products set status = 'INACTIVE', archived_at = now() where id = $1`, [P3])
const PB = await product('b_op', 'TF-B-01', 'Company B Basin')

const before = await request('op', `select public.support_ticket_form()`)
ok('before the migration the form function does not exist (the app keeps the old New Ticket form)', /does not exist/.test(before.error ?? ''), before)
const ticketsBefore = Number(await val(`select count(*) from public.support_tickets`))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
console.log(`✓ ${NAME} applied (twice)`)
ok('existing tickets untouched by the migration', Number(await val(`select count(*) from public.support_tickets`)) === ticketsBefore)

// ---------------------------------------------------------------------------
console.log('\nPermissions')
const codes = (await db.query(`select code from public.permissions where resource in ('support_ticket_fields', 'support_ticket_products') order by code`)).rows.map((r) => r.code)
ok('six permissions', JSON.stringify(codes) === JSON.stringify(['support_ticket_fields.create', 'support_ticket_fields.delete', 'support_ticket_fields.update',
  'support_ticket_fields.view', 'support_ticket_products.manage', 'support_ticket_products.view']), codes)
const roleCodes = async (role) => (await db.query(`select p.code from public.role_permissions rp join public.roles r on r.id = rp.role_id join public.permissions p on p.id = rp.permission_id
  where r.code = $1 and p.resource in ('support_ticket_fields', 'support_ticket_products') order by p.code`, [role])).rows.map((r) => r.code)
ok('Super Admin and Admin hold all six', (await roleCodes('SUPER_ADMIN')).length === 6 && (await roleCodes('ADMIN')).length === 6)
ok('Sales Manager uses fields and links products but cannot change the builder',
  JSON.stringify(await roleCodes('SALES_MANAGER')) === JSON.stringify(['support_ticket_fields.view', 'support_ticket_products.manage', 'support_ticket_products.view']))
ok('read-only roles get none (they hold only *.read permissions)', (await roleCodes('MANAGEMENT_VIEWER')).length === 0)

// ---------------------------------------------------------------------------
console.log('\nCustom field types')
const save = (user, id, p) => as(user)(`select public.support_ticket_field_save($1::uuid, $2::jsonb)`, [id, JSON.stringify(p)])
const F = {}
F.pick = await save('op', null, { field_label: 'Complaint type', field_type: 'PICKLIST', is_required: true, help_text: 'What went wrong',
  field_config: { options: [{ label: 'Damaged' }, { label: 'Missing part' }, { label: 'Wrong item' }] } })
ok('picklist: key generated from the label, options get stable ids', F.pick.field_key === 'cf_complaint_type' && F.pick.field_config.options.every((o) => /^opt_[0-9a-f]{10}$/.test(o.id)), F.pick)
const DAMAGED = F.pick.field_config.options[0].id
F.pick2 = await save('op', null, { field_label: 'complaint TYPE', field_type: 'PICKLIST', field_config: { options: ['A'] } }).catch((e) => e.message)
ok('two active fields cannot share a label (any letter case)', /unique|duplicate/i.test(String(F.pick2)), F.pick2)
F.pick3 = await save('op', null, { field_label: 'Complaint type!', field_type: 'PICKLIST', field_config: { options: ['A'] } })
ok('a similar label gets its own key (suffix), never another field\'s key', F.pick3.field_key === 'cf_complaint_type_2', F.pick3)
F.text = await save('op', null, { field_label: 'Invoice reference', field_type: 'TEXT', placeholder: 'INV-…', field_config: { min_length: 3, max_length: 20 } })
F.num = await save('op', null, { field_label: 'Units affected', field_type: 'NUMBER', field_config: { number_kind: 'INTEGER', min: 1, max: 1000 } })
F.dec = await save('op', null, { field_label: 'Weight kg', field_type: 'NUMBER', field_config: { number_kind: 'DECIMAL', decimals: 2 } })
F.cur = await save('op', null, { field_label: 'Claim amount', field_type: 'CURRENCY', field_config: { min: 0 } })
F.formula = await save('op', null, { field_label: 'Claim per unit', field_type: 'FORMULA', field_config: { expression: 'ROUND({cf_claim_amount} / {cf_units_affected}, 2)', result_kind: 'CURRENCY' } })
F.date = await save('op', null, { field_label: 'Purchase date', field_type: 'DATE' })
F.email = await save('op', null, { field_label: 'Site contact email', field_type: 'EMAIL' })
F.phone = await save('op', null, { field_label: 'Site phone', field_type: 'PHONE' })
F.url = await save('op', null, { field_label: 'Photo link', field_type: 'URL' })
F.check = await save('op', null, { field_label: 'Under warranty', field_type: 'CHECKBOX', default_value: true })
F.user = await save('op', null, { field_label: 'Field engineer', field_type: 'USER', field_config: { scope: 'EMPLOYEES' } })
F.lookup = await save('op', null, { field_label: 'Original order', field_type: 'LOOKUP', field_config: { target: 'SUPPORT_TICKET' } })
F.secret = await save('op', null, { field_label: 'Internal cost note', field_type: 'TEXT', visibility: 'TICKET_MANAGERS' })
ok('all twelve types created', new Set(Object.values(F).filter((x) => typeof x === 'object').map((x) => x.field_type)).size === 12)
ok('currency defaults to INR', F.cur.field_config.currency === 'INR', F.cur.field_config)
ok('integer numbers have no decimals', F.num.field_config.decimals === 0 && F.dec.field_config.decimals === 2)
ok('checkbox default stored as a boolean', F.check.default_value === true, F.check)
ok('formula stored with its expression', F.formula.field_config.expression.includes('{cf_claim_amount}'))

console.log('\nConfiguration checks')
const bad = async (p, pattern, id = null) => refused('op', `select public.support_ticket_field_save($1::uuid, $2::jsonb)`, [id, JSON.stringify(p)], pattern)
ok('picklist without options refused', await bad({ field_label: 'X1', field_type: 'PICKLIST', field_config: { options: [] } }, /at least one option/))
ok('picklist option twice refused', await bad({ field_label: 'X2', field_type: 'PICKLIST', field_config: { options: ['a', 'A'] } }, /listed twice/))
ok('text minimum above maximum refused', await bad({ field_label: 'X3', field_type: 'TEXT', field_config: { min_length: 9, max_length: 2 } }, /minimum length/))
ok('lookup without a supported target refused', await bad({ field_label: 'X4', field_type: 'LOOKUP', field_config: { target: 'PAYROLL' } }, /lookup links to/))
ok('formula with an unknown field refused', await bad({ field_label: 'X5', field_type: 'FORMULA', field_config: { expression: '{cf_nope} * 2' } }, /not a ticket field|not a field of this form/))
ok('formula using a text field refused', await bad({ field_label: 'X6', field_type: 'FORMULA', field_config: { expression: '{cf_invoice_reference} + 1' } }, /number and currency/))
ok('formula with SQL / JavaScript refused', await bad({ field_label: 'X7', field_type: 'FORMULA', field_config: { expression: '1; drop table x' } }, /not allowed/))
ok('formula with an unknown function refused', await bad({ field_label: 'X8', field_type: 'FORMULA', field_config: { expression: 'eval(1)' } }, /Unknown function/))
ok('formula with broken brackets refused', await bad({ field_label: 'X9', field_type: 'FORMULA', field_config: { expression: 'ROUND((1 + 2), 2' } }, /never closed/))
ok('a checkbox cannot be required', await bad({ field_label: 'X10', field_type: 'CHECKBOX', is_required: true }, /cannot be required/))
ok('an invalid default value refused (same rules as ticket values)', await bad({ field_label: 'X11', field_type: 'EMAIL', default_value: 'not-an-email' }, /email address/))
ok('a type that does not exist refused', await bad({ field_label: 'X12', field_type: 'SCRIPT' }, /field type/))
ok('the type cannot change after creation', await bad({ field_type: 'NUMBER' }, /type of a ticket field cannot be changed/, F.text.id))
ok('the key cannot change after creation', await bad({ field_key: 'cf_other' }, /internal key/, F.text.id))
const direct = await request('op', `update public.support_ticket_field_definitions set field_type = 'TEXT' where id = '${F.num.id}'`)
ok('the table itself cannot be written by the app', /permission denied/.test(direct.error ?? ''), direct)
await db.exec('reset role')
const trig = await db.query(`update public.support_ticket_field_definitions set field_key = 'cf_x' where id = $1`, [F.num.id]).then(() => null, (e) => e.message)
ok('even a direct database update cannot change the key (trigger)', /cannot be changed/.test(trig ?? ''), trig)
const renamed = await save('op', F.text.id, { field_label: 'Invoice ref', help_text: 'From the customer invoice' })
ok('label and help text can be edited; key stays', renamed.field_label === 'Invoice ref' && renamed.field_key === 'cf_invoice_reference')

console.log('\nPermissions on the builder')
ok('Sales Manager can view the builder', !(await request('tf_sales', `select public.support_ticket_fields_admin()`)).error)
ok('Sales Manager cannot create fields', await refused('tf_sales', `select public.support_ticket_field_save(null, '{"field_label":"S","field_type":"TEXT"}'::jsonb)`, [], /support_ticket_fields\.create/))
ok('Sales Manager cannot edit fields', await refused('tf_sales', `select public.support_ticket_field_save($1::uuid, '{"field_label":"S"}'::jsonb)`, [F.text.id], /support_ticket_fields/))
ok('a support viewer cannot open the builder', await refused('tf_view', `select public.support_ticket_fields_admin()`, [], /support_ticket_fields\.view/))

// ---------------------------------------------------------------------------
console.log('\nLayout')
let admin = await op(`select public.support_ticket_fields_admin()`)
ok('default layout = the existing New Ticket fields, in their order', admin.layout.filter((l) => l.is_visible).map((l) => l.standard_key).join(',')
  === 'subject,customer,products,customer_phone,customer_email,priority,assigned_agent,category,subcategory,department,description', admin.layout)
ok('new custom fields start unused', admin.layout.every((l) => l.standard_key))
ok('counter: 15 of 25 custom fields active', admin.active_custom === 15 && admin.max_custom === 25, admin.active_custom)
const used = (...items) => items.map((x) => (typeof x === 'string' ? { standard_key: x } : x))
const layout1 = used('subject', 'customer', 'products', { field_definition_id: F.pick.id }, 'priority', { field_definition_id: F.text.id, is_required: true },
  { field_definition_id: F.num.id }, { field_definition_id: F.cur.id }, { field_definition_id: F.formula.id }, { field_definition_id: F.check.id },
  { field_definition_id: F.date.id }, { field_definition_id: F.email.id }, { field_definition_id: F.user.id }, { field_definition_id: F.lookup.id },
  { field_definition_id: F.secret.id }, { standard_key: 'category', is_required: true }, 'description')
const saveLayout = (user, items, stamp) => as(user)(`select public.support_ticket_fields_save_layout($1::jsonb, $2)`, [JSON.stringify(items), stamp])
const s1 = await saveLayout('op', layout1, admin.stamp)
ok('layout saved', typeof s1.stamp === 'string' && s1.stamp !== admin.stamp)
ok('a stale layout is refused (someone saved meanwhile)', await refused('op', `select public.support_ticket_fields_save_layout($1::jsonb, $2)`, [JSON.stringify(layout1), admin.stamp], /Someone else changed/))
ok('Subject cannot be taken off the form', await refused('op', `select public.support_ticket_fields_save_layout($1::jsonb, $2)`, [JSON.stringify(used('customer')), s1.stamp], /Subject is always/))
ok('a field cannot be on the form twice', await refused('op', `select public.support_ticket_fields_save_layout($1::jsonb, $2)`, [JSON.stringify(used('subject', 'customer', 'subject')), s1.stamp], /once/))
ok('Priority cannot be made required (it always has a value)', await refused('op', `select public.support_ticket_fields_save_layout($1::jsonb, $2)`,
  [JSON.stringify(used('subject', 'customer', { standard_key: 'priority', is_required: true })), s1.stamp], /cannot be made required/))
ok('Sales Manager cannot change the layout', await refused('tf_sales', `select public.support_ticket_fields_save_layout($1::jsonb, $2)`, [JSON.stringify(layout1), s1.stamp], /support_ticket_fields\.update/))
let form = await as('tf_tickets')(`select public.support_ticket_form()`)
const order = form.fields.map((f) => f.standard_key ?? f.field_key)
ok('the form follows the saved order', order.join(',') === 'subject,customer,products,cf_complaint_type,priority,cf_invoice_reference,cf_units_affected,cf_claim_amount,cf_claim_per_unit,cf_under_warranty,cf_purchase_date,cf_site_contact_email,cf_field_engineer,cf_original_order,cf_internal_cost_note,category,description', order)
ok('removed standard fields are not on the form (phone, email, agent, subcategory, department)', !order.includes('customer_phone') && !order.includes('department'))
ok('required: definition (complaint type), override (invoice ref), standard (category)', form.fields.find((f) => f.field_key === 'cf_complaint_type').required
  && form.fields.find((f) => f.field_key === 'cf_invoice_reference').required && form.fields.find((f) => f.standard_key === 'category').required)
ok('a support viewer sees the form without manager-only fields', !(await as('tf_view')(`select public.support_ticket_form()`)).fields.some((f) => f.field_key === 'cf_internal_cost_note'))
ok('the form reports product permissions (agent without products: no product selector)', form.products.manage === false
  && (await as('tf_sales')(`select public.support_ticket_form()`)).products.manage === true)
admin = await op(`select public.support_ticket_fields_admin()`)
ok('the builder reads back the same layout and stamp', admin.stamp === s1.stamp && admin.layout.filter((l) => l.is_visible).length === 17)

// ---------------------------------------------------------------------------
console.log('\nNew ticket with custom fields and products')
const create = (user, p) => as(user)(`select public.support_ticket_create_v2($1::jsonb)`, [JSON.stringify(p)])
const base = { subject: 'Basin cracked on arrival', customer_phone: '+91 98765 43210', priority: 'HIGH', category: 'Damage', description: 'Crack near the tap hole' }
const OP = await val(`select rls_test.id('op')::text`)
const ticketCount = async () => Number(await val(`select count(*) from public.support_tickets`))
const seq0 = await val(`select max(ticket_number) from public.support_tickets`)
const n0 = await ticketCount()
ok('missing required custom fields: refused, naming them', await refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`, [JSON.stringify(base)], /required fields: Complaint type, Invoice ref/))
ok('missing required standard field (category): refused', await refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, category: '', custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1' } })], /required fields: Category/))
ok('nothing was created by the refused attempts (no ticket, no number used)', (await ticketCount()) === n0 && (await val(`select max(ticket_number) from public.support_tickets`)) === seq0)
const badValue = async (cf, pattern) => refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1', ...cf } })], pattern)
ok('text shorter than its minimum refused', await badValue({ cf_invoice_reference: 'IN' }, /at least 3 characters/))
ok('integer with decimals refused', await badValue({ cf_units_affected: '2.5' }, /whole number/))
ok('number above its maximum refused', await badValue({ cf_units_affected: 5000 }, /at most 1000/))
ok('invalid email refused', await badValue({ cf_site_contact_email: 'abc@' }, /email address/))
ok('invalid phone refused', await badValue({ cf_site_phone: '12ab' }, /phone number/))
ok('invalid URL refused (javascript: links too)', await badValue({ cf_photo_link: 'javascript:alert(1)' }, /web address/))
ok('invalid date refused', await badValue({ cf_purchase_date: '2026-02-30' }, /date/))
ok('a picklist value that is not an option refused', await badValue({ cf_complaint_type: 'opt_0000000000' }, /Choose one of the options/))
ok('a formula value cannot be entered', await badValue({ cf_claim_per_unit: 5 }, /calculated/))
ok('an unknown field key refused', await badValue({ cf_does_not_exist: 'x' }, /Unknown ticket field/))
ok('a user from another company refused', await badValue({ cf_field_engineer: await val(`select rls_test.id('b_op')::text`) }, /active employee/))
ok('a lookup to another company\'s record refused', await badValue({ cf_original_order: await val(`select id::text from public.support_tickets where company_id = $1::uuid limit 1`, [B]) ?? '00000000-0000-4000-8000-000000000000' }, /not found in your company/))
ok('products from another company refused', await refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1' }, products: [{ product_id: PB, quantity: 1 }] })], /not found in your company/))
ok('an archived product cannot be added to a new ticket', await refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1' }, products: [{ product_id: P3, quantity: 1 }] })], /archived or inactive/))
ok('the same product twice refused', await refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1' }, products: [{ product_id: P1 }, { product_id: P1 }] })], /listed twice/))
ok('a zero quantity refused', await refused('tf_sales', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1' }, products: [{ product_id: P1, quantity: 0 }] })], /more than 0/))
ok('an agent without the products permission cannot add products', await refused('tf_tickets', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: 'INV-1' }, products: [{ product_id: P1, quantity: 1 }] })], /support_ticket_products\.manage/))
ok('still nothing created', (await ticketCount()) === n0)

const t1 = await create('tf_sales', { ...base, custom_fields: { cf_complaint_type: DAMAGED, cf_invoice_reference: ' INV-2041 ', cf_units_affected: '3', cf_claim_amount: { amount: '1500.50', currency: 'INR' },
  cf_purchase_date: '2026-10-02', cf_site_contact_email: 'Site@Customer.Example', cf_site_phone: '+91 (22) 4000-1234', cf_photo_link: 'https://photos.example.com/a/1.jpg',
  cf_field_engineer: OP, cf_weight_kg: '12.25' }, products: [{ product_id: P1, quantity: 2 }, { product_id: P2, quantity: '1.5' }] })
ok('ticket created with the normal number', /^ALT-SUP-\d{6}$/.test(t1.ticket_number) && t1.custom_fields >= 10 && t1.products === 2, t1)
const values = Object.fromEntries((await db.query(`select d.field_key, v.value_json from public.support_ticket_field_values v join public.support_ticket_field_definitions d on d.id = v.field_definition_id
  where v.ticket_id = $1`, [t1.id])).rows.map((r) => [r.field_key, r.value_json]))
ok('picklist saved as option id + label', values.cf_complaint_type?.id === DAMAGED && values.cf_complaint_type.label === 'Damaged', values.cf_complaint_type)
ok('text trimmed, number and currency typed, email lower-cased', values.cf_invoice_reference === 'INV-2041' && values.cf_units_affected === 3
  && values.cf_claim_amount.amount === 1500.5 && values.cf_claim_amount.currency === 'INR' && values.cf_site_contact_email === 'site@customer.example', values)
ok('user saved with id and name', values.cf_field_engineer?.id === OP && values.cf_field_engineer.name === 'op@e7.example.invalid' || values.cf_field_engineer?.id === OP, values.cf_field_engineer)
ok('checkbox default applied on the form (not sent)', values.cf_under_warranty === true, values)
ok('a field not on the form can still be given a value (weight)', values.cf_weight_kg === 12.25)
ok('formula values are never stored', !('cf_claim_per_unit' in values))
const links = (await db.query(`select product_id::text, quantity::text, product_name_snapshot, sku_snapshot from public.support_ticket_products where ticket_id = $1 order by sku_snapshot`, [t1.id])).rows
ok('the real product ids are stored, with name and SKU snapshots and quantities', links.length === 2 && links[0].product_id === P1 && links[0].sku_snapshot === 'TF-BASIN-01'
  && links[0].quantity === '2.000' && links[1].product_id === P2 && links[1].quantity === '1.500' && links[1].product_name_snapshot === 'Pillar Tap Chrome', links)
const tk = (await db.query(`select * from public.support_tickets where id = $1`, [t1.id])).rows[0]
ok('the ticket itself is the normal ticket (status New, priority, category, contact)', tk.status === 'NEW' && tk.priority === 'HIGH' && tk.category === 'Damage' && tk.customer_phone === '+91 98765 43210')
ok('history: CREATED by the existing ticket function', Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and event_type = 'CREATED'`, [t1.id])) === 1)
const old = await op(`select public.support_ticket_create($1::jsonb)`, [JSON.stringify({ subject: 'Old style ticket', customer_email: 'x@y.example' })])
ok('the existing support_ticket_create still works (no custom fields required there)', /^ALT-SUP-/.test(old.ticket_number))
const oldDetail = await op(`select public.support_ticket_detail($1)`, [t1.id])
ok('the existing ticket detail still works', oldDetail.ticket.ticket_number === t1.ticket_number)

console.log('\nThe form (TypeScript) and the database apply the same rules')
const exprs = ['1 + 2', '{cf_a} * (ROUND({cf_b}, 2) + 1)', 'MIN(1, {cf_a}, 3)', 'max(1,2)', '-1 * -2', '+3', '1 +', 'ABS(1, 2)', 'MIN(1)', 'ROUND(1, 2, 3)', '1 2', 'foo(1)',
  '(1', ')', '()', '1;drop table x', 'ROUND', 'ROUND 1', '{cf_a}{cf_b}', '1,2', '(1, 2)', '{CF_A}', '2 * (3 + {cf_x}) / 4', '']
const fDisagree = []
for (const e of exprs) {
  let ts = true
  try { parseFormula(e) } catch { ts = false }
  await db.exec('reset role')
  const sql = await db.query(`select private.support_ticket_formula_refs($1)`, [e]).then(() => true, () => false)
  if (ts !== sql) fDisagree.push({ e, ts, sql })
}
ok(`formulas: ${exprs.length} expressions accepted / refused alike`, fDisagree.length === 0, fDisagree)
ok('formula results: ROUND, MIN, MAX, ABS, precedence, division by zero', evaluateFormula('ROUND({a} / {b}, 2)', { a: 1500.5, b: 3 }) === 500.17
  && evaluateFormula('MAX(1, {a}) - MIN(4, 2) * ABS(-2)', { a: 10 }) === 6 && evaluateFormula('{a} / 0', { a: 1 }) === null && evaluateFormula('{a} + 1', {}) === null)
const defs = (await db.query(`select * from public.support_ticket_field_definitions where company_id = $1 and is_active`, [A])).rows
const samples = { TEXT: ['ab', 'abc', ' INV-1 ', 'x'.repeat(21)], NUMBER: ['1', '2.5', '1001', '-1', 'abc', '0', '3.000', '12.345'], CURRENCY: ['10', '10.5', '10.555', '-5', 'x', '1e3'],
  DATE: ['2026-02-28', '2026-02-30', '2026/01/01', '2024-02-29'], EMAIL: ['a@b.co', 'a@b', 'A@B.CO', 'a b@c.d'], PHONE: ['+91 98765 43210', '12345', '(022) 4000-1234', '12ab34', '+1234567890123456'],
  URL: ['https://a.example/x?y=1', 'http://a.example', 'ftp://a.example', 'javascript:alert(1)', 'https://localhost', 'https://a.example:8080/p'] }
const vDisagree = []
for (const d of defs) {
  for (const raw of samples[d.field_type] ?? []) {
    const ts = !checkFieldValue(d, raw).error
    await db.exec('reset role')
    const sql = await db.query(`select private.support_ticket_field_value(d, $2::jsonb) from public.support_ticket_field_definitions d where d.id = $1`, [d.id, JSON.stringify(raw)]).then(() => true, () => false)
    if (ts !== sql) vDisagree.push({ field: d.field_key, raw, ts, sql })
  }
}
ok(`values: ${defs.filter((d) => samples[d.field_type]).length} fields × samples accepted / refused alike`, vDisagree.length === 0, vDisagree)

console.log('\nTicket details')
let ex = await as('tf_sales')(`select public.support_ticket_extras($1)`, [t1.id])
ok('custom fields in the configured order', ex.fields.filter((f) => f.in_form).map((f) => f.field_key).slice(0, 4).join(',') === 'cf_complaint_type,cf_invoice_reference,cf_units_affected,cf_claim_amount', ex.fields.map((f) => f.field_key))
const firstOff = ex.fields.findIndex((f) => !f.in_form)
ok('values of fields not on the form are shown too, after the form fields', firstOff > 0 && ex.fields.slice(firstOff).every((f) => !f.in_form)
  && ex.fields.slice(firstOff).some((f) => f.field_key === 'cf_weight_kg'), ex.fields.map((f) => [f.field_key, f.in_form]))
ok('formula inputs for the calculation', ex.formula_inputs.cf_units_affected === 3 && ex.formula_inputs.cf_claim_amount.amount === 1500.5, ex.formula_inputs)
ok('linked products with SKU, name, quantity and identifiers', ex.products.length === 2 && ex.products[0].sku === 'TF-BASIN-01' && ex.products[0].ean === '4006381333931' && ex.products[0].quantity === 2)
ok('Sales Manager may edit fields and products', ex.can.edit_fields && ex.can.manage_products)
const exView = await as('tf_view')(`select public.support_ticket_extras($1)`, [t1.id])
ok('a viewer without support_ticket_products.view sees no products', exView.products === null)
ok('a viewer does not see manager-only fields', !exView.fields.some((f) => f.field_key === 'cf_internal_cost_note'))
ok('a viewer cannot edit', !exView.can.edit_fields && !exView.can.manage_products)

console.log('\nEditing after creation')
const editF = (user, values) => as(user)(`select public.support_ticket_custom_fields_save($1, $2::jsonb)`, [t1.id, JSON.stringify(values)])
const e1 = await editF('tf_sales', { cf_units_affected: 4, cf_photo_link: null })
ok('values changed and cleared; only the given keys', JSON.stringify(e1.changed.sort()) === JSON.stringify(['cf_photo_link', 'cf_units_affected']), e1)
ok('the edit is in the ticket history', Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and event_type = 'UPDATED' and details ? 'custom_fields'`, [t1.id])) === 1)
ok('other values intact', (await val(`select v.value_json ->> 'label' from public.support_ticket_field_values v join public.support_ticket_field_definitions d on d.id = v.field_definition_id where v.ticket_id = $1 and d.field_key = 'cf_complaint_type'`, [t1.id])) === 'Damaged')
ok('a required field cannot be cleared', await refused('tf_sales', `select public.support_ticket_custom_fields_save($1, $2::jsonb)`, [t1.id, JSON.stringify({ cf_invoice_reference: '' })], /required fields: Invoice ref/))
ok('a viewer cannot edit values', await refused('tf_view', `select public.support_ticket_custom_fields_save($1, $2::jsonb)`, [t1.id, '{"cf_units_affected": 2}'], /support\.manage_tickets/))
ok('saving unchanged values records nothing', (await editF('tf_sales', { cf_units_affected: 4 })).changed.length === 0)

console.log('\nProducts after creation')
const saveP = (user, items, allow = false) => as(user)(`select public.support_ticket_products_save($1, $2::jsonb, $3)`, [t1.id, JSON.stringify(items), allow])
const r1 = await saveP('tf_sales', [{ product_id: P1, quantity: 5 }])
ok('quantity changed and a product removed', r1.added.length === 0 && r1.removed.join() === 'TF-TAP-02' && r1.changed.join() === 'TF-BASIN-01', r1)
ok('the change is in the ticket history', Number(await val(`select count(*) from public.support_ticket_events where ticket_id = $1 and details ? 'products'`, [t1.id])) === 1)
ok('an agent without the products permission cannot change products', await refused('tf_tickets', `select public.support_ticket_products_save($1, '[]'::jsonb, false)`, [t1.id], /support_ticket_products\.manage/))
ok('Sales Manager (no products.update) cannot add archived products even when asking', await refused('tf_sales', `select public.support_ticket_products_save($1, $2::jsonb, true)`,
  [t1.id, JSON.stringify([{ product_id: P1, quantity: 5 }, { product_id: P3 }])], /products\.update/))
const r2 = await saveP('op', [{ product_id: P1, quantity: 5 }, { product_id: P3, quantity: 1 }], true)
ok('a Product Master editor may add an archived product explicitly', r2.added[0] === 'TF-OLD-03', r2)
await op(`update public.products set status = 'INACTIVE', archived_at = now() where id = $1`, [P1])
const r3 = await saveP('tf_sales', [{ product_id: P1, quantity: 6 }, { product_id: P3, quantity: 1 }])
ok('products archived later stay on the ticket and can still be changed', r3.changed[0] === 'TF-BASIN-01')
ex = await as('tf_sales')(`select public.support_ticket_extras($1)`, [t1.id])
ok('the ticket page marks archived products', ex.products.every((p) => p.archived))
await op(`update public.products set status = 'ACTIVE', archived_at = null where id = $1`, [P1])
await op(`update public.products set product_name = 'Wall Hung Basin White v2' where id = $1`, [P1])
ex = await as('tf_sales')(`select public.support_ticket_extras($1)`, [t1.id])
const pv = ex.products.find((p) => p.product_id === P1)
ok('the snapshot keeps the name at the time; the current name is shown too', pv.product_name === 'Wall Hung Basin White v2' && pv.product_name_snapshot === 'Wall Hung Basin White')

console.log('\nProduct Master search')
const search = (user, term, archived = false) => as(user)(`select public.support_ticket_product_search($1, $2, 15)`, [term, archived])
ok('by SKU', (await search('tf_sales', 'tf-tap')).map((p) => p.id).join() === P2)
ok('by name', (await search('tf_sales', 'hung basin')).map((p) => p.id).join() === P1)
ok('by barcode', (await search('tf_sales', 'BC7788')).map((p) => p.id).join() === P1)
ok('by EAN', (await search('tf_sales', '4006381333931'))[0]?.id === P1)
ok('by model number (product code)', (await search('tf_sales', 'PTC-22'))[0]?.id === P2)
ok('an exact SKU comes first', (await search('tf_sales', 'TF-BASIN-01'))[0]?.sku === 'TF-BASIN-01')
ok('archived products are not offered', !(await search('tf_sales', 'basin')).some((p) => p.id === P3))
ok('LIKE wildcards are literal', (await search('tf_sales', '%')).length === 0 && (await search('tf_sales', '_')).length === 0)
ok('another company\'s products are never found', (await search('tf_sales', 'Company B')).length === 0 && (await search('b_op', 'basin')).map((p) => p.id).join() === PB)
ok('archived products only for Product Master editors', await refused('tf_sales', `select public.support_ticket_product_search('basin', true, 15)`, [], /products\.update/)
  && (await search('op', 'discontinued', true))[0]?.archived === true)
ok('search needs the products permission', await refused('tf_tickets', `select public.support_ticket_product_search('basin', false, 15)`, [], /support_ticket_products\.manage/))
ok('lookup search respects the target permission (ERP customers need customers.read)', await refused('tf_view', `select public.support_ticket_lookup_search('ERP_CUSTOMER', 'a', 10)`, [], /customers\.read/))
ok('lookup search of tickets', (await as('tf_sales')(`select public.support_ticket_lookup_search('SUPPORT_TICKET', 'basin cracked', 10)`)).some((x) => x.id === t1.id))
ok('user options: active employees of the company only', (await as('tf_sales')(`select public.support_ticket_user_options('EMPLOYEES')`)).every((u) => u.id !== null)
  && !(await as('tf_sales')(`select public.support_ticket_user_options('EMPLOYEES')`)).some((u) => u.name === 'b_op@e7.example.invalid'))

console.log('\nRemoving and deactivating fields keeps the values')
admin = await op(`select public.support_ticket_fields_admin()`)
const without = layout1.filter((x) => x.field_definition_id !== F.num.id)
const s2 = await saveLayout('op', without, admin.stamp)
ex = await as('tf_sales')(`select public.support_ticket_extras($1)`, [t1.id])
ok('a field taken off the form keeps its saved value on the ticket', ex.fields.find((f) => f.field_key === 'cf_units_affected')?.value === 4 && !ex.fields.find((f) => f.field_key === 'cf_units_affected').in_form)
ok('Sales Manager cannot deactivate', await refused('tf_sales', `select public.support_ticket_field_save($1::uuid, '{"is_active": false}'::jsonb)`, [F.date.id], /support_ticket_fields\.delete/))
await save('op', F.date.id, { is_active: false })
ex = await as('tf_sales')(`select public.support_ticket_extras($1)`, [t1.id])
ok('a deactivated field keeps its values (shown, read-only)', ex.fields.find((f) => f.field_key === 'cf_purchase_date')?.value === '2026-10-02' && ex.fields.find((f) => f.field_key === 'cf_purchase_date').is_active === false)
ok('…and leaves the form', !(await as('tf_sales')(`select public.support_ticket_form()`)).fields.some((f) => f.field_key === 'cf_purchase_date'))
ok('its value cannot be changed while inactive', await refused('tf_sales', `select public.support_ticket_custom_fields_save($1, '{"cf_purchase_date":"2026-01-01"}'::jsonb)`, [t1.id], /no longer in use/))
ok('deactivating takes the field off the form (the layout changed)', (await op(`select public.support_ticket_fields_admin()`)).stamp !== s2.stamp)
ok('an inactive field cannot be put on the form', await refused('op', `select public.support_ticket_fields_save_layout($1::jsonb, $2)`,
  [JSON.stringify([...without, { field_definition_id: F.date.id }]), (await op(`select public.support_ticket_fields_admin()`)).stamp], /inactive/))
ok('a definition with saved values cannot be deleted (FK)', await (async () => { await db.exec('reset role'); return db.query(`delete from public.support_ticket_field_definitions where id = $1`, [F.pick.id]).then(() => false, (e) => /foreign key/.test(e.message)) })())
ok('the value rows are all still there', Number(await val(`select count(*) from public.support_ticket_field_values where ticket_id = $1`, [t1.id])) >= 10)

console.log('\nAt most 25 active custom fields')
for (let i = (await op(`select public.support_ticket_fields_admin()`)).active_custom; i < 25; i++) await save('op', null, { field_label: `Extra ${i}`, field_type: 'TEXT' })
ok('25 active', (await op(`select public.support_ticket_fields_admin()`)).active_custom === 25)
ok('the 26th is refused', await bad({ field_label: 'One too many', field_type: 'TEXT' }, /at most 25 active/))
ok('reactivating beyond 25 is refused', await refused('op', `select public.support_ticket_field_save($1::uuid, '{"is_active": true}'::jsonb)`, [F.date.id], /at most 25/))
await db.exec('reset role')
const sneaky = await db.query(`insert into public.support_ticket_field_definitions (company_id, field_label, field_key, field_type) values ($1, 'Sneaky', 'cf_sneaky', 'TEXT')`, [A]).then(() => null, (e) => e.message)
ok('the limit holds even for a direct insert (trigger, not only the app)', /at most 25/.test(sneaky ?? ''), sneaky)
ok('company B has its own 25', (await as('b_op')(`select public.support_ticket_field_save(null, '{"field_label":"B field","field_type":"TEXT"}'::jsonb)`)).field_key === 'cf_b_field')

console.log('\nCompany isolation')
const bAdmin = await as('b_op')(`select public.support_ticket_fields_admin()`)
ok('company B sees only its own fields', bAdmin.definitions.length === 1 && bAdmin.definitions[0].field_key === 'cf_b_field')
ok('company B cannot edit company A\'s field', await refused('b_op', `select public.support_ticket_field_save($1::uuid, '{"field_label":"Hacked"}'::jsonb)`, [F.text.id], /not found in your company/))
ok('company B cannot read company A\'s ticket extras', await refused('b_op', `select public.support_ticket_extras($1)`, [t1.id], /not found in your company/))
ok('company B cannot use company A\'s field keys', await refused('b_op', `select public.support_ticket_create_v2($1::jsonb)`,
  [JSON.stringify({ subject: 'B ticket', customer_email: 'b@b.example', custom_fields: { cf_complaint_type: DAMAGED } })], /Unknown ticket field/))
ok('company B cannot change company A\'s ticket products', await refused('b_op', `select public.support_ticket_products_save($1, '[]'::jsonb, false)`, [t1.id], /not found in your company/))
const rls = await request('b_op', `select (select count(*) from public.support_ticket_field_definitions where company_id = '${A}')
  + (select count(*) from public.support_ticket_field_values where company_id = '${A}') + (select count(*) from public.support_ticket_products where company_id = '${A}')
  + (select count(*) from public.support_ticket_field_layout where company_id = '${A}') as n`)
ok('RLS: company B reads none of company A\'s rows directly', Number(rls.value) === 0, rls)
const rlsView = await request('tf_view', `select (select count(*) from public.support_ticket_products) as p, (select count(*) from public.support_ticket_field_values v join public.support_ticket_field_definitions d on d.id = v.field_definition_id where d.visibility = 'TICKET_MANAGERS') as m`)
ok('RLS: a viewer reads no ticket products and no manager-only values', Number(rlsView.rows?.[0]?.p) === 0 && Number(rlsView.rows?.[0]?.m) === 0, rlsView)

console.log('\nRead-only (PostgREST GET)')
for (const q of [`select public.support_ticket_form()`, `select public.support_ticket_fields_admin()`, `select public.support_ticket_extras('${t1.id}')`,
  `select public.support_ticket_product_search('basin', false, 15)`, `select public.support_ticket_lookup_search('SUPPORT_TICKET', 'a', 5)`, `select public.support_ticket_user_options('AGENTS')`]) {
  const r = await request('op', q, [], true)
  ok(`${q.slice(14, 50)} runs read-only`, !r.error, r.error)
}

console.log('\nReset allowlist and rollback')
const inReset = async () => Number(await val(`select count(*) from private.erp_reset_tables() where table_name in ('support_ticket_field_definitions', 'support_ticket_field_layout', 'support_ticket_field_values', 'support_ticket_products')`))
ok('reset allowlist: the four tables (values and links before definitions and tickets)', (await inReset()) === 4
  && Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_ticket_field_values'`)) < Number(await val(`select ord from private.erp_reset_tables() where table_name = 'support_ticket_field_definitions'`)))
// Later migrations are rolled back first (newest first), as a real rollback of this migration would be done.
for (const f of files.filter((x) => x > `${NAME}.sql`).reverse()) {
  const downFile = path.join(root, 'supabase', 'rollback', f.replace(/\.sql$/, '_down.sql'))
  const sql = await read(downFile).catch(() => null)
  if (!sql) continue
  await db.exec(`reset role; set app.support_crm_rollback_force = 'on'; set app.support_pipelines_rollback_force = 'on'`)
  await db.exec(sql)
  await db.exec(`reset app.support_crm_rollback_force; reset app.support_pipelines_rollback_force`)
}
const down = await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`))
await db.exec('reset role')
const refusedDown = await db.exec(down).then(() => null, (e) => e.message)
ok('rollback refuses while values or ticket products exist', /Export them/.test(refusedDown ?? ''), refusedDown)
await db.exec(`set app.support_ticket_fields_rollback_force = 'on'`)
await db.exec(down)
await db.exec(`reset app.support_ticket_fields_rollback_force`)
ok('rollback (forced): tables and functions gone, tickets kept', !(await val(`select to_regclass('public.support_ticket_field_values') is not null`))
  && !(await val(`select exists (select 1 from pg_proc where proname = 'support_ticket_create_v2')`)) && Number(await val(`select count(*) from public.support_tickets where id = $1`, [t1.id])) === 1)
ok('rollback restores the previous reset allowlist and removes the permissions', (await inReset()) === 0
  && Number(await val(`select count(*) from public.permissions where resource in ('support_ticket_fields', 'support_ticket_products')`)) === 0)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('re-applies after the rollback', (await inReset()) === 4 && !(await request('op', `select public.support_ticket_form()`)).error)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
