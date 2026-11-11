// Opening stock with an optional unit cost (migration 20261204090000).
//
//   npm run test:db:opening-optional-cost
//
// Local PGlite database only (throwaway, in memory). Every posting goes through the existing opening stock
// functions (inventory_post_opening_stock_at_cost / inventory_submit_opening_stock_at_cost + review), one
// committed transaction per call. The Excel validation of the app (validateOpeningRows) is run on the same
// products with the costs the database returns.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { autoMapOpening, validateOpeningRows } from '../../src/features/inventory/opening-import.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261204090000_opening_stock_optional_cost'
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const files = (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()
// Everything before this migration first: opening stock posted then must stay exactly as it is (scenario 8).
for (const f of files.filter((x) => x < `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f)))
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
suite = suite.slice(0, suite.lastIndexOf('\ndo $$'))
await db.exec(suite)
const flowFailed = (await db.query('select name from rls_test.results where not passed')).rows
if (flowFailed.length) { console.error('✗ end-to-end flow failed:', flowFailed.map((r) => r.name).join('; ')); process.exit(1) }
await db.exec('commit')
console.log('✓ migrations before 20261204090000 applied, end-to-end business flow')

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
const op = async (sql, params) => { const r = await request('op', sql, params); if (r.error) throw new Error(`${sql.slice(0, 70)}… → ${r.error}`); return r.value }
const A = await val(`select rls_test.id('company_a')::text`)
const g1 = await val(`select rls_test.id('g1')::text`)
const today = await val(`select rls_test.today()::text`)
let n = 0
const newProduct = (cost, unit = 'PCS') => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2, 'RAW_MATERIAL', 'OUTSOURCED', $3, 'ACTIVE', $4, 18, '6910') returning id`, [A, `OO-${++n}`, unit, cost])
const line = (no, product, qty, extra = {}) => ({ line_no: no, product_id: product, location_id: g1, source_type: 'OUTSOURCED', quantity: qty, unit: 'PCS', effective_date: today, ...extra })
const post = (lines, source = 'MANUAL', key = crypto.randomUUID()) => request('op', `select public.inventory_post_opening_stock_at_cost($1::jsonb, $2, $3, null, $4::uuid)`,
  [JSON.stringify(lines), source, source === 'IMPORT' ? 'opening.xlsx' : null, key])
const opening = (product) => val(`select jsonb_build_object('cost', t.unit_cost::float8, 'qty', t.quantity::float8) from public.inventory_transactions t
  where t.product_id = $1 and t.transaction_type = 'OPENING_STOCK' order by t.created_at desc limit 1`, [product])
const valuation = (product) => val(`select jsonb_build_object('status', valuation_status, 'value', stock_value::float8, 'unvalued', unvalued_on_hand::float8, 'valued', valued_on_hand::float8, 'cost', unit_cost::float8)
  from public.inventory_product_stock_value where product_id = $1`, [product])

// Scenario 8: opening stock posted before this change (one with a cost, staged lines) — kept exactly.
const OLD = await newProduct(25)
const oldPost = await post([line(1, OLD, 4)])
const OLD2 = await newProduct(30)
const oldStaged = await request('op', `select public.inventory_submit_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, OLD2, 2)])])
const NOCOST_BEFORE = await newProduct(null)
const refusedBefore = await post([line(1, NOCOST_BEFORE, 3)])
const existing = () => val(`select md5(coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.id) from public.inventory_opening_lines l where l.created_at <= $1::timestamptz), '')
  || coalesce((select string_agg(to_jsonb(b)::text, '|' order by b.id) from public.inventory_opening_batches b where b.id in (select opening_batch_id from public.inventory_opening_lines where created_at <= $1::timestamptz)), '')
  || coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t where t.created_at <= $1::timestamptz), '')
  || coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.goods_receipts r), '')
  || coalesce((select string_agg(to_jsonb(o)::text, '|' order by o.id) from public.purchase_orders o), '')
  || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.product_purchase_cost_events e), '')
  || coalesce((select string_agg(p.id || ':' || coalesce(p.standard_cost::text, '-'), '|' order by p.id) from public.products p where p.created_at <= $1::timestamptz), ''))`, [cutoff])
const cutoff = await val(`select clock_timestamp()::text`)
const existingBefore = await existing()
ok('before this change: opening stock with a cost posts, and a product without a cost is refused', oldPost.value?.ok === true && oldStaged.value?.ok === true
  && refusedBefore.value?.ok === false && /Product Master Cost is missing/.test(JSON.stringify(refusedBefore.value.errors)), { oldPost, refusedBefore })

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log('✓ 20261204090000 applied (twice)')

// ---------------------------------------------------------------------------
console.log('\nManual entry')
const STD = await newProduct(120)
const NONE = await newProduct(null)
const ZERO = await newProduct(0)
const m1 = await post([line(1, STD, 7)])
ok('1. manual entry with a cost: posted at the Product Master Cost ₹120', m1.value?.ok && (await opening(STD)).cost === 120, m1)
const m2 = await post([line(1, NONE, 5)])
const o2 = await opening(NONE)
ok('2. manual entry without a cost: posted, quantity 5 recorded, no cost (not zero)', m2.value?.ok && m2.value.status === 'POSTED' && o2.qty === 5 && o2.cost === null, { m2, o2 })
ok('2. the opening line is stored without a cost', (await val(`select unit_cost from public.inventory_opening_lines where opening_batch_id = $1`, [m2.value?.opening_batch_id])) === null)
const m3 = await post([line(1, ZERO, 2)])
ok('6. a zero Product Master Cost is not used: posted without a cost, never at zero', m3.value?.ok && (await opening(ZERO)).cost === null, m3)
const m4 = await post([line(1, await newProduct(80), 1, { unit_cost: 999 })])
ok('a cost sent by the browser is still ignored (the Product Master Cost is set on the server)', m4.value?.ok && (await val(`select unit_cost::float8 from public.inventory_opening_lines where opening_batch_id = $1`, [m4.value.opening_batch_id])) === 80)
const audit = await val(`select metadata from public.audit_logs where action = 'inventory.opening_cost_from_product_master' and resource_id = $1`, [m2.value?.opening_batch_id])
ok('audit: the entry lists the lines recorded without a cost', audit?.unvalued_lines?.[0]?.reason === 'NO_PRODUCT_MASTER_COST' && audit.cost_source === 'product_master_list.master_cost', audit)

// Approval path (submit, then approve): unchanged workflow, the line without a cost is approved and posted.
const STAGED = await newProduct(null)
const sub = await request('op', `select public.inventory_submit_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, STAGED, 6)])])
ok('submit for approval without a cost: staged (pending approval), stock unchanged', sub.value?.ok
  && (await val(`select status from public.inventory_opening_batches where id = $1`, [sub.value.opening_batch_id])) === 'PENDING_APPROVAL'
  && (await val(`select count(*)::int from public.inventory_transactions where product_id = $1`, [STAGED])) === 0, sub)
