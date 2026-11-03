import type { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'

import { Breadcrumbs, type BreadcrumbItem } from '@/components/layout/breadcrumbs'
import { findNavItemByPath, getNavGroupLabel } from '@/config/navigation'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  /** Defaults to the current route's navigation title. */
  title?: string
  /** Defaults to the current route's navigation description. */
  description?: string
  /** Defaults to "Group / Page" derived from the navigation config. */
  breadcrumbs?: BreadcrumbItem[]
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, breadcrumbs, actions, className }: PageHeaderProps) {
  const { pathname } = useLocation()
  const navItem = findNavItemByPath(pathname)

  const resolvedTitle = title ?? navItem?.title ?? ''
  const resolvedDescription = description ?? navItem?.description
  const resolvedCrumbs =
    breadcrumbs ??
    (navItem && navItem.path !== '/'
      ? [{ label: getNavGroupLabel(navItem.group) }, { label: navItem.title }]
      : [{ label: resolvedTitle }])

  return (
    <header className={cn('mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="min-w-0">
        <Breadcrumbs items={resolvedCrumbs} className="mb-2" />
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{resolvedTitle}</h1>
        {resolvedDescription && (
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{resolvedDescription}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 lg:justify-end">{actions}</div>}
    </header>
  )
}
