import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchReconciliation } from '@/services/management'

/** /reconciliation — read-only inventory and finance checks. */
export default function ReconciliationPage() {
  const rec = useAsync(fetchReconciliation, [])
  const d = rec.data
  return (
    <>
      <PageHeader title="Reconciliation" description="Checks that stock, reservations, invoices, payments and both ledgers agree with the records they come from. Nothing is changed by running them."
        actions={<Button variant="outline" onClick={rec.reload}><RefreshCw className={rec.loading ? 'animate-spin' : undefined} /> Run again</Button>} />
      {rec.loading && !d ? <LoadingState variant="cards" rows={4} /> : rec.error || !d ? <Card><ErrorState message={describeDataError(rec.error)} onRetry={rec.reload} /></Card> : <>
        <p role="status" className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${d.issues === 0 ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
          {d.issues === 0 ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
          {d.issues === 0 ? `All ${d.checks.length} checks pass.` : `${d.issues} difference(s) found.`} Checked {formatDateTime(d.generated_at)}.
        </p>
        <div className="grid gap-6 xl:grid-cols-2">
          {(['Inventory', 'Finance'] as const).map((area) => (
            <Card key={area}>
              <CardHeader><CardTitle>{area}</CardTitle></CardHeader>
              <CardContent><ul className="space-y-3">{d.checks.filter((c) => c.area === area).map((c) => (
                <li key={c.code} className="text-sm" data-testid={`check-${c.code}`}>
                  <p className="flex items-center gap-2 font-medium">{c.issues === 0 ? <CheckCircle2 className="size-4 text-green-700" /> : <XCircle className="size-4 text-red-700" />} {c.title}
                    {c.issues > 0 && <span className="text-red-700">({c.issues})</span>}</p>
                  <p className="pl-6 text-xs text-muted-foreground">{c.rule}</p>
                  {c.samples.length > 0 && <ul className="pl-6 text-xs text-red-800">{c.samples.map((s, i) => <li key={i}>{s.reference}: {s.detail}</li>)}</ul>}
                </li>
              ))}</ul></CardContent>
            </Card>
          ))}
        </div>
      </>}
    </>
  )
}
