// GST-exclusive dashboard reporting (migration 20261209090000).
//
//   npm run test:db:gst-exclusive
//
// Local PGlite database only (throwaway, in memory). Purchases and goods receipts go through the ERP's own
// functions (PO save → open → receipt post / reverse, direct GRN, supplier payment); invoices, receipts and a
// credit note are copied from the end-to-end fixture's issued invoice with known amounts, so every expected
// figure can be worked out by hand.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const migDir = path.join(root, 'supabase', 'migrations')
const NAME = '20261209090000_gst_exclusive_reporting'
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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
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
const w1 = await val(`select rls_test.id('w1')::text`)
const g1 = await val(`select rls_test.id('g1')::text`)
const today = await val(`select rls_test.today()::text`)

// --- Purchases: an intra-state GST supplier, a PO with a 10% discount, receipts and a reversal --------------
const coGstin = await val(`select gstin from public.companies where id = $1`, [A])
const st = coGstin.slice(0, 2)
const supplier = async (name, extra) => (await op(`select public.party_save(null, $1::jsonb, true, gen_random_uuid())`, [{ party_type: 'SUPPLIER', party_name: name, ...extra }]))
const S1 = await supplier('GX Intra', { gstin: `${st}AABCG1234A1Z5`, state_code: st })
const S2 = await supplier('GX Paid', { gstin: `${st}AABCH1234A1Z5`, state_code: st })
let skuNo = 0
const product = () => op(`insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, standard_cost, gst_rate, hsn_code)
  values ($1, $2, $2, 'RAW_MATERIAL', 'OUTSOURCED', 'PCS', 'ACTIVE', 10, 18, '6910') returning id`, [A, `GX-${++skuNo}`])
const P1 = await product()
const P2 = await product()
const openPo = async (sup, lines) => {
  const po = (await op(`select public.purchase_order_save(null, $1::jsonb, $2::jsonb, null, gen_random_uuid())`, [{ supplier_id: sup, purchase_type: 'RAW_MATERIAL', warehouse_id: w1 }, lines])).po_id
  await op(`select public.purchase_order_open($1)`, [po])
  return po
}
const lineIds = (po) => val(`select jsonb_agg(id order by line_no) from public.purchase_order_lines where purchase_order_id = $1`, [po])
const receive = async (po, parts) => {
  const ids = await lineIds(po)
  return op(`select public.purchase_receipt_post($1, jsonb_build_object('receipt_date', rls_test.today()::text), $2::jsonb, gen_random_uuid())`, [po, JSON.stringify(parts.map((x) => ({
    po_line_id: ids[x.i ?? 0], received_quantity: x.qty, accepted_quantity: x.qty, rejected_quantity: 0, accepted_location_id: g1,
    ...(x.actual !== undefined ? { actual_unit_price: x.actual, price_variance_reason: 'Supplier price revision' } : {}) })))])
}

// PO 1 (S1): 10 × ₹100 less 10% = ₹900 taxable, + 18% GST. Receive 4 at the PO price, then 2 at ₹110 (price changed).
const po1 = await openPo(S1.supplier_id, [{ product_id: P1, quantity: 10, unit_price: 100, discount_percent: 10 }])
const grnA = await receive(po1, [{ qty: 4 }])
const grnB = await receive(po1, [{ qty: 2, actual: 110 }])
// PO 2 (S2): 5 × ₹200 = ₹1,000 taxable. Received in full, then a supplier payment of ₹500 (does not say which part is GST).
const po2 = await openPo(S2.supplier_id, [{ product_id: P2, quantity: 5, unit_price: 200 }])
const grnC = await receive(po2, [{ qty: 5 }])
await op(`select public.supplier_payment_record($1, rls_test.today(), 500, 'BANK_TRANSFER', 'GX-PAY', null, gen_random_uuid())`, [S2.supplier_id])
// PO 3 (S1): received then reversed (never counted).
const po3 = await openPo(S1.supplier_id, [{ product_id: P2, quantity: 3, unit_price: 50 }])
const grnD = await receive(po3, [{ qty: 3 }])
await op(`select public.purchase_receipt_reverse($1, 'Wrong supplier invoice', gen_random_uuid())`, [grnD.receipt_id])
// Direct receipt (S1): 3 × ₹40, GST 18% → ₹120 taxable.
const direct = await op(`select public.goods_receipt_direct_post($1::jsonb, $2::jsonb, gen_random_uuid())`, [JSON.stringify({ warehouse_id: w1, supplier_id: S1.supplier_id, receipt_date: today }),
  JSON.stringify([{ product_id: P1, received_quantity: 3, accepted_quantity: 3, rejected_quantity: 0, unit_cost: 40, gst_rate: 18, accepted_location_id: g1 }])])

