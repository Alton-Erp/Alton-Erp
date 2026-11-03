import { Building2, ChevronDown, LogOut, Menu, Settings, UserCog } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'

import { CompanyLogo } from '@/components/layout/company-logo'
import { GlobalSearch } from '@/components/layout/global-search'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ROLE_LABELS } from '@/auth/permissions'
import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { COMPANY } from '@/config/app'
import { NotificationsMenu } from '@/features/admin/notifications-menu'
import { cn } from '@/lib/utils'

export function TopNav({ onOpenMobileNav, sidebarCollapsed = false }: { onOpenMobileNav: () => void; sidebarCollapsed?: boolean }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={onOpenMobileNav} aria-label="Open navigation">
        <Menu />
      </Button>
      {/* Compact logo wherever the sidebar logo is not in view: mobile/tablet, and the collapsed desktop rail. */}
      <Link to="/" title="Dashboard" className={cn('shrink-0 rounded-sm', !sidebarCollapsed && 'lg:hidden')}>
        <CompanyLogo size="header" />
      </Link>
      <GlobalSearch />

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <NotificationsMenu />
        <UserMenu />
      </div>
    </header>
  )
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?'
}

function UserMenu() {
  const navigate = useNavigate()
  const { access, signOut } = useAuth()
  const { has } = usePermissions()

  const name = access?.profile?.full_name || access?.profile?.email || 'Signed-in user'
  const roleLabel = access?.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || 'No role'
  const companyName = access?.company?.display_name ?? COMPANY.legalName

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg p-1 pr-2 outline-none transition-colors hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/40"
          aria-label="Account menu"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-gray-200 text-xs font-semibold text-gray-700">
            {initials(name)}
          </span>
          <span className="hidden max-w-44 text-left leading-tight md:block">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{roleLabel}</span>
          </span>
          <ChevronDown aria-hidden className="hidden size-4 text-muted-foreground md:block" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal">
          <p className="truncate text-sm font-medium">{name}</p>
          {access?.profile?.email && <p className="truncate text-xs text-muted-foreground">{access.profile.email}</p>}
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{companyName}</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{roleLabel}</p>
        </DropdownMenuLabel>
        {(has('users.manage') || has('settings.manage')) && <DropdownMenuSeparator />}
        {has('users.manage') && (
          <DropdownMenuItem onSelect={() => navigate('/users')}>
            <UserCog />
            Users & roles
          </DropdownMenuItem>
        )}
        {has('settings.manage') && (
          <DropdownMenuItem onSelect={() => navigate('/admin/erp-settings')}>
            <Settings />
            ERP settings
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
