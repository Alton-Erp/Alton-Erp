// Unified Product Cost Intelligence and BOM cost (migration 20261208090000).
//
//   npm run test:db:product-cost
//
// Local PGlite database only (throwaway, in memory). Every document goes through the ERP's own functions
// (BOM save / submit / activate, PO save → open → receipt post / reverse / correct, direct GRN, production
// order save → complete), one committed transaction per call, like a request (the purchase cost is recorded
// by a trigger deferred to the end of the posting transaction).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { bomCost } from '../../src/features/production/bom-tools-model.ts'
import { bomCostExportRows } from '../../src/features/production/bom-cost-columns.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261208090000_product_cost_intelligence'
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
console.log(`✓ migrations before ${NAME.slice(0, 14)} applied, end-to-end business flow`)

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
const op = async (sql, params) => { const r = await request('op', sql, params); if (r.error) throw new Error(`${sql.slice(0, 80)}… → ${r.error}`); return r.value }
const A = await val(`select rls_test.id('company_a')::text`)
const supA = await val(`select rls_test.gid('sup', 'supplier_id')::text`)
const w1 = await val(`select rls_test.id('w1')::text`)
const g1 = await val(`select rls_test.id('g1')::text`)

// A read-only user of company A (products.read, no products.update).
const roleRead = await val(`select r.id from public.roles r where r.code <> 'SUPER_ADMIN'
  and exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'products.read')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code in ('products.update', 'products.create'))
  order by r.code limit 1`)
await db.exec(`reset role;
  insert into rls_test.ids (key, id) values ('pc_view', 'e7e5c800-0000-4000-8000-0000000000d1');
  insert into auth.users (id, email) values (rls_test.id('pc_view'), 'pc_view@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('pc_view');
  insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('pc_view'), rls_test.id('company_a'), '${roleRead}')`)

let n = 0
const product = (type, source, cost = null) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2 || ' name', $3, $4, 'PCS', 'ACTIVE', $5, 18, '6910') returning id`, [A, `PC-${String(++n).padStart(2, '0')}`, type, source, cost])
const item = (p, q, w = 0) => ({ component_product_id: p, quantity_required: q, unit: 'PCS', wastage_percentage: w, notes: null })
const saveBom = async (fg, items, out = 1) => (await op(`select public.production_save_bom(null, $1, rls_test.today(), null, $2, null, $3::jsonb, gen_random_uuid())`,
  [fg, out, JSON.stringify(items)])).bom_id
const activate = (bom) => op(`select public.production_bom_activate($1)`, [bom])
const openPo = async (lines) => {
  const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
    [{ supplier_id: supA, purchase_type: 'RAW_MATERIAL', warehouse_id: w1 }, lines])).po_id
  await op(`select public.purchase_order_open($1)`, [po])
  return po
}
const poLineIds = (po) => val(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
const receiptLines = async (po, qty) => (await poLineIds(po)).map((id) => ({ po_line_id: id, received_quantity: qty, accepted_quantity: qty, rejected_quantity: 0, accepted_location_id: g1 }))
/** PO receipt of one line (price, optional discount %), all accepted. */
const buy = async (productId, price, qty = 10, extra = {}) => {
  const po = await openPo([{ product_id: productId, quantity: qty, unit_price: price, ...extra }])
  const key = crypto.randomUUID()
  const r = await op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, $3::uuid)`, [po, JSON.stringify(await receiptLines(po, qty)), key])
  return { ...r, po, key }
}
const master = async (id, user = 'op') => (await request(user, `select jsonb_build_object('cost', master_cost::float8, 'source', master_cost_source, 'bom', bom_manufacturing_cost::float8,
  'last', last_purchase_cost::float8, 'status', cost_status, 'note', cost_status_note, 'default', default_cost_source, 'ref', master_cost_reference,
  'updated', cost_updated_at, 'version', bom_cost_version) from public.product_master_list where id = $1`, [id])).value
const history = (id) => val(`select coalesce(jsonb_agg(jsonb_build_object('prev', previous_cost::float8, 'new', new_cost::float8, 'source', new_source, 'event', event,
  'bom_version', bom_version, 'receipt', receipt_number, 'by', created_by) order by created_at), '[]') from public.product_cost_history where product_id = $1`, [id])
