import { BellRing, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  ALERT_TYPE_LABEL, dedupeAlerts, filterAlerts, refreshFailedAlert, SEVERITY_LABEL, SEVERITY_ORDER, sortAlerts, TEAM_LABEL, type AlertFilter,
} from '@/features/analytics/analytics-alerts'
import { isIsoDate } from '@/features/analytics/analytics-period'
import { SelectFilter, StaleBanner } from '@/features/analytics/analytics-ui'
import { useAnalyticsQuery } from '@/features/analytics/use-analytics'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchAlerts, type AlertSeverity } from '@/services/analytics'

const TONE: Record<AlertSeverity, 'danger' | 'warning' | 'info'> = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'info' }

export default function AlertsPage() {
  const [asOf, setAsOf] = useState('')
  const q = useAnalyticsQuery(() => fetchAlerts(isIsoDate(asOf) ? asOf : null), [asOf])
  const [f, setF] = useState<AlertFilter>({ severity: 'all', type: 'all', team: 'all', since: null, search: '' })
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const all = useMemo(() => {
    const list = dedupeAlerts(q.data?.alerts ?? [])
    return q.error ? [refreshFailedAlert('Alerts', q.error, q.failedAt ?? ''), ...list] : list
  }, [q.data, q.error, q.failedAt])
  const shown = sortAlerts(filterAlerts(all, f))
  const set = (c: Partial<AlertFilter>) => { setPage(0); setF((x) => ({ ...x, ...c })) }
  const types = [...new Set(all.map((a) => a.type))]
  const teams = [...new Set(all.map((a) => a.team))]

  return (
    <>
      <PageHeader actions={<>
        <span className="text-xs text-muted-foreground">{q.lastSuccessAt ? `Last refreshed ${formatDateTime(q.lastSuccessAt)}` : q.loading ? 'Loading…' : ''}</span>
        <Button variant="outline" size="sm" onClick={q.reload} disabled={q.loading}><RefreshCw className={q.loading ? 'animate-spin' : undefined} /> Refresh</Button>
      </>} />
      <p className="mb-4 text-sm text-muted-foreground">
        Alerts are evaluated from current records each time this page loads, using fixed rules; each has a stable reference, so refreshing never duplicates them.
        Nothing is changed from here — open the record to act. You only see alerts for the modules your role can access.
      </p>
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <SelectFilter id="al-sev" label="Severity" value={f.severity === 'all' ? null : f.severity} onChange={(v) => set({ severity: (v ?? 'all') as AlertFilter['severity'] })}
          options={SEVERITY_ORDER.map((s) => ({ value: s, label: `${SEVERITY_LABEL[s]} (${all.filter((a) => a.severity === s).length})` }))} allLabel="All severities" width="w-40" />
        <SelectFilter id="al-type" label="Alert type" value={f.type === 'all' ? null : f.type} onChange={(v) => set({ type: v ?? 'all' })}
          options={types.map((t) => ({ value: t, label: ALERT_TYPE_LABEL[t] ?? t }))} allLabel="All types" width="w-52" />
        <SelectFilter id="al-team" label="Responsible team" value={f.team === 'all' ? null : f.team} onChange={(v) => set({ team: v ?? 'all' })}
          options={teams.map((t) => ({ value: t, label: TEAM_LABEL[t] ?? t }))} allLabel="All teams" width="w-40" />
        <div className="space-y-1"><Label htmlFor="al-since">Detected on or after</Label><Input id="al-since" type="date" value={f.since ?? ''} onChange={(e) => set({ since: isIsoDate(e.target.value) ? e.target.value : null })} /></div>
        <div className="space-y-1"><Label htmlFor="al-asof">Evaluate as of</Label><Input id="al-asof" type="date" value={asOf} onChange={(e) => { setPage(0); setAsOf(e.target.value) }} /></div>
        <div className="relative w-64"><Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search alerts" className="pl-9" placeholder="Reference, product, customer…" value={f.search} onChange={(e) => set({ search: e.target.value })} /></div>
      </CardContent></Card>
      <StaleBanner error={q.error} failedAt={q.failedAt} lastSuccessAt={q.data ? q.lastSuccessAt : null} onRetry={q.reload} />
      {q.data && q.data.skipped.length > 0 && <p className="mb-3 text-xs text-muted-foreground">Not evaluated for your role: {q.data.skipped.join('; ')}.</p>}
      {q.loading && !q.data ? <LoadingState variant="table" rows={6} /> : shown.length === 0 ? (
        <Card><EmptyState icon={BellRing} title={all.length ? 'No alerts match these filters' : 'No alerts'} description={all.length ? 'Change the filters to see other alerts.' : 'No rule found an exception in the records you can access.'} /></Card>
      ) : (
        <Card><CardContent className="p-0">
          <ul className="divide-y">{shown.slice(page * pageSize, (page + 1) * pageSize).map((a) => (
            <li key={a.id} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[110px_1fr_auto] md:items-start">
              <div className="flex flex-col gap-1"><StatusBadge label={SEVERITY_LABEL[a.severity]} tone={TONE[a.severity]} /><span className="text-xs text-muted-foreground">{TEAM_LABEL[a.team] ?? a.team}</span></div>
              <div className="min-w-0">
                <p className="font-medium">{a.title} <span className="font-normal text-muted-foreground">· {a.reference}</span></p>
                <p>{a.explanation}</p>
                <p className="text-muted-foreground">Next action: {a.action}</p>
              </div>
              <div className="flex items-center gap-2 md:flex-col md:items-end">
                <span className="text-xs text-muted-foreground">Detected {formatDate(a.detected_at)}</span>
                {a.link ? <Button size="sm" variant="outline" asChild><Link to={a.link}>Open record</Link></Button> : <Button size="sm" variant="outline" onClick={q.reload}>Retry</Button>}
              </div>
            </li>
          ))}</ul>
          <PaginationBar page={page} pageSize={pageSize} total={shown.length} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(0) }} />
        </CardContent></Card>
      )}
      {q.data && <p className="mt-3 text-xs text-muted-foreground">Each rule lists at most {q.data.limit_per_rule} alerts (oldest or most severe first).</p>}
    </>
  )
}
