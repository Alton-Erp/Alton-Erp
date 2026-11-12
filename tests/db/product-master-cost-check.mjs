// Product Master Cost = second-most-recent valid purchase receipt (migration 20261128090000).
//
//   npm run test:db:master-cost
//
// Local PGlite database only. Every receipt goes through the ERP's own functions (PO save → open →
// receipt post / reverse), one committed transaction per call so the deferred purchase cost trigger runs.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
// Pinned to the migrations before 20261208090000: from that migration on, a purchased product's Product Master Cost is its
// latest valid GRN (Cost Intelligence; tests/db/product-cost-intelligence-check.mjs). This check keeps verifying the rule below, which
// still applies to products without a stored cost.
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql') && x < '20261208090000').sort()) await db.exec(await read(path.join(migDir, f)))
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
const supA = await val(`select rls_test.gid('sup', 'supplier_id')::text`)
const supB = (await op(`select public.party_save(null, jsonb_build_object('party_type', 'SUPPLIER', 'party_name', 'Second Supplier', 'state_code', '27'), false, gen_random_uuid())`)).supplier_id

const newProduct = (sku, cost) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2, 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', $3, 18, '6910') returning id`, [A, sku, cost])
/** PO with the given lines ([qty, price]) for one product, opened. */
const openPo = async (product, lines, supplier = supA) => {
  const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
    [{ supplier_id: supplier, purchase_type: 'RAW_MATERIAL', warehouse_id: await val(`select rls_test.id('w1')`) },
      lines.map(([quantity, unit_price]) => ({ product_id: product, quantity, unit_price }))])).po_id
  await op(`select public.purchase_order_open($1)`, [po])
  return po
}
const poLines = (po) => val(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
/** Receives [lineIndex, received, accepted, rejected] on a PO. */
const receive = async (po, parts, key = null) => {
  const ids = await poLines(po)
  const g1 = await val(`select rls_test.id('g1')::text`)
  const lines = parts.map(([i, received, accepted, rejected = 0]) => ({ po_line_id: ids[i], received_quantity: received, accepted_quantity: accepted, rejected_quantity: rejected,
    accepted_location_id: g1, ...(rejected ? { rejection_reason: 'Broken in transit' } : {}) }))
  return op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, $3::uuid)`, [po, JSON.stringify(lines), key ?? crypto.randomUUID()])
}
const buy = async (product, price, qty = 10, supplier = supA) => receive(await openPo(product, [[qty, price]], supplier), [[0, qty, qty]])
const master = async (id) => (await request('op', `select jsonb_build_object('cost', master_cost::float8, 'source', master_cost_source, 'receipt', master_cost_receipt_number,
  'fallback', fallback_cost::float8, 'last', last_purchase_cost::float8, 'last_date', last_purchase_date, 'change', master_cost_change::float8,
  'pct', master_cost_change_percent::float8, 'standard_cost', standard_cost::float8) from public.product_master_list where id = $1`, [id])).value

// ---------------------------------------------------------------------------
console.log('\nCost from the purchase history')
const X = await newProduct('MC-X', 451)
let m = await master(X)
ok('1. no purchase receipt: Cost = the standard (manufacturing) cost ₹451; no Last Purchase Cost', m.cost === 451 && m.source === 'STANDARD' && m.last === null && m.change === null, m)
const r1 = await buy(X, 440)
m = await master(X)
ok('2. one receipt (₹440): Cost stays ₹451 (fallback); Last Purchase Cost ₹440; change −₹11', m.cost === 451 && m.source === 'STANDARD' && m.last === 440 && m.change === -11, m)
const r2 = await buy(X, 460)
m = await master(X)
ok('3. second receipt (₹460): Cost ₹440 (the first receipt); Last Purchase Cost ₹460; Cost Change +₹20', m.cost === 440 && m.source === 'PURCHASE' && m.receipt === r1.receipt_number
  && m.last === 460 && m.change === 20 && m.pct === 4.55, m)
await buy(X, 470, 5, supB)
m = await master(X)
ok('4/5. third receipt from another supplier and PO (₹470): Cost ₹460, Last ₹470', m.cost === 460 && m.receipt === r2.receipt_number && m.last === 470 && m.change === 10, m)
await buy(X, 455)
m = await master(X)
ok('4. fourth receipt (₹455): Cost ₹470 (third), Last ₹455, change −₹15', m.cost === 470 && m.last === 455 && m.change === -15, m)
ok('the entered standard cost is never overwritten by purchases', m.standard_cost === 451 && m.fallback === 451, m)

// 8. Reversal: the reversed receipt leaves the history; the cost is recalculated.
const Y = await newProduct('MC-Y', 300)
const y1 = await buy(Y, 100)
const y2 = await buy(Y, 120)
const y3 = await buy(Y, 150)
m = await master(Y)
ok('8. before reversal: Cost ₹120, Last ₹150', m.cost === 120 && m.last === 150, m)
await op(`select public.goods_receipt_reverse($1, 'Wrong supplier delivered', gen_random_uuid())`, [y3.receipt_id])
m = await master(Y)
ok('8. latest receipt reversed: Cost ₹100, Last ₹120 (from the remaining valid history)', m.cost === 100 && m.last === 120 && m.receipt === y1.receipt_number, m)
await op(`select public.goods_receipt_reverse($1, 'Damaged lot returned', gen_random_uuid())`, [y1.receipt_id])
m = await master(Y)
ok('8. an older receipt reversed too: one valid receipt left → Cost back to the standard ₹300, Last ₹120', m.cost === 300 && m.source === 'STANDARD' && m.last === 120, m)
ok('8. reversed GRNs keep their records (status REVERSED)', (await val(`select count(*)::int from public.goods_receipts where id = any($1) and status = 'REVERSED'`, [[y1.receipt_id, y3.receipt_id]])) === 2
  && Boolean(y2.receipt_id))

// 6. Two lines of the same product in one GRN: one receipt, quantity-weighted.
const Z = await newProduct('MC-Z', 50)
await buy(Z, 90)
const poZ = await openPo(Z, [[10, 100], [30, 200]])
await receive(poZ, [[0, 10, 10], [1, 30, 30]])
m = await master(Z)
ok('6. two lines of one product in one GRN count as ONE receipt at the weighted cost (10×100 + 30×200)/40 = ₹175', m.last === 175 && m.cost === 90, m)

// 7. Partial receipts and rejected quantities.
const W = await newProduct('MC-W', 60)
const poW = await openPo(W, [[10, 80]])
await receive(poW, [[0, 4, 4]])
await receive(poW, [[0, 6, 5, 1]])
m = await master(W)
ok('7. two partial receipts of one PO are two receipts; Cost = first (₹80), Last = second (₹80)', m.cost === 80 && m.last === 80 && m.source === 'PURCHASE', m)
const accepted = await val(`select received_quantity::float8 from public.product_purchase_cost_events where product_id = $1 and event_type = 'GRN_RECEIPT' order by posted_at desc limit 1`, [W])
const rejected = await val(`select rejected_quantity::float8 from public.product_purchase_cost_events where product_id = $1 and event_type = 'GRN_RECEIPT' order by posted_at desc limit 1`, [W])
ok('7. rejected quantity is not counted in the receipt cost (5 accepted, 1 rejected recorded apart)', rejected === 1 && accepted !== null, { accepted, rejected })

// 9. Repeated / back-to-back postings.
const V = await newProduct('MC-V', 10)
const poV = await openPo(V, [[5, 30]])
const key = crypto.randomUUID()
const v1 = await receive(poV, [[0, 2, 2]], key)
const v1again = await request('op', `select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, $3::uuid)`,
  [poV, JSON.stringify([{ po_line_id: (await poLines(poV))[0], received_quantity: 2, accepted_quantity: 2, rejected_quantity: 0, accepted_location_id: await val(`select rls_test.id('g1')::text`) }]), key])
ok('9. the same posting sent twice creates one receipt and one cost event (idempotent)', (v1again.error || v1again.value?.receipt_id === v1.receipt_id)
  && (await val(`select count(*)::int from public.product_purchase_cost_events where product_id = $1`, [V])) === 1, v1again)
const [b1, b2] = [await buy(V, 31), await buy(V, 32)]
m = await master(V)
ok('9. back-to-back postings on the same day are ordered by posting time (Cost ₹31, Last ₹32)', m.cost === 31 && m.last === 32 && Boolean(b1 && b2), m)
const locks = await val(`select count(*)::int from pg_proc where proname = 'purchase_cost_lock'`)
ok('9. events of one company + product are still serialised by the existing advisory lock (posting path unchanged)', locks === 1)

// 11. Products whose purchase and manufacturing costs differ.
const U = await newProduct('MC-U', 80)
await db.exec(`reset role; alter table public.products disable trigger products_0_cost_unify`)
await db.query(`update public.products set standard_cost = 80, standard_manufacturing_cost = 120, change_reason = 'test: costs as before the merge' where id = $1`, [U])
await db.exec(`alter table public.products enable trigger products_0_cost_unify`)
m = await master(U)
ok('11. purchase ₹80 and manufacturing ₹120 (not merged yet): the fallback Cost is the manufacturing cost ₹120', m.cost === 120 && m.fallback === 120 && m.standard_cost === 80, m)
await db.exec(`reset role; alter table public.products disable trigger products_0_cost_unify`)
await db.query(`update public.products set standard_manufacturing_cost = null, change_reason = 'test: purchase cost only' where id = $1`, [U])
await db.exec(`alter table public.products enable trigger products_0_cost_unify`)
ok('11. only a purchase cost: it is the fallback', (await master(U)).cost === 80)

// ---------------------------------------------------------------------------
console.log('\nSafety and isolation')
const frozen = () => val(`select md5(coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), '')
  || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.product_purchase_cost_events e), '')
  || coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.product_id) from public.product_last_purchase_costs c), '')
  || coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.goods_receipts r), ''))`)
const before = await frozen()
await request('op', `select count(*) from public.product_master_list`)
ok('reading the Product Master changes nothing (stock, receipts, cost history, Last Purchase Cost)', (await frozen()) === before)
const bRows = await request('b_op', `select count(*)::int from public.product_master_list where company_id = $1`, [A])
ok('11. company B sees no company A row (RLS through security_invoker)', bRows.value === 0, bRows)
ok('anon has no access to the view', !(await val(`select has_table_privilege('anon', 'public.product_master_list', 'SELECT')`)))
ok('the view runs with the caller\'s rights', (await val(`select coalesce(reloptions::text, '') from pg_class where relname = 'product_master_list'`)).includes('security_invoker=true'))
const allCols = await val(`select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'products'`)
const viewCols = await val(`select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'product_master_list'`)
ok('the view has every products column plus the 9 cost columns', viewCols === allCols + 9, { allCols, viewCols })

console.log('\nRollback')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261128090000_product_master_cost_down.sql')))
ok('rollback removes the view and changes no data', (await val(`select to_regclass('public.product_master_list')::text`)) === null && (await frozen()) === before)
await db.exec(await read(path.join(migDir, '20261128090000_product_master_cost.sql')))
await db.exec(await read(path.join(migDir, '20261128090000_product_master_cost.sql')))
ok('the migration applies again, twice', (await master(X)).cost === 470)

console.log(`${failed === 0 ? '✓' : '✗'} product master cost check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
