import { AlertTriangle, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ErrorStateProps {
  title?: string
  message?: string
  onRetry?: () => void
  compact?: boolean
  className?: string
}

export function ErrorState({
  title = 'Something went wrong',
  message = 'The data could not be loaded. Please try again.',
  onRetry,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-8' : 'px-6 py-14',
        className,
      )}
    >
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-red-50 text-shortage">
        <AlertTriangle aria-hidden className="size-5" />
      </div>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          <RotateCw />
          Try again
        </Button>
      )}
    </div>
  )
}
