import {
  AlarmClock, AlertTriangle, Boxes, CheckCircle2, ClipboardList, Factory, FileText, Gauge, HandCoins, Hourglass, IndianRupee, Lock, Package, PackageX,
  Receipt, ShoppingCart, Truck, Wallet, Warehouse,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { refreshFailedAlert, SEVERITY_LABEL, sortAlerts } from '@/features/analytics/analytics-alerts'
import { inr, pct, qty, unitList, type ExportSection } from '@/features/analytics/analytics-format'
import { activeFilters, categoryOptions, warehouseOptions } from '@/features/analytics/analytics-options'
import { dayStartInstant, addDays, formatBucket } from '@/features/analytics/analytics-period'
import {
  AnalyticsExport, AnalyticsHeader, FilterBar, MetricCard, PeriodControls, PrintHeader, SectionHeading, SelectFilter, StaleBanner, UnavailableCard,
} from '@/features/analytics/analytics-ui'
import { useDrilldown } from '@/features/analytics/use-drilldown'
import { useAnalyticsContext, useAnalyticsFilters, useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { formatDate } from '@/lib/format'
import {
  fetchAlerts, fetchExecutive, fetchFinanceAnalytics, fetchSalesAnalytics, isAvailable, type AlertSeverity, type ExecutiveData,
} from '@/services/analytics'

type SectionKey = 'sales' | 'billing' | 'inventory' | 'production'
const VIEWS: { value: string; label: string; order: SectionKey[] }[] = [
  { value: 'company', label: 'Company-wide', order: ['sales', 'billing', 'inventory', 'production'] },
  { value: 'sales', label: 'Sales focus', order: ['sales', 'inventory', 'billing', 'production'] },
  { value: 'inventory', label: 'Inventory focus', order: ['inventory', 'sales', 'production', 'billing'] },
  { value: 'production', label: 'Production focus', order: ['production', 'inventory', 'sales', 'billing'] },
  { value: 'purchase', label: 'Purchase focus', order: ['inventory', 'production', 'sales', 'billing'] },
  { value: 'accounts', label: 'Accounts focus', order: ['billing', 'sales', 'inventory', 'production'] },
]
const ROLE_VIEW: [string, string][] = [
  ['SUPER_ADMIN', 'company'], ['ADMIN', 'company'], ['MANAGEMENT_VIEWER', 'company'], ['ACCOUNTS_MANAGER', 'accounts'], ['SALES_MANAGER', 'sales'],
  ['INVENTORY_MANAGER', 'inventory'], ['PRODUCTION_MANAGER', 'production'], ['PURCHASE_MANAGER', 'purchase'],
]
const SEVERITY_TONE: Record<AlertSeverity, 'danger' | 'warning' | 'info' | 'neutral'> = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'info' }
const SECTION_TITLE: Record<SectionKey, string> = { sales: 'Sales & dispatch', billing: 'Billing & receivables', inventory: 'Inventory (current position)', production: 'Manufacturing & outsourcing' }

export default function ExecutiveDashboardPage() {
  const { roles } = usePermissions()
  const context = useAnalyticsContext()
  const ctx = context.data
  const { filters, update, reset } = useAnalyticsFilters(ctx)
  const defaultView = ROLE_VIEW.find(([r]) => roles.has(r as never))?.[1] ?? 'company'
  const [view, setView] = useState<string | null>(null)
  const order = VIEWS.find((v) => v.value === (view ?? defaultView))?.order ?? VIEWS[0].order
  const drill = useDrilldown()

  const ready = Boolean(ctx)
  const ex = useAnalyticsQuery(ready ? () => fetchExecutive({ from: filters.from, to: filters.to, asOf: filters.asOf, warehouseId: filters.warehouseId, categoryId: filters.categoryId }) : null,
    [filters.from, filters.to, filters.asOf, filters.warehouseId, filters.categoryId, ready])
  const sales = useAnalyticsQuery(ready && ctx?.access.sales ? () => fetchSalesAnalytics({ from: filters.from, to: filters.to, warehouseId: filters.warehouseId, categoryId: filters.categoryId, bucket: 'month' }) : null,
    [filters.from, filters.to, filters.warehouseId, filters.categoryId, ready && ctx?.access.sales])
  const fin = useAnalyticsQuery(ready && ctx?.access.billing ? () => fetchFinanceAnalytics({ from: filters.from, to: filters.to, asOf: filters.asOf }) : null,
    [filters.from, filters.to, filters.asOf, ready && ctx?.access.billing])
  const alerts = useAnalyticsQuery(ready ? () => fetchAlerts(filters.asOf) : null, [filters.asOf, ready])
  const refreshAll = () => { context.reload(); ex.reload(); sales.reload(); fin.reload(); alerts.reload() }
  const active = activeFilters(filters, ctx)
  const d = ex.data
  const tz = ctx?.timezone ?? 'Asia/Kolkata'
  const period = { from: filters.from, to: filters.to }
  const instants = { fromInstant: dayStartInstant(filters.from, tz), toInstant: dayStartInstant(addDays(filters.to, 1), tz) }

  const failures = [
    ex.error && refreshFailedAlert('Executive KPIs', ex.error, ex.failedAt ?? ''),
    sales.error && refreshFailedAlert('Sales trend', sales.error, sales.failedAt ?? ''),
    fin.error && refreshFailedAlert('Billing trend', fin.error, fin.failedAt ?? ''),
    alerts.error && refreshFailedAlert('Alerts', alerts.error, alerts.failedAt ?? ''),
  ].filter(Boolean)
  const topAlerts = useMemo(() => sortAlerts(alerts.data?.alerts ?? []).slice(0, 8), [alerts.data])

  const exportSections = (): ExportSection[] => (d ? buildExport(d, ctx?.export ?? null) : [])
  const canExport = Boolean(ctx && Object.entries(ctx.export).some(([k, v]) => v && k !== 'data_quality'))

  if (context.error) return <><AnalyticsHeader ctx={null} filters={filters} lastSuccessAt={null} loading={false} onRefresh={context.reload} /><StaleBanner error={context.error} failedAt={null} lastSuccessAt={null} onRetry={context.reload} /></>

  return (
    <>
      <AnalyticsHeader ctx={ctx} filters={filters} lastSuccessAt={ex.lastSuccessAt} loading={ex.loading || !ctx} onRefresh={refreshAll}
        extraNote={d && <span>Balances as of <span className="font-medium text-foreground">{formatDate(d.as_of)}</span> · stock is the current position</span>}
        exportButton={<AnalyticsExport allowed={canExport} title="Executive dashboard" fileStem="executive-dashboard" ctx={ctx} filters={filters} active={active}
          generatedAt={ex.lastSuccessAt} sections={exportSections}
          notes={['Order value, dispatched value and invoiced value are different measures.', 'Receipts are as recorded by users and are not bank-verified.', 'Stock figures are the current position, not the position at the end of the period.']} />} />
      <FilterBar active={active} onClear={reset} appliesTo="Period filters apply to orders, dispatches, invoices, receipts and production in the period. Warehouse and category apply to sales and stock; receivables are company-wide as of the reporting date.">
        <PeriodControls ctx={ctx} filters={filters} update={update} showAsOf />
        <SelectFilter id="af-wh" label="Warehouse" value={filters.warehouseId} onChange={(v) => update({ warehouseId: v })} options={warehouseOptions(ctx)} allLabel="All warehouses" />
        <SelectFilter id="af-cat" label="Product category" value={filters.categoryId} onChange={(v) => update({ categoryId: v })} options={categoryOptions(ctx)} allLabel="All categories" />
        <div className="space-y-1"><Label htmlFor="af-view">Dashboard view</Label>
          <Select value={view ?? defaultView} onValueChange={setView}><SelectTrigger id="af-view" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>{VIEWS.map((v) => <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>)}</SelectContent></Select></div>
      </FilterBar>
      <StaleBanner error={ex.error} failedAt={ex.failedAt} lastSuccessAt={ex.data ? ex.lastSuccessAt : null} onRetry={ex.reload} />

      <div className="print-area space-y-8">
        <PrintHeader title="Executive dashboard" ctx={ctx} filters={filters} active={active} generatedAt={ex.lastSuccessAt} />
        {!d ? (ex.loading || !ctx ? <LoadingState variant="cards" rows={8} /> : null) : (
          order.map((key) => <div key={key}>{renderSection(key, d)}</div>)
        )}

        {(failures.length > 0 || topAlerts.length > 0 || alerts.loading) && (
          <section aria-labelledby="ex-alerts" className="print-avoid-break">
            <SectionHeading id="ex-alerts" title="Executive alerts" description="Exceptions found by defined rules on current records. Nothing is changed automatically.">
              <Button variant="outline" size="sm" asChild><Link to="/analytics/alerts">Open alert centre</Link></Button>
            </SectionHeading>
            <Card><CardContent className="p-0">
              {alerts.loading && !alerts.data ? <LoadingState variant="table" rows={3} /> : (
                <ul className="divide-y">
                  {[...(failures as ReturnType<typeof refreshFailedAlert>[]), ...topAlerts].map((a) => (
                    <li key={a.id} className="flex flex-wrap items-start gap-3 px-4 py-3 text-sm">
                      <StatusBadge label={SEVERITY_LABEL[a.severity]} tone={SEVERITY_TONE[a.severity]} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{a.title} · <span className="font-normal">{a.reference}</span></p>
                        <p className="text-muted-foreground">{a.explanation} <span className="text-foreground">{a.action}</span></p>
                      </div>
                      <span className="text-xs text-muted-foreground">Detected {formatDate(a.detected_at)}</span>
                      {a.link && <Button variant="ghost" size="sm" asChild><Link to={a.link}>Open</Link></Button>}
                    </li>
                  ))}
                  {!failures.length && !topAlerts.length && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No alerts for your areas.</li>}
                </ul>
              )}
            </CardContent></Card>
          </section>
        )}
      </div>
      {drill.element}
    </>
  )

  function renderSection(key: SectionKey, data: ExecutiveData): ReactNode {
    const heading = (desc: string, link?: { to: string; label: string }) => (
      <SectionHeading id={`ex-${key}`} title={SECTION_TITLE[key]} description={desc}>
        {link && <Button variant="outline" size="sm" asChild className="print-hidden"><Link to={link.to}>{link.label}</Link></Button>}
      </SectionHeading>
    )
    if (key === 'sales') {
      const s = data.sales
      if (!isAvailable(s)) return <><SectionHeading id="ex-sales" title={SECTION_TITLE.sales} /><UnavailableCard title="Sales KPIs" reason={s.reason} /></>
      const monthly = (sales.data?.monthly ?? []).map((m) => ({ label: formatBucket(m.month, 'month'), a: Number(m.order_value), b: Number(m.dispatched_value), c: m.invoiced_value === null ? null : Number(m.invoiced_value) }))
      return (
        <section aria-labelledby="ex-sales">
          {heading('Orders, dispatches and fulfilment. Values come from the sales order price snapshots.', { to: '/analytics/sales', label: 'Sales analytics' })}
          {!s.has_records && <Card className="mb-4"><EmptyState compact icon={ShoppingCart} title="No sales orders yet" description="Figures appear once sales orders exist." /></Card>}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Orders created" value={qty(s.orders_created)} icon={ShoppingCart} accent="blue" kind="period" definition="Sales orders dated in the period, excluding draft and cancelled orders."
              onDrill={() => drill.open({ source: 'sales_orders', title: 'Sales orders in the period', ...period, warehouseId: filters.warehouseId })} />
            <MetricCard label="Total order value" value={inr(s.order_value)} icon={IndianRupee} accent="blue" kind="period"
              hint={s.unpriced_order_lines ? `${s.unpriced_order_lines} line(s) without a price snapshot not valued` : 'Ordered − cancelled quantity × price snapshot'}
              definition="(Ordered − cancelled) × the sales order line's price snapshot, before GST. Not invoiced value." />
            <MetricCard label="Dispatched value" value={inr(s.dispatched_value)} icon={Truck} accent="green" kind="period"
              hint={s.unpriced_dispatch_lines ? `${s.unpriced_dispatch_lines} dispatch line(s) without a price` : `${unitList(s.quantity_dispatched, 'quantity')} dispatched`}
              definition="Quantity on dispatches posted in the period × the order line price snapshot. Never assumed equal to invoiced value."
              onDrill={() => drill.open({ source: 'dispatches', title: 'Dispatches posted in the period', ...period, ...instants, warehouseId: filters.warehouseId })} />
            <MetricCard label="Completed dispatches" value={qty(s.dispatches_completed)} icon={CheckCircle2} accent="green" kind="period" hint={`${unitList(s.quantity_dispatched, 'quantity')} dispatched`}
              definition="Consignments whose dispatch was posted in the period (company time zone)." />
            <MetricCard label="Orders awaiting fulfilment" value={qty(s.orders_awaiting_fulfilment)} icon={Hourglass} accent="orange" kind="current"
              definition="Confirmed orders that still have quantity to dispatch (not on hold, cancelled or fulfilled)." />
            <MetricCard label="Orders with shortages" value={qty(s.orders_with_shortages)} icon={AlertTriangle} accent="red" kind="current"
              hint={<Link className="text-primary hover:underline" to="/analytics/fulfilment">Shortage report</Link>}
              definition="Open orders with a line whose unreserved remaining quantity exceeds the eligible stock available now." />
            <MetricCard label="Partially fulfilled orders" value={qty(s.partially_fulfilled)} icon={Package} accent="orange" kind="current" definition="Open orders with some, but not all, quantity dispatched." />
          </div>
          {sales.data && (
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <ChartCard title="Order value vs dispatched value" description="By month (order date vs dispatch date)" isEmpty={monthly.every((m) => !m.a && !m.b)}
                table={{ headers: ['Month', 'Order value', 'Dispatched value'], rows: monthly.map((m) => [m.label, inr(m.a), inr(m.b)]) }}>
                <PairedBarChart aName="Order value" bName="Dispatched value" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => inr(v)} data={monthly} />
              </ChartCard>
              {sales.data.invoices_available ? (
                <ChartCard title="Dispatched value vs invoiced value" description="By month; invoiced = taxable value of issued invoices" isEmpty={monthly.every((m) => !m.b && !m.c)}
                  table={{ headers: ['Month', 'Dispatched', 'Invoiced (taxable)'], rows: monthly.map((m) => [m.label, inr(m.b), inr(m.c)]) }}>
                  <PairedBarChart aName="Dispatched value" bName="Invoiced (taxable)" aColor={TONE_FILL.success} bColor={TONE_FILL.info} valueFormatter={(v) => inr(v)}
                    data={monthly.map((m) => ({ label: m.label, a: m.b, b: m.c ?? 0 }))} />
                </ChartCard>
              ) : <UnavailableCard title="Dispatched vs invoiced" reason="Your role does not include the billing_reports.read permission." />}
            </div>
          )}
        </section>
      )
    }
    if (key === 'billing') {
      const b = data.billing
      if (!isAvailable(b)) return <><SectionHeading id="ex-billing" title={SECTION_TITLE.billing} /><UnavailableCard title="Billing KPIs" reason={b.reason} /></>
      const monthly = (fin.data?.monthly ?? []).map((m) => ({ label: formatBucket(m.month, 'month'), a: Number(m.invoiced), b: Number(m.collected) }))
      const asOfToday = data.as_of === data.today
      return (
        <section aria-labelledby="ex-billing">
          {heading(`Issued invoices and recorded receipts in the period; balances as of ${formatDate(data.as_of)}. Drafts and cancelled invoices are excluded.`, { to: '/analytics/finance', label: 'Financial overview' })}
          {!b.has_records && <Card className="mb-4"><EmptyState compact icon={Receipt} title="No invoices issued yet" description="Billing figures appear once invoices are issued." /></Card>}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Invoices issued" value={qty(b.invoices_issued)} icon={FileText} accent="blue" kind="period" definition="Issued invoices dated in the period. Drafts, discarded and cancelled invoices are excluded."
              onDrill={() => drill.open({ source: 'invoices', title: 'Invoices issued in the period', ...period })} />
            <MetricCard label="Total invoiced value" value={inr(b.invoiced_total)} icon={Receipt} accent="blue" kind="period" hint={`Taxable ${inr(b.invoiced_taxable)} · credit notes ${inr(b.credit_notes_total)} · debit notes ${inr(b.debit_notes_total)}`}
              definition="Grand total (incl. GST) of issued invoices dated in the period. Credit and debit notes are shown separately, not netted." />
            <MetricCard label="Payments received" value={inr(b.payments_received)} icon={Wallet} accent="green" kind="period" hint={`${b.receipts_count} receipt(s) · not bank-verified`}
              definition="Receipts recorded with a receipt date in the period; reversed receipts excluded. Not derived from invoice values."
              onDrill={() => drill.open({ source: 'receipts', title: 'Receipts in the period', ...period })} />
            <MetricCard label="Outstanding receivables" value={inr(b.outstanding)} icon={HandCoins} accent="orange" kind="as-of"
              hint={`${b.open_invoices} open invoice(s)${b.customer_credits ? ` · customer credits ${inr(b.customer_credits)} not netted` : ''}`}
              definition="Issued invoice totals − issued credit notes + issued debit notes − active payment allocations, as of the reporting date." />
            <MetricCard label="Overdue receivables" value={inr(b.overdue)} icon={AlarmClock} accent="red" kind="as-of" hint={`${b.overdue_invoices} overdue invoice(s)`}
              definition="Outstanding balance of invoices whose due date had passed on the reporting date."
              onDrill={asOfToday ? () => drill.open({ source: 'invoices', title: 'Overdue invoices (today)', overdueOnly: true }) : undefined} />
            <MetricCard label="Partially paid invoices" value={qty(b.partially_paid)} icon={HandCoins} accent="orange" kind="as-of" definition="Open invoices with at least one active payment allocation." />
            <MetricCard label="Unallocated receipts" value={inr(b.unallocated_receipts)} icon={Wallet} accent="orange" kind="current" hint={`${b.unallocated_receipts_count} receipt(s)`}
              definition="Recorded receipt amounts not yet allocated to any invoice. They are not deducted from outstanding receivables." />
          </div>
          {fin.data && (
            <div className="mt-4">
              <ChartCard title="Issued invoices vs collections" description="By month: invoice date vs receipt date (two different events)" isEmpty={monthly.every((m) => !m.a && !m.b)}
                table={{ headers: ['Month', 'Invoiced', 'Collected'], rows: monthly.map((m) => [m.label, inr(m.a), inr(m.b)]) }}>
                <PairedBarChart aName="Invoiced" bName="Collected" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => inr(v)} data={monthly} />
              </ChartCard>
            </div>
          )}
        </section>
      )
    }
    if (key === 'inventory') {
      const i = data.inventory
      if (!isAvailable(i)) return <><SectionHeading id="ex-inventory" title={SECTION_TITLE.inventory} /><UnavailableCard title="Inventory KPIs" reason={i.reason} /></>
      const primary = [...i.units].sort((a, b) => Number(b.on_hand) - Number(a.on_hand))[0]
      const byWh = i.by_warehouse.filter((w) => w.unit === primary?.unit)
      const v = data.valuation
      return (
        <section aria-labelledby="ex-inventory">
          {heading('Current position from the stock ledger balances — not the position at the end of the selected period.', { to: '/analytics/inventory', label: 'Inventory analytics' })}
          {!i.has_records && <Card className="mb-4"><EmptyState compact icon={Boxes} title="No stock movements yet" description="Stock figures appear after opening stock or receipts are posted." /></Card>}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Active products" value={qty(i.active_products)} icon={Package} kind="current" hint={`${i.never_stocked_products} never stocked`} definition="Active, non-archived products in the selected category." />
            <MetricCard label="Physical stock on hand" value={unitList(i.units, 'on_hand')} icon={Boxes} accent="blue" kind="current" definition="All company-owned stock in every location, by unit of measure (units are never added together)."
              onDrill={() => drill.open({ source: 'stock', title: 'Current stock by lot and location', warehouseId: filters.warehouseId, categoryId: filters.categoryId })} />
            <MetricCard label="Reserved stock" value={unitList(i.units, 'reserved')} icon={Lock} accent="orange" kind="current" definition="Open reservations for orders and production. Reservations reduce available stock, not stock on hand." />
            <MetricCard label="Available stock" value={unitList(i.units, 'available')} icon={CheckCircle2} accent="green" kind="current"
              hint={`Not available: ${unitList(i.units, 'quarantine')} quarantine · ${unitList(i.units, 'rejected')} rejected · ${unitList(i.units, 'external')} at processors`}
              definition="On hand − reserved in storage locations only. Quarantined, rejected and external-processing stock is never available." />
            <MetricCard label="Low-stock products" value={qty(i.low_stock_products)} icon={AlertTriangle} accent="orange" kind="current" definition="Products with available stock at or below their reorder level (products without a reorder level are not counted)." />
            <MetricCard label="Out-of-stock products" value={qty(i.out_of_stock_products)} icon={PackageX} accent="red" kind="current" hint={`${i.fully_reserved_products} fully reserved`}
              definition="Products that have stock history but no stock in storage locations." />
            <MetricCard label="Stock shortages" value={qty(i.shortage_products)} icon={AlertTriangle} accent="red" kind="current"
              hint={`Short by ${unitList(i.shortage_units, 'quantity')}`} definition="Products whose open order demand not covered by reservations exceeds the eligible stock available now." />
            <MetricCard label="In-house stock" value={unitList(i.units, 'in_house')} icon={Factory} accent="blue" kind="current"
              hint={i.units.some((u) => Number(u.unknown)) ? `Unverified source: ${unitList(i.units, 'unknown')}` : 'On hand from lots recorded as in-house'}
              definition="Source recorded on each stock lot (not the product's default source)." />
            <MetricCard label="Outsourced stock" value={unitList(i.units, 'outsourced')} icon={Truck} accent="purple" kind="current"
              definition="On hand from lots recorded as outsourced. Material held at outside processors is reported separately and is never available." />
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <ChartCard title="Stock by warehouse" description={primary ? `On hand, ${primary.unit} (other units in the table)` : 'On hand'} isEmpty={!byWh.length}
              table={{ headers: ['Warehouse', 'Unit', 'On hand', 'Available'], rows: i.by_warehouse.map((w) => [w.warehouse_code, w.unit, qty(w.on_hand), qty(w.available)]) }}>
              <HorizontalBarChart seriesName={`On hand (${primary?.unit ?? ''})`} valueFormatter={(n) => qty(n)} data={byWh.map((w) => ({ label: w.warehouse_code, value: Number(w.on_hand) }))} />
            </ChartCard>
            <Card>
              <CardHeader><div><CardTitle>Stock valuation</CardTitle><CardDescription>Current position only</CardDescription></div></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {'method' in v ? (
                  v.available ? (<><p className="text-2xl font-semibold">{inr(v.value)}</p><p className="text-muted-foreground">{v.method}</p></>) : (
                    <><p className="font-medium">{v.lots ? 'Valuation unavailable — cost data required' : 'No stock on hand'}</p>
                      {v.lots > 0 && <p className="text-muted-foreground">{v.costed_lots} of {v.lots} lots on hand have a receipt cost; {unitList(v.uncosted, 'quantity')} has none. Record receipt costs to value stock. Selling prices are never used.</p>}</>)
                ) : <p className="text-muted-foreground">{v.reason}</p>}
              </CardContent>
            </Card>
          </div>
        </section>
      )
    }
    const p = data.production
    if (!isAvailable(p)) return <><SectionHeading id="ex-production" title={SECTION_TITLE.production} /><UnavailableCard title="Production KPIs" reason={p.reason} /></>
    const os = p.outsourcing
    return (
      <section aria-labelledby="ex-production">
        {heading('Production orders and recorded output. Planned quantities are never counted as output.', { to: '/analytics/production', label: 'Production analytics' })}
        {!p.has_records && <Card className="mb-4"><EmptyState compact icon={Factory} title="No production or outsourcing orders yet" description="Figures appear once orders exist." /></Card>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Production orders created" value={qty(p.orders_created)} icon={ClipboardList} accent="blue" kind="period" definition="Orders created in the period (any status)." />
          <MetricCard label="Orders in progress" value={qty(p.orders_in_progress)} icon={Factory} accent="blue" kind="current" definition="Orders in production or partially completed." />
          <MetricCard label="Orders completed" value={qty(p.orders_completed)} icon={CheckCircle2} accent="green" kind="period" definition="Orders completed with a completion date in the period." />
          <MetricCard label="Completion rate" value={p.completion_rate === null ? null : pct(p.completion_rate)} icon={Gauge} accent="green" kind="period"
            unavailableReason="No orders were due in the period." hint={`${p.orders_due_completed} of ${p.orders_due} order(s) due in the period completed`}
            definition="Orders due (target date) in the period that are completed ÷ all approved orders due in the period." />
          <MetricCard label="Planned vs good output" value={p.planned_vs_actual.length ? p.planned_vs_actual.map((u) => `${qty(u.good)} / ${qty(u.planned)} ${u.unit}`).join(' · ') : '0'} icon={Factory} accent="blue" kind="period"
            definition="For orders due in the period: good quantity received so far vs planned quantity." />
          <MetricCard label="Rejected / scrap (period)" value={p.output_in_period.length ? p.output_in_period.map((u) => `${qty(Number(u.rejected) + Number(u.scrap))} ${u.unit}`).join(' · ') : '0'} icon={PackageX} accent="red" kind="period"
            definition="Rejected and scrap quantities on output receipts posted in the period." />
          <MetricCard label="Material shortages" value={qty(p.material_shortages)} icon={AlertTriangle} accent="red" kind="current" definition="Components whose outstanding requirement for open orders exceeds available stock." />
          <MetricCard label="Delayed orders" value={qty(p.delayed_orders)} icon={AlarmClock} accent="red" kind="as-of" definition="Open orders whose target completion date is before the reporting date." />
          {isAvailable(os) ? (
            <>
              <MetricCard label="Outsourcing in progress" value={qty(os.in_progress)} icon={Truck} accent="purple" kind="current" hint={`${os.overdue} past expected return date`}
                definition="Approved outsourcing orders not yet completed." />
              <MetricCard label="Outsourced goods awaiting receipt" value={unitList(os.awaiting_receipt, 'quantity')} icon={Warehouse} accent="purple" kind="current"
                definition="Ordered − received quantity on open outsourcing orders." />
            </>
          ) : <UnavailableCard title="Outsourcing" reason={os.reason} />}
        </div>
      </section>
    )
  }
}

