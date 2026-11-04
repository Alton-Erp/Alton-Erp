import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { COLUMNS, MODULE_LIST, RECORD_LINK } from '../../src/features/drilldown/drill-columns.ts'
import {
  and, anyGt, applyConditions, conditionsToSql, dayBetween, dayStart, eq, gt, isFalse, isIn, isNull, isTrue, matchesConditions, neq, notIn, or, productIs,
  todayIn, tzOffset, type FilterBuilder,
} from '../../src/features/drilldown/drill-conditions.ts'
import {
  bucketRange, contextFromParams, contextToParams, DASHBOARDS, invoiceStatusIs, METRIC_LIST, METRICS, monthEnd, paymentStatusIs, SOURCES, type DrillContext,
} from '../../src/features/drilldown/drill-registry.ts'

/** Records every builder call, like the Supabase query builder would receive them. */
class Recorder implements FilterBuilder<Recorder> {
  calls: string[] = []
  private add(s: string) { this.calls.push(s); return this }
  eq(c: string, v: unknown) { return this.add(`eq ${c} ${v}`) }
  neq(c: string, v: unknown) { return this.add(`neq ${c} ${v}`) }
  in(c: string, v: unknown[]) { return this.add(`in ${c} ${v.join('|')}`) }
  gt(c: string, v: unknown) { return this.add(`gt ${c} ${v}`) }
  gte(c: string, v: unknown) { return this.add(`gte ${c} ${v}`) }
  lt(c: string, v: unknown) { return this.add(`lt ${c} ${v}`) }
  lte(c: string, v: unknown) { return this.add(`lte ${c} ${v}`) }
  is(c: string, v: null | boolean) { return this.add(`is ${c} ${v}`) }
  not(c: string, op: string, v: unknown) { return this.add(`not ${c} ${op} ${v}`) }
  or(f: string) { return this.add(`or ${f}`) }
}

const ctx: DrillContext = { from: '2026-11-01', to: '2026-11-30', today: '2026-11-04', tz: 'Asia/Kolkata' }

describe('drill-down conditions', () => {
  it('server query: every condition becomes a PostgREST filter (AND), OR groups and nested AND keep their meaning', () => {
    const q = applyConditions(new Recorder(), [isNull('archived_at'), eq('status', 'ACTIVE'), isIn('type', ['A', 'B']), notIn('s', ['X', 'Y']),
      or(eq('stock_status', 'LOW_STOCK'), and(eq('stock_status', 'OUT_OF_STOCK'), isTrue('has_history')))])
    assert.deepEqual(q.calls, ['is archived_at null', 'eq status ACTIVE', 'in type A|B', 'not s in (X,Y)',
      'or stock_status.eq.LOW_STOCK,and(stock_status.eq.OUT_OF_STOCK,has_history.is.true)'])
  })
  it('values with reserved characters are quoted inside OR filters (supplier names with commas or dots)', () => {
    const q = applyConditions(new Recorder(), [or(eq('supplier_name', 'Shah, Sons & Co.'), isNull('x'))])
    assert.equal(q.calls[0], 'or supplier_name.eq."Shah, Sons & Co.",x.is.null')
  })
  it('a calendar day in the company time zone becomes a timestamp range with that zone', () => {
    assert.equal(tzOffset('2026-11-04', 'Asia/Kolkata'), '+05:30')
    assert.equal(dayStart('2026-11-04', 'Asia/Kolkata'), '2026-11-04T00:00:00+05:30')
    const q = applyConditions(new Recorder(), [dayBetween('created_at', '2026-11-01', '2026-11-30', 'Asia/Kolkata')])
    assert.deepEqual(q.calls, ['gte created_at 2026-11-01T00:00:00+05:30', 'lt created_at 2026-12-01T00:00:00+05:30'])
    assert.equal(todayIn('Asia/Kolkata', new Date('2026-11-03T20:00:00Z')), '2026-11-04')
  })
  it('browser rows follow SQL rules: NULL never equals, never differs, never compares', () => {
    assert.ok(!matchesConditions({ s: null }, [neq('s', 'X')]))
    assert.ok(!matchesConditions({ s: null }, [notIn('s', ['X'])]))
    assert.ok(!matchesConditions({ n: null }, [gt('n', 0)]))
    assert.ok(matchesConditions({ s: 'A', n: '5' }, [eq('s', 'A'), gt('n', 0)]))
    assert.ok(matchesConditions({ units: [{ unit: 'PCS', reserved: 0 }, { unit: 'KG', reserved: 2 }] }, [anyGt('units', 'reserved', 0)]))
    assert.ok(!matchesConditions({ units: [] }, [anyGt('units', 'reserved', 0)]))
    assert.ok(matchesConditions({ t: '2026-11-04T10:00:00Z' }, [dayBetween('t', '2026-11-04', '2026-11-04', 'Asia/Kolkata')]))
  })
  it('SQL form (database check) uses the same rules', () => {
    assert.equal(conditionsToSql([eq('status', 'POSTED'), or(neq('a', 0), isNull('b'))], { alias: 'v' }), "v.status = 'POSTED' and (v.a <> 0 or v.b is null)")
    assert.equal(conditionsToSql([productIs('product_id', 'product_type', 'eq', 'FINISHED_GOOD')], { alias: 'v' }),
      "exists (select 1 from public.products j where j.id = v.product_id and j.product_type = 'FINISHED_GOOD')")
    assert.equal(conditionsToSql([gt('receivable', 0)], { alias: 'r', json: true }), "(r ->> 'receivable')::numeric > 0")
    assert.equal(conditionsToSql([eq('name', "O'Brien")], { alias: 'v' }), "v.name = 'O''Brien'")
    assert.equal(conditionsToSql([], { alias: 'v' }), 'true')
  })
  it('a product-type condition is a join on the product (no product list in the URL)', () => {
    const q = applyConditions(new Recorder(), [productIs('component_product_id', 'product_type', 'neq', 'RAW_MATERIAL')])
    assert.deepEqual(q.calls, ['neq product.product_type RAW_MATERIAL'])
  })
})

