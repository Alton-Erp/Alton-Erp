import { AlertTriangle, CalendarDays, ClipboardList, PackageCheck, PackagePlus, Unlink } from 'lucide-react'
import { Link } from 'react-router-dom'

import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { money } from '@/features/billing/billing-model'
import { unitsText } from '@/features/management/report-defs'
import { ListCard, ModuleDashboard } from '@/features/management/module-dashboard-shell'
import { formatDate, formatNumber } from '@/lib/format'

interface Data {
  total: number
  today: number
  month: number
  in_period: number
  value_in_period: number
  pending_orders: number
  pending_value: number
  rejected: { unit: string; quantity: number }[]
  unlinked: number
  reversed: number
  recent_items: { receipt_id: string; receipt_number: string; receipt_date: string; sku: string | null; product_name: string | null; unit: string; accepted: number; rejected: number; direct: boolean }[]
}

/** /goods-receipts/dashboard */
export default function GrnDashboardPage() {
  return (
    <ModuleDashboard<Data> module="GRN" title="Goods Received Dashboard" description="Goods received into stock, what is still pending on purchase orders, rejections and receipts without a PO."
      actions={<Button asChild><Link to="/goods-receipts?receive=po"><PackagePlus /> Receive goods</Link></Button>}>
      {(d) => (
        <div className="space-y-6">
          <section aria-label="Goods received figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total GRNs" value={formatNumber(d.total)} hint={`${d.reversed} reversed (not counted)`} icon={PackageCheck} />
            <KpiCard label="GRNs Today" value={formatNumber(d.today)} icon={CalendarDays} />
            <KpiCard label="Monthly GRNs" value={formatNumber(d.month)} hint="This calendar month" icon={CalendarDays} />
            <KpiCard label="Received in Period" value={money(d.value_in_period)} hint={`${d.in_period} GRN(s)`} icon={PackageCheck} accent="available" />
            <KpiCard label="Pending Receipts" value={formatNumber(d.pending_orders)} hint={`${money(d.pending_value)} still to be received`} icon={ClipboardList} accent="pending" />
            <KpiCard label="Rejected Goods" value={unitsText(d.rejected)} hint="In the period" icon={AlertTriangle} accent="shortage" />
            <KpiCard label="Unlinked GRNs" value={formatNumber(d.unlinked)} hint="Received without a purchase order" icon={Unlink} />
          </section>
          <ListCard title="Recently received items" empty={d.recent_items.length === 0}>
            <table className="w-full text-sm" aria-label="Recently received items"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">GRN</th><th className="pb-1 text-left">Date</th>
              <th className="pb-1 text-left">Item</th><th className="pb-1 text-right">Accepted</th><th className="pb-1 text-right">Rejected</th></tr></thead>
              <tbody>{d.recent_items.map((r, i) => (
                <tr key={r.receipt_id + i} className="border-t"><td className="py-1.5"><Link className="text-primary hover:underline" to={`/goods-receipts/${r.receipt_id}`}>{r.receipt_number}</Link>{r.direct && <span className="ml-1 text-xs text-muted-foreground">(no PO)</span>}</td>
                  <td className="py-1.5">{formatDate(r.receipt_date)}</td><td className="py-1.5">{r.sku ?? '—'} {r.product_name ? `— ${r.product_name}` : ''}</td>
                  <td className="py-1.5 text-right tabular-nums">{Number(r.accepted)} {r.unit}</td><td className="py-1.5 text-right tabular-nums">{Number(r.rejected) || ''}</td></tr>
              ))}</tbody></table>
          </ListCard>
        </div>
      )}
    </ModuleDashboard>
  )
}
