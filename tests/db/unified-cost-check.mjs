// One product Cost (migration 20261127090000): database checks.
//
//   npm run test:db:unified-cost
//
// Local PGlite database only (never the live ALTON V2 project).
//  1. Builds the database WITHOUT the migration, runs the end-to-end business flow (stock, GRNs,
//     purchase cost history, valuation) and adds products with every cost combination.
//  2. Applies the migration and checks: Cost = manufacturing cost (purchase cost only when the
//     manufacturing cost is blank), backups, versions, every other field and all stock, GRN, PO,
//     purchase-cost and valuation data unchanged.
//  3. Checks the mirror trigger (new and legacy callers), a GRN posted after the merge (Last
//     Purchase Cost moves, Cost does not), re-running the migration, and the rollback.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIGRATION = '20261127090000_unified_product_cost.sql'
const ROLLBACK = path.join(root, 'supabase', 'rollback', '20261127090000_unified_product_cost_down.sql')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql') && x < MIGRATION).sort()) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations before 20261127 applied')
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ end-to-end business flow (stock, GRNs, purchase cost history)')

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
const op = async (sql, params) => { const r = await request('op', sql, params); if (r.error) throw new Error(`${sql.slice(0, 60)}… → ${r.error}`); return r.value }
const A = await val(`select rls_test.id('company_a')::text`)
const B = await val(`select rls_test.id('company_b')::text`)

// Products with every cost combination (purchase = standard_cost, manufacturing = standard_manufacturing_cost).
const CASES = {
  EQUAL: [100, 100], DIFF: [80, 120], HIGHER_PURCHASE: [500, 300], ZERO_MFG: [75, 0], ONLY_PURCHASE: [45, null], ONLY_MFG: [null, 60], NONE: [null, null],
}
const ids = {}
for (const [key, [cost, mfg]] of Object.entries(CASES)) {
  ids[key] = await val(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost,
      standard_manufacturing_cost, mrp, selling_price, gst_rate, hsn_code, remarks)
    values ($1, $2, $3, 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', $4, $5, 999, 650, 18, '6910', 'keep') returning id`, [A, `UC-${key}`, `Cost case ${key}`, cost, mfg])
}
const idB = await val(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, standard_manufacturing_cost)
  values ($1, 'UC-B', 'Company B', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', 10, 20) returning id`, [B])
const clay = await val(`select rls_test.id('clay')::text`)
const clayCost = await val(`select jsonb_build_array(standard_cost, standard_manufacturing_cost) from public.products where id = $1`, [clay])

// What must not change.
const others = () => val(`select jsonb_object_agg(id, to_jsonb(p) - array['standard_cost', 'standard_manufacturing_cost', 'updated_at', 'updated_by', 'change_reason'])
  from public.products p`)
const frozen = () => val(`select jsonb_build_object(
  'tx', (select md5(string_agg(to_jsonb(t)::text, '|' order by t.id)) from public.inventory_transactions t),
  'bal', (select md5(string_agg(to_jsonb(b)::text, '|' order by b.id)) from public.inventory_balances b),
  'batches', (select md5(string_agg(to_jsonb(b)::text, '|' order by b.id)) from public.inventory_batches b),
  'grn', (select md5(string_agg(to_jsonb(r)::text, '|' order by r.id)) from public.goods_receipts r),
  'grn_lines', (select md5(string_agg(to_jsonb(l)::text, '|' order by l.id)) from public.goods_receipt_lines l),
  'po', (select md5(string_agg(to_jsonb(o)::text, '|' order by o.id)) from public.purchase_orders o),
  'po_lines', (select md5(string_agg(to_jsonb(l)::text, '|' order by l.id)) from public.purchase_order_lines l),
  'cost_events', (select md5(string_agg(to_jsonb(e)::text, '|' order by e.id)) from public.product_purchase_cost_events e),
  'last_cost', (select md5(string_agg(to_jsonb(c)::text, '|' order by c.product_id)) from public.product_last_purchase_costs c),
  'prod_orders', (select md5(string_agg(to_jsonb(o)::text, '|' order by o.id)) from public.production_orders o),
  'prod_materials', (select md5(string_agg(to_jsonb(m)::text, '|' order by m.id)) from public.production_order_materials m))`)
const valuation = async () => (await request('op', `select md5(coalesce((select string_agg(to_jsonb(v)::text, '|' order by to_jsonb(v)::text) from public.inventory_valuation() v), ''))`)).value
const costOf = (id) => val(`select jsonb_build_array(standard_cost::float8, standard_manufacturing_cost::float8) from public.products where id = $1`, [id])
const versions = (id) => val(`select count(*)::int from public.product_versions where product_id = $1`, [id])

const othersBefore = await others()
const frozenBefore = await frozen()
const valuationBefore = await valuation()
const versionsBefore = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await versions(id)])))
ok('valuation is readable before the merge', typeof valuationBefore === 'string' && valuationBefore.length === 32, valuationBefore)