const histCount = () => val(`select count(*)::int from public.product_cost_history`)
const bomRow = (bom) => val(`select jsonb_build_object('unit', bom_unit_cost::float8, 'status', bom_cost_status, 'master', product_master_cost::float8,
  'diff', cost_difference::float8, 'at', cost_calculated_at, 'missing', missing_count) from public.bom_cost_list where bom_id = $1`, [bom])
/** The BOM pages' own formula (TypeScript) on the components' current Product Master Cost. */
const tsBomCost = async (items, out = 1) => {
  const costs = await val(`select jsonb_object_agg(id, master_cost::float8) from public.product_master_list where id = any($1::uuid[])`, [items.map((i) => i.component_product_id)])
  return bomCost(items.map((i) => ({ quantity: i.quantity_required, wastage: i.wastage_percentage, unitCost: costs[i.component_product_id] ?? null })), out)
}

// ---------------------------------------------------------------------------
// Data that exists before the migration: nothing may change when it is applied.
const OLD_P = await product('RAW_MATERIAL', 'OUTSOURCED', 77)
await buy(OLD_P, 70)
await buy(OLD_P, 72)
const OLD_FG = await product('FINISHED_GOOD', 'IN_HOUSE', 500)
await activate(await saveBom(OLD_FG, [item(OLD_P, 2)]))
const allMaster = () => val(`select md5(string_agg(id || ':' || coalesce(master_cost::text, '-') || ':' || coalesce(master_cost_source, '-'), '|' order by id)) from public.product_master_list`)
const ledger = () => val(`select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) from public.inventory_transactions t`)
const lots = () => val(`select md5(coalesce(string_agg(b.id || ':' || coalesce(private.lot_average_cost(b.id)::text, '-'), '|' order by b.id), '')) from public.inventory_batches b`)
const productsHash = () => val(`select md5(string_agg(to_jsonb(p)::text, '|' order by p.id)) from public.products p`)
const before = { master: await allMaster(), ledger: await ledger(), lots: await lots(), products: await productsHash() }

await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
console.log('✓ 20261208090000 applied (twice)')

console.log('\nDeployment')
ok('applying the migration changes no Product Master Cost, product, lot or ledger entry (nothing is backfilled)',
  (await allMaster()) === before.master && (await ledger()) === before.ledger && (await lots()) === before.lots && (await productsHash()) === before.products
  && (await val(`select count(*)::int from public.product_cost_profiles`)) === 0)
ok('existing products keep the earlier rule until an event or Recalculate (second-most-recent receipt ₹70)', (await master(OLD_P)).cost === 70 && (await master(OLD_P)).source === 'PURCHASE')

// ---------------------------------------------------------------------------
console.log('\nManufactured products (Rule 1)')
const C1 = await product('RAW_MATERIAL', 'OUTSOURCED', 10)
const C2 = await product('COMPONENT', 'OUTSOURCED', 25.5)
await buy(C1, 12)
await buy(C2, 30)
const FG = await product('FINISHED_GOOD', 'IN_HOUSE', 999)
const fgItems = [item(C1, 3, 5), item(C2, 2)]
const fgBom = await saveBom(FG, fgItems, 2)
let m = await master(FG)
ok('4. a draft BOM does not change the Product Master Cost (₹999 stays)', m.cost === 999 && m.bom === null && (await history(FG)).length === 0, m)
ok('4. …and the BOM list shows no approved cost for it (dash, "not approved")', (await bomRow(fgBom)).unit === null && (await bomRow(fgBom)).status === 'NOT_APPROVED')
await op(`select public.production_bom_action($1, 'SUBMIT', null)`, [fgBom])
m = await master(FG)
ok('5. a BOM pending approval does not change it either', m.cost === 999 && (await val(`select status from public.boms where id = $1`, [fgBom])) === 'PENDING_APPROVAL', m)
await activate(fgBom)
const exp = await tsBomCost(fgItems, 2)
m = await master(FG)
ok(`1/6. approval + activation: Product Master Cost = BOM Manufacturing Cost ₹${exp.perUnit} (3×1.05×12 + 2×30) ÷ 2`, exp.complete && exp.perUnit === 48.9
  && m.cost === 48.9 && m.bom === 48.9 && m.source === 'BOM' && m.status === 'CURRENT' && m.version === 1 && Boolean(m.updated), { exp, m })
