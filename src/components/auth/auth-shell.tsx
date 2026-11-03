import type { ReactNode } from 'react'

import { CompanyLogo } from '@/components/layout/company-logo'
import { COMPANY } from '@/config/app'

/** Centered card layout for sign-in, password and account-status screens. */
export function AuthShell({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-surface-muted">
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-center">
            <CompanyLogo size="auth" />
          </div>
          <div className="rounded-xl border bg-card p-6 shadow-[0_1px_2px_rgba(16,24,40,0.04)] sm:p-8">
            <h1 className="text-lg font-semibold text-foreground">{title}</h1>
            {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
            <div className="mt-6">{children}</div>
          </div>
        </div>
      </main>
      <footer className="px-4 py-4 text-center text-xs text-muted-foreground">
        {COMPANY.legalName} · {COMPANY.productName}
      </footer>
    </div>
  )
}

export function FormAlert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const classes = {
    error: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-green-200 bg-green-50 text-green-800',
    info: 'border-blue-200 bg-blue-50 text-blue-900',
  }[tone]
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`mb-4 rounded-lg border px-3.5 py-2.5 text-sm ${classes}`}>
      {children}
    </div>
  )
}
