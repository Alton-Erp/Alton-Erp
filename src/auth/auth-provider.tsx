import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AuthContext, AuthFlowError, type AuthContextValue, type AuthStatus } from '@/auth/auth-context'
import { browserStorage, flushAllDrafts } from '@/features/drafts/draft-flush'
import { clearLocalDrafts } from '@/features/drafts/draft-model'
import { describeAuthError, describeDataError, isNetworkError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { fetchMyAccess, logSecurityEvent, type MyAccess } from '@/services/access'

/** Re-check access when the tab regains focus after this long (ms). */
const ACCESS_RECHECK_MS = 5 * 60 * 1000

/** Access is stored with the user it was loaded for, so a stale result is never applied to another user. */
type AccessState = { userId: string; data: MyAccess | null; error: string | null }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionReady, setSessionReady] = useState(!supabase)
  const [accessState, setAccessState] = useState<AccessState | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [sessionExpired, setSessionExpired] = useState(false)

  const userSignedOut = useRef(false)
  const hadSession = useRef(false)
  const lastAccessCheck = useRef(0)

  // Session tracking. No awaits inside the callback: supabase-js holds an auth
  // lock while notifying, and nested Supabase calls there can deadlock.
  useEffect(() => {
    if (!supabase) return
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'SIGNED_OUT') {
        if (hadSession.current && !userSignedOut.current) setSessionExpired(true)
        userSignedOut.current = false
      }
      if (event === 'SIGNED_IN') setSessionExpired(false)
      if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') setReloadKey((k) => k + 1)
      hadSession.current = Boolean(nextSession)
      setSession(nextSession)
      setSessionReady(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id

  // Load profile, company, roles and permissions whenever the user changes.
  useEffect(() => {
    if (!supabase || !userId) return
    let cancelled = false
    fetchMyAccess().then(
      (result) => {
        if (cancelled) return
        lastAccessCheck.current = Date.now()
        setAccessState({ userId, data: result, error: null })
      },
      (error: unknown) => {
        if (cancelled) return
        // Keep previously loaded access on a transient refresh failure.
        setAccessState((prev) => ({
          userId,
          data: prev?.userId === userId ? prev.data : null,
          error: describeDataError(error),
        }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [userId, reloadKey])

  // Pick up deactivation or role changes when the user returns to the tab.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && userId && Date.now() - lastAccessCheck.current > ACCESS_RECHECK_MS) {
        setReloadKey((k) => k + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [userId])

  const current = accessState && accessState.userId === userId ? accessState : null
  const accessForUser = current?.data ?? null
  const accessError = current?.error ?? null

  const status: AuthStatus = useMemo(() => {
    if (!supabase) return 'unconfigured'
    if (!sessionReady) return 'loading'
    if (!session) return 'signed_out'
    if (!accessForUser) return accessError ? 'error' : 'loading'
    const { profile, company, roles } = accessForUser
    if (!profile) return 'no_profile'
    if (!profile.company_id || !company) return 'pending'
    if (!company.is_active) return 'company_inactive'
    if (!profile.is_active) return 'inactive'
    if (roles.length === 0) return 'no_roles'
    return 'authorized'
  }, [sessionReady, session, accessForUser, accessError])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) throw new AuthFlowError('Supabase is not configured.')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new AuthFlowError(describeAuthError(error))
    void logSecurityEvent('auth.sign_in')
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return
    userSignedOut.current = true
    // Open forms save their pending drafts first; then this browser keeps only copies the server does not have yet.
    await flushAllDrafts()
    const signedOutUser = (await supabase.auth.getSession()).data.session?.user.id
    if (signedOutUser) clearLocalDrafts(browserStorage(), signedOutUser)
    await logSecurityEvent('auth.sign_out')
    const { error } = await supabase.auth.signOut()
    // If the server call fails, still drop the local session.
    if (error) await supabase.auth.signOut({ scope: 'local' })
    setAccessState(null)
  }, [])

  const requestPasswordReset = useCallback(async (email: string) => {
    if (!supabase) throw new AuthFlowError('Supabase is not configured.')
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    })
    // Only rate-limit and connectivity problems are reported; anything else is
    // treated as success so the response never reveals whether an account exists.
    if (error && (error.status === 429 || isNetworkError(error))) {
      throw new AuthFlowError(describeAuthError(error))
    }
  }, [])

  const updatePassword = useCallback(async (password: string) => {
    if (!supabase) throw new AuthFlowError('Supabase is not configured.')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw new AuthFlowError(describeAuthError(error))
    void logSecurityEvent('auth.password_changed')
  }, [])

  const reloadAccess = useCallback(() => {
    setAccessState((prev) => (prev ? { ...prev, error: null } : prev))
    setReloadKey((k) => k + 1)
  }, [])

  const value: AuthContextValue = {
    status,
    session,
    user: session?.user ?? null,
    access: accessForUser,
    accessError,
    sessionExpired,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
    reloadAccess,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