const appr = await request('op', `select public.inventory_review_opening_stock($1, 'APPROVE', 'checked', gen_random_uuid())`, [sub.value?.opening_batch_id])
ok('approving posts it without a cost', !appr.error && (await opening(STAGED)).cost === null && (await opening(STAGED)).qty === 6, appr)

// ---------------------------------------------------------------------------
console.log('\nExcel upload')
const X1 = await newProduct(40)
const X2 = await newProduct(null)
const X3 = await newProduct(55)
const costs = await op(`select public.opening_stock_product_costs($1::uuid[])`, [[X1, X2, X3]])
const ctxProducts = new Map((await val(`select jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'product_name', product_name, 'base_unit', base_unit, 'status', status, 'track_batches', track_batches,
  'track_expiry', track_expiry, 'default_source_type', default_source_type, 'product_type', product_type)) from public.products where id = any($1::uuid[])`, [[X1, X2, X3]])).map((p) => [p.sku.toLowerCase(), p]))
const locs = await val(`select jsonb_agg(jsonb_build_object('id', l.id, 'warehouseCode', w.warehouse_code, 'locationCode', l.location_code, 'active', l.status = 'ACTIVE', 'isDefault', l.is_default)) from public.inventory_locations l
  join public.warehouses w on w.id = l.warehouse_id where l.id = $1`, [g1])
