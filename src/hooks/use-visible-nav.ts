import { useMemo } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { NAV_ITEMS, NAV_PERMISSIONS } from '@/config/navigation'

/** Navigation entries the current user may open. */
export function useVisibleNavItems() {
  const { has } = usePermissions()
  return useMemo(
    () =>
      NAV_ITEMS.filter((item) => {
        const permission = NAV_PERMISSIONS[item.key]
        return permission === null || has(permission)
      }),
    [has],
  )
}
