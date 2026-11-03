import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, SearchX, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { EmptyState, type EmptyStateProps } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { SampleTag } from '@/components/common/sample-data'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

export interface DataTableColumn<T> {
  id: string
  header: string
  cell: (row: T) => ReactNode
  /** Text used by the search box. Columns without it are not searched. */
  searchValue?: (row: T) => string
  align?: 'left' | 'right' | 'center'
  className?: string
  /** When provided, the column header sorts the (client-side) data. */
  sortValue?: (row: T) => string | number | null
}

interface DataTableProps<T> {
  /** Makes rows clickable (e.g. to open a detail page). */
  onRowClick?: (row: T) => void
  columns: DataTableColumn<T>[]
  data: T[]
  getRowId: (row: T) => string
  title?: string
  description?: string
  /** Marks the table as showing development sample data. */
  isSample?: boolean
  searchable?: boolean
  searchPlaceholder?: string
  /** Extra filter controls rendered beside the search box. */
  toolbar?: ReactNode
  loading?: boolean
  error?: Error | null
  onRetry?: () => void
  /** Shown when there are no records at all (as opposed to no search matches). */
  emptyState: EmptyStateProps
  pageSize?: number
  className?: string
  /** Search text to start with (e.g. from a link). */
  initialQuery?: string
}

const ALIGN: Record<NonNullable<DataTableColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
}

export function DataTable<T>({
  columns,
  data,
  getRowId,
  title,
  description,
  isSample = false,
  searchable = true,
  searchPlaceholder = 'Search…',
  toolbar,
  loading = false,
  error = null,
  onRetry,
  emptyState,
  pageSize = 10,
  className,
  onRowClick,
  initialQuery,
}: DataTableProps<T>) {
  const [query, setQuery] = useState(initialQuery ?? '')
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ id: string; ascending: boolean } | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const searchable = columns.filter((c) => c.searchValue)
    const matched = q ? data.filter((row) => searchable.some((c) => c.searchValue!(row).toLowerCase().includes(q))) : data
    const sortColumn = sort ? columns.find((c) => c.id === sort.id && c.sortValue) : undefined
    if (!sortColumn || !sort) return matched
    const dir = sort.ascending ? 1 : -1
    return [...matched].sort((a, b) => {
      const x = sortColumn.sortValue!(a)
      const y = sortColumn.sortValue!(b)
      if (x === y) return 0
      if (x === null) return 1
      if (y === null) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir
    })
  }, [data, columns, query, sort])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const rows = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)

  const updateQuery = (value: string) => {
    setQuery(value)
    setPage(0)
  }

  const hasHeader = title || description
  const hasToolbar = searchable || toolbar

  let emptyContent: ReactNode = null
  if (data.length === 0) {
    emptyContent = <EmptyState compact {...emptyState} />
  } else if (filtered.length === 0) {
    emptyContent = (
      <EmptyState
        compact
        icon={SearchX}
        title="No matching records"
        description={`Nothing matches “${query.trim()}”. Try a different search term.`}
        action={
          <Button variant="outline" size="sm" onClick={() => updateQuery('')}>
            Clear search
          </Button>
        }
      />
    )
  }

  let body: ReactNode
  if (loading) {
    body = <LoadingState variant="table" rows={Math.min(pageSize, 5)} />
  } else if (error) {
    body = <ErrorState message={error.message} onRetry={onRetry} compact />
  } else {
    // Headers render even when empty so the table's layout is always visible.
    body = (
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const active = sort?.id === column.id
              return (
                <TableHead
                  key={column.id}
                  className={cn(ALIGN[column.align ?? 'left'], column.className)}
                  aria-sort={column.sortValue ? (active ? (sort!.ascending ? 'ascending' : 'descending') : 'none') : undefined}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      className={cn('inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground', active && 'text-foreground')}
                      onClick={() => {
                        setSort({ id: column.id, ascending: active ? !sort!.ascending : true })
                        setPage(0)
                      }}
                    >
                      {column.header}
                      {active ? (sort!.ascending ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-50" />}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {emptyContent ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="whitespace-normal p-0">
                {/* Keeps the message in view when a wide table scrolls horizontally on small screens. */}
                <div className="sticky left-0 max-w-[calc(100vw-2rem)]">{emptyContent}</div>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow
                key={getRowId(row)}
                className={onRowClick ? 'cursor-pointer' : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row) } : undefined}
              >
                {columns.map((column) => (
                  <TableCell key={column.id} className={cn(ALIGN[column.align ?? 'left'], column.className)}>
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    )
  }

  const showPagination = !loading && !error && filtered.length > pageSize

  return (
    <Card className={cn('overflow-hidden', className)}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {isSample && !loading && data.length > 0 && <SampleTag />}
        </div>
      )}

      {hasToolbar && (
        <div className="flex flex-col gap-3 border-b px-5 py-4 md:flex-row md:items-center md:justify-between">
          {searchable && (
            <div className="relative w-full md:max-w-xs">
              <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => updateQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="pr-8 pl-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => updateQuery('')}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}
          {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}

      {body}

      {showPagination && (
        <div className="flex items-center justify-between gap-3 border-t px-5 py-3 text-sm text-muted-foreground">
          <span>
            Showing <span className="font-medium text-foreground">{currentPage * pageSize + 1}</span>–
            <span className="font-medium text-foreground">
              {Math.min((currentPage + 1) * pageSize, filtered.length)}
            </span>{' '}
            of <span className="font-medium text-foreground">{filtered.length}</span>
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setPage(currentPage - 1)}
              disabled={currentPage === 0}
              aria-label="Previous page"
            >
              <ChevronLeft />
            </Button>
            <span className="px-2 tabular-nums">
              {currentPage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => setPage(currentPage + 1)}
              disabled={currentPage >= pageCount - 1}
              aria-label="Next page"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
