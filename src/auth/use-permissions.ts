import { useCallback, useMemo } from 'react'

import type { PermissionCode, RoleCode } from '@/auth/permissions'
import { useAuth } from '@/auth/use-auth'

/**
 * Permission helpers for the signed-in user. For UI decisions only (what to
 * show); the database enforces every permission independently via RLS.
 */
export function usePermissions() {
  const { access, status } = useAuth()
  const authorized = status === 'authorized'

  const permissions = useMemo(
    () => new Set(authorized ? (access?.permissions ?? []) : []),
    [access, authorized],
  )
  const roles = useMemo(() => new Set(authorized ? (access?.roles ?? []) : []), [access, authorized])

  const has = useCallback((permission: PermissionCode) => permissions.has(permission), [permissions])
  const hasAny = useCallback((list: PermissionCode[]) => list.some((p) => permissions.has(p)), [permissions])
  const hasRole = useCallback((role: RoleCode) => roles.has(role), [roles])

  return { permissions, roles, has, hasAny, hasRole }
}
