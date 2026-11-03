import type { Session, User } from '@supabase/supabase-js'
import { createContext } from 'react'

import type { MyAccess } from '@/services/access'

/**
 * unconfigured     Supabase env vars missing or invalid
 * loading          restoring the session or loading access
 * signed_out       no session
 * no_profile       signed in, but no profile row (never treated as privileged)
 * pending          profile exists but has not been assigned to a company yet
 * inactive         profile deactivated by an administrator
 * company_inactive the user's company is disabled
 * no_roles         active, but no role assigned
 * error            access could not be loaded (network, etc.)
 * authorized       active member with at least one role
 */
export type AuthStatus =
  | 'unconfigured'
  | 'loading'
  | 'signed_out'
  | 'no_profile'
  | 'pending'
  | 'inactive'
  | 'company_inactive'
  | 'no_roles'
  | 'error'
  | 'authorized'

export interface AuthContextValue {
  status: AuthStatus
  session: Session | null
  user: User | null
  access: MyAccess | null
  accessError: string | null
  /** Set when the session ended without the user signing out (e.g. refresh token expired). */
  sessionExpired: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  updatePassword: (password: string) => Promise<void>
  reloadAccess: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

/** Error with a message that is safe to show to the user. */
export class AuthFlowError extends Error {}
