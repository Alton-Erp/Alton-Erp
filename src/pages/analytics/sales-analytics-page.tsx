import { CheckCircle2, IndianRupee, Receipt, ShoppingCart, Truck } from 'lucide-react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { TrendLineChart } from '@/components/charts/trend-line-chart'
import { ChartCard } from '@/components/common/chart-card'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { inr, pct, qty, STATUS_LABEL, unitList, type ExportSection } from '@/features/analytics/analytics-format'
import { activeFilters, categoryOptions, warehouseOptions } from '@/features/analytics/analytics-options'
import { addDays, bucketFor, dayStartInstant, formatBucket, partsOf, isoOf } from '@/features/analytics/analytics-period'
import {
  AnalyticsExport, AnalyticsHeader, FilterBar, MetricCard, MiniTable, PeriodControls, PrintHeader, SectionHeading, SelectFilter, StaleBanner, UnavailableCard,
} from '@/features/analytics/analytics-ui'
import { useDrilldown } from '@/features/analytics/use-drilldown'
import { useAnalyticsContext, useAnalyticsFilters, useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { ORDER_STATUS_LABELS } from '@/features/sales/sales-model'
import { fetchSalesAnalytics, type SalesAnalytics } from '@/services/analytics'

const monthEnd = (iso: string) => { const { y, m } = partsOf(iso); return isoOf(y, m + 1, 0) }

export default function SalesAnalyticsPage() {
  const { has } = usePermissions()
  const context = useAnalyticsContext()
  const ctx = context.data
  const { filters, update, reset } = useAnalyticsFilters(ctx)
  const drill = useDrilldown()
  const bucket = bucketFor(filters.from, filters.to)
  const q = useAnalyticsQuery(ctx ? () => fetchSalesAnalytics({ from: filters.from, to: filters.to, customerId: filters.customerId, categoryId: filters.categoryId,
    productId: filters.productId, warehouseId: filters.warehouseId, orderStatus: filters.orderStatus, bucket }) : null,
  [filters.from, filters.to, filters.customerId, filters.categoryId, filters.productId, filters.warehouseId, filters.orderStatus, bucket, Boolean(ctx)])
  const d = q.data
  const tz = ctx?.timezone ?? 'Asia/Kolkata'
  const customerLabel = filters.customerId ? 'Selected customer' : null
  const active = activeFilters(filters, ctx, customerLabel ? [{ label: 'Customer', value: customerLabel }] : [])

  const clipFrom = (iso: string) => (iso < filters.from ? filters.from : iso)
  const clipTo = (iso: string) => (iso > filters.to ? filters.to : iso)
  const monthDrill = (month: string, source: 'sales_orders' | 'dispatches' | 'invoices') => {
    const from = clipFrom(month)
    const to = clipTo(monthEnd(month))
    drill.open({ source, title: `${source === 'sales_orders' ? 'Orders' : source === 'dispatches' ? 'Dispatches' : 'Issued invoices'} · ${formatBucket(month, 'month')}`, from, to,
      fromInstant: dayStartInstant(from, tz), toInstant: dayStartInstant(addDays(to, 1), tz), customerId: filters.customerId, warehouseId: source === 'invoices' ? null : filters.warehouseId })
  }

  return (
    <>
      <AnalyticsHeader ctx={ctx} filters={filters} lastSuccessAt={q.lastSuccessAt} loading={q.loading || !ctx} onRefresh={() => { context.reload(); q.reload() }}
        exportButton={<AnalyticsExport allowed={Boolean(ctx?.export.sales)} title="Sales analytics" fileStem="sales-analytics" ctx={ctx} filters={filters} active={active}
          generatedAt={q.lastSuccessAt} sections={() => (d ? salesExport(d) : [])}
          notes={['Order value = (ordered − cancelled) × order line price snapshot; dispatched value = dispatched quantity × the same snapshot; invoiced value = taxable value of issued invoices.']} />} />
      <FilterBar active={active} onClear={reset} appliesTo="All filters apply to orders (order date), dispatches (dispatch date) and invoices (invoice date). Warehouse applies to orders and dispatches, and to invoice lines through their dispatch.">
        <PeriodControls ctx={ctx} filters={filters} update={update} />
        {has('customers.read') && <div className="space-y-1"><Label htmlFor="sa-cust">Customer</Label><CustomerSelect id="sa-cust" value={filters.customerId ?? 'all'} onChange={(v) => update({ customerId: v === 'all' ? null : v })} allowAll className="w-56" /></div>}
        <SelectFilter id="sa-wh" label="Warehouse" value={filters.warehouseId} onChange={(v) => update({ warehouseId: v })} options={warehouseOptions(ctx)} allLabel="All warehouses" />
        <SelectFilter id="sa-cat" label="Category" value={filters.categoryId} onChange={(v) => update({ categoryId: v })} options={categoryOptions(ctx)} allLabel="All categories" />
        <SelectFilter id="sa-status" label="Order status" value={filters.orderStatus} onChange={(v) => update({ orderStatus: v })}
          options={Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => ({ value, label }))} allLabel="All except cancelled" />
      </FilterBar>
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={d ? q.lastSuccessAt : null} onRetry={q.reload} />
      <div className="print-area space-y-8">
        <PrintHeader title="Sales analytics" ctx={ctx} filters={filters} active={active} generatedAt={q.lastSuccessAt} />
        {!d ? (q.loading || !ctx ? <LoadingState variant="cards" rows={6} /> : null) : !d.has_records ? (
          <Card><EmptyState icon={ShoppingCart} title="No sales orders yet" description="Sales analytics appear once sales orders are created." /></Card>
        ) : (
          <>
            <section aria-labelledby="sa-kpis">
              <SectionHeading id="sa-kpis" title="Period totals" description="Three different measures — never assumed equal." />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Order value" value={inr(d.totals.order_value)} icon={IndianRupee} accent="blue" kind="period" hint={`${d.totals.orders} order(s)${d.totals.unpriced_order_lines ? ` · ${d.totals.unpriced_order_lines} unpriced line(s)` : ''}`}
                  definition="(Ordered − cancelled) × sales order line price snapshot, orders dated in the period."
                  onDrill={() => drill.open({ source: 'sales_orders', title: 'Orders in the period', from: filters.from, to: filters.to, customerId: filters.customerId, warehouseId: filters.warehouseId })} />
                <MetricCard label="Dispatched value" value={inr(d.totals.dispatched_value)} icon={Truck} accent="green" kind="period" hint={`${d.totals.dispatches} dispatch(es)`}
                  definition="Dispatched quantity × the order line's price snapshot, by dispatch date." />
                <MetricCard label="Invoiced value (taxable)" value={d.totals.invoiced_value === null ? null : inr(d.totals.invoiced_value)} icon={Receipt} accent="blue" kind="period"
                  unavailableReason="Requires the billing_reports.read permission." hint={d.totals.credit_notes !== null ? `Credit notes ${inr(d.totals.credit_notes)} · debit notes ${inr(d.totals.debit_notes)} (shown separately)` : undefined}
                  definition="Taxable value (before GST) of issued invoice lines dated in the period." />
                <MetricCard label="Order fulfilment" value={d.fulfilment.order_rate === null ? null : pct(d.fulfilment.order_rate)} icon={CheckCircle2} accent="green" kind="period"
                  unavailableReason="No orders in the period." hint={`${d.fulfilment.fully_dispatched} of ${d.fulfilment.orders} order(s) fully dispatched · ${d.fulfilment.units.map((u) => `${pct(u.rate)} of ${u.unit}`).join(' · ')}`}
                  definition="Orders of the period whose every line is fully dispatched ÷ orders of the period. Quantity rate = dispatched ÷ (ordered − cancelled), per unit." />
              </div>
            </section>
            <section aria-labelledby="sa-trends" className="grid gap-4 xl:grid-cols-2">
              <h2 id="sa-trends" className="sr-only">Trends</h2>
              <ChartCard title="Monthly order value vs dispatched value" description="Click a month in the table view to see its records" isEmpty={d.monthly.every((m) => !Number(m.order_value) && !Number(m.dispatched_value))}
                table={{ headers: ['Month', 'Order value', 'Dispatched value'], rows: d.monthly.map((m) => [formatBucket(m.month, 'month'), inr(m.order_value), inr(m.dispatched_value)]) }}>
                <PairedBarChart aName="Order value" bName="Dispatched value" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => inr(v)}
                  data={d.monthly.map((m) => ({ label: formatBucket(m.month, 'month'), a: Number(m.order_value), b: Number(m.dispatched_value) }))} />
              </ChartCard>
              {d.invoices_available ? (
                <ChartCard title="Monthly dispatched value vs invoiced value" description="Invoiced = taxable value of issued invoices" isEmpty={d.monthly.every((m) => !Number(m.dispatched_value) && !Number(m.invoiced_value))}
                  table={{ headers: ['Month', 'Dispatched', 'Invoiced', 'Credit notes', 'Debit notes'], rows: d.monthly.map((m) => [formatBucket(m.month, 'month'), inr(m.dispatched_value), inr(m.invoiced_value), inr(m.credit_notes), inr(m.debit_notes)]) }}>
                  <PairedBarChart aName="Dispatched value" bName="Invoiced (taxable)" aColor={TONE_FILL.success} bColor={TONE_FILL.info} valueFormatter={(v) => inr(v)}
                    data={d.monthly.map((m) => ({ label: formatBucket(m.month, 'month'), a: Number(m.dispatched_value), b: Number(m.invoiced_value ?? 0) }))} />
                </ChartCard>
              ) : <UnavailableCard title="Dispatched vs invoiced" reason="Your role does not include the billing_reports.read permission." />}
              <ChartCard title="Sales order trend" description={`Orders created per ${d.bucket}`} isEmpty={!d.trend.length}
                table={{ headers: [d.bucket === 'month' ? 'Month' : 'Date', 'Orders', 'Order value'], rows: d.trend.map((t) => [formatBucket(t.bucket, d.bucket), t.orders, inr(t.order_value)]) }}>
                <TrendLineChart seriesName="Orders" data={d.trend.map((t) => ({ label: formatBucket(t.bucket, d.bucket), value: Number(t.orders) }))} />
              </ChartCard>
              <Card>
                <CardHeader><div><CardTitle>Records by month</CardTitle><CardDescription>Open the orders, dispatches or invoices behind each month</CardDescription></div></CardHeader>
                <CardContent>
                  <MiniTable headers={['Month', 'Orders', 'Dispatches', 'Invoices']} rows={d.monthly.map((m) => [
                    formatBucket(m.month, 'month'),
                    <button key="o" type="button" className="text-primary hover:underline" onClick={() => monthDrill(m.month, 'sales_orders')}>{m.orders} · {inr(m.order_value)}</button>,
                    <button key="d" type="button" className="text-primary hover:underline" onClick={() => monthDrill(m.month, 'dispatches')}>{inr(m.dispatched_value)}</button>,
                    m.invoiced_value === null ? '—' : <button key="i" type="button" className="text-primary hover:underline" onClick={() => monthDrill(m.month, 'invoices')}>{inr(m.invoiced_value)}</button>,
                  ])} />
                </CardContent>
              </Card>
            </section>
            <section aria-labelledby="sa-customers" className="grid gap-4 xl:grid-cols-3">
              <h2 id="sa-customers" className="sr-only">Customers</h2>
              {([['Top customers by order value', d.top_customers_ordered, 'sales_orders'], ['Top customers by dispatched value', d.top_customers_dispatched, 'dispatches'],
                ['Top customers by invoiced value', d.top_customers_invoiced, 'invoices']] as const).map(([title, list, source]) => list === null ? (
                <UnavailableCard key={title} title={title} reason="Your role does not include the billing_reports.read permission." />
              ) : (
                <Card key={title}>
                  <CardHeader><div><CardTitle>{title}</CardTitle><CardDescription>Top 10 in the period · click to see records</CardDescription></div></CardHeader>
                  <CardContent>
                    <MiniTable headers={['Customer', 'Value']} empty="No records in the period." rows={list.map((c) => [
                      <button key="c" type="button" className="text-left text-primary hover:underline" onClick={() => drill.open({ source, title: `${c.customer} · ${title.toLowerCase()}`,
                        from: filters.from, to: filters.to, fromInstant: dayStartInstant(filters.from, tz), toInstant: dayStartInstant(addDays(filters.to, 1), tz),
                        customerId: c.customer_id, customerKey: c.customer_id ? null : c.customer_key ?? null })}>{c.customer}</button>, inr(c.value)])} />
                  </CardContent>
                </Card>
              ))}
            </section>
            <section aria-labelledby="sa-products" className="grid gap-4 xl:grid-cols-2">
              <h2 id="sa-products" className="sr-only">Products</h2>
              <Card className="xl:col-span-2">
                <CardHeader><div><CardTitle>Sales by product</CardTitle><CardDescription>Top 15 by order value; quantities in each product's unit</CardDescription></div></CardHeader>
                <CardContent>
                  <MiniTable headers={['Product', 'Ordered', 'Order value', 'Dispatched', 'Dispatched value']} empty="No order lines in the period." rows={d.by_product.map((p) => [
                    <span key="p">{p.sku}<span className="block text-xs text-muted-foreground">{p.product_name}</span></span>,
                    `${qty(p.ordered)} ${p.unit}`, inr(p.order_value), `${qty(p.dispatched)} ${p.unit}`, inr(p.dispatched_value)])} />
                </CardContent>
              </Card>
              <ChartCard title="Sales by product category" description="Order value in the period" isEmpty={!d.by_category.some((c) => Number(c.order_value))}
                table={{ headers: ['Category', 'Order value', 'Dispatched value'], rows: d.by_category.map((c) => [c.category, inr(c.order_value), inr(c.dispatched_value)]) }}>
                <HorizontalBarChart seriesName="Order value" labelWidth={150} valueFormatter={(v) => inr(v)} data={d.by_category.map((c) => ({ label: c.category, value: Number(c.order_value) }))} />
              </ChartCard>
              <UnavailableCard title="Sales by salesperson" reason={d.salesperson.reason} />
            </section>
            <section aria-labelledby="sa-short">
              <SectionHeading id="sa-short" title="Partial fulfilment and shortages (current open orders)"
                description={`${d.open_lines.lines} open line(s); ${d.open_lines.short_lines} short on ${d.open_lines.orders_short} order(s). Remaining: ${unitList(d.open_lines.by_unit, 'remaining')} · short: ${unitList(d.open_lines.by_unit, 'shortage')}`}>
                <Link to="/analytics/fulfilment" className="print-hidden text-sm text-primary hover:underline">Full shortage report</Link>
              </SectionHeading>
              <Card><CardContent className="p-4">
                <MiniTable headers={['Order', 'Customer', 'Product', 'Ordered', 'Dispatched', 'Reserved', 'Available now', 'Short']} empty="No open order lines." rows={d.open_lines.rows.map((r) => [
                  <Link key="o" className="text-primary hover:underline" to={`/sales/order-details?so=${r.sales_order_id}`}>{r.sales_order_number}</Link>, r.customer,
                  <span key="p">{r.sku}<span className="block text-xs text-muted-foreground">{STATUS_LABEL(r.order_status)}</span></span>,
                  `${qty(r.ordered)} ${r.unit}`, qty(r.dispatched), qty(r.reserved), qty(r.available_now),
                  r.shortage > 0 ? <span key="s" className="font-medium text-shortage">{qty(r.shortage)}</span> : '0'])} align={['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right']} />
              </CardContent></Card>
            </section>
          </>
        )}
      </div>
      {drill.element}
    </>
  )
}

