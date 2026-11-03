import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, ClipboardClock, Factory, IndianRupee, Lock, PackageCheck, ShoppingCart, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { CHART_COLORS, TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { InventoryMovementChart } from '@/components/charts/inventory-movement-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { PlaceholderCard } from '@/components/common/placeholder-card'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { money } from '@/features/billing/billing-model'
import { StockStatusBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { bucketForRange, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { requireSupabase } from '@/lib/supabase'
import { fetchInventoryOverview, fetchMovementTrend } from '@/services/inventory'
import { fetchBillingOverview } from '@/services/billing'
import { fetchOrderLines, fetchOrdersPage, fetchSalesOverview } from '@/services/sales'
import { SalesOrderStatusBadge } from '@/features/sales/sales-badges'
import { ORDER_STATUS_LABELS, ORDER_STATUS_TONE, WORKABLE_ORDER_STATUSES } from '@/features/sales/sales-model'
import type { ProductStockRow } from '@/types/database-inventory'
import type { DateRangeValue } from '@/types'

const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' })
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })

async function fetchLowStock(): Promise<ProductStockRow[]> {
  const { data, error } = await requireSupabase()
    .from('inventory_product_stock')
    .select('*')
    .is('archived_at', null)
    .eq('product_status', 'ACTIVE')
    .in('stock_status', ['LOW_STOCK', 'FULLY_RESERVED', 'OUT_OF_STOCK'])
    .eq('has_history', true)
    .order('available')
    .limit(8)
  if (error) throw error
  return data ?? []
}

export default function DashboardPage() {
  const { has } = usePermissions()
  const canInventory = has('inventory.read')
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const bucket = bucketForRange(range)
  const overview = useAsync(() => (canInventory ? fetchInventoryOverview() : Promise.resolve(null)), [canInventory])
  const trend = useAsync(() => (canInventory ? fetchMovementTrend(toIsoDate(range.from), toIsoDate(range.to), bucket) : Promise.resolve([])), [canInventory, range])
  const lowStock = useAsync(() => (canInventory ? fetchLowStock() : Promise.resolve([])), [canInventory])
  const canSales = has('sales_orders.read')
  const openOrders = useAsync(() => (canSales ? fetchOrdersPage({ search: '', status: 'OPEN', customerId: null, source: null, from: null, to: null }, 0, 5) : Promise.resolve(null)), [canSales])
  const recentOrders = useAsync(() => (canSales ? fetchOrdersPage({ search: '', status: null, customerId: null, source: null, from: null, to: null }, 0, 6) : Promise.resolve(null)), [canSales])
  const backordered = useAsync(() => (canSales ? fetchOrderLines({ backorderedOnly: true, openOnly: true }) : Promise.resolve([])), [canSales])
  const salesOverview = useAsync(() => (canSales ? fetchSalesOverview({ from: toIsoDate(range.from), to: toIsoDate(range.to), customerId: null, warehouseId: null, orderStatus: null, dispatchStatus: null, deliveryStatus: null, bucket }) : Promise.resolve(null)), [canSales, range])
  const canBilling = has('billing_reports.read')
  const monthRange = useMemo(() => getPresetRange('this_month'), [])
  const billingMonth = useAsync(() => (canBilling ? fetchBillingOverview({ from: toIsoDate(monthRange.from), to: toIsoDate(monthRange.to), customerId: null, status: null, paymentStatus: null }) : Promise.resolve(null)), [canBilling, monthRange])
  const shortageOrders = new Set((backordered.data ?? []).filter((l) => (WORKABLE_ORDER_STATUSES as readonly string[]).includes(l.order_status)).map((l) => l.sales_order_id)).size

  const data = overview.data
  // Most common unit (by quantity) is shown; other units are listed in hints. Units are never summed together.
  const units = useMemo(() => [...(data?.units ?? [])].sort((a, b) => Number(b.on_hand) - Number(a.on_hand)), [data])
  const primary = units[0]
  const others = (k: 'on_hand' | 'in_house' | 'outsourced' | 'available' | 'reserved') =>
    units.length > 1 ? `Also ${units.slice(1).map((u) => formatQty(Number(u[k]), u.unit)).join(', ')}` : undefined
  const q = (k: 'on_hand' | 'in_house' | 'outsourced' | 'available' | 'reserved') => (data ? formatQty(Number(primary?.[k] ?? 0)) : null)

  const points = (trend.data ?? [])
    .filter((r) => r.unit === primary?.unit)
    .map((r) => {
      const d = new Date(`${r.bucket}T00:00:00`)
      return { label: bucket === 'month' ? MONTH.format(d) : bucket === 'year' ? String(d.getFullYear()) : DAY.format(d), inward: Number(r.quantity_in), outward: Number(r.quantity_out) }
    })
  const byCategory = (data?.by_category ?? []).filter((c) => c.unit === primary?.unit)
  const noStockYet = data && !data.first_transaction_at

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Live stock position from the inventory ledger, sales order status and issued invoices."
        actions={canInventory ? <DateRangeFilter value={range} onChange={setRange} /> : undefined}
      />

      {!canInventory && (
        <Card className="mb-6"><EmptyState icon={Boxes} title="No inventory access" description="Your role does not include inventory access, so stock figures are not shown." /></Card>
      )}
      {overview.error && <p role="alert" className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{describeDataError(overview.error)}</p>}
      {noStockYet && (
        <Card className="mb-6">
          <EmptyState icon={Boxes} title="No inventory recorded yet" description="Stock figures appear here once opening stock has been entered and approved."
            action={<Button asChild><Link to="/inventory/opening-stock">Initialize opening stock</Link></Button>} />
        </Card>
      )}

      <section aria-labelledby="kpi-heading" className="mb-6">
        <h2 id="kpi-heading" className="mb-3 text-sm font-semibold">Key metrics{primary ? ` (${primary.unit})` : ''}</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Total Stock" value={canInventory ? q('on_hand') : null} unit={primary?.unit} hint={others('on_hand') ?? 'On hand across all warehouses'} icon={Boxes} />
          <KpiCard label="In-House Stock" value={canInventory ? q('in_house') : null} unit={primary?.unit} hint={others('in_house') ?? 'Manufactured (per receipt / lot)'} icon={Factory} accent="manufacturing" />
          <KpiCard label="Outsourced Stock" value={canInventory ? q('outsourced') : null} unit={primary?.unit} hint={others('outsourced') ?? 'Purchased (per receipt / lot)'} icon={Truck} accent="outsourced" />
          <KpiCard label="Available Stock" value={canInventory ? q('available') : null} unit={primary?.unit} hint={others('available') ?? 'On hand minus reserved'} icon={PackageCheck} accent="available" />
          <KpiCard label="Reserved Stock" value={canInventory ? q('reserved') : null} unit={primary?.unit} hint={others('reserved') ?? 'Allocated, not yet issued'} icon={Lock} accent="pending" />
          <KpiCard label="Pending Orders" value={canSales && openOrders.data ? String(openOrders.data.total) : null} hint={canSales ? 'Open sales orders (not fulfilled or cancelled)' : 'No sales order access'} icon={ClipboardClock} accent="pending" />
          <KpiCard label="Orders With Shortages" value={canSales && backordered.data ? String(shortageOrders) : null} hint={canSales ? 'Confirmed orders with quantity not covered by reservations' : 'No sales order access'} icon={AlertTriangle} accent="shortage" />
          <KpiCard label="Invoiced This Month" value={canBilling && billingMonth.data ? money(billingMonth.data.invoiced_total) : null} hint={canBilling ? (billingMonth.error ? describeDataError(billingMonth.error) : 'Issued invoices incl. GST (calendar month)') : 'No billing report access'} icon={IndianRupee} accent="manufacturing" />
        </div>
      </section>

      {canInventory && (
        <>
          <div className="mb-6 grid gap-6 xl:grid-cols-2">
            <ChartCard title="Stock Composition" description={`Current on hand by category${primary ? ` (${primary.unit})` : ''}`} loading={overview.loading}
              isEmpty={byCategory.length === 0} emptyMessage="No stock on hand yet."
              table={{ headers: ['Category', 'On hand'], rows: byCategory.map((c) => [c.category, formatQty(Number(c.on_hand))]) }}>
              <HorizontalBarChart seriesName="On hand" valueFormatter={(v) => formatQty(v)} data={byCategory.map((c) => ({ label: c.category, value: Number(c.on_hand) }))} />
            </ChartCard>
            <ChartCard title="In-House vs Outsourced Stock" description={`Actual source of current stock${primary ? ` (${primary.unit})` : ''}`} loading={overview.loading} height={220}
              isEmpty={!primary || Number(primary.on_hand) === 0} emptyMessage="No stock on hand yet."
              table={{ headers: ['Source', 'On hand'], rows: [['In-House', formatQty(Number(primary?.in_house ?? 0))], ['Outsourced', formatQty(Number(primary?.outsourced ?? 0))], ['Unverified', formatQty(Number(primary?.unknown ?? 0))]] }}>
              <HorizontalBarChart seriesName="On hand" valueFormatter={(v) => formatQty(v)} data={[
                { label: 'In-House', value: Number(primary?.in_house ?? 0), color: CHART_COLORS.inHouse },
                { label: 'Outsourced', value: Number(primary?.outsourced ?? 0), color: CHART_COLORS.outsourced },
                { label: 'Unverified', value: Number(primary?.unknown ?? 0), color: TONE_FILL.neutral },
              ]} />
            </ChartCard>
          </div>
          <div className="mb-6 grid gap-6 xl:grid-cols-5">
            <ChartCard className="xl:col-span-3" title="Inventory Movement" description={`Received vs issued in the selected period (${primary?.unit ?? 'all units'}); transfers excluded`}
              loading={trend.loading} error={trend.error ? new Error(describeDataError(trend.error)) : null} onRetry={trend.reload}
              isEmpty={points.length === 0} emptyMessage="No stock movements in this period."
              table={{ headers: ['Period', 'In', 'Out'], rows: points.map((p) => [p.label, formatQty(p.inward), formatQty(p.outward)]) }}>
              <InventoryMovementChart data={points} />
            </ChartCard>
            <Card className="xl:col-span-2">
              <CardHeader>
                <div><CardTitle>Low-Stock Alerts</CardTitle><CardDescription>Available at or below reorder level, or out of stock</CardDescription></div>
                <Button variant="ghost" size="sm" asChild><Link to="/inventory/alerts">All alerts <ArrowRight /></Link></Button>
              </CardHeader>
              <CardContent className="pt-4">
                {lowStock.loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (lowStock.data ?? []).length === 0 ? (
                  <EmptyState compact icon={CheckCircle2} title="No low-stock products" description="Products whose available stock falls to their reorder level appear here." />
                ) : (
                  <ul className="divide-y">
                    {(lowStock.data ?? []).map((p) => (
                      <li key={p.product_id} className="flex items-center gap-3 py-2.5 first:pt-0">
                        <div className="min-w-0 flex-1">
                          <Link to={`/inventory/stock/${p.product_id}`} className="block truncate text-sm font-medium hover:underline">{p.sku} — {p.product_name}</Link>
                          <span className="text-xs text-muted-foreground">Available {formatQty(p.available, p.base_unit)}{p.reorder_level !== null && ` · reorder at ${formatQty(p.reorder_level)}`}</span>
                        </div>
                        <StockStatusBadge status={p.stock_status} />
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        {canSales ? (
          <ChartCard title="Order Status" description="Sales orders created in the selected period" loading={salesOverview.loading} height={220}
            isEmpty={(salesOverview.data?.by_status ?? []).length === 0} emptyMessage="No sales orders in this period."
            table={{ headers: ['Status', 'Orders'], rows: (salesOverview.data?.by_status ?? []).map((s) => [ORDER_STATUS_LABELS[s.status] ?? s.status, s.count]) }}>
            <HorizontalBarChart seriesName="Orders" labelWidth={160} data={(salesOverview.data?.by_status ?? []).map((s) => ({ label: ORDER_STATUS_LABELS[s.status] ?? s.status, value: Number(s.count), color: TONE_FILL[ORDER_STATUS_TONE[s.status] ?? 'neutral'] }))} />
          </ChartCard>
        ) : (
          <PlaceholderCard title="Order Status" description="Sales orders by status" icon={ShoppingCart} emptyTitle="No sales order access" emptyDescription="Your role does not include sales order access." />
        )}
        <PlaceholderCard title="Sales by Channel" description="Order value by channel" icon={IndianRupee} emptyTitle="Not tracked by channel" emptyDescription="Invoices are not split by sales channel. See Billing Overview for invoiced value; order quantities are not revenue." />
        <Card>
          <CardHeader>
            <div><CardTitle>Recent Orders</CardTitle><CardDescription>Latest customer sales orders</CardDescription></div>
            {canSales && <Button variant="ghost" size="sm" asChild><Link to="/sales/orders">All orders <ArrowRight /></Link></Button>}
          </CardHeader>
          <CardContent className="pt-4">
            {!canSales ? <p className="text-sm text-muted-foreground">Your role does not include sales order access.</p>
              : recentOrders.loading ? <p className="text-sm text-muted-foreground">Loading…</p>
              : (recentOrders.data?.rows ?? []).length === 0 ? <EmptyState compact icon={ShoppingCart} title="No orders yet" description="Sales orders created from customer POs or manually appear here." />
              : (
                <ul className="divide-y">
                  {(recentOrders.data?.rows ?? []).map((o) => (
                    <li key={o.id} className="flex items-center gap-3 py-2.5 first:pt-0">
                      <div className="min-w-0 flex-1">
                        <Link to={`/sales/order-details?so=${o.id}`} className="block truncate text-sm font-medium hover:underline">{o.sales_order_number} · {o.customer_name_snapshot}</Link>
                        <span className="text-xs text-muted-foreground">{o.customer_po_number ? `PO ${o.customer_po_number}` : 'Manual order'}</span>
                      </div>
                      <SalesOrderStatusBadge status={o.order_status} />
                    </li>
                  ))}
                </ul>
              )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