let h = await history(FG)
ok('6. history: ₹999 → ₹48.90, source BOM, event BOM_ACTIVATED, BOM version 1, by the user', h.length === 1 && h[0].prev === 999 && h[0].new === 48.9
  && h[0].event === 'BOM_ACTIVATED' && h[0].bom_version === 1 && h[0].by === await val(`select rls_test.id('op')::text`), h)
let row = await bomRow(fgBom)
ok('19. BOM list: BOM Cost / Unit ₹48.90 = the BOM pages\' formula, Product Master Cost ₹48.90, difference 0, calculation time', row.unit === exp.perUnit
  && row.master === 48.9 && row.diff === 0 && row.status === 'COMPLETE' && Boolean(row.at), row)

// New version: v2 activation recalculates; v1 (archived) no longer shows an approved cost.
const fgItems2 = [item(C1, 4), item(C2, 2)]
const fgBom2 = await saveBom(FG, fgItems2, 2)
m = await master(FG)
ok('4. a new draft version of an active BOM leaves the cost at ₹48.90', m.cost === 48.9, m)
await activate(fgBom2)
m = await master(FG)
ok('6. activating v2 recalculates: (4×12 + 2×30) ÷ 2 = ₹54.00, history v2', m.cost === 54 && m.version === 2 && (await history(FG)).at(-1).bom_version === 2, m)
ok('the superseded version shows a dash in the BOM list', (await bomRow(fgBom)).unit === null && (await bomRow(fgBom2)).unit === 54)

// Missing component cost: never treated as zero.
const C3 = await product('COMPONENT', 'OUTSOURCED', null)
const FG3 = await product('FINISHED_GOOD', 'IN_HOUSE', 400)
const fg3Bom = await saveBom(FG3, [item(C1, 1), item(C3, 1)])
await activate(fg3Bom)
m = await master(FG3)
row = await bomRow(fg3Bom)
ok('F. a component without a cost: no BOM cost (not counted as zero), Product Master Cost ₹400 kept, status explains it', m.cost === 400 && m.bom === null
  && m.status === 'BOM_INCOMPLETE' && /1 component/.test(m.note ?? '') && row.unit === null && row.status === 'MISSING_COSTS' && row.missing === 1, { m, row })

// ---------------------------------------------------------------------------
console.log('\nPurchased products (Rule 2) and no source (Rule 3)')
const P = await product('RAW_MATERIAL', 'OUTSOURCED', 50)
m = await master(P)
ok('3. no BOM and no GRN: the existing cost ₹50 is kept; no cost record is created', m.cost === 50 && m.source === 'STANDARD'
  && (await val(`select count(*)::int from public.product_cost_profiles where product_id = $1`, [P])) === 0, m)
const p1 = await buy(P, 100)
m = await master(P)
ok('2/7. first posted GRN (₹100): Product Master Cost ₹100 from the GRN', m.cost === 100 && m.source === 'GRN' && m.ref === p1.receipt_number && m.last === 100, m)
const p2 = await buy(P, 120)
m = await master(P)
ok('7. a newer GRN (₹120) updates it to the latest valid purchase cost', m.cost === 120 && m.ref === p2.receipt_number, m)
const opening = await op(`select public.opening_stock_product_costs(array[$1]::uuid[])`, [P])
ok('7. opening stock is priced at the same Product Master Cost (₹120, source GRN)', opening?.costs?.[0]?.cost === 120 && opening.costs[0].source === 'GRN', opening)
const again = await request('op', `select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, $3::uuid)`,
  [p2.po, JSON.stringify(await receiptLines(p2.po, 10)), p2.key])
