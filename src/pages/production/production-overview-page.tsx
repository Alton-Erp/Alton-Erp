import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Factory,
  Network,
  PackageCheck,
  RefreshCw,
  Timer,
  Truck,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { TrendLineChart } from '@/components/charts/trend-line-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { PRODUCTION_STATUS_LABELS } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, bucketForRange, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ProductOption } from '@/services/inventory'
import { fetchProductionOverview } from '@/services/production'
import type { DateRangeValue } from '@/types'
import type { ProductionStatus } from '@/types/database-production'

const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })
type Bucket = 'day' | 'week' | 'month' | 'year'

const STATUS_FILL: Record<string, string> = {
  DRAFT: TONE_FILL.neutral,
  PENDING_APPROVAL: TONE_FILL.warning,
  APPROVED: TONE_FILL.info,
  MATERIALS_RESERVED: TONE_FILL.info,
  IN_PROGRESS: TONE_FILL.info,
  PARTIALLY_COMPLETED: TONE_FILL.info,
  COMPLETED: TONE_FILL.success,
  ON_HOLD: TONE_FILL.warning,
  CANCELLED: TONE_FILL.neutral,
}

function UnitToggle({ units, value, onChange, label }: { units: string[]; value: string | null; onChange: (u: string) => void; label: string }) {
  if (units.length < 2) return null
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1">
      {units.map((u) => (
        <button key={u} type="button" aria-pressed={u === value} onClick={() => onChange(u)}
          className={cn('rounded-md border px-2.5 py-1 text-xs font-medium', u === value ? 'border-primary bg-accent text-accent-foreground' : 'bg-background text-muted-foreground hover:text-foreground')}>
          {u}
        </button>
      ))}
    </div>
  )
}