function salesExport(d: SalesAnalytics): ExportSection[] {
  return [
    { name: 'Totals', headers: ['Metric', 'Value'], rows: [
      ['Orders', d.totals.orders], ['Order value', Number(d.totals.order_value)], ['Unpriced order lines', d.totals.unpriced_order_lines],
      ['Dispatched value', Number(d.totals.dispatched_value)], ['Dispatches', d.totals.dispatches],
      ['Invoiced value (taxable)', d.totals.invoiced_value === null ? 'Not permitted' : Number(d.totals.invoiced_value)],
      ['Credit notes (taxable)', d.totals.credit_notes === null ? 'Not permitted' : Number(d.totals.credit_notes)],
      ['Debit notes (taxable)', d.totals.debit_notes === null ? 'Not permitted' : Number(d.totals.debit_notes)],
      ['Order fulfilment %', d.fulfilment.order_rate]] },
    { name: 'Monthly', headers: ['Month', 'Orders', 'Order value', 'Dispatched value', 'Invoiced value', 'Credit notes', 'Debit notes'],
      rows: d.monthly.map((m) => [m.month, m.orders, Number(m.order_value), Number(m.dispatched_value), m.invoiced_value === null ? null : Number(m.invoiced_value),
        m.credit_notes === null ? null : Number(m.credit_notes), m.debit_notes === null ? null : Number(m.debit_notes)]) },
    { name: 'Customers', headers: ['Ranking', 'Customer', 'Value'], rows: [
      ...d.top_customers_ordered.map((c) => ['Order value', c.customer, Number(c.value)]),
      ...d.top_customers_dispatched.map((c) => ['Dispatched value', c.customer, Number(c.value)]),
      ...(d.top_customers_invoiced ?? []).map((c) => ['Invoiced value', c.customer, Number(c.value)])] },
    { name: 'Products', headers: ['SKU', 'Product', 'Unit', 'Ordered', 'Order value', 'Dispatched', 'Dispatched value'],
      rows: d.by_product.map((p) => [p.sku, p.product_name, p.unit, Number(p.ordered), Number(p.order_value), Number(p.dispatched), Number(p.dispatched_value)]) },
    { name: 'Categories', headers: ['Category', 'Order value', 'Dispatched value'], rows: d.by_category.map((c) => [c.category, Number(c.order_value), Number(c.dispatched_value)]) },
    { name: 'Open lines', headers: ['Order', 'Customer', 'SKU', 'Unit', 'Ordered', 'Dispatched', 'Remaining', 'Reserved', 'Available now', 'Shortage'],
      rows: d.open_lines.rows.map((r) => [r.sales_order_number, r.customer, r.sku, r.unit, Number(r.ordered), Number(r.dispatched), Number(r.remaining), Number(r.reserved), Number(r.available_now), Number(r.shortage)]) },
  ]
}
