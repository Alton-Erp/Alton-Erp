import { Suspense, useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'

import { ErrorBoundary } from '@/components/common/error-boundary'
import { LoadingState } from '@/components/common/loading-state'
import { Sidebar } from '@/components/layout/sidebar'
import { TopNav } from '@/components/layout/top-nav'
import { TooltipProvider } from '@/components/ui/tooltip'
import { COMPANY } from '@/config/app'
import { NAV_ITEMS, findNavItemByPath } from '@/config/navigation'
import { ErpPreferencesProvider } from '@/features/management/erp-preferences-provider'
import { usePersistentState } from '@/hooks/use-persistent-state'
import { installGlobalErrorReporting } from '@/lib/error-reporting'
import { cn } from '@/lib/utils'

export function AppLayout() {
  const [collapsed, setCollapsed] = usePersistentState('alton-erp:sidebar-collapsed', false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => installGlobalErrorReporting(), [])

  // Document title + scroll reset on navigation.
  useEffect(() => {
    // Sub-pages (e.g. /products/new) take their section's title.
    const page =
      findNavItemByPath(pathname) ??
      NAV_ITEMS.find((item) => item.path !== '/' && pathname.startsWith(`${item.path}/`))
    document.title = page ? `${page.title} · Alton ERP` : 'Alton ERP'
    window.scrollTo(0, 0)
  }, [pathname])

  return (
    <TooltipProvider>
      <ErpPreferencesProvider>
      <div className="min-h-dvh bg-surface-muted">
        <a
          href="#main-content"
          className="sr-only z-[60] rounded-md bg-background px-3 py-2 text-sm shadow focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <Sidebar
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
          mobileOpen={mobileOpen}
          onMobileClose={() => setMobileOpen(false)}
        />
        <div className={cn('flex min-h-dvh min-w-0 flex-col transition-[padding] duration-200', collapsed ? 'lg:pl-[64px]' : 'lg:pl-64')}>
          <TopNav onOpenMobileNav={() => setMobileOpen(true)} sidebarCollapsed={collapsed} />
          <main id="main-content" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            <div className="mx-auto w-full min-w-0 max-w-[1600px]">
              <Suspense fallback={<LoadingState label="Loading page…" />}>
                <ErrorBoundary resetKey={pathname}>
                  <Outlet />
                </ErrorBoundary>
              </Suspense>
            </div>
          </main>
          <footer className="border-t bg-background px-4 py-3 text-xs text-muted-foreground sm:px-6 lg:px-8">
            {COMPANY.legalName} · {COMPANY.productName}
          </footer>
        </div>
      </div>
      </ErpPreferencesProvider>
    </TooltipProvider>
  )
}