// ---------------------------------------------------------------------------
console.log('\nThe merge')
await db.exec('reset role')
await db.exec(await read(path.join(migDir, MIGRATION)))
const expected = { EQUAL: [100, 100], DIFF: [120, 120], HIGHER_PURCHASE: [300, 300], ZERO_MFG: [0, 0], ONLY_PURCHASE: [45, 45], ONLY_MFG: [60, 60], NONE: [null, null] }
for (const [key, want] of Object.entries(expected)) {
  ok(`${key}: purchase ${CASES[key][0]}, manufacturing ${CASES[key][1]} → Cost ${want[0]} (both columns)`, JSON.stringify(await costOf(ids[key])) === JSON.stringify(want), await costOf(ids[key]))
}
ok('1. both costs equal: nothing changed, no new version, no backup row', versionsBefore.EQUAL === await versions(ids.EQUAL)
  && (await val(`select count(*)::int from private.product_cost_merge_backup where product_id = $1`, [ids.EQUAL])) === 0)
ok('2. different costs: the manufacturing cost is kept (also when the purchase cost is higher)',
  (await costOf(ids.DIFF))[0] === 120 && (await costOf(ids.HIGHER_PURCHASE))[0] === 300)
ok('3. zero manufacturing cost: Cost is 0, not the purchase cost', (await costOf(ids.ZERO_MFG))[0] === 0)
const backup = await val(`select jsonb_object_agg(product_id, jsonb_build_array(standard_cost::float8, standard_manufacturing_cost::float8, merged_cost::float8)) from private.product_cost_merge_backup`)
ok('the old values of every changed product are backed up', JSON.stringify(backup[ids.DIFF]) === '[80,120,120]' && JSON.stringify(backup[ids.ZERO_MFG]) === '[75,0,0]'
  && JSON.stringify(backup[ids.ONLY_PURCHASE]) === '[45,null,45]' && !backup[ids.NONE], backup)
const reasons = await val(`select count(*)::int from public.product_versions where product_id = $1 and change_reason like 'Standard purchase and manufacturing costs merged%'`, [ids.DIFF])
ok('each changed product has a new version with the reason (history kept)', reasons === 1 && (await versions(ids.DIFF)) === versionsBefore.DIFF + 1, { reasons })
ok('company B is merged by the same rule (manufacturing 20 kept)', JSON.stringify(await costOf(idB)) === '[20,20]')
ok('12. every other product field is intact (SKU, name, MRP, selling price, GST, HSN, remarks …)', JSON.stringify(await others()) === JSON.stringify(othersBefore))
ok('10/11. stock, lots, GRNs, POs, production snapshots, purchase cost history and Last Purchase Cost are unchanged', JSON.stringify(await frozen()) === JSON.stringify(frozenBefore),
  { before: frozenBefore, after: await frozen() })
ok('11. inventory valuation is unchanged', (await valuation()) === valuationBefore)
ok('signed-in users cannot read the backup', !(await val(`select has_table_privilege('authenticated', 'private.product_cost_merge_backup', 'SELECT')`)))

