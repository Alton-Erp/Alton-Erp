import { AlarmClock, Clock, FileMinus, Gauge, HandCoins, Receipt, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { PairedBarChart } from '@/components/charts/paired-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { BUCKET_LABELS, NOTE_REASON_LABELS } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { inr, pct, type ExportSection } from '@/features/analytics/analytics-format'
import { activeFilters } from '@/features/analytics/analytics-options'
import { formatBucket, formatIso } from '@/features/analytics/analytics-period'
import {
  AnalyticsExport, AnalyticsHeader, FilterBar, MetricCard, MiniTable, PeriodControls, PrintHeader, SectionHeading, StaleBanner, UnavailableCard,
} from '@/features/analytics/analytics-ui'
import { useDrilldown } from '@/features/analytics/use-drilldown'
import { useAnalyticsContext, useAnalyticsFilters, useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { fetchFinanceAnalytics, type FinanceAnalytics } from '@/services/analytics'

const BUCKET_FILL: Record<string, string> = { NOT_DUE: TONE_FILL.info, '1_30': TONE_FILL.warning, '31_60': TONE_FILL.warning, '61_90': TONE_FILL.danger, OVER_90: TONE_FILL.danger }

export default function FinanceAnalyticsPage() {
  const { has } = usePermissions()
  const context = useAnalyticsContext()
  const ctx = context.data
  const { filters, update, reset } = useAnalyticsFilters(ctx)
  const drill = useDrilldown()
  const q = useAnalyticsQuery(ctx ? () => fetchFinanceAnalytics({ from: filters.from, to: filters.to, asOf: filters.asOf, customerId: filters.customerId }) : null,
    [filters.from, filters.to, filters.asOf, filters.customerId, Boolean(ctx)])
  const d = q.data
  const active = activeFilters(filters, ctx, filters.customerId ? [{ label: 'Customer', value: 'Selected customer' }] : [])

  return (
    <>
      <AnalyticsHeader ctx={ctx} filters={filters} lastSuccessAt={q.lastSuccessAt} loading={q.loading || !ctx} onRefresh={() => { context.reload(); q.reload() }}
        extraNote={d && <span>Balances as of <span className="font-medium text-foreground">{formatIso(d.as_of)}</span></span>}
        exportButton={<AnalyticsExport allowed={Boolean(ctx?.export.billing)} title="Financial overview" fileStem="financial-overview" ctx={ctx} filters={filters} active={active}
          generatedAt={q.lastSuccessAt} sections={() => (d ? financeExport(d) : [])}
          notes={['Operational billing and receivables only — not accounting results.', 'Receipts are as recorded by users and are not bank-verified.']} />} />
      <FilterBar active={active} onClear={reset} appliesTo="The period applies to invoices (invoice date), receipts (receipt date) and notes (note date). Outstanding, ageing and due dates use the 'balances as of' date (default: the period end, or today if earlier).">
        <PeriodControls ctx={ctx} filters={filters} update={update} showAsOf />
        {has('customers.read') && <div className="space-y-1"><Label htmlFor="fi-cust">Customer</Label>
          <CustomerSelect id="fi-cust" value={filters.customerId ?? 'all'} onChange={(v) => update({ customerId: v === 'all' ? null : v })} allowAll className="w-56" /></div>}
      </FilterBar>
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={d ? q.lastSuccessAt : null} onRetry={q.reload} />
      <div className="print-area space-y-8">
        <PrintHeader title="Financial overview" ctx={ctx} filters={filters} active={active} generatedAt={q.lastSuccessAt} />
        {!d ? (q.loading || !ctx ? <LoadingState variant="cards" rows={6} /> : null) : !d.has_records ? (
          <Card><EmptyState icon={Receipt} title="No invoices issued yet" description="The financial overview appears once invoices are issued." /></Card>
        ) : (
          <>
            <section aria-labelledby="fi-kpis">
              <SectionHeading id="fi-kpis" title="Invoicing, collections and receivables" />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="Issued invoices" value={inr(d.totals.invoiced)} icon={Receipt} accent="blue" kind="period" hint={`${d.totals.invoices} invoice(s) · taxable ${inr(d.totals.invoiced_taxable)}`}
                  definition="Sum of the grand total of issued invoices dated in the period (drafts and cancelled excluded)."
                  onDrill={() => drill.open({ source: 'invoices', title: 'Issued invoices in the period', from: filters.from, to: filters.to, customerId: filters.customerId })} />
                <MetricCard label="Collections" value={inr(d.totals.collected)} icon={Wallet} accent="green" kind="period"
                  hint={`${d.totals.receipts} receipt(s)${d.totals.reversed_receipts ? ` · ${inr(d.totals.reversed_receipts)} reversed (excluded)` : ''}`}
                  definition="Sum of recorded receipts by receipt date. Reversed receipts are excluded."
                  onDrill={() => drill.open({ source: 'receipts', title: 'Receipts in the period', from: filters.from, to: filters.to, customerId: filters.customerId })} />
                <MetricCard label="Outstanding receivables" value={inr(d.totals.outstanding)} icon={HandCoins} accent="orange" kind="as-of"
                  hint={`${d.customers_with_balance} customer(s)${d.totals.customer_credits ? ` · credits ${inr(d.totals.customer_credits)} not netted` : ''}`}
                  definition="Issued invoices + debit notes − credit notes − active allocations, as of the reporting date." />
                <MetricCard label="Overdue receivables" value={inr(d.totals.overdue)} icon={AlarmClock} accent="red" kind="as-of" definition="Outstanding balance of invoices past their due date on the reporting date." />
                <MetricCard label="Collection rate" value={d.collection_rate.percent === null ? null : pct(d.collection_rate.percent)} icon={Gauge} accent="green" kind="period"
                  unavailableReason="Nothing was billed or open in the period." hint={`${inr(d.collection_rate.allocated)} allocated · ${inr(d.collection_rate.open_at_end)} still open at period end`}
                  definition={d.collection_rate.definition} />
                <MetricCard label="Average collection time" value={d.collection_time.average_days === null ? null : `${d.collection_time.average_days} days`} icon={Clock} accent="blue" kind="period"
                  unavailableReason="No invoice was fully settled by allocations in the period." hint={`${d.collection_time.invoices} invoice(s) settled`} definition={d.collection_time.definition} />
                <MetricCard label="Credit / debit notes" value={`${inr(d.totals.credit_notes)} / ${inr(d.totals.debit_notes)}`} icon={FileMinus} kind="period"
                  definition="Issued notes dated in the period; reported separately from invoiced value." />
                <MetricCard label="Unallocated receipts" value={inr(d.totals.unallocated)} icon={Wallet} accent="orange" kind="current" definition="Recorded receipt amounts not allocated to invoices; not deducted from outstanding." />
              </div>
            </section>
            <section aria-labelledby="fi-charts" className="grid gap-4 xl:grid-cols-2">
              <h2 id="fi-charts" className="sr-only">Charts</h2>
              <ChartCard title="Issued invoices vs collections by month" description="Invoice date vs receipt date" isEmpty={d.monthly.every((m) => !Number(m.invoiced) && !Number(m.collected))}
                table={{ headers: ['Month', 'Invoices', 'Invoiced', 'Collected', 'Credit notes', 'Debit notes'], rows: d.monthly.map((m) => [formatBucket(m.month, 'month'), m.invoices, inr(m.invoiced), inr(m.collected), inr(m.credit_notes), inr(m.debit_notes)]) }}>
                <PairedBarChart aName="Invoiced" bName="Collected" aColor={TONE_FILL.info} bColor={TONE_FILL.success} valueFormatter={(v) => inr(v)}
                  data={d.monthly.map((m) => ({ label: formatBucket(m.month, 'month'), a: Number(m.invoiced), b: Number(m.collected) }))} />
              </ChartCard>
              <ChartCard title="Receivables by ageing bucket" description={`Open balances as of ${formatIso(d.as_of)}`} isEmpty={d.ageing.every((a) => !Number(a.amount))}
                table={{ headers: ['Bucket', 'Amount', 'Invoices'], rows: d.ageing.map((a) => [BUCKET_LABELS[a.bucket], inr(a.amount), a.invoices]) }}>
                <HorizontalBarChart seriesName="Outstanding" valueFormatter={(v) => inr(v)} data={d.ageing.map((a) => ({ label: BUCKET_LABELS[a.bucket], value: Number(a.amount), color: BUCKET_FILL[a.bucket] }))} />
              </ChartCard>
              <Card>
                <CardHeader><div><CardTitle>Outstanding by customer</CardTitle><CardDescription>Top 25 of {d.customers_with_balance}</CardDescription></div></CardHeader>
                <CardContent><MiniTable headers={['Customer', 'Outstanding', 'Overdue', 'Invoices']} empty="Nothing outstanding." rows={d.by_customer.map((c) => [
                  <Link key="c" className="text-primary hover:underline" to={`/billing/statements?customer=${c.customer_id}`}>{c.customer}</Link>, inr(c.balance, true),
                  Number(c.overdue) ? <span key="o" className="text-shortage">{inr(c.overdue, true)}</span> : inr(0, true), c.invoices])} /></CardContent>
              </Card>
              <Card>
                <CardHeader><div><CardTitle>Top overdue customer accounts</CardTitle></div></CardHeader>
                <CardContent><MiniTable headers={['Customer', 'Overdue', 'Invoices', 'Oldest (days)']} empty="No overdue balances." rows={d.top_overdue.map((c) => [
                  <Link key="c" className="text-primary hover:underline" to={`/billing/statements?customer=${c.customer_id}`}>{c.customer}</Link>, inr(c.overdue, true), c.invoices,
                  <span key="d" className="text-shortage">{c.oldest_days_overdue}</span>])} /></CardContent>
              </Card>
              <Card>
                <CardHeader><div><CardTitle>Upcoming due dates</CardTitle><CardDescription>Next 30 days · {inr(d.upcoming_due_total)}</CardDescription></div></CardHeader>
                <CardContent><MiniTable headers={['Invoice', 'Customer', 'Due', 'In (days)', 'Balance']} empty="Nothing falls due in the next 30 days." rows={d.upcoming_due.map((u) => [
                  <Link key="i" className="text-primary hover:underline" to={`/billing/invoices/${u.invoice_id}`}>{u.invoice_number}</Link>, u.customer, formatIso(u.due_date), u.days_to_due,
                  inr(u.balance, true)])} align={['left', 'left', 'left', 'right', 'right']} /></CardContent>
              </Card>
              <Card>
                <CardHeader><div><CardTitle>Credit and debit notes</CardTitle><CardDescription>Issued in the period, by reason</CardDescription></div></CardHeader>
                <CardContent><MiniTable headers={['Type', 'Reason', 'Notes', 'Total']} empty="No notes issued in the period." rows={d.notes_by_reason.map((n) => [
                  n.note_type === 'CREDIT' ? 'Credit' : 'Debit', NOTE_REASON_LABELS[n.reason_code] ?? n.reason_code, n.notes, inr(n.total, true)])} align={['left', 'left', 'right', 'right']} /></CardContent>
              </Card>
              {d.unallocated_receipts === null ? <UnavailableCard title="Unallocated payments" reason="Your role does not include the payments.read permission." /> : (
                <Card>
                  <CardHeader><div><CardTitle>Unallocated payments</CardTitle><CardDescription>Receipts needing allocation or review</CardDescription></div></CardHeader>
                  <CardContent><MiniTable headers={['Receipt', 'Date', 'Customer', 'Amount', 'Unallocated']} empty="Every receipt is fully allocated." rows={d.unallocated_receipts.map((r) => [
                    <Link key="r" className="text-primary hover:underline" to={`/billing/payments?receipt=${r.payment_id}`}>{r.receipt_number}</Link>, formatIso(r.receipt_date), r.customer,
                    inr(r.amount, true), inr(r.unallocated, true)])} align={['left', 'left', 'left', 'right', 'right']} /></CardContent>
                </Card>
              )}
            </section>
            <section aria-labelledby="fi-na">
              <SectionHeading id="fi-na" title="Metrics not available" description="Shown so they are not mistaken for zero." />
              <div className="grid gap-4 md:grid-cols-3">{d.unavailable_metrics.map((m) => <UnavailableCard key={m.metric} title={m.metric} reason={m.reason} />)}</div>
            </section>
          </>
        )}
      </div>
      {drill.element}
    </>
  )
}

function financeExport(d: FinanceAnalytics): ExportSection[] {
  return [
    { name: 'Totals', headers: ['Metric', 'Value'], rows: [
      ['Issued invoices (count)', d.totals.invoices], ['Issued invoice total', Number(d.totals.invoiced)], ['Taxable value', Number(d.totals.invoiced_taxable)],
      ['Collections', Number(d.totals.collected)], ['Reversed receipts (excluded)', Number(d.totals.reversed_receipts)], ['Allocated in period', Number(d.totals.allocated_in_period)],
      [`Outstanding as of ${d.as_of}`, Number(d.totals.outstanding)], [`Overdue as of ${d.as_of}`, Number(d.totals.overdue)], ['Customer credits', Number(d.totals.customer_credits)],
      ['Credit notes', Number(d.totals.credit_notes)], ['Debit notes', Number(d.totals.debit_notes)], ['Unallocated receipts', Number(d.totals.unallocated)],
      ['Collection rate %', d.collection_rate.percent], ['Collection rate definition', d.collection_rate.definition],
      ['Average collection days', d.collection_time.average_days], ['Collection time definition', d.collection_time.definition]] },
    { name: 'Monthly', headers: ['Month', 'Invoices', 'Invoiced', 'Collected', 'Credit notes', 'Debit notes'],
      rows: d.monthly.map((m) => [m.month, m.invoices, Number(m.invoiced), Number(m.collected), Number(m.credit_notes), Number(m.debit_notes)]) },
    { name: 'Ageing', headers: ['Bucket', 'Amount', 'Invoices'], rows: d.ageing.map((a) => [BUCKET_LABELS[a.bucket], Number(a.amount), a.invoices]) },
    { name: 'By customer', headers: ['Customer', 'Outstanding', 'Overdue', 'Invoices', 'Oldest days overdue'], rows: d.by_customer.map((c) => [c.customer, Number(c.balance), Number(c.overdue), c.invoices, c.oldest_days_overdue]) },
    { name: 'Upcoming due', headers: ['Invoice', 'Customer', 'Due date', 'Balance'], rows: d.upcoming_due.map((u) => [u.invoice_number, u.customer, u.due_date, Number(u.balance)]) },
    { name: 'Unavailable', headers: ['Metric', 'Why'], rows: d.unavailable_metrics.map((m) => [m.metric, m.reason]) },
  ]
}
