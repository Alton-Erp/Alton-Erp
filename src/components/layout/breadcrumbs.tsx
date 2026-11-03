import { ChevronRight, Home } from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'

export interface BreadcrumbItem {
  label: string
  to?: string
}

export function Breadcrumbs({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-xs text-muted-foreground', className)}>
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link
            to="/"
            className="flex items-center rounded p-0.5 transition-colors hover:text-foreground"
            aria-label="Dashboard"
          >
            <Home className="size-3.5" />
          </Link>
        </li>
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1">
              <ChevronRight aria-hidden className="size-3.5 text-gray-400" />
              {item.to && !isLast ? (
                <Link to={item.to} className="transition-colors hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined} className={cn(isLast && 'font-medium text-foreground')}>
                  {item.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
