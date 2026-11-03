import { AlertTriangle, CheckCircle2, ClipboardCheck, FileSpreadsheet, PackageCheck, Truck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { LoadingState } from '@/components/common/loading-state'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { pct, qty, STATUS_LABEL, type ExportSection } from '@/features/analytics/analytics-format'
import { activeFilters, warehouseOptions } from '@/features/analytics/analytics-options'
import {
  AnalyticsExport, AnalyticsHeader, FilterBar, MetricCard, MiniTable, PeriodControls, PrintHeader, SectionHeading, SelectFilter, StaleBanner, UnavailableCard,
} from '@/features/analytics/analytics-ui'
import { useAnalyticsContext, useAnalyticsFilters, useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { fetchFulfilmentAnalytics, fetchShortages, isAvailable, type FulfilmentAnalytics, type ShortageReport } from '@/services/analytics'

export default function FulfilmentAnalyticsPage() {
  const { has } = usePermissions()
  const context = useAnalyticsContext()
  const ctx = context.data
  const { filters, update, reset } = useAnalyticsFilters(ctx)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [onlyShort, setOnlyShort] = useState(true)
  const customerKey = filters.customerId ? `C:${filters.customerId}` : null
  const q = useAnalyticsQuery(ctx ? () => fetchFulfilmentAnalytics({ from: filters.from, to: filters.to, customerKey, warehouseId: filters.warehouseId }) : null,
    [filters.from, filters.to, customerKey, filters.warehouseId, Boolean(ctx)])
  const sh = useAnalyticsQuery(ctx?.access.shortages ? () => fetchShortages({ customerKey, warehouseId: filters.warehouseId, onlyShort, limit: pageSize, offset: page * pageSize }) : null,
    [customerKey, filters.warehouseId, onlyShort, page, pageSize, Boolean(ctx?.access.shortages)])
  const d = q.data
  const active = activeFilters(filters, ctx, filters.customerId ? [{ label: 'Customer', value: 'Selected customer' }] : [])
  const po = d?.purchase_orders
  const so = d?.sales_orders

  return (
    <>
      <AnalyticsHeader ctx={ctx} filters={filters} lastSuccessAt={q.lastSuccessAt} loading={q.loading || !ctx} onRefresh={() => { context.reload(); q.reload(); sh.reload() }}
        exportButton={<AnalyticsExport allowed={Boolean(ctx?.export.purchase_orders || ctx?.export.sales)} title="Purchase order & fulfilment" fileStem="po-fulfilment" ctx={ctx} filters={filters}
          active={active} generatedAt={q.lastSuccessAt} sections={() => (d ? fulfilmentExport(d, sh.data) : [])}
          notes={['The shortage sheet contains the page of rows shown on screen; eligible stock is shared between lines.']} />} />
      <FilterBar active={active} onClear={reset} appliesTo="The period applies to POs imported, orders created and orders completed; pipeline stages and the shortage report are current. Customer and warehouse apply to all.">
        <PeriodControls ctx={ctx} filters={filters} update={update} />
        {has('customers.read') && <div className="space-y-1"><Label htmlFor="fa-cust">Customer</Label>
          <CustomerSelect id="fa-cust" value={filters.customerId ?? 'all'} onChange={(v) => { setPage(0); update({ customerId: v === 'all' ? null : v }) }} allowAll className="w-56" /></div>}
        <SelectFilter id="fa-wh" label="Warehouse" value={filters.warehouseId} onChange={(v) => { setPage(0); update({ warehouseId: v }) }} options={warehouseOptions(ctx)} allLabel="All warehouses" />
      </FilterBar>
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={d ? q.lastSuccessAt : null} onRetry={q.reload} />
      <div className="print-area space-y-8">
        <PrintHeader title="Purchase order & fulfilment" ctx={ctx} filters={filters} active={active} generatedAt={q.lastSuccessAt} />
        {!d ? (q.loading || !ctx ? <LoadingState variant="cards" rows={6} /> : null) : (
          <>
            <section aria-labelledby="fa-po">
              <SectionHeading id="fa-po" title="Customer purchase orders" description="Current revisions only. Converted POs continue as sales orders below." />
              {!po || !isAvailable(po) ? <UnavailableCard title="Purchase orders" reason={po && !isAvailable(po) ? po.reason : ''} /> : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard label="POs imported" value={qty(po.imported)} icon={FileSpreadsheet} accent="blue" kind="period" definition="Current PO revisions uploaded in the period." />
                  <MetricCard label="Awaiting validation" value={qty(po.awaiting_validation)} icon={ClipboardCheck} accent="orange" kind="current" definition="Uploaded POs not yet validated." />
                  <MetricCard label="Unresolved product mappings" value={qty(po.unresolved_mappings)} icon={AlertTriangle} accent="red" kind="current"
                    hint={<Link className="text-primary hover:underline" to="/customer-pos/matching">Resolve in Product Matching</Link>}
                    definition="Open POs with unmatched, ambiguous, invalid or duplicate-review lines." />
                  <MetricCard label="Ready for fulfilment" value={qty(po.ready_for_fulfilment)} icon={CheckCircle2} accent="green" kind="current" definition="Matched POs ready for allocation, not yet converted." />
                  <MetricCard label="Partially allocated" value={qty(po.partially_allocated)} icon={PackageCheck} accent="orange" kind="current" definition="POs with some lines allocated." />
                  <MetricCard label="Fully allocated" value={qty(po.fully_allocated)} icon={PackageCheck} accent="green" kind="current" definition="POs whose open quantity is fully reserved." />
                  <MetricCard label="POs with stock shortages" value={qty(po.with_shortages)} icon={AlertTriangle} accent="red" kind="current" definition="Open, unconverted POs with a matched line short of eligible stock (Phase 6 analysis)." />
                  <MetricCard label="Converted to sales orders" value={qty(po.converted_to_sales_orders)} icon={Truck} accent="blue" kind="current" definition="POs with an active sales order." />
                </div>
              )}
            </section>
            <section aria-labelledby="fa-so">
              <SectionHeading id="fa-so" title="Sales order fulfilment pipeline" />
              {!so || !isAvailable(so) ? <UnavailableCard title="Sales orders" reason={so && !isAvailable(so) ? so.reason : ''} /> : (
                <div className="grid gap-4 xl:grid-cols-2">
                  <ChartCard title="Orders at each stage (current)" description="An order can be at more than one stage when it has several consignments"
                    isEmpty={[so.awaiting_confirmation, so.awaiting_allocation, so.awaiting_picking, so.awaiting_packing, so.awaiting_dispatch, so.partially_dispatched, so.on_hold].every((n) => !n)}
                    table={{ headers: ['Stage', 'Orders'], rows: stages(so).map((s) => [s.label, s.value]) }}>
                    <HorizontalBarChart seriesName="Orders" labelWidth={160} data={stages(so)} />
                  </ChartCard>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <MetricCard label="Completed in period" value={qty(so.completed_in_period)} icon={CheckCircle2} accent="green" kind="period" definition="Fulfilled orders whose last dispatch was in the period." />
                    <MetricCard label="Order fulfilment rate" value={so.fulfilment_rate === null ? null : pct(so.fulfilment_rate)} icon={Truck} accent="green" kind="period"
                      unavailableReason="No orders in the period." hint={`${so.fully_dispatched_in_period} of ${so.orders_in_period} order(s) fully dispatched`}
                      definition="Orders created in the period whose every line is fully dispatched ÷ orders created in the period (cancelled excluded)." />
                    <Card className="sm:col-span-2"><CardHeader><div><CardTitle>Quantity fulfilment (orders of the period)</CardTitle></div></CardHeader>
                      <CardContent><MiniTable headers={['Unit', 'Ordered', 'Dispatched', 'Rate']} empty="No orders in the period." rows={so.units.map((u) => [u.unit, qty(u.ordered), qty(u.dispatched), pct(u.rate)])} /></CardContent></Card>
                  </div>
                </div>
              )}
            </section>
            <section aria-labelledby="fa-short">
              <SectionHeading id="fa-short" title="Shortage report (current)" description={sh.data?.definition}>
                <label className="print-hidden flex items-center gap-2 text-sm"><Checkbox checked={onlyShort} onCheckedChange={(v) => { setPage(0); setOnlyShort(v === true) }} /> Only lines with a shortage</label>
              </SectionHeading>
              {!ctx?.access.shortages ? <UnavailableCard title="Shortage report" reason="Your role does not include the customer_po_shortages.read permission." /> : (
                <Card><CardContent className="space-y-3 p-4">
                  {sh.error && <p role="alert" className="text-sm text-red-800">Could not load the shortage report: {sh.error}</p>}
                  {sh.loading && !sh.data ? <LoadingState variant="table" rows={5} /> : sh.data && (
                    <>
                      <MiniTable headers={['Customer PO', 'Sales order', 'Product', 'Ordered', 'Dispatched', 'Reserved', 'Eligible available', 'Remaining required', 'Shortage', 'In-house', 'Outsourced', 'Suggested next action']}
                        empty={onlyShort ? 'No open line is short of stock.' : 'No open lines.'}
                        align={['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left']}
                        rows={sh.data.rows.map((r) => [
                          r.purchase_order_id ? <Link key="p" className="text-primary hover:underline" to={`/customer-pos/${r.purchase_order_id}`}>{r.customer_po_number ?? '—'}</Link> : (r.customer_po_number ?? '—'),
                          r.sales_order_id ? <Link key="s" className="text-primary hover:underline" to={`/sales/order-details?so=${r.sales_order_id}`}>{r.sales_order_number}</Link> : <span key="s" className="text-muted-foreground">Not converted</span>,
                          <span key="pr">{r.sku}<span className="block text-xs text-muted-foreground">{r.product_name} · {r.customer}</span></span>,
                          `${qty(r.ordered)} ${r.unit}`, qty(r.dispatched), qty(r.reserved), qty(r.available), qty(r.remaining_required),
                          Number(r.shortage) > 0 ? <span key="sh" className="font-medium text-shortage">{qty(r.shortage)}</span> : '0',
                          <span key="ih" className="text-manufacturing">{qty(r.in_house)}</span>, <span key="os" className="text-outsourced">{qty(r.outsourced)}</span>, r.next_action])} />
                      <PaginationBar page={page} pageSize={pageSize} total={sh.data.total} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(0) }} disabled={sh.loading} />
                      {sh.data.product_totals.length > 0 && (
                        <div><p className="mb-1 text-sm font-medium">Net shortage by product (shared stock counted once)</p>
                          <MiniTable headers={['Product', 'Required', 'Eligible available', 'Net shortage', 'Lines']} rows={sh.data.product_totals.map((p) => [
                            p.sku, `${qty(p.required)} ${p.unit}`, qty(p.available), <span key="n" className="font-medium text-shortage">{qty(p.net_shortage)}</span>, p.lines])} /></div>
                      )}
                      <p className="text-xs text-muted-foreground">Read-only: nothing is reserved, ordered or planned from this report. Use the linked order or PO to act.</p>
                    </>
                  )}
                </CardContent></Card>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}

type SoSection = Extract<FulfilmentAnalytics['sales_orders'], { available: true }>
function stages(so: SoSection) {
  return [
    { label: 'Awaiting confirmation', value: so.awaiting_confirmation }, { label: 'Awaiting allocation', value: so.awaiting_allocation },
    { label: 'Awaiting picking', value: so.awaiting_picking }, { label: 'Awaiting packing', value: so.awaiting_packing },
    { label: 'Awaiting dispatch', value: so.awaiting_dispatch }, { label: 'Partially dispatched', value: so.partially_dispatched }, { label: 'On hold', value: so.on_hold },
  ].map((s) => ({ label: s.label, value: Number(s.value) }))
}

function fulfilmentExport(d: FulfilmentAnalytics, sh: ShortageReport | null): ExportSection[] {
  const out: ExportSection[] = []
  if (isAvailable(d.purchase_orders)) {
    const p = d.purchase_orders
    out.push({ name: 'Purchase orders', headers: ['Metric', 'Value'], rows: [['Imported (period)', p.imported], ['Awaiting validation', p.awaiting_validation], ['Unresolved mappings', p.unresolved_mappings],
      ['Ready for fulfilment', p.ready_for_fulfilment], ['Partially allocated', p.partially_allocated], ['Fully allocated', p.fully_allocated], ['With shortages', p.with_shortages],
      ['Converted to sales orders', p.converted_to_sales_orders], ...p.by_status.map((s) => [`Status ${STATUS_LABEL(s.status)}`, s.count])] })
  }
  if (isAvailable(d.sales_orders)) {
    const s = d.sales_orders
    out.push({ name: 'Fulfilment pipeline', headers: ['Metric', 'Value'], rows: [...stages(s).map((x) => [x.label, x.value]), ['Completed in period', s.completed_in_period],
      ['Orders in period', s.orders_in_period], ['Fully dispatched (period orders)', s.fully_dispatched_in_period], ['Fulfilment rate %', s.fulfilment_rate]] })
  }
  if (sh) {
    out.push({ name: 'Shortages', headers: ['Source', 'Customer PO', 'Sales order', 'Customer', 'SKU', 'Unit', 'Ordered', 'Dispatched', 'Reserved', 'Eligible available', 'Remaining required', 'Shortage', 'In-house', 'Outsourced', 'Next action'],
      rows: sh.rows.map((r) => [r.source, r.customer_po_number, r.sales_order_number, r.customer, r.sku, r.unit, Number(r.ordered), Number(r.dispatched), Number(r.reserved), Number(r.available),
        Number(r.remaining_required), Number(r.shortage), Number(r.in_house), Number(r.outsourced), r.next_action]) })
  }
  return out
}
