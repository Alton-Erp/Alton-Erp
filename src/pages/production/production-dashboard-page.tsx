import {
  AlertTriangle, Boxes, CalendarDays, CalendarRange, ClipboardList, Factory, Hourglass, PackageCheck, PackageMinus, Plus, ShoppingCart, Upload, XCircle,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatQty } from '@/features/inventory/inventory-model'
import { EVENT_LABELS } from '@/features/production/production-model'
import { V2_EVENT_LABELS, formatByUnit } from '@/features/production/production-v2-model'
import { useAsync } from '@/hooks/use-async'
import { getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchProductionDashboard, type ProductionDashboard } from '@/services/production-v2'
import type { DateRangeValue } from '@/types'

const eventLabel = (t: string) => V2_EVENT_LABELS[t] ?? EVENT_LABELS[t] ?? t.replace(/_/g, ' ').toLowerCase()

function eventDetail(e: ProductionDashboard['recent'][number]): string {
  const d = e.details as Record<string, unknown>
  if (e.event_type === 'PRODUCTION_RECORDED') return `${formatQty(Number(d.accepted ?? 0), e.unit)} accepted${Number(d.rejected ?? 0) > 0 ? `, ${formatQty(Number(d.rejected))} rejected` : ''}${Number(d.wastage ?? 0) > 0 ? `, ${formatQty(Number(d.wastage))} wasted` : ''}`
  if (e.event_type === 'CREATED' && d.planned_quantity) return `${formatQty(Number(d.planned_quantity), e.unit)} planned`
  return e.note ?? ''
}

/** /production — production at a glance: output, consumption, shortages and recent activity. */
export default function ProductionDashboardPage() {
  const { has } = usePermissions()
  const [period, setPeriod] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const dash = useAsync(() => fetchProductionDashboard(toIsoDate(period.from), toIsoDate(period.to)), [period.from.getTime(), period.to.getTime()])
  const d = dash.data
  const v = (fn: (x: ProductionDashboard) => string) => (d ? fn(d) : null)

  return (
    <>
      <PageHeader
        title="Production Dashboard"
        description="Production orders, output, material consumption and shortages. Stock changes only when production is completed."
        actions={has('production_order.create') && (
          <>
            <Button variant="outline" asChild><Link to="/production/import"><Upload /> Import from Excel</Link></Button>
            <Button asChild><Link to="/production/new"><Plus /> New production</Link></Button>
          </>
        )}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <DateRangeFilter value={period} onChange={setPeriod} />
        <span className="text-xs text-muted-foreground">Today and monthly figures always use the current day and month.</span>      </div>
      {dash.error && <Card className="mb-6"><ErrorState message={describeDataError(dash.error)} onRetry={dash.reload} /></Card>}

      <section aria-label="Production summary" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard label="Total Production Orders" value={v((x) => formatNumber(x.orders))} hint={d ? `${d.orders_completed} completed in the period · ${d.open_orders} open` : 'In the period'} icon={ClipboardList} />
        <KpiCard label="Production Today" value={v((x) => formatByUnit(x.produced_today))} hint="Accepted into stock today" icon={CalendarDays} accent="manufacturing" />
        <KpiCard label="Monthly Production" value={v((x) => formatByUnit(x.produced_month))} hint="Accepted this month" icon={CalendarRange} accent="manufacturing" />
        <KpiCard label="Finished Goods Produced" value={v((x) => formatByUnit(x.finished_goods))} hint="Finished goods accepted in the period" icon={PackageCheck} accent="available" />
        <KpiCard label="Raw Materials Consumed" value={v((x) => formatByUnit(x.raw_materials))} hint="Actual consumption in the period" icon={PackageMinus} />
        <KpiCard label="Components Consumed" value={v((x) => formatByUnit(x.components))} hint="Components, sub-assemblies, outsourced parts, packing" icon={Boxes} />
        <KpiCard label="Production Shortages" value={v((x) => formatNumber(x.shortages.length))} hint="Materials short for open orders" icon={AlertTriangle} accent={d && d.shortages.length > 0 ? 'shortage' : 'neutral'} />
        <KpiCard label="Rejected Quantity" value={v((x) => formatByUnit(x.rejected))} hint={d ? `Wastage ${formatByUnit(d.wastage)}` : 'In the period'} icon={XCircle} accent={d && d.rejected.length > 0 ? 'shortage' : 'neutral'} />
        <KpiCard label="Pending Production" value={v((x) => formatByUnit(x.pending))} hint={d ? `${d.open_orders} open order(s) still to produce` : undefined} icon={Hourglass} accent="pending" />
      </section>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="overflow-hidden xl:col-span-3">
          <CardHeader>
            <div><CardTitle>Material shortages</CardTitle><CardDescription>Still needed by open orders, minus what is reserved for them and free stock. Purchase the shortage quantity.</CardDescription></div>
            {d && d.shortages.length > 0 && has('purchase_order.create') && <Button size="sm" variant="outline" asChild><Link to="/purchase-orders/new"><ShoppingCart /> Create purchase order</Link></Button>}
          </CardHeader>
          {!d ? <CardContent><p className="text-sm text-muted-foreground">{dash.loading ? 'Loading…' : '—'}</p></CardContent>
            : d.shortages.length === 0 ? <CardContent><p className="text-sm text-muted-foreground">No shortages: every open order has its materials reserved or available.</p></CardContent>
            : (
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent">
                  <TableHead>Material</TableHead><TableHead className="text-right">Still needed</TableHead><TableHead className="text-right">Reserved</TableHead>
                  <TableHead className="text-right">Available</TableHead><TableHead className="text-right">Purchase</TableHead><TableHead className="text-right">Orders</TableHead>
                </TableRow></TableHeader>
                <TableBody>{d.shortages.map((s) => (
                  <TableRow key={s.component_product_id}>
                    <TableCell><span className="font-medium">{s.sku}</span><span className="block text-xs text-muted-foreground">{s.product_name}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(s.needed, s.unit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(s.reserved)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQty(s.available)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-shortage">{formatQty(s.shortage, s.unit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{s.orders}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            )}
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader><div><CardTitle className="flex items-center gap-2"><Factory className="size-4" /> Recent production activity</CardTitle><CardDescription>Latest changes on production orders.</CardDescription></div></CardHeader>
          <CardContent>
            {!d ? <p className="text-sm text-muted-foreground">{dash.loading ? 'Loading…' : '—'}</p>
              : d.recent.length === 0 ? <p className="text-sm text-muted-foreground">No production activity yet.</p>
              : (
                <ol className="space-y-3 border-l pl-4">{d.recent.map((e) => (
                  <li key={e.id} className="relative text-sm">
                    <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-gray-400" />
                    <p><Link className="font-medium text-primary hover:underline" to={`/production/orders/${e.order_id}`}>{e.production_order_number}</Link> · {eventLabel(e.event_type)}</p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(e.created_at)} · {e.sku} — {e.product_name}</p>
                    {eventDetail(e) && <p className="text-xs">{eventDetail(e)}</p>}
                  </li>
                ))}</ol>
              )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
