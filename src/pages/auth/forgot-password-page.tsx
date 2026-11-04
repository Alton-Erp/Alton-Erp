import { ArrowLeft, Check, CheckCircle2, KeyRound, Loader2, Mail, RotateCw, ShieldCheck, X } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { AuthFlowError } from '@/auth/auth-context'
import { useAuth } from '@/auth/use-auth'
import { AuthLoadingScreen, SetupRequiredNotice } from '@/components/auth/auth-screens'
import { AuthShell, FormAlert } from '@/components/auth/auth-shell'
import { OtpInput } from '@/components/auth/otp-input'
import { PasswordInput } from '@/components/auth/password-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  clearPendingRequest,
  EMAIL_RE,
  emptyOtp,
  OTP_LENGTH,
  otpComplete,
  passwordChecks,
  readPendingRequest,
  resendSecondsLeft,
  RESEND_SECONDS,
  savePendingRequest,
  validateNewPassword,
  type PendingRequest,
} from '@/features/auth/password-recovery'
import { cn } from '@/lib/utils'

const SIGN_IN_DELAY_MS = 2500
const errorText = (err: unknown, fallback: string) => (err instanceof AuthFlowError ? err.message : fallback)

/**
 * /forgot-password — password reset with a 6-digit e-mail code:
 * e-mail address → code (verifyOtp, type recovery) → new password (updateUser) → sign in again.
 * The code is kept only in this page's memory.
 */
export default function ForgotPasswordPage() {
  const { status, session, recoveryPending } = useAuth()
  const [request, setRequest] = useState<PendingRequest | null>(readPendingRequest)
  const [done, setDone] = useState(false)
  // Set while the new password is saved and the session ends, so no other step flashes in between.
  const [finishing, setFinishing] = useState(false)

  if (status === 'unconfigured') {
    return <AuthShell title="Reset your password"><SetupRequiredNotice /><BackToSignIn /></AuthShell>
  }
  if (done) return <DoneStep />
  if (recoveryPending && session) {
    return <PasswordStep email={session.user.email ?? ''} onSaving={setFinishing} onDone={() => { setFinishing(false); setDone(true) }} />
  }
  if (finishing) return <AuthLoadingScreen label="Updating password…" />
  if (status === 'loading' && !request) return <AuthLoadingScreen />
  if (request) {
    return (
      <CodeStep
        request={request}
        onResent={(r) => setRequest(r)}
        onChangeEmail={() => { clearPendingRequest(); setRequest(null) }}
      />
    )
  }
  return <EmailStep onSent={(r) => setRequest(r)} />
}

function BackToSignIn({ onClick }: { onClick?: () => void }) {
  return (
    <div className="mt-6 text-center">
      <Link to="/login" onClick={onClick} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
        <ArrowLeft className="size-3.5" /> Back to sign in
      </Link>
    </div>
  )
}

function EmailStep({ onSent }: { onSent: (r: PendingRequest) => void }) {
  const { requestPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const address = email.trim()
    if (!EMAIL_RE.test(address)) return setError('Enter a valid email address.')
    setSubmitting(true)
    try {
      await requestPasswordReset(address)
      const r = { email: address, sentAt: Date.now() }
      savePendingRequest(r)
      onSent(r)
    } catch (err) {
      setError(errorText(err, 'Something went wrong. Please try again.'))
      setSubmitting(false)
    }
  }

  return (
    <AuthShell title="Reset your password" description="Enter your account's email address. We'll send you a 6-digit code.">
      {error && <FormAlert>{error}</FormAlert>}
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="forgot-email">Email</Label>
          <Input id="forgot-email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} disabled={submitting} />
        </div>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" /> : <Mail />}
          {submitting ? 'Sending code…' : 'Send code'}
        </Button>
      </form>
      <BackToSignIn />
    </AuthShell>
  )
}

