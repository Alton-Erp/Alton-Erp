import { BarChart3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  buildCostCentreTree, financialYear, flattenCostCentreTree, formatAmount, formatBalance, fyMonthLabels, rollUp, toPaise, type CostCentre,
} from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingExport, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { CostCentreSelect } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBudgetVsActual, fetchCostCentreLedger, fetchCostCentreProfitability, fetchCostCentreSummary, fetchCostCentres } from '@/services/accounting'

type Tab = 'summary' | 'ledger' | 'profitability' | 'budget'

export default function CostCentreReportsPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <Reports today={s.today} fyStartMonth={s.settings!.fy_start_month} />}</SetupGate>
}

function Reports({ today, fyStartMonth }: { today: string; fyStartMonth: number }) {
  const [params, setParams] = useSearchParams()
  const fy = financialYear(today, fyStartMonth)
  const get = (k: string, d = '') => params.get(k) ?? d
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const tab = (get('tab', 'summary') as Tab)
  const from = get('from', fy.from)
  const to = get('to', today)
  const centres = useAsync(() => fetchCostCentres(), [])
  return (
    <>
      <PageHeader />
      <AccountingNotice>Only posted and reversed vouchers count. Allocated figures are shown per cost centre; income and expense posted without a cost centre are shown apart as Unallocated.</AccountingNotice>
      <FilterTabs label="Report" className="mb-4" value={tab} onChange={(v) => set('tab', v)} options={[
        { value: 'summary', label: 'Cost centre summary' }, { value: 'ledger', label: 'Cost centre ledger' }, { value: 'profitability', label: 'Profitability' },
        { value: 'budget', label: 'Budget vs actual' }]} />
      {tab !== 'budget' && (
        <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="cr-from">From</Label><Input id="cr-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="cr-to">To</Label><Input id="cr-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          {tab === 'ledger' && <>
            <div className="w-72 space-y-1"><Label htmlFor="cr-cc">Cost centre</Label><CostCentreSelect id="cr-cc" value={get('cc')} centres={centres.data} activeOnly={false} onChange={(v) => set('cc', v)} /></div>
            <div className="w-72 space-y-1"><Label htmlFor="cr-acc">Ledger account</Label><AccountSelect id="cr-acc" value={get('account')} postableOnly={false} allowClear placeholder="All accounts" onChange={(v) => set('account', v)} /></div>
          </>}
        </CardContent></Card>
      )}
      {tab === 'summary' && <Summary from={from} to={to} centres={centres.data ?? []} />}
      {tab === 'ledger' && <Ledger from={from} to={to} cc={get('cc')} account={get('account')} />}
      {tab === 'profitability' && <ProfitabilityView from={from} to={to} centres={centres.data ?? []} />}
      {tab === 'budget' && <BudgetVsActualView fyLabel={get('fy', fy.label)} month={get('month')} cc={get('cc')} account={get('account')} centres={centres.data} fyStartMonth={fyStartMonth}
        fyNow={fy.label} onChange={set} />}
    </>
  )
}

const num = (v: unknown) => Number(v ?? 0)

