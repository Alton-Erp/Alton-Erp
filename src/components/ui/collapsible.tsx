import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

interface CollapsibleProps {
  open: boolean
  id?: string
  className?: string
  children: ReactNode
}

/**
 * Animated show/hide region. The height animates with a CSS grid row (0fr ↔ 1fr), so no measuring is needed.
 * A closed region is `inert`: its links cannot be focused or clicked, and screen readers skip it.
 */
export function Collapsible({ open, id, className, children }: CollapsibleProps) {
  return (
    <div
      id={id}
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  )
}
