import { AlarmClock, CheckCircle2, FilePen, FileText, HandCoins, Info, Receipt, RefreshCw, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InvoiceStatusBadge } from '@/features/billing/billing-badges'
import { BUCKET_LABELS, INVOICE_STATUS_LABELS, recentFinancialYears, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { fetchBillingOverview } from '@/services/billing'
import type { DateRangeValue } from '@/types'

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })
const BUCKET_FILL: Record<string, string> = { NOT_DUE: TONE_FILL.info, '1_30': TONE_FILL.warning, '31_60': TONE_FILL.warning, '61_90': TONE_FILL.danger, OVER_90: TONE_FILL.danger }

export default function BillingOverviewPage() {
  const { has } = usePermissions()
  const years = recentFinancialYears(5)
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [fy, setFy] = useState('none')
  const [customer, setCustomer] = useState('all')
  const [status, setStatus] = useState('all')
  const [payment, setPayment] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const year = years.find((y) => y.label === fy)
  const from = year?.from ?? toIsoDate(range.from)
  const to = year?.to ?? toIsoDate(range.to)
  const ov = useAsync(() => fetchBillingOverview({ from, to, customerId: customer === 'all' ? null : customer, status: status === 'all' ? null : status, paymentStatus: payment === 'all' ? null : payment }),
    [from, to, customer, status, payment, refresh])
  const d = ov.data

  const filters = (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="bo-fy">Financial year</Label>
          <Select value={fy} onValueChange={setFy}><SelectTrigger id="bo-fy" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">Use date range</SelectItem>{years.map((y) => <SelectItem key={y.label} value={y.label}>FY {y.label}</SelectItem>)}</SelectContent></Select></div>
        {fy === 'none' && <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />}
        <div className="space-y-1"><Label htmlFor="bo-cust">Customer</Label><CustomerSelect id="bo-cust" value={customer} onChange={setCustomer} allowAll /></div>
        <div className="space-y-1"><Label htmlFor="bo-status">Invoice status</Label>
          <Select value={status} onValueChange={setStatus}><SelectTrigger id="bo-status" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All issued</SelectItem>{['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'].map((s) => <SelectItem key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label htmlFor="bo-pay">Payment status</Label>
          <Select value={payment} onValueChange={setPayment}><SelectTrigger id="bo-pay" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="UNPAID">Unpaid</SelectItem><SelectItem value="PARTIALLY_PAID">Partially paid</SelectItem><SelectItem value="PAID">Paid</SelectItem></SelectContent></Select></div>
      </CardContent>
    </Card>
  )
  const header = <PageHeader actions={<>
    <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={ov.loading ? 'animate-spin' : undefined} /></Button>
    {has('invoices.create') && <Button asChild><Link to="/billing/invoices/new">Create invoice</Link></Button>}
  </>} />

  if (ov.loading && !d) return (<>{header}{filters}<LoadingState variant="cards" rows={8} /></>)
  if (ov.error || !d) return (<>{header}{filters}<Card><ErrorState message={describeDataError(ov.error)} onRetry={ov.reload} /></Card></>)
  const monthly = d.monthly.map((m) => ({ label: MONTH.format(new Date(`${m.month}T00:00:00`)), a: Number(m.invoiced), b: Number(m.collected) }))

  return (
    <>
      {header}
      {filters}
      {!d.has_records && <Card className="mb-6"><EmptyState icon={Receipt} title="No invoices yet" description="Invoices are created from dispatched quantities in Create Invoice. Nothing is invoiced automatically." /></Card>}
      <p className="mb-4 flex items-start gap-2 rounded-lg border bg-background px-4 py-2.5 text-sm"><Info className="mt-0.5 size-4 shrink-0" />
        Invoiced and received figures cover {formatDate(from)} – {formatDate(to)} (issued invoices and recorded receipts only; drafts and cancelled invoices are excluded). Outstanding, overdue and ageing are as of today ({formatDate(d.today)}). Receipts are as recorded by users, not bank-verified. Amounts in {d.currency}. As of {formatDateTime(d.as_of)}.
      </p>
      <section aria-label="Billing KPIs" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total Invoiced (period)" value={money(d.invoiced_total)} hint="Grand total of issued invoices" icon={Receipt} accent="manufacturing" />
        <KpiCard label="Amount Received (period)" value={money(d.received_total)} hint="Recorded receipts (not bank-verified)" icon={Wallet} accent="available" />
        <KpiCard label="Outstanding Receivables" value={money(d.outstanding_total)} hint={Number(d.customer_credit_total) ? `Customer credits ${money(d.customer_credit_total)} not netted` : 'Open invoice balances today'} icon={HandCoins} accent="pending" />
        <KpiCard label="Overdue Receivables" value={money(d.overdue_total)} hint="Past due date" icon={AlarmClock} accent="shortage" />
        <KpiCard label="Invoices Issued (period)" value={formatNumber(d.invoices_issued)} hint="By invoice date" icon={FileText} />
        <KpiCard label="Drafts Awaiting Issue" value={formatNumber(d.drafts_awaiting)} hint={`${d.pending_approval} pending approval`} icon={FilePen} accent="pending" />
        <KpiCard label="Partially Paid Invoices" value={formatNumber(d.partially_paid)} hint="Issued in the period" icon={HandCoins} accent="pending" />
        <KpiCard label="Fully Paid Invoices" value={formatNumber(d.fully_paid)} hint={`Issued in the period · unallocated receipts ${money(d.unallocated_receipts_total)}`} icon={CheckCircle2} accent="available" />
      </section>
      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Monthly invoicing vs collections" description="Issued invoice totals and recorded receipts per month" isEmpty={monthly.every((m) => !m.a && !m.b)} emptyMessage="No invoices or receipts in this period."
          table={{ headers: ['Month', 'Invoiced', 'Collected'], rows: monthly.map((m) => [m.label, money(m.a), money(m.b)]) }}>
          <PairedBarChart aName="Invoiced" bName="Collected" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => money(v)} data={monthly} />
        </ChartCard>
        <ChartCard title="Receivables ageing" description="Open balances by days overdue (today)" isEmpty={d.ageing.every((a) => !Number(a.amount))} emptyMessage="Nothing outstanding."
          table={{ headers: ['Bucket', 'Amount', 'Invoices'], rows: d.ageing.map((a) => [BUCKET_LABELS[a.bucket], money(a.amount), a.invoices]) }}>
          <HorizontalBarChart seriesName="Outstanding" valueFormatter={(v) => money(v)} data={d.ageing.map((a) => ({ label: BUCKET_LABELS[a.bucket], value: Number(a.amount), color: BUCKET_FILL[a.bucket] }))} />
        </ChartCard>
        <ChartCard title="Outstanding by customer" description="Top 10 open balances today" isEmpty={d.outstanding_by_customer.length === 0} emptyMessage="Nothing outstanding."
          table={{ headers: ['Customer', 'Outstanding', 'Overdue'], rows: d.outstanding_by_customer.map((c) => [c.customer_name, money(c.balance), money(c.overdue ?? 0)]) }}>
          <HorizontalBarChart seriesName="Outstanding" labelWidth={170} valueFormatter={(v) => money(v)} data={d.outstanding_by_customer.map((c) => ({ label: c.customer_name, value: Number(c.balance) }))} />
        </ChartCard>
        <ChartCard title="Top customers by invoiced value" description="Issued in the period" isEmpty={d.top_customers.length === 0} emptyMessage="No invoices in this period."
          table={{ headers: ['Customer', 'Invoiced', 'Invoices'], rows: d.top_customers.map((c) => [c.customer_name, money(c.invoiced), c.invoices]) }}>
          <HorizontalBarChart seriesName="Invoiced" labelWidth={170} valueFormatter={(v) => money(v)} data={d.top_customers.map((c) => ({ label: c.customer_name, value: Number(c.invoiced), color: TONE_FILL.info }))} />
        </ChartCard>
        <Card>
          <CardHeader><CardTitle>Recent invoices</CardTitle></CardHeader>
          <CardContent>{d.recent_invoices.length === 0 ? <p className="text-sm text-muted-foreground">No issued invoices.</p> : (
            <ul className="divide-y text-sm">{d.recent_invoices.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2"><Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${r.id}`}>{r.invoice_number}</Link>
                <span className="min-w-0 flex-1 truncate">{r.customer_legal_name}</span><span>{money(r.grand_total)}</span><InvoiceStatusBadge status={r.display_status} /></li>
            ))}</ul>)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent payment receipts</CardTitle></CardHeader>
          <CardContent>{d.recent_receipts.length === 0 ? <p className="text-sm text-muted-foreground">No receipts recorded.</p> : (
            <ul className="divide-y text-sm">{d.recent_receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2"><Link className="font-medium text-primary hover:underline" to={`/billing/payments?receipt=${r.id}`}>{r.receipt_number}</Link>
                <span className="min-w-0 flex-1 truncate">{r.customer_name}</span><span>{money(r.amount_received)}</span>
                <span className="text-xs text-muted-foreground">{r.status === 'REVERSED' ? 'reversed' : Number(r.unallocated_amount) > 0 ? `${money(r.unallocated_amount)} unallocated` : 'allocated'}</span></li>
            ))}</ul>)}</CardContent>
        </Card>
        <Card className="xl:col-span-2">
          <CardHeader><CardTitle>Overdue invoices requiring follow-up</CardTitle></CardHeader>
          <CardContent>{d.overdue_invoices.length === 0 ? <p className="text-sm text-muted-foreground">No overdue invoices.</p> : (
            <table className="w-full text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Invoice</th><th className="pb-1 text-left">Customer</th><th className="pb-1 text-left">Due</th><th className="pb-1 text-right">Days overdue</th><th className="pb-1 text-right">Balance</th></tr></thead>
              <tbody>{d.overdue_invoices.map((o) => (
                <tr key={o.invoice_id} className="border-t"><td className="py-1.5"><Link className="text-primary hover:underline" to={`/billing/invoices/${o.invoice_id}`}>{o.invoice_number}</Link></td><td className="py-1.5">{o.customer_name}</td>
                  <td className="py-1.5">{formatDate(o.due_date)}</td><td className="py-1.5 text-right text-shortage">{o.days_overdue}</td><td className="py-1.5 text-right">{money(o.balance)}</td></tr>
              ))}</tbody></table>)}</CardContent>
        </Card>
      </div>
    </>
  )
}
