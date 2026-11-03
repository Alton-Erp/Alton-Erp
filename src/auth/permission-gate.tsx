import type { ReactNode } from 'react'

import type { PermissionCode } from '@/auth/permissions'
import { usePermissions } from '@/auth/use-permissions'

interface PermissionGateProps {
  /** Required permission. */
  permission?: PermissionCode
  /** Alternatively, any one of these. */
  anyOf?: PermissionCode[]
  fallback?: ReactNode
  children: ReactNode
}

/**
 * Renders children only when the user holds the permission. UX only — hiding
 * a control is not a security boundary; RLS rejects unauthorized writes.
 */
export function PermissionGate({ permission, anyOf, fallback = null, children }: PermissionGateProps) {
  const { has, hasAny } = usePermissions()
  const allowed = (permission ? has(permission) : true) && (anyOf ? hasAny(anyOf) : true)
  return <>{allowed ? children : fallback}</>
}