// --- Invoices: copies of the fixture's issued invoice with known amounts ----------------------------------
const srcInv = await val(`select id from public.sales_invoices where company_id = $1 and status = 'ISSUED' order by created_at limit 1`, [A])
const custId = await val(`select customer_id from public.sales_invoices where id = $1`, [srcInv])
let invNo = 0
const invoice = async (taxable, gst, due = today) => {
  const patch = { id: crypto.randomUUID(), invoice_number: `GX-INV-${++invNo}`, invoice_date: today, due_date: due, taxable_subtotal: taxable, cgst_total: gst / 2, sgst_total: gst / 2,
    igst_total: 0, round_off: 0, grand_total: taxable + gst, gross_total: taxable, discount_total: 0, other_charges_total: 0 }
  await db.exec('reset role')
  await db.query(`insert into public.sales_invoices select (jsonb_populate_record(null::public.sales_invoices, to_jsonb(i) || $2::jsonb)).* from public.sales_invoices i where i.id = $1`,
    [srcInv, JSON.stringify(patch)])
  return patch.id
}
const srcPay = await val(`select id from public.customer_payments where company_id = $1 order by created_at limit 1`, [A])
let payNo = 0
const pay = async (inv, amount) => {
  const id = crypto.randomUUID()
  await db.exec('reset role')
  await db.query(`insert into public.customer_payments select (jsonb_populate_record(null::public.customer_payments, to_jsonb(p) || $2::jsonb)).* from public.customer_payments p where p.id = $1`,
    [srcPay, JSON.stringify({ id, receipt_number: `GX-RCPT-${++payNo}`, customer_id: custId, receipt_date: today, amount_received: amount, status: 'RECORDED', reversal_reason: null, reversed_at: null, reversed_by: null })])
  await db.query(`insert into public.invoice_payment_allocations (company_id, invoice_id, payment_id, allocated_amount, allocation_date) values ($1, $2, $3, $4, $5)`, [A, inv, id, amount, today])
}
const credit = async (inv, taxable, gst) => {
  await db.exec('reset role')
  await db.query(`insert into public.invoice_adjustment_notes (company_id, note_number, note_type, customer_id, original_invoice_id, note_date, reason_code, reason, tax_treatment,
      taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount, status, issued_at, issued_by)
    values ($1, 'GX-CN-1', 'CREDIT', $2, $3, $4, 'SALES_RETURN', 'Returned goods', 'INTRA_STATE', $5::numeric, $6::numeric, $6::numeric, 0, $5::numeric + 2 * $6::numeric, 'ISSUED', now(), rls_test.id('op'))`,
    [A, custId, inv, today, taxable, gst / 2])
}
const I1 = await invoice(1000, 180)                    // unpaid                → ₹1,000 excl. GST
const I2 = await invoice(500, 90); await pay(I2, 590)   // fully paid            → ₹0
const I3 = await invoice(2000, 360); await pay(I3, 1000) // partly paid           → review (₹1,360 incl. GST)
const I4 = await invoice(1000, 180); await credit(I4, 200, 36) // unpaid, credit note ₹236 → ₹800 excl. GST