function Summary({ from, to, centres }: { from: string; to: string; centres: CostCentre[] }) {
  const [rollup, setRollup] = useState(false)
  const s = useAsync(() => fetchCostCentreSummary(from, to), [from, to])
  const order = useMemo(() => flattenCostCentreTree(buildCostCentreTree(centres)), [centres])
  if (s.loading) return <LoadingState variant="table" />
  if (s.error) return <ErrorState message={describeDataError(s.error)} onRetry={s.reload} />
  const x = s.data!
  const byId = new Map(x.rows.map((r) => [r.cost_centre_id, r]))
  const roll = (k: 'income' | 'expense' | 'budget') => rollUp(centres, Object.fromEntries(x.rows.map((r) => [r.cost_centre_id, r[k]])))
  const ri = roll('income'), re = roll('expense'), rb = roll('budget')
  const val = (id: string, k: 'income' | 'expense' | 'budget') => (rollup ? { income: ri, expense: re, budget: rb }[k][id] : num(byId.get(id)?.[k]))
  const allocated = (k: 'income' | 'expense') => x.rows.reduce((t, r) => t + toPaise(r[k]), 0)
  const reconciles = allocated('income') + toPaise(x.unallocated.income) === toPaise(x.company.income) && allocated('expense') + toPaise(x.unallocated.expense) === toPaise(x.company.expense)
  return (
    <Card>
      <CardHeader><div><CardTitle>Cost centre summary</CardTitle><CardDescription>{formatDate(from)} – {formatDate(to)} · budget = approved budget of the months in the period</CardDescription></div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={rollup} onCheckedChange={(v) => setRollup(v === true)} /> Include sub-centres</label>
          <StatusBadge label={reconciles ? 'Allocated + unallocated = company totals' : 'Does not reconcile'} tone={reconciles ? 'success' : 'danger'} />
          <AccountingExport title="Cost centre summary" fileStem={`cost-centre-summary-${from}-${to}`} rows={order.map((n) => n.centre)} columns={[
            { header: 'Code', value: (c) => c.cost_centre_code }, { header: 'Cost centre', value: (c) => c.cost_centre_name },
            { header: 'Income', value: (c) => val(c.id, 'income') }, { header: 'Expenditure', value: (c) => val(c.id, 'expense') },
            { header: 'Net', value: (c) => (toPaise(val(c.id, 'income')) - toPaise(val(c.id, 'expense'))) / 100 }, { header: 'Budget', value: (c) => val(c.id, 'budget') },
            { header: 'Actual', value: (c) => val(c.id, 'expense') }, { header: 'Variance', value: (c) => (toPaise(val(c.id, 'budget')) - toPaise(val(c.id, 'expense'))) / 100 },
          ]} extraRows={[['', 'Unallocated', num(x.unallocated.income), num(x.unallocated.expense), num(x.unallocated.net)], ['', 'Company total', num(x.company.income), num(x.company.expense)]]} />
        </div></CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Cost centre</TableHead><TableHead className="text-right">Income</TableHead><TableHead className="text-right">Expenditure</TableHead>
            <TableHead className="text-right">Net result</TableHead><TableHead className="text-right">Budget</TableHead><TableHead className="text-right">Actual</TableHead>
            <TableHead className="text-right">Variance</TableHead></TableRow></TableHeader>
          <TableBody>
            {order.map(({ centre: c, depth }) => {
              const inc = val(c.id, 'income'), exp = val(c.id, 'expense'), bud = val(c.id, 'budget')
              return (
                <TableRow key={c.id} data-testid="cc-summary-row">
                  <TableCell><span style={{ paddingLeft: depth * 18 }} className="inline-block"><span className="mr-2 font-mono text-xs text-muted-foreground">{c.cost_centre_code}</span>
                    <Link className="text-primary hover:underline" to={`/accounts/cost-centres/reports?tab=ledger&cc=${c.id}&from=${from}&to=${to}`}>{c.cost_centre_name}</Link></span></TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(inc)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(exp)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount((toPaise(inc) - toPaise(exp)) / 100)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(bud)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(exp)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${toPaise(bud) - toPaise(exp) < 0 ? 'text-red-700' : ''}`}>{formatAmount((toPaise(bud) - toPaise(exp)) / 100)}</TableCell>
                </TableRow>
              )
            })}
            <TableRow className="bg-amber-50/60" data-testid="cc-unallocated"><TableCell className="font-medium">Unallocated (no cost centre)</TableCell>
              <TableCell className="text-right tabular-nums">{formatAmount(x.unallocated.income)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(x.unallocated.expense)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatAmount(x.unallocated.net)}</TableCell><TableCell colSpan={3} /></TableRow>
            <TableRow className="border-t-2 font-semibold"><TableCell>Company total (all posted income / expense)</TableCell>
              <TableCell className="text-right tabular-nums">{formatAmount(x.company.income)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(x.company.expense)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatAmount((toPaise(x.company.income) - toPaise(x.company.expense)) / 100)}</TableCell><TableCell colSpan={3} /></TableRow>
          </TableBody>
        </Table>
        {rollup && <p className="p-3 text-xs text-muted-foreground">With sub-centres each row includes its sub-centres, so rows are not additive.</p>}
      </CardContent>
    </Card>
  )
}

function Ledger({ from, to, cc, account }: { from: string; to: string; cc: string; account: string }) {
  const l = useAsync(() => (cc ? fetchCostCentreLedger(cc, from, to, account || null) : Promise.resolve(null)), [cc, from, to, account])
  if (!cc) return <EmptyState icon={BarChart3} title="Choose a cost centre" description="The ledger lists every posted allocation of the cost centre with a running balance." />
  if (l.loading) return <LoadingState variant="table" />
  if (l.error) return <ErrorState message={describeDataError(l.error)} onRetry={l.reload} />
  const x = l.data!
  return (
    <Card>
      <CardHeader><div><CardTitle>{x.cost_centre.cost_centre_code} {x.cost_centre.cost_centre_name}</CardTitle><CardDescription>{formatDate(from)} – {formatDate(to)} · allocated amounts</CardDescription></div>
        <AccountingExport title="Cost centre ledger" fileStem={`cost-centre-ledger-${x.cost_centre.cost_centre_code}-${from}-${to}`} rows={x.entries} columns={[
          { header: 'Date', value: (e) => e.voucher_date }, { header: 'Voucher no.', value: (e) => e.voucher_number }, { header: 'Ledger account', value: (e) => `${e.account_code} ${e.account_name}` },
          { header: 'Narration', value: (e) => e.narration }, { header: 'Debit', value: (e) => num(e.debit) }, { header: 'Credit', value: (e) => num(e.credit) },
          { header: 'Running balance (Dr + / Cr −)', value: (e) => num(e.balance) },
        ]} extraRows={[['', '', '', 'Opening balance', '', '', num(x.opening_balance)], ['', '', '', 'Closing balance', '', '', num(x.closing_balance)]]} /></CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Voucher</TableHead><TableHead>Ledger account</TableHead><TableHead>Narration</TableHead>
            <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead className="text-right">Running balance</TableHead></TableRow></TableHeader>
          <TableBody>
            <TableRow className="bg-muted/40"><TableCell colSpan={6} className="font-medium">Opening balance</TableCell><TableCell className="text-right tabular-nums">{formatBalance(x.opening_balance)}</TableCell></TableRow>
            {x.entries.map((e, i) => (
              <TableRow key={`${e.voucher_id}-${i}`}><TableCell className="whitespace-nowrap">{formatDate(e.voucher_date)}</TableCell>
                <TableCell><Link className="text-primary hover:underline" to={`/accounts/vouchers/${e.voucher_id}`}>{e.voucher_number}</Link></TableCell>
                <TableCell>{e.account_code} {e.account_name}</TableCell><TableCell className="max-w-md text-sm">{e.narration ?? ''}</TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(e.debit, true)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(e.credit, true)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBalance(e.balance)}</TableCell></TableRow>
            ))}
            <TableRow className="border-t-2 font-semibold"><TableCell colSpan={6}>Closing balance</TableCell><TableCell className="text-right tabular-nums">{formatBalance(x.closing_balance)}</TableCell></TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function ProfitabilityView({ from, to, centres }: { from: string; to: string; centres: CostCentre[] }) {
  const p = useAsync(() => fetchCostCentreProfitability(from, to), [from, to])
  const order = useMemo(() => flattenCostCentreTree(buildCostCentreTree(centres)), [centres])
  if (p.loading) return <LoadingState variant="table" />
  if (p.error) return <ErrorState message={describeDataError(p.error)} onRetry={p.reload} />
  const x = p.data!
  const byId = new Map(x.rows.map((r) => [r.cost_centre_id, r]))
  const cols = ['revenue', 'direct_expenses', 'indirect_expenses', 'net_contribution'] as const
  return (
    <Card>
      <CardHeader><div><CardTitle>Cost centre profitability</CardTitle><CardDescription>Direct expenses: accounts under Purchase Accounts or Direct Expenses; all other expenses are indirect.</CardDescription></div>
        <AccountingExport title="Cost centre profitability" fileStem={`cost-centre-profitability-${from}-${to}`} rows={x.rows} columns={[
          { header: 'Code', value: (r) => r.cost_centre_code }, { header: 'Cost centre', value: (r) => r.cost_centre_name }, { header: 'Revenue', value: (r) => num(r.revenue) },
          { header: 'Direct expenses', value: (r) => num(r.direct_expenses) }, { header: 'Indirect expenses', value: (r) => num(r.indirect_expenses) },
          { header: 'Net contribution', value: (r) => num(r.net_contribution) },
        ]} extraRows={[['', 'Unallocated', num(x.unallocated.revenue), num(x.unallocated.direct_expenses), num(x.unallocated.indirect_expenses), num(x.unallocated.net_contribution)]]} /></CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Cost centre</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Direct expenses</TableHead>
            <TableHead className="text-right">Indirect expenses</TableHead><TableHead className="text-right">Net contribution</TableHead></TableRow></TableHeader>
          <TableBody>
            {order.map(({ centre: c, depth }) => { const r = byId.get(c.id); return (
              <TableRow key={c.id}><TableCell><span style={{ paddingLeft: depth * 18 }} className="inline-block"><span className="mr-2 font-mono text-xs text-muted-foreground">{c.cost_centre_code}</span>{c.cost_centre_name}</span></TableCell>
                {cols.map((k) => <TableCell key={k} className="text-right tabular-nums">{formatAmount(r?.[k] ?? 0)}</TableCell>)}</TableRow>) })}
            <TableRow className="bg-amber-50/60"><TableCell className="font-medium">Unallocated (no cost centre)</TableCell>
              {cols.map((k) => <TableCell key={k} className="text-right tabular-nums">{formatAmount(x.unallocated[k])}</TableCell>)}</TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function BudgetVsActualView({ fyLabel, month, cc, account, centres, fyStartMonth, fyNow, onChange }: {
  fyLabel: string; month: string; cc: string; account: string; centres?: CostCentre[]; fyStartMonth: number; fyNow: string; onChange: (k: string, v: string) => void
}) {
  const months = fyMonthLabels(fyStartMonth)
  const b = useAsync(() => fetchBudgetVsActual(fyLabel, month ? Number(month) : null, cc || null, account || null), [fyLabel, month, cc, account])
  const prevFy = `${Number(fyNow.slice(0, 4)) - 1}${fyNow.includes('-') ? `-${String(Number(fyNow.slice(0, 4)) % 100).padStart(2, '0')}` : ''}`
  return (
    <>
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="bv-fy">Financial year</Label>
          <Select value={fyLabel} onValueChange={(v) => onChange('fy', v)}><SelectTrigger id="bv-fy" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>{[fyNow, prevFy].map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-1"><Label htmlFor="bv-month">Up to month</Label>
          <Select value={month || 'all'} onValueChange={(v) => onChange('month', v === 'all' ? '' : v)}><SelectTrigger id="bv-month" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Whole year</SelectItem>{months.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent></Select></div>
        <div className="w-64 space-y-1"><Label htmlFor="bv-cc">Cost centre</Label><CostCentreSelect id="bv-cc" value={cc} centres={centres} activeOnly={false} allowClear placeholder="All cost centres" onChange={(v) => onChange('cc', v)} /></div>
        <div className="w-72 space-y-1"><Label htmlFor="bv-acc">Ledger account</Label><AccountSelect id="bv-acc" value={account} postableOnly={false} allowClear placeholder="All accounts" onChange={(v) => onChange('account', v)} /></div>
      </CardContent></Card>
      {b.loading ? <LoadingState variant="table" /> : b.error ? <ErrorState message={describeDataError(b.error)} onRetry={b.reload} /> : (() => {
        const x = b.data!
        return (
          <Card>
            <CardHeader><div><CardTitle>Budget vs actual — FY {x.financial_year}</CardTitle>
              <CardDescription>{x.budget ? `Approved budget version ${x.budget.version} (${x.budget.budget_name})` : 'No approved budget for this year: actuals only.'} · actuals {formatDate(x.from)} – {formatDate(x.to)}.
                Variance = period budget − actual (for income a negative variance means more income than budgeted).</CardDescription></div>
              <AccountingExport title="Budget vs actual" fileStem={`budget-vs-actual-${x.financial_year}`} rows={x.rows} columns={[
                { header: 'Cost centre', value: (r) => `${r.cost_centre_code} ${r.cost_centre_name}` }, { header: 'Account', value: (r) => `${r.account_code} ${r.account_name}` },
                { header: 'Type', value: (r) => r.classification }, { header: 'Annual budget', value: (r) => num(r.annual_budget) }, { header: 'Monthly budget', value: (r) => num(r.monthly_budget) },
                { header: 'Budget to date', value: (r) => num(r.period_budget) }, { header: 'Actual', value: (r) => num(r.actual) }, { header: 'Remaining budget', value: (r) => num(r.remaining) },
                { header: 'Variance', value: (r) => num(r.variance) }, { header: 'Variance %', value: (r) => (r.variance_percent === null ? null : num(r.variance_percent)) },
              ]} /></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              {!x.rows.length ? <p className="p-4 text-sm text-muted-foreground">No budget lines and no allocated actuals for this selection.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Cost centre</TableHead><TableHead>Account</TableHead><TableHead className="text-right">Annual budget</TableHead>
                    <TableHead className="text-right">Monthly budget ({months[x.upto_month - 1]})</TableHead><TableHead className="text-right">Budget to date</TableHead><TableHead className="text-right">Actual</TableHead>
                    <TableHead className="text-right">Remaining</TableHead><TableHead className="text-right">Variance</TableHead><TableHead className="text-right">Variance %</TableHead></TableRow></TableHeader>
                  <TableBody>{x.rows.map((r) => (
                    <TableRow key={`${r.cost_centre_id}-${r.account_id}`} data-testid="bva-row">
                      <TableCell><span className="font-mono text-xs">{r.cost_centre_code}</span> {r.cost_centre_name}</TableCell>
                      <TableCell><span className="font-mono text-xs">{r.account_code}</span> {r.account_name}{r.classification === 'INCOME' && <span className="ml-1 text-xs text-muted-foreground">(income)</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(r.annual_budget)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(r.monthly_budget)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(r.period_budget)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(r.actual)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(r.remaining)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${num(r.variance) < 0 && r.classification === 'EXPENSE' ? 'text-red-700' : ''}`}>{formatAmount(r.variance)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.variance_percent === null ? '—' : `${num(r.variance_percent).toFixed(2)}%`}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )
      })()}
    </>
  )
}
