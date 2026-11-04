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
import { fetchModuleDashboard, type ModuleKey } from '@/services/management'

/** Shared frame of the module dashboards: period filter, refresh, loading and error states. */
export function ModuleDashboard<T>({ module, title, description, actions, children }: {
  module: ModuleKey
  title: string
  description: string
  actions?: ReactNode
  children: (data: T, period: { from: string; to: string }) => ReactNode
}) {
  // Kept in the address, so Back from a drill-down page returns to the same period.
  const [range, setRange] = useUrlDateRange('this_month')
  const [refresh, setRefresh] = useState(0)
  const from = toIsoDate(range.from)
  const to = toIsoDate(range.to)
  const data = useAsync(() => fetchModuleDashboard<T>(module, from, to), [module, from, to, refresh])
  return (
    <>
      <PageHeader title={title} description={description} actions={<>
        <DateRangeFilter value={range} onChange={setRange} />
        <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={data.loading ? 'animate-spin' : undefined} /></Button>
        {actions}
      </>} />
      {data.loading && !data.data ? <LoadingState variant="cards" rows={6} />
        : data.error || !data.data ? <Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card>
        : children(data.data, { from, to })}
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