ok('21. the same GRN posted again (retry): one receipt, no second history row', again.value?.receipt_id === p2.receipt_id && (await history(P)).length === 2, again)
await op(`select public.goods_receipt_reverse($1, 'Wrong supplier delivered', gen_random_uuid())`, [p2.receipt_id])
m = await master(P)
h = await history(P)
ok('8. reversing the ₹120 GRN removes it: back to ₹100 (latest remaining valid GRN), event GRN_REVERSED', m.cost === 100 && m.ref === p1.receipt_number
  && h.at(-1).event === 'GRN_REVERSED' && h.at(-1).new === 100, { m, h })
const corrPo = await openPo([{ product_id: P, quantity: 10, unit_price: 100 }])
const toCorrect = await op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, gen_random_uuid())`,
  [corrPo, JSON.stringify(await receiptLines(corrPo, 10))])
const corrected = await op(`select public.goods_receipt_correct_refs($1, 'Supplier invoice shows ₹110', jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, gen_random_uuid())`,
  [toCorrect.receipt_id, JSON.stringify((await receiptLines(corrPo, 10)).map((l) => ({ ...l, actual_unit_price: 110, price_variance_reason: 'Supplier price revision' })))])
m = await master(P)
ok('9. a corrected GRN (reversed + reposted at ₹110) updates the purchase cost to ₹110', m.cost === 110 && m.ref === corrected.receipt_number, m)
await op(`select public.goods_receipt_reverse($1, 'Returned', gen_random_uuid())`, [corrected.receipt_id])
await op(`select public.goods_receipt_reverse($1, 'Returned', gen_random_uuid())`, [p1.receipt_id])
m = await master(P)
ok('3. every GRN reversed: no valid purchase cost left → the cost (₹100) is kept, never zero or blank, with a clear status',
  m.cost === 100 && m.status === 'NO_NEW_COST' && /No new cost available/.test(m.note ?? ''), m)

const T = await product('RAW_MATERIAL', 'OUTSOURCED', 1)
await buy(T, 200)
ok('14. GST excluded: ₹200 + 18% GST → Product Master Cost ₹200', (await master(T)).cost === 200)
await buy(T, 200, 10, { discount_percent: 10 })
ok('15. discount applied the existing way: ₹200 less 10% → ₹180', (await master(T)).cost === 180, await master(T))

// Manual purchase cost override (existing function and permission): visible, not lost on recalculation.
await op(`select public.product_purchase_cost_override($1, 175, 'Supplier credit note agreed')`, [T])
m = await master(T)
ok('E. an authorised manual purchase cost override (₹175) becomes the cost with source MANUAL', m.cost === 175 && m.source === 'MANUAL', m)
await op(`select public.product_cost_recalculate(array[$1]::uuid[])`, [T])
ok('E. …and does not silently disappear on recalculation', (await master(T)).cost === 175 && (await master(T)).source === 'MANUAL')

// ---------------------------------------------------------------------------
console.log('\nBoth (Make & Buy)')
const H = await product('FINISHED_GOOD', 'HYBRID', 300)
const hItems = [item(C1, 5), item(C2, 1)]
await activate(await saveBom(H, hItems))
m = await master(H)
ok('10. Both: default source BOM → Product Master Cost = BOM cost 5×12 + 30 = ₹90', m.cost === 90 && m.source === 'BOM' && m.default === 'BOM', m)
const hGrn = await buy(H, 140, 4)
m = await master(H)
ok('10. a GRN for a Both product does not overwrite the manufacturing cost (cost ₹90, BOM ₹90, Last Purchase ₹140)', m.cost === 90 && m.bom === 90 && m.last === 140, m)
const view = await request('pc_view', `select public.product_cost_set_default_source($1, 'GRN', 'Mostly bought')`, [H])
ok('18. a user without products.update cannot change the default cost source', /products\.update|permission/i.test(view.error ?? ''), view)
const setGrn = await op(`select public.product_cost_set_default_source($1, 'GRN', 'Mostly bought now')`, [H])
m = await master(H)
ok('10. default source set to GRN by an authorised user: cost ₹140 (purchase), BOM cost still ₹90 kept separately', setGrn.master_cost == 140 && m.cost === 140
  && m.bom === 90 && m.default === 'GRN' && (await history(H)).at(-1).event === 'DEFAULT_SOURCE_CHANGED', m)
await activate(await saveBom(H, [item(C1, 6), item(C2, 1)]))
m = await master(H)
ok('10. a new BOM activation updates the BOM cost (₹102) but not the purchase-based cost (₹140)', m.bom === 102 && m.cost === 140 && m.last === 140, m)
const notBoth = await request('op', `select public.product_cost_set_default_source($1, 'GRN', null)`, [FG])
ok('the default cost source is only for Both products', /Both/.test(notBoth.error ?? ''), notBoth)

// 11 / 12 / 13: each receipt keeps its own cost; Product Master Cost never rewrites stock.
const hLot = await val(`select jsonb_build_object('tx', t.unit_cost::float8, 'lot', private.lot_average_cost(t.batch_id)::float8) from public.inventory_transactions t
  where t.reference_id = $1 and t.product_id = $2 and t.transaction_type = 'RECEIPT' limit 1`, [hGrn.po, H])
ok('12. the purchased receipt of the Both product is valued at the GRN actual cost ₹140 (not the Product Master Cost)', hLot?.tx === 140 && hLot?.lot === 140, hLot)
const ledgerBefore = await val(`select jsonb_object_agg(id, unit_cost) from public.inventory_transactions`)
const lotCosts = (ids = null) => val(`select jsonb_object_agg(id, private.lot_average_cost(id)) from public.inventory_batches where $1::uuid[] is null or id = any($1::uuid[])`, [ids])
const lotsBefore = await lotCosts()
await op(`select public.product_cost_set_default_source($1, 'BOM', 'Back to manufacturing')`, [H])
await buy(C1, 12, 20) // materials for the production order, at the same ₹12
const order = await op(`select public.production_order_v2_save(null, $1::jsonb, gen_random_uuid())`, [JSON.stringify({ product_id: H, planned_quantity: 2, production_date: await val(`select rls_test.today()::text`) })])
const done = await request('op', `select public.production_order_v2_complete($1, $2::jsonb, gen_random_uuid())`, [order.order_id, JSON.stringify({ actual_quantity: 2 })])
const prodCost = await val(`select unit_cost::float8 from public.inventory_transactions where reference_id = $1 and transaction_type = 'PRODUCTION_RECEIPT' and product_id = $2 limit 1`, [order.order_id, H])
ok('11. the manufactured receipt is valued at the manufacturing cost of the approved BOM (6×12 + 30 = ₹102 from the issued lots), not the ₹140 purchase cost',
  !done.error && prodCost === 102, { done, prodCost })
const ledgerAfter = await val(`select jsonb_object_agg(id, unit_cost) from public.inventory_transactions where id = any(select jsonb_object_keys($1::jsonb)::uuid)`, [JSON.stringify(ledgerBefore)])
ok('13. historical stock valuation unchanged: every earlier ledger entry and lot keeps its cost', JSON.stringify(ledgerAfter) === JSON.stringify(ledgerBefore)
  && JSON.stringify(await lotCosts(Object.keys(lotsBefore))) === JSON.stringify(lotsBefore), { ledger: Object.keys(ledgerBefore).length, lots: Object.keys(lotsBefore).length })
ok('13. the lot of the earlier GRN still carries ₹140 after the cost source changed', (await val(`select private.lot_average_cost(t.batch_id)::float8 from public.inventory_transactions t
  where t.reference_id = $1 and t.product_id = $2 and t.transaction_type = 'RECEIPT' limit 1`, [hGrn.po, H])) === 140)

// ---------------------------------------------------------------------------
console.log('\nComponent cost changes, circular BOMs, permissions')
const SUB = await product('SUBASSEMBLY', 'IN_HOUSE', 5)
await activate(await saveBom(SUB, [item(C1, 2)]))
const TOP = await product('FINISHED_GOOD', 'IN_HOUSE', 5)
const topBom = await saveBom(TOP, [item(SUB, 3), item(C2, 1)])
await activate(topBom)
ok('setup: SUB = 2×12 = ₹24, TOP = 3×24 + 30 = ₹102', (await master(SUB)).cost === 24 && (await master(TOP)).cost === 102)
await buy(C1, 15)
ok('16. a component cost change (C1 ₹12 → ₹15) recalculates the dependent BOMs up the tree: SUB ₹30, TOP ₹120, FG ₹(4×15+60)/2 = ₹60',
  (await master(SUB)).cost === 30 && (await master(TOP)).cost === 120 && (await master(FG)).cost === 60 && (await bomRow(topBom)).unit === 120)
ok('16. the dependent change is recorded as COMPONENT_COST_CHANGED', (await history(TOP)).at(-1).event === 'COMPONENT_COST_CHANGED')
const cyc = await request('op', `select public.production_save_bom(null, $1, rls_test.today(), null, 1, null, $2::jsonb, gen_random_uuid())`, [SUB, JSON.stringify([item(TOP, 1)])])
ok('17. a circular BOM (SUB inside TOP inside SUB) is refused', /circular|cycle/i.test(cyc.error ?? ''), cyc)
// A cycle that bypassed validation (owner insert) must not loop forever.
await db.exec(`reset role; alter table public.bom_items disable trigger user;
  insert into public.bom_items (company_id, bom_id, line_no, component_product_id, quantity_required, unit)
  select company_id, id, 99, '${TOP}', 1, 'PCS' from public.boms where finished_product_id = '${SUB}' and status = 'APPROVED';
  alter table public.bom_items enable trigger user;`)
const loop = await request('op', `select public.product_cost_recalculate(array[$1]::uuid[])`, [C1])
ok('17. …and a cycle that got into the data anyway stops safely (no endless recalculation)', !loop.error && (await val(`select count(*)::int from public.product_cost_profiles
  where product_id in ($1, $2) and cost_status in ('CIRCULAR_DEPENDENCY', 'BOM_INCOMPLETE', 'CURRENT')`, [SUB, TOP])) === 2, loop)
await db.exec(`reset role; alter table public.bom_items disable trigger user; delete from public.bom_items where line_no = 99 and component_product_id = '${TOP}'; alter table public.bom_items enable trigger user;`)

const rec = await request('pc_view', `select public.product_cost_recalculate(null)`)
ok('18. a user without products.update cannot recalculate', /products\.update|permission/i.test(rec.error ?? ''), rec)
const apply = await request('pc_view', `select public.product_sourcing_apply($1, 'HYBRID', null)`, [P])
ok('18. …nor change the sourcing method', /products\.update|permission/i.test(apply.error ?? ''), apply)
const direct = await request('op', `update public.product_cost_profiles set current_cost = 1 where product_id = $1`, [FG])
const directH = await request('op', `insert into public.product_cost_history (company_id, product_id, new_cost, new_source, event, reason) values ($1, $2, 1, 'BOM', 'RECALCULATED', 'x')`, [A, FG])
ok('18. nobody writes the cost tables directly (only the database functions)', Boolean(direct.error) && Boolean(directH.error) && (await master(FG)).cost === 60, { direct, directH })
ok('18. anon cannot call the cost functions', !(await val(`select has_function_privilege('anon', 'public.product_cost_recalculate(uuid[])', 'EXECUTE')
  or has_function_privilege('anon', 'public.product_cost_set_default_source(uuid, text, text)', 'EXECUTE') or has_function_privilege('anon', 'public.product_sourcing_apply(uuid, text, text)', 'EXECUTE')`)))
const otherCo = await request('b_op', `select count(*)::int from public.product_cost_history`)
const otherBom = await request('b_op', `select count(*)::int from public.bom_cost_list where bom_id = $1`, [topBom])
ok('company isolation: another company sees none of these cost rows', otherCo.value === 0 && otherBom.value === 0, { otherCo, otherBom })
const otherSet = await request('b_op', `select public.product_cost_set_default_source($1, 'GRN', null)`, [H])
ok('company isolation: another company cannot change this product', /not found/i.test(otherSet.error ?? ''), otherSet)
ok('the read-only user sees the costs (products.read)', (await master(FG, 'pc_view'))?.cost === 60)

// ---------------------------------------------------------------------------
console.log('\nRecalculation, sourcing proposals, export')
const before21 = await histCount()
const rc1 = await op(`select public.product_cost_recalculate(null)`)
const mid21 = await histCount()
const rc2 = await op(`select public.product_cost_recalculate(null)`)
ok('21. repeated recalculation creates no duplicate history (second run: 0 changes)', rc2.changed === 0 && (await histCount()) === mid21, { rc1, rc2, before21, mid21 })
ok('Recalculate applies the rules to products from before the migration (OLD_P: latest GRN ₹72; OLD_FG: BOM 2×72 = ₹144)',
  (await master(OLD_P)).cost === 72 && (await master(OLD_P)).source === 'GRN' && (await master(OLD_FG)).cost === 144, { p: await master(OLD_P), fg: await master(OLD_FG) })
const props = await op(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.product_sourcing_proposals(array[$1, $2]::uuid[]) x`, [FG, C1])
ok('B. products whose sourcing method matches their BOM / GRN history get no proposal (C1 bought, FG manufactured)', Array.isArray(props) && props.length === 0, props)
const fgGrn = await buy(FG, 70, 2)
const prop = await op(`select to_jsonb(x) from public.product_sourcing_proposals(array[$1]::uuid[]) x`, [FG])
ok('B. FG has approved BOMs and a posted GRN → proposed HYBRID; its method is still IN_HOUSE', prop?.proposed_method === 'HYBRID' && prop.current_method === 'IN_HOUSE'
  && (await val(`select default_source_type from public.products where id = $1`, [FG])) === 'IN_HOUSE' && Boolean(fgGrn.receipt_id), prop)