// ---------------------------------------------------------------------------
console.log('\nOne value from now on')
await op(`update public.products set standard_cost = 130, change_reason = 'test: edit Cost' where id = $1`, [ids.DIFF])
ok('5. editing Cost: the manufacturing column follows', JSON.stringify(await costOf(ids.DIFF)) === '[130,130]', await costOf(ids.DIFF))
await op(`update public.products set standard_manufacturing_cost = 140, change_reason = 'test: old screen' where id = $1`, [ids.DIFF])
ok('an older screen that sends only the manufacturing cost sets Cost', JSON.stringify(await costOf(ids.DIFF)) === '[140,140]', await costOf(ids.DIFF))
const created = await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost)
  values ($1, 'UC-NEW', 'New with Cost', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', 25) returning id`, [A])
ok('4. a new product with Cost: both columns hold it', JSON.stringify(await costOf(created)) === '[25,25]', await costOf(created))
const legacyNew = await op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, standard_manufacturing_cost)
  values ($1, 'UC-OLD', 'Old screen', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', 90, 70) returning id`, [A])
ok('a legacy insert with both costs keeps the manufacturing cost', JSON.stringify(await costOf(legacyNew)) === '[70,70]', await costOf(legacyNew))
const neg = await request('op', `update public.products set standard_cost = -1, change_reason = 'x' where id = $1`, [ids.DIFF])
ok('a negative Cost is refused by the database', Boolean(neg.error) && JSON.stringify(await costOf(ids.DIFF)) === '[140,140]', neg)

// GRN after the merge: Last Purchase Cost and history move; Cost does not.
const lastBefore = await val(`select last_purchase_cost::float8 from public.product_last_purchase_costs where product_id = $1`, [clay])
const eventsBefore = await val(`select count(*)::int from public.product_purchase_cost_events where product_id = $1`, [clay])
const clayAfterMerge = await costOf(clay)
const header = await val(`select jsonb_build_object('supplier_id', rls_test.gid('sup', 'supplier_id'), 'purchase_type', 'RAW_MATERIAL', 'warehouse_id', rls_test.id('w1'))`)
const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
  [header, [{ product_id: clay, quantity: 10, unit_price: 37 }]])).po_id
await op(`select public.purchase_order_open($1)`, [po])
const grn = await op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text),
  jsonb_build_array(jsonb_build_object('po_line_id', rls_test.po_line($1, $2), 'received_quantity', 10, 'accepted_quantity', 10, 'rejected_quantity', 0,
    'accepted_location_id', rls_test.id('g1'))), gen_random_uuid())`, [po, clay])
ok('10. a GRN posts after the merge', /^[A-Z]+-\d+$/.test(grn.receipt_number ?? ''), grn)
ok('10. Last Purchase Cost and its history are updated by the GRN', (await val(`select last_purchase_cost::float8 from public.product_last_purchase_costs where product_id = $1`, [clay])) === 37
  && (await val(`select count(*)::int from public.product_purchase_cost_events where product_id = $1`, [clay])) === eventsBefore + 1, { lastBefore })
ok('10. the GRN does not change the product Cost', JSON.stringify(await costOf(clay)) === JSON.stringify(clayAfterMerge), { before: clayCost, after: await costOf(clay) })
ok('11. valuation still works after the GRN', typeof (await valuation()) === 'string')

// ---------------------------------------------------------------------------
console.log('\nRe-run and rollback')
const backupRows = await val(`select count(*)::int from private.product_cost_merge_backup`)
const versionCount = await val(`select count(*)::int from public.product_versions`)
await db.exec('reset role')
await db.exec(await read(path.join(migDir, MIGRATION)))
ok('the migration runs again without changes (no new backup rows or versions)', (await val(`select count(*)::int from private.product_cost_merge_backup`)) === backupRows
  && (await val(`select count(*)::int from public.product_versions`)) === versionCount)
await db.exec('reset role')
await db.exec(await read(ROLLBACK))
ok('rollback: untouched products get their two original costs back', JSON.stringify(await costOf(ids.ZERO_MFG)) === '[75,0]'
  && JSON.stringify(await costOf(ids.ONLY_PURCHASE)) === '[45,null]' && JSON.stringify(await costOf(ids.HIGHER_PURCHASE)) === '[500,300]'
  && JSON.stringify(await costOf(idB)) === '[10,20]' && JSON.stringify(await costOf(ids.EQUAL)) === '[100,100]', [await costOf(ids.ZERO_MFG), await costOf(ids.ONLY_PURCHASE)])
ok('rollback: a product edited after the merge keeps its newer Cost', JSON.stringify(await costOf(ids.DIFF)) === '[140,140]', await costOf(ids.DIFF))
ok('rollback: trigger, function and backup table are removed', (await val(`select count(*)::int from pg_trigger where tgname = 'products_0_cost_unify'`)) === 0
  && (await val(`select to_regclass('private.product_cost_merge_backup')::text`)) === null
  && (await val(`select count(*)::int from pg_proc where proname = 'product_cost_unify'`)) === 0)
await op(`update public.products set standard_manufacturing_cost = 11, change_reason = 'test: columns independent again' where id = $1`, [ids.NONE])
ok('rollback: the two columns are independent again', JSON.stringify(await costOf(ids.NONE)) === '[null,11]', await costOf(ids.NONE))
ok('rollback: stock, GRN and purchase cost data untouched by the rollback', (await val(`select count(*)::int from public.goods_receipts where id = $1`, [grn.receipt_id])) === 1)

console.log(`${failed === 0 ? '✓' : '✗'} unified product cost check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