function buildExport(d: ExecutiveData, can: Record<string, boolean> | null): ExportSection[] {
  const rows: (string | number | null)[][] = []
  const s = d.sales
  if (can?.sales && isAvailable(s)) {
    rows.push(['Sales', 'Orders created (period)', s.orders_created, ''], ['Sales', 'Total order value (period)', Number(s.order_value), d.currency],
      ['Sales', 'Unpriced order lines', s.unpriced_order_lines, ''], ['Sales', 'Dispatched value (period)', Number(s.dispatched_value), d.currency],
      ...s.quantity_dispatched.map((u) => ['Sales', 'Quantity dispatched (period)', Number(u.quantity), u.unit]),
      ['Sales', 'Completed dispatches (period)', s.dispatches_completed, ''], ['Sales', 'Orders awaiting fulfilment (current)', s.orders_awaiting_fulfilment, ''],
      ['Sales', 'Orders with shortages (current)', s.orders_with_shortages, ''], ['Sales', 'Partially fulfilled orders (current)', s.partially_fulfilled, ''])
  }
  const b = d.billing
  if (can?.billing && isAvailable(b)) {
    rows.push(['Billing', 'Invoices issued (period)', b.invoices_issued, ''], ['Billing', 'Total invoiced value (period)', Number(b.invoiced_total), d.currency],
      ['Billing', 'Credit notes (period)', Number(b.credit_notes_total), d.currency], ['Billing', 'Debit notes (period)', Number(b.debit_notes_total), d.currency],
      ['Billing', 'Payments received (period)', Number(b.payments_received), d.currency], ['Billing', `Outstanding receivables (as of ${d.as_of})`, Number(b.outstanding), d.currency],
      ['Billing', `Overdue receivables (as of ${d.as_of})`, Number(b.overdue), d.currency], ['Billing', 'Overdue invoices', b.overdue_invoices, ''],
      ['Billing', 'Partially paid invoices', b.partially_paid, ''], ['Billing', 'Unallocated receipts (current)', Number(b.unallocated_receipts), d.currency])
  }
  const i = d.inventory
  if (can?.inventory && isAvailable(i)) {
    rows.push(['Inventory', 'Active products (current)', i.active_products, ''])
    for (const u of i.units) {
      rows.push(['Inventory', 'On hand (current)', Number(u.on_hand), u.unit], ['Inventory', 'Reserved (current)', Number(u.reserved), u.unit],
        ['Inventory', 'Available (current)', Number(u.available), u.unit], ['Inventory', 'In-house on hand', Number(u.in_house), u.unit],
        ['Inventory', 'Outsourced on hand', Number(u.outsourced), u.unit])
    }
    rows.push(['Inventory', 'Low-stock products', i.low_stock_products, ''], ['Inventory', 'Out-of-stock products', i.out_of_stock_products, ''],
      ['Inventory', 'Products with shortages', i.shortage_products, ''])
    for (const w of i.by_warehouse) rows.push(['Inventory', `On hand ${w.warehouse_code}`, Number(w.on_hand), w.unit])
  }
  const p = d.production
  if (can?.production && isAvailable(p)) {
    rows.push(['Production', 'Orders created (period)', p.orders_created, ''], ['Production', 'Orders in progress (current)', p.orders_in_progress, ''],
      ['Production', 'Orders completed (period)', p.orders_completed, ''], ['Production', 'Completion rate %', p.completion_rate, ''],
      ...p.planned_vs_actual.flatMap((u) => [['Production', 'Planned (orders due)', Number(u.planned), u.unit], ['Production', 'Good output (orders due)', Number(u.good), u.unit]]),
      ['Production', 'Material shortages (current)', p.material_shortages, ''], ['Production', 'Delayed orders', p.delayed_orders, ''])
  }
  return [{ name: 'Executive KPIs', headers: ['Section', 'Metric', 'Value', 'Unit / currency'], rows }]
}
