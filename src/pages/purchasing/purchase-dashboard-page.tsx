import { AlertTriangle, CheckCircle2, ClipboardList, IndianRupee, PackageCheck, Truck } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { money } from '@/features/billing/billing-model'
import { useDrill } from '@/features/drilldown/use-drill'
import { ListCard, ModuleDashboard } from '@/features/management/module-dashboard-shell'
import { formatDate, formatNumber } from '@/lib/format'

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
    <ModuleDashboard<Data> module="PURCHASE" title="Purchase Orders Dashboard" description="Orders placed with suppliers, what is still to arrive and what is late."
      actions={<Button asChild><Link to="/purchase-orders/new"><ClipboardList /> New purchase order</Link></Button>}>
      {(d, p) => (
        <div className="space-y-6">
          <section aria-label="Purchase figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard to={href('purchase.total', p)} label="Total POs" value={formatNumber(d.total)} hint={`${d.period_orders} placed in the period`} icon={ClipboardList} />
            <KpiCard to={href('purchase.open', p)} label="Open POs" value={formatNumber(d.open)} icon={ClipboardList} accent="pending" />
            <KpiCard to={href('purchase.partial', p)} label="Partially Received POs" value={formatNumber(d.partially_received)} icon={PackageCheck} accent="pending" />
            <KpiCard to={href('purchase.received', p)} label="Fully Received POs" value={formatNumber(d.fully_received)} icon={CheckCircle2} accent="available" />
            <KpiCard to={href('purchase.pending_value', p)} label="Pending Purchase Value" value={money(d.outstanding_receipt_value)} hint="Still to be received" icon={Truck} />
            <KpiCard to={href('purchase.overdue', p)} label="Overdue Deliveries" value={formatNumber(d.overdue)} icon={AlertTriangle} accent={d.overdue ? 'shortage' : 'neutral'} />
            <KpiCard to={href('purchase.period', p)} label="Ordered in Period" value={money(d.period_value)} icon={IndianRupee} />
          </section>
          <div className="grid gap-6 xl:grid-cols-2">
            <ChartCard title="Top suppliers" description="Purchase order value in the period" isEmpty={d.top_suppliers.length === 0} emptyMessage="No purchase orders in this period."
              table={{ headers: ['Supplier', 'Value', 'POs'], rows: d.top_suppliers.map((s) => [s.supplier, money(s.value), s.orders]), links: d.top_suppliers.map((s) => href('purchase.supplier', { ...p, segment: s.supplier })) }}
              drillHint={href('purchase.total') ? 'Click a supplier to open its purchase orders.' : undefined}>
              <HorizontalBarChart seriesName="PO value" labelWidth={160} valueFormatter={(v) => money(v)} data={d.top_suppliers.map((s) => ({ label: s.supplier, value: Number(s.value) }))}
                onSelect={href('purchase.total') ? (i) => { const to = href('purchase.supplier', { ...p, segment: d.top_suppliers[i]?.supplier }); if (to) navigate(to) } : undefined} />
            </ChartCard>
            <ListCard title="Overdue deliveries" empty={d.overdue_list.length === 0} viewAll={href('purchase.overdue', p)}>
              <ul className="divide-y text-sm">{d.overdue_list.map((p) => (
                <li key={p.id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/purchase-orders/${p.id}`}>{p.po_number} — {p.supplier}</Link>
                  <span className="shrink-0 text-xs text-shortage">expected {formatDate(p.expected)}</span></li>
              ))}</ul>
            </ListCard>
          </div>
        </div>
      )}
    </ModuleDashboard>
  )
}