// --- Snapshot of every posted record, before the migration -------------------------------------------------
const TABLES = ['sales_invoices', 'customer_payments', 'invoice_payment_allocations', 'invoice_adjustment_notes', 'supplier_payments', 'goods_receipts', 'goods_receipt_lines',
  'purchase_orders', 'purchase_order_lines', 'sales_orders', 'sales_order_lines', 'inventory_transactions', 'inventory_balances', 'parties', 'products']
const snapshot = async () => {
  const out = {}
  for (const t of TABLES) out[t] = await val(`select md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) from public.${t} x`)
  return out
}
const strip = (o) => JSON.stringify(o, (k, v) => (k === 'generated_at' ? undefined : v))
const range = { from: `${today.slice(0, 8)}01`, to: today }
const existing = async () => ({
  overview: strip(await op(`select public.management_overview($1::date, $2::date)`, [range.from, range.to])),
  invoice: strip(await op(`select public.invoice_dashboard($1::date, $2::date)`, [range.from, range.to])),
  ledger: strip(await op(`select public.module_dashboard('LEDGER', $1::date, $2::date)`, [range.from, range.to])),
  purchase: strip(await op(`select public.module_dashboard('PURCHASE', $1::date, $2::date)`, [range.from, range.to])),
})
const before = await snapshot()
const beforeFns = await existing()

const mig = await read(path.join(migDir, `${NAME}.sql`))
await db.exec('reset role')
await db.exec(mig)
console.log(`✓ ${NAME} applied`)

console.log('\nDeployment changes nothing')
const after = await snapshot()
ok('no posted record changed by applying the migration', JSON.stringify(after) === JSON.stringify(before), Object.keys(before).filter((k) => before[k] !== after[k]))
const afterFns = await existing()
ok('existing dashboard functions return the same (GST-inclusive) figures as before', JSON.stringify(afterFns) === JSON.stringify(beforeFns), Object.keys(beforeFns).filter((k) => beforeFns[k] !== afterFns[k]).map((k) => { const a = beforeFns[k]; const b = afterFns[k]; let i = 0; while (a[i] === b[i]) i++; return `${k}: …${a.slice(i - 60, i + 40)} ≠ …${b.slice(i - 60, i + 40)}` }))

const dash = (scope, user = 'op', extra = []) => request(user, `select public.gst_exclusive_dashboard($1, $2::date, $3::date${extra.length ? ', ' + extra.map((_, i) => `$${i + 4}`).join(', ') : ''})`,
  [scope, range.from, range.to, ...extra])
const M = (await dash('MANAGEMENT')).value
const taxable = (r) => val(`select private.goods_receipt_taxable_value($1)::float8`, [r])
const payable = (r) => val(`select private.goods_receipt_value($1)::float8`, [r])

console.log('\nGoods received excl. GST')
ok('PO price: 4 × ₹90 (₹100 less 10%) = ₹360 taxable; payable ₹424.80 incl. GST', near(await taxable(grnA.receipt_id), 360) && near(await payable(grnA.receipt_id), 424.8),
  [await taxable(grnA.receipt_id), await payable(grnA.receipt_id)])
ok('price changed: 2 × ₹99 (₹110 less 10%) = ₹198 taxable; payable ₹233.64', near(await taxable(grnB.receipt_id), 198) && near(await payable(grnB.receipt_id), 233.64),
  [await taxable(grnB.receipt_id), await payable(grnB.receipt_id)])
ok('direct receipt: 3 × ₹40 = ₹120 taxable; payable ₹141.60', near(await taxable(direct.receipt_id), 120) && near(await payable(direct.receipt_id), 141.6),
  [await taxable(direct.receipt_id), await payable(direct.receipt_id)])
