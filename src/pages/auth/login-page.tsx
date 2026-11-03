import { Loader2, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'

import { AuthFlowError } from '@/auth/auth-context'
import { useAuth } from '@/auth/use-auth'
import { AuthLoadingScreen, SetupRequiredNotice } from '@/components/auth/auth-screens'
import { AuthShell, FormAlert } from '@/components/auth/auth-shell'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface LocationState {
  from?: string
  message?: string
}

export default function LoginPage() {
  const { status, signIn, sessionExpired } = useAuth()
  const location = useLocation()
  const state = (location.state ?? {}) as LocationState
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  if (status === 'loading') return <AuthLoadingScreen />

  // Any signed-in state goes to the app; ProtectedRoute explains inactive/pending accounts.
  if (status !== 'signed_out' && status !== 'unconfigured') {
    const target = state.from && state.from.startsWith('/') && !state.from.startsWith('//') ? state.from : '/'
    return <Navigate to={target} replace />
  }

  const emailError = touched && !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : null
  const passwordError = touched && password.length === 0 ? 'Enter your password.' : null

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    setError(null)
    if (!EMAIL_RE.test(email.trim()) || password.length === 0) return
    setSubmitting(true)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(err instanceof AuthFlowError ? err.message : 'Sign-in failed. Please try again.')
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell title="Sign in" description="Use your company account to access the ERP.">
      {status === 'unconfigured' ? (
        <SetupRequiredNotice />
      ) : (
        <>
          {sessionExpired && !error && <FormAlert tone="info">Your session has expired. Please sign in again.</FormAlert>}
          {state.message && !error && <FormAlert tone="success">{state.message}</FormAlert>}
          {error && <FormAlert>{error}</FormAlert>}

          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Email</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(emailError)}
                aria-describedby={emailError ? 'login-email-error' : undefined}
              />
              {emailError && (
                <p id="login-email-error" className="text-xs text-shortage">
                  {emailError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="login-password">Password</Label>
                <Link to="/forgot-password" className="text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </Link>
              </div>
              <PasswordInput
                id="login-password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(passwordError)}
                aria-describedby={passwordError ? 'login-password-error' : undefined}
              />
              {passwordError && (
                <p id="login-password-error" className="text-xs text-shortage">
                  {passwordError}
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <LogIn />}
              {submitting ? 'Signing in…' : 'Sign In'}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Accounts are created by your administrator. There is no public sign-up.
          </p>
        </>
      )}
    </AuthShell>
  )
}