describe('drill-down registry', () => {
  it('every figure has a source with columns, a record link, a module list, a known dashboard and permissions', () => {
    for (const m of METRIC_LIST) {
      assert.ok(SOURCES[m.source], `${m.key}: unknown source`)
      assert.ok(COLUMNS[m.source].length > 0 && RECORD_LINK[m.source] && MODULE_LIST[m.source], `${m.key}: no columns / link`)
      assert.ok(DASHBOARDS[m.dashboard], `${m.key}: unknown dashboard`)
      assert.ok(m.permissions.length > 0 && m.definition.length > 10 && m.basis, `${m.key}: missing permission, definition or basis`)
      assert.equal(SOURCES[m.source].kind === 'rpc' ? true : !m.rpcArgs, true, `${m.key}: rpcArgs on a view source`)
      assert.ok(Array.isArray(m.conditions(ctx)), `${m.key}: conditions`)
    }
    assert.equal(new Set(METRIC_LIST.map((m) => m.key)).size, METRIC_LIST.length, 'duplicate keys')
    assert.ok(METRIC_LIST.length >= 80)
  })
  it('only Product Master figures open the Product Master list', () => {
    for (const m of METRIC_LIST) if (m.target === 'products') assert.equal(m.source, 'products', m.key)
  })
  it('figures use the dashboard period, today and filters from the context', () => {
    assert.deepEqual(METRICS['purchase.period'].conditions(ctx).slice(0, 2), [{ col: 'po_date', op: 'gte', value: '2026-11-01' }, { col: 'po_date', op: 'lte', value: '2026-11-30' }])
    assert.deepEqual(METRICS['grn.month'].conditions(ctx).slice(1), [{ col: 'receipt_date', op: 'gte', value: '2026-11-01' }, { col: 'receipt_date', op: 'lte', value: '2026-11-04' }])
    assert.deepEqual(METRICS['sales.today'].rpcArgs!({ ...ctx, customer: null }), { p_from: '2026-11-04', p_to: '2026-11-04', p_customer_id: null, p_status: null })
    const withFilters = METRICS['billing.total'].conditions({ ...ctx, customer: 'c1', status: 'ISSUED', payment: 'OVERDUE' })
    assert.ok(withFilters.some((c) => JSON.stringify(c) === JSON.stringify(eq('customer_id', 'c1'))))
    assert.deepEqual(invoiceStatusIs('PROFORMA'), [isTrue('is_proforma')])
    assert.deepEqual(invoiceStatusIs('DRAFT'), [isFalse('is_proforma'), isIn('status', ['DRAFT', 'PENDING_APPROVAL'])])
    assert.equal(paymentStatusIs('PAID').length, 3)
  })
  it('URL context: round trip, and unsafe values are dropped', () => {
    const p = contextToParams({ ...ctx, unit: 'PCS', segment: 'Shah, Sons', segFrom: '2026-11-02', segTo: '2026-11-08', customer: '0f0e0d0c-0b0a-4908-8706-050403020100' })
    const back = contextFromParams(p, { today: '2026-01-01', tz: 'UTC' })
    assert.deepEqual(back, { ...ctx, unit: 'PCS', segment: 'Shah, Sons', segFrom: '2026-11-02', segTo: '2026-11-08', customer: '0f0e0d0c-0b0a-4908-8706-050403020100', status: null, payment: null })
    const bad = contextFromParams(new URLSearchParams('from=2026-13-99&to=x&customer=1;drop&tz=Asia/Kolkata\';&today=2026-11-04'), { today: '2026-11-04', tz: 'UTC' })
    assert.equal(bad.customer, null)
    assert.equal(bad.tz, 'UTC')
    assert.equal(bad.from, '2026-11-01')
    assert.equal(bad.to, '2026-11-04')
    const swapped = contextFromParams(new URLSearchParams('from=2026-11-30&to=2026-11-01'), { today: '2026-11-04', tz: 'UTC' })
    assert.deepEqual([swapped.from, swapped.to], ['2026-11-01', '2026-11-30'])
  })
  it('chart buckets cover the dates the database counts (weeks from Monday, clipped to the period)', () => {
    assert.deepEqual(bucketRange('2026-11-02', 'week'), { segFrom: '2026-11-02', segTo: '2026-11-08' })
    assert.deepEqual(bucketRange('2026-10-26', 'week', { from: '2026-11-01', to: '2026-11-30' }), { segFrom: '2026-11-01', segTo: '2026-11-01' })
    assert.deepEqual(bucketRange('2026-11-01', 'month', { from: '2026-11-01', to: '2026-11-15' }), { segFrom: '2026-11-01', segTo: '2026-11-15' })
    assert.deepEqual(bucketRange('2024-02-01', 'month'), { segFrom: '2024-02-01', segTo: '2024-02-29' })
    assert.equal(monthEnd('2026-12-15'), '2026-12-31')
  })
  it('record links point at the original documents', () => {
    assert.equal(RECORD_LINK.purchase_orders({ id: 'p1' }), '/purchase-orders/p1')
    assert.equal(RECORD_LINK.production_outputs({ production_order_id: 'o1' }), '/production/orders/o1')
    assert.equal(RECORD_LINK.parties({ party_id: 'x' }), '/ledger/x')
    assert.equal(RECORD_LINK.invoices({}), null)
  })
})
