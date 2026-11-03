import { ShieldX } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

import type { PermissionCode } from '@/auth/permissions'
import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { logSecurityEvent } from '@/services/access'

/** Route-level permission check. Shows an access-denied page instead of the content. */
export function RequirePermission({ permission, children }: { permission?: PermissionCode; children: ReactNode }) {
  const { has } = usePermissions()
  if (!permission || has(permission)) return <>{children}</>
  return <UnauthorizedPage />
}

export function UnauthorizedPage() {
  const { pathname } = useLocation()
  const { has } = usePermissions()

  useEffect(() => {
    void logSecurityEvent('auth.access_denied', { path: pathname })
  }, [pathname])

  return (
    <>
      <PageHeader title="Access denied" description="Your role does not include access to this page." />
      <Card>
        <EmptyState
          icon={ShieldX}
          title="You don't have permission to view this page"
          description="If you need access, ask an administrator to update your role."
          action={
            has('dashboard.read') ? (
              <Button asChild variant="outline">
                <Link to="/">Go to Dashboard</Link>
              </Button>
            ) : undefined
          }
        />
      </Card>
    </>
  )
}
