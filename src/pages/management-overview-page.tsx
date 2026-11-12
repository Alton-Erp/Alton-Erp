import {
  AlertTriangle, ArrowRight, Boxes, CheckCircle2, ClipboardList, Factory, HandCoins, IndianRupee, PackageCheck, RefreshCw, ShoppingCart, Truck,
  type LucideIcon,
} from 'lucide-react'
import { ArrowUpRight } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

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
import { bucketRange } from '@/features/drilldown/drill-registry'
import { useDrill, useUrlDateRange } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { DASHBOARD_DATE_RANGE_PRESETS } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchInventoryOverview, type InventoryOverview } from '@/services/inventory'
import { EXCL_GST_MISSING, EXCL_GST_NOTE, exclOk, fetchExclGst, reviewText, type ExclGstDashboard } from '@/services/gst-exclusive'
import { fetchManagementOverview, sectionOk, type ManagementOverview } from '@/services/management'

const SOURCE_COLORS = { manufactured: '#2563EB', outsourced: '#8B5CF6', unknown: '#9CA3AF' }
const SEVERITY_DOT: Record<string, string> = { CRITICAL: 'bg-red-500', WARNING: 'bg-amber-500', INFO: 'bg-blue-500' }

/** / — Management Dashboard (V2): the nine headline figures, charts for the period and the items that need attention. */
export default function ManagementOverviewPage() {
  const { has } = usePermissions()
  // Period kept in the address, so Back from a drill-down page keeps it.
  const [range, setRange] = useUrlDateRange('this_month')
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const canStock = has('inventory.read')
  const ov = useAsync(() => fetchManagementOverview(from, to), [from, to, refresh])
  // Every amount shown is GST-exclusive (migration 20261209090000); null before that update.
  const ex = useAsync(() => fetchExclGst('MANAGEMENT', from, to), [from, to, refresh])
  // Current stock with its source split (in-house = manufactured, outsourced); not period-bound.
  const stock = useAsync(() => (canStock ? fetchInventoryOverview() : Promise.resolve(null)), [canStock, refresh])

  const header = (
    <PageHeader title="Management Dashboard" description="Alton Hi-Tech Sanitary Ware Pvt. Ltd. — every figure comes from posted records in the ERP."
      actions={<>
        <DateRangeFilter value={range} onChange={setRange} presets={DASHBOARD_DATE_RANGE_PRESETS} />
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={ov.loading || stock.loading ? 'animate-spin' : undefined} /></Button>
      </>} />
  )
  if ((ov.loading && !ov.data) || (ex.loading && ex.data === undefined)) return (<>{header}<LoadingState variant="cards" rows={9} /></>)
  if (ov.error || !ov.data || ex.error) return (<>{header}<Card><ErrorState message={describeDataError(ov.error ?? ex.error)} onRetry={() => { ov.reload(); ex.reload() }} /></Card></>)
  return (
    <>
      {header}
      <Dashboard d={ov.data} ex={ex.data ?? null} stock={stock.data ?? null} stockError={canStock && stock.error ? describeDataError(stock.error) : canStock ? null : 'No inventory access.'} />
    </>
  )
}

function MetricCard({ label, value, hint, icon: Icon, to, tone = 'neutral', testId }: {
  label: string; value: string; hint?: ReactNode; icon: LucideIcon; to?: string | null; tone?: 'neutral' | 'blue' | 'violet' | 'green' | 'amber' | 'red'; testId?: string
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
      {to && <span className="inline-flex items-center gap-1 text-xs font-medium text-primary opacity-80 group-hover:opacity-100">View records <ArrowUpRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></span>}
    </div>
  )
  if (!to) return <Card className="gap-0 p-0" data-testid={testId}>{body}</Card>
  return (
    <Link to={to} data-testid={testId} data-drill="kpi" className="group block h-full rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label={`${label}: ${value} — view records`}>
      <Card className="h-full cursor-pointer gap-0 p-0 transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md motion-reduce:transform-none">{body}</Card>
    </Link>
  )
}

