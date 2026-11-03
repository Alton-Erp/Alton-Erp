import { KeyRound, Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { AuthFlowError } from '@/auth/auth-context'
import { useAuth } from '@/auth/use-auth'
import { AuthLoadingScreen, SetupRequiredNotice } from '@/components/auth/auth-screens'
import { AuthShell, FormAlert } from '@/components/auth/auth-shell'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

const MIN_LENGTH = 8

/** Reads an error returned by Supabase in the redirect URL (query or hash). */
function linkErrorFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  return params.get('error_description') ?? hash.get('error_description')
}

/**
 * Landing page for password-reset and invitation links. supabase-js exchanges
 * the link for a short-lived session; the user then sets a new password.
 */
export default function ResetPasswordPage() {
  const { status, session, updatePassword, signOut } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [linkError] = useState(linkErrorFromUrl)

  if (status === 'loading') return <AuthLoadingScreen label="Verifying your link…" />

  if (status === 'unconfigured') {
    return (
      <AuthShell title="Set a new password">
        <SetupRequiredNotice />
      </AuthShell>
    )
  }

  // Signing out after a successful change; avoid flashing the "invalid link" state.
  if (!session && submitting) return <AuthLoadingScreen label="Password saved…" />

  if (!session) {
    return (
      <AuthShell title="Link invalid or expired">
        <FormAlert>
          {linkError ? 'This link is invalid or has expired.' : 'This link is invalid, has expired, or was opened in a different browser.'}{' '}
          Request a new one and open it in the same browser.
        </FormAlert>
        <div className="flex justify-between gap-2">
          <Button asChild variant="outline">
            <Link to="/login">Back to sign in</Link>
          </Button>
          <Button asChild>
            <Link to="/forgot-password">Request a new link</Link>
          </Button>
        </div>
      </AuthShell>
    )
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`)
    if (password !== confirm) return setError('The passwords do not match.')
    setSubmitting(true)
    try {
      await updatePassword(password)
      await signOut()
      navigate('/login', { replace: true, state: { message: 'Your password has been set. Sign in with your new password.' } })
    } catch (err) {
      setError(err instanceof AuthFlowError ? err.message : 'Could not update the password. Please try again.')
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title="Set a new password"
      description={
        <>
          For <span className="font-medium text-foreground">{session.user.email}</span>
        </>
      }
    >
      {error && <FormAlert>{error}</FormAlert>}
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">New password</Label>
          <PasswordInput
            id="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">At least {MIN_LENGTH} characters.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <PasswordInput
            id="confirm-password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {submitting ? 'Saving…' : 'Save password'}
        </Button>
      </form>
    </AuthShell>
  )
}
