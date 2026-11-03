import { Hourglass } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { TONE_FILL } from '@/components/charts/chart-theme'
import { HorizontalBarChart } from '@/components/charts/horizontal-bar-chart'
import { ChartCard } from '@/components/common/chart-card'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BillingExport } from '@/features/billing/billing-export'
import { BUCKETS, BUCKET_LABELS, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { fetchReceivables } from '@/services/billing'

const BUCKET_FILL: Record<string, string> = { NOT_DUE: TONE_FILL.info, '1_30': TONE_FILL.warning, '31_60': TONE_FILL.warning, '61_90': TONE_FILL.danger, OVER_90: TONE_FILL.danger }

type MatrixRow = { customer_id: string; customer_name: string; cells: Record<string, number>; total: number }

export default function AgeingPage() {
  const [asOf, setAsOf] = useState(() => toIsoDate(new Date()))
  const [customer, setCustomer] = useState('all')
  const list = useAsync(() => (asOf ? fetchReceivables(asOf, customer === 'all' ? null : customer, null) : Promise.resolve([])), [asOf, customer])

  // Summed in paise for display; each balance comes from the database.
  const byCustomer = new Map<string, MatrixRow>()
  const totals: Record<string, number> = Object.fromEntries(BUCKETS.map((b) => [b, 0]))
  for (const r of list.data ?? []) {
    const p = Math.round(Number(r.balance) * 100)
    const row = byCustomer.get(r.customer_id) ?? { customer_id: r.customer_id, customer_name: r.customer_name, cells: Object.fromEntries(BUCKETS.map((b) => [b, 0])), total: 0 }
    row.cells[r.bucket] += p
    row.total += p
    totals[r.bucket] += p
    byCustomer.set(r.customer_id, row)
  }
  const matrix = [...byCustomer.values()].sort((a, b) => b.total - a.total)
  const grand = Object.values(totals).reduce((s, v) => s + v, 0)
  const m = (p: number) => (p ? money(p / 100, false) : '—')

  return (
    <>
      <PageHeader actions={<BillingExport title="Receivables ageing" fileStem={`ageing-${asOf}`} rows={matrix} columns={[
        { header: 'Customer', value: (r) => r.customer_name }, ...BUCKETS.map((b) => ({ header: BUCKET_LABELS[b], value: (r: MatrixRow) => r.cells[b] / 100 })), { header: 'Total', value: (r) => r.total / 100 },
      ]} />} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="ag-asof">As of</Label><Input id="ag-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ag-cust">Customer</Label><CustomerSelect id="ag-cust" value={customer} onChange={setCustomer} allowAll /></div>
          <p className="text-xs text-muted-foreground">Days overdue = as-of date − invoice due date. Open balances after issued credit/debit notes and allocated receipts.</p>
        </CardContent>
      </Card>
      {list.loading ? <LoadingState variant="cards" rows={2} /> : list.error ? <Card><ErrorState message={describeDataError(list.error)} onRetry={list.reload} /></Card> : matrix.length === 0 ? (
        <Card><EmptyState icon={Hourglass} title="Nothing outstanding" description="No issued invoice had an open balance on this date." /></Card>
      ) : (
        <div className="space-y-6">
          <ChartCard title="Outstanding by ageing bucket" description={`As of ${asOf} · total ${money(grand / 100)}`} isEmpty={grand === 0} emptyMessage="Nothing outstanding."
            table={{ headers: ['Bucket', 'Amount'], rows: BUCKETS.map((b) => [BUCKET_LABELS[b], money(totals[b] / 100)]) }}>
            <HorizontalBarChart seriesName="Outstanding" valueFormatter={(v) => money(v)} data={BUCKETS.map((b) => ({ label: BUCKET_LABELS[b], value: totals[b] / 100, color: BUCKET_FILL[b] }))} />
          </ChartCard>
          <Card>
            <CardHeader><div><CardTitle>Customer × bucket</CardTitle><CardDescription>Amounts in ₹. Negative values are customer credits (e.g. a credit note larger than the balance).</CardDescription></div></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">Customer</th>{BUCKETS.map((b) => <th key={b} className="pb-2 text-right">{BUCKET_LABELS[b]}</th>)}<th className="pb-2 text-right">Total</th></tr></thead>
                <tbody>
                  {matrix.map((r) => (
                    <tr key={r.customer_id} className="border-t">
                      <td className="py-1.5"><Link className="text-primary hover:underline" to={`/billing/statements?customer=${r.customer_id}`}>{r.customer_name}</Link></td>
                      {BUCKETS.map((b) => <td key={b} className={`py-1.5 text-right ${b !== 'NOT_DUE' && r.cells[b] > 0 ? 'text-shortage' : ''}`}>{m(r.cells[b])}</td>)}
                      <td className="py-1.5 text-right font-medium">{m(r.total)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold"><td className="py-1.5">Total</td>{BUCKETS.map((b) => <td key={b} className="py-1.5 text-right">{m(totals[b])}</td>)}<td className="py-1.5 text-right">{m(grand)}</td></tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}