function Dashboard({ d, ex, stock, stockError }: { d: ManagementOverview; ex: ExclGstDashboard | null; stock: InventoryOverview | null; stockError: string | null }) {
  const { href } = useDrill('management')
  const navigate = useNavigate()
  const ctx = { from: d.from, to: d.to, today: d.today }
  const drill = (key: string, extra: Record<string, string | null | undefined> = {}) => href(key, { ...ctx, ...extra })
  const go = (to: string | null) => { if (to) navigate(to) }
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
  // Amounts excl. GST: sales orders at their taxable totals, invoices at taxable value, purchases at taxable value.
  const exSales = exclOk(ex?.sales) ? ex.sales : null
  const exPur = exclOk(ex?.purchase) ? ex.purchase : null
  const exBill = exclOk(ex?.invoicing) ? ex.invoicing : null
  const amt = (v: number | null | undefined) => (ex && v !== null && v !== undefined ? money(v) : '—')
  const salesSeries = sectionOk(sales) && exSales ? bucketSeries(exSales.daily, ['value', 'orders'] as const, d.from, d.to, bucket) : []
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
  // Chart drill-down: a period bucket (clipped to the period, as counted) or a month (whole month, as counted).
  const period = { from: d.from, to: d.to }
  const salesHref = (start?: string) => (start ? drill('sales.booked_period', bucketRange(start, bucket, period)) : null)
  const prodHref = (start?: string) => (start ? drill('production.output', { unit: prodUnit, ...bucketRange(start, bucket, period) }) : null)
  const moveHref = (start?: string) => (start ? drill('inventory.movements', { unit: moveUnit, ...bucketRange(start, bucket, period) }) : null)
  const SOURCE_KEY: Record<string, string> = { Manufactured: 'inventory.in_house', Outsourced: 'inventory.outsourced', 'Source not recorded': 'inventory.unknown' }
  const donutHref = (label?: string) => (label && donutUnit ? drill(SOURCE_KEY[label], { unit: donutUnit.unit }) : null)
  const billHref = (month: string | undefined, series: 'a' | 'b') => (month ? drill(series === 'a' ? 'billing.month_invoiced' : 'billing.month_received', bucketRange(month, 'month')) : null)
  const purHref = (month: string | undefined, series: 'a' | 'b') => (month ? drill(series === 'a' ? 'purchase.month' : 'grn.month_received', bucketRange(month, 'month')) : null)
  const hint = 'Click a point or bar to open the records.'
  const unknownText = sourceText(split, 'unknown', '')

  return (
    <>
      <p className="mb-4 text-xs text-muted-foreground">
        <span data-testid="gst-basis">{EXCL_GST_NOTE}</span> Period {formatDate(d.from)} – {formatDate(d.to)} · as of {formatDateTime(d.generated_at)}.
      </p>
      {!ex && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900" data-testid="gst-missing">{EXCL_GST_MISSING}</p>}

      <section aria-label="Key figures" className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard testId="kpi-total-stock" label="Total stock" icon={Boxes} to={stockError ? null : drill('inventory.on_hand')}
          value={stockError ? '—' : sourceText(split, 'total')}
          hint={stockError ?? (k.inventory_value === null ? 'Physical stock on hand' : `Physical stock on hand · Stock Value (Excl. GST) ${money(k.inventory_value)}`)} />
        <MetricCard testId="kpi-manufactured-stock" label="Manufactured stock" icon={Factory} tone="blue" to={stockError ? null : drill('inventory.in_house')}
          value={stockError ? '—' : sourceText(split, 'manufactured')} hint={stockError ?? 'Stock lots made in-house'} />
        <MetricCard testId="kpi-outsourced-stock" label="Outsourced stock" icon={Truck} tone="violet" to={stockError ? null : drill('inventory.outsourced')}
          value={stockError ? '—' : sourceText(split, 'outsourced')}
          hint={stockError ?? (unknownText ? `From outsourcing partners · ${unknownText} with no source recorded` : 'Stock lots from outsourcing partners')} />
        <MetricCard testId="kpi-purchase-orders" label="Purchase orders" icon={ClipboardList} to={sectionOk(pur) ? drill('purchase.created') : null}
          value={sectionOk(pur) ? formatNumber(pur.created) : '—'}
          hint={sectionOk(pur) ? `Raised in the period · Taxable Purchases ${amt(exPur?.period_value)} · ${formatNumber(pur.open)} open` : noAccess(pur)} />
        <MetricCard testId="kpi-pending-grns" label="Pending GRNs" icon={PackageCheck} tone="amber" to={sectionOk(pur) ? drill('purchase.open') : null}
          value={sectionOk(pur) ? formatNumber(pur.open) : '—'}
          hint={sectionOk(pur) ? `POs awaiting goods · ${amt(exPur?.outstanding_receipt_value)} still to receive (excl. GST)${pur.overdue ? ` · ${formatNumber(pur.overdue)} overdue` : ''}` : noAccess(pur)} />
        <MetricCard testId="kpi-production-orders" label="Production orders" icon={Factory} to={sectionOk(prod) ? drill('production.orders') : null}
          value={sectionOk(prod) ? formatNumber(prod.orders) : '—'}
          hint={sectionOk(prod) ? `Planned to start in the period · ${formatNumber(prod.open_orders)} open · ${formatNumber(prod.orders_completed)} completed` : noAccess(prod)} />
        <MetricCard testId="kpi-sales-orders" label="Sales orders" icon={ShoppingCart} to={sectionOk(sales) ? drill('sales.booked') : null}
          // sales_dashboard counts cancelled orders in total_orders; they are left out here, and the value is the
          // overview's order value (drafts and cancelled excluded), the same basis as the "Sales orders booked" chart.
          value={sectionOk(sales) ? formatNumber(Math.max(Number(sales.total_orders) - Number(sales.cancelled ?? 0), 0)) : '—'}
          hint={sectionOk(sales) ? `Booked in the period, excluding cancelled · order value ${amt(exSales?.order_value)} (excl. GST)` : noAccess(sales)} />
        <MetricCard testId="kpi-invoiced-sales" label="Taxable Sales" icon={IndianRupee} tone="green" to={drill('billing.issued_period')}
          value={amt(ex?.sales_invoiced)} hint={`${formatNumber(k.invoices)} invoice(s) issued in the period · taxable value, GST excluded`} />
        <MetricCard testId="kpi-outstanding" label="Outstanding Receivables (Excl. GST)" icon={HandCoins} tone="red" to={drill('billing.outstanding_all')}
          value={amt(ex?.receivables?.outstanding_excl_gst)}
          hint={ex ? <>
            <span className="block">Due from customers on issued invoices · Outstanding Payables (Excl. GST) {money(ex.payables?.outstanding_excl_gst ?? 0)}</span>
            {[reviewText(ex.receivables ? { count: ex.receivables.review_count, balance: ex.receivables.review_balance } : null, 'part-paid invoice(s)', money),
              reviewText(ex.payables ? { count: ex.payables.review_count, balance: ex.payables.review_balance } : null, 'supplier balance(s) with payments', money)]
              .filter((t): t is string => Boolean(t)).map((t) => <span key={t} className="mt-1 block text-amber-800" data-testid="kpi-outstanding-review">{t}</span>)}
          </> : EXCL_GST_MISSING} />
      </section>

      <section aria-label="Charts" className="mb-6 grid gap-4 xl:grid-cols-2">
        <ChartCard title="Sales orders booked" description={`Order value excl. GST ${per} in the period`} isEmpty={!sectionOk(sales) || salesSeries.every((p) => !p.value)}
          emptyMessage={!sectionOk(sales) ? `Not shown: ${noAccess(sales)}` : !exSales ? EXCL_GST_MISSING : 'No sales orders in this period.'}
          table={{ headers: ['Period', 'Orders', 'Value (excl. GST)'], rows: salesSeries.map((p) => [p.label, p.orders, money(p.value)]), links: salesSeries.map((p) => salesHref(p.start)) }}
          drillHint={salesHref(salesSeries[0]?.start) ? hint : undefined}>
          <TrendLineChart seriesName="Order value (excl. GST)" valueFormatter={(v) => money(v)} data={salesSeries.map((p) => ({ label: p.label, value: p.value }))}
            onSelect={salesHref(salesSeries[0]?.start) ? (i) => go(salesHref(salesSeries[i]?.start)) : undefined} />
        </ChartCard>
        <ChartCard title="Production output" description={`Good vs rejected / scrap ${per}${prodUnit ? ` (${prodUnit})` : ''}`} isEmpty={!sectionOk(prod) || prodSeries.every((p) => !p.good && !p.rejected)}
          emptyMessage={sectionOk(prod) ? 'No production recorded in this period.' : `Not shown: ${noAccess(prod)}`}
          table={{ headers: ['Period', 'Good', 'Rejected / scrap'], rows: prodSeries.map((p) => [p.label, p.good, p.rejected]), links: prodSeries.map((p) => prodHref(p.start)) }}
          drillHint={prodHref(prodSeries[0]?.start) ? hint : undefined}>
          <PairedBarChart aName="Good" bName="Rejected / scrap" aColor={TONE_FILL.success} bColor={TONE_FILL.danger} data={prodSeries.map((p) => ({ label: p.label, a: p.good, b: p.rejected }))}
            onSelect={prodHref(prodSeries[0]?.start) ? (i) => go(prodHref(prodSeries[i]?.start)) : undefined} />
        </ChartCard>
        <ChartCard title="Stock movement" description={`Received vs issued ${per}${moveUnit ? ` (${moveUnit})` : ''}; transfers excluded`} isEmpty={!sectionOk(inv) || moveSeries.every((p) => !p.in && !p.out)}
          emptyMessage={sectionOk(inv) ? 'No stock movements in this period.' : `Not shown: ${noAccess(inv)}`}
          table={{ headers: ['Period', 'In', 'Out'], rows: moveSeries.map((p) => [p.label, p.in, p.out]), links: moveSeries.map((p) => moveHref(p.start)) }}
          drillHint={moveHref(moveSeries[0]?.start) ? hint : undefined}>
          <InventoryMovementChart data={moveSeries.map((p) => ({ label: p.label, inward: p.in, outward: p.out }))}
            onSelect={moveHref(moveSeries[0]?.start) ? (i) => go(moveHref(moveSeries[i]?.start)) : undefined} />
        </ChartCard>
        <ChartCard title="Stock by source" description={donutUnit ? `Manufactured vs outsourced stock on hand now (${donutUnit.unit}; other units in the table view)` : 'Manufactured vs outsourced stock on hand now'}
          isEmpty={Boolean(stockError) || donut.length === 0} emptyMessage={stockError ? `Not shown: ${stockError}` : 'No stock on hand.'}
          table={{ headers: ['Unit', 'Total', 'Manufactured', 'Outsourced', 'Source not recorded'], rows: split.map((r) => [r.unit, r.total, r.manufactured, r.outsourced, r.unknown]) }}>
          <DonutChart seriesName={donutUnit?.unit ?? 'Stock'} valueFormatter={(v) => `${formatNumber(v)} ${donutUnit?.unit ?? ''}`} data={donut}
            onSelect={donutHref(donut[0]?.label) ? (i) => go(donutHref(donut[i]?.label)) : undefined} />
        </ChartCard>
        <ChartCard title="Taxable sales invoiced" description={`Taxable value and GST of issued invoices per month, the 12 months to ${formatDate(d.to)}`}
          isEmpty={!sectionOk(bill) || !exBill || exBill.monthly.every((x) => !Number(x.taxable) && !Number(x.gst))}
          emptyMessage={!sectionOk(bill) ? `Not shown: ${noAccess(bill)}` : !exBill ? EXCL_GST_MISSING : 'No invoices yet.'}
          table={{ headers: ['Month', 'Taxable sales', 'GST (shown separately)', 'Received (incl. GST; receipts are not split)'],
            rows: exBill ? exBill.monthly.map((x) => [bucketLabel(x.month, 'month'), money(x.taxable), money(x.gst), money(x.received)]) : [],
            links: exBill ? exBill.monthly.map((x) => billHref(x.month, 'a')) : [] }}
          drillHint={exBill && billHref(exBill.monthly[0]?.month, 'a') ? hint : undefined}>
          <PairedBarChart aName="Taxable sales" bName="GST" stacked aColor={TONE_FILL.info} bColor={TONE_FILL.neutral} valueFormatter={(v) => money(v)}
            data={exBill ? exBill.monthly.map((x) => ({ label: bucketLabel(x.month, 'month'), a: Number(x.taxable), b: Number(x.gst) })) : []}
            onSelect={exBill ? (i) => go(billHref(exBill.monthly[i]?.month, 'a')) : undefined} />
        </ChartCard>
        <ChartCard title="Purchases ordered vs received" description={`Taxable value (excl. GST) per month, the 12 months to ${formatDate(d.to)}`}
          isEmpty={!sectionOk(pur) || !exPur || exPur.monthly.every((x) => !Number(x.ordered) && !Number(x.received))}
          emptyMessage={!sectionOk(pur) ? `Not shown: ${noAccess(pur)}` : !exPur ? EXCL_GST_MISSING : 'No purchases yet.'}
          table={{ headers: ['Month', 'Ordered (excl. GST)', 'Received (excl. GST)'], rows: exPur ? exPur.monthly.map((x) => [bucketLabel(x.month, 'month'), money(x.ordered), money(x.received)]) : [],
            links: exPur ? exPur.monthly.map((x) => purHref(x.month, 'a')) : [] }}
          drillHint={exPur && purHref(exPur.monthly[0]?.month, 'a') ? hint : undefined}>
          <PairedBarChart aName="Ordered" bName="Received" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => money(v)}
            data={exPur ? exPur.monthly.map((x) => ({ label: bucketLabel(x.month, 'month'), a: Number(x.ordered), b: Number(x.received) })) : []}
            onSelect={exPur ? (i, s) => go(purHref(exPur.monthly[i]?.month, s)) : undefined} />
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
        <ListCard title="Customer balances" description="Largest open invoice balances, excl. GST" link={{ to: '/billing/ageing', label: 'Ageing' }}>
          {!sectionOk(bill) ? <p className="py-2 text-sm text-muted-foreground">Not shown: {noAccess(bill)}</p> : bill.customer_outstanding.length === 0 ? <p className="py-2 text-sm text-muted-foreground">Nothing outstanding.</p> : (
            <table className="w-full text-sm" aria-label="Customer balances"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left font-medium">Customer</th><th className="pb-1 text-right font-medium">Outstanding (excl. GST)</th><th className="pb-1 text-right font-medium">Overdue (excl. GST)</th></tr></thead>
              <tbody>{bill.customer_outstanding.map((c) => {
                const x = ex?.customer_outstanding?.find((r) => r.party_id === c.party_id)
                return (
                  <tr key={c.party_id} className="border-t" data-testid={`customer-balance-${c.party_id}`}><td className="max-w-0 truncate py-1.5"><Link className="text-primary hover:underline" to={`/ledger/${c.party_id}`}>{c.customer}</Link>
                    {x && x.review_invoices > 0 && <span className="block text-[11px] text-amber-800" title="Payments are not split into taxable value and GST, so these invoices are left out of the GST-exclusive figures.">
                      + {x.review_invoices} part-paid invoice(s), {money(x.review_balance)} incl. GST, to review</span>}</td>
                    <td className="py-1.5 text-right align-top tabular-nums">{x ? money(x.outstanding_excl_gst) : '—'}</td>
                    <td className={cn('py-1.5 text-right align-top tabular-nums', Number(x?.overdue_excl_gst) > 0 && 'text-red-700')}>{x ? money(x.overdue_excl_gst) : '—'}</td></tr>
                )
              })}</tbody></table>
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
