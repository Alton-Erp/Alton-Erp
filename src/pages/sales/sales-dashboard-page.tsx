import {
  AlertTriangle, Ban, CalendarDays, CalendarRange, CheckCircle2, ClipboardList, Factory, Hourglass, IndianRupee, Lock, PackageCheck, Plus, ShoppingCart, Truck, Upload,
} from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { formatByUnit } from '@/features/production/production-v2-model'
import { SO_V2_STATUS, soStatusMeta, type SoV2Status } from '@/features/sales/sales-v2-model'
import { useDrill, useUrlDateRange, useUrlParam } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { fetchCustomers } from '@/services/customer-po'
import { fetchSalesDashboard, type SalesDashboard } from '@/services/sales-v2'

/** /sales/dashboard — orders, value, reservations, production need, shortages and fulfilment. */
export default function SalesDashboardPage() {
  const navigate = useNavigate()
  const { has } = usePermissions()
  // Filters kept in the address, so Back from a drill-down page keeps them.
  const [period, setPeriod] = useUrlDateRange('this_month')
  const [customer, setCustomer] = useUrlParam('customer', 'all')
  const [status, setStatus] = useUrlParam('status', 'all')
  const { href } = useDrill('sales')
  const customers = useAsync(() => fetchCustomers(true).catch(() => []), [])
  const dash = useAsync(() => fetchSalesDashboard(toIsoDate(period.from), toIsoDate(period.to), customer === 'all' ? null : customer, status === 'all' ? null : status),
    [period.from.getTime(), period.to.getTime(), customer, status])
  const d = dash.data
  const v = (fn: (x: SalesDashboard) => string) => (d ? fn(d) : null)
  const ctx = { from: toIsoDate(period.from), to: toIsoDate(period.to), customer: customer === 'all' ? null : customer, status: status === 'all' ? null : status, ...(d?.today ? { today: d.today } : {}) }
  const to = (key: string) => href(key, ctx)

  return (
    <>
      <PageHeader title="Sales Dashboard" description="Sales orders, reserved stock, what must still be produced and what is short. Reservations never move stock; only dispatch does."
        actions={has('sales_orders.create') && (
          <>
            <Button variant="outline" asChild><Link to="/sales/orders/import"><Upload /> Import from Excel</Link></Button>
            <Button asChild><Link to="/sales/orders/new"><Plus /> New sales order</Link></Button>
          </>
        )} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <DateRangeFilter value={period} onChange={setPeriod} />
        <div className="w-56 space-y-1"><Label htmlFor="sd-customer" className="text-xs">Customer</Label>
          <Select value={customer} onValueChange={(x) => { if (x) setCustomer(x) }}>
            <SelectTrigger id="sd-customer"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72"><SelectItem value="all">All customers</SelectItem>
              {(customers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent>
          </Select></div>
        <div className="w-52 space-y-1"><Label htmlFor="sd-status" className="text-xs">Order status</Label>
          <Select value={status} onValueChange={(x) => { if (x) setStatus(x) }}>
            <SelectTrigger id="sd-status"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All statuses</SelectItem>
              {(Object.keys(SO_V2_STATUS) as SoV2Status[]).map((s) => <SelectItem key={s} value={s}>{SO_V2_STATUS[s].label}</SelectItem>)}</SelectContent>
          </Select></div>
      </div>
      {dash.error && <Card className="mb-6"><ErrorState message={describeDataError(dash.error)} onRetry={dash.reload} /></Card>}

      <section aria-label="Sales summary" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <KpiCard to={to('sales.total')} label="Total Sales Orders" value={v((x) => formatNumber(x.total_orders))} hint="Ordered in the period" icon={ClipboardList} />
        <KpiCard to={to('sales.today')} label="Orders Created Today" value={v((x) => formatNumber(x.created_today))} icon={CalendarDays} accent="manufacturing" />
        <KpiCard to={to('sales.month')} label="Orders This Month" value={v((x) => formatNumber(x.this_month))} icon={CalendarRange} />
        <KpiCard to={to('sales.value')} label="Total Sales Order Value" value={v((x) => money(x.total_value))} hint="Grand totals, cancelled orders excluded" icon={IndianRupee} accent="available" />
        <KpiCard to={to('sales.pending')} label="Pending Orders" value={v((x) => formatNumber(x.pending))} hint="Nothing dispatched yet" icon={Hourglass} accent="pending" />
        <KpiCard to={to('sales.partial')} label="Partially Fulfilled Orders" value={v((x) => formatNumber(x.partially_fulfilled))} icon={Truck} accent="pending" />
        <KpiCard to={to('sales.fulfilled')} label="Fully Fulfilled Orders" value={v((x) => formatNumber(x.fully_fulfilled))} icon={CheckCircle2} accent="available" />
        <KpiCard to={to('sales.cancelled')} label="Cancelled Orders" value={v((x) => formatNumber(x.cancelled))} icon={Ban} />
        <KpiCard to={to('sales.reserved')} label="Finished Goods Reserved" value={v((x) => formatByUnit(x.finished_goods_reserved))} hint="For open orders (still in the warehouse)" icon={Lock} accent="available" />
        <KpiCard to={has('manufacturing.read') ? '/production/planning' : null} label="Production Required" value={v((x) => formatByUnit(x.production_required))} hint={d ? `Not yet ordered · in production ${formatByUnit(d.production_required.map((p) => ({ unit: p.unit, quantity: p.in_production })))}` : undefined} icon={Factory} accent="manufacturing" />
        <KpiCard to={to('sales.shortages')} label="Raw Material Shortages" value={v((x) => formatNumber(x.shortages.length))} hint="Materials short for open orders" icon={AlertTriangle} accent={d && d.shortages.length > 0 ? 'shortage' : 'neutral'} />
        <KpiCard to={to('sales.awaiting')} label="Orders Awaiting Dispatch" value={v((x) => formatNumber(x.awaiting_dispatch))} hint="With reserved goods ready to go" icon={PackageCheck} accent="pending" />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader><div><CardTitle>Recent sales orders</CardTitle><CardDescription>Latest orders matching the filters.</CardDescription></div>
            <Button size="sm" variant="outline" asChild><Link to={to('sales.total') ?? '/sales/orders'}>All orders</Link></Button></CardHeader>
          {!d ? <CardContent><p className="text-sm text-muted-foreground">{dash.loading ? 'Loading…' : '—'}</p></CardContent>
            : d.recent.length === 0 ? <CardContent><p className="text-sm text-muted-foreground">No sales orders in this period.</p></CardContent> : (
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Order</TableHead><TableHead>Customer</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Value</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>{d.recent.map((o) => {
                  const s = soStatusMeta(o.status)
                  return (
                    <TableRow key={o.id} className="cursor-pointer" onClick={() => navigate(`/sales/orders/${o.id}`)}>
                      <TableCell className="font-medium"><Link to={`/sales/orders/${o.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{o.sales_order_number}</Link></TableCell>
                      <TableCell>{o.customer_name}</TableCell><TableCell>{formatDate(o.order_date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(o.grand_total)}</TableCell><TableCell><StatusBadge label={s.label} tone={s.tone} /></TableCell>
                    </TableRow>
                  )
                })}</TableBody>
              </Table>
            )}
        </Card>
        <Card>
          <CardHeader><div><CardTitle>Order fulfilment summary</CardTitle><CardDescription>Orders by status and quantities per unit (never added across units).</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">{d && (Object.keys(SO_V2_STATUS) as SoV2Status[]).filter((s) => d.by_status[s]).map((s) => (
              <button key={s} type="button" onClick={() => setStatus(s)} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">
                {SO_V2_STATUS[s].label}: <span className="font-semibold">{d.by_status[s]}</span></button>
            ))}{d && Object.keys(d.by_status).length === 0 && <span className="text-sm text-muted-foreground">No orders.</span>}</div>
            {d && d.ordered.length > 0 && (
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Unit</TableHead><TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Dispatched</TableHead><TableHead className="text-right">Pending</TableHead></TableRow></TableHeader>
                <TableBody>{d.ordered.map((u) => (
                  <TableRow key={u.unit}><TableCell>{u.unit}</TableCell><TableCell className="text-right tabular-nums">{formatQty(u.ordered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(u.dispatched)}</TableCell><TableCell className="text-right tabular-nums">{formatQty(u.pending)}</TableCell></TableRow>
                ))}</TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader><div><CardTitle>Stock shortages</CardTitle><CardDescription>Materials needed by open orders for what is still to be produced, after reservations and free stock. Incoming purchases count only once received.</CardDescription></div>
            <div className="flex gap-2">
              {d && d.shortages.length > 0 && to('sales.shortages') && <Button size="sm" variant="ghost" asChild><Link to={to('sales.shortages')!}>View all</Link></Button>}
              {d && d.shortages.length > 0 && has('purchase_order.create') && <Button size="sm" variant="outline" asChild><Link to="/purchase-orders/new"><ShoppingCart /> Create purchase order</Link></Button>}
            </div></CardHeader>
          {!d ? <CardContent><p className="text-sm text-muted-foreground">{dash.loading ? 'Loading…' : '—'}</p></CardContent>
            : d.shortages.length === 0 ? <CardContent><p className="text-sm text-muted-foreground">No material shortages for open orders.</p></CardContent> : (
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Item</TableHead><TableHead className="text-right">Required</TableHead><TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead><TableHead className="text-right">Shortage</TableHead><TableHead>Preferred supplier</TableHead><TableHead className="text-right">Orders</TableHead></TableRow></TableHeader>
                <TableBody>{d.shortages.map((s) => (
                  <TableRow key={s.product_id}>
                    <TableCell><Link className="font-medium text-primary hover:underline" to={`/inventory/stock/${s.product_id}`}>{s.sku}</Link> <span className="text-xs text-muted-foreground">{s.product_name}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(s.required, s.unit)}</TableCell><TableCell className="text-right tabular-nums">{formatQty(s.reserved)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(s.available)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-shortage">{formatQty(s.shortage, s.unit)}</TableCell>
                    <TableCell>{s.preferred_supplier_name ?? '—'}</TableCell><TableCell className="text-right tabular-nums">{s.orders}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
        </Card>
      </div>
    </>
  )
}