export default function ProductionOverviewPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const [refresh, setRefresh] = useState(0)
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [bucketChoice, setBucketChoice] = useState<Bucket | 'auto'>('auto')
  const [warehouseId, setWarehouseId] = useState<string>('all')
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [status, setStatus] = useState<string>('all')
  const [unit, setUnit] = useState<string | null>(null)
  const [materialUnit, setMaterialUnit] = useState<string | null>(null)
  const bucket: Bucket = bucketChoice === 'auto' ? bucketForRange(range) : bucketChoice

  const overview = useAsync(
    () =>
      fetchProductionOverview({
        from: toIsoDate(range.from),
        to: toIsoDate(range.to),
        warehouseId: warehouseId === 'all' ? null : warehouseId,
        productId: product?.product_id ?? null,
        status: status === 'all' ? null : (status as ProductionStatus),
        bucket,
      }),
    [range, bucket, warehouseId, product?.product_id, status, refresh],
  )
  const data = overview.data

  const fgUnits = useMemo(() => {
    const s = new Set<string>()
    for (const r of [...(data?.planned_open ?? []), ...(data?.produced_this_month ?? []), ...(data?.planned_vs_actual ?? []), ...(data?.source_split ?? [])]) s.add(r.unit)
    return [...s].sort()
  }, [data])
  const selectedUnit = unit && fgUnits.includes(unit) ? unit : (fgUnits.includes('PCS') ? 'PCS' : (fgUnits[0] ?? null))
  const matUnits = useMemo(() => [...new Set((data?.consumption_trend ?? []).map((r) => r.unit))].sort(), [data])
  const selectedMatUnit = materialUnit && matUnits.includes(materialUnit) ? materialUnit : (matUnits[0] ?? null)

  const label = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`)
    return bucket === 'month' ? MONTH.format(d) : bucket === 'year' ? String(d.getFullYear()) : DAY.format(d)
  }
  const forUnit = <T extends { unit: string }>(rows: T[] | undefined, u: string | null) => (rows ?? []).filter((r) => r.unit === u)
  const sumFor = (rows: { unit: string }[] | undefined, key: string) => {
    const r = (rows ?? []).find((x) => x.unit === selectedUnit) as Record<string, unknown> | undefined
    return r ? Number(r[key]) : 0
  }
  const otherUnits = (rows: { unit: string }[] | undefined, key: string) => {
    const others = (rows ?? []).filter((x) => x.unit !== selectedUnit) as unknown as Record<string, unknown>[]
    return others.length ? `Also: ${others.map((o) => formatQty(Number(o[key]), String(o.unit))).join(', ')}` : undefined
  }

  const plannedActual = forUnit(data?.planned_vs_actual, selectedUnit).map((r) => ({ label: label(r.bucket), a: Number(r.planned), b: Number(r.actual) }))
  const split = forUnit(data?.source_split, selectedUnit).map((r) => ({ label: label(r.bucket), a: Number(r.in_house), b: Number(r.outsourced) }))
  const consumption = forUnit(data?.consumption_trend, selectedMatUnit).map((r) => ({ label: label(r.bucket), value: Number(r.quantity) }))
  const byProduct = forUnit(data?.by_product, selectedUnit)

  const filters = (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1">
          <Label htmlFor="ov-wh">Warehouse</Label>
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger id="ov-wh" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All warehouses</SelectItem>
              {storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="w-72 space-y-1">
          <Label htmlFor="ov-product">Product</Label>
          <ProductPicker id="ov-product" value={product} onChange={setProduct} includeInactive />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ov-status">Order status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="ov-status" className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {Object.entries(PRODUCTION_STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="ov-bucket">Group by</Label>
          <Select value={bucketChoice} onValueChange={(v) => setBucketChoice(v as Bucket | 'auto')}>
            <SelectTrigger id="ov-bucket" className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
      </CardContent>
    </Card>
  )

  const header = (
    <PageHeader
      actions={
        <>
          <Button variant="outline" size="icon" aria-label="Refresh" title="Refresh" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw className={overview.loading ? 'animate-spin' : undefined} />
          </Button>
          {has('production_plan.create') && <Button variant="outline" asChild><Link to="/production/planning">Plan production</Link></Button>}
          <Button asChild><Link to="/production/orders">Production orders</Link></Button>
        </>
      }
    />
  )

  if (overview.loading && !data) {
    return (<>{header}{filters}<LoadingState variant="cards" rows={8} /></>)
  }
  if (overview.error || !data) {
    return (<>{header}{filters}<Card><ErrorState message={describeDataError(overview.error)} onRetry={overview.reload} /></Card></>)
  }

  const pendingApprovals = data.pending_order_approvals + data.pending_bom_approvals

  return (
    <>
      {header}
      {filters}

      {!data.has_records && (
        <Card className="mb-6">
          <EmptyState
            icon={Factory}
            title="No production records yet"
            description="Production starts with an approved bill of materials for each finished product. Nothing is created automatically; all figures below come from recorded orders, issues and receipts."
            action={has('production_bom.create') ? <Button asChild><Link to="/production/boms/new"><Network /> Create a BOM</Link></Button> : undefined}
          />
        </Card>
      )}

      {(pendingApprovals > 0 || data.pending_outsourcing_approvals > 0) && (
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <ClipboardCheck aria-hidden className="size-4" />
          <span className="font-medium">Awaiting approval:</span>
          {data.pending_order_approvals > 0 && <Link className="underline" to="/production/orders">{data.pending_order_approvals} production orders</Link>}
          {data.pending_bom_approvals > 0 && <Link className="underline" to="/production/boms">{data.pending_bom_approvals} BOMs</Link>}
          {data.pending_outsourcing_approvals > 0 && <Link className="underline" to="/production/outsourcing">{data.pending_outsourcing_approvals} outsourcing orders</Link>}
        </div>
      )}

      <section aria-labelledby="kpi-heading" className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="kpi-heading" className="text-sm font-semibold">Production position</h2>
            <p className="text-xs text-muted-foreground">
              Open orders and shortages are current ({formatDateTime(data.as_of, data.timezone)}); completed orders follow the selected period. Quantities are shown per unit and never added across units.
            </p>
          </div>
          <UnitToggle units={fgUnits} value={selectedUnit} onChange={setUnit} label="Output unit" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Production Orders — Total Open" value={formatNumber(data.open_orders)} hint={`${formatNumber(data.draft_orders)} drafts · ${formatNumber(data.overdue_orders)} past target date`} icon={ClipboardList} />
          <KpiCard label="Planned Production Quantity" value={formatQty(sumFor(data.planned_open, 'planned'))} unit={selectedUnit ?? undefined}
            hint={otherUnits(data.planned_open, 'planned') ?? `${formatQty(sumFor(data.planned_open, 'remaining'))} still to produce on open orders`} icon={CalendarClock} accent="manufacturing" />
          <KpiCard label="In-Progress Orders" value={formatNumber(data.in_progress_orders)} hint={`${formatNumber(data.on_hold_orders)} on hold`} icon={Timer} accent="manufacturing" />
          <KpiCard label="Completed Orders" value={formatNumber(data.completed_orders)} hint="Completed in the selected period" icon={CheckCircle2} accent="available" />
          <KpiCard label="Raw Material Shortages" value={formatNumber(data.shortage_materials)} hint="Materials short for open orders (source warehouse)" icon={AlertTriangle} accent="shortage" />
          <KpiCard label="Finished Goods Produced This Month" value={formatQty(sumFor(data.produced_this_month, 'good'))} unit={selectedUnit ?? undefined}
            hint={otherUnits(data.produced_this_month, 'good') ?? 'Good output posted to stock'} icon={PackageCheck} accent="available" />
          <KpiCard label="Outsourcing Orders In Progress" value={formatNumber(data.outsourcing_in_progress)} hint="Approved, dispatched or partially received" icon={Truck} accent="outsourced" />
          <KpiCard label="Pending Production Approvals" value={formatNumber(pendingApprovals)} hint={`${formatNumber(data.pending_order_approvals)} orders · ${formatNumber(data.pending_bom_approvals)} BOMs`} icon={ClipboardCheck} accent="pending" />
        </div>
      </section>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <ChartCard
          title="Planned versus actual production"
          description={`Planned quantity by target date vs good output by production date (${bucket}, ${selectedUnit ?? '—'})`}
          isEmpty={plannedActual.length === 0}
          emptyMessage="No planned or produced quantities in this period."
          table={{ headers: ['Period', 'Planned', 'Actual (good)'], rows: plannedActual.map((p) => [p.label, formatQty(p.a), formatQty(p.b)]) }}
        >
          <PairedBarChart data={plannedActual} aName="Planned" bName="Actual (good)" valueFormatter={(v) => formatQty(v)} />
        </ChartCard>
        <ChartCard
          title="Production quantity by product"
          description={`Good output in the period (${selectedUnit ?? '—'}), top 10`}
          isEmpty={byProduct.length === 0}
          emptyMessage="No output recorded in this period."
          table={{ headers: ['Product', 'Good', 'Rejected', 'Scrap'], rows: byProduct.map((p) => [`${p.sku} — ${p.product_name}`, formatQty(p.good), formatQty(p.rejected), formatQty(p.scrap)]) }}
        >
          <HorizontalBarChart seriesName="Good output" valueFormatter={(v) => formatQty(v)} data={byProduct.map((p) => ({ label: p.sku, value: Number(p.good) }))} />
        </ChartCard>
        <ChartCard
          title="Production orders by status"
          description="Open orders plus orders planned to start in the period"
          height={260}
          isEmpty={data.by_status.length === 0}
          emptyMessage="No production orders."
          table={{ headers: ['Status', 'Orders'], rows: data.by_status.map((s) => [PRODUCTION_STATUS_LABELS[s.status] ?? s.status, s.orders]) }}
        >
          <HorizontalBarChart seriesName="Orders" labelWidth={150}
            data={data.by_status.map((s) => ({ label: PRODUCTION_STATUS_LABELS[s.status] ?? s.status, value: Number(s.orders), color: STATUS_FILL[s.status] }))} />
        </ChartCard>
        <ChartCard
          title="In-house versus outsourced finished goods"
          description={`Good in-house output vs accepted outsourced receipts (${bucket}, ${selectedUnit ?? '—'})`}
          isEmpty={split.length === 0}
          emptyMessage="No finished goods received in this period."
          table={{ headers: ['Period', 'In-house', 'Outsourced'], rows: split.map((p) => [p.label, formatQty(p.a), formatQty(p.b)]) }}
        >
          <PairedBarChart data={split} aName="In-house" bName="Outsourced" aColor={CHART_COLORS.inHouse} bColor={CHART_COLORS.outsourced} valueFormatter={(v) => formatQty(v)} />
        </ChartCard>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div>
          <ChartCard
            title="Raw-material consumption trend"
            description={`Material issued to production, net of reversals (${bucket}, ${selectedMatUnit ?? '—'})`}
            isEmpty={consumption.length === 0}
            emptyMessage="No material issued in this period."
            table={{ headers: ['Period', `Issued (${selectedMatUnit ?? ''})`], rows: consumption.map((p) => [p.label, formatQty(p.value)]) }}
          >
            <TrendLineChart data={consumption} seriesName={`Issued (${selectedMatUnit ?? ''})`} valueFormatter={(v) => formatQty(v)} />
          </ChartCard>
          <div className="mt-2 flex justify-end"><UnitToggle units={matUnits} value={selectedMatUnit} onChange={setMaterialUnit} label="Material unit" /></div>
        </div>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Production shortages by material</CardTitle>
              <CardDescription>Outstanding requirement of open orders not covered by their reservations or usable stock in the source warehouse</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.shortages.length === 0 ? (
              <EmptyState compact icon={CheckCircle2} title="No material shortages" description="Every open order's outstanding material is covered by reservations or usable stock." />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr><th className="pb-2 text-left">Material</th><th className="pb-2 text-left">Warehouse</th><th className="pb-2 text-right">Needed</th><th className="pb-2 text-right">Usable</th><th className="pb-2 text-right">Short</th></tr>
                </thead>
                <tbody>
                  {data.shortages.map((s) => (
                    <tr key={`${s.sku}-${s.warehouse_code}`} className="border-t">
                      <td className="py-2"><span className="font-medium">{s.sku}</span><div className="text-xs text-muted-foreground">{s.product_name} · {s.orders} order(s)</div></td>
                      <td className="py-2">{s.warehouse_code}</td>
                      <td className="py-2 text-right tabular-nums">{formatQty(s.outstanding, s.unit)}</td>
                      <td className="py-2 text-right tabular-nums">{formatQty(Number(s.available) + Number(s.reserved_for_orders))}</td>
                      <td className="py-2 text-right font-medium tabular-nums text-shortage">{formatQty(s.shortage, s.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
