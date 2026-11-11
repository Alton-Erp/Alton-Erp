// Opening stock at the Product Master Cost (migrations 20261129090000 and 20261130090000): database checks.
//
//   npm run test:db:opening-cost
//
// Local PGlite database only. Products get their Product Master Cost the real way (a standard cost,
// or two posted GRNs through the purchase functions); opening stock is then posted through the new
// server-priced functions with wrong, missing and overridden costs.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIGRATION = '20261129090000_opening_stock_master_cost.sql'
const LOCKDOWN = '20261130090000_opening_stock_lockdown.sql'
const OPTIONAL = '20261204090000_opening_stock_optional_cost'
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of files) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ end-to-end business flow')

let failed = 0
let passed = 0
const ok = (name, cond, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const val = async (sql, params) => { await db.exec('reset role'); return Object.values((await db.query(sql, params)).rows[0] ?? {})[0] }
async function request(user, sql, params) {
  await db.exec('reset role')
  await db.exec('begin')
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
const as = (user) => async (sql, params) => { const r = await request(user, sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const op = as('op')
const A = await val(`select rls_test.id('company_a')::text`)
const g1 = await val(`select rls_test.id('g1')::text`)
const today = await val(`select rls_test.today()::text`)

const newProduct = (sku, cost) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $3, 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', $4, 18, '6910') returning id`, [A, sku, `Opening ${sku}`, cost])
const buy = async (product, price) => {
  const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
    [{ supplier_id: await val(`select rls_test.gid('sup', 'supplier_id')::text`), purchase_type: 'RAW_MATERIAL', warehouse_id: await val(`select rls_test.id('w1')::text`) },
      [{ product_id: product, quantity: 10, unit_price: price }]])).po_id
  await op(`select public.purchase_order_open($1)`, [po])
  const line = await val(`select id from public.purchase_order_lines where purchase_order_id = $1`, [po])
  return op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', $2::text), jsonb_build_array(jsonb_build_object('po_line_id', $3::uuid,
    'received_quantity', 10, 'accepted_quantity', 10, 'rejected_quantity', 0, 'accepted_location_id', $4::uuid)), gen_random_uuid())`, [po, today, line, g1])
}
const line = (n, product, qty, extra = {}) => ({ line_no: n, product_id: product, location_id: g1, source_type: 'OUTSOURCED', quantity: qty, unit: 'PCS', effective_date: today, ...extra })
const post = (lines, key = crypto.randomUUID(), user = 'op') => request(user, `select public.inventory_post_opening_stock_at_cost($1::jsonb, 'IMPORT', 'opening.xlsx', null, $2::uuid)`, [JSON.stringify(lines), key])
const opening = (product) => val(`select jsonb_build_object('cost', t.unit_cost::float8, 'qty', t.quantity::float8, 'value', (t.quantity * t.unit_cost)::float8)
  from public.inventory_transactions t where t.product_id = $1 and t.transaction_type = 'OPENING_STOCK' order by t.created_at desc limit 1`, [product])

const STD = await newProduct('OC-STD', 120)       // standard cost only
const GRN = await newProduct('OC-GRN', 451)       // two receipts: Cost = the first (₹440), Last Purchase Cost ₹460
await buy(GRN, 440)
await buy(GRN, 460)
const NONE = await newProduct('OC-NONE', null)    // no cost at all
const ZERO = await newProduct('OC-ZERO', 0)       // cost zero

// What must not change.
const knownProducts = await val(`select array_agg(id::text) from public.products`)
const frozen = () => val(`select md5(coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.goods_receipts r), '')
  || coalesce((select string_agg(to_jsonb(o)::text, '|' order by o.id) from public.purchase_orders o), '')
  || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.product_purchase_cost_events e), '')
  || coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.product_id) from public.product_last_purchase_costs c), '')
  || coalesce((select string_agg(p.id || ':' || coalesce(p.standard_cost::text, '-') || ':' || coalesce(p.standard_manufacturing_cost::text, '-'), '|' order by p.id) from public.products p where p.id::text = any($1::text[])), '')
  || coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t where t.transaction_type <> 'OPENING_STOCK'), ''))`, [knownProducts])
const frozenBefore = await frozen()

// ---------------------------------------------------------------------------
console.log('\nCosts shown to the screens')
const costs = await op(`select public.opening_stock_product_costs($1::uuid[])`, [[STD, GRN, NONE, ZERO]])
const byId = Object.fromEntries(costs.costs.map((c) => [c.product_id, c]))
ok('1. the Product Master Cost of each product: standard ₹120; second-most-recent GRN ₹440 (not the Last Purchase Cost ₹460)',
  byId[STD].cost === 120 && byId[STD].source === 'STANDARD' && byId[GRN].cost === 440 && byId[GRN].source === 'PURCHASE', costs)
const view = await op(`select jsonb_object_agg(id, master_cost) from public.product_master_list where id = any($1::uuid[])`, [[STD, GRN]])
ok('3. the same value as the Product Master list (product_master_list.master_cost)', view[STD] === 120 && view[GRN] === 440, view)
ok('5. missing and zero costs are marked not valid', byId[NONE].cost === null && !byId[NONE].valid && byId[ZERO].cost === 0 && !byId[ZERO].valid, [byId[NONE], byId[ZERO]])
ok('override is off by default', costs.override_allowed === false)

// ---------------------------------------------------------------------------
console.log('\nPosting at the Product Master Cost')
const r1 = await post([line(1, STD, 7, { unit_cost: 999 }), line(2, GRN, 3, { unit_cost: 1 })])
ok('2/3. posted; the costs sent (₹999, ₹1, as an Excel column would) are ignored', r1.value?.ok === true && r1.value?.status === 'POSTED', r1)
const o1 = await opening(STD)
const o2 = await opening(GRN)
ok('6. ledger: 7 × ₹120 = ₹840 and 3 × ₹440 = ₹1,320 (quantity × Product Master Cost)', o1.cost === 120 && o1.value === 840 && o2.cost === 440 && o2.value === 1320, [o1, o2])
const lineCosts = await val(`select jsonb_object_agg(product_id, unit_cost::float8) from public.inventory_opening_lines where opening_batch_id = $1`, [r1.value?.opening_batch_id])
ok('the opening lines store the same costs', lineCosts[STD] === 120 && lineCosts[GRN] === 440, lineCosts)
ok('7. stock balance and lot valuation follow the posted cost', (await val(`select private.lot_average_cost(t.batch_id)::float8 from public.inventory_transactions t
  where t.product_id = $1 and t.transaction_type = 'OPENING_STOCK'`, [STD])) === 120
  && (await val(`select sum(on_hand)::float8 from public.inventory_balances where product_id = $1`, [STD])) === 7)
const audit = await val(`select metadata from public.audit_logs where action = 'inventory.opening_cost_from_product_master' and resource_id = $1`, [r1.value?.opening_batch_id])
ok('an audit entry records the cost source', audit?.cost_source === 'product_master_list.master_cost' && audit.lines === 2, audit)

const r2 = await post([line(1, NONE, 5), line(2, ZERO, 5), line(3, await newProduct('OC-OK', 50), 5)])
// Since 20261204090000 the cost is optional: rows without a valid Product Master Cost are posted without a cost
// (pending, not valued) instead of being rejected; they are never posted at zero.
ok('5. missing / zero Product Master Cost: posted without a cost (not valued, never at zero); the costed row keeps its cost', r2.value?.ok === true
  && (await opening(NONE)).cost === null && (await opening(ZERO)).cost === null && (await opening(NONE)).qty === 5
  && (await val(`select count(*)::int from public.inventory_transactions where product_id = any($1::uuid[]) and transaction_type = 'OPENING_STOCK' and unit_cost = 0`, [[NONE, ZERO]])) === 0, r2)
const r3 = await post([line(1, '00000000-0000-4000-8000-0000000000ff', 5)])
ok('4. an unknown product is rejected with a clear reason', r3.value?.ok === false && /Product not found/.test(JSON.stringify(r3.value.errors)), r3)
const r4 = await post([line(1, STD, 2)])
ok('existing safeguard: a second opening balance for the same product and location is rejected', r4.value?.ok === false && /already exists/.test(JSON.stringify(r4.value.errors)), r4)
const key = crypto.randomUUID()
const w = await newProduct('OC-RETRY', 30)
const first = await post([line(1, w, 4)], key)
const again = await post([line(1, w, 4)], key)
ok('existing safeguard: the same request sent twice posts once', first.value?.ok && again.value?.opening_batch_id === first.value.opening_batch_id
  && (await val(`select count(*)::int from public.inventory_transactions where product_id = $1`, [w])) === 1, again)

// Approval path: staged with the costs, approved later.
const s = await newProduct('OC-STAGE', 65)
const staged = await request('op', `select public.inventory_submit_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, s, 2, { unit_cost: 5 })])])
ok('submit for approval: the staged line carries the Product Master Cost (₹65, not ₹5)', staged.value?.ok
  && (await val(`select unit_cost::float8 from public.inventory_opening_lines where opening_batch_id = $1`, [staged.value.opening_batch_id])) === 65, staged)

