import { FileBarChart } from 'lucide-react'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { REPORTS, display, exportValue, type Row } from '@/features/billing/billing-report-defs'
import { BillingExport } from '@/features/billing/billing-export'
import { money } from '@/features/billing/billing-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBillingReport, type BillingReportKey } from '@/services/billing'


/** Runs one billing report on the server and shows it as a table with totals (summed in paise for display) and export. */
export function BillingReportView({ report, from, to, customerId, status, compact = false }: { report: BillingReportKey; from: string; to: string; customerId: string | null; status: string | null; compact?: boolean }) {
  const def = REPORTS[report]
  const data = useAsync(() => fetchBillingReport(report, { from, to, customerId, status }), [report, from, to, customerId, status])
  const rows = (data.data ?? []) as Row[]
  const money_ = def.columns.filter((c) => c.kind === 'money' || c.kind === 'int')
  const totals = Object.fromEntries(money_.map((c) => [c.key, rows.reduce((s, r) => s + (c.kind === 'int' ? Number(r[c.key] ?? 0) : Math.round(Number(r[c.key] ?? 0) * 100)), 0)]))
  const showTotals = rows.length > 1 && !['BY_GST_RATE', 'HSN_SUMMARY'].includes(report)

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div><CardTitle>{def.title}</CardTitle><CardDescription>{def.description} {def.asOf ? `As of ${formatDate(to)}.` : `${formatDate(from)} – ${formatDate(to)}.`}</CardDescription></div>
        <BillingExport<Row> title={def.title} fileStem={`${report.toLowerCase()}-${from}-${to}`} rows={rows} columns={def.columns.map((c) => ({ header: c.label, value: (r: Row) => exportValue(c, r[c.key]) }))} />
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {data.loading ? <LoadingState variant="table" rows={compact ? 3 : 6} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
          : rows.length === 0 ? <EmptyState icon={FileBarChart} title="No records" description="Nothing matches this report for the selected period and filters." /> : (
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-xs text-muted-foreground"><tr>{def.columns.map((c) => <th key={c.key} className={`pb-2 ${c.kind === 'money' || c.kind === 'int' || c.kind === 'qty' || c.kind === 'rate' ? 'text-right' : 'text-left'}`}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t">{def.columns.map((c) => <td key={c.key} className={`py-1.5 ${c.kind === 'money' || c.kind === 'int' || c.kind === 'qty' || c.kind === 'rate' ? 'text-right tabular-nums' : ''}`}>{display(c, r[c.key])}</td>)}</tr>
                ))}
                {showTotals && (
                  <tr className="border-t-2 font-semibold">{def.columns.map((c, i) => (
                    <td key={c.key} className="py-1.5 text-right tabular-nums">{i === 0 ? <span className="block text-left">Total</span> : c.kind === 'money' ? money(totals[c.key] / 100, false) : c.kind === 'int' ? totals[c.key] : ''}</td>
                  ))}</tr>
                )}
              </tbody>
            </table>
          )}
      </CardContent>
    </Card>
  )
}
