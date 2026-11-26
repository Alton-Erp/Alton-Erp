import { Download, Loader2, Plus, Trash2, Upload, Wallet } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  BUDGET_STATUS_META, budgetTemplate, financialYear, formatAmount, fyMonthLabels, isPositiveAmount, parseBudgetSheet, type Budget, type BudgetLine,
} from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingExport, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { CostCentreSelect } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { approveBudget, cancelBudget, createBudget, fetchAccounts, fetchBudget, fetchBudgets, replaceBudgetLines, reviseBudget } from '@/services/accounting'

export default function CostCentreBudgetsPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <Budgets today={s.today} fyStartMonth={s.settings!.fy_start_month} />}</SetupGate>
}

/** Existing lines in the shape accounting_budget_lines_replace accepts. */
const lineInput = (l: BudgetLine) => ({ cost_centre_id: l.cost_centre_id, account_id: l.account_id, annual: String(l.annual_amount), months: l.months.map(String), notes: l.notes })

function Budgets({ today, fyStartMonth }: { today: string; fyStartMonth: number }) {
  const { has } = usePermissions()
  const fyNow = financialYear(today, fyStartMonth)
  const fyNext = financialYear(addDay(fyNow.to), fyStartMonth)
  const [fy, setFy] = useState(fyNow.label)
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const list = useAsync(() => fetchBudgets(fy), [fy, refresh])
  const current = selected ?? (list.data ?? []).find((b) => b.status === 'DRAFT')?.id ?? (list.data ?? []).find((b) => b.status === 'APPROVED')?.id ?? (list.data ?? [])[0]?.id ?? null
  const done = (m: string) => { setAction(null); setMessage({ text: m, ok: true }); setRefresh((n) => n + 1) }
  const startDate = (label: string) => (label === fyNow.label ? fyNow.from : fyNext.from)

  return (
    <>
      <PageHeader actions={has('accounting_budgets.manage') ? <Button onClick={() => setAction({
        title: `New budget for FY ${fy}`, description: 'A new draft version. Import the lines from Excel / CSV or add them below, then approve it.', confirmLabel: 'Create draft',
        note: 'required', noteLabel: 'Budget name', minLength: 2,
        run: async (n) => { const b = await createBudget(startDate(fy), n!, null); setSelected(b.id); return `Draft version ${b.version} created.` },
      })}><Plus /> New budget</Button> : undefined} />
      <AccountingNotice>Budgets are plans only: they never create vouchers or change balances. One approved version per financial year; a revision creates a new version.</AccountingNotice>
      {message && <p role={message.ok ? 'status' : 'alert'} className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${message.ok ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800'}`}>{message.text}</p>}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="bd-fy">Financial year</Label>
            <Select value={fy} onValueChange={(v) => { setFy(v); setSelected(null) }}><SelectTrigger id="bd-fy" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>{[fyNow.label, fyNext.label].map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent></Select></div>
          <div className="flex flex-wrap gap-2 pb-0.5">{(list.data ?? []).map((b) => (
            <Button key={b.id} variant={b.id === current ? 'default' : 'outline'} size="sm" onClick={() => setSelected(b.id)}>
              v{b.version} · {BUDGET_STATUS_META[b.status].label} · {formatAmount(b.total_annual)}</Button>))}</div>
        </CardContent>
      </Card>
      {list.loading ? <LoadingState /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        : !current ? <EmptyState icon={Wallet} title={`No budget for FY ${fy}`} description="Create a draft and import the cost centre budgets from Excel or CSV." />
          : <BudgetDetail key={`${current}-${refresh}`} budgetId={current} fyStartMonth={fyStartMonth} onAction={setAction} onMessage={(t, ok) => { setMessage({ text: t, ok }); if (ok) setRefresh((n) => n + 1) }} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
const addDay = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }

function BudgetDetail({ budgetId, fyStartMonth, onAction, onMessage }: {
  budgetId: string; fyStartMonth: number; onAction: (a: ActionRequest) => void; onMessage: (text: string, ok: boolean) => void
}) {
  const { has } = usePermissions()
  const b = useAsync(() => fetchBudget(budgetId), [budgetId])
  const [busy, setBusy] = useState(false)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [cc, setCc] = useState('')
  const [account, setAccount] = useState('')
  const [annual, setAnnual] = useState('')
  const accounts = useAsync(() => fetchAccounts(null, false), [])
  const months = fyMonthLabels(fyStartMonth)
  if (b.loading) return <LoadingState variant="table" />
  if (b.error) return <ErrorState message={describeDataError(b.error)} onRetry={b.reload} />
  const x: Budget = b.data!
  const draft = x.status === 'DRAFT'
  const canEdit = draft && has('accounting_budgets.manage')
  const save = async (lines: Record<string, unknown>[], source: 'MANUAL' | 'IMPORT', fileName: string | null, ok: string) => {
    setBusy(true)
    try { await replaceBudgetLines(x.id, lines, source, fileName); onMessage(ok, true) } catch (e) { onMessage(describeDataError(e), false) } finally { setBusy(false) }
  }
  const onFile = async (file: File | null) => {
    if (!file) return
    setImportErrors([])
    const { parseWorkbook } = await import('@/features/products/spreadsheet')
    const wb = await parseWorkbook(await file.arrayBuffer())
    const parsed = parseBudgetSheet(wb.rows(wb.sheetNames[0]), fyStartMonth)
    if (parsed.errors.length) { setImportErrors(parsed.errors); return }
    await save(parsed.lines as unknown as Record<string, unknown>[], 'IMPORT', file.name, `${parsed.lines.length} budget line(s) imported from ${file.name}.`)
  }
  const template = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Budget', rows: budgetTemplate(fyStartMonth) }], `budget-template-${x.financial_year}`, 'xlsx')
  }
  const expenseIncome = (accounts.data ?? []).filter((a) => a.classification === 'INCOME' || a.classification === 'EXPENSE')
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div><CardTitle>{x.budget_name} — FY {x.financial_year}, version {x.version} <StatusBadge label={BUDGET_STATUS_META[x.status].label} tone={BUDGET_STATUS_META[x.status].tone} /></CardTitle>
            <CardDescription>{x.lines.length} line(s) · annual total {formatAmount(x.total_annual)}{x.revision_of_version ? ` · revision of version ${x.revision_of_version}` : ''}
              {x.file_name ? ` · imported from ${x.file_name}` : ''}{x.approved_by_name ? ` · approved by ${x.approved_by_name}` : ''}</CardDescription></div>
          <div className="flex flex-wrap gap-2">
            <AccountingExport title={`Budget ${x.financial_year} v${x.version}`} fileStem={`budget-${x.financial_year}-v${x.version}`} rows={x.lines} columns={[
              { header: 'Cost centre code', value: (l) => l.cost_centre_code }, { header: 'Cost centre', value: (l) => l.cost_centre_name }, { header: 'Account code', value: (l) => l.account_code },
              { header: 'Account', value: (l) => l.account_name }, { header: 'Annual', value: (l) => Number(l.annual_amount) },
              ...months.map((m, i) => ({ header: m, value: (l: BudgetLine) => Number(l.months[i]) })), { header: 'Notes', value: (l) => l.notes },
            ]} />
            {canEdit && <>
              <Button variant="outline" onClick={() => void template()}><Download /> Template</Button>
              <Button variant="outline" asChild><label className="cursor-pointer"><Upload /> Import CSV / Excel
                <input type="file" className="sr-only" accept=".csv,.xlsx,.xls" onChange={(e) => { void onFile(e.target.files?.[0] ?? null); e.target.value = '' }} /></label></Button>
            </>}
            {draft && has('accounting_budgets.approve') && <Button disabled={!x.lines.length || busy} onClick={() => onAction({
              title: `Approve version ${x.version}`, description: 'The approved budget is used by the budget versus actual reports. Any earlier approved version of this year becomes superseded.',
              confirmLabel: 'Approve budget', note: 'optional', run: async (n) => { await approveBudget(x.id, n); return `Version ${x.version} approved.` },
            })}>Approve</Button>}
            {(x.status === 'APPROVED' || x.status === 'SUPERSEDED') && has('accounting_budgets.manage') && <Button variant="outline" onClick={() => onAction({
              title: `Revise version ${x.version}`, description: 'Creates a new draft version with the same lines; this version stays unchanged until the revision is approved.',
              confirmLabel: 'Create revision', note: 'required', minLength: 5, run: async (n) => { const r = await reviseBudget(x.id, n!); return `Draft version ${r.version} created.` },
            })}>Revise</Button>}
            {canEdit && <Button variant="outline" className="text-shortage" onClick={() => onAction({
              title: `Cancel draft version ${x.version}`, description: 'The draft is kept as cancelled.', confirmLabel: 'Cancel draft', note: 'required', minLength: 3, destructive: true,
              run: async (n) => { await cancelBudget(x.id, n!); return 'Draft cancelled.' },
            })}>Cancel draft</Button>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          {importErrors.length > 0 && <div role="alert" className="mx-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
            <p className="font-medium">The file was not imported:</p><ul className="list-disc pl-5">{importErrors.slice(0, 20).map((e) => <li key={e}>{e}</li>)}</ul></div>}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Cost centre</TableHead><TableHead>Account</TableHead><TableHead className="text-right">Annual</TableHead>
                {months.map((m) => <TableHead key={m} className="text-right">{m}</TableHead>)}{canEdit && <TableHead />}</TableRow></TableHeader>
              <TableBody>{x.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="whitespace-nowrap"><span className="font-mono text-xs">{l.cost_centre_code}</span> {l.cost_centre_name}</TableCell>
                  <TableCell className="whitespace-nowrap"><span className="font-mono text-xs">{l.account_code}</span> {l.account_name}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatAmount(l.annual_amount)}</TableCell>
                  {l.months.map((m, i) => <TableCell key={i} className="text-right text-xs tabular-nums">{formatAmount(m)}</TableCell>)}
                  {canEdit && <TableCell><Button variant="ghost" size="icon" aria-label="Remove line" disabled={busy}
                    onClick={() => void save(x.lines.filter((y) => y.id !== l.id).map(lineInput), 'MANUAL', null, 'Budget line removed.')}><Trash2 /></Button></TableCell>}
                </TableRow>
              ))}</TableBody>
            </Table>
            {!x.lines.length && <p className="p-4 text-sm text-muted-foreground">No lines yet.{canEdit ? ' Import a file or add lines below.' : ''}</p>}
          </div>
          {canEdit && (
            <div className="flex flex-wrap items-end gap-3 border-t p-4">
              <div className="w-64 space-y-1"><Label htmlFor="bl-cc">Cost centre</Label><CostCentreSelect id="bl-cc" value={cc} onChange={setCc} /></div>
              <div className="w-72 space-y-1"><Label htmlFor="bl-acc">Income / expense account</Label><AccountSelect id="bl-acc" value={account} accounts={expenseIncome} onChange={(v) => setAccount(v)} /></div>
              <div className="space-y-1"><Label htmlFor="bl-annual">Annual budget</Label><Input id="bl-annual" className="w-36 text-right" inputMode="decimal" value={annual} onChange={(e) => setAnnual(e.target.value)} /></div>
              <Button variant="outline" disabled={busy || !cc || !account || !isPositiveAmount(annual)} onClick={() => void save([...x.lines.map(lineInput),
                { cost_centre_id: cc, account_id: account, annual: annual.trim(), months: [] }], 'MANUAL', null, 'Budget line added (spread evenly over the months).').then(() => { setCc(''); setAccount(''); setAnnual('') })}>
                {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add line (spread evenly)</Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Approval history</CardTitle></div></CardHeader>
        <CardContent><ul className="space-y-1 text-sm" data-testid="budget-history">{x.history.map((h, i) => (
          <li key={i}><span className="text-muted-foreground">{formatDateTime(h.at)}</span> · {h.action.toLowerCase().replace('_', ' ')} · {h.by ?? 'System'}{h.note ? ` — ${h.note}` : ''}</li>
        ))}</ul></CardContent>
      </Card>
    </div>
  )
}
