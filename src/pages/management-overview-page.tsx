import {
  AlertTriangle, ArrowRight, Boxes, CheckCircle2, ClipboardList, Factory, HandCoins, IndianRupee, PackageCheck, RefreshCw, ShoppingCart, Truck,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { DonutChart } from '@/components/charts/donut-chart'
import { InventoryMovementChart } from '@/components/charts/inventory-movement-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { TrendLineChart } from '@/components/charts/trend-line-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { money } from '@/features/billing/billing-model'
import { bucketLabel, bucketSeries, chartBucket, mainUnit, sourceText, stockBySource, type StockBySource } from '@/features/management/dashboard-model'
import { useAsync } from '@/hooks/use-async'
import { DASHBOARD_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchInventoryOverview, type InventoryOverview } from '@/services/inventory'
import { fetchManagementOverview, sectionOk, type ManagementOverview } from '@/services/management'
import type { DateRangeValue } from '@/types'

const SOURCE_COLORS = { manufactured: '#2563EB', outsourced: '#8B5CF6', unknown: '#9CA3AF' }
const SEVERITY_DOT: Record<string, string> = { CRITICAL: 'bg-red-500', WARNING: 'bg-amber-500', INFO: 'bg-blue-500' }

/** / — Management Dashboard (V2): the nine headline figures, charts for the period and the items that need attention. */
export default function ManagementOverviewPage() {
  const { has } = usePermissions()
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const canStock = has('inventory.read')
  const ov = useAsync(() => fetchManagementOverview(from, to), [from, to, refresh])
  // Current stock with its source split (in-house = manufactured, outsourced); not period-bound.
  const stock = useAsync(() => (canStock ? fetchInventoryOverview() : Promise.resolve(null)), [canStock, refresh])

  const header = (
    <PageHeader title="Management Dashboard" description="Alton Hi-Tech Sanitary Ware Pvt. Ltd. — every figure comes from posted records in the ERP."
      actions={<>
        <DateRangeFilter value={range} onChange={setRange} presets={DASHBOARD_DATE_RANGE_PRESETS} />
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={ov.loading || stock.loading ? 'animate-spin' : undefined} /></Button>
      </>} />
  )
  if (ov.loading && !ov.data) return (<>{header}<LoadingState variant="cards" rows={9} /></>)
  if (ov.error || !ov.data) return (<>{header}<Card><ErrorState message={describeDataError(ov.error)} onRetry={ov.reload} /></Card></>)
  return (
    <>
      {header}
      <Dashboard d={ov.data} stock={stock.data ?? null} stockError={canStock && stock.error ? describeDataError(stock.error) : canStock ? null : 'No inventory access.'} />
    </>
  )
}

function MetricCard({ label, value, hint, icon: Icon, to, tone = 'neutral', testId }: {
  label: string; value: string; hint?: ReactNode; icon: LucideIcon; to?: string; tone?: 'neutral' | 'blue' | 'violet' | 'green' | 'amber' | 'red'; testId?: string
}) {
  const toneClass = { neutral: 'bg-gray-100 text-gray-600', blue: 'bg-blue-50 text-blue-600', violet: 'bg-violet-50 text-violet-600', green: 'bg-green-50 text-green-700', amber: 'bg-amber-50 text-amber-700', red: 'bg-red-50 text-red-600' }[tone]
  const body = (
    <div className="flex h-full flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium text-muted-foreground">{label}</p>
        <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-md', toneClass)}><Icon aria-hidden className="size-4" /></span>
      </div>
      <p className="text-xl font-semibold tracking-tight break-words text-foreground tabular-nums">{value}</p>
      {hint && <p className="mt-auto text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
  return (
    <Card className="gap-0 p-0 transition-colors hover:border-primary/40" data-testid={testId}>
      {to ? <Link to={to} className="h-full rounded-xl focus-visible:outline-2 focus-visible:outline-ring" aria-label={`${label}: ${value}`}>{body}</Link> : body}
    </Card>
  )
}

function Dashboard({ d, stock, stockError }: { d: ManagementOverview; stock: InventoryOverview | null; stockError: string | null }) {
  const k = d.kpis
  const inv = d.inventory
  const pur = d.purchase
  const prod = d.production
  const sales = d.sales
  const bill = d.invoicing
  const noAccess = (s: { available: boolean; reason?: string }) => ('reason' in s && s.reason) || 'Not available'
  const split: StockBySource[] = stockBySource(stock?.units)
  const bucket = chartBucket(d.from, d.to)
  const per = bucket === 'day' ? 'per day' : bucket === 'week' ? 'per week' : 'per month'

  // Charts follow the period; quantities are shown one unit at a time.
  const salesSeries = sectionOk(sales) ? bucketSeries(sales.daily, ['value', 'orders'] as const, d.from, d.to, bucket) : []
  const prodUnit = sectionOk(prod) ? mainUnit(prod.daily.map((r) => ({ unit: r.unit, quantity: Number(r.good) + Number(r.rejected) }))) : null
  const prodSeries = sectionOk(prod) ? bucketSeries(prod.daily.filter((r) => r.unit === prodUnit), ['good', 'rejected'] as const, d.from, d.to, bucket) : []
  const moveUnit = sectionOk(inv) ? mainUnit(inv.movement.map((r) => ({ unit: r.unit, quantity: Number(r.in ?? 0) + Number(r.out ?? 0) }))) : null
  const moveSeries = sectionOk(inv) ? bucketSeries(inv.movement.filter((r) => r.unit === moveUnit), ['in', 'out'] as const, d.from, d.to, bucket) : []
  const donutUnit = split[0] ?? null
  const donut = donutUnit ? [
    { label: 'Manufactured', value: donutUnit.manufactured, color: SOURCE_COLORS.manufactured },
    { label: 'Outsourced', value: donutUnit.outsourced, color: SOURCE_COLORS.outsourced },
    { label: 'Source not recorded', value: donutUnit.unknown, color: SOURCE_COLORS.unknown },
  ].filter((x) => x.value > 0) : []
  const alerts = d.alerts.filter((a) => a.count > 0)
  const unknownText = sourceText(split, 'unknown', '')

  return (
    <>
      <p className="mb-4 text-xs text-muted-foreground">
        Period {formatDate(d.from)} – {formatDate(d.to)} · stock and outstanding balances are as of now ({formatDateTime(d.generated_at)}) · amounts in {d.currency}, including GST.
      </p>

      <section aria-label="Key figures" className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard testId="kpi-total-stock" label="Total stock" icon={Boxes} to="/inventory/stock"
          value={stockError ? '—' : sourceText(split, 'total')}
          hint={stockError ?? (k.inventory_value === null ? 'Physical stock on hand' : `Physical stock on hand · valued at ${money(k.inventory_value)}`)} />
        <MetricCard testId="kpi-manufactured-stock" label="Manufactured stock" icon={Factory} tone="blue" to="/inventory/stock"
          value={stockError ? '—' : sourceText(split, 'manufactured')} hint={stockError ?? 'Stock lots made in-house'} />
        <MetricCard testId="kpi-outsourced-stock" label="Outsourced stock" icon={Truck} tone="violet" to="/inventory/stock"
          value={stockError ? '—' : sourceText(split, 'outsourced')}
          hint={stockError ?? (unknownText ? `From outsourcing partners · ${unknownText} with no source recorded` : 'Stock lots from outsourcing partners')} />
        <MetricCard testId="kpi-purchase-orders" label="Purchase orders" icon={ClipboardList} to="/purchase-orders"
          value={sectionOk(pur) ? formatNumber(pur.created) : '—'}
          hint={sectionOk(pur) ? `Raised in the period · ${money(pur.period_value)} placed · ${formatNumber(pur.open)} open` : noAccess(pur)} />
        <MetricCard testId="kpi-pending-grns" label="Pending GRNs" icon={PackageCheck} tone="amber" to="/goods-receipts/dashboard"
          value={sectionOk(pur) ? formatNumber(pur.open) : '—'}
          hint={sectionOk(pur) ? `POs awaiting goods · ${money(pur.outstanding_receipt_value)} still to receive${pur.overdue ? ` · ${formatNumber(pur.overdue)} overdue` : ''}` : noAccess(pur)} />
        <MetricCard testId="kpi-production-orders" label="Production orders" icon={Factory} to="/production/orders"
          value={sectionOk(prod) ? formatNumber(prod.orders) : '—'}
          hint={sectionOk(prod) ? `Planned to start in the period · ${formatNumber(prod.open_orders)} open · ${formatNumber(prod.orders_completed)} completed` : noAccess(prod)} />
        <MetricCard testId="kpi-sales-orders" label="Sales orders" icon={ShoppingCart} to="/sales/orders"
          // sales_dashboard counts cancelled orders in total_orders; they are left out here, and the value is the
          // overview's order value (drafts and cancelled excluded), the same basis as the "Sales orders booked" chart.
          value={sectionOk(sales) ? formatNumber(Math.max(Number(sales.total_orders) - Number(sales.cancelled ?? 0), 0)) : '—'}
          hint={sectionOk(sales) ? `Booked in the period, excluding cancelled · order value ${money(k.sales_order_value)}` : noAccess(sales)} />
        <MetricCard testId="kpi-invoiced-sales" label="Invoiced sales" icon={IndianRupee} tone="green" to="/billing/register"
          value={money(k.sales_invoiced)} hint={`${formatNumber(k.invoices)} invoice(s) issued in the period · ${money(k.receipts)} received`} />
        <MetricCard testId="kpi-outstanding" label="Outstanding payments" icon={HandCoins} tone="red" to="/billing/receivables"
          value={money(k.customer_outstanding)} hint={`Due from customers on issued invoices · ${money(k.supplier_outstanding)} due to suppliers`} />
      </section>

      <section aria-label="Charts" className="mb-6 grid gap-4 xl:grid-cols-2">
        <ChartCard title="Sales orders booked" description={`Order value ${per} in the period`} isEmpty={!sectionOk(sales) || salesSeries.every((p) => !p.value)}
          emptyMessage={sectionOk(sales) ? 'No sales orders in this period.' : `Not shown: ${noAccess(sales)}`}
          table={{ headers: ['Period', 'Orders', 'Value'], rows: salesSeries.map((p) => [p.label, p.orders, money(p.value)]) }}>
          <TrendLineChart seriesName="Order value" valueFormatter={(v) => money(v)} data={salesSeries.map((p) => ({ label: p.label, value: p.value }))} />
        </ChartCard>
        <ChartCard title="Production output" description={`Good vs rejected / scrap ${per}${prodUnit ? ` (${prodUnit})` : ''}`} isEmpty={!sectionOk(prod) || prodSeries.every((p) => !p.good && !p.rejected)}
          emptyMessage={sectionOk(prod) ? 'No production recorded in this period.' : `Not shown: ${noAccess(prod)}`}
          table={{ headers: ['Period', 'Good', 'Rejected / scrap'], rows: prodSeries.map((p) => [p.label, p.good, p.rejected]) }}>
          <PairedBarChart aName="Good" bName="Rejected / scrap" aColor={TONE_FILL.success} bColor={TONE_FILL.danger} data={prodSeries.map((p) => ({ label: p.label, a: p.good, b: p.rejected }))} />
        </ChartCard>
        <ChartCard title="Stock movement" description={`Received vs issued ${per}${moveUnit ? ` (${moveUnit})` : ''}; transfers excluded`} isEmpty={!sectionOk(inv) || moveSeries.every((p) => !p.in && !p.out)}
          emptyMessage={sectionOk(inv) ? 'No stock movements in this period.' : `Not shown: ${noAccess(inv)}`}
          table={{ headers: ['Period', 'In', 'Out'], rows: moveSeries.map((p) => [p.label, p.in, p.out]) }}>
          <InventoryMovementChart data={moveSeries.map((p) => ({ label: p.label, inward: p.in, outward: p.out }))} />
        </ChartCard>
        <ChartCard title="Stock by source" description={donutUnit ? `Manufactured vs outsourced stock on hand now (${donutUnit.unit}; other units in the table view)` : 'Manufactured vs outsourced stock on hand now'}
          isEmpty={Boolean(stockError) || donut.length === 0} emptyMessage={stockError ? `Not shown: ${stockError}` : 'No stock on hand.'}
          table={{ headers: ['Unit', 'Total', 'Manufactured', 'Outsourced', 'Source not recorded'], rows: split.map((r) => [r.unit, r.total, r.manufactured, r.outsourced, r.unknown]) }}>
          <DonutChart seriesName={donutUnit?.unit ?? 'Stock'} valueFormatter={(v) => `${formatNumber(v)} ${donutUnit?.unit ?? ''}`} data={donut} />
        </ChartCard>
        <ChartCard title="Invoiced vs collected" description={`Per month, the 12 months to ${formatDate(d.to)}`}
          isEmpty={!sectionOk(bill) || bill.monthly.every((x) => !Number(x.invoiced) && !Number(x.received))}
          emptyMessage={sectionOk(bill) ? 'No invoices or receipts yet.' : `Not shown: ${noAccess(bill)}`}
          table={{ headers: ['Month', 'Invoiced', 'Received'], rows: sectionOk(bill) ? bill.monthly.map((x) => [bucketLabel(x.month, 'month'), money(x.invoiced), money(x.received)]) : [] }}>
          <PairedBarChart aName="Invoiced" bName="Received" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => money(v)}
            data={sectionOk(bill) ? bill.monthly.map((x) => ({ label: bucketLabel(x.month, 'month'), a: Number(x.invoiced), b: Number(x.received) })) : []} />
        </ChartCard>
        <ChartCard title="Purchases ordered vs received" description={`Per month, the 12 months to ${formatDate(d.to)}`}
          isEmpty={!sectionOk(pur) || pur.monthly.every((x) => !Number(x.ordered) && !Number(x.received))}
          emptyMessage={sectionOk(pur) ? 'No purchases yet.' : `Not shown: ${noAccess(pur)}`}
          table={{ headers: ['Month', 'Ordered', 'Received'], rows: sectionOk(pur) ? pur.monthly.map((x) => [bucketLabel(x.month, 'month'), money(x.ordered), money(x.received)]) : [] }}>
          <PairedBarChart aName="Ordered" bName="Received" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => money(v)}
            data={sectionOk(pur) ? pur.monthly.map((x) => ({ label: bucketLabel(x.month, 'month'), a: Number(x.ordered), b: Number(x.received) })) : []} />
        </ChartCard>
      </section>

      <section aria-label="Lists" className="grid gap-4 xl:grid-cols-3">
        <ListCard title="Needs attention" description={alerts.length ? `${alerts.length} area(s); each opens the records` : 'Nothing needs attention'}>
          {alerts.length === 0 ? (
            <p className="flex items-center gap-2 py-2 text-sm text-green-800"><CheckCircle2 className="size-4" /> No low stock, shortages, overdue orders or overdue invoices.</p>
          ) : (
            <table className="w-full text-sm" aria-label="Needs attention"><tbody>{alerts.map((a) => (
              <tr key={a.code} className="border-t first:border-t-0" data-testid={`alert-${a.code}`}>
                <td className="py-1.5"><Link to={a.link} className="inline-flex items-center gap-2 hover:underline"><span aria-hidden className={cn('size-2 rounded-full', SEVERITY_DOT[a.severity])} />{a.title}</Link></td>
                <td className="py-1.5 text-right font-medium tabular-nums">{formatNumber(a.count)}</td>
              </tr>
            ))}</tbody></table>
          )}
        </ListCard>
        <ListCard title="Low stock" description="At or below reorder level, or out of stock" link={{ to: '/inventory/alerts', label: 'All alerts' }}>
          {!sectionOk(inv) ? <p className="py-2 text-sm text-muted-foreground">Not shown: {noAccess(inv)}</p> : inv.low_stock.length === 0 ? <p className="py-2 text-sm text-muted-foreground">No low-stock products.</p> : (
            <table className="w-full text-sm" aria-label="Low stock"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left font-medium">Product</th><th className="pb-1 text-right font-medium">Available / reorder</th></tr></thead>
              <tbody>{inv.low_stock.map((p) => (
                <tr key={p.product_id} className="border-t"><td className="max-w-0 truncate py-1.5"><Link className="text-primary hover:underline" to={`/inventory/stock/${p.product_id}`}>{p.sku} — {p.product_name}</Link></td>
                  <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{formatNumber(Number(p.available))} {p.unit}{p.reorder_level !== null ? ` / ${formatNumber(Number(p.reorder_level))}` : ''}</td></tr>
              ))}</tbody></table>
          )}
        </ListCard>
        <ListCard title="Customer balances" description="Largest open invoice balances" link={{ to: '/billing/ageing', label: 'Ageing' }}>
          {!sectionOk(bill) ? <p className="py-2 text-sm text-muted-foreground">Not shown: {noAccess(bill)}</p> : bill.customer_outstanding.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Nothing outstanding.</p> : (
            <table className="w-full text-sm" aria-label="Customer balances"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left font-medium">Customer</th><th className="pb-1 text-right font-medium">Outstanding</th><th className="pb-1 text-right font-medium">Overdue</th></tr></thead>
              <tbody>{bill.customer_outstanding.map((c) => (
                <tr key={c.party_id} className="border-t"><td className="max-w-0 truncate py-1.5"><Link className="text-primary hover:underline" to={`/ledger/${c.party_id}`}>{c.customer}</Link></td>
                  <td className="py-1.5 text-right tabular-nums">{money(c.outstanding)}</td>
                  <td className={cn('py-1.5 text-right tabular-nums', Number(c.overdue) > 0 && 'text-red-700')}>{money(c.overdue)}</td></tr>
              ))}</tbody></table>
          )}
        </ListCard>
      </section>
      {sectionOk(inv) && inv.production_shortages > 0 && (
        <p className="mt-4 flex items-center gap-2 text-xs text-amber-800"><AlertTriangle className="size-3.5" /> {formatNumber(inv.production_shortages)} material(s) are short for open production orders. <Link className="underline" to="/production">Production dashboard</Link></p>
      )}
    </>
  )
}

function ListCard({ title, description, link, children }: { title: string; description?: string; link?: { to: string; label: string }; children: ReactNode }) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div><CardTitle className="text-sm">{title}</CardTitle>{description && <CardDescription className="text-xs">{description}</CardDescription>}</div>
        {link && <Button variant="ghost" size="sm" asChild><Link to={link.to}>{link.label} <ArrowRight /></Link></Button>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
