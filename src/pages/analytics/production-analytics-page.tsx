import { AlarmClock, CheckCircle2, Factory, Gauge, PackageX, Truck } from 'lucide-react'
import { Link } from 'react-router-dom'

import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { pct, qty, STATUS_LABEL, unitList, type ExportSection } from '@/features/analytics/analytics-format'
import { activeFilters, warehouseOptions } from '@/features/analytics/analytics-options'
import { formatBucket, formatIso } from '@/features/analytics/analytics-period'
import {
  AnalyticsExport, AnalyticsHeader, FilterBar, MetricCard, MiniTable, PeriodControls, PrintHeader, SectionHeading, SelectFilter, StaleBanner, UnavailableCard,
} from '@/features/analytics/analytics-ui'
import { useAnalyticsContext, useAnalyticsFilters, useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { ProductPicker } from '@/features/inventory/pickers'
import { fetchProductionAnalytics, isAvailable, type ProductionAnalytics } from '@/services/analytics'

export default function ProductionAnalyticsPage() {
  const context = useAnalyticsContext()
  const ctx = context.data
  const { filters, update, reset } = useAnalyticsFilters(ctx)
  const q = useAnalyticsQuery(ctx ? () => fetchProductionAnalytics({ from: filters.from, to: filters.to, warehouseId: filters.warehouseId, productId: filters.productId,
    supplier: filters.supplier, orderId: filters.orderId }) : null,
  [filters.from, filters.to, filters.warehouseId, filters.productId, filters.supplier, filters.orderId, Boolean(ctx)])
  const d = q.data
  const active = activeFilters(filters, ctx)
  const os = d?.outsourcing
  const focus = (id: string, label: string) => update({ orderId: id, orderLabel: label })

  return (
    <>
      <AnalyticsHeader ctx={ctx} filters={filters} lastSuccessAt={q.lastSuccessAt} loading={q.loading || !ctx} onRefresh={() => { context.reload(); q.reload() }}
        exportButton={<AnalyticsExport allowed={Boolean(ctx?.export.production)} title="Production analytics" fileStem="production-analytics" ctx={ctx} filters={filters} active={active}
          generatedAt={q.lastSuccessAt} sections={() => (d ? productionExport(d) : [])}
          notes={['Output is recorded output receipts only; planned quantities are never counted as produced.']} />} />
      <FilterBar active={active} onClear={reset} appliesTo="Warehouse, product and order apply to production orders; supplier applies to outsourcing. The period applies to orders due, output, consumption and outsourcing movements; overdue and shortages are current.">
        <PeriodControls ctx={ctx} filters={filters} update={update} />
        <SelectFilter id="pa-wh" label="Warehouse" value={filters.warehouseId} onChange={(v) => update({ warehouseId: v })} options={warehouseOptions(ctx)} allLabel="All warehouses" />
        <div className="w-64 space-y-1"><Label htmlFor="pa-prod">Product</Label>
          <ProductPicker id="pa-prod" includeInactive value={filters.productId ? { product_id: filters.productId, sku: filters.productLabel ?? 'Selected', product_name: '', base_unit: '', track_batches: false, track_expiry: false } : null}
            onChange={(p) => update({ productId: p?.product_id ?? null, productLabel: p?.sku ?? null })} /></div>
        {os && isAvailable(os) && (
          <SelectFilter id="pa-sup" label="Supplier" value={filters.supplier} onChange={(v) => update({ supplier: v })} options={os.suppliers.map((s) => ({ value: s, label: s }))} allLabel="All suppliers" />
        )}
        {filters.orderId && <Button variant="outline" size="sm" onClick={() => update({ orderId: null, orderLabel: null })}>Show all orders</Button>}
      </FilterBar>
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={d ? q.lastSuccessAt : null} onRetry={q.reload} />
      <div className="print-area space-y-8">
        <PrintHeader title="Production analytics" ctx={ctx} filters={filters} active={active} generatedAt={q.lastSuccessAt} />
        {!d ? (q.loading || !ctx ? <LoadingState variant="cards" rows={6} /> : null) : !d.has_records ? (
          <Card><EmptyState icon={Factory} title="No production or outsourcing orders yet" description="Production analytics appear once orders exist." /></Card>
        ) : (
          <>
            <section aria-labelledby="pa-kpis">
              <SectionHeading id="pa-kpis" title="Production" />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Completion rate" value={d.completion_rate === null ? null : pct(d.completion_rate)} icon={Gauge} accent="green" kind="period"
                  unavailableReason="No approved orders were due in the period." hint={`${d.orders_due_completed} of ${d.orders_due} order(s) due completed`}
                  definition="Orders due (target date) in the period that are completed ÷ approved orders due in the period." />
                <MetricCard label="Good output" value={unitList(d.output, 'good')} icon={CheckCircle2} accent="green" kind="period" definition="Good quantity on output receipts posted in the period." />
                <MetricCard label="Rejected / scrap" value={d.output.length ? d.output.map((o) => `${qty(Number(o.rejected) + Number(o.scrap))} ${o.unit}`).join(' · ') : '0'} icon={PackageX} accent="red" kind="period"
                  hint={d.output.length ? d.output.map((o) => `${qty(o.rejected)} rejected · ${qty(o.scrap)} scrap ${o.unit}`).join('; ') : undefined} definition="Recorded on output receipts in the period." />
                <MetricCard label="Overdue orders" value={qty(d.overdue_count)} icon={AlarmClock} accent="red" kind="current" definition="Open orders whose target completion date has passed." />
              </div>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <ChartCard title="Production orders by status" description="Open orders and orders due or completed in the period" isEmpty={!d.by_status.length}
                  table={{ headers: ['Status', 'Orders'], rows: d.by_status.map((s) => [STATUS_LABEL(s.status), s.orders]) }}>
                  <HorizontalBarChart seriesName="Orders" labelWidth={150} data={d.by_status.map((s) => ({ label: STATUS_LABEL(s.status), value: Number(s.orders),
                    color: s.status === 'COMPLETED' ? TONE_FILL.success : s.status === 'ON_HOLD' ? TONE_FILL.warning : TONE_FILL.info }))} />
                </ChartCard>
                <ChartCard title="Planned vs actual (orders due in the period)" description="Good quantity received so far against the plan, per unit" isEmpty={!d.planned_vs_actual.length}
                  table={{ headers: ['Unit', 'Planned', 'Good', 'Rejected', 'Scrap', 'Rate'], rows: d.planned_vs_actual.map((u) => [u.unit, qty(u.planned), qty(u.good), qty(u.rejected), qty(u.scrap), pct(u.rate)]) }}>
                  <PairedBarChart aName="Planned" bName="Good" aColor={TONE_FILL.neutral} bColor={TONE_FILL.success}
                    data={d.planned_vs_actual.map((u) => ({ label: u.unit, a: Number(u.planned), b: Number(u.good) }))} />
                </ChartCard>
                <Card>
                  <CardHeader><div><CardTitle>Finished goods received by month</CardTitle></div></CardHeader>
                  <CardContent><MiniTable headers={['Month', 'Good', 'Rejected', 'Scrap']} empty="No output recorded in the period." rows={d.output_by_month.map((m) => [
                    formatBucket(m.month, 'month'), `${qty(m.good)} ${m.unit}`, qty(m.rejected), qty(m.scrap)])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Orders due in the period</CardTitle><CardDescription>Click an order to focus the page on it</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Order', 'Product', 'Target', 'Status', 'Good / planned']} empty="No orders due." rows={d.due_orders.map((o) => [
                    <button key="o" type="button" className="text-primary hover:underline" onClick={() => focus(o.order_id, o.order_number)}>{o.order_number}</button>, o.sku,
                    formatIso(o.target_date), STATUS_LABEL(o.status), `${qty(o.good)} / ${qty(o.planned)} ${o.unit}`])} align={['left', 'left', 'left', 'left', 'right']} /></CardContent>
                </Card>
                <Card className="xl:col-span-2">
                  <CardHeader><div><CardTitle>Material requirements vs available stock</CardTitle><CardDescription>{d.shortage_materials} component(s) short for open orders (current)</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Component', 'Warehouse', 'Orders', 'Outstanding', 'Reserved', 'Available', 'Shortage']} empty="No open material requirements."
                    rows={d.material_outlook.map((m) => [<span key="m">{m.sku}<span className="block text-xs text-muted-foreground">{m.order_numbers}</span></span>, m.warehouse, m.orders,
                      `${qty(m.outstanding)} ${m.unit}`, qty(m.reserved_for_orders), qty(m.available),
                      Number(m.shortage) > 0 ? <span key="s" className="font-medium text-shortage">{qty(m.shortage)}</span> : '0'])} align={['left', 'left', 'right', 'right', 'right', 'right', 'right']} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Material consumption by order</CardTitle><CardDescription>Issues posted in the period</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Order', 'Product', 'Issued', 'Planned (issued lines)']} empty="No material issued in the period." rows={d.consumption_by_order.map((c) => [
                    <Link key="o" className="text-primary hover:underline" to={`/production/orders/${c.order_id}`}>{c.order_number}</Link>, c.product_sku, `${qty(c.quantity)} ${c.unit}`, qty(c.planned)])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Orders overdue against target date</CardTitle></div></CardHeader>
                  <CardContent><MiniTable headers={['Order', 'Product', 'Target', 'Days late', 'Good / planned']} empty="No overdue orders." rows={d.overdue_orders.map((o) => [
                    <Link key="o" className="text-primary hover:underline" to={`/production/orders/${o.order_id}`}>{o.order_number}</Link>, o.sku, formatIso(o.target_date),
                    <span key="l" className="text-shortage">{o.days_late}</span>, `${qty(o.good)} / ${qty(o.planned)} ${o.unit}`])} align={['left', 'left', 'left', 'right', 'right']} /></CardContent>
                </Card>
              </div>
            </section>
            <section aria-labelledby="pa-os">
              <SectionHeading id="pa-os" title="Outsourcing" description="Company material held by outside processors is never counted as available warehouse stock." />
              {!os || !isAvailable(os) ? <UnavailableCard title="Outsourcing analytics" reason={os && !isAvailable(os) ? os.reason : ''} /> : (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="grid gap-4 sm:grid-cols-2 xl:col-span-2 xl:grid-cols-4">
                    <MetricCard label="Awaiting receipt" value={unitList(os.awaiting_receipt, 'quantity')} icon={Truck} accent="purple" kind="current" definition="Ordered − received on open outsourcing orders." />
                    <MetricCard label="Held at processors (ledger)" value={unitList(os.external_stock.map((e) => ({ unit: e.unit, quantity: e.on_hand })), 'quantity')} icon={Factory} accent="purple" kind="current"
                      definition="Stock in external-processing locations according to the stock ledger." />
                    <MetricCard label="Overdue returns" value={qty(os.overdue.length)} icon={AlarmClock} accent="red" kind="current" definition="Open outsourcing orders past their expected return date." />
                    <MetricCard label="Average lead time" value={os.lead_time.average_days === null ? null : `${os.lead_time.average_days} days`} icon={Gauge} accent="purple" kind="period"
                      unavailableReason="No order with a dispatch date was completed in the period." hint={`${os.lead_time.orders} completed order(s)`} definition={os.lead_time.definition} />
                  </div>
                  <ChartCard title="Material sent to suppliers vs returned" description="Movements posted in the period" isEmpty={!os.flows.length}
                    table={{ headers: ['Unit', 'Dispatched', 'Returned'], rows: os.flows.map((f) => [f.unit, qty(f.dispatched), qty(f.returned)]) }}>
                    <PairedBarChart aName="Dispatched to suppliers" bName="Returned" aColor={CHART_COLORS.outsourced} bColor={CHART_COLORS.inHouse}
                      data={os.flows.map((f) => ({ label: f.unit, a: Number(f.dispatched), b: Number(f.returned) }))} />
                  </ChartCard>
                  <Card>
                    <CardHeader><div><CardTitle>Outsourcing orders by status</CardTitle></div></CardHeader>
                    <CardContent className="space-y-3">
                      <MiniTable headers={['Status', 'Orders']} empty="No outsourcing orders." rows={os.by_status.map((s) => [STATUS_LABEL(s.status), s.orders])} />
                      <MiniTable headers={['Received in period', 'Accepted', 'Rejected']} empty="Nothing received in the period." rows={os.received.map((r) => [`${qty(r.received)} ${r.unit}`, qty(r.accepted), qty(r.rejected)])} />
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><div><CardTitle>Material held by suppliers</CardTitle><CardDescription>Dispatched − returned − consumed on open orders</CardDescription></div></CardHeader>
                    <CardContent><MiniTable headers={['Supplier', 'Material', 'Quantity']} empty="No material is held by suppliers." rows={os.held_by_suppliers.map((h) => [h.supplier, h.sku, `${qty(h.quantity)} ${h.unit}`])} /></CardContent>
                  </Card>
                  <Card>
                    <CardHeader><div><CardTitle>Overdue outsourcing returns</CardTitle></div></CardHeader>
                    <CardContent><MiniTable headers={['Order', 'Supplier', 'Expected', 'Days late', 'Outstanding']} empty="No overdue returns." rows={os.overdue.map((o) => [
                      <Link key="o" className="text-primary hover:underline" to={`/production/outsourcing/${o.order_id}`}>{o.order_number}</Link>, o.supplier, formatIso(o.expected_return_date),
                      <span key="l" className="text-shortage">{o.days_late}</span>, `${qty(o.outstanding)} ${o.unit}`])} align={['left', 'left', 'left', 'right', 'right']} /></CardContent>
                  </Card>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}

function productionExport(d: ProductionAnalytics): ExportSection[] {
  const sections: ExportSection[] = [
    { name: 'Summary', headers: ['Metric', 'Value'], rows: [['Orders due in period', d.orders_due], ['Orders due completed', d.orders_due_completed], ['Completion rate %', d.completion_rate],
      ['Overdue orders (current)', d.overdue_count], ['Components short (current)', d.shortage_materials]] },
    { name: 'Planned vs actual', headers: ['Unit', 'Planned', 'Good', 'Rejected', 'Scrap', 'Rate %'], rows: d.planned_vs_actual.map((u) => [u.unit, Number(u.planned), Number(u.good), Number(u.rejected), Number(u.scrap), u.rate]) },
    { name: 'Output', headers: ['Month', 'Unit', 'Good', 'Rejected', 'Scrap'], rows: d.output_by_month.map((m) => [m.month, m.unit, Number(m.good), Number(m.rejected), Number(m.scrap)]) },
    { name: 'Material outlook', headers: ['Component', 'Unit', 'Warehouse', 'Outstanding', 'Reserved', 'Available', 'Shortage'],
      rows: d.material_outlook.map((m) => [m.sku, m.unit, m.warehouse, Number(m.outstanding), Number(m.reserved_for_orders), Number(m.available), Number(m.shortage)]) },
    { name: 'Overdue orders', headers: ['Order', 'Product', 'Target', 'Days late', 'Planned', 'Good'], rows: d.overdue_orders.map((o) => [o.order_number, o.sku, o.target_date, o.days_late, Number(o.planned), Number(o.good)]) },
  ]
  if (isAvailable(d.outsourcing)) {
    sections.push({ name: 'Outsourcing', headers: ['Supplier', 'Material', 'Unit', 'Held quantity'], rows: d.outsourcing.held_by_suppliers.map((h) => [h.supplier, h.sku, h.unit, Number(h.quantity)]) })
  }
  return sections
}
