import { Activity, AlertTriangle, BookOpen, CalendarDays, FileClock, Landmark, Scale } from 'lucide-react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  CLASSIFICATIONS, CLASSIFICATION_LABELS, PAYMENT_METHOD_LABELS, formatAmount, formatBalance, toPaise, type EventStatus,
} from '@/features/accounting/accounting-model'
import { AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchAccountingDashboard } from '@/services/accounting'

export default function AccountsDashboardPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{() => <><PageHeader /><AccountingNotice /><Dashboard /></>}</SetupGate>
}

function Dashboard() {
  const { has } = usePermissions()
  const d = useAsync(() => fetchAccountingDashboard(), [])
  if (d.loading) return <LoadingState variant="cards" />
  if (d.error) return <ErrorState message={describeDataError(d.error)} onRetry={d.reload} />
  const x = d.data!
  const ev = (s: EventStatus) => x.events?.[s] ?? 0
  const balanced = toPaise(x.books?.total_debit) === toPaise(x.books?.total_credit)
  const attention = ev('FAILED') + ev('NEEDS_ACCOUNT_MAPPING')
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label={`Vouchers posted (FY ${x.financial_year})`} value={String(x.vouchers?.posted_this_fy ?? 0)} icon={BookOpen} accent="available"
          hint={`${x.vouchers?.automatic ?? 0} automatic · ${x.vouchers?.manual ?? 0} manual`} to={has('vouchers.read') ? '/accounts/vouchers?status=POSTED' : null} />
        <KpiCard label="Draft vouchers" value={String(x.vouchers?.draft ?? 0)} icon={FileClock} accent="pending" hint="Not in any report until posted"
          to={has('vouchers.read') ? '/accounts/vouchers?status=DRAFT' : null} />
        <KpiCard label="Postings needing attention" value={String(attention)} icon={AlertTriangle} accent={attention ? 'shortage' : 'neutral'}
          hint={`${ev('FAILED')} failed · ${ev('NEEDS_ACCOUNT_MAPPING')} need an account · ${ev('PENDING')} pending`} to="/accounts/posting-monitor" />
        <KpiCard label="Books balance" value={balanced ? 'Balanced' : 'NOT BALANCED'} icon={Scale} accent={balanced ? 'available' : 'shortage'}
          hint={`Debit ${formatAmount(x.books?.total_debit)} · Credit ${formatAmount(x.books?.total_credit)}`} to="/accounts/trial-balance" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle>Financial year {x.financial_year}</CardTitle>
            <CardDescription>Net balances by classification from {x.fy_from ? formatDate(x.fy_from) : '—'} (debit − credit)</CardDescription></div></CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {CLASSIFICATIONS.map((c) => (
                <div key={c} className="flex items-center justify-between py-1.5"><dt>{CLASSIFICATION_LABELS[c]}</dt>
                  <dd className="font-medium tabular-nums">{formatBalance(x.classification?.[c] ?? 0)}</dd></div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><div><CardTitle>Books</CardTitle><CardDescription>Set-up and control</CardDescription></div></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex items-center gap-2"><Landmark className="size-4 text-muted-foreground" /> Books start {x.books_start_date ? formatDate(x.books_start_date) : '—'}</p>
            <p className="flex items-center gap-2"><CalendarDays className="size-4 text-muted-foreground" /> Current period: {x.periods?.current ?? 'none — create the periods'} ·
              {' '}{x.periods?.open ?? 0} open, {x.periods?.closed ?? 0} closed</p>
            <p className="flex items-center gap-2"><Activity className="size-4 text-muted-foreground" /> Opening balances:{' '}
              {x.opening?.posted ? 'posted' : x.opening?.in_progress ? 'in progress' : 'not entered'} · <Link className="text-primary hover:underline" to="/accounts/opening-balances">open</Link></p>
            {(x.unmapped_payment_methods ?? []).length > 0 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
                Customer receipts by {(x.unmapped_payment_methods ?? []).map((m) => PAYMENT_METHOD_LABELS[m as keyof typeof PAYMENT_METHOD_LABELS] ?? m).join(', ')} have no cash / bank
                account yet; they wait in the Posting Monitor until mapped in <Link className="font-medium underline" to="/accounts/settings?tab=rules">Accounting Settings</Link>.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