ok('taxable + GST of each new receipt = its payable (GST split exactly as at posting)', near(await taxable(grnC.receipt_id) * 1.18, await payable(grnC.receipt_id)))
const recvExpected = await val(`select sum(private.goods_receipt_taxable_value(id))::float8 from public.goods_receipts where company_id = $1 and status = 'POSTED' and receipt_date between $2 and $3`,
  [A, range.from, range.to])
ok('received in period excludes GST and the reversed GRN', near(M.purchase.received_value, recvExpected) && recvExpected >= 360 + 198 + 120 + 1000, [M.purchase.received_value, recvExpected])
const reversedTaxable = await taxable(grnD.receipt_id)
ok('reversed GRN is not counted (₹150 taxable left out)', reversedTaxable === 150
  && near(await val(`select sum(private.goods_receipt_taxable_value(id))::float8 from public.goods_receipts where company_id = $1 and status = 'POSTED' and receipt_date between $2 and $3 and id = $4`,
    [A, range.from, range.to, grnD.receipt_id]) ?? 0, 0))

console.log('\nPurchase orders excl. GST')
const poTaxable = await val(`select sum(taxable_total)::float8 from public.purchase_orders where company_id = $1 and po_date between $2 and $3 and status in ('APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED')`, [A, range.from, range.to])
const poGross = await val(`select sum(grand_total)::float8 from public.purchase_orders where company_id = $1 and po_date between $2 and $3 and status in ('APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED')`, [A, range.from, range.to])
ok('ordered in period = taxable totals (less than the GST-inclusive value)', near(M.purchase.period_value, poTaxable) && poTaxable < poGross, [M.purchase.period_value, poTaxable, poGross])
const P = (await dash('PURCHASE')).value
ok('Purchase dashboard uses the same ordered value', near(P.purchase.period_value, M.purchase.period_value))
// PO 1: 4 still to receive of 10 at ₹90 → ₹360 (the price-changed receipt counts 2 accepted).
const po1Pending = await val(`select pending_taxable_value::float8 from public.purchase_order_list_excl_gst where id = $1`, [po1])
ok('still to receive on PO 1: 4 × ₹90 = ₹360 excl. GST', near(po1Pending, 360), po1Pending)
const pendingDrill = (await request('op', `select sum(pending_taxable_value)::float8 from public.purchase_order_list_excl_gst where status in ('APPROVED','SENT','PARTIALLY_RECEIVED')`)).value
ok('card "still to receive" = sum of its drill-down rows', near(M.purchase.outstanding_receipt_value, pendingDrill), [M.purchase.outstanding_receipt_value, pendingDrill])
const periodDrill = (await request('op', `select sum(taxable_total)::float8 from public.purchase_order_list_excl_gst where po_date between $1 and $2 and status in ('APPROVED','SENT','PARTIALLY_RECEIVED','RECEIVED','CLOSED')`, [range.from, range.to])).value
ok('card "ordered in period" = sum of its drill-down rows', near(periodDrill, P.purchase.period_value))
ok('monthly ordered / received of this month = the period figures', (() => { const m = M.purchase.monthly.at(-1); return near(m.ordered, poTaxable) && near(m.received, recvExpected) })(), M.purchase.monthly.at(-1))
const G = (await dash('GRN')).value
ok('GRN dashboard value in period and pending value excl. GST', near(G.purchase.received_value, recvExpected) && near(G.purchase.outstanding_receipt_value, pendingDrill))

