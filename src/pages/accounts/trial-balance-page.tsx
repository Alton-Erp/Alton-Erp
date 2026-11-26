import { Scale } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CLASSIFICATIONS, CLASSIFICATION_LABELS, financialYear, formatAmount, toPaise, type TrialBalanceRow } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchTrialBalance } from '@/services/accounting'

export default function TrialBalancePage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <TrialBalanceView fyStartMonth={s.settings!.fy_start_month} today={s.today} />}</SetupGate>
}

const COLS = ['opening_debit', 'opening_credit', 'period_debit', 'period_credit', 'closing_debit', 'closing_credit'] as const

function TrialBalanceView({ fyStartMonth, today }: { fyStartMonth: number; today: string }) {
  const [params, setParams] = useSearchParams()
  const fy = financialYear(today, fyStartMonth)
  const from = params.get('from') ?? fy.from
  const to = params.get('to') ?? today
  const [includeZero, setIncludeZero] = useState(false)
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const tb = useAsync(() => (from && to && from <= to ? fetchTrialBalance(from, to, includeZero) : Promise.reject(new Error('Choose a valid date range.'))), [from, to, includeZero])
  const t = tb.data
  const balanced = t ? toPaise(t.totals.closing_debit) === toPaise(t.totals.closing_credit) && toPaise(t.totals.period_debit) === toPaise(t.totals.period_credit) : true

  return (
    <>
      <PageHeader actions={<AccountingExport title="Trial balance" fileStem={`trial-balance-${from}-${to}`} rows={t?.rows ?? []} columns={[
        { header: 'Code', value: (r: TrialBalanceRow) => r.account_code }, { header: 'Account', value: (r) => r.account_name }, { header: 'Group', value: (r) => r.group_name },
        { header: 'Classification', value: (r) => CLASSIFICATION_LABELS[r.classification] },
        { header: 'Opening debit', value: (r) => Number(r.opening_debit) }, { header: 'Opening credit', value: (r) => Number(r.opening_credit) },
        { header: 'Debit', value: (r) => Number(r.period_debit) }, { header: 'Credit', value: (r) => Number(r.period_credit) },
        { header: 'Closing debit', value: (r) => Number(r.closing_debit) }, { header: 'Closing credit', value: (r) => Number(r.closing_credit) },
      ]} extraRows={t ? [['', 'Total', '', '', ...COLS.map((c) => Number(t.totals[c]))]] : []} />} />
      <AccountingNotice />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="tb-from">From</Label><Input id="tb-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="tb-to">To</Label><Input id="tb-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={includeZero} onCheckedChange={(v) => setIncludeZero(v === true)} /> Show accounts without balances</label>
          {t && <span className="ml-auto pb-2"><StatusBadge label={balanced ? 'Debit = credit' : 'NOT BALANCED'} tone={balanced ? 'success' : 'danger'} /></span>}
        </CardContent>
      </Card>
      {tb.loading ? <LoadingState variant="table" /> : tb.error ? <ErrorState message={describeDataError(tb.error)} onRetry={tb.reload} />
        : !t?.rows.length ? <EmptyState icon={Scale} title="No balances" description={`No posted vouchers up to ${formatDate(to)}.`} /> : (
          <Card><CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow><TableHead rowSpan={2}>Account</TableHead><TableHead colSpan={2} className="text-center">Opening ({formatDate(from)})</TableHead>
                  <TableHead colSpan={2} className="text-center">Transactions</TableHead><TableHead colSpan={2} className="text-center">Closing ({formatDate(to)})</TableHead></TableRow>
                <TableRow>{COLS.map((c) => <TableHead key={c} className="text-right">{c.endsWith('debit') ? 'Debit' : 'Credit'}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {CLASSIFICATIONS.map((cl) => {
                  const rows = t.rows.filter((r) => r.classification === cl)
                  if (!rows.length) return null
                  return (
                    <Fragment key={cl}>
                      <TableRow className="bg-muted/40"><TableCell colSpan={7} className="font-semibold">{CLASSIFICATION_LABELS[cl]}</TableCell></TableRow>
                      {rows.map((r) => (
                        <TableRow key={r.account_id}>
                          <TableCell><Link className="text-primary hover:underline" to={`/accounts/general-ledger?account=${r.account_id}&from=${from}&to=${to}`}>
                            <span className="mr-2 font-mono text-xs text-muted-foreground">{r.account_code}</span>{r.account_name}</Link>
                            <span className="block text-xs text-muted-foreground">{r.group_name}</span></TableCell>
                          {COLS.map((c) => <TableCell key={c} className="text-right tabular-nums">{formatAmount(r[c], true)}</TableCell>)}
                        </TableRow>
                      ))}
                    </Fragment>
                  )
                })}
                <TableRow className="border-t-2 font-semibold"><TableCell>Total</TableCell>
                  {COLS.map((c) => <TableCell key={c} className="text-right tabular-nums">{formatAmount(t.totals[c])}</TableCell>)}</TableRow>
              </TableBody>
            </Table>
          </CardContent></Card>
        )}
    </>
  )
}