const ctx = { products: ctxProducts, locations: locs, defaultEffectiveDate: today, today,
  costs: new Map(costs.costs.map((c) => [c.product_id, { cost: c.cost === null ? null : Number(c.cost), valid: c.valid }])) }
const sku = async (id) => val(`select sku from public.products where id = $1`, [id])
const wh = locs[0].warehouseCode
const loc = locs[0].locationCode
// 3. with a price column, 4. without one, 5. with some blank price cells
const sheetWith = [['SKU', 'Warehouse', 'Location', 'Quantity', 'Unit Cost'], [await sku(X1), wh, loc, '3', '777']]
const sheetWithout = [['SKU', 'Warehouse', 'Location', 'Quantity'], [await sku(X2), wh, loc, '4']]
const sheetBlanks = [['SKU', 'Warehouse', 'Location', 'Quantity', 'Unit Cost'], [await sku(X3), wh, loc, '2', '']]
const screen = (sheet) => validateOpeningRows(sheet.slice(1), autoMapOpening(sheet[0]), ctx, 2)
const [s1, s2, s3] = [screen(sheetWith), screen(sheetWithout), screen(sheetBlanks)]
ok('the Excel validation accepts every row (with a price column, without one, with a blank price cell)',
  [s1, s2, s3].every((r) => r.length === 1 && r[0].status === 'valid'), [s1, s2, s3].map((r) => r.map((x) => [x.status, x.errors])))
ok('the Excel validation shows the Product Master Cost where there is one and a pending cost (with a warning) where there is none',
  s1[0].cost === 40 && s3[0].cost === 55 && s2[0].cost === null && /pending cost/.test(s2[0].warnings.join()), [s1[0].cost, s2[0].cost, s3[0].cost])
const imp = await post([...s1, ...s2, ...s3].map((r, i) => ({ ...r.payload, line_no: i + 1, unit_cost: null })), 'IMPORT')
ok('3/4/5. one import posts all three rows', imp.value?.ok && imp.value.status === 'POSTED', imp)
ok('3. price column: posted at the Product Master Cost ₹40 (the ₹777 in the file is ignored)', (await opening(X1)).cost === 40)
ok('4. no price column: posted without a cost', (await opening(X2)).cost === null && (await opening(X2)).qty === 4)
ok('5. blank price cell: posted at the Product Master Cost ₹55', (await opening(X3)).cost === 55)

// ---------------------------------------------------------------------------
console.log('\nOverride (unchanged, audited)')
await op(`select public.erp_settings_save('{}'::jsonb, '{"inventory.opening_cost_override": true}'::jsonb)`)
const OV = await newProduct(null)
const blankOverride = await post([line(1, OV, 1, { cost_override: true, unit_cost: '' })])
ok('an override ticked without a cost is no override: posted without a cost (none available)', blankOverride.value?.ok && (await opening(OV)).cost === null, blankOverride)
const zeroOverride = await post([line(1, await newProduct(null), 1, { cost_override: true, unit_cost: 0 })])
ok('an override of zero is still refused', zeroOverride.value?.ok === false && /greater than zero/.test(JSON.stringify(zeroOverride.value.errors)), zeroOverride)
const OV2 = await newProduct(null)
const realOverride = await post([line(1, OV2, 2, { cost_override: true, unit_cost: 64 })])
ok('a permitted override gives a cost to a product without one, and is audited', realOverride.value?.ok && (await opening(OV2)).cost === 64
  && (await val(`select metadata -> 'overrides' -> 0 ->> 'unit_cost' from public.audit_logs where action = 'inventory.opening_cost_from_product_master' and resource_id = $1`, [realOverride.value.opening_batch_id])) === '64', realOverride)
await op(`select public.erp_settings_save('{}'::jsonb, '{"inventory.opening_cost_override": false}'::jsonb)`)

