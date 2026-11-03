import { Printer, ScrollText } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BillingExport } from '@/features/billing/billing-export'
import { financialYearRange, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { fetchStatement, type CustomerStatement } from '@/services/billing'

type Entry = CustomerStatement['entries'][number]

export default function StatementsPage() {
  const [params, setParams] = useSearchParams()
  const customer = params.get('customer') ?? ''
  const [from, setFrom] = useState(() => financialYearRange(new Date()).from)
  const [to, setTo] = useState(() => toIsoDate(new Date()))
  const st = useAsync(() => (customer && from && to ? fetchStatement(customer, from, to) : Promise.resolve(null)), [customer, from, to])
  const s = st.data
  const dc = (v: number) => (Number(v) ? money(v, false) : '')

  return (
    <>
      <div className="print-hidden">
        <PageHeader actions={<>
          {s && <BillingExport<Entry> title="Statement" fileStem={`statement-${s.customer.customer_code}-${s.from}-${s.to}`} rows={s.entries} columns={[
            { header: 'Date', value: (e) => e.date }, { header: 'Document', value: (e) => e.document }, { header: 'Description', value: (e) => e.description },
            { header: 'Debit', value: (e) => Number(e.debit) }, { header: 'Credit', value: (e) => Number(e.credit) }, { header: 'Balance', value: (e) => Number(e.balance) },
          ]} />}
          <Button variant="outline" disabled={!s} onClick={() => window.print()}><Printer /> Print</Button>
        </>} />
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="space-y-1"><Label htmlFor="st-cust">Customer</Label><CustomerSelect id="st-cust" value={customer} onChange={(v) => setParams({ customer: v }, { replace: true })} /></div>
            <div className="space-y-1"><Label htmlFor="st-from">From</Label><Input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="st-to">To</Label><Input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            <p className="text-xs text-muted-foreground">To save a PDF, print and choose "Save as PDF". Issued invoices and debit notes are debits; issued credit notes and recorded receipts are credits; cancellations and reversals appear as their own entries.</p>
          </CardContent>
        </Card>
      </div>
      {!customer ? <Card><EmptyState icon={ScrollText} title="Choose a customer" description="The statement is built from issued documents and recorded receipts." /></Card>
        : st.loading ? <LoadingState variant="cards" rows={2} />
        : st.error || !s ? <Card><ErrorState message={describeDataError(st.error)} onRetry={st.reload} /></Card> : (
          <article className="print-area mx-auto max-w-[210mm] border bg-white p-8 text-xs leading-snug text-gray-900 shadow-sm">
            <header className="flex flex-wrap items-start justify-between gap-6 border-b pb-3">
              <div><p className="text-base font-bold">{s.company.legal_name}</p><p className="whitespace-pre-line">{s.company.legal_address ?? ''}</p>{s.company.gstin && <p>GSTIN: {s.company.gstin}</p>}</div>
              <div className="text-right"><p className="text-base font-bold">STATEMENT OF ACCOUNT</p><p>{formatDate(s.from)} – {formatDate(s.to)}</p><p className="text-gray-500">Generated {formatDateTime(s.generated_at)}</p></div>
            </header>
            <section className="border-b py-3">
              <p className="font-semibold">{s.customer.name} ({s.customer.customer_code})</p>
              <p className="whitespace-pre-line">{s.customer.billing_address ?? ''}</p>{s.customer.gstin && <p>GSTIN: {s.customer.gstin}</p>}
            </section>
            <table className="mt-3 w-full">
              <thead><tr className="border-b text-left"><th className="py-1">Date</th><th className="py-1">Document</th><th className="py-1">Description</th><th className="py-1 text-right">Debit</th><th className="py-1 text-right">Credit</th><th className="py-1 text-right">Balance</th></tr></thead>
              <tbody>
                <tr className="border-b"><td className="py-1">{formatDate(s.from)}</td><td /><td className="py-1 font-medium">Opening balance</td><td /><td /><td className="py-1 text-right font-medium">{money(s.opening_balance, false)}</td></tr>
                {s.entries.map((e, idx) => (
                  <tr key={`${e.document}-${idx}`} className="border-b border-gray-100">
                    <td className="py-1">{formatDate(e.date)}</td><td className="py-1">{e.document}</td><td className="py-1">{e.description}</td>
                    <td className="py-1 text-right">{dc(e.debit)}</td><td className="py-1 text-right">{dc(e.credit)}</td><td className="py-1 text-right">{money(e.balance, false)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 font-semibold"><td className="py-1">{formatDate(s.to)}</td><td /><td className="py-1">Closing balance</td><td /><td /><td className="py-1 text-right">{money(s.closing_balance)}</td></tr>
              </tbody>
            </table>
            {s.entries.length === 0 && <p className="mt-2 text-gray-500">No transactions in this period.</p>}
            <p className="mt-4 text-gray-600">A positive balance is owed by the customer; a negative balance is a credit in the customer's favour.{Number(s.unallocated_receipts) ? ` ${money(s.unallocated_receipts)} of the customer's receipts (all dates) is not yet allocated to specific invoices.` : ''} Receipts are as recorded and are not bank-verified.</p>
          </article>
        )}
    </>
  )
}
