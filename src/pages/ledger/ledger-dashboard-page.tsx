import { BookUser, HandCoins, Users, UserPlus } from 'lucide-react'
import { Link } from 'react-router-dom'

import { KpiCard } from '@/components/common/kpi-card'
import { Button } from '@/components/ui/button'
import { money } from '@/features/billing/billing-model'
import { ListCard, ModuleDashboard } from '@/features/management/module-dashboard-shell'
import { formatNumber } from '@/lib/format'

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
  return (
    <ModuleDashboard<Data> module="LEDGER" title="Ledger Dashboard" description="Customers and suppliers, what they owe you and what you owe them. Payables come from goods received, not purchase orders."
      actions={<Button asChild><Link to="/ledger/new"><UserPlus /> Add party</Link></Button>}>
      {(d) => (
        <div className="space-y-6">
          <section aria-label="Ledger figures" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Total Customers" value={formatNumber(d.customers)} icon={Users} />
            <KpiCard label="Total Suppliers" value={formatNumber(d.suppliers)} icon={Users} />
            <KpiCard label="Customer and Supplier" value={formatNumber(d.both)} hint="One party in both roles" icon={BookUser} />
            <KpiCard label="Outstanding Balances" value={formatNumber(d.with_balance)} hint="Parties with a balance" icon={HandCoins} />
            <KpiCard label="Customer Receivables" value={money(d.receivables)} hint={d.customer_advances ? `Advances ${money(d.customer_advances)} not netted` : 'Incl. opening balances'} icon={HandCoins} accent="available" />
            <KpiCard label="Supplier Payables" value={money(d.payables)} hint="Goods received − payments, incl. opening" icon={HandCoins} accent="shortage" />
          </section>
          <div className="grid gap-6 xl:grid-cols-3">
            <ListCard title="Outstanding balances" empty={d.outstanding.length === 0}>
              <ul className="divide-y text-sm">{d.outstanding.map((p) => (
                <li key={p.party_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/ledger/${p.party_id}`}>{p.name}</Link>
                  <span className="shrink-0 text-right tabular-nums">{Number(p.receivable) ? `Receivable ${money(p.receivable)}` : ''}{Number(p.receivable) && Number(p.payable) ? ' · ' : ''}{Number(p.payable) ? `Payable ${money(p.payable)}` : ''}</span></li>
              ))}</ul>
            </ListCard>
            <ListCard title="Top customers" description="Invoiced in the period" empty={d.top_customers.length === 0}>
              <ul className="divide-y text-sm">{d.top_customers.map((p) => (
                <li key={p.party_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/ledger/${p.party_id}`}>{p.name}</Link><span className="tabular-nums">{money(p.invoiced)}</span></li>
              ))}</ul>
            </ListCard>
            <ListCard title="Top suppliers" description="Goods received in the period" empty={d.top_suppliers.length === 0}>
              <ul className="divide-y text-sm">{d.top_suppliers.map((p) => (
                <li key={p.party_id} className="flex justify-between gap-2 py-1.5"><Link className="truncate text-primary hover:underline" to={`/ledger/${p.party_id}`}>{p.name}</Link><span className="tabular-nums">{money(p.received)}</span></li>
              ))}</ul>
            </ListCard>
          </div>
        </div>
      )}
    </ModuleDashboard>
  )
}
