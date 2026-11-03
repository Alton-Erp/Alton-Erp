import { ChevronDown, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { NavLink, useLocation } from 'react-router-dom'

import { CompanyLogo } from '@/components/layout/company-logo'
import {
  ALWAYS_OPEN_GROUPS,
  EXPANDED_SECTIONS_KEY,
  activeNavPath,
  ensureSectionOpen,
  sanitizeExpanded,
  toggleSection,
} from '@/components/layout/sidebar-sections'
import { Button } from '@/components/ui/button'
import { Collapsible } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { COMPANY } from '@/config/app'
import { NAV_GROUPS, NAV_ITEMS, type NavItem } from '@/config/navigation'
import { usePersistentState } from '@/hooks/use-persistent-state'
import { useVisibleNavItems } from '@/hooks/use-visible-nav'
import { cn } from '@/lib/utils'

interface SidebarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  mobileOpen: boolean
  onMobileClose: () => void
}

const GROUP_IDS = NAV_GROUPS.map((g) => g.id)
const NAV_PATHS = NAV_ITEMS.map((i) => i.path)

export function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onMobileClose }: SidebarProps) {
  // Only entries the user's role allows; groups with no visible entries are hidden.
  const visibleItems = useVisibleNavItems()
  const visibleGroups = NAV_GROUPS.map((group) => ({
    group,
    items: visibleItems.filter((item) => item.group === group.id),
  })).filter((g) => g.items.length > 0)

  const { pathname } = useLocation()
  const activePath = activeNavPath(pathname, NAV_PATHS)
  const activeGroup = NAV_ITEMS.find((i) => i.path === activePath)?.group ?? null

  // The icon-only rail exists on desktop only; there every entry is shown, as before.
  const isDesktop = useIsDesktop()
  const rail = collapsed && isDesktop

  // Open sections, remembered across visits. Several can be open at once.
  const [stored, setStored] = usePersistentState<unknown>(EXPANDED_SECTIONS_KEY, [])
  const expanded = sanitizeExpanded(stored, GROUP_IDS)

  // When the page changes to one inside a closed section, open that section.
  // Done while rendering (not in an effect) so the active entry is never shown hidden.
  const [seenGroup, setSeenGroup] = useState<string | null>(null)
  if (activeGroup !== seenGroup) {
    setSeenGroup(activeGroup)
    const next = ensureSectionOpen(expanded, activeGroup)
    if (next !== expanded) setStored(next)
  }

  return (
    <>
      {/* Mobile/tablet overlay */}
      <div
        aria-hidden
        onClick={onMobileClose}
        className={cn(
          'fixed inset-0 z-40 bg-gray-900/40 transition-opacity lg:hidden',
          mobileOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        aria-label="Main navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-background transition-[width,transform] duration-200',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:translate-x-0',
          collapsed ? 'lg:w-[64px]' : 'lg:w-64',
        )}
      >
        <div className={cn('flex h-14 shrink-0 items-center border-b px-4', collapsed && 'lg:justify-center lg:px-0')}>
          <CompanyLogo collapsed={collapsed} />
          <Button variant="ghost" size="icon-sm" className="ml-auto lg:hidden" onClick={onMobileClose} aria-label="Close navigation">
            <X />
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {visibleGroups.map(({ group, items }, groupIndex) => {
            const list = (
              <ul className="space-y-px">
                {items.map((item) => (
                  <li key={item.key}>
                    <SidebarLink item={item} isActive={activePath === item.path} collapsed={collapsed} onNavigate={onMobileClose} />
                  </li>
                ))}
              </ul>
            )

            if (rail || ALWAYS_OPEN_GROUPS.includes(group.id)) {
              // A section with a single page (the Management Dashboard) is shown as that link alone.
              const single = items.length === 1 && items[0].title === group.label
              return (
                <div key={group.id} className={cn(groupIndex > 0 && (rail ? 'mt-4' : 'mt-3'), single && !rail && 'mb-2')}>
                  <p
                    className={cn(
                      'mb-1 px-3 text-[11px] font-semibold tracking-wider text-gray-400 uppercase',
                      (collapsed || single) && 'sr-only',
                    )}
                  >
                    {group.label}
                  </p>
                  {collapsed && groupIndex > 0 && <div aria-hidden className="mx-3 mb-2 hidden h-px bg-border lg:block" />}
                  {list}
                </div>
              )
            }

            const open = expanded.includes(group.id)
            const regionId = `sidebar-section-${group.id}`
            return (
              <div key={group.id} className={cn(groupIndex > 0 && 'mt-0.5')}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={regionId}
                  onClick={() => setStored(toggleSection(expanded, group.id))}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-[11px] font-semibold tracking-normal uppercase transition-colors',
                    'hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    // A closed section that holds the current page keeps a hint of where you are.
                    !open && activeGroup === group.id ? 'text-primary' : 'text-gray-400',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  <ChevronDown
                    aria-hidden
                    className={cn('size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180')}
                  />
                </button>
                <Collapsible id={regionId} open={open}>
                  <div className="pt-0.5 pb-1.5 pl-1.5">{list}</div>
                </Collapsible>
              </div>
            )
          })}
        </nav>

        <div className="hidden shrink-0 border-t p-2.5 lg:block">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCollapsed}
            className={cn('w-full justify-start text-muted-foreground', collapsed && 'justify-center px-0')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!collapsed && 'Collapse'}
          </Button>
        </div>
        <p className="border-t px-4 py-3 text-[11px] text-muted-foreground lg:hidden">{COMPANY.legalName}</p>
      </aside>
    </>
  )
}

/** Matches Tailwind's `lg` breakpoint (64rem), where the sidebar is docked and can become the icon rail. */
const DESKTOP_QUERY = '(min-width: 64rem)'

function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(DESKTOP_QUERY)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}

function SidebarLink({ item, isActive, collapsed, onNavigate }: { item: NavItem; isActive: boolean; collapsed: boolean; onNavigate: () => void }) {
  const Icon = item.icon
  const link = (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      onClick={onNavigate}
      // Set explicitly: NavLink would otherwise also mark parent paths (e.g. /inventory on /inventory/stock).
      aria-current={isActive ? 'page' : false}
      className={() =>
        cn(
          'relative flex h-8 items-center gap-2.5 rounded-md px-3 text-[13px] font-medium transition-colors',
          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
          isActive
            ? 'bg-accent text-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-primary'
            : 'text-gray-600 hover:bg-muted hover:text-foreground',
          collapsed && 'lg:justify-center lg:px-0',
        )
      }
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className={cn('truncate', collapsed && 'lg:sr-only')}>{item.title}</span>
    </NavLink>
  )

  if (!collapsed) return link

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="hidden lg:block">
        {item.title}
      </TooltipContent>
    </Tooltip>
  )
}
