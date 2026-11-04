import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import {
  AccessErrorScreen,
  AccountStatusScreen,
  AuthLoadingScreen,
  SetupRequiredScreen,
} from '@/components/auth/auth-screens'

/**
 * Restricts its children to signed-in, active users with an active company
 * and at least one role. Every other state gets an explanatory screen — never
 * a default grant of access.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, recoveryPending } = useAuth()
  const location = useLocation()

  // A verified password-recovery code is not a sign-in: the new password must be set first.
  if (recoveryPending) return <Navigate to="/forgot-password" replace />

  switch (status) {
    case 'unconfigured':
      return <SetupRequiredScreen />
    case 'loading':
      return <AuthLoadingScreen />
    case 'signed_out':
      return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
    case 'error':
      return <AccessErrorScreen />
    case 'authorized':
      return <>{children}</>
    default:
      return <AccountStatusScreen status={status} />
  }
}
