import { Boxes, CalendarClock, CheckCircle2, Lock, PackageX } from 'lucide-react'
import { Link } from 'react-router-dom'

import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { inr, pct, qty, STATUS_LABEL, unitList, type ExportSection } from '@/features/analytics/analytics-format'
import { activeFilters, categoryOptions, SOURCE_OPTIONS, warehouseOptions } from '@/features/analytics/analytics-options'
import { bucketFor, formatBucket, formatIso } from '@/features/analytics/analytics-period'
import {
  AnalyticsExport, AnalyticsHeader, FilterBar, MetricCard, MiniTable, PeriodControls, PrintHeader, SectionHeading, SelectFilter, StaleBanner,
} from '@/features/analytics/analytics-ui'
import { useDrilldown } from '@/features/analytics/use-drilldown'
import { useAnalyticsContext, useAnalyticsFilters, useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { fetchInventoryAnalytics, type InventoryAnalytics } from '@/services/analytics'

const USAGE_LABEL: Record<string, string> = { STORAGE: 'Storage (saleable)', QUARANTINE: 'Quarantine', REJECTED: 'Rejected', EXTERNAL_PROCESSING: 'At outside processors' }

export default function InventoryAnalyticsPage() {
  const context = useAnalyticsContext()
  const ctx = context.data
  const { filters, update, reset } = useAnalyticsFilters(ctx)
  const drill = useDrilldown()
  const bucket = bucketFor(filters.from, filters.to)
  const q = useAnalyticsQuery(ctx ? () => fetchInventoryAnalytics({ from: filters.from, to: filters.to, warehouseId: filters.warehouseId, categoryId: filters.categoryId,
    sourceType: filters.sourceType, bucket }) : null, [filters.from, filters.to, filters.warehouseId, filters.categoryId, filters.sourceType, bucket, Boolean(ctx)])
  const d = q.data
  const active = activeFilters(filters, ctx)
  const units = d ? [...new Set([...d.current.by_warehouse.map((w) => w.unit), ...d.period.balances.map((b) => b.unit)])].sort() : []
  const primary = d ? [...d.current.by_warehouse].reduce<Record<string, number>>((acc, w) => ({ ...acc, [w.unit]: (acc[w.unit] ?? 0) + Number(w.on_hand) }), {}) : {}
  const mainUnit = Object.entries(primary).sort((a, b) => b[1] - a[1])[0]?.[0] ?? units[0]

  return (
    <>
      <AnalyticsHeader ctx={ctx} filters={filters} lastSuccessAt={q.lastSuccessAt} loading={q.loading || !ctx} onRefresh={() => { context.reload(); q.reload() }}
        extraNote={<span>Current position is today's stock; period figures come from posted ledger transactions.</span>}
        exportButton={<AnalyticsExport allowed={Boolean(ctx?.export.inventory)} title="Inventory analytics" fileStem="inventory-analytics" ctx={ctx} filters={filters} active={active}
          generatedAt={q.lastSuccessAt} sections={() => (d ? inventoryExport(d) : [])}
          notes={['"Current" sheets are today\'s position; "Period" sheets are ledger movements in the period.', 'Quantities are per unit of measure and never added across units.']} />} />
      <FilterBar active={active} onClear={reset} appliesTo="Warehouse, category and source apply to the current position and to period movements. The period applies only to movements, transfers, adjustments and counts.">
        <PeriodControls ctx={ctx} filters={filters} update={update} />
        <SelectFilter id="ia-wh" label="Warehouse" value={filters.warehouseId} onChange={(v) => update({ warehouseId: v })} options={warehouseOptions(ctx)} allLabel="All warehouses" />
        <SelectFilter id="ia-cat" label="Category" value={filters.categoryId} onChange={(v) => update({ categoryId: v })} options={categoryOptions(ctx)} allLabel="All categories" />
        <SelectFilter id="ia-src" label="Source" value={filters.sourceType} onChange={(v) => update({ sourceType: v })} options={SOURCE_OPTIONS} allLabel="In-house and outsourced" />
      </FilterBar>
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={d ? q.lastSuccessAt : null} onRetry={q.reload} />
      <div className="print-area space-y-8">
        <PrintHeader title="Inventory analytics" ctx={ctx} filters={filters} active={active} generatedAt={q.lastSuccessAt} />
        {!d ? (q.loading || !ctx ? <LoadingState variant="cards" rows={6} /> : null) : !d.has_records ? (
          <Card><EmptyState icon={Boxes} title="No stock movements yet" description="Inventory analytics appear after opening stock or receipts are posted." /></Card>
        ) : (
          <>
            <section aria-labelledby="ia-current">
              <SectionHeading id="ia-current" title="Current position" description={`Stock as of now (${formatIso(d.today)}), not the end of the selected period.`} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="On hand" value={unitList(d.current.by_warehouse, 'on_hand')} icon={Boxes} accent="blue" kind="current" definition="All company-owned stock in the selected warehouses."
                  onDrill={() => drill.open({ source: 'stock', title: 'Current stock by lot and location', warehouseId: filters.warehouseId, categoryId: filters.categoryId, sourceType: filters.sourceType })} />
                <MetricCard label="Available" value={unitList(d.current.by_warehouse, 'available')} icon={CheckCircle2} accent="green" kind="current" definition="On hand − reserved in storage locations." />
                <MetricCard label="Below reorder level" value={qty(d.current.below_reorder_count)} icon={PackageX} accent="orange" kind="current" definition="Available stock at or below the product's reorder level." />
                <MetricCard label="Zero available" value={qty(d.current.zero_stock_count)} icon={PackageX} accent="red" kind="current" definition="Active products with no available stock (including never-stocked products)." />
              </div>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <ChartCard title="Stock by warehouse" description={mainUnit ? `On hand vs available, ${mainUnit}` : 'On hand'} isEmpty={!d.current.by_warehouse.length}
                  table={{ headers: ['Warehouse', 'Unit', 'On hand', 'Reserved', 'Available'], rows: d.current.by_warehouse.map((w) => [w.warehouse, w.unit, qty(w.on_hand), qty(w.reserved), qty(w.available)]) }}>
                  <PairedBarChart aName="On hand" bName="Available" aColor={TONE_FILL.neutral} bColor={TONE_FILL.success}
                    data={d.current.by_warehouse.filter((w) => w.unit === mainUnit).map((w) => ({ label: w.warehouse, a: Number(w.on_hand), b: Number(w.available) }))} />
                </ChartCard>
                <ChartCard title="Stock by product category" description={mainUnit ? `On hand, ${mainUnit}` : 'On hand'} isEmpty={!d.current.by_category.length}
                  table={{ headers: ['Category', 'Unit', 'On hand', 'Available'], rows: d.current.by_category.map((c) => [c.category, c.unit, qty(c.on_hand), qty(c.available)]) }}>
                  <HorizontalBarChart seriesName={`On hand (${mainUnit ?? ''})`} labelWidth={150} valueFormatter={(v) => qty(v)}
                    data={d.current.by_category.filter((c) => c.unit === mainUnit).map((c) => ({ label: c.category, value: Number(c.on_hand) }))} />
                </ChartCard>
                <ChartCard title="In-house vs outsourced stock" description="On hand by the source recorded on each lot" isEmpty={!d.current.by_source.length}
                  table={{ headers: ['Unit', 'In-house', 'Outsourced', 'Unknown source'], rows: d.current.by_source.map((s) => [s.unit, qty(s.in_house), qty(s.outsourced), qty(s.unknown)]) }}>
                  <PairedBarChart aName="In-house" bName="Outsourced" aColor={CHART_COLORS.inHouse} bColor={CHART_COLORS.outsourced}
                    data={d.current.by_source.map((s) => ({ label: s.unit, a: Number(s.in_house), b: Number(s.outsourced) }))} />
                </ChartCard>
                <Card>
                  <CardHeader><div><CardTitle>Where stock is held</CardTitle><CardDescription>Only storage stock can be available</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Usage', 'On hand']} rows={d.current.by_usage.map((u) => [USAGE_LABEL[u.usage] ?? u.usage, `${qty(u.on_hand)} ${u.unit}`])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Top products by available quantity</CardTitle><CardDescription>Top 20</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Product', 'Available', 'Reserved']} empty="No available stock." rows={d.current.top_available.map((p) => [
                    <Link key="p" className="text-primary hover:underline" to={`/inventory/stock/${p.product_id}`}>{p.sku}</Link>, `${qty(p.available)} ${p.unit}`, qty(p.reserved)])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Products below reorder level</CardTitle><CardDescription>{d.current.below_reorder_count} product(s)</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Product', 'Available', 'Reorder level', 'Gap']} empty="No product is below its reorder level." rows={d.current.below_reorder.map((p) => [
                    <Link key="p" className="text-primary hover:underline" to={`/inventory/stock/${p.product_id}`}>{p.sku}</Link>, `${qty(p.available)} ${p.unit}`, qty(p.reorder_level),
                    <span key="g" className="text-shortage">{qty(p.gap)}</span>])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Zero available stock</CardTitle><CardDescription>{d.current.zero_stock_count} product(s)</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Product', 'Storage on hand', 'Reserved', 'History']} empty="Every active product has available stock." rows={d.current.zero_stock.map((p) => [
                    <Link key="p" className="text-primary hover:underline" to={`/inventory/stock/${p.product_id}`}>{p.sku}</Link>, `${qty(p.storage_on_hand)} ${p.unit}`, qty(p.reserved),
                    p.has_history ? 'Stocked before' : 'Never stocked'])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Reservation utilisation</CardTitle><CardDescription>Reserved share of storage stock, and open reservations by purpose</CardDescription></div></CardHeader>
                  <CardContent className="space-y-3">
                    <MiniTable headers={['Unit', 'Storage on hand', 'Reserved', 'Utilisation']} rows={d.current.reservation_utilisation.map((r) => [r.unit, qty(r.storage_on_hand), qty(r.reserved), pct(r.percent)])} empty="No storage stock." />
                    <MiniTable headers={['Reserved for', 'Reservations', 'Quantity']} rows={d.current.reservations_by_type.map((r) => [STATUS_LABEL(r.reference_type), r.reservations, `${qty(r.quantity)} ${r.unit}`])} empty="No open reservations." />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle className="flex items-center gap-2"><CalendarClock className="size-4" /> Batch and expiry alerts</CardTitle><CardDescription>Products with expiry tracking only</CardDescription></div></CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-sm">Expired on hand: <span className="font-medium text-shortage">{unitList(d.current.expiry.expired, 'quantity')}</span> · expiring within 30 days: <span className="font-medium text-amber-700">{unitList(d.current.expiry.expiring_30, 'quantity')}</span></p>
                    <MiniTable headers={['Product', 'Lot', 'Expiry', 'Days left', 'On hand']} empty="No expired or soon-expiring lots." rows={d.current.expiry.lots.map((l) => [
                      l.sku, l.batch_number ?? '—', formatIso(l.expiry_date), l.days_left < 0 ? <span key="d" className="text-shortage">expired</span> : l.days_left, `${qty(l.on_hand)} ${l.unit}`])} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Stock valuation</CardTitle><CardDescription>Current position only; historical valuation is not reconstructed</CardDescription></div></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {'method' in d.valuation ? (d.valuation.available ? <><p className="text-2xl font-semibold">{inr(d.valuation.value)}</p><p className="text-muted-foreground">{d.valuation.method}</p></> : (
                      <><p className="font-medium">{d.valuation.lots ? 'Valuation unavailable — cost data required' : 'No stock on hand'}</p>
                        {d.valuation.lots > 0 && <p className="text-muted-foreground">{d.valuation.costed_lots} of {d.valuation.lots} lots have a recorded receipt cost; {unitList(d.valuation.uncosted, 'quantity')} has none. Selling prices are never substituted.</p>}</>
                    )) : <p className="flex items-center gap-2 text-muted-foreground"><Lock className="size-4" /> {d.valuation.reason}</p>}
                  </CardContent>
                </Card>
              </div>
            </section>
            <section aria-labelledby="ia-period">
              <SectionHeading id="ia-period" title="Movements in the period" description="From posted ledger transactions; internal transfers are excluded from receipts and issues." />
              <div className="grid gap-4 xl:grid-cols-2">
                <Card className="xl:col-span-2">
                  <CardHeader><div><CardTitle>Stock at the start and end of the period</CardTitle><CardDescription>Reconstructed from every posted transaction (receipts, issues, transfers, adjustments, reversals)</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Unit', 'Opening', 'Closing', 'Net change']} rows={d.period.balances.map((b) => [b.unit, qty(b.opening), qty(b.closing), qty(b.net_change)])} empty="No transactions." /></CardContent>
                </Card>
                {units.map((u) => {
                  const points = d.period.trend.filter((t) => t.unit === u)
                  return (
                    <ChartCard key={u} title={`Stock movement trend (${u})`} description={`Received vs issued per ${d.bucket}`} isEmpty={!points.length}
                      table={{ headers: ['Period', 'Received', 'Issued'], rows: points.map((t) => [formatBucket(t.bucket, d.bucket), qty(t.in), qty(t.out)]) }}>
                      <PairedBarChart aName="Received" bName="Issued" aColor={CHART_COLORS.inward} bColor={CHART_COLORS.outward}
                        data={points.map((t) => ({ label: formatBucket(t.bucket, d.bucket), a: Number(t.in), b: Number(t.out) }))} />
                    </ChartCard>
                  )
                })}
                <Card>
                  <CardHeader><div><CardTitle>Goods received vs issued by type</CardTitle></div></CardHeader>
                  <CardContent><MiniTable headers={['Type', 'Received', 'Issued', 'Transactions']} empty="No movements in the period." rows={d.period.by_type.map((t) => [
                    STATUS_LABEL(t.transaction_type), Number(t.in) ? `${qty(t.in)} ${t.unit}` : '—', Number(t.out) ? `${qty(t.out)} ${t.unit}` : '—', t.transactions])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Transfers between warehouses</CardTitle><CardDescription>{d.period.transfers.count} transfer(s), {d.period.transfers.between_warehouses} between warehouses; counted once, not as receipt + issue</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['From', 'To', 'Transfers', 'Quantity']} empty="No transfers in the period." rows={d.period.transfers.routes.map((r) => [r.from, r.to, r.transfers, `${qty(r.quantity)} ${r.unit}`])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Stock adjustments and reasons</CardTitle><CardDescription>{d.period.adjustments.posted} posted in the period · {d.period.adjustments.pending_approval} awaiting approval</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Reason', 'Adjustments', 'Increase', 'Decrease']} empty="No posted adjustments." rows={d.period.adjustments.by_reason.map((a) => [
                    STATUS_LABEL(a.reason_code), a.adjustments, `${qty(a.increase)} ${a.unit}`, `${qty(a.decrease)} ${a.unit}`])} /></CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Physical count discrepancies</CardTitle>
                    <CardDescription>{d.period.counts.posted_counts} count(s) posted · {d.period.counts.lines_with_variance} of {d.period.counts.lines_counted} line(s) differed · {d.period.counts.pending_review} awaiting review</CardDescription></div></CardHeader>
                  <CardContent className="space-y-2">
                    <MiniTable headers={['Unit', 'Surplus', 'Shortfall']} rows={d.period.counts.by_unit.map((u) => [u.unit, qty(u.surplus), qty(u.shortfall)])} empty="No discrepancies in posted counts." />
                    {d.period.counts.rows.length > 0 && <MiniTable headers={['Count', 'Product', 'System', 'Counted', 'Variance']} rows={d.period.counts.rows.map((r) => [
                      <Link key="c" className="text-primary hover:underline" to={`/inventory/counts/${r.count_id}`}>{r.count_number}</Link>, r.sku, qty(r.system_quantity), qty(r.counted_quantity),
                      `${Number(r.variance) > 0 ? '+' : ''}${qty(r.variance)} ${r.unit}`])} />}
                  </CardContent>
                </Card>
              </div>
            </section>
          </>
        )}
      </div>
      {drill.element}
    </>
  )
}

