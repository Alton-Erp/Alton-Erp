import { CheckCircle2, KeyRound, Loader2, LogOut } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { AuthFlowError } from '@/auth/auth-context'
import { useAuth } from '@/auth/use-auth'
import { AuthLoadingScreen, SetupRequiredNotice } from '@/components/auth/auth-screens'
import { AuthShell, FormAlert } from '@/components/auth/auth-shell'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { parseInvitationLink, type MyInvitation } from '@/features/users/invitation-model'
import { describeDataError } from '@/lib/errors'
import { acceptMyInvitation, establishInvitationSession, fetchMyInvitation } from '@/services/users'

const MIN_LENGTH = 8

/** True when this session was created by signing in with a password (not by an e-mail link). */
function signedInWithPassword(accessToken: string | undefined): boolean {
  try {
    const payload = JSON.parse(atob((accessToken ?? '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { amr?: { method?: string }[] }
    return (payload.amr ?? []).some((a) => a.method === 'password')
  } catch {
    return false
  }
}

const formatExpiry = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Landing page for invitation links (/accept-invitation). Supabase Auth verifies
 * the link and creates the session; the invitee sets a password and activates
 * the account. Company and roles come only from the server-side invitation.
 */
export default function AcceptInvitationPage() {
  const { status, session, updatePassword, signOut, reloadAccess } = useAuth()
  const navigate = useNavigate()
  const [link] = useState(() => parseInvitationLink(window.location.search, window.location.hash))
  const [linking, setLinking] = useState(link.kind === 'token_hash' || link.kind === 'tokens')
  const [linkError, setLinkError] = useState<string | null>(link.kind === 'error' ? link.message : null)
  const [invitation, setInvitation] = useState<MyInvitation | null | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activated, setActivated] = useState(false)
  const userId = session?.user.id

  // Exchange the link for a session once (verifyOtp / setSession), then scrub the URL.
  // A one-time link must be used exactly once, even if the effect runs twice.
  const linkUsed = useRef(false)
  useEffect(() => {
    if (!linking || status === 'unconfigured' || linkUsed.current) return
    linkUsed.current = true
    establishInvitationSession(link).then(
      (message) => {
        setLinkError(message)
        setLinking(false)
      },
      () => {
        setLinkError('The invitation link could not be verified. Check your connection and open the link again.')
        setLinking(false)
      },
    )
  }, [link, linking, status])

  useEffect(() => {
    if (!userId || linking) return
    let cancelled = false
    fetchMyInvitation().then(
      (inv) => !cancelled && setInvitation(inv),
      (err: unknown) => !cancelled && setLoadError(describeDataError(err)),
    )
    return () => {
      cancelled = true
    }
  }, [userId, linking])

  // Open the dashboard once the reloaded access shows the account as active.
  useEffect(() => {
    if (activated && (status === 'authorized' || status === 'error' || status === 'no_roles')) navigate('/', { replace: true })
  }, [activated, status, navigate])

  if (status !== 'unconfigured' && (linking || (status === 'loading' && !session))) return <AuthLoadingScreen label="Verifying your invitation…" />
  if (status === 'unconfigured') {
    return (
      <AuthShell title="Activate your account">
        <SetupRequiredNotice />
      </AuthShell>
    )
  }
  if (activated) return <AuthLoadingScreen label="Account activated. Opening your dashboard…" />

  if (!session) {
    return (
      <AuthShell title="Invitation link invalid or expired">
        <FormAlert>
          {linkError ?? 'This invitation link is invalid, has expired, or was already used.'}{' '}
          Ask your administrator to resend the invitation, then open the newest e-mail.
        </FormAlert>
        <Button asChild variant="outline">
          <Link to="/login">Back to sign in</Link>
        </Button>
      </AuthShell>
    )
  }

  const leave = (
    <Button variant="outline" onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}>
      <LogOut />
      Sign out
    </Button>
  )

  if (loadError) {
    return (
      <AuthShell title="Could not load your invitation">
        <FormAlert>{loadError}</FormAlert>
        {leave}
      </AuthShell>
    )
  }
  if (invitation === undefined) return <AuthLoadingScreen label="Loading your invitation…" />

  if (invitation === null || invitation.status !== 'PENDING') {
    const s = invitation?.status
    const body =
      s === 'ACCEPTED'
        ? 'This invitation was already accepted. Sign in with your e-mail and password.'
        : s === 'REVOKED'
          ? 'This invitation was revoked. Contact your administrator if you think this is a mistake.'
          : s === 'EXPIRED'
            ? 'This invitation has expired. Ask your administrator to resend it.'
            : s === 'FAILED'
              ? 'This invitation is no longer valid. Ask your administrator to resend it.'
              : `No invitation was found for ${session.user.email ?? 'this account'}.`
    return (
      <AuthShell title={s === 'ACCEPTED' ? 'Already activated' : 'Invitation not available'}>
        <FormAlert tone={s === 'ACCEPTED' ? 'info' : 'error'}>{body}</FormAlert>
        {invitation?.support_email && s !== 'ACCEPTED' && (
          <p className="text-sm text-muted-foreground">Support: <a className="text-primary underline" href={`mailto:${invitation.support_email}`}>{invitation.support_email}</a></p>
        )}
        <div className="flex justify-end gap-2">
          {s === 'ACCEPTED' ? (
            <Button asChild>
              <Link to="/">Go to dashboard</Link>
            </Button>
          ) : (
            leave
          )}
        </div>
      </AuthShell>
    )
  }

  const canSkipPassword = signedInWithPassword(session.access_token)

  const activate = async (withPassword: boolean) => {
    setError(null)
    if (withPassword) {
      if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`)
      if (password !== confirm) return setError('The passwords do not match.')
    }
    setSubmitting(true)
    try {
      if (withPassword) await updatePassword(password)
      const result = await acceptMyInvitation()
      if (result.status !== 'ACCEPTED') {
        setError(result.error ?? 'The invitation could not be accepted.')
        setInvitation({ ...invitation, status: result.status === 'EXPIRED' ? 'EXPIRED' : invitation.status })
        setSubmitting(false)
        return
      }
      setActivated(true)
      reloadAccess()
    } catch (err) {
      setError(err instanceof AuthFlowError ? err.message : describeDataError(err))
      setSubmitting(false)
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void activate(true)
  }

  return (
    <AuthShell
      title={`Join ${invitation.company_name}`}
      description={
        <>
          Welcome, <span className="font-medium text-foreground">{invitation.full_name}</span>. Set a password to activate your Alton ERP account.
        </>
      }
    >
      <dl className="mb-4 space-y-1.5 rounded-lg border bg-surface-muted p-3 text-sm">
        <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Account</dt><dd className="break-all">{invitation.email}</dd></div>
        <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Roles</dt><dd>{(invitation.roles ?? []).join(', ') || '—'}</dd></div>
        <div className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">Expires</dt><dd>{formatExpiry(invitation.expires_at)}</dd></div>
      </dl>
      {error && <FormAlert>{error}</FormAlert>}
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="invite-password">Password</Label>
          <PasswordInput id="invite-password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="text-xs text-muted-foreground">At least {MIN_LENGTH} characters.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-password-confirm">Confirm password</Label>
          <PasswordInput id="invite-password-confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {submitting ? 'Activating…' : 'Set password & activate'}
        </Button>
        {canSkipPassword && (
          <Button type="button" variant="outline" className="w-full" disabled={submitting} onClick={() => void activate(false)}>
            <CheckCircle2 />
            Keep my current password & activate
          </Button>
        )}
      </form>
      {invitation.support_email && (
        <p className="mt-4 text-xs text-muted-foreground">
          Questions? Contact <a className="text-primary underline" href={`mailto:${invitation.support_email}`}>{invitation.support_email}</a>.
        </p>
      )}
    </AuthShell>
  )
}
