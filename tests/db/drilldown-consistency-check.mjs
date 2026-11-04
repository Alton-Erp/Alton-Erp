// Dashboard figure = records behind it.
//
//   npm run test:db:drilldown
//
// Builds a company with the whole end-to-end business flow (supabase/tests/stage7_e2e_verification.sql,
// kept instead of rolled back) plus products of every kind, then, for every drill-down figure in
// src/features/drilldown/drill-registry.ts:
//   1. runs the dashboard function the card shows (module_dashboard, inventory_overview, ...),
//   2. runs the drill-down conditions of the same figure against the list's own view (or RPC rows),
//      as the signed-in user, so RLS applies exactly as in the app,
//   3. checks that the count / total match.
// It repeats the run for a second, empty company (no figures, no records from company A).

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

import { conditionsToSql } from '../../src/features/drilldown/drill-conditions.ts'
import { bucketRange, METRICS, SOURCES } from '../../src/features/drilldown/drill-registry.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFile(p, 'utf8')
const db = new PGlite()
await db.exec(await read(path.join(root, 'supabase', 'tests', 'local_supabase_shim.sql')))
const migDir = path.join(root, 'supabase', 'migrations')
for (const f of (await readdir(migDir)).filter((x) => x.endsWith('.sql')).sort()) await db.exec(await read(path.join(migDir, f)))
console.log('✓ migrations applied')

// --- Data: the end-to-end flow, without its final rollback -----------------------------------
let suite = await read(path.join(root, 'supabase', 'tests', 'stage7_e2e_verification.sql'))
const cut = suite.lastIndexOf('\ndo $$')
suite = suite.slice(0, cut)
await db.exec(suite)
const failedSteps = (await db.query(`select name from rls_test.results where not passed`)).rows
if (failedSteps.length) {
  console.error('✗ the end-to-end flow failed:', failedSteps.map((r) => r.name).join('; '))
  process.exit(1)
}
console.log(`✓ end-to-end flow: ${(await db.query('select count(*)::int n from rls_test.results')).rows[0].n} steps`)

// More kinds of products (owner inserts; the flow's own products stay as they are).
await db.exec(`
  reset role;
  insert into public.products (company_id, sku, product_name, product_type, default_source_type, base_unit, status, created_at) values
    (rls_test.id('company_a'), 'DD-COMP-1', 'Drill component', 'COMPONENT', 'IN_HOUSE', 'PCS', 'ACTIVE', now()),
    (rls_test.id('company_a'), 'DD-SUB-1', 'Drill subassembly (no BOM)', 'SUBASSEMBLY', 'IN_HOUSE', 'PCS', 'ACTIVE', now()),
    (rls_test.id('company_a'), 'DD-FG-OLD', 'Drill old finished good', 'FINISHED_GOOD', 'IN_HOUSE', 'PCS', 'INACTIVE', now() - interval '400 days'),
    (rls_test.id('company_a'), 'DD-FG-OUT', 'Drill outsourced finished good', 'FINISHED_GOOD', 'OUTSOURCED', 'PCS', 'ACTIVE', now()),
    (rls_test.id('company_a'), 'DD-PACK-1', 'Drill carton', 'PACKAGING_MATERIAL', 'IN_HOUSE', 'PCS', 'ACTIVE', now()),
    (rls_test.id('company_a'), 'DD-ARCH-1', 'Drill archived', 'RAW_MATERIAL', 'IN_HOUSE', 'KG', 'INACTIVE', now());
  update public.products set archived_at = now() where sku = 'DD-ARCH-1';
`)