function inventoryExport(d: InventoryAnalytics): ExportSection[] {
  return [
    { name: 'Current by warehouse', headers: ['Warehouse', 'Unit', 'On hand', 'Reserved', 'Available'], rows: d.current.by_warehouse.map((w) => [w.warehouse, w.unit, Number(w.on_hand), Number(w.reserved), Number(w.available)]) },
    { name: 'Current by category', headers: ['Category', 'Unit', 'On hand', 'Available'], rows: d.current.by_category.map((c) => [c.category, c.unit, Number(c.on_hand), Number(c.available)]) },
    { name: 'Current by source', headers: ['Unit', 'In-house', 'Outsourced', 'Unknown'], rows: d.current.by_source.map((s) => [s.unit, Number(s.in_house), Number(s.outsourced), Number(s.unknown)]) },
    { name: 'Below reorder', headers: ['SKU', 'Product', 'Unit', 'Available', 'Reorder level'], rows: d.current.below_reorder.map((p) => [p.sku, p.product_name, p.unit, Number(p.available), Number(p.reorder_level)]) },
    { name: 'Zero available', headers: ['SKU', 'Product', 'Unit', 'Storage on hand', 'Reserved', 'Stocked before'], rows: d.current.zero_stock.map((p) => [p.sku, p.product_name, p.unit, Number(p.storage_on_hand), Number(p.reserved), p.has_history ? 'Yes' : 'No']) },
    { name: 'Period balances', headers: ['Unit', 'Opening', 'Closing', 'Net change'], rows: d.period.balances.map((b) => [b.unit, Number(b.opening), Number(b.closing), Number(b.net_change)]) },
    { name: 'Period by type', headers: ['Type', 'Unit', 'Received', 'Issued', 'Transactions'], rows: d.period.by_type.map((t) => [t.transaction_type, t.unit, Number(t.in), Number(t.out), t.transactions]) },
    { name: 'Transfers', headers: ['From', 'To', 'Unit', 'Transfers', 'Quantity'], rows: d.period.transfers.routes.map((r) => [r.from, r.to, r.unit, r.transfers, Number(r.quantity)]) },
    { name: 'Adjustments', headers: ['Reason', 'Unit', 'Adjustments', 'Increase', 'Decrease'], rows: d.period.adjustments.by_reason.map((a) => [a.reason_code, a.unit, a.adjustments, Number(a.increase), Number(a.decrease)]) },
  ]
}
