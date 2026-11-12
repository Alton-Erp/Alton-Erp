import { AlertTriangle, CheckCircle2, ClipboardList, IndianRupee, PackageCheck, Truck } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { barCardHeight } from '@/components/charts/chart-layout'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { money } from '@/features/billing/billing-model'
import { useDrill } from '@/features/drilldown/use-drill'
import { ListCard, ModuleDashboard } from '@/features/management/module-dashboard-shell'
import { formatDate, formatNumber } from '@/lib/format'
import { exclOk } from '@/services/gst-exclusive'

interface Data {
  total: number
  open: number
  overdue: number
  period_value: number
  period_orders: number
  outstanding_receipt_value: number
  partially_received: number
  fully_received: number
  overdue_list: { id: string; po_number: string; supplier: string; expected: string }[]
  top_suppliers: { supplier: string; value: number; orders: number }[]
}

/** /purchase-orders/dashboard */
export default function PurchaseDashboardPage() {
  const { href } = useDrill('purchase')
  const navigate = useNavigate()
  return (
    <ModuleDashboard<Data> module="PURCHASE" exclGst="PURCHASE" title="Purchase Orders Dashboard" description="Orders placed with suppliers, what is still to arrive and what is late."
      actions={<Button asChild><Link to="/purchase-orders/new"><ClipboardList /> New purchase order</Link></Button>}>
      {(d, p, ex) => {
        const x = exclOk(ex?.purchase) ? ex.purchase : null
        const top = x?.top_suppliers.slice(0, 8) ?? []
        return (
        <div className="space-y-6">
          <section aria-label="Purchase figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard to={href('purchase.total', p)} label="Total POs" value={formatNumber(d.total)} hint={`${d.period_orders} placed in the period`} icon={ClipboardList} />
            <KpiCard to={href('purchase.open', p)} label="Open POs" value={formatNumber(d.open)} icon={ClipboardList} accent="pending" />
            <KpiCard to={href('purchase.partial', p)} label="Partially Received POs" value={formatNumber(d.partially_received)} icon={PackageCheck} accent="pending" />
            <KpiCard to={href('purchase.received', p)} label="Fully Received POs" value={formatNumber(d.fully_received)} icon={CheckCircle2} accent="available" />
            <KpiCard to={href('purchase.pending_value', p)} label="Pending Purchase Value (Excl. GST)" value={x ? money(x.outstanding_receipt_value) : '—'} hint="Still to be received, taxable value" icon={Truck} />
            <KpiCard to={href('purchase.overdue', p)} label="Overdue Deliveries" value={formatNumber(d.overdue)} icon={AlertTriangle} accent={d.overdue ? 'shortage' : 'neutral'} />
            <KpiCard to={href('purchase.period', p)} label="Taxable Purchases" value={x ? money(x.period_value) : '—'} hint="Ordered in the period, GST excluded" icon={IndianRupee} />
          </section>
          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard title="Top suppliers" description="Purchase order value excl. GST in the period" isEmpty={top.length === 0} emptyMessage={x ? 'No purchase orders in this period.' : 'GST-exclusive values are not available yet.'}
              height={barCardHeight(top.length)}
              table={{ headers: ['Supplier', 'Value (excl. GST)', 'POs'], rows: top.map((s) => [s.supplier, money(s.value), s.orders]), links: top.map((s) => href('purchase.supplier', { ...p, segment: s.supplier })) }}
              drillHint={href('purchase.total') ? 'Click a supplier to open its purchase orders.' : undefined}>
              <HorizontalBarChart seriesName="PO value (excl. GST)" labelWidth={160} valueFormatter={(v) => money(v)} data={top.map((s) => ({ label: s.supplier, value: Number(s.value) }))}
                onSelect={href('purchase.total') ? (i) => { const to = href('purchase.supplier', { ...p, segment: top[i]?.supplier }); if (to) navigate(to) } : undefined} />
            </ChartCard>
            <ListCard title="Overdue deliveries" empty={d.overdue_list.length === 0} viewAll={href('purchase.overdue', p)}>
              <ul className="divide-y text-sm">{d.overdue_list.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/purchase-orders/${p.id}`}>{p.po_number} — {p.supplier}</Link>
                  <span className="shrink-0 text-xs text-shortage">expected {formatDate(p.expected)}</span></li>
              ))}</ul>
            </ListCard>
          </div>
        </div>
        )
      }}
    </ModuleDashboard>
  )
}
