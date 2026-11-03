import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'

import { TableHead } from '@/components/ui/table'
import { cn } from '@/lib/utils'

interface SortableHeadProps<C extends string> {
  column: C
  label: string
  sort: { column: C; ascending: boolean }
  onSort: (sort: { column: C; ascending: boolean }) => void
  align?: 'left' | 'right'
  className?: string
}

/** Table header cell that toggles sort direction; exposes aria-sort. */
export function SortableHead<C extends string>({ column, label, sort, onSort, align = 'left', className }: SortableHeadProps<C>) {
  const active = sort.column === column
  const Icon = !active ? ArrowUpDown : sort.ascending ? ArrowUp : ArrowDown
  return (
    <TableHead
      aria-sort={active ? (sort.ascending ? 'ascending' : 'descending') : 'none'}
      className={cn(align === 'right' && 'text-right', className)}
    >
      <button
        type="button"
        onClick={() => onSort({ column, ascending: active ? !sort.ascending : true })}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground',
          active && 'text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        <Icon aria-hidden className={cn('size-3', !active && 'opacity-50')} />
      </button>
    </TableHead>
  )
}
