import { ArrowLeft, Loader2, Mail } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { AuthFlowError } from '@/auth/auth-context'
import { useAuth } from '@/auth/use-auth'
import { SetupRequiredNotice } from '@/components/auth/auth-screens'
import { AuthShell, FormAlert } from '@/components/auth/auth-shell'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function ForgotPasswordPage() {
  const { status, requestPasswordReset } = useAuth()
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!EMAIL_RE.test(email.trim())) {
      setError('Enter a valid email address.')
      return
    }
    setSubmitting(true)
    try {
      await requestPasswordReset(email)
      setSent(true)
    } catch (err) {
      setError(err instanceof AuthFlowError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell title="Reset your password" description="We'll email you a link to choose a new password.">
      {status === 'unconfigured' ? (
        <SetupRequiredNotice />
      ) : sent ? (
        // Identical response whether or not the address has an account.
        <FormAlert tone="success">
          If an account exists for <strong>{email.trim()}</strong>, a password reset link has been sent. The link
          expires after a short time — open it in this same browser.
        </FormAlert>
      ) : (
        <>
          {error && <FormAlert>{error}</FormAlert>}
          <form className="space-y-4" onSubmit={onSubmit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="forgot-email">Email</Label>
              <Input
                id="forgot-email"
                type="email"
                autoComplete="username"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="animate-spin" /> : <Mail />}
              {submitting ? 'Sending…' : 'Send reset link'}
            </Button>
          </form>
        </>
      )}
      <div className="mt-6 text-center">
        <Link to="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <ArrowLeft className="size-3.5" />
          Back to sign in
        </Link>
      </div>
    </AuthShell>
  )
}