const ctxRow = (await db.query(`select (now() at time zone private.company_tz(rls_test.id('company_a')))::date::text as today, private.company_tz(rls_test.id('company_a')) as tz`)).rows[0]
const today = ctxRow.today
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const monthEnd = (m) => { const x = new Date(`${m.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); x.setUTCDate(0); return x.toISOString().slice(0, 10) }
const base = { from: addDays(today, -60), to: today, today, tz: ctxRow.tz }

let failed = 0
let checks = 0
let nonZero = 0
const ok = (name, cond, detail = '') => {
  checks++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` — ${detail}`}`)
  if (!cond) failed++
}
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`)
const one = async (sql) => (await db.query(sql)).rows[0]

/** Value of goods receipts as the dashboards value them (private.goods_receipt_value), for receipts the user can list. */
async function receiptValue(user, where) {
  const ids = (await db.query(`select v.id from public.goods_receipt_list_v2 v where ${where}`)).rows.map((r) => r.id)
  await db.exec('reset role')
  const v = ids.length ? (await one(`select coalesce(sum(private.goods_receipt_value(id)), 0) as v from unnest(array[${ids.map(lit).join(',')}]::uuid[]) id`)).v : 0
  await db.exec(`set role authenticated; select rls_test.claims('${user}');`)
  return v
}

/** count and total of the drill-down records of a metric, as the signed-in user. */
async function drill(key, ctx) {
  const m = METRICS[key]
  const src = SOURCES[m.source]
  const sumExpr = (alias, json) => (m.measure.kind === 'sum'
    ? m.measure.columns.map((c) => (json ? `coalesce((${alias} ->> '${c}')::numeric, 0)` : `coalesce(${alias}.${c}, 0)`)).join(' + ')
    : '0')
  if (src.kind === 'view') {
    const where = conditionsToSql(m.conditions(ctx), { alias: 'v' })
    return one(`select count(*)::numeric as n, coalesce(sum(${sumExpr('v', false)}), 0)::numeric as s from public.${src.relation} v where ${where}`)
  }
  const args = Object.entries(m.rpcArgs ? m.rpcArgs(ctx) : {}).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')
  const rows = src.fn === 'ledger_parties'
    ? `(select to_jsonb(t) as r from public.ledger_parties(${args}) t) x`
    : `jsonb_array_elements(coalesce(public.${src.fn}(${args})${src.path ? ` -> '${src.path}'` : ''}, '[]'::jsonb)) as x(r)`
  const where = conditionsToSql(m.conditions(ctx), { alias: 'r', json: true })
  return one(`select count(*)::numeric as n, coalesce(sum(${sumExpr('r', true)}), 0)::numeric as s from ${rows} where ${where}`)
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v))
const tested = new Set(['grn.month_received', 'sales.reserved'])
async function compare(label, key, ctx, expected, what = 'count') {
  tested.add(key)
  const r = await drill(key, ctx)
  const got = what === 'count' ? num(r.n) : num(r.s)
  if (num(expected) !== 0) nonZero++
  ok(`${label}: ${what} ${got} = dashboard ${num(expected)}`, Math.abs(got - num(expected)) < 0.005, `${key} ${JSON.stringify(ctx)}`)
}
const units = (list) => (Array.isArray(list) ? list : [])

async function run(user) {
  await db.exec(`reset role; set role authenticated; select rls_test.claims('${user}');`)
  const q = (sql) => one(`select (${sql}) as v`).then((r) => r.v)
  const c = base
  const P = (fn) => `public.${fn}`
  const md = (mod) => q(`${P('module_dashboard')}('${mod}', '${c.from}', '${c.to}')`)

  // Products
  const pr = await md('PRODUCTS')
  for (const [k, f] of [['total', 'total'], ['finished_goods', 'finished_goods'], ['raw_materials', 'raw_materials'], ['components', 'components'],
    ['outsourced', 'outsourced'], ['without_bom', 'without_bom'], ['added', 'added_in_period'], ['low_stock', 'low_stock_count']]) {
    await compare(`Products / ${k}`, `products.${k}`, c, pr[f])
  }

  // Inventory
  const inv = await q(`${P('inventory_overview')}()`)
  await compare('Inventory / active products', 'inventory.active_products', c, inv.active_products)
  await compare('Inventory / low stock (incl. fully reserved)', 'inventory.low_stock', c, num(inv.low_stock) + num(inv.fully_reserved))
  await compare('Inventory / out of stock', 'inventory.out_of_stock', c, inv.out_of_stock)
  for (const u of units(inv.units)) {
    for (const [k, f] of [['on_hand', 'on_hand'], ['reserved', 'reserved'], ['available', 'available'], ['in_house', 'in_house'], ['outsourced', 'outsourced'], ['unknown', 'unknown']]) {
      await compare(`Inventory / ${k} (${u.unit})`, `inventory.${k}`, { ...c, unit: u.unit }, u[f], 'total')
    }
  }
  for (const [seg, f] of [['HEALTHY', 'healthy'], ['LOW_STOCK', 'low_stock'], ['FULLY_RESERVED', 'fully_reserved'], ['OUT_OF_STOCK', 'out_of_stock'], ['NO_THRESHOLD', 'no_threshold'], ['NEVER_STOCKED', 'never_stocked']]) {
    await compare(`Inventory / health ${seg}`, 'inventory.health', { ...c, segment: seg }, inv[f])
  }
  for (const bucket of ['day', 'week']) {
    const rows = (await db.query(`select bucket::text, unit, transactions from ${P('inventory_movement_trend')}('${c.from}', '${c.to}', '${bucket}')`)).rows
    for (const t of rows) await compare(`Inventory / movements ${bucket} ${t.bucket} (${t.unit})`, 'inventory.movements', { ...c, unit: t.unit, ...bucketRange(t.bucket, bucket, c) }, t.transactions)
  }
  for (const b of units(inv.by_category)) await compare(`Inventory / category ${b.category} (${b.unit})`, 'inventory.category', { ...c, unit: b.unit, segment: b.category }, b.on_hand, 'total')
  for (const b of units(inv.by_warehouse)) await compare(`Inventory / warehouse ${b.warehouse_code} (${b.unit})`, 'inventory.warehouse', { ...c, unit: b.unit, segment: b.warehouse_code }, b.on_hand, 'total')
  const trend = (await db.query(`select bucket::text, unit, transactions from ${P('inventory_movement_trend')}('${c.from}', '${c.to}', 'month')`)).rows
  for (const t of trend) {
    const segFrom = t.bucket < c.from ? c.from : t.bucket
    const segTo = monthEnd(t.bucket) > c.to ? c.to : monthEnd(t.bucket)
    await compare(`Inventory / movements ${t.bucket} (${t.unit})`, 'inventory.movements', { ...c, unit: t.unit, segFrom, segTo }, t.transactions)
  }

  // Purchase
  const po = await q(`${P('purchase_order_dashboard')}('${c.from}', '${c.to}')`)
  const pm = await md('PURCHASE')
  await compare('Purchase / total', 'purchase.total', c, po.total)
  await compare('Purchase / open', 'purchase.open', c, po.open)
  await compare('Purchase / overdue', 'purchase.overdue', c, po.overdue)
  await compare('Purchase / pending value', 'purchase.pending_value', c, po.outstanding_receipt_value, 'total')
  await compare('Purchase / ordered in period (orders)', 'purchase.period', c, po.period_orders)
  await compare('Purchase / ordered in period (value)', 'purchase.period', c, po.period_value, 'total')
  await compare('Purchase / partially received', 'purchase.partial', c, pm.partially_received)
  await compare('Purchase / fully received', 'purchase.received', c, pm.fully_received)
  for (const s of units(pm.top_suppliers)) await compare(`Purchase / supplier ${s.supplier}`, 'purchase.supplier', { ...c, segment: s.supplier }, s.value, 'total')

  // Goods received
  const g = await md('GRN')
  for (const [k, f] of [['total', 'total'], ['today', 'today'], ['month', 'month'], ['period', 'in_period'], ['unlinked', 'unlinked'], ['pending', 'pending_orders']]) {
    await compare(`GRN / ${k}`, `grn.${k}`, c, g[f])
  }
  await compare('GRN / pending value', 'grn.pending', c, g.pending_value, 'total')
  if (!units(g.rejected).length) await compare('GRN / rejected (none)', 'grn.rejected', c, 0, 'total')
  for (const u of units(g.rejected)) await compare(`GRN / rejected (${u.unit})`, 'grn.rejected', { ...c, unit: u.unit }, u.quantity, 'total')
  // Value of the receipts in the period (the list has no value column): same records, valued by the database.
  const grnWhere = conditionsToSql(METRICS['grn.period'].conditions(c), { alias: 'v' })
  const grnValue = await receiptValue(user, grnWhere)
  ok(`GRN / value in period ${grnValue} = dashboard ${g.value_in_period}`, Math.abs(num(grnValue) - num(g.value_in_period)) < 0.005)

  // Management overview
  const ov = await q(`${P('management_overview')}('${c.from}', '${c.to}')`)
  await compare('Management / purchase orders', 'purchase.created', c, ov.purchase.created)
  await compare('Management / pending GRNs', 'purchase.open', c, ov.purchase.open)
  await compare('Management / production orders', 'production.orders', c, ov.production.orders)
  await compare('Management / sales orders (excl. cancelled)', 'sales.booked', c, num(ov.sales.total_orders) - num(ov.sales.cancelled))
  await compare('Management / invoiced sales (value)', 'billing.issued_period', c, ov.kpis.sales_invoiced, 'total')
  await compare('Management / invoiced sales (invoices)', 'billing.issued_period', c, ov.kpis.invoices)
  await compare('Management / outstanding payments', 'billing.outstanding_all', c, ov.kpis.customer_outstanding, 'total')
  for (const d of units(ov.sales.daily)) {
    await compare(`Management / sales booked ${d.day}`, 'sales.booked_period', { ...c, segFrom: d.day, segTo: d.day }, d.orders)
    await compare(`Management / sales booked ${d.day} (value)`, 'sales.booked_period', { ...c, segFrom: d.day, segTo: d.day }, d.value, 'total')
  }
  for (const d of units(ov.production.daily)) await compare(`Management / production ${d.day} (${d.unit})`, 'production.output', { ...c, unit: d.unit, segFrom: d.day, segTo: d.day }, d.good, 'total')
  for (const m of units(ov.purchase.monthly)) await compare(`Management / purchases ordered ${m.month}`, 'purchase.month', { ...c, segFrom: m.month, segTo: monthEnd(m.month) }, m.ordered, 'total')
  for (const m of units(ov.purchase.monthly)) {
    const where = conditionsToSql(METRICS['grn.month_received'].conditions({ ...c, segFrom: m.month, segTo: monthEnd(m.month) }), { alias: 'v' })
    const v = await receiptValue(user, where)
    ok(`Management / purchases received ${m.month}: ${v} = dashboard ${m.received}`, Math.abs(num(v) - num(m.received)) < 0.005)
  }

  // Production
  const pd = await q(`${P('production_dashboard')}('${c.from}', '${c.to}')`)
  await compare('Production / orders', 'production.orders', c, pd.orders)
  await compare('Production / open', 'production.open', c, pd.open_orders)
  await compare('Production / completed', 'production.completed', c, pd.orders_completed)
  await compare('Production / shortages', 'production.shortages', c, units(pd.shortages).length)
  for (const [k, f] of [['today', 'produced_today'], ['month', 'produced_month'], ['finished_goods', 'finished_goods'], ['rejected', 'rejected'], ['raw_materials', 'raw_materials'], ['components', 'components']]) {
    if (!units(pd[f]).length) await compare(`Production / ${k} (none)`, `production.${k}`, c, 0, 'total')
    for (const u of units(pd[f])) await compare(`Production / ${k} (${u.unit})`, `production.${k}`, { ...c, unit: u.unit }, u.quantity, 'total')
  }

  // Sales (with and without the dashboard's status filter)
  const salesCheck = async (status) => {
    const cs = { ...c, status }
    const sd = await q(`${P('sales_dashboard')}('${c.from}', '${c.to}', null, ${lit(status)})`)
    const tag = status ? ` [status ${status}]` : ''
    for (const [k, f] of [['total', 'total_orders'], ['today', 'created_today'], ['month', 'this_month'], ['pending', 'pending'], ['partial', 'partially_fulfilled'],
      ['fulfilled', 'fully_fulfilled'], ['cancelled', 'cancelled'], ['awaiting', 'awaiting_dispatch']]) {
      await compare(`Sales / ${k}${tag}`, `sales.${k}`, cs, sd[f])
    }
    await compare(`Sales / value${tag}`, 'sales.value', cs, sd.total_value, 'total')
    await compare(`Sales / shortages${tag}`, 'sales.shortages', cs, units(sd.shortages).length)
    // Finished goods reserved: the reserved quantities of the listed orders add up to the card.
    for (const u of units(sd.finished_goods_reserved)) {
      const m = METRICS['sales.reserved']
      const args = Object.entries(m.rpcArgs(cs)).map(([k, v]) => `${k} => ${lit(v)}`).join(', ')
      const where = conditionsToSql(m.conditions(cs), { alias: 'r', json: true })
      const v = await q(`select coalesce(sum((e ->> 'reserved')::numeric), 0) from jsonb_array_elements(public.sales_orders_v2_list(${args})) x(r)
        cross join lateral jsonb_array_elements(r -> 'units') e where ${where} and e ->> 'unit' = ${lit(u.unit)}`)
      ok(`Sales / finished goods reserved (${u.unit})${tag}: ${v} = dashboard ${u.quantity}`, Math.abs(num(v) - num(u.quantity)) < 0.005)
    }
  }
  await salesCheck(null)
  await salesCheck('CANCELLED')
  await salesCheck('FULLY_DISPATCHED')

  // Invoices (with and without the dashboard's filters)
  const billCheck = async (status, payment) => {
    const cb = { ...c, status, payment }
    const d = await q(`${P('invoice_dashboard')}('${c.from}', '${c.to}', null, ${lit(status)}, ${lit(payment)})`)
    const tag = status || payment ? ` [${status ?? '-'} / ${payment ?? '-'}]` : ''
    for (const [k, f] of [['total', 'total_invoices'], ['partially_paid', 'partially_paid'], ['fully_paid', 'fully_paid'], ['drafts', 'drafts'], ['proforma', 'proforma'],
      ['cancelled', 'cancelled'], ['today', 'created_today'], ['month', 'this_month']]) {
      await compare(`Invoices / ${k}${tag}`, `billing.${k}`, cb, d[f])
    }
    for (const [k, f] of [['value', 'total_value'], ['taxable', 'taxable_value'], ['gst', 'gst_collected'], ['received', 'amount_received'], ['outstanding', 'outstanding'], ['overdue', 'overdue_amount']]) {
      await compare(`Invoices / ${k}${tag}`, `billing.${k}`, cb, d[f], 'total')
    }
    if (!status && !payment) {
      for (const m of units(d.monthly)) {
        const cm = { ...cb, segFrom: m.month, segTo: monthEnd(m.month) }
        await compare(`Invoices / invoiced ${m.month}`, 'billing.month_invoiced', cm, m.invoiced, 'total')
        await compare(`Invoices / received ${m.month}`, 'billing.month_received', cm, m.received, 'total')
      }
    }
  }
  await billCheck(null, null)
  await billCheck('ISSUED', null)
  await billCheck(null, 'PAID')
  await billCheck('DRAFT', null)
  await billCheck('CANCELLED', null)

  // Ledger
  const lg = await md('LEDGER')
  for (const [k, f] of [['customers', 'customers'], ['suppliers', 'suppliers'], ['both', 'both'], ['with_balance', 'with_balance']]) await compare(`Ledger / ${k}`, `ledger.${k}`, c, lg[f])
  await compare('Ledger / receivables', 'ledger.receivables', c, lg.receivables, 'total')
  await compare('Ledger / payables', 'ledger.payables', c, lg.payables, 'total')
}

console.log('\nCompany A (operator, Super Admin)')
await run('op')
const untested = Object.keys(METRICS).filter((k) => !tested.has(k))
ok(`every drill-down figure is compared with its dashboard (${Object.keys(METRICS).length})`, untested.length === 0, untested.join(', '))
ok(`at least 60 figures have records behind them (${nonZero})`, nonZero >= 60, `only ${nonZero} non-zero figures`)

console.log('\nCompany B (empty company, its own Super Admin)')
const before = nonZero
await run('b_op')
ok('company B sees no figure and no record of company A', nonZero === before, `${nonZero - before} non-zero figures`)

await db.exec('reset role; rollback').catch(() => {})
console.log(`\n${failed === 0 ? '✓' : '✗'} Dashboard drill-down consistency: ${checks - failed} passed, ${failed} failed (${Object.keys(METRICS).length} figures defined)`)
process.exit(failed === 0 ? 0 : 1)