function CodeStep({ request, onResent, onChangeEmail }: { request: PendingRequest; onResent: (r: PendingRequest) => void; onChangeEmail: () => void }) {
  const { verifyRecoveryCode, requestPasswordReset } = useAuth()
  const [digits, setDigits] = useState(emptyOtp)
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  // Resend is possible RESEND_SECONDS after the last code (or later, when the server asks to wait longer).
  const [cooldownFrom, setCooldownFrom] = useState(request.sentAt)
  const [cooldown, setCooldown] = useState(RESEND_SECONDS)
  const [now, setNow] = useState(Date.now)
  const left = resendSecondsLeft(cooldownFrom, now, cooldown)

  useEffect(() => {
    if (left <= 0) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [left])

  const verify = async (code: string[]) => {
    if (verifying) return
    if (!otpComplete(code)) return setError(`Enter all ${OTP_LENGTH} digits of the code.`)
    setError(null)
    setNotice(null)
    setVerifying(true)
    try {
      await verifyRecoveryCode(request.email, code.join(''))
      // The page switches to the password step; the code is dropped from memory.
      setDigits(emptyOtp())
    } catch (err) {
      setError(errorText(err, 'The code could not be verified. Please try again.'))
      setDigits(emptyOtp())
      setVerifying(false)
      setFocusSignal((n) => n + 1)
    }
  }

  const onDigits = (next: string[]) => {
    setDigits(next)
    if (error) setError(null)
    // Checked as soon as the last digit is entered.
    if (otpComplete(next) && !otpComplete(digits)) void verify(next)
  }

  const resend = async () => {
    if (left > 0 || resending) return
    setError(null)
    setNotice(null)
    setResending(true)
    try {
      await requestPasswordReset(request.email)
      const r = { email: request.email, sentAt: Date.now() }
      savePendingRequest(r)
      setCooldownFrom(r.sentAt)
      setCooldown(RESEND_SECONDS)
      setNow(Date.now())
      setDigits(emptyOtp())
      setNotice('A new code has been sent. Earlier codes no longer work.')
      setFocusSignal((n) => n + 1)
      onResent(r)
    } catch (err) {
      const wait = err instanceof AuthFlowError ? err.retryAfter : null
      if (wait) {
        setCooldownFrom(Date.now())
        setCooldown(wait)
        setNow(Date.now())
      }
      setError(errorText(err, 'The code could not be sent. Please try again.'))
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthShell
      title="Enter the 6-digit code"
      description={<>If an account exists for <span className="font-medium text-foreground break-words">{request.email}</span>, we have emailed it a 6-digit code. The code expires after a short time.</>}
    >
      {error && <FormAlert>{error}</FormAlert>}
      {notice && !error && <FormAlert tone="success">{notice}</FormAlert>}
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void verify(digits) }} noValidate>
        <OtpInput digits={digits} onChange={onDigits} disabled={verifying} invalid={Boolean(error)} focusSignal={focusSignal} describedBy="otp-help" />
        <p id="otp-help" className="text-xs text-muted-foreground">Type or paste the code from the email. Only the latest code works.</p>
        <Button type="submit" className="w-full" disabled={verifying || !otpComplete(digits)}>
          {verifying ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          {verifying ? 'Verifying…' : 'Verify code'}
        </Button>
      </form>
      <div className="mt-4 flex flex-col items-center gap-2 text-sm sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={() => void resend()} disabled={left > 0 || resending || verifying} data-testid="otp-resend">
          {resending ? <Loader2 className="animate-spin" /> : <RotateCw />}
          {resending ? 'Sending…' : left > 0 ? `Resend code in ${left}s` : 'Resend code'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onChangeEmail} disabled={verifying}>Use a different email</Button>
      </div>
      <BackToSignIn onClick={clearPendingRequest} />
    </AuthShell>
  )
}

function PasswordStep({ email, onSaving, onDone }: { email: string; onSaving: (saving: boolean) => void; onDone: () => void }) {
  const { completePasswordRecovery, cancelPasswordRecovery } = useAuth()
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState<'save' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checks = passwordChecks(password, email)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    setError(null)
    const problem = validateNewPassword(password, confirm, email)
    if (problem) return setError(problem)
    setBusy('save')
    onSaving(true)
    try {
      await completePasswordRecovery(password)
      setPassword('')
      setConfirm('')
      onDone()
    } catch (err) {
      setError(errorText(err, 'Could not update the password. Please try again.'))
      setBusy(null)
      onSaving(false)
    }
  }

  const cancel = async () => {
    setBusy('cancel')
    setPassword('')
    setConfirm('')
    await cancelPasswordRecovery()
    navigate('/login', { replace: true })
  }

  return (
    <AuthShell title="Choose a new password" description={<>Code verified for <span className="font-medium text-foreground break-words">{email}</span>.</>}>
      {error && <FormAlert>{error}</FormAlert>}
      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="new-password">New password</Label>
          <PasswordInput id="new-password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy !== null} />
          <ul className="grid gap-1 pt-1 text-xs sm:grid-cols-2" aria-label="Password requirements">
            {checks.map((c) => (
              <li key={c.key} data-check={c.key} data-ok={c.ok} className={cn('flex items-center gap-1.5', c.ok ? 'text-green-700' : touched ? 'text-red-700' : 'text-muted-foreground')}>
                {c.ok ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />} {c.label}
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <PasswordInput id="confirm-password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy !== null}
            aria-invalid={touched && confirm !== password ? true : undefined} />
          {touched && confirm.length > 0 && confirm !== password && <p className="text-xs text-red-700">The passwords do not match.</p>}
        </div>
        <Button type="submit" className="w-full" disabled={busy !== null}>
          {busy === 'save' ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {busy === 'save' ? 'Updating password…' : 'Update password'}
        </Button>
        <Button type="button" variant="ghost" className="w-full" onClick={() => void cancel()} disabled={busy !== null}>
          {busy === 'cancel' && <Loader2 className="animate-spin" />} Cancel and keep the old password
        </Button>
      </form>
    </AuthShell>
  )
}

function DoneStep() {
  const navigate = useNavigate()
  const message = 'Your password has been updated. Sign in with your new password.'
  useEffect(() => {
    const t = window.setTimeout(() => navigate('/login', { replace: true, state: { message } }), SIGN_IN_DELAY_MS)
    return () => window.clearTimeout(t)
  }, [navigate])
  return (
    <AuthShell title="Password updated">
      <FormAlert tone="success">
        <span className="flex items-start gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />{message} You have been signed out on every device.</span>
      </FormAlert>
      <Button className="w-full" onClick={() => navigate('/login', { replace: true, state: { message } })}>Continue to sign in</Button>
    </AuthShell>
  )
}
