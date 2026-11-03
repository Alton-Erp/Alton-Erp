import { Loader2 } from 'lucide-react'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface LoadingStateProps {
  variant?: 'spinner' | 'table' | 'cards' | 'chart'
  label?: string
  rows?: number
  className?: string
}

export function LoadingState({
  variant = 'spinner',
  label = 'Loading…',
  rows = 5,
  className,
}: LoadingStateProps) {
  if (variant === 'table') {
    return (
      <div className={cn('space-y-3 p-4', className)} role="status" aria-label={label}>
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (variant === 'cards') {
    return (
      <div
        className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)}
        role="status"
        aria-label={label}
      >
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-[118px] rounded-xl" />
        ))}
      </div>
    )
  }

  if (variant === 'chart') {
    return (
      <div className={cn('flex h-full min-h-56 items-end gap-3 px-2 pb-2', className)} role="status" aria-label={label}>
        {[45, 70, 55, 85, 60, 75, 40].map((h, i) => (
          <Skeleton key={i} className="flex-1" style={{ height: `${h}%` }} />
        ))}
      </div>
    )
  }

  return (
    <div
      className={cn('flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground', className)}
      role="status"
    >
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {label}
    </div>
  )
}
