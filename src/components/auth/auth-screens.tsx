import { Clock, Loader2, LogOut, PlugZap, RotateCw, ShieldOff, UserX } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { AuthStatus } from '@/auth/auth-context'
import { useAuth } from '@/auth/use-auth'
import { AuthShell } from '@/components/auth/auth-shell'
import { Button } from '@/components/ui/button'
import { supabaseConfigError } from '@/lib/supabase'

export function AuthLoadingScreen({ label = 'Checking your session…' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-muted" role="status" aria-live="polite">
      <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin text-primary" />
        {label}
      </div>
    </div>
  )
}

/** Shown when the Supabase URL/key are missing or invalid. */
export function SetupRequiredNotice() {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-amber-900">
        <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>{supabaseConfigError}</p>
      </div>
      <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
        <li>Create or open your Supabase project.</li>
        <li>
          Copy the <strong className="text-foreground">Project URL</strong> and the{' '}
          <strong className="text-foreground">publishable (or anon) key</strong> from Project Settings → API.
        </li>
        <li>
          Set <code className="rounded bg-muted px-1">VITE_SUPABASE_URL</code> and{' '}
          <code className="rounded bg-muted px-1">VITE_SUPABASE_PUBLISHABLE_KEY</code> in <code className="rounded bg-muted px-1">.env.local</code>{' '}
          or your hosting environment, then restart or redeploy.
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">See docs/SUPABASE_SETUP.md for the full procedure.</p>
    </div>
  )
}

export function SetupRequiredScreen() {
  return (
    <AuthShell title="Connect the database" description="The ERP needs a Supabase connection before anyone can sign in.">
      <SetupRequiredNotice />
    </AuthShell>
  )
}

const STATUS_COPY: Partial<Record<AuthStatus, { icon: typeof Clock; title: string; body: ReactNode }>> = {
  no_profile: {
    icon: UserX,
    title: 'Account profile not found',
    body: 'You are signed in, but no ERP profile exists for this account. No access has been granted. Ask an administrator to provision your account.',
  },
  pending: {
    icon: Clock,
    title: 'Account setup pending',
    body: 'Your account exists but has not been assigned to a company yet. An administrator must complete your setup before you can use the ERP.',
  },
  inactive: {
    icon: ShieldOff,
    title: 'Account deactivated',
    body: 'Your account has been deactivated. Contact your administrator if you believe this is a mistake.',
  },
  company_inactive: {
    icon: ShieldOff,
    title: 'Company access suspended',
    body: 'Access for your company is currently disabled. Contact your administrator.',
  },
  no_roles: {
    icon: Clock,
    title: 'No role assigned',
    body: 'Your account is active but has no role yet, so there is nothing you can access. Ask an administrator to assign a role.',
  },
}

/** Blocks the app for signed-in users who are not (or no longer) authorized. */
export function AccountStatusScreen({ status }: { status: AuthStatus }) {
  const { user, signOut, reloadAccess } = useAuth()
  const [signingOut, setSigningOut] = useState(false)
  const copy = STATUS_COPY[status]
  if (!copy) return null
  const Icon = copy.icon

  return (
    <AuthShell title={copy.title}>
      <div className="flex gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-muted-foreground">
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="text-sm">
          <p className="text-muted-foreground">{copy.body}</p>
          {user?.email && (
            <p className="mt-3 text-xs text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{user.email}</span>
            </p>
          )}
        </div>
      </div>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={reloadAccess}>
          <RotateCw />
          Check again
        </Button>
        <Button
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true)
            void signOut().finally(() => setSigningOut(false))
          }}
        >
          <LogOut />
          Sign out
        </Button>
      </div>
    </AuthShell>
  )
}

export function AccessErrorScreen() {
  const { accessError, reloadAccess, signOut } = useAuth()
  return (
    <AuthShell title="Could not load your access" description={accessError ?? 'An unexpected error occurred.'}>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={() => void signOut()}>
          <LogOut />
          Sign out
        </Button>
        <Button onClick={reloadAccess}>
          <RotateCw />
          Try again
        </Button>
      </div>
    </AuthShell>
  )
}