ok('B. the GRN did not change the manufactured product\'s cost (₹60)', (await master(FG)).cost === 60)
const applied = await op(`select public.product_sourcing_apply($1, 'OUTSOURCED', 'Now bought in')`, [FG])
ok('B. an authorised user applies a sourcing method: product version + audit, cost follows the new rule (₹70 GRN)', applied.changed === true && (await master(FG)).cost === 70
  && (await val(`select count(*)::int from public.audit_logs where action = 'products.sourcing_method_changed' and resource_id = $1`, [FG])) === 1
  && (await history(FG)).at(-1).event === 'SOURCING_CHANGED')

const rows = await op(`select jsonb_agg(to_jsonb(c)) from public.bom_cost_list c where bom_id = any($1::uuid[])`, [[topBom, fgBom, fgBom2]])
const boms = await op(`select jsonb_agg(jsonb_build_object('id', id, 'bom_code', bom_code, 'version', version, 'sku', sku, 'product_name', product_name, 'status', status)) from public.bom_list_v2 where id = any($1::uuid[])`, [[topBom, fgBom, fgBom2]])
const sheet = bomCostExportRows(boms, new Map(rows.map((r) => [r.bom_id, r])))
const top = sheet.find((r) => r[0] === boms.find((b) => b.id === topBom).bom_code)
ok('20. the BOM cost export uses the same values as the list (TOP: ₹120.00, Product Master ₹120.00, difference ₹0.00)', top && top[5] === 120 && top[6] === 120 && top[7] === 0, top)
ok('20. …and a dash-equivalent (blank) for versions without an approved cost', sheet.filter((r) => r[5] === '').length === 1, sheet)

// ---------------------------------------------------------------------------
console.log('\nRollback')
const down = await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`))
await db.exec(down)
const gone = await val(`select count(*)::int from pg_class where relname in ('product_cost_profiles', 'product_cost_history', 'bom_cost_snapshots', 'bom_cost_list')`)
const resetCount = await val(`select count(*)::int from private.erp_reset_tables()`)
ok('rollback removes the tables, views, functions and triggers; the reset list is back to 85', gone === 0 && resetCount === 85
  && (await val(`select count(*)::int from pg_trigger where tgname in ('boms_product_cost', 'products_product_cost', 'product_cost_follows_last_purchase')`)) === 0)
const oldRule = await val(`select jsonb_build_object('cost', master_cost::float8, 'source', master_cost_source) from public.product_master_list where id = $1`, [OLD_P])
ok('rollback restores product_master_list with the earlier rule (OLD_P: second-most-recent ₹70)', oldRule?.cost === 70 && oldRule?.source === 'PURCHASE', oldRule)
await db.exec(await read(path.join(migDir, `${NAME}.sql`)))
ok('the migration applies again after the rollback (reset list 88)', (await val(`select count(*)::int from private.erp_reset_tables()`)) === 88)

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
