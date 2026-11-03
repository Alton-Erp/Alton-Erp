import { CheckCircle2, RefreshCw, ShieldAlert } from 'lucide-react'
import { Link } from 'react-router-dom'

import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StaleBanner } from '@/features/analytics/analytics-ui'
import { useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { formatDateTime } from '@/lib/format'
import { fetchDataQuality } from '@/services/analytics'

export default function DataQualityPage() {
  const q = useAnalyticsQuery(() => fetchDataQuality(), [])
  const d = q.data
  return (
    <>
      <PageHeader actions={<>
        <span className="text-xs text-muted-foreground">{q.lastSuccessAt ? `Last checked ${formatDateTime(q.lastSuccessAt)}` : ''}</span>
        <Button variant="outline" size="sm" onClick={q.reload} disabled={q.loading}><RefreshCw className={q.loading ? 'animate-spin' : undefined} /> Run checks</Button>
      </>} />
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={d ? q.lastSuccessAt : null} onRetry={q.reload} />
      {q.loading && !d ? <LoadingState variant="cards" rows={4} /> : d && (
        <>
          <p className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${d.issues ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-green-200 bg-green-50 text-green-800'}`}>
            {d.issues ? <ShieldAlert className="size-4" /> : <CheckCircle2 className="size-4" />}
            {d.issues ? `${d.issues} record(s) need attention across ${d.checks.filter((c) => c.issues).length} check(s).` : `All ${d.checks.length} checks reconcile.`} {d.note}
          </p>
          <div className="grid gap-4 xl:grid-cols-2">
            {d.checks.map((c) => (
              <Card key={c.code}>
                <CardHeader>
                  <div><CardTitle>{c.title}</CardTitle><CardDescription>{c.module} · Rule: {c.rule}</CardDescription></div>
                  <StatusBadge label={c.issues ? `${c.issues} issue${c.issues === 1 ? '' : 's'}` : 'OK'} tone={c.issues ? 'warning' : 'success'} />
                </CardHeader>
                {c.issues > 0 && (
                  <CardContent>
                    <ul className="divide-y text-sm">{c.samples.map((s, i) => (
                      <li key={`${s.reference}-${i}`} className="flex flex-wrap items-center gap-2 py-1.5">
                        <span className="font-medium">{s.reference}</span><span className="text-muted-foreground">{s.detail}</span>
                        <Link className="ml-auto text-primary hover:underline" to={s.link}>Open</Link>
                      </li>
                    ))}</ul>
                    {c.issues > c.samples.length && <p className="mt-1 text-xs text-muted-foreground">Showing {c.samples.length} of {c.issues}.</p>}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  )
}