console.log('\nInvoices and receivables excl. GST')
const row = (id) => val(`select jsonb_build_object('x', outstanding_excl_gst::float8, 's', excl_gst_status, 'b', balance_due::float8) from public.sales_invoice_list_excl_gst where id = $1`, [id])
const r1 = await row(I1); const r2 = await row(I2); const r3 = await row(I3); const r4 = await row(I4)
ok('unpaid invoice: ₹1,180 due → ₹1,000 excl. GST', r1.x === 1000 && r1.s === 'EXACT' && r1.b === 1180, r1)
ok('fully paid invoice: ₹0', r2.x === 0 && r2.s === 'SETTLED', r2)
ok('partly paid invoice: no GST-exclusive figure invented, flagged for review', r3.x === null && r3.s === 'REVIEW' && r3.b === 1360, r3)
ok('credit note applied with its own taxable value: ₹1,000 − ₹200 = ₹800', r4.x === 800 && r4.b === 944, r4)
const diffCols = await val(`select count(*)::int from public.sales_invoice_list l join public.sales_invoice_list_excl_gst e on e.id = l.id
  cross join jsonb_each(to_jsonb(l)) j(k, v) where (to_jsonb(e) -> j.k) is distinct from j.v`)
const sameRows = diffCols === 0 && await val(`select (select count(*) from public.sales_invoice_list) = (select count(*) from public.sales_invoice_list_excl_gst)`)
ok('the GST-exclusive invoice view has the same rows and values as sales_invoice_list (built on the tables, no view dependency)', sameRows === true)
const fixtureRow = await row(srcInv)
ok('fixture invoice with a partial payment is flagged for review too', fixtureRow.s === 'REVIEW' || fixtureRow.s === 'SETTLED', fixtureRow)
const recDrill = (await request('op', `select jsonb_build_object('x', coalesce(sum(outstanding_excl_gst), 0)::float8, 'review', count(*) filter (where excl_gst_status = 'REVIEW'),
  'rb', coalesce(sum(balance_due) filter (where excl_gst_status = 'REVIEW'), 0)::float8) from public.sales_invoice_list_excl_gst where status = 'ISSUED' and balance_due > 0`)).value
ok('Outstanding Receivables (Excl. GST) = sum of the drill-down rows', near(M.receivables.outstanding_excl_gst, recDrill.x) && M.receivables.outstanding_excl_gst >= 1800, [M.receivables, recDrill])
ok('review count and GST-inclusive review balance match the drill-down', M.receivables.review_count === recDrill.review && near(M.receivables.review_balance, recDrill.rb), [M.receivables, recDrill])
const mo = await op(`select public.management_overview($1::date, $2::date)`, [range.from, range.to])
ok('GST-inclusive outstanding of the same invoices = the existing figure (unchanged ledger)', near(M.receivables.outstanding_incl_gst, mo.kpis.customer_outstanding), [M.receivables.outstanding_incl_gst, mo.kpis.customer_outstanding])
ok('Taxable Sales of the period = taxable values of issued invoices', near(M.sales_invoiced, await val(`select sum(taxable_subtotal)::float8 from public.sales_invoices where company_id = $1 and status = 'ISSUED' and invoice_date between $2 and $3`, [A, range.from, range.to]))
  && M.sales_invoiced < mo.kpis.sales_invoiced, [M.sales_invoiced, mo.kpis.sales_invoiced])
const B = (await dash('BILLING')).value
const inv = await op(`select public.invoice_dashboard($1::date, $2::date)`, [range.from, range.to])
ok('Invoice dashboard: taxable value and GST equal the existing invoice dashboard figures', near(B.invoicing.taxable_value, inv.taxable_value) && near(B.invoicing.gst, inv.gst_collected))
ok('Invoice dashboard: outstanding excl. GST for the period, review flagged', B.invoicing.outstanding_excl_gst >= 1800 && B.invoicing.outstanding_review.count >= 1, B.invoicing)
ok('monthly taxable + GST of this month = invoiced incl. GST (round-off aside)', (() => { const m = B.invoicing.monthly.at(-1); const i = inv.monthly.at(-1); return Math.abs(m.taxable + m.gst - i.invoiced) < 1 })())
ok('per-invoice values for the dashboard lists', B.invoicing.by_invoice[I1]?.outstanding_excl_gst === 1000 && B.invoicing.by_invoice[I3]?.status === 'REVIEW', B.invoicing.by_invoice[I1])
const filtered = (await dash('BILLING', 'op', [custId, 'ISSUED', 'PARTIALLY_PAID'])).value
ok('invoice dashboard filters (customer / status / payment status) are applied', filtered.invoicing.invoices >= 1 && filtered.invoicing.invoices < B.invoicing.invoices, filtered.invoicing.invoices)
const custRow = M.customer_outstanding.find((c) => c.party_id === (mo.invoicing.customer_outstanding[0] ?? {}).party_id)
ok('customer balances list: excl. GST per customer with review count', custRow && custRow.outstanding_excl_gst >= 1800 && custRow.review_invoices >= 1, custRow)