// ---------------------------------------------------------------------------
console.log('\nOverride')
const o = await newProduct('OC-OVR', 100)
const deniedOff = await post([line(1, o, 1, { unit_cost: 77, cost_override: true })])
ok('with the override switched off, a different cost is refused', deniedOff.value?.ok === false && /cannot be changed here/.test(JSON.stringify(deniedOff.value.errors)), deniedOff)
ok('the override setting is OFF by default', (await val(`select private.erp_setting($1, 'inventory.opening_cost_override')::text`, [A])) === 'false')
const saved = await request('op', `select public.erp_settings_save('{}'::jsonb, '{"inventory.opening_cost_override": true}'::jsonb)`)
ok('a settings manager switches it on in ERP Settings (audited as a settings change)', !saved.error
  && (await val(`select private.erp_setting($1, 'inventory.opening_cost_override')::text`, [A])) === 'true'
  && (await val(`select count(*)::int from public.audit_logs where company_id = $1 and action = 'settings.erp_updated'`, [A])) > 0, saved)
ok('the setting is validated (on / off only)', Boolean((await request('op', `select public.erp_settings_save('{}'::jsonb, '{"inventory.opening_cost_override": "yes"}'::jsonb)`)).error))
ok('switched on: a settings manager sees the override as allowed', (await op(`select public.opening_stock_product_costs($1::uuid[])`, [[o]])).override_allowed === true)
const bad = await post([line(1, o, 1, { unit_cost: 0, cost_override: true })])
ok('an override cost must be greater than zero', bad.value?.ok === false && /greater than zero/.test(JSON.stringify(bad.value.errors)), bad)
const over = await post([line(1, o, 2, { unit_cost: 77, cost_override: true })])
ok('a permitted override posts the entered cost', over.value?.ok && (await opening(o)).cost === 77, over)
const ovAudit = await val(`select metadata -> 'overrides' from public.audit_logs where action = 'inventory.opening_cost_from_product_master' and resource_id = $1`, [over.value?.opening_batch_id])
ok('the override is listed in the audit entry with the Product Master Cost it replaced', ovAudit?.[0]?.unit_cost === 77 && ovAudit[0].product_master_cost === 100, ovAudit)
// A user who may enter opening stock but not manage settings.
const role = await val(`select r.id from public.roles r where exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'inventory_opening.create')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'settings.manage') limit 1`)
if (role) {
  await db.exec(`reset role; insert into rls_test.ids (key, id) values ('oc_clerk', 'e7e5c800-0000-4000-8000-0000000000c9');
    insert into auth.users (id, email) values (rls_test.id('oc_clerk'), 'oc_clerk@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('oc_clerk')`)
  await db.query(`insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('oc_clerk'), $1, $2)`, [A, role])
  const c = await newProduct('OC-CLERK', 40)
  const clerk = await post([line(1, c, 1, { unit_cost: 5, cost_override: true })], crypto.randomUUID(), 'oc_clerk')
  ok('even with the override on, a user without settings.manage cannot change the cost', clerk.value?.ok === false && /cannot be changed here/.test(JSON.stringify(clerk.value.errors)), clerk)
  const plain = await post([line(1, c, 1, { unit_cost: 5 })], crypto.randomUUID(), 'oc_clerk')
  ok('that user posts at the Product Master Cost', plain.value?.ok && (await opening(c)).cost === 40, plain)
  const flip = await request('oc_clerk', `select public.erp_settings_save('{}'::jsonb, '{"inventory.opening_cost_override": false}'::jsonb)`)
  ok('that user cannot change the override setting', Boolean(flip.error) && (await val(`select private.erp_setting($1, 'inventory.opening_cost_override')::text`, [A])) === 'true', flip)
  // No bypass: the older functions that accept any cost are not callable by users (20261130090000).
  const c2 = await newProduct('OC-BYPASS', 40)
  for (const [user, fn] of [['oc_clerk', 'inventory_submit_opening_stock'], ['oc_clerk', 'inventory_post_opening_stock'], ['op', 'inventory_submit_opening_stock'], ['op', 'inventory_post_opening_stock']]) {
    const r = await request(user, `select public.${fn}($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, c2, 1, { unit_cost: 1 })])])
    ok(`5. ${user} calling ${fn} directly (cost ₹1) is refused`, /permission denied/.test(r.error ?? ''), r)
  }
  ok('5. ...and nothing was posted or staged for that product', (await val(`select count(*)::int from public.inventory_opening_lines where product_id = $1`, [c2])) === 0)
} else ok('a role with inventory_opening.create and without settings.manage exists', false)

// ---------------------------------------------------------------------------
console.log('\nSafety')
ok('8. GRNs, POs, purchase cost history, Last Purchase Cost, product costs and other stock movements are unchanged', (await frozen()) === frozenBefore)
const bView = await request('b_op', `select public.opening_stock_product_costs($1::uuid[])`, [[STD]])
ok('company isolation: another company gets no cost for these products', bView.value?.costs?.length === 0, bView)
ok('5. signed-in users and anon cannot execute the older functions; service_role (server key) can',
  !(await val(`select has_function_privilege('authenticated', 'public.inventory_submit_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('authenticated', 'public.inventory_post_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.inventory_submit_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')`))
  && (await val(`select has_function_privilege('service_role', 'public.inventory_post_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')`))
  && (await val(`select has_function_privilege('authenticated', 'public.inventory_review_opening_stock(uuid, text, text, uuid)', 'EXECUTE')`)))
ok('anon cannot call the functions', !(await val(`select has_function_privilege('anon', 'public.inventory_post_opening_stock_at_cost(jsonb, text, text, text, uuid)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.opening_stock_product_costs(uuid[])', 'EXECUTE')`)))
ok('users cannot call the private pricing functions', !(await val(`select has_function_privilege('authenticated', 'private.opening_price_lines(uuid, jsonb)', 'EXECUTE')`)))

// ---------------------------------------------------------------------------
console.log('\nRollback')
const before = new PGlite()
await before.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of files.filter((x) => x < MIGRATION)) await before.exec(await read(path.join(migDir, f)))
const def = async (d, fn) => (await d.query(`select pg_get_functiondef($1::regprocedure) d`, [fn])).rows[0].d
const original = { defaults: await def(before, 'private.erp_setting_defaults()'), validate: await def(before, 'private.company_settings_validate()') }
const acl = async (d) => (await d.query(`select string_agg(proname || '=' || coalesce((select string_agg(x, ',' order by x) from unnest(proacl::text[]) x), '') || '|' || coalesce(obj_description(oid, 'pg_proc'), ''), ';' order by proname) a
  from pg_proc where proname in ('inventory_submit_opening_stock', 'inventory_post_opening_stock')`)).rows[0].a
const originalAcl = await acl(before)
await db.exec('reset role')
// 20261204090000 (optional cost) redefines the pricing step: roll it back first.
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${OPTIONAL}_down.sql`)))
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261130090000_opening_stock_lockdown_down.sql')))
ok('rollback of 20261130090000 restores the original privileges of the older functions exactly', (await acl(db)) === originalAcl, [await acl(db), originalAcl])
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261129090000_opening_stock_master_cost_down.sql')))
ok('rollback restores the two settings functions exactly', (await def(db, 'private.erp_setting_defaults()')) === original.defaults && (await def(db, 'private.company_settings_validate()')) === original.validate)
ok('rollback removes the new functions and the setting, and leaves posted opening stock', (await val(`select count(*)::int from pg_proc where proname in ('inventory_post_opening_stock_at_cost',
  'inventory_submit_opening_stock_at_cost', 'opening_stock_product_costs', 'opening_price_lines', 'opening_master_costs', 'opening_cost_override_allowed', 'opening_cost_audit')`)) === 0
  && (await val(`select count(*)::int from public.company_settings where setting_key = 'inventory.opening_cost_override'`)) === 0 && (await opening(STD)).cost === 120)
for (let i = 0; i < 2; i++) {
  await db.exec(await read(path.join(migDir, MIGRATION)))
  await db.exec(await read(path.join(migDir, LOCKDOWN)))
  await db.exec(await read(path.join(migDir, `${OPTIONAL}.sql`)))
}
ok('both migrations apply again, twice', (await op(`select public.opening_stock_product_costs($1::uuid[])`, [[STD]])).costs[0].cost === 120
  && !(await val(`select has_function_privilege('authenticated', 'public.inventory_post_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')`)))
const afterReapply = await post([line(1, await newProduct('OC-AFTER', 33), 2, { unit_cost: 1 })])
ok('after re-applying, opening stock still posts at the Product Master Cost', afterReapply.value?.ok === true && afterReapply.value.status === 'POSTED', afterReapply)

console.log(`${failed === 0 ? '✓' : '✗'} opening stock master cost check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
