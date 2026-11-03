import { ChartColumn, Table2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { SampleTag } from '@/components/common/sample-data'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export interface ChartTableView {
  headers: string[]
  rows: (string | number)[][]
}

interface ChartCardProps {
  title: string
  description?: string
  isSample?: boolean
  loading?: boolean
  error?: Error | null
  onRetry?: () => void
  isEmpty?: boolean
  emptyMessage?: string
  /** Accessible tabular alternative to the chart. */
  table?: ChartTableView
  height?: number
  className?: string
  children: ReactNode
}

/** Card wrapper for charts with loading/error/empty states and a chart/table toggle. */
export function ChartCard({
  title,
  description,
  isSample = false,
  loading = false,
  error = null,
  onRetry,
  isEmpty = false,
  emptyMessage = 'No data is available for this period yet.',
  table,
  height = 280,
  className,
  children,
}: ChartCardProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const ready = !loading && !error && !isEmpty

  let content: ReactNode
  if (loading) content = <LoadingState variant="chart" />
  else if (error) content = <ErrorState compact message={error.message} onRetry={onRetry} />
  else if (isEmpty) content = <EmptyState compact icon={ChartColumn} title="Nothing to chart" description={emptyMessage} />
  else if (view === 'table' && table) {
    content = (
      <div className="h-full overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-muted">
            <tr>
              {table.headers.map((h, i) => (
                <th key={h} className={cn('px-3 py-2 text-xs font-medium text-muted-foreground', i === 0 ? 'text-left' : 'text-right')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-t">
                {row.map((cell, c) => (
                  <td key={c} className={cn('px-3 py-2', c === 0 ? 'text-left' : 'text-right tabular-nums')}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else content = children

  return (
    <Card className={className}>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isSample && ready && <SampleTag />}
          {table && ready && (
            <div role="group" aria-label={`${title} view`} className="inline-flex rounded-md border p-0.5">
              <button
                type="button"
                onClick={() => setView('chart')}
                aria-pressed={view === 'chart'}
                aria-label="Chart view"
                className={cn('rounded p-1', view === 'chart' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <ChartColumn className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setView('table')}
                aria-pressed={view === 'table'}
                aria-label="Table view"
                className={cn('rounded p-1', view === 'table' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                <Table2 className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        <div style={{ height }}>{content}</div>
      </CardContent>
    </Card>
  )
}
