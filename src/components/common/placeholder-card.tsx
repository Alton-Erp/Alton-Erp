import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { EmptyState } from '@/components/common/empty-state'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** Marks a section whose functionality is scheduled for a later build phase. */
export function PhaseBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border bg-surface-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase',
        className,
      )}
    >
      Later phase
    </span>
  )
}

interface PlaceholderCardProps {
  title: string
  description?: string
  icon?: LucideIcon
  emptyTitle: string
  emptyDescription: ReactNode
  className?: string
}

/** A titled card holding an explanatory empty state for a not-yet-built section. */
export function PlaceholderCard({
  title,
  description,
  icon,
  emptyTitle,
  emptyDescription,
  className,
}: PlaceholderCardProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <PhaseBadge />
      </CardHeader>
      <CardContent className="pt-0">
        <EmptyState compact icon={icon} title={emptyTitle} description={emptyDescription} />
      </CardContent>
    </Card>
  )
}
