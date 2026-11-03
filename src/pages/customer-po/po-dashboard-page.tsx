import { AlertTriangle, CheckCircle2, ClipboardCheck, ClipboardList, Info, Lock, PackageCheck, PackageSearch, RefreshCw, ScanSearch, ShoppingCart, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
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
import { PO_STATUS_LABELS } from '@/features/customer-po/po-import'
import { formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, bucketForRange, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ProductOption } from '@/services/inventory'
import { fetchCustomerOptions, fetchPoDashboard } from '@/services/customer-po'
import type { DateRangeValue } from '@/types'

const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })
const STATUS_FILL: Record<string, string> = {
  UPLOADED: TONE_FILL.warning, VALIDATION_REQUIRED: TONE_FILL.warning, PRODUCT_MATCHING_REQUIRED: TONE_FILL.warning, READY_FOR_ALLOCATION: TONE_FILL.info,
  PARTIALLY_ALLOCATED: TONE_FILL.info, FULLY_ALLOCATED: TONE_FILL.success, PARTIALLY_FULFILLED: TONE_FILL.info, FULFILLED: TONE_FILL.success,
  ON_HOLD: TONE_FILL.warning, CANCELLED: TONE_FILL.neutral, DRAFT: TONE_FILL.neutral,
}

export default function PoDashboardPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const customers = useAsync(fetchCustomerOptions, [])
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [customer, setCustomer] = useState('all')
  const [status, setStatus] = useState('all')
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [warehouse, setWarehouse] = useState('all')
  const [unit, setUnit] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const bucket = bucketForRange(range)
  const dash = useAsync(() => fetchPoDashboard({
    from: toIsoDate(range.from), to: toIsoDate(range.to), customerKey: customer === 'all' ? null : customer, status: status === 'all' ? null : status,
    productId: product?.product_id ?? null, warehouseId: warehouse === 'all' ? null : warehouse, bucket,
  }), [range, customer, status, product?.product_id, warehouse, refresh])
  const d = dash.data
  const units = useMemo(() => [...(d?.units ?? [])].sort((a, b) => Number(b.ordered) - Number(a.ordered)), [d])
  const sel = unit && units.some((u) => u.unit === unit) ? unit : (units[0]?.unit ?? null)
  const u = units.find((x) => x.unit === sel)
  const others = (k: 'ordered' | 'available' | 'reserved_for_pos' | 'shortage') => {
    const o = units.filter((x) => x.unit !== sel)
    return o.length ? `Also: ${o.map((x) => formatQty(Number(x[k]), x.unit)).join(', ')}` : undefined
  }
  const label = (iso: string) => { const dt = new Date(`${iso}T00:00:00`); return bucket === 'month' ? MONTH.format(dt) : bucket === 'year' ? String(dt.getFullYear()) : DAY.format(dt) }
  const top = (d?.top_products ?? []).filter((p) => p.unit === sel)
  const cat = (d?.shortage_by_category ?? []).filter((c) => c.unit === sel)
  const overTime = (d?.received_over_time ?? []).map((r) => ({ label: label(r.bucket), value: Number(r.count) }))

  const filters = (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="pd-customer">Customer</Label>
          <Select value={customer} onValueChange={setCustomer}><SelectTrigger id="pd-customer" className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All customers</SelectItem>{(customers.data ?? []).map((c) => <SelectItem key={c.customer_key} value={c.customer_key}>{c.customer_name}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label htmlFor="pd-status">Status</Label>
          <Select value={status} onValueChange={setStatus}><SelectTrigger id="pd-status" className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(PO_STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
        <div className="w-64 space-y-1"><Label htmlFor="pd-product">Product</Label><ProductPicker id="pd-product" value={product} onChange={setProduct} includeInactive /></div>
        <div className="space-y-1"><Label htmlFor="pd-wh">Fulfilment location</Label>
          <Select value={warehouse} onValueChange={setWarehouse}><SelectTrigger id="pd-wh" className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All warehouses</SelectItem>{storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code}</SelectItem>)}</SelectContent></Select></div>
        <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
      </CardContent>
    </Card>
  )
  const header = (
    <PageHeader actions={
      <>
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={dash.loading ? 'animate-spin' : undefined} /></Button>
        {has('customer_po.import') && <Button asChild><Link to="/customer-pos/upload"><Upload /> Upload customer PO</Link></Button>}
      </>
    } />
  )

  if (dash.loading && !d) return (<>{header}{filters}<LoadingState variant="cards" rows={8} /></>)
  if (dash.error || !d) return (<>{header}{filters}<Card><ErrorState message={describeDataError(dash.error)} onRetry={dash.reload} /></Card></>)

  return (
    <>
      {header}
      {filters}
      {!d.has_records && (
        <Card className="mb-6">
          <EmptyState icon={ShoppingCart} title="No customer POs yet" description="Upload a customer purchase order (Excel or CSV) to match it to products and check stock. Nothing is created automatically."
            action={has('customer_po.import') ? <Button asChild><Link to="/customer-pos/upload">Upload customer PO</Link></Button> : undefined} />
        </Card>
      )}
      <p className="mb-4 flex items-start gap-2 rounded-lg border bg-background px-4 py-2.5 text-sm">
        <Info className="mt-0.5 size-4 shrink-0" />
        PO counts cover current revisions received in the period. Unit totals cover open POs and are shown per unit of measure — never added across units. Availability and shortage are calculated per product across all open POs (stock shared by several POs is counted once): available = eligible on hand − active reservations. As of {formatDateTime(d.as_of, d.timezone)}.
      </p>
      <section aria-label="PO KPIs" className="mb-6">
        {units.length > 1 && (
          <div role="group" aria-label="Unit" className="mb-3 inline-flex flex-wrap gap-1">
            {units.map((x) => (
              <button key={x.unit} type="button" aria-pressed={x.unit === sel} onClick={() => setUnit(x.unit)}
                className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', x.unit === sel ? 'border-primary bg-accent text-accent-foreground' : 'bg-background text-muted-foreground')}>{x.unit}</button>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <KpiCard label="Total POs Received" value={formatNumber(d.total_received)} hint="Current revisions in the period" icon={ClipboardList} />
          <KpiCard label="POs Pending Review" value={formatNumber(d.pending_review)} hint="Validation or product matching needed" icon={ScanSearch} accent="pending" />
          <KpiCard label="POs Ready for Fulfilment" value={formatNumber(d.ready_for_fulfilment)} hint="All lines matched; nothing allocated yet" icon={ClipboardCheck} accent="manufacturing" />
          <KpiCard label="POs Partially Available" value={formatNumber(d.partially_available)} hint="Some lines can be covered from stock" icon={PackageSearch} accent="pending" />
          <KpiCard label="POs With Stock Shortages" value={formatNumber(d.with_shortages)} hint="At least one line cannot be fully covered" icon={AlertTriangle} accent="shortage" />
          <KpiCard label="POs Fully Allocated" value={formatNumber(d.fully_allocated)} hint="Every line covered by reservations" icon={CheckCircle2} accent="available" />
          <KpiCard label="Total Ordered Units" value={formatQty(Number(u?.ordered ?? 0))} unit={sel ?? undefined} hint={others('ordered') ?? 'Matched lines of open POs'} icon={ShoppingCart} />
          <KpiCard label="Units Available for Allocation" value={formatQty(Number(u?.available ?? 0))} unit={sel ?? undefined} hint={others('available') ?? 'Eligible stock not reserved'} icon={PackageCheck} accent="available" />
          <KpiCard label="Units Reserved for POs" value={formatQty(Number(u?.reserved_for_pos ?? 0))} unit={sel ?? undefined} hint={others('reserved_for_pos') ?? 'Open PO reservations'} icon={Lock} accent="manufacturing" />
          <KpiCard label="Total Shortage Units" value={formatQty(Number(u?.shortage ?? 0))} unit={sel ?? undefined} hint={others('shortage') ?? 'Demand not coverable from stock'} icon={AlertTriangle} accent="shortage" />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="PO status distribution" description="Current revisions received in the period" isEmpty={d.by_status.length === 0} emptyMessage="No POs in this period." height={240}
          table={{ headers: ['Status', 'POs'], rows: d.by_status.map((s) => [PO_STATUS_LABELS[s.status] ?? s.status, s.count]) }}>
          <HorizontalBarChart seriesName="POs" labelWidth={170} data={d.by_status.map((s) => ({ label: PO_STATUS_LABELS[s.status] ?? s.status, value: Number(s.count), color: STATUS_FILL[s.status] }))} />
        </ChartCard>
        <ChartCard title="Ordered vs available vs shortage" description={`Open POs (${sel ?? '—'})`} isEmpty={!u} emptyMessage="No open PO demand." height={200}
          table={{ headers: ['Measure', sel ?? ''], rows: u ? [['Still to cover', formatQty(Number(u.need))], ['Available', formatQty(Number(u.available))], ['Shortage', formatQty(Number(u.shortage))]] : [] }}>
          <HorizontalBarChart seriesName={sel ?? ''} valueFormatter={(v) => formatQty(v)} data={u ? [
            { label: 'Still to cover', value: Number(u.need), color: TONE_FILL.neutral },
            { label: 'Available', value: Number(u.available), color: TONE_FILL.success },
            { label: 'Shortage', value: Number(u.shortage), color: TONE_FILL.danger },
          ] : []} />
        </ChartCard>
        <ChartCard title="Top products by demand" description={`Ordered on open POs (${sel ?? '—'}), top 10`} isEmpty={top.length === 0} emptyMessage="No demand."
          table={{ headers: ['Product', 'Ordered', 'Available', 'Shortage'], rows: top.map((p) => [`${p.sku} — ${p.product_name}`, formatQty(Number(p.ordered)), formatQty(Number(p.available)), formatQty(Number(p.shortage))]) }}>
          <HorizontalBarChart seriesName="Ordered" valueFormatter={(v) => formatQty(v)} data={top.map((p) => ({ label: p.sku, value: Number(p.ordered) }))} />
        </ChartCard>
        <ChartCard title="Shortage by product category" description={`Open POs (${sel ?? '—'})`} isEmpty={cat.length === 0} emptyMessage="No shortages."
          table={{ headers: ['Category', 'Shortage'], rows: cat.map((c) => [c.category, formatQty(Number(c.shortage))]) }}>
          <HorizontalBarChart seriesName="Shortage" valueFormatter={(v) => formatQty(v)} data={cat.map((c) => ({ label: c.category, value: Number(c.shortage), color: TONE_FILL.danger }))} />
        </ChartCard>
        <ChartCard title="In-house vs outsourced availability" description={`Eligible stock of products on open POs (${sel ?? '—'})`} isEmpty={!u} emptyMessage="No open PO demand." height={200}
          table={{ headers: ['Source', 'Available'], rows: u ? [['In-house', formatQty(Number(u.in_house_available))], ['Outsourced', formatQty(Number(u.outsourced_available))], ['Unverified (excluded)', formatQty(Number(u.unknown_on_hand))]] : [] }}>
          <HorizontalBarChart seriesName="Available" valueFormatter={(v) => formatQty(v)} data={u ? [
            { label: 'In-house', value: Number(u.in_house_available), color: CHART_COLORS.inHouse },
            { label: 'Outsourced', value: Number(u.outsourced_available), color: CHART_COLORS.outsourced },
          ] : []} />
        </ChartCard>
        <ChartCard title="POs received over time" description={`Current revisions per ${bucket}`} isEmpty={overTime.length === 0} emptyMessage="No POs received in this period."
          table={{ headers: ['Period', 'POs'], rows: overTime.map((p) => [p.label, p.value]) }}>
          <TrendLineChart data={overTime} seriesName="POs received" />
        </ChartCard>
      </div>
    </>
  )
}
