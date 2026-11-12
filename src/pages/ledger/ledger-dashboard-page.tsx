import { BookUser, HandCoins, Users, UserPlus } from 'lucide-react'
import { Link } from 'react-router-dom'

import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { money } from '@/features/billing/billing-model'
import { useDrill } from '@/features/drilldown/use-drill'
import { ListCard, ModuleDashboard } from '@/features/management/module-dashboard-shell'
import { formatNumber } from '@/lib/format'
import { reviewText } from '@/services/gst-exclusive'

interface Data {
  customers: number
  suppliers: number
  both: number
  parties: number
  receivables: number
  payables: number
  customer_advances: number
  with_balance: number
  outstanding: { party_id: string; party_code: string; name: string; receivable: number; payable: number }[]
  top_customers: { party_id: string; name: string; invoiced: number }[]
  top_suppliers: { party_id: string; name: string; received: number }[]
}

/** /ledger/dashboard */
export default function LedgerDashboardPage() {
  const { href } = useDrill('ledger')
  return (
    <ModuleDashboard<Data> module="LEDGER" exclGst="LEDGER" title="Ledger Dashboard" description="Customers and suppliers, what they owe you and what you owe them (excl. GST). Payables come from goods received, not purchase orders. The ledger balances themselves are unchanged."
      actions={<Button asChild><Link to="/ledger/new"><UserPlus /> Add party</Link></Button>}>
      {(d, p, ex) => {
        const amt = (v: number | null | undefined) => (ex && v !== null && v !== undefined ? money(v) : '—')
        const byParty = ex?.by_party ?? {}
        const topCust = new Map((ex?.top_customers ?? []).map((t) => [t.party_id, t.invoiced]))
        const topSup = new Map((ex?.top_suppliers ?? []).map((t) => [t.party_id, t.received]))
        const balance = (v: number | null | undefined, status: string | undefined) => (status === 'REVIEW' ? 'review (payments not split)' : amt(v))
        return (
        <div className="space-y-6">
          <section aria-label="Ledger figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard to={href('ledger.customers', p)} label="Total Customers" value={formatNumber(d.customers)} icon={Users} />
            <KpiCard to={href('ledger.suppliers', p)} label="Total Suppliers" value={formatNumber(d.suppliers)} icon={Users} />
            <KpiCard to={href('ledger.both', p)} label="Customer and Supplier" value={formatNumber(d.both)} hint="One party in both roles" icon={BookUser} />
            <KpiCard to={href('ledger.with_balance', p)} label="Outstanding Balances" value={formatNumber(d.with_balance)} hint="Parties with a balance" icon={HandCoins} />
            <KpiCard to={href('ledger.receivables', p)} label="Outstanding Receivables (Excl. GST)" value={amt(ex?.receivables_excl_gst)}
              hint={reviewText(ex?.receivables_review, 'customer balance(s) with payments or opening balances', money) ?? (d.customer_advances ? `Advances ${money(d.customer_advances)} not netted` : 'Taxable value of unpaid invoices less credit notes')} icon={HandCoins} accent="available" />
            <KpiCard to={href('ledger.payables', p)} label="Outstanding Payables (Excl. GST)" value={amt(ex?.payables_excl_gst)}
              hint={reviewText(ex?.payables_review, 'supplier balance(s) with payments or opening balances', money) ?? 'Taxable value of goods received, not yet paid'} icon={HandCoins} accent="shortage" />
          </section>
          <div className="grid gap-6 xl:grid-cols-3">
            <ListCard title="Outstanding balances" empty={d.outstanding.length === 0} viewAll={href('ledger.with_balance', p)}>
              <ul className="divide-y text-sm">{d.outstanding.map((p) => (
                <li key={p.party_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/ledger/${p.party_id}`}>{p.name}</Link>
                  <span className="shrink-0 text-right tabular-nums">{Number(p.receivable) ? `Receivable ${balance(byParty[p.party_id]?.receivable_excl_gst, byParty[p.party_id]?.receivable_status)}` : ''}{Number(p.receivable) && Number(p.payable) ? ' · ' : ''}{Number(p.payable) ? `Payable ${balance(byParty[p.party_id]?.payable_excl_gst, byParty[p.party_id]?.payable_status)}` : ''}</span></li>
              ))}</ul>
            </ListCard>
            <ListCard title="Top customers" description="Taxable value invoiced in the period" empty={d.top_customers.length === 0}>
              <ul className="divide-y text-sm">{d.top_customers.map((p) => (
                <li key={p.party_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/ledger/${p.party_id}`}>{p.name}</Link><span className="tabular-nums">{amt(topCust.get(p.party_id))}</span></li>
              ))}</ul>
            </ListCard>
            <ListCard title="Top suppliers" description="Taxable value of goods received in the period" empty={d.top_suppliers.length === 0}>
              <ul className="divide-y text-sm">{d.top_suppliers.map((p) => (
                <li key={p.party_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/ledger/${p.party_id}`}>{p.name}</Link><span className="tabular-nums">{amt(topSup.get(p.party_id))}</span></li>
              ))}</ul>
            </ListCard>
          </div>
        </div>
        )
      }}
    </ModuleDashboard>
  )
}
