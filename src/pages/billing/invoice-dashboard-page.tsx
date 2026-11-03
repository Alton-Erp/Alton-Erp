import { AlarmClock, Ban, CalendarDays, CheckCircle2, FilePen, FilePlus, FileSpreadsheet, FileText, HandCoins, IndianRupee, Percent, Receipt, RefreshCw, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { PAYMENT_STATUS_META, type PaymentStatusKey } from '@/features/billing/invoicing-v2-model'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { fetchInvoiceDashboard } from '@/services/invoicing-v2'
import type { DateRangeValue } from '@/types'

const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' })
const INVOICE_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  PROFORMA: { label: 'Proforma', tone: 'info' },
  ISSUED: { label: 'Issued', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}

/** /billing/dashboard — Stage 6 invoice dashboard (invoice_dashboard RPC). */
export default function InvoiceDashboardPage() {
  const { has } = usePermissions()
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [customer, setCustomer] = useState('all')
  const [status, setStatus] = useState('all')
  const [payment, setPayment] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const dash = useAsync(() => fetchInvoiceDashboard(from, to, customer === 'all' ? null : customer, status === 'all' ? null : status, payment === 'all' ? null : payment),
    [from, to, customer, status, payment, refresh])
  const d = dash.data

  const header = <PageHeader title="Invoice Dashboard" description="Issued invoices, GST, payments received and what is still outstanding. Drafts and proforma invoices are counted separately; cancelled invoices are excluded from values."
    actions={<>
      <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={dash.loading ? 'animate-spin' : undefined} /></Button>
      {has('invoices.create') && <Button variant="outline" asChild><Link to="/billing/invoices/import"><FileSpreadsheet /> Import</Link></Button>}
      {has('invoices.create') && <Button asChild><Link to="/billing/invoices/new"><FilePlus /> New invoice</Link></Button>}
    </>} />
  const filters = (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />
        <div className="space-y-1"><Label htmlFor="id-cust">Customer</Label><CustomerSelect id="id-cust" value={customer} onChange={setCustomer} allowAll /></div>
        <div className="space-y-1"><Label htmlFor="id-status">Invoice status</Label>
          <Select value={status} onValueChange={(v) => { if (v) setStatus(v) }}><SelectTrigger id="id-status" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{Object.entries(INVOICE_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label htmlFor="id-pay">Payment status</Label>
          <Select value={payment} onValueChange={(v) => { if (v) setPayment(v) }}><SelectTrigger id="id-pay" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{(['UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as PaymentStatusKey[]).map((k) => <SelectItem key={k} value={k}>{PAYMENT_STATUS_META[k].label}</SelectItem>)}</SelectContent></Select></div>
      </CardContent>
    </Card>
  )
  if (dash.loading && !d) return (<>{header}{filters}<LoadingState variant="cards" rows={8} /></>)
  if (dash.error || !d) return (<>{header}{filters}<Card><ErrorState message={describeDataError(dash.error)} onRetry={dash.reload} /></Card></>)
  const monthly = d.monthly.map((m) => ({ label: MONTH.format(new Date(`${m.month}T00:00:00`)), a: Number(m.invoiced), b: Number(m.received) }))
  const gstTotal = d.gst_summary.reduce((s, g) => ({ taxable: s.taxable + Number(g.taxable), cgst: s.cgst + Number(g.cgst), sgst: s.sgst + Number(g.sgst), igst: s.igst + Number(g.igst) }), { taxable: 0, cgst: 0, sgst: 0, igst: 0 })

  return (
    <>
      {header}
      {filters}
      <section aria-label="Invoice figures" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total invoices" value={formatNumber(d.total_invoices)} hint={`Issued ${formatDate(from)} – ${formatDate(to)}`} icon={FileText} accent="manufacturing" />
        <KpiCard label="Created today" value={formatNumber(d.created_today)} hint="Drafts, proforma and issued" icon={CalendarDays} />
        <KpiCard label="Issued this month" value={formatNumber(d.this_month)} hint="By invoice date" icon={Receipt} />
        <KpiCard label="Invoice value" value={money(d.total_value)} hint="Grand total of issued invoices" icon={IndianRupee} accent="manufacturing" />
        <KpiCard label="Taxable value" value={money(d.taxable_value)} hint="Before GST" icon={Receipt} />
        <KpiCard label="GST" value={money(d.gst_collected)} hint="CGST + SGST + IGST on issued invoices" icon={Percent} />
        <KpiCard label="Amount received" value={money(d.amount_received)} hint="Allocated to these invoices" icon={Wallet} accent="available" />
        <KpiCard label="Outstanding" value={money(d.outstanding)} hint="Balance still due" icon={HandCoins} accent="pending" />
        <KpiCard label="Overdue" value={money(d.overdue_amount)} hint="Past the due date" icon={AlarmClock} accent="shortage" />
        <KpiCard label="Partially paid" value={formatNumber(d.partially_paid)} icon={HandCoins} accent="pending" />
        <KpiCard label="Fully paid" value={formatNumber(d.fully_paid)} icon={CheckCircle2} accent="available" />
        <KpiCard label="Drafts" value={formatNumber(d.drafts)} hint={`${d.proforma} proforma`} icon={FilePen} />
        <KpiCard label="Cancelled" value={formatNumber(d.cancelled)} icon={Ban} />
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <ChartCard title="Monthly trend" description="Invoiced and received over the last 12 months" isEmpty={monthly.every((m) => !m.a && !m.b)} emptyMessage="No invoices or receipts yet."
          table={{ headers: ['Month', 'Invoiced', 'Received'], rows: monthly.map((m) => [m.label, money(m.a), money(m.b)]) }}>
          <PairedBarChart aName="Invoiced" bName="Received" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => money(v)} data={monthly} />
        </ChartCard>
        <Card>
          <CardHeader><CardTitle>GST summary</CardTitle></CardHeader>
          <CardContent>{d.gst_summary.length === 0 ? <p className="text-sm text-muted-foreground">No issued invoices in this period.</p> : (
            <table className="w-full text-sm" aria-label="GST summary"><thead className="text-xs text-muted-foreground"><tr>
              <th className="pb-1 text-left">GST rate</th><th className="pb-1 text-right">Taxable</th><th className="pb-1 text-right">CGST</th><th className="pb-1 text-right">SGST</th><th className="pb-1 text-right">IGST</th></tr></thead>
              <tbody>{d.gst_summary.map((g) => (
                <tr key={String(g.gst_rate)} className="border-t"><td className="py-1.5">{g.gst_rate === null ? 'No GST' : `${Number(g.gst_rate)}%`}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(g.taxable)}</td><td className="py-1.5 text-right tabular-nums">{money(g.cgst)}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(g.sgst)}</td><td className="py-1.5 text-right tabular-nums">{money(g.igst)}</td></tr>
              ))}
                <tr className="border-t font-medium"><td className="py-1.5">Total</td><td className="py-1.5 text-right tabular-nums">{money(gstTotal.taxable)}</td>
                  <td className="py-1.5 text-right tabular-nums">{money(gstTotal.cgst)}</td><td className="py-1.5 text-right tabular-nums">{money(gstTotal.sgst)}</td><td className="py-1.5 text-right tabular-nums">{money(gstTotal.igst)}</td></tr>
              </tbody></table>)}
            <p className="mt-3 text-xs text-muted-foreground">For your own records and GST return preparation. Nothing is filed and no e-invoice (IRN) is generated from this ERP.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Recent invoices</CardTitle></CardHeader>
          <CardContent>{d.recent.length === 0 ? <p className="text-sm text-muted-foreground">No invoices in this period.</p> : (
            <ul className="divide-y text-sm">{d.recent.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${r.id}`}>{r.invoice_number ?? 'Draft'}</Link>
                <span className="min-w-0 flex-1 truncate">{r.customer_name}</span><span className="tabular-nums">{money(r.grand_total)}</span>
                <StatusBadge tone={(r.payment_status ? PAYMENT_STATUS_META[r.payment_status as PaymentStatusKey]?.tone : INVOICE_STATUS[r.status]?.tone) ?? 'neutral'}
                  label={r.payment_status ? PAYMENT_STATUS_META[r.payment_status as PaymentStatusKey]?.label ?? r.payment_status : INVOICE_STATUS[r.status]?.label ?? r.status} />
              </li>
            ))}</ul>)}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Overdue invoices</CardTitle></CardHeader>
          <CardContent>{d.overdue.length === 0 ? <p className="text-sm text-muted-foreground">No overdue invoices.</p> : (
            <table className="w-full text-sm" aria-label="Overdue invoices"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Invoice</th><th className="pb-1 text-left">Customer</th>
              <th className="pb-1 text-left">Due</th><th className="pb-1 text-right">Days</th><th className="pb-1 text-right">Balance</th></tr></thead>
              <tbody>{d.overdue.map((o) => (
                <tr key={o.id} className="border-t"><td className="py-1.5"><Link className="text-primary hover:underline" to={`/billing/invoices/${o.id}`}>{o.invoice_number}</Link></td>
                  <td className="py-1.5">{o.customer_name}</td><td className="py-1.5">{formatDate(o.due_date)}</td>
                  <td className="py-1.5 text-right text-shortage">{o.days_overdue}</td><td className="py-1.5 text-right tabular-nums">{money(o.balance_due)}</td></tr>
              ))}</tbody></table>)}</CardContent>
        </Card>
      </div>
    </>
  )
}
