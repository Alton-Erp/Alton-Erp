// Editable actual purchase cost at GRN level (migration 20261202090000).
//
//   npm run test:db:grn-actual-cost
//
// Local PGlite database only (throwaway, in memory). Every receipt goes through the ERP's own functions
// (PO save → open → receipt post / reverse / correct / amend), one committed transaction per call so the
// deferred purchase cost trigger runs. The Product Master Cost comes from the existing view
// product_master_list. The receipt screen's calculation (src/features/purchasing/grn-price.ts) is run on
// the same order lines and must give exactly the stored cost and payable.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { receiptPayable } from '../../src/features/purchasing/grn-price.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const MIG = '20261202090000_grn_actual_cost.sql'
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
const g1 = await val(`select rls_test.id('g1')::text`)
const w1 = await val(`select rls_test.id('w1')::text`)
const startedAt = await val(`select clock_timestamp()::text`)

// A read-only user (Management Viewer) in company A, and a rejected-goods location in warehouse W1.
await db.exec(`reset role;
  insert into rls_test.ids (key, id) values ('grn_view', 'e7e5c800-0000-4000-8000-0000000000f1');
  insert into auth.users (id, email) values (rls_test.id('grn_view'), 'grn_view@e7.example.invalid');
  update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('grn_view');
  insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('grn_view'), rls_test.id('company_a'), rls_test.id('role_management_viewer'))`)
const rejLoc = await val(`insert into public.inventory_locations (company_id, warehouse_id, location_code, location_name, location_type, stock_usage)
  values ($1, $2, 'GA-REJ', 'GRN audit rejected goods', 'BIN', 'REJECTED') returning id::text`, [A, w1])

// Suppliers for every PO tax treatment (the company GSTIN decides intra / inter state).
const coGstin = await val(`select gstin from public.companies where id = $1`, [A])
const st = coGstin.slice(0, 2)
const supplier = async (name, extra) => (await op(`select public.party_save(null, $1::jsonb, true, gen_random_uuid())`,
  [{ party_type: 'SUPPLIER', party_name: name, ...extra }])).supplier_id
const SUP = {
  INTRA_STATE: await supplier('GA Intra', { gstin: `${st}AABCA1234A1Z5`, state_code: st }),
  INTER_STATE: await supplier('GA Inter', { gstin: `${st === '29' ? '27' : '29'}AABCB1234B1Z5`, state_code: st === '29' ? '27' : '29' }),
  NO_GST: await supplier('GA No GSTIN', { state_code: st }),
  IMPORT: await supplier('GA Overseas', { country: 'Germany' }),
}

