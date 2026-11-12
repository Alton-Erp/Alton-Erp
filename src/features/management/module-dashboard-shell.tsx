import { RefreshCw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { DateRangeFilter } from '@/components/common/date-range-filter'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUrlDateRange } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { EXCL_GST_MISSING, EXCL_GST_NOTE, fetchExclGst, type ExclGstDashboard, type ExclGstScope } from '@/services/gst-exclusive'
import { fetchModuleDashboard, type ModuleKey } from '@/services/management'

/** Shared frame of the module dashboards: period filter, refresh, loading and error states. */
export function ModuleDashboard<T>({ module, title, description, actions, exclGst, children }: {
  module: ModuleKey
  title: string
  description: string
  actions?: ReactNode
  /** Dashboards with amounts: the GST-exclusive figures of this scope (migration 20261209090000). */
  exclGst?: ExclGstScope
  children: (data: T, period: { from: string; to: string }, ex: ExclGstDashboard | null) => ReactNode
}) {
  // Kept in the address, so Back from a drill-down page returns to the same period.
  const [range, setRange] = useUrlDateRange('this_month')
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const data = useAsync(() => fetchModuleDashboard<T>(module, from, to), [module, from, to, refresh])
  const ex = useAsync(() => (exclGst ? fetchExclGst(exclGst, from, to) : Promise.resolve(null)), [exclGst, from, to, refresh])
  return (
    <>
      <PageHeader title={title} description={description} actions={<>
        <DateRangeFilter value={range} onChange={setRange} />
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={data.loading ? 'animate-spin' : undefined} /></Button>
        {actions}
      </>} />
      {exclGst && <p className="mb-4 text-xs text-muted-foreground" data-testid="gst-basis">{EXCL_GST_NOTE}</p>}
      {exclGst && ex.data === null && <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900" data-testid="gst-missing">{EXCL_GST_MISSING}</p>}
      {(data.loading && !data.data) || (ex.loading && ex.data === undefined) ? <LoadingState variant="cards" rows={6} />
        : data.error || !data.data || ex.error ? <Card><ErrorState message={describeDataError(data.error ?? ex.error)} onRetry={() => { data.reload(); ex.reload() }} /></Card>
        : children(data.data, { from, to }, ex.data ?? null)}
    </>
  )
}

export function ListCard({ title, description, empty, children, viewAll }: { title: string; description?: string; empty: boolean; children: ReactNode; viewAll?: string | null }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div>
        {viewAll && <Button variant="ghost" size="sm" asChild><Link to={viewAll} data-drill="list">View all</Link></Button>}
      </CardHeader>
      <CardContent>{empty ? <p className="text-sm text-muted-foreground">Nothing to show.</p> : children}</CardContent>
    </Card>
  )
}