console.log('\nSupplier payables excl. GST')
const parties = await op(`select public.ledger_parties_excl_gst()`)
const sp1 = parties.find((p) => p.party_id === S1.party_id)
const sp2 = parties.find((p) => p.party_id === S2.party_id)
ok('supplier with no payment: payable excl. GST = taxable value received (₹360 + ₹198 + ₹120)', near(sp1.payable_excl_gst, 678) && sp1.payable_gst_status === 'EXACT' && near(sp1.payable, 800.04), { payable: sp1.payable, excl: sp1.payable_excl_gst, status: sp1.payable_gst_status })
ok('supplier with an unallocated payment: flagged for review, no figure invented', sp2.payable_excl_gst === null && sp2.payable_gst_status === 'REVIEW' && near(sp2.payable, 680), sp2)
ok('Outstanding Payables (Excl. GST) includes ₹678 and flags the paid supplier', M.payables.outstanding_excl_gst >= 678 && M.payables.review_count >= 1 && M.payables.review_balance >= 680, M.payables)
ok('GST-inclusive payables of the same suppliers = the existing figure', near(M.payables.outstanding_incl_gst, mo.kpis.supplier_outstanding), [M.payables.outstanding_incl_gst, mo.kpis.supplier_outstanding])
const L = (await dash('LEDGER')).value
const ledgerDrill = parties.filter((p) => Number(p.payable) > 0).reduce((s, p) => s + Number(p.payable_excl_gst ?? 0), 0)
ok('Ledger: payables excl. GST = sum of its drill-down rows', near(L.payables_excl_gst, ledgerDrill), [L.payables_excl_gst, ledgerDrill])
const recLedger = parties.filter((p) => Number(p.receivable) > 0).reduce((s, p) => s + Number(p.receivable_excl_gst ?? 0), 0)
ok('Ledger: receivables excl. GST = sum of its drill-down rows; customer with payments is in review', near(L.receivables_excl_gst, recLedger) && L.receivables_review.count >= 1, L)
ok('Ledger: top suppliers by taxable value received', L.top_suppliers.some((s) => s.party_id === S1.party_id && near(s.received, 678)), L.top_suppliers)

console.log('\nSales orders excl. GST')
const S = (await dash('SALES')).value
const sd = await op(`select public.sales_dashboard($1::date, $2::date, null, null)`, [range.from, range.to])
const soTaxable = await val(`select coalesce(sum(taxable_total), 0)::float8 from public.sales_orders where company_id = $1 and order_date between $2 and $3 and private.so_v2_status(id) <> 'CANCELLED'`, [A, range.from, range.to])
ok('total sales order value = taxable totals (cancelled left out)', near(S.sales.total_value, soTaxable) && S.sales.total_value <= sd.total_value, [S.sales.total_value, soTaxable, sd.total_value])
const soDrill = await op(`select public.sales_orders_v2_list_excl_gst($1::date, $2::date, null, null)`, [range.from, range.to])
ok('sales order drill-down rows carry the taxable total; their sum = the card', near(soDrill.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + Number(r.taxable_total ?? 0), 0), S.sales.total_value))