let skuNo = 0
const newProduct = (cost = 1, sku = `GA-${++skuNo}`) => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2, 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', $3, 18, '6910') returning id`, [A, sku, cost])
/** PO with the given lines ({ product_id?, quantity, unit_price, discount_percent?, discount_amount?, line_type? }), opened. */
const openPo = async (lines, sup = SUP.INTRA_STATE) => {
  const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`,
    [{ supplier_id: sup, purchase_type: 'RAW_MATERIAL', warehouse_id: w1 }, lines])).po_id
  await op(`select public.purchase_order_open($1)`, [po])
  return po
}
const poLineIds = (po) => val(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
/** Receipt lines: { i, qty, acc?, rej?, actual?, reason?, rejLocation? } */
const lineInput = async (po, parts) => {
  const ids = await poLineIds(po)
  const types = await val(`select jsonb_agg(line_type order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
  return parts.map(({ i = 0, qty, acc = qty, rej = 0, actual, reason, rejLocation }) => ({ po_line_id: ids[i], received_quantity: qty, accepted_quantity: acc, rejected_quantity: rej,
    accepted_location_id: acc && types[i] === 'GOODS' ? g1 : null, rejected_location_id: rejLocation ?? null, ...(rej ? { rejection_reason: 'Broken in transit' } : {}),
    ...(actual !== undefined ? { actual_unit_price: actual } : {}), ...(reason ? { price_variance_reason: reason } : {}) }))
}
const post = async (user, po, parts, key = crypto.randomUUID()) => request(user, `select public.purchase_receipt_post_refs($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, $3::uuid)`,
  [po, JSON.stringify(await lineInput(po, parts)), key])
const receive = async (po, parts, key) => { const r = await post('op', po, parts, key); if (r.error) throw new Error(r.error); return r.value }
const master = async (id) => (await request('op', `select jsonb_build_object('cost', master_cost::float8, 'source', master_cost_source, 'last', last_purchase_cost::float8,
  'change', master_cost_change::float8, 'standard_cost', standard_cost::float8) from public.product_master_list where id = $1`, [id])).value
const grnLines = (receipt) => val(`select jsonb_agg(jsonb_build_object('po', l.po_unit_price::float8, 'po_cost', l.po_unit_cost::float8, 'actual', l.actual_unit_price::float8,
  'reason', l.price_variance_reason, 'cost', l.unit_cost::float8, 'value', l.line_value::float8,
  'rej_cost', (select unit_cost::float8 from public.inventory_transactions where id = l.rejected_transaction_id),
  'acc_cost', (select unit_cost::float8 from public.inventory_transactions where id = l.accepted_transaction_id)) order by pl.line_no)
  from public.goods_receipt_lines l join public.purchase_order_lines pl on pl.id = l.purchase_order_line_id where l.goods_receipt_id = $1`, [receipt])
const grnLine = async (receipt) => (await grnLines(receipt))[0]
const receiptValue = (receipt) => val(`select private.goods_receipt_value($1)::float8`, [receipt])
const payable = (sup) => val(`select private.supplier_payable($1)::float8`, [sup])
const treatment = (po) => val(`select tax_treatment from public.purchase_orders where id = $1`, [po])
/** Order line as text (exact decimals), for the screen's calculation. */
const pricedLine = (po, i = 0) => val(`select jsonb_build_object('line_type', line_type, 'ordered_quantity', ordered_quantity::text, 'unit_price', unit_price::text,
  'discount_percent', discount_percent::text, 'discount_amount', discount_amount::text, 'taxable_value', taxable_value::text, 'line_total', line_total::text,
  'cgst_rate', cgst_rate::text, 'sgst_rate', sgst_rate::text, 'igst_rate', igst_rate::text)
  from public.purchase_order_lines where purchase_order_id = $1 order by line_no offset $2 limit 1`, [po, i])
/** The screen's preview must match the stored cost and payable exactly. */
const screenAgrees = async (po, receipt, parts) => {
  const lines = await grnLines(receipt)
  for (const [k, p] of parts.entries()) {
    const line = await pricedLine(po, p.i ?? 0)
    const s = receiptPayable(line, p.actual ?? line.unit_price, String(p.acc ?? p.qty))
    const g = lines[k]
    if (s.payable !== g.value || (line.line_type === 'GOODS' && s.cost !== g.cost)) return { screen: s, stored: g }
  }
  return true
}

// ---------------------------------------------------------------------------
console.log('\nScenario: standard manufacturing cost ₹451')
const X = await newProduct(451, 'GA-X')
const po1 = await openPo([{ product_id: X, quantity: 10, unit_price: 10 }])
const r1 = await receive(po1, [{ qty: 10, actual: 10 }])
let m = await master(X)
ok('GRN 1: PO ₹10, actual ₹10 → Product Master Cost ₹451, Last Purchase Cost ₹10', m.cost === 451 && m.source === 'STANDARD' && m.last === 10, m)
const po2 = await openPo([{ product_id: X, quantity: 10, unit_price: 12 }])
const po2Before = await pricedLine(po2)
const r2 = await receive(po2, [{ qty: 10, actual: 15, reason: 'Supplier price revision' }])
m = await master(X)
ok('GRN 2: PO ₹12, actual ₹15 → Cost ₹10, Last ₹15, Cost Change +₹5', m.cost === 10 && m.last === 15 && m.change === 5, m)
ok('the purchase order is never changed by a price change', JSON.stringify(await pricedLine(po2)) === JSON.stringify(po2Before))
const po3 = await openPo([{ product_id: X, quantity: 10, unit_price: 15 }])
const r3 = await receive(po3, [{ qty: 10, actual: 17, reason: 'Market price increase' }])
m = await master(X)
ok('GRN 3: PO ₹15, actual ₹17 → Cost ₹15, Last ₹17, Cost Change +₹2', m.cost === 15 && m.last === 17 && m.change === 2, m)
ok('products.standard_cost is never overwritten (still ₹451)', m.standard_cost === 451, m)
ok('accepted stock is valued at the actual cost (inventory movement ₹17)', (await grnLine(r3.receipt_id)).acc_cost === 17)
const ev = await val(`select details from public.purchase_order_events where purchase_order_id = $1 and event_type = 'RECEIPT_POSTED' order by created_at desc limit 1`, [po3])
const ch = ev?.price_changes?.[0]
ok('audit: the receipt event records PO price and cost, actual price and cost, difference, variance %, reason and payable', ch && Number(ch.po_unit_price) === 15
  && Number(ch.actual_unit_price) === 17 && Number(ch.difference) === 2 && Number(ch.variance_percent) === 13.33 && Number(ch.po_unit_cost) === 15
  && Number(ch.actual_unit_cost) === 17 && Number(ch.payable) === 200.6 && ch.reason === 'Market price increase', ev)
ok('audit: the user and time are recorded on the GRN', (await val(`select (created_by = rls_test.id('op') and created_at is not null) from public.goods_receipts where id = $1`, [r3.receipt_id])) === true)
ok('the posting result confirms actual_cost_supported = true', r1.actual_cost_supported === true && r3.actual_cost_supported === true, r3)

// ---------------------------------------------------------------------------
console.log('\nA. GST by tax treatment (payable = taxable + CGST + SGST + IGST, each rounded like the order line)')
const gstCase = async (label, sup, qty, price, actual, expected, expectTreatment) => {
  const p = await newProduct()
  const po = await openPo([{ product_id: p, quantity: qty, unit_price: price }], sup)
  const parts = [{ qty, actual, reason: 'Supplier price revision' }]
  const r = await receive(po, parts)
  const l = await grnLine(r.receipt_id)
  const t = await treatment(po)
  ok(`${label}: ${qty} × ₹${price} → ₹${actual} (${t}) → payable ₹${expected}`, l.value === expected && t === expectTreatment && (await receiptValue(r.receipt_id)) === expected, { l, t })
  const agree = await screenAgrees(po, r.receipt_id, parts)
  ok(`${label}: the receipt screen previews exactly the stored cost and payable`, agree === true, agree)
}
await gstCase('1. intra-state, CGST and SGST rounded separately', SUP.INTRA_STATE, 7, 10.07, 10.09, 83.35, 'INTRA_STATE')
await gstCase('2. inter-state, IGST', SUP.INTER_STATE, 7, 10.07, 10.09, 83.34, 'INTER_STATE')
await gstCase('3. NO_GST supplier (no GSTIN): no GST added', SUP.NO_GST, 10, 10, 15, 150, 'NO_GST')
await gstCase('4. IMPORT supplier: no GST added (the PO charges none)', SUP.IMPORT, 10, 10, 15, 150, 'IMPORT')
await gstCase('5. decimals: 3 × ₹10 → ₹10.05 (CGST 2.7135 → 2.71 twice)', SUP.INTRA_STATE, 3, 10, 10.05, 35.57, 'INTRA_STATE')
await gstCase('5. decimals: 1 × ₹1 → ₹1.07 (CGST 0.0963 → 0.10 twice)', SUP.INTRA_STATE, 1, 1, 1.07, 1.27, 'INTRA_STATE')
await gstCase('5. decimals: 11 × ₹12.50 → ₹12.55', SUP.INTRA_STATE, 11, 12.5, 12.55, 162.89, 'INTRA_STATE')
await gstCase('5. decimals: 3 × ₹33.33 → ₹33.35', SUP.INTRA_STATE, 3, 33.33, 33.35, 118.05, 'INTRA_STATE')
await gstCase('5. half-paise: 1 × ₹11 → ₹11.50 (CGST 1.035 → 1.04 twice; floating point would give 1.03)', SUP.INTRA_STATE, 1, 11, 11.5, 13.58, 'INTRA_STATE')

// ---------------------------------------------------------------------------
console.log('\nB. Prices')
{
  const p = await newProduct()
  const before = await payable(SUP.INTRA_STATE)
  const po = await openPo([{ product_id: p, quantity: 10, unit_price: 10 }])
  const parts = [{ qty: 10, actual: 15, reason: 'Supplier price revision' }]
  const r = await receive(po, parts)
  const l = await grnLine(r.receipt_id)
  ok('6. PO ₹10, actual ₹15, 10 accepted, 18%: taxable ₹150 + GST ₹27 = payable ₹177', l.value === 177 && l.cost === 15 && l.po_cost === 10, l)
  ok('6. the supplier payable rises by exactly ₹177', Math.round(((await payable(SUP.INTRA_STATE)) - before) * 100) / 100 === 177)
  const party = await val(`select id from public.parties where supplier_id = $1`, [SUP.INTRA_STATE])
  const tx = await op(`select public.party_transactions($1)`, [party])
  const entry = tx.entries.find((x) => x.ref_id === r.receipt_id)
  ok('6. the supplier ledger shows the GRN at ₹177', Number(entry?.payable) === 177, entry)
  ok('6. screen preview = stored', (await screenAgrees(po, r.receipt_id, parts)) === true)
}
const priceCase = async (label, lines, parts, expect) => {
  const p = await newProduct()
  const po = await openPo(lines.map((x) => ({ product_id: p, ...x })))
  const r = await receive(po, parts)
  const ls = await grnLines(r.receipt_id)
  ok(label, expect(ls, await receiptValue(r.receipt_id)), ls)
  const agree = await screenAgrees(po, r.receipt_id, parts)
  ok(`${label.split(':')[0]}: screen preview = stored`, agree === true, agree)
  return { po, r }
}
await priceCase('7. lower price: PO ₹10, actual ₹8 × 10 → ₹80 + ₹14.40 GST = ₹94.40', [{ quantity: 10, unit_price: 10 }], [{ qty: 10, actual: 8, reason: 'Negotiated price change' }],
  ([l], v) => l.value === 94.4 && l.cost === 8 && v === 94.4)
await priceCase('8. percentage discount: ₹120 less 10% = ₹108 × 10 = ₹1,080 + GST = ₹1,274.40', [{ quantity: 10, unit_price: 100, discount_percent: 10 }],
  [{ qty: 10, actual: 120, reason: 'Negotiated price change' }], ([l]) => l.cost === 108 && l.po_cost === 90 && l.value === 1274.4)
await priceCase('9. fixed discount: ₹50 over 10 units → ₹110 − ₹5 = ₹105 × 10 = ₹1,050 + GST = ₹1,239', [{ quantity: 10, unit_price: 100, discount_amount: 50 }],
  [{ qty: 10, actual: 110, reason: 'Supplier price revision' }], ([l]) => l.cost === 105 && l.po_cost === 95 && l.value === 1239)
await priceCase('10. partial acceptance: 10 received, 8 accepted, 2 rejected to a rejected-goods location at ₹15 → payable 8 × 15 = ₹120 + GST = ₹141.60; rejected stock at the same ₹15 cost',
  [{ quantity: 10, unit_price: 10 }], [{ qty: 10, acc: 8, rej: 2, actual: 15, reason: 'Supplier price revision', rejLocation: rejLoc }],
  ([l]) => l.value === 141.6 && l.acc_cost === 15 && l.rej_cost === 15)
{
  const p = await newProduct()
  const po = await openPo([{ product_id: p, quantity: 10, unit_price: 10 }])
  const a = await receive(po, [{ qty: 4, actual: 15, reason: 'Supplier price revision' }])
  const b = await receive(po, [{ qty: 6 }])
  const [la, lb] = [await grnLine(a.receipt_id), await grnLine(b.receipt_id)]
  ok('11. two GRNs on one PO: 4 at ₹15 = ₹70.80, then 6 at the PO price = ₹70.80, each stored on its own GRN', la.value === 70.8 && lb.value === 70.8 && lb.actual === 10 && lb.reason === null, { la, lb })
  ok('11. the PO is fully received (status RECEIVED)', (await val(`select status from public.purchase_orders where id = $1`, [po])) === 'RECEIVED')
}
{
  const p = await newProduct()
  const po = await openPo([{ product_id: p, quantity: 10, unit_price: 10 }])
  const parts = [{ qty: 10, actual: 10 }]
  const r = await receive(po, parts)
  const l = await grnLine(r.receipt_id)
  const legacy = await val(`select private.grn_line_value(10, ordered_quantity, line_total)::float8 from public.purchase_order_lines where purchase_order_id = $1`, [po])
  ok('12. unchanged price: no reason; payable ₹118 stored, equal to the existing order-line calculation', l.value === 118 && legacy === 118 && l.reason === null && l.cost === 10, { l, legacy })
  ok('12. screen preview = stored', (await screenAgrees(po, r.receipt_id, parts)) === true)
}

// 13. Invalid prices: refused with a clear message, nothing posted.
{
  const p = await newProduct()
  const po = await openPo([{ product_id: p, quantity: 10, unit_price: 20 }])
  const big = await openPo([{ product_id: p, quantity: 1000000, unit_price: 10 }])
  const svc = await openPo([{ product_id: p, quantity: 1, unit_price: 20 }, { line_type: 'SERVICE', description: 'Installation', quantity: 1, unit_price: 500, gst_rate: 18, hsn_sac: '9954' }])
  const cases = [
    ['no reason', po, { qty: 1, actual: 25 }, /reason for the price change/i],
    ['negative', po, { qty: 1, actual: -1, reason: 'Other: test' }, /cannot be negative/i],
    ['zero', po, { qty: 1, actual: 0, reason: 'Other: free sample' }, /cannot be zero/i],
    ['5 decimals', po, { qty: 1, actual: 20.12345, reason: 'Other: test' }, /4 decimal places/i],
    ['text', po, { qty: 1, actual: 'abc', reason: 'Other: test' }, /must be a number/i],
    ['above 999,999,999,999', po, { qty: 1, actual: 1e15, reason: 'Other: test' }, /too large \(the maximum is 999,999,999,999\)/i],
    ['cost above what stock can be valued at', po, { qty: 1, actual: 10000000000, reason: 'Other: test' }, /larger than stock can be valued at/i],
    ['line value too large', big, { qty: 1000000, actual: 999999999, reason: 'Other: test' }, /value of this line is too large/i],
    ['changed price on a service line', svc, { i: 1, qty: 1, actual: 600, reason: 'Other: test' }, /only be changed on goods lines/i],
  ]
  for (const [label, pid, part, re] of cases) {
    const e = await post('op', pid, [part])
    ok(`13. ${label}: refused with a clear message`, re.test(e.error ?? ''), e)
  }
  ok('13. nothing was posted by the refused attempts', (await val(`select count(*)::int from public.goods_receipts where purchase_order_id = any($1)`, [[po, big, svc]])) === 0)
  const s = await receive(svc, [{ i: 1, qty: 1 }])
  ok('13. a service line at the PO price is still received (payable ₹590 stored, no unit cost)', (await grnLine(s.receipt_id)).value === 590 && (await grnLine(s.receipt_id)).cost === null)
}

// ---------------------------------------------------------------------------
console.log('\nC. Snapshots and accounting')
const missing = await val(`select count(*)::int from public.goods_receipt_lines l join public.goods_receipts r on r.id = l.goods_receipt_id
  where r.created_at >= $1::timestamptz and l.purchase_order_id is not null and l.line_value is null`, [startedAt])
const newLines = await val(`select count(*)::int from public.goods_receipt_lines l join public.goods_receipts r on r.id = l.goods_receipt_id
  where r.created_at >= $1::timestamptz and l.purchase_order_id is not null`, [startedAt])
ok(`14. every new PO GRN line stores its payable in line_value (${newLines} lines, 0 missing)`, missing === 0 && newLines >= 20, { missing, newLines })
const noSnap = await val(`select count(*)::int from public.goods_receipt_lines l join public.goods_receipts r on r.id = l.goods_receipt_id
  where r.created_at >= $1::timestamptz and l.purchase_order_id is not null and (l.po_unit_price is null or l.po_unit_cost is null or l.actual_unit_price is null)`, [startedAt])
ok('15. every new PO GRN line stores the PO price, PO cost and actual price snapshots', noSnap === 0, noSnap)

// 16 / 17. A later PO amendment changes neither the posted payable nor the variance report.
const P1 = await newProduct()
const P2 = await newProduct()
const poA = await openPo([{ product_id: P1, quantity: 10, unit_price: 10 }, { product_id: P2, quantity: 10, unit_price: 10 }])
const rA = await receive(poA, [{ i: 0, qty: 4 }, { i: 1, qty: 4, actual: 15, reason: 'Supplier price revision' }])
const payBefore = await receiptValue(rA.receipt_id)
const supBefore = await payable(SUP.INTRA_STATE)
const varSql = `select jsonb_agg(jsonb_build_object('po', po_unit_price::float8, 'po_cost', po_unit_cost::float8, 'actual', actual_unit_price::float8, 'at_po', accepted_value_at_po::float8,
  'value', accepted_value::float8, 'diff', price_difference::float8, 'payable', payable_value::float8, 'recorded', price_recorded) order by po_line_no)
  from public.goods_receipt_price_variance where goods_receipt_id = $1`
const varBefore = (await request('op', varSql, [rA.receipt_id])).value
const ids = await poLineIds(poA)
await op(`select public.purchase_order_action($1, 'AMEND', 'Supplier revised the prices')`, [poA])
await op(`select public.purchase_order_save($1, $2::jsonb, $3::jsonb, null, gen_random_uuid())`, [poA,
  { supplier_id: SUP.INTRA_STATE, purchase_type: 'RAW_MATERIAL', warehouse_id: w1 },
  [{ id: ids[0], product_id: P1, quantity: 10, unit_price: 12 }, { id: ids[1], product_id: P2, quantity: 10, unit_price: 20, discount_percent: 5 }]])
await op(`select public.purchase_order_open($1)`, [poA])
const amended = await val(`select jsonb_agg(unit_price::float8 order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [poA])
const legacyNow = await val(`select sum(private.grn_line_value(4, ordered_quantity, line_total))::float8 from public.purchase_order_lines where purchase_order_id = $1`, [poA])
ok(`16. after amending the PO prices to ${JSON.stringify(amended)}, the posted GRN payable stays ₹${payBefore} (the old order-line method would now give ₹${legacyNow})`,
  JSON.stringify(amended) === '[12,20]' && payBefore === 118.0 && (await receiptValue(rA.receipt_id)) === payBefore && legacyNow !== payBefore, { payBefore, after: await receiptValue(rA.receipt_id), legacyNow })
ok('16. the supplier payable is unchanged by the amendment', (await payable(SUP.INTRA_STATE)) === supBefore)
const varAfter = (await request('op', varSql, [rA.receipt_id])).value
ok('17. the variance report still shows the prices at receipt (PO ₹10 / ₹10, actual ₹10 / ₹15, values ₹40 / ₹60 vs ₹40 / ₹40)', JSON.stringify(varAfter) === JSON.stringify(varBefore)
  && varAfter[0].po === 10 && varAfter[0].actual === 10 && varAfter[0].value === 40 && varAfter[0].at_po === 40
  && varAfter[1].po === 10 && varAfter[1].actual === 15 && varAfter[1].value === 60 && varAfter[1].at_po === 40 && varAfter[1].diff === 5, { varBefore, varAfter })

// 19. Reversal and correction: cost history and payables.
await op(`select public.goods_receipt_reverse($1, 'Wrong supplier delivered', gen_random_uuid())`, [r3.receipt_id])
m = await master(X)
ok('19. reversing GRN 3 removes its ₹17 from the cost history (Cost ₹10, Last ₹15)', m.cost === 10 && m.last === 15, m)
const payX = await val(`select coalesce(sum(private.goods_receipt_value(id)), 0)::float8 from public.goods_receipts where purchase_order_id = $1 and status = 'POSTED'`, [po3])
ok('19. a reversed GRN no longer counts in the payable', payX === 0, payX)
const corr = await op(`select public.goods_receipt_correct_refs($1, 'Supplier invoice shows ₹16', jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, gen_random_uuid())`,
  [r2.receipt_id, JSON.stringify(await lineInput(po2, [{ qty: 10, actual: 16, reason: 'Supplier price revision' }]))])
m = await master(X)
const lc = await grnLine(corr.receipt_id)
ok('19. correcting GRN 2 to ₹16 reposts at the corrected price (Cost ₹10, Last ₹16; payable 160 + 28.80 = ₹188.80)', m.cost === 10 && m.last === 16 && lc.actual === 16 && lc.po === 12 && lc.value === 188.8, { m, lc })
ok('19. the correction result confirms actual_cost_supported = true', corr.actual_cost_supported === true, corr)

// 20. Idempotency: the same posting twice gives one receipt, one payable, one stock movement, one cost event.
{
  const p = await newProduct()
  const po = await openPo([{ product_id: p, quantity: 10, unit_price: 30 }])
  const key = crypto.randomUUID()
  const parts = [{ qty: 2, actual: 33, reason: 'Market price increase' }]
  const before = await payable(SUP.INTRA_STATE)
  const first = await receive(po, parts, key)
  const again = await post('op', po, parts, key)
  ok('20. the replay returns the same receipt, still confirming actual_cost_supported', again.value?.receipt_id === first.receipt_id && again.value?.actual_cost_supported === true, again)
  ok('20. one GRN, one stock movement, one cost event', (await val(`select count(*)::int from public.goods_receipts where purchase_order_id = $1`, [po])) === 1
    && (await val(`select count(*)::int from public.inventory_transactions t join public.goods_receipt_lines l on l.accepted_transaction_id = t.id where l.purchase_order_id = $1`, [po])) === 1
    && (await val(`select count(*)::int from public.product_purchase_cost_events where product_id = $1`, [p])) === 1)
  ok('20. the payable is counted once (2 × 33 = 66 + 11.88 = ₹77.88)', Math.round(((await payable(SUP.INTRA_STATE)) - before) * 100) / 100 === 77.88)
  const edit = await request('op', `update public.goods_receipt_lines set line_value = 1 where goods_receipt_id = $1`, [first.receipt_id])
  ok('20. a posted GRN line (and its payable) cannot be edited', Boolean(edit.error) && (await grnLine(first.receipt_id)).value === 77.88, edit)
}

// ---------------------------------------------------------------------------
console.log('\nPermissions, isolation, views')
{
  const po = await openPo([{ product_id: await newProduct(), quantity: 5, unit_price: 30 }])
  const e = await post('grn_view', po, [{ qty: 1, actual: 31, reason: 'Other: test' }])
  ok('a user without the GRN permission cannot post (or change prices)', /not allowed|permission/i.test(e.error ?? ''), e)
}
const bRows = await request('b_op', `select count(*)::int from public.goods_receipt_price_variance where company_id = $1`, [A])
ok('company B sees no company A variance rows (RLS through security_invoker)', bRows.value === 0, bRows)
ok('anon cannot read the variance report or the GRN line list', !(await val(`select has_table_privilege('anon', 'public.goods_receipt_price_variance', 'SELECT')`))
  && !(await val(`select has_table_privilege('anon', 'public.goods_receipt_line_list', 'SELECT')`)))
ok('both views run with the caller\'s rights', (await val(`select count(*)::int from pg_class where relname in ('goods_receipt_price_variance', 'goods_receipt_line_list') and reloptions::text like '%security_invoker=true%'`)) === 2)
const lv = (await request('op', `select jsonb_build_object('po', po_unit_price::float8, 'po_cost', po_unit_cost::float8, 'actual', actual_unit_price::float8, 'reason', price_variance_reason)
  from public.goods_receipt_line_list where goods_receipt_id = $1`, [r2.receipt_id])).value
ok('the GRN line list (detail screen) shows the snapshots and reason', lv?.po === 12 && lv.po_cost === 12 && lv.actual === 15 && lv.reason === 'Supplier price revision', lv)

// ---------------------------------------------------------------------------
console.log('\nRollback (throwaway local database) and historical GRNs')
const frozen = () => val(`select md5(coalesce((select string_agg(to_jsonb(t)::text, '|' order by t.id) from public.inventory_transactions t), '')
  || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from public.product_purchase_cost_events e), '')
  || coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from public.goods_receipts r), '')
  || coalesce((select string_agg(l.id::text || ':' || coalesce(l.line_value::text, '-') || ':' || coalesce(l.unit_cost::text, '-'), '|' order by l.id) from public.goods_receipt_lines l), ''))`)
const before = await frozen()
const masterBefore = await master(X)
const payablesBefore = await val(`select jsonb_object_agg(id, private.supplier_payable(id)) from public.suppliers where company_id = $1`, [A])
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', '20261202090000_grn_actual_cost_down.sql')))
const src = await val(`select prosrc from pg_proc where proname = 'purchase_receipt_post' and pronamespace = 'public'::regnamespace`)
const orig = await read(path.join(migDir, '20261022090100_purchase_orders.sql'))
const origBody = orig.slice(orig.indexOf('as $$', orig.indexOf('create or replace function public.purchase_receipt_post(')) + 5, orig.indexOf('\n$$;', orig.indexOf('create or replace function public.purchase_receipt_post(')) + 1)
ok('rollback restores the original posting function exactly', src === origBody)
ok('rollback removes the 4 snapshot columns and the variance view; the GRN line list is re-created',
  (await val(`select count(*)::int from information_schema.columns where table_name = 'goods_receipt_lines' and column_name in ('po_unit_price', 'po_unit_cost', 'actual_unit_price', 'price_variance_reason')`)) === 0
  && (await val(`select to_regclass('public.goods_receipt_price_variance')::text`)) === null
  && (await val(`select to_regclass('public.goods_receipt_line_list')::text`)) === 'goods_receipt_line_list')
ok('rollback keeps every GRN, stock movement, cost event and stored payable; supplier payables and the Product Master Cost are unchanged', (await frozen()) === before
  && JSON.stringify(await master(X)) === JSON.stringify(masterBefore)
  && JSON.stringify(await val(`select jsonb_object_agg(id, private.supplier_payable(id)) from public.suppliers where company_id = $1`, [A])) === JSON.stringify(payablesBefore))
ok('rollback documents what it removes and keeps', /REMOVED: the recorded PO price, PO cost, actual price and price-change reason/.test(await read(path.join(root, 'supabase', 'rollback', '20261202090000_grn_actual_cost_down.sql'))))
// 18. A GRN posted by the old function (as all GRNs before this migration).
const H = await newProduct()
const poH = await openPo([{ product_id: H, quantity: 10, unit_price: 10 }])
const legacyGrn = await receive(poH, [{ qty: 4, actual: 99, reason: 'ignored by the old function' }])
ok('18. the old function ignores actual prices (why the app checks support before posting a changed price)', legacyGrn.actual_cost_supported === undefined)
await db.exec(await read(path.join(migDir, MIG)))
await db.exec(await read(path.join(migDir, MIG)))
const hl = await grnLine(legacyGrn.receipt_id)
ok('18. a historical GRN keeps line_value null and no snapshots', hl.value === null && hl.po === null && hl.po_cost === null && hl.actual === null && hl.cost === 10, hl)
ok('18. its payable still uses the existing fallback (4/10 of the order line total = ₹47.20)', (await receiptValue(legacyGrn.receipt_id)) === 47.2)
const hv = (await request('op', `select jsonb_build_object('recorded', price_recorded, 'po', po_unit_price, 'actual', actual_unit_price, 'diff', price_difference, 'at_po', accepted_value_at_po, 'value', accepted_value)
  from public.goods_receipt_price_variance where goods_receipt_id = $1`, [legacyGrn.receipt_id])).value
ok('18. the variance report marks it "not recorded" with no prices (never the current PO price)', hv?.recorded === false && hv.po === null && hv.actual === null && hv.diff === null
  && hv.at_po === null && hv.value === null, hv)
const again = await receive(await openPo([{ product_id: H, quantity: 3, unit_price: 30 }]), [{ qty: 3, actual: 31, reason: 'Market price increase' }])
ok('the migration applies again, twice, and actual prices post again', (await grnLine(again.receipt_id)).actual === 31 && again.actual_cost_supported === true)

console.log(`${failed === 0 ? '✓' : '✗'} GRN actual cost check: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
