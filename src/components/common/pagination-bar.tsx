import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatNumber } from '@/lib/format'

interface PaginationBarProps {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
  pageSizes?: number[]
  disabled?: boolean
}

/** Footer for server-side paginated tables. `page` is zero-based. */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizes = [25, 50, 100],
  disabled = false,
}: PaginationBarProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min((page + 1) * pageSize, total)

  return (
    <div className="flex flex-col gap-3 border-t px-5 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>
        Showing <span className="font-medium text-foreground">{formatNumber(from)}</span>–
        <span className="font-medium text-foreground">{formatNumber(to)}</span> of{' '}
        <span className="font-medium text-foreground">{formatNumber(total)}</span>
      </span>
      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline">Rows</span>
            <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))} disabled={disabled}>
              <SelectTrigger className="h-8 w-[72px]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageChange(page - 1)}
            disabled={disabled || page === 0}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <span className="px-2 tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => onPageChange(page + 1)}
            disabled={disabled || page >= pageCount - 1}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