console.log('\nStock value')
ok('stock value is already GST-exclusive: PO 1 receipt costed at ₹90; its lot averages ₹678 taxable ÷ 9 units', near(await val(`select t.unit_cost::float8 from public.goods_receipt_lines l join public.inventory_transactions t on t.id = l.accepted_transaction_id where l.goods_receipt_id = $1`, [grnA.receipt_id]), 90)
  && Math.abs(await val(`select private.lot_average_cost(t.batch_id)::float8 from public.goods_receipt_lines l join public.inventory_transactions t on t.id = l.accepted_transaction_id where l.goods_receipt_id = $1`, [grnA.receipt_id]) - 678 / 9) < 0.0001)

console.log('\nPermissions and isolation')
ok('anon cannot call the dashboard function', (await (async () => { await db.exec('reset role'); await db.exec('begin'); await db.exec('set local role anon')
  try { await db.query(`select public.gst_exclusive_dashboard('MANAGEMENT', current_date, current_date)`); await db.exec('rollback'); return false } catch { await db.exec('rollback'); return true } })()))
const viewer = await val(`select r.id from public.roles r where exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code = 'dashboard.read')
  and not exists (select 1 from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = r.id and p.code in ('invoices.read', 'ledger.read')) order by r.code limit 1`)
if (viewer) {
  await db.exec(`reset role;
    insert into rls_test.ids (key, id) values ('gx_view', 'e7e5c800-0000-4000-8000-0000000000e9');
    insert into auth.users (id, email) values (rls_test.id('gx_view'), 'gx_view@e7.example.invalid');
    update public.profiles set company_id = rls_test.id('company_a'), is_active = true where id = rls_test.id('gx_view');
    insert into public.user_roles (user_id, company_id, role_id) values (rls_test.id('gx_view'), rls_test.id('company_a'), '${viewer}')`)
  const v = await dash('MANAGEMENT', 'gx_view')
  ok('a dashboard reader without invoice access gets no invoice figures', !v.error && v.value.invoicing.available === false && v.value.customer_outstanding.length === 0, v)
  ok('…and cannot open the ledger figures', Boolean((await dash('LEDGER', 'gx_view')).error))
} else ok('a dashboard-only role exists for the permission test', false)
const bOp = await dash('MANAGEMENT', 'b_op')
ok('company B sees none of company A\'s figures', !bOp.error && bOp.value.receivables.outstanding_excl_gst === 0 && bOp.value.purchase.period_value === 0, bOp)
const bRows = (await request('b_op', `select count(*)::int from public.sales_invoice_list_excl_gst`)).value
ok('company B reads no company A invoice rows through the new view', bRows === 0, bRows)
ok('unknown scope refused', /Unknown dashboard/.test((await dash('NOPE')).error ?? ''))

console.log('\nRead only')
ok('calling every scope changed no record', JSON.stringify(await snapshot()) === JSON.stringify(before))

console.log('\nRollback and re-apply')
await db.exec('reset role')
await db.exec(await read(path.join(root, 'supabase', 'rollback', `${NAME}_down.sql`)))
const left = await val(`select count(*)::int from pg_proc where proname in ('gst_exclusive_dashboard', 'ledger_parties_excl_gst', 'sales_orders_v2_list_excl_gst', 'goods_receipt_taxable_value', 'invoice_excl_gst', 'party_balances_excl_gst', 'po_pending_taxable')`)
const views = await val(`select count(*)::int from pg_views where viewname in ('sales_invoice_list_excl_gst', 'purchase_order_list_excl_gst')`)
ok('rollback removes every object it created', left === 0 && views === 0, [left, views])
ok('after rollback the records and the existing dashboards are unchanged', JSON.stringify(await snapshot()) === JSON.stringify(before) && JSON.stringify(await existing()) === JSON.stringify(beforeFns))
await db.exec(mig)
ok('re-applies cleanly after rollback', near((await dash('MANAGEMENT')).value.receivables.outstanding_excl_gst, M.receivables.outstanding_excl_gst))

console.log(`\n${failed ? '✗' : '✓'} gst-exclusive reporting: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