// ---------------------------------------------------------------------------
console.log('\nValuation (existing method)')
const vStd = await valuation(STD)
const vNone = await valuation(NONE)
ok('7. a product with a cost is valued: 7 × ₹120 = ₹840', vStd.status === 'VALUED' && vStd.value === 840, vStd)
ok('7. a product without a cost is NOT_VALUED: no value, its 5 units shown as not valued', vNone.status === 'NOT_VALUED' && vNone.value === null && vNone.unvalued === 5, vNone)
const summary = await op(`select public.inventory_stock_value_summary(null, 'OO-')`)
const report = await op(`select coalesce(sum(value), 0)::float8 from public.inventory_valuation() where sku like 'OO-%'`)
ok('7. the value total leaves the uncosted stock out and equals the stock valuation report', Number(summary.total_value) === report && report > 0, { summary, report })
const pcs = summary.unvalued_units.find((u) => u.unit === 'PCS')
const expected = await val(`select sum(t.quantity)::float8 from public.inventory_transactions t join public.products p on p.id = t.product_id
  where p.sku like 'OO-%' and t.transaction_type = 'OPENING_STOCK' and t.unit_cost is null`)
ok(`7. the dashboard summary shows the uncosted quantity apart: ${pcs?.quantity} PCS`, Number(pcs?.quantity) === expected && summary.not_valued_products >= 4, summary)
ok('7. lot cost of an uncosted lot is unknown (never zero)', (await val(`select private.lot_average_cost(t.batch_id) from public.inventory_transactions t where t.product_id = $1 and t.transaction_type = 'OPENING_STOCK'`, [NONE])) === null)

// ---------------------------------------------------------------------------
console.log('\nSecurity and existing records')
ok('8. opening stock, transactions, GRNs, POs, cost history and product costs recorded before the change are unchanged', (await existing()) === existingBefore)
ok('8. the line staged before the change keeps its cost', (await val(`select unit_cost::float8 from public.inventory_opening_lines where opening_batch_id = $1`, [oldStaged.value.opening_batch_id])) === 30)
const viewer = await request('b_op', `select public.inventory_post_opening_stock_at_cost($1::jsonb, 'MANUAL', null, null, gen_random_uuid())`, [JSON.stringify([line(1, NONE, 1)])])
ok('company isolation: another company cannot post opening stock for these products / locations', viewer.value?.ok === false || Boolean(viewer.error), viewer)
ok('the older functions are still not callable by users; the private pricing is not callable',
  !(await val(`select has_function_privilege('authenticated', 'public.inventory_post_opening_stock(jsonb, text, text, text, uuid)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('authenticated', 'private.opening_price_lines(uuid, jsonb)', 'EXECUTE')`))
  && !(await val(`select has_function_privilege('anon', 'public.inventory_stock_value_summary(text, text)', 'EXECUTE')`)))
const dup = await post([line(1, NONE, 1)])
ok('existing safeguard: a second opening balance for the same product and location is still refused', dup.value?.ok === false && /already exists/.test(JSON.stringify(dup.value.errors)), dup)

// ---------------------------------------------------------------------------
console.log('\nRollback (throwaway local database)')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const again = await post([line(1, await newProduct(null), 1)])
ok('rollback restores the earlier rule (a product without a cost is refused)', again.value?.ok === false && /Product Master Cost is missing/.test(JSON.stringify(again.value.errors)), again)
ok('rollback keeps the stock posted without a cost as it is', (await opening(NONE)).cost === null && (await opening(NONE)).qty === 5)
ok('rollback restores the summary without unvalued_units', !('unvalued_units' in (await op(`select public.inventory_stock_value_summary(null, null)`))))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
const re = await post([line(1, await newProduct(null), 1)])
ok('the migration applies again, twice, and works', re.value?.ok === true, re)
ok('every later migration still applies on top', await (async () => { for (const f of files.filter((x) => x > `${NAME}.sql`)) await db.exec(await read(path.join(migDir, f))); return true })())

console.log(`${failed === 0 ? '✓' : '✗'} opening stock optional cost check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
