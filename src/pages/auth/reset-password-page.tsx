import { KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { AuthLoadingScreen } from '@/components/auth/auth-screens'
import { AuthShell, FormAlert } from '@/components/auth/auth-shell'
import { Button } from '@/components/ui/button'

const LINK_PARAMS = /[?#&](code|token_hash|token|access_token|refresh_token|error_description)=/

/**
 * /reset-password — kept only for old password-reset links. Passwords are now reset with a 6-digit
 * code on /forgot-password; an old link never opens a session (any session it created is ended).
 * Invitation links use /accept-invitation and are not affected.
 */
export default function ResetPasswordPage() {
  const { status, signOut } = useAuth()
  const [fromLink] = useState(() => LINK_PARAMS.test(window.location.search + window.location.hash))
  // A session the old link may have opened is ended before anything else is shown.
  const signedIn = status !== 'loading' && status !== 'signed_out' && status !== 'unconfigured'
  const signingOut = useRef(false)

  useEffect(() => {
    if (!fromLink) return
    // Never leave the link's tokens in the address bar or history.
    window.history.replaceState(window.history.state, '', '/reset-password')
  }, [fromLink])

  useEffect(() => {
    if (!fromLink || !signedIn || signingOut.current) return
    signingOut.current = true
    void signOut().finally(() => { signingOut.current = false })
  }, [fromLink, signedIn, signOut])

  if (!fromLink) return <Navigate to="/forgot-password" replace />
  if (status === 'loading' || signedIn) return <AuthLoadingScreen label="Checking the link…" />

  return (
    <AuthShell title="Reset links are no longer used">
      <FormAlert tone="info">Password resets now use a 6-digit code sent by email. This link was not used to sign in.</FormAlert>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button asChild variant="outline"><Link to="/login">Back to sign in</Link></Button>
        <Button asChild><Link to="/forgot-password"><KeyRound /> Get a reset code</Link></Button>
      </div>
    </AuthShell>
  )
}
