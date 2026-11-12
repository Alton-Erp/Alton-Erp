import {
  AlertTriangle,
  Boxes,
  CircleSlash,
  ClipboardCheck,
  Factory,
  Lock,
  PackageCheck,
  PackagePlus,
  RefreshCw,
  Truck,
  Warehouse,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { usePermissions } from '@/auth/use-permissions'
import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { RankedBarCard } from '@/components/charts/ranked-bar-card'
import { InventoryMovementChart } from '@/components/charts/inventory-movement-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatQty } from '@/features/inventory/inventory-model'
import { isFractionalForUnit } from '@/features/inventory/whole-units'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, bucketForRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchInventoryOverview, fetchMovementTrend, type UnitTotals } from '@/services/inventory'
import { bucketRange, STOCK_HEALTH } from '@/features/drilldown/drill-registry'
import { useDrill, useUrlDateRange } from '@/features/drilldown/use-drill'

const BUCKET_LABEL = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })
const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })

export default function InventoryOverviewPage() {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const [unit, setUnit] = useState<string | null>(null)
  // Movement period kept in the address, so Back from a drill-down page keeps it.
  const [range, setRange] = useUrlDateRange('last_7_days')
  const { href } = useDrill('inventory')
  const navigate = useNavigate()
  const overview = useAsync(fetchInventoryOverview, [refresh])
  const bucket = bucketForRange(range)
  const trend = useAsync(() => fetchMovementTrend(toIsoDate(range.from), toIsoDate(range.to), bucket), [range, refresh])

  const data = overview.data
  const units = useMemo(() => [...(data?.units ?? [])].sort((a, b) => Number(b.on_hand) - Number(a.on_hand)), [data])
  const selectedUnit = unit && units.some((u) => u.unit === unit) ? unit : (units[0]?.unit ?? null)
  const totals: UnitTotals | undefined = units.find((u) => u.unit === selectedUnit)
  const otherUnits = units.filter((u) => u.unit !== selectedUnit)
  // Whole-piece units whose totals are not whole: flagged, never rounded.
  const fractionalUnits = units
    .filter((u) => isFractionalForUnit(u.on_hand, u.unit) || isFractionalForUnit(u.reserved, u.unit))
    .map((u) => u.unit)
  const qty = (key: keyof UnitTotals) => (totals ? formatQty(Number(totals[key])) : '0')
  const others = (key: keyof UnitTotals) =>
    otherUnits.length ? `Also: ${otherUnits.map((u) => formatQty(Number(u[key]), u.unit)).join(', ')}` : undefined

  const trendPoints = useMemo(() => {
    const rows = (trend.data ?? []).filter((r) => r.unit === selectedUnit)
    return rows.map((r) => {
      const d = new Date(`${r.bucket}T00:00:00`)
      return {
        bucket: String(r.bucket).slice(0, 10),
        label: bucket === 'month' ? MONTH_LABEL.format(d) : bucket === 'year' ? String(d.getFullYear()) : BUCKET_LABEL.format(d),
        inward: Number(r.quantity_in),
        outward: Number(r.quantity_out),
      }
    })
  }, [trend.data, selectedUnit, bucket])

  if (overview.loading && !data) {
    return (
      <>
        <PageHeader />
        <LoadingState variant="cards" rows={8} />
      </>
    )
  }
  if (overview.error || !data) {
    return (
      <>
        <PageHeader />
        <Card>
          <ErrorState message={describeDataError(overview.error)} onRetry={overview.reload} />
        </Card>
      </>
    )
  }

  const pending = data.pending_opening + data.pending_adjustments + data.pending_counts
  const noLedger = !data.first_transaction_at
  const byCategory = data.by_category.filter((c) => c.unit === selectedUnit)
  const byWarehouse = data.by_warehouse.filter((w) => w.unit === selectedUnit)
  // Drill-down: figures of the selected unit open the records behind them.
  const u = { unit: selectedUnit }
  const drillable = Boolean(href('inventory.active_products'))
  const go = (to: string | null) => { if (to) navigate(to) }
  const SOURCE_KEYS = ['inventory.in_house', 'inventory.outsourced', 'inventory.unknown'] as const
  const movementHref = (start: string | undefined) => (start
    ? href('inventory.movements', { from: toIsoDate(range.from), to: toIsoDate(range.to), unit: selectedUnit, ...bucketRange(start, bucket, { from: toIsoDate(range.from), to: toIsoDate(range.to) }) })
    : null)

  return (
    <>
      <PageHeader
        actions={
          <>
            <Button variant="outline" size="icon" aria-label="Refresh" title="Refresh" onClick={() => setRefresh((n) => n + 1)}>
              <RefreshCw className={overview.loading ? 'animate-spin' : undefined} />
            </Button>
            {(has('inventory_opening.create') || has('inventory_opening.approve')) && (
              <Button variant="outline" asChild>
                <Link to="/inventory/opening-stock">
                  <PackagePlus />
                  Opening stock
                </Link>
              </Button>
            )}
            <Button asChild>
              <Link to="/inventory/movements">Stock movements</Link>
            </Button>
          </>
        }
      />

      {fractionalUnits.length > 0 && (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          The {fractionalUnits.join(', ')} totals include fractional quantities posted before whole-piece rules. They are shown exactly as recorded, not rounded.{' '}
          {has('inventory_reconciliation.run')
            ? <Link className="underline" to="/inventory/whole-piece-audit">Review and reconcile them in the whole-piece audit.</Link>
            : 'Ask an inventory manager to reconcile them.'}
        </p>
      )}

      {data.warehouses === 0 ? (
        <Card>
          <EmptyState
            icon={Warehouse}
            title="No warehouse set up yet"
            description="Create at least one warehouse before recording stock. Each warehouse gets a default General area location automatically."
            action={
              <PermissionGate permission="inventory_warehouse.manage">
                <Button asChild>
                  <Link to="/inventory/warehouses">Set up warehouses</Link>
                </Button>
              </PermissionGate>
            }
          />
        </Card>
      ) : noLedger ? (
        <Card className="mb-6">
          <EmptyState
            icon={Boxes}
            title="No inventory recorded yet"
            description="Inventory starts with opening stock: enter or import the physical quantities you hold today. Nothing is created automatically from the product master."
            action={
              (has('inventory_opening.create') || has('inventory_opening.approve')) ? (
                <Button asChild>
                  <Link to="/inventory/opening-stock">Initialize opening stock</Link>
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : null}

      {pending > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <ClipboardCheck aria-hidden className="size-4" />
          <span className="font-medium">Awaiting approval:</span>
          {data.pending_opening > 0 && <Link className="underline" to="/inventory/opening-stock">{data.pending_opening} opening stock</Link>}
          {data.pending_adjustments > 0 && <span>{data.pending_adjustments} adjustments</span>}
          {data.pending_counts > 0 && <span>{data.pending_counts} stock counts</span>}
        </div>
      )}

      <section aria-labelledby="position-heading" className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="position-heading" className="text-sm font-semibold">Current inventory position</h2>
            <p className="text-xs text-muted-foreground">
              Live balances as of {formatDateTime(data.as_of, data.timezone)} ({data.timezone}). For a past date use Inventory Reports → Stock as of date.
            </p>
          </div>
          {units.length > 1 && (
            <div role="group" aria-label="Unit" className="inline-flex flex-wrap gap-1">
              {units.map((u) => (
                <button
                  key={u.unit}
                  type="button"
                  aria-pressed={u.unit === selectedUnit}
                  onClick={() => setUnit(u.unit)}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-xs font-medium',
                    u.unit === selectedUnit ? 'border-primary bg-accent text-accent-foreground' : 'bg-background text-muted-foreground hover:text-foreground',
                  )}
                >
                  {u.unit}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard to={href('inventory.active_products')} label="Total Active Products" value={formatNumber(data.active_products)} hint={`${formatNumber(data.products_with_stock)} with stock on hand`} icon={Boxes} />
          <KpiCard to={href('inventory.on_hand', u)} label="Total Units on Hand" value={qty('on_hand')} unit={selectedUnit ?? undefined} hint={others('on_hand') ?? 'Physical quantity in stock'} icon={Warehouse} accent="manufacturing" />
          <KpiCard to={href('inventory.reserved', u)} label="Total Reserved Units" value={qty('reserved')} unit={selectedUnit ?? undefined} hint={others('reserved') ?? 'Allocated, not yet issued'} icon={Lock} accent="pending" />
          <KpiCard to={href('inventory.available', u)} label="Total Available Units" value={qty('available')} unit={selectedUnit ?? undefined} hint={others('available') ?? 'On hand minus reserved'} icon={PackageCheck} accent="available" />
          <KpiCard to={href('inventory.low_stock')} label="Low-Stock Products" value={formatNumber(data.low_stock + data.fully_reserved)} hint={`${formatNumber(data.fully_reserved)} with no available stock`} icon={AlertTriangle} accent="pending" />
          <KpiCard to={href('inventory.out_of_stock')} label="Out-of-Stock Products" value={formatNumber(data.out_of_stock)} hint={`${formatNumber(data.never_stocked)} active products never stocked`} icon={CircleSlash} accent="shortage" />
          <KpiCard to={href('inventory.in_house', u)} label="In-House Stock" value={qty('in_house')} unit={selectedUnit ?? undefined} hint="Manufactured, per receipt / lot" icon={Factory} accent="manufacturing" />
          <KpiCard
            to={href('inventory.outsourced', u)}
            label="Outsourced Stock"
            value={qty('outsourced')}
            unit={selectedUnit ?? undefined}
            hint={Number(totals?.unknown ?? 0) > 0 ? `${formatQty(Number(totals?.unknown))} ${selectedUnit} with unverified source` : 'Purchased, per receipt / lot'}
            icon={Truck}
            accent="outsourced"
          />
        </div>
      </section>

      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <RankedBarCard
          testId="inventory-by-category"
          title="Inventory by category"
          description={`Current on-hand quantity${selectedUnit ? ` (${selectedUnit})` : ''}, largest first`}
          rows={byCategory.map((c) => ({ label: c.category, value: Number(c.on_hand), href: href('inventory.category', { ...u, segment: c.category }) }))}
          seriesName="On hand"
          labelHeader="Category"
          valueHeader={`On hand (${selectedUnit ?? ''})`}
          valueFormatter={(v) => formatQty(v)}
          limit={10}
          emptyMessage="No stock on hand."
          onOpen={drillable ? go : undefined}
          drillHint="Click a category to open its products."
        />
        <ChartCard
          title="In-house vs outsourced"
          description={`Actual source of current stock${selectedUnit ? ` (${selectedUnit})` : ''}`}
          isEmpty={!totals || Number(totals.on_hand) === 0}
          emptyMessage="No stock on hand."
          height={220}
          table={{
            headers: ['Source', `On hand (${selectedUnit ?? ''})`],
            rows: [
              ['In-House', formatQty(Number(totals?.in_house ?? 0))],
              ['Outsourced', formatQty(Number(totals?.outsourced ?? 0))],
              ['Unverified source', formatQty(Number(totals?.unknown ?? 0))],
            ],
            links: SOURCE_KEYS.map((k) => href(k, u)),
          }}
          drillHint={drillable ? 'Click a source to open its stock.' : undefined}
        >
          <HorizontalBarChart
            seriesName="On hand"
            valueFormatter={(v) => formatQty(v)}
            data={[
              { label: 'In-House', value: Number(totals?.in_house ?? 0), color: CHART_COLORS.inHouse },
              { label: 'Outsourced', value: Number(totals?.outsourced ?? 0), color: CHART_COLORS.outsourced },
              { label: 'Unverified', value: Number(totals?.unknown ?? 0), color: TONE_FILL.neutral },
            ]}
            onSelect={drillable ? (i) => go(href(SOURCE_KEYS[i], u)) : undefined}
          />
        </ChartCard>
      </div>

      <section aria-labelledby="movement-heading" className="mb-6">
        <ChartCard
          title="Stock movement trend"
          description={`Quantity received vs issued during the selected period (${bucket}ly, ${selectedUnit ?? 'all units'}). Internal transfers are excluded.`}
          loading={trend.loading}
          error={trend.error ? new Error(describeDataError(trend.error)) : null}
          onRetry={trend.reload}
          isEmpty={trendPoints.length === 0}
          emptyMessage="No stock movements in this period."
          table={{ headers: ['Period', 'In', 'Out'], rows: trendPoints.map((p) => [p.label, formatQty(p.inward), formatQty(p.outward)]), links: trendPoints.map((p) => movementHref(p.bucket)) }}
          drillHint={drillable ? 'Click a point to open the movements of that period.' : undefined}
        >
          <InventoryMovementChart data={trendPoints} onSelect={drillable ? (i) => go(movementHref(trendPoints[i]?.bucket)) : undefined} />
        </ChartCard>
        <div className="mt-3 flex justify-end">
          <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
        </div>
        <h2 id="movement-heading" className="sr-only">Movements during the selected period</h2>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard
          title="Stock health"
          description="Active products by current stock status"
          height={240}
          isEmpty={data.active_products === 0}
          emptyMessage="No active products."
          table={{
            headers: ['Status', 'Products'],
            rows: [
              ['Healthy', data.healthy],
              ['Low stock', data.low_stock],
              ['No available stock (fully reserved)', data.fully_reserved],
              ['Out of stock', data.out_of_stock],
              ['In stock, no reorder level', data.no_threshold],
              ['Never stocked', data.never_stocked],
            ],
            links: STOCK_HEALTH.map((s) => href('inventory.health', { segment: s })),
          }}
          drillHint={drillable ? 'Click a bar to open those products.' : undefined}
        >
          <HorizontalBarChart
            seriesName="Products"
            labelWidth={140}
            data={[
              { label: 'Healthy', value: data.healthy, color: TONE_FILL.success },
              { label: 'Low stock', value: data.low_stock, color: TONE_FILL.warning },
              { label: 'Fully reserved', value: data.fully_reserved, color: TONE_FILL.danger },
              { label: 'Out of stock', value: data.out_of_stock, color: TONE_FILL.danger },
              { label: 'No reorder level', value: data.no_threshold, color: TONE_FILL.neutral },
              { label: 'Never stocked', value: data.never_stocked, color: TONE_FILL.neutral },
            ]}
            onSelect={drillable ? (i) => go(href('inventory.health', { segment: STOCK_HEALTH[i] })) : undefined}
          />
        </ChartCard>
        <ChartCard
          title="Inventory by warehouse"
          description={`Current on-hand quantity${selectedUnit ? ` (${selectedUnit})` : ''}`}
          height={240}
          isEmpty={byWarehouse.length === 0}
          emptyMessage="No stock on hand."
          table={{ headers: ['Warehouse', `On hand (${selectedUnit ?? ''})`], rows: byWarehouse.map((w) => [`${w.warehouse_code} — ${w.warehouse_name}`, formatQty(Number(w.on_hand))]),
            links: byWarehouse.map((w) => href('inventory.warehouse', { ...u, segment: w.warehouse_code })) }}
          drillHint={drillable ? 'Click a warehouse to open its stock.' : undefined}
        >
          <HorizontalBarChart seriesName="On hand" valueFormatter={(v) => formatQty(v)} data={byWarehouse.map((w) => ({ label: w.warehouse_code, value: Number(w.on_hand) }))}
            onSelect={drillable ? (i) => go(href('inventory.warehouse', { ...u, segment: byWarehouse[i]?.warehouse_code })) : undefined} />
        </ChartCard>
      </div>
    </>
  )
}
