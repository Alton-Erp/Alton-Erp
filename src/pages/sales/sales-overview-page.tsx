import { AlertTriangle, Boxes, CheckCircle2, ClipboardClock, Info, MapPinned, PackageCheck, PackageOpen, RefreshCw, ScanLine, ShoppingCart, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { TrendLineChart } from '@/components/charts/trend-line-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { ORDER_STATUS_LABELS, ORDER_STATUS_TONE, RETURN_REASON_LABELS } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, bucketForRange, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchCustomers } from '@/services/customer-po'
import { fetchSalesOverview } from '@/services/sales'
import type { DateRangeValue } from '@/types'

const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })

function FilterSelect({ id, label, value, onChange, options, width = 'w-48' }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][]; width?: string }) {
  return (
    <div className="space-y-1"><Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className={width}><SelectValue /></SelectTrigger>
        <SelectContent>{options.map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
      </Select></div>
  )
}

export default function SalesOverviewPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const customers = useAsync(() => (has('customers.read') || has('customer_po.read') ? fetchCustomers(true) : Promise.resolve([])), [])
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [customer, setCustomer] = useState('all')
  const [warehouse, setWarehouse] = useState('all')
  const [status, setStatus] = useState('all')
  const [dispatch, setDispatch] = useState('all')
  const [delivery, setDelivery] = useState('all')
  const [unit, setUnit] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const bucket = bucketForRange(range)
  const v = (x: string) => (x === 'all' ? null : x)
  const ov = useAsync(() => fetchSalesOverview({
    from: toIsoDate(range.from), to: toIsoDate(range.to), customerId: v(customer), warehouseId: v(warehouse), orderStatus: v(status),
    dispatchStatus: v(dispatch), deliveryStatus: v(delivery), bucket,
  }), [range, customer, warehouse, status, dispatch, delivery, refresh])
  const d = ov.data

  const units = useMemo(() => {
    const all = new Map<string, number>()
    for (const u of [...(d?.units_awaiting ?? []), ...(d?.units_dispatched ?? [])]) all.set(u.unit, (all.get(u.unit) ?? 0) + Number(u.quantity))
    for (const p of d?.ordered_vs_dispatched ?? []) all.set(p.unit, (all.get(p.unit) ?? 0) + Number(p.ordered))
    return [...all.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u)
  }, [d])
  const sel = unit && units.includes(unit) ? unit : (units[0] ?? null)
  const qtyFor = (list: { unit: string; quantity: number }[] | undefined) => Number(list?.find((x) => x.unit === sel)?.quantity ?? 0)
  const others = (list: { unit: string; quantity: number }[] | undefined) => {
    const o = (list ?? []).filter((x) => x.unit !== sel)
    return o.length ? `Also: ${o.map((x) => formatQty(Number(x.quantity), x.unit)).join(', ')}` : undefined
  }
  const label = (iso: string) => { const dt = new Date(`${iso}T00:00:00`); return bucket === 'month' ? MONTH.format(dt) : bucket === 'year' ? String(dt.getFullYear()) : DAY.format(dt) }
  const overTime = (d?.created_over_time ?? []).map((r) => ({ label: label(r.bucket), value: Number(r.count) }))
  const products = (d?.ordered_vs_dispatched ?? []).filter((p) => p.unit === sel)
  const pending = (d?.pending_by_warehouse ?? []).filter((p) => p.unit === sel).map((p) => ({ label: p.warehouse, value: Number(p.reserved) + Number(p.unallocated), unallocated: p.warehouse === 'Not allocated' }))
  const perf = d?.delivery_performance
  const perfBuckets = (perf?.by_bucket ?? []).map((b) => ({ label: label(b.bucket), a: Number(b.on_time), b: Number(b.late) }))
  const returns = (d?.returns_by_product_reason ?? []).filter((r) => r.unit === sel)

  const filters = (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
        <FilterSelect id="so-customer" label="Customer" value={customer} onChange={setCustomer} width="w-52"
          options={[['all', 'All customers'], ...(customers.data ?? []).map((c) => [c.id, `${c.customer_code} — ${c.customer_name}`] as [string, string])]} />
        <FilterSelect id="so-wh" label="Warehouse" value={warehouse} onChange={setWarehouse} width="w-40"
          options={[['all', 'All warehouses'], ...storage.warehouses.map((w) => [w.id, w.warehouse_code] as [string, string])]} />
        <FilterSelect id="so-status" label="Order status" value={status} onChange={setStatus} width="w-52" options={[['all', 'All statuses'], ...Object.entries(ORDER_STATUS_LABELS).filter(([k]) => k !== 'DRAFT')]} />
        <FilterSelect id="so-dispatch" label="Dispatch status" value={dispatch} onChange={setDispatch}
          options={[['all', 'Any'], ['NOT_DISPATCHED', 'Not dispatched'], ['PARTIALLY_DISPATCHED', 'Partially dispatched'], ['DISPATCHED', 'Fully dispatched']]} />
        <FilterSelect id="so-delivery" label="Delivery status" value={delivery} onChange={setDelivery}
          options={[['all', 'Any'], ['NOT_DELIVERED', 'Not delivered'], ['PARTIALLY_DELIVERED', 'Partially delivered'], ['DELIVERED', 'Delivered'], ['EXCEPTION', 'Delivery exception']]} />
      </CardContent>
    </Card>
  )
  const header = (
    <PageHeader actions={
      <>
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={ov.loading ? 'animate-spin' : undefined} /></Button>
        {has('sales_orders.create') && <Button asChild><Link to="/sales/orders">Sales orders</Link></Button>}
      </>
    } />
  )

  if (ov.loading && !d) return (<>{header}{filters}<LoadingState variant="cards" rows={8} /></>)
  if (ov.error || !d) return (<>{header}{filters}<Card><ErrorState message={describeDataError(ov.error)} onRetry={ov.reload} /></Card></>)

  return (
    <>
      {header}
      {filters}
      {!d.has_records && (
        <Card className="mb-6">
          <EmptyState icon={ShoppingCart} title="No sales orders yet" description="Convert a matched customer PO into a sales order (or create one manually) to start fulfilment. Nothing is created automatically."
            action={has('sales_orders.create') ? <Button asChild><Link to="/sales/orders">Create a sales order</Link></Button> : undefined} />
        </Card>
      )}
      <p className="mb-4 flex items-start gap-2 rounded-lg border bg-background px-4 py-2.5 text-sm">
        <Info className="mt-0.5 size-4 shrink-0" />
        Order counts cover sales orders dated in the period (and the filters). "Units dispatched" uses actual dispatch dates. Quantities are shown per unit of measure and are never revenue — billing is not part of this module. As of {formatDateTime(d.as_of, d.timezone)}.
      </p>
      <section aria-label="Sales KPIs" className="mb-6">
        {units.length > 1 && (
          <div role="group" aria-label="Unit" className="mb-3 inline-flex flex-wrap gap-1">
            {units.map((x) => (
              <button key={x} type="button" aria-pressed={x === sel} onClick={() => setUnit(x)}
                className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', x === sel ? 'border-primary bg-accent text-accent-foreground' : 'bg-background text-muted-foreground')}>{x}</button>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Total Sales Orders" value={formatNumber(d.total_orders)} hint="Created in the period" icon={ShoppingCart} />
          <KpiCard label="Orders Awaiting Confirmation" value={formatNumber(d.awaiting_confirmation)} hint="Created, not yet confirmed" icon={ClipboardClock} accent="pending" />
          <KpiCard label="Orders Ready for Picking" value={formatNumber(d.ready_for_picking)} hint="Reserved stock free to pick, or open pick lists" icon={ScanLine} accent="manufacturing" />
          <KpiCard label="Orders Being Packed" value={formatNumber(d.being_packed)} hint="Picked, packing in progress" icon={PackageOpen} accent="manufacturing" />
          <KpiCard label="Orders Ready for Dispatch" value={formatNumber(d.ready_for_dispatch)} hint="Packed and verified" icon={PackageCheck} accent="available" />
          <KpiCard label="Orders Dispatched" value={formatNumber(d.dispatched)} hint="At least one consignment dispatched" icon={Truck} accent="outsourced" />
          <KpiCard label="Orders In Transit" value={formatNumber(d.in_transit)} hint="Consignments dispatched, not delivered" icon={MapPinned} accent="outsourced" />
          <KpiCard label="Orders Delivered" value={formatNumber(d.delivered)} hint="Every unit delivered" icon={CheckCircle2} accent="available" />
          <KpiCard label="Orders Partially Fulfilled" value={formatNumber(d.partially_fulfilled)} hint="Some quantity still to dispatch" icon={Boxes} accent="pending" />
          <KpiCard label="Orders With Exceptions" value={formatNumber(d.with_exceptions)} hint={`Pick/pack exceptions, failed or overdue deliveries${d.overdue_deliveries ? ` · ${d.overdue_deliveries} overdue consignment(s)` : ''}`} icon={AlertTriangle} accent="shortage" />
          <KpiCard label="Units Awaiting Fulfilment" value={formatQty(qtyFor(d.units_awaiting))} unit={sel ?? undefined} hint={others(d.units_awaiting) ?? 'Ordered − cancelled − dispatched (open orders)'} icon={ClipboardClock} accent="pending" />
          <KpiCard label="Units Dispatched (period)" value={formatQty(qtyFor(d.units_dispatched))} unit={sel ?? undefined} hint={others(d.units_dispatched) ?? 'Posted stock issues by dispatch date'} icon={Truck} accent="outsourced" />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Orders by status" description="Sales orders in the period" isEmpty={d.by_status.length === 0} emptyMessage="No sales orders in this period." height={240}
          table={{ headers: ['Status', 'Orders'], rows: d.by_status.map((s) => [ORDER_STATUS_LABELS[s.status] ?? s.status, s.count]) }}>
          <HorizontalBarChart seriesName="Orders" labelWidth={170} data={d.by_status.map((s) => ({ label: ORDER_STATUS_LABELS[s.status] ?? s.status, value: Number(s.count), color: TONE_FILL[ORDER_STATUS_TONE[s.status] ?? 'neutral'] }))} />
        </ChartCard>
        <ChartCard title="Orders created over time" description={`Sales orders per ${bucket}`} isEmpty={overTime.length === 0} emptyMessage="No orders created in this period."
          table={{ headers: ['Period', 'Orders'], rows: overTime.map((p) => [p.label, p.value]) }}>
          <TrendLineChart data={overTime} seriesName="Orders created" />
        </ChartCard>
        <ChartCard title="Ordered vs dispatched" description={`Top products on these orders (${sel ?? '—'})`} isEmpty={products.length === 0} emptyMessage="No order lines."
          table={{ headers: ['Product', 'Ordered', 'Dispatched', 'Remaining'], rows: products.map((p) => [`${p.sku} — ${p.product_name}`, formatQty(Number(p.ordered)), formatQty(Number(p.dispatched)), formatQty(Number(p.remaining))]) }}>
          <PairedBarChart aName="Ordered" bName="Dispatched" valueFormatter={(x) => formatQty(x)} data={products.map((p) => ({ label: p.sku, a: Number(p.ordered), b: Number(p.dispatched) }))} />
        </ChartCard>
        <ChartCard title="Pending fulfilment by warehouse" description={`Reserved, not yet dispatched; unreserved demand shown as "Not allocated" (${sel ?? '—'})`} isEmpty={pending.length === 0} emptyMessage="Nothing pending."
          table={{ headers: ['Warehouse', 'Quantity'], rows: pending.map((p) => [p.label, formatQty(p.value)]) }}>
          <HorizontalBarChart seriesName="Pending" valueFormatter={(x) => formatQty(x)} data={pending.map((p) => ({ label: p.label, value: p.value, color: p.unallocated ? TONE_FILL.warning : TONE_FILL.info }))} />
        </ChartCard>
        <ChartCard title="Delivery performance" description={perf && perf.delivered > 0 ? `${perf.on_time} on time · ${perf.late} late${perf.average_days_late ? ` (avg ${perf.average_days_late} days)` : ''} · ${perf.no_expected_date} without an expected date` : 'Delivered consignments by delivery date'}
          isEmpty={perfBuckets.length === 0} emptyMessage="No deliveries recorded in this period (only consignments with an actual delivery date are counted)."
          table={{ headers: ['Period', 'On time', 'Late'], rows: perfBuckets.map((p) => [p.label, p.a, p.b]) }}>
          <PairedBarChart aName="On time" bName="Late" aColor={TONE_FILL.success} bColor={TONE_FILL.danger} stacked data={perfBuckets} />
        </ChartCard>
        <ChartCard title="Returns by product and reason" description={`Returned (or requested) quantity in the period (${sel ?? '—'})`} isEmpty={returns.length === 0} emptyMessage="No returns in this period."
          table={{ headers: ['Product', 'Reason', 'Quantity', 'Returns'], rows: returns.map((r) => [r.sku, RETURN_REASON_LABELS[r.reason_code] ?? r.reason_code, formatQty(Number(r.quantity)), r.returns]) }}>
          <HorizontalBarChart seriesName="Returned" labelWidth={190} valueFormatter={(x) => formatQty(x)}
            data={returns.map((r) => ({ label: `${r.sku} · ${RETURN_REASON_LABELS[r.reason_code] ?? r.reason_code}`, value: Number(r.quantity), color: TONE_FILL.warning }))} />
        </ChartCard>
      </div>
    </>
  )
}
