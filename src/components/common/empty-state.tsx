import type { LucideIcon } from 'lucide-react'
import { Inbox } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: ReactNode
  action?: ReactNode
  /** Smaller padding for use inside cards and tables. */
  compact?: boolean
  className?: string
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-muted text-muted-foreground">
        <Icon aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      {description && (
        <div className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">{description}</div>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}
