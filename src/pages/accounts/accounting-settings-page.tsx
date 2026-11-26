import { Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  PAYMENT_METHODS, PAYMENT_METHOD_LABELS, RULES, financialYear, type Account, type AccountingStatus, type CostCentre, type PostingRule,
} from '@/features/accounting/accounting-model'
import { AccountingNotice, SearchSelect } from '@/features/accounting/accounting-ui'
import { PaymentAccountPolicies } from '@/features/accounting/bank-cash-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import {
  fetchAccounts, fetchCostCentres, fetchPeriods, fetchPostingRules, generatePeriods, initializeAccounting, saveAccountingSettings, saveCostCentre, savePostingRule,
  setPeriodStatus,
} from '@/services/accounting'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
type Tab = 'books' | 'periods' | 'rules' | 'cost-centres'

export default function AccountingSettingsPage() {
  const status = useAccountingStatus()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'books'
  if (status.loading) return <><PageHeader /><LoadingState /></>
  if (status.error) return <><PageHeader /><ErrorState message={describeDataError(status.error)} onRetry={status.reload} /></>
  const s = status.data!
  return (
    <>
      <PageHeader />
      <AccountingNotice />
      {!s.initialized ? <SetUp status={s} onDone={status.reload} /> : (
        <>
          <FilterTabs label="Settings section" className="mb-4" value={tab} onChange={(v) => setParams({ tab: v }, { replace: true })} options={[
            { value: 'books', label: 'Books' }, { value: 'periods', label: 'Accounting periods' }, { value: 'rules', label: 'Posting rules' }, { value: 'cost-centres', label: 'Cost centres' },
          ]} />
          {tab === 'books' && <Books status={s} onSaved={status.reload} />}
          {tab === 'periods' && <Periods status={s} />}
          {tab === 'rules' && <Rules />}
          {tab === 'cost-centres' && <CostCentres />}
        </>
      )}
    </>
  )
}

function SetUp({ status, onDone }: { status: AccountingStatus; onDone: () => void }) {
  const { has } = usePermissions()
  const [month, setMonth] = useState(String(status.default_fy_start_month))
  const [start, setStart] = useState(financialYear(status.today, status.default_fy_start_month).from)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setError(null)
    try { await initializeAccounting(start, Number(month)); onDone() } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Card className="max-w-2xl">
      <CardHeader><div><CardTitle>Set up accounting</CardTitle>
        <CardDescription>Creates the default chart of accounts (Indian groups, Debtors and Creditors control accounts, output GST, sales, purchases, round off),
          the voucher types, the automatic posting rules and the accounting periods of the first financial year. Currency is INR. No bank account is assumed:
          you add bank / cash accounts and map payment methods afterwards.</CardDescription></div></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="st-start">Books start date</Label><Input id="st-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <p className="text-xs text-muted-foreground">Documents dated before it are covered by the opening balances, not posted.</p></div>
          <div className="space-y-1"><Label htmlFor="st-month">Financial year starts in</Label>
            <Select value={month} onValueChange={setMonth}><SelectTrigger id="st-month"><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}{i === 3 ? ' (April–March)' : ''}</SelectItem>)}</SelectContent></Select></div>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {has('accounting_settings.manage') ? <Button onClick={() => void submit()} disabled={busy || !start}>{busy && <Loader2 className="animate-spin" />} Set up accounting</Button>
          : <p className="text-sm text-muted-foreground">Ask a user with Accounting settings permission to set up accounting.</p>}
      </CardContent>
    </Card>
  )
}

function Books({ status, onSaved }: { status: AccountingStatus; onSaved: () => void }) {
  const { has } = usePermissions()
  const s = status.settings!
  const [start, setStart] = useState(s.books_start_date)
  const [month, setMonth] = useState(String(s.fy_start_month))
  const [future, setFuture] = useState(s.allow_future_dates)
  const [backdate, setBackdate] = useState(s.backdate_limit_days === null ? '' : String(s.backdate_limit_days))
  const [sod, setSod] = useState(s.segregation_of_duties)
  const [attempts, setAttempts] = useState(String(s.auto_posting_max_attempts))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const can = has('accounting_settings.manage')
  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      await saveAccountingSettings({ books_start_date: start, fy_start_month: Number(month), allow_future_dates: future, backdate_limit_days: backdate.trim() === '' ? null : Number(backdate),
        segregation_of_duties: sod, auto_posting_max_attempts: Number(attempts) })
      setMsg({ text: 'Settings saved.', ok: true }); onSaved()
    } catch (e) { setMsg({ text: describeDataError(e), ok: false }) } finally { setBusy(false) }
  }
  return (
    <Card className="max-w-3xl">
      <CardHeader><div><CardTitle>Books</CardTitle><CardDescription>Currency INR · current financial year {status.current_financial_year}</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="bk-start">Books start date</Label>
            <Input id="bk-start" type="date" value={start} disabled={!can || status.has_vouchers} onChange={(e) => setStart(e.target.value)} />
            {status.has_vouchers && <p className="text-xs text-muted-foreground">Fixed once vouchers exist.</p>}</div>
          <div className="space-y-1"><Label htmlFor="bk-month">Financial year starts in</Label>
            <Select value={month} onValueChange={setMonth} disabled={!can || status.has_vouchers}><SelectTrigger id="bk-month"><SelectValue /></SelectTrigger>
              <SelectContent>{MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="bk-back">Back-dating limit for manual vouchers (days)</Label>
            <Input id="bk-back" inputMode="numeric" value={backdate} disabled={!can} placeholder="No limit" onChange={(e) => setBackdate(e.target.value.replace(/\D/g, ''))} /></div>
          <div className="space-y-1"><Label htmlFor="bk-att">Automatic posting retries</Label>
            <Input id="bk-att" inputMode="numeric" value={attempts} disabled={!can} onChange={(e) => setAttempts(e.target.value.replace(/\D/g, ''))} /></div>
        </div>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={future} disabled={!can} onCheckedChange={(v) => setFuture(v === true)} /> Allow future-dated vouchers</label>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={sod} disabled={!can} onCheckedChange={(v) => setSod(v === true)} />
          Segregation of duties (a voucher is posted, and opening balances approved, by someone other than the person who prepared them)</label>
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-green-700' : 'text-red-700'}`}>{msg.text}</p>}
        {can && <Button onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save settings</Button>}
      </CardContent>
    </Card>
  )
}

function Periods({ status }: { status: AccountingStatus }) {
  const { has } = usePermissions()
  const fyNow = financialYear(status.today, status.settings!.fy_start_month)
  const [fy, setFy] = useState(fyNow.label)
  const [refresh, setRefresh] = useState(0)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const all = useAsync(() => fetchPeriods(null), [refresh])
  const years = [...new Set((all.data ?? []).map((p) => p.financial_year))]
  const rows = (all.data ?? []).filter((p) => p.financial_year === fy)
  const can = has('accounting_period.close')
  const nextYearStart = (() => { const last = (all.data ?? []).at(-1); if (!last) return fyNow.from; const d = new Date(`${last.end_date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) })()
  const done = (m: string) => { setAction(null); setMessage(m); setRefresh((n) => n + 1) }
  return (
    <Card>
      <CardHeader><div><CardTitle>Accounting periods</CardTitle><CardDescription>Posting is allowed only in open or reopened periods. Closing a period blocks every new voucher dated in it.</CardDescription></div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={fy} onValueChange={setFy}><SelectTrigger className="w-36" aria-label="Financial year"><SelectValue /></SelectTrigger>
            <SelectContent>{(years.length ? years : [fy]).map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent></Select>
          {can && <Button variant="outline" onClick={() => setAction({
            title: 'Create the next financial year\'s periods', description: `Creates 12 monthly periods starting ${formatDate(nextYearStart)}.`, confirmLabel: 'Create periods', note: 'none',
            run: async () => { const r = await generatePeriods(nextYearStart); setFy(r.financial_year); return `${r.periods_created} period(s) created for FY ${r.financial_year}.` },
          })}><Plus /> Next financial year</Button>}
        </div></CardHeader>
      <CardContent className="p-0">
        {message && <p role="status" className="mx-4 mb-2 text-sm text-green-700">{message}</p>}
        {all.loading ? <LoadingState variant="table" /> : all.error ? <ErrorState message={describeDataError(all.error)} onRetry={all.reload} /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Period</TableHead><TableHead>Dates</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Posted</TableHead>
              <TableHead className="text-right">Drafts</TableHead><TableHead>Note</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>{rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.period_name}</TableCell><TableCell className="text-sm">{formatDate(p.start_date)} – {formatDate(p.end_date)}</TableCell>
                <TableCell><StatusBadge label={p.status === 'OPEN' ? 'Open' : p.status === 'CLOSED' ? 'Closed' : 'Reopened'} tone={p.status === 'CLOSED' ? 'neutral' : p.status === 'REOPENED' ? 'warning' : 'success'} /></TableCell>
                <TableCell className="text-right">{p.posted_vouchers}</TableCell><TableCell className="text-right">{p.draft_vouchers}</TableCell>
                <TableCell className="max-w-xs text-sm text-muted-foreground">{p.status_reason ?? ''}</TableCell>
                <TableCell className="text-right">{can && (p.status === 'CLOSED'
                  ? <Button variant="ghost" size="sm" onClick={() => setAction({ title: `Reopen ${p.period_name}`, description: 'Vouchers can be posted into the period again. The reason is kept in the audit log.',
                      confirmLabel: 'Reopen period', note: 'required', minLength: 5, run: async (n) => { await setPeriodStatus(p.id, 'REOPENED', n); return `${p.period_name} reopened.` } })}>Reopen</Button>
                  : <Button variant="ghost" size="sm" onClick={() => setAction({ title: `Close ${p.period_name}`,
                      description: <>No voucher dated {formatDate(p.start_date)} – {formatDate(p.end_date)} can be posted after closing{p.draft_vouchers ? ` (${p.draft_vouchers} draft voucher(s) are dated in it)` : ''}.</>,
                      confirmLabel: 'Close period', note: 'optional', run: async (n) => { await setPeriodStatus(p.id, 'CLOSED', n); return `${p.period_name} closed.` } })}>Close</Button>)}</TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        )}
      </CardContent>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </Card>
  )
}

function Rules() {
  const { has } = usePermissions()
  const can = has('accounting_settings.manage')
  const [refresh, setRefresh] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const rules = useAsync(() => fetchPostingRules(), [refresh])
  const accounts = useAsync(() => fetchAccounts(null, false), [])
  const find = (key: string, match = '') => (rules.data ?? []).find((r) => r.rule_key === key && r.match_value === match) ?? null
  const save = async (key: string, match: string, accountId: string | null) => {
    setSaving(`${key}:${match}`); setError(null)
    try { await savePostingRule(key, match, accountId); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) } finally { setSaving(null) }
  }
  const cashBank = (accounts.data ?? []).filter((a: Account) => ['CASH', 'BANK'].includes(a.account_nature) && a.is_active && a.is_postable)
  const ruleAccounts = (nature?: string) => (accounts.data ?? []).filter((a) => a.is_active && a.is_postable && (nature ? a.account_nature === nature : !['RECEIVABLE_CONTROL', 'PAYABLE_CONTROL'].includes(a.account_nature)))
  const picker = (key: string, match: string, list: Account[], current: PostingRule | null, clear: boolean) => (
    <div className="flex items-center gap-2">
      <div className="w-80">{can ? <SearchSelect value={current?.account_id ?? ''} allowClear={clear} placeholder={clear ? 'Not mapped — never guessed' : 'Select an account'}
        options={list.map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}`, hint: a.group_name }))}
        onChange={(v) => void save(key, match, v || null)} /> : <span className="text-sm">{current ? `${current.account_code} — ${current.account_name}` : 'Not mapped'}</span>}</div>
      {saving === `${key}:${match}` && <Loader2 className="size-4 animate-spin" />}
      {current && !current.account_active && <StatusBadge label="Account inactive" tone="danger" />}
    </div>
  )
  if (rules.loading || accounts.loading) return <LoadingState variant="table" />
  if (rules.error) return <ErrorState message={describeDataError(rules.error)} onRetry={rules.reload} />
  return (
    <div className="space-y-4">
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card>
        <CardHeader><div><CardTitle>Automatic posting accounts</CardTitle><CardDescription>The account each part of an ERP document is posted to.</CardDescription></div></CardHeader>
        <CardContent className="p-0"><Table>
          <TableHeader><TableRow><TableHead>Rule</TableHead><TableHead>Used for</TableHead><TableHead>Account</TableHead></TableRow></TableHeader>
          <TableBody>{RULES.map((r) => (
            <TableRow key={r.key}><TableCell className="font-medium">{r.label}</TableCell><TableCell className="text-sm text-muted-foreground">{r.use}</TableCell>
              <TableCell>{picker(r.key, '', ruleAccounts(r.nature), find(r.key), false)}</TableCell></TableRow>
          ))}</TableBody>
        </Table></CardContent>
      </Card>
      <Card>
        <CardHeader><div><CardTitle>Cash and bank accounts by payment method</CardTitle>
          <CardDescription>Receipts and supplier payments are posted only when their payment method is mapped to a cash or bank account. Unmapped ones wait in the
            Posting Monitor (Needs account mapping). Add bank accounts under Ledger Accounts (nature Bank) first.</CardDescription></div></CardHeader>
        <CardContent className="p-0"><Table>
          <TableHeader><TableRow><TableHead>Payment method</TableHead><TableHead>Customer receipts</TableHead><TableHead>Supplier payments</TableHead></TableRow></TableHeader>
          <TableBody>{PAYMENT_METHODS.map((m) => (
            <TableRow key={m}><TableCell className="font-medium">{PAYMENT_METHOD_LABELS[m]}</TableCell>
              <TableCell>{picker('RECEIPT_ACCOUNT', m, cashBank, find('RECEIPT_ACCOUNT', m), true)}</TableCell>
              <TableCell>{picker('SUPPLIER_PAYMENT_ACCOUNT', m, cashBank, find('SUPPLIER_PAYMENT_ACCOUNT', m), true)}</TableCell></TableRow>
          ))}</TableBody>
        </Table></CardContent>
      </Card>
      <PaymentAccountPolicies />
    </div>
  )
}

function CostCentres() {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const [edit, setEdit] = useState<CostCentre | 'new' | null>(null)
  const list = useAsync(() => fetchCostCentres(), [refresh])
  const byId = new Map((list.data ?? []).map((c) => [c.id, c]))
  return (
    <Card>
      <CardHeader><div><CardTitle>Cost centres</CardTitle><CardDescription>Master list only. Allocating vouchers to cost centres and budgets come in a later phase.</CardDescription></div>
        {has('accounts.manage') && <Button onClick={() => setEdit('new')}><Plus /> New cost centre</Button>}</CardHeader>
      <CardContent className="p-0">
        {list.loading ? <LoadingState variant="table" /> : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} /> : !(list.data ?? []).length
          ? <p className="p-4 text-sm text-muted-foreground">No cost centres yet.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Name</TableHead><TableHead>Parent</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{(list.data ?? []).map((c) => (
                <TableRow key={c.id}><TableCell className="font-mono text-xs">{c.cost_centre_code}</TableCell><TableCell>{c.cost_centre_name}
                  {c.description && <span className="block text-xs text-muted-foreground">{c.description}</span>}</TableCell>
                  <TableCell>{c.parent_cost_centre_id ? byId.get(c.parent_cost_centre_id)?.cost_centre_name ?? '' : '—'}</TableCell>
                  <TableCell><StatusBadge label={c.is_active ? 'Active' : 'Inactive'} tone={c.is_active ? 'success' : 'neutral'} /></TableCell>
                  <TableCell className="text-right">{has('accounts.manage') && <Button variant="ghost" size="sm" onClick={() => setEdit(c)}>Edit</Button>}</TableCell></TableRow>
              ))}</TableBody>
            </Table>
          )}
      </CardContent>
      {edit && <CostCentreDialog centre={edit === 'new' ? null : edit} all={list.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setRefresh((n) => n + 1) }} />}
    </Card>
  )
}

function CostCentreDialog({ centre, all, onClose, onSaved }: { centre: CostCentre | null; all: CostCentre[]; onClose: () => void; onSaved: () => void }) {
  const [code, setCode] = useState(centre?.cost_centre_code ?? '')
  const [name, setName] = useState(centre?.cost_centre_name ?? '')
  const [parent, setParent] = useState(centre?.parent_cost_centre_id ?? '')
  const [description, setDescription] = useState(centre?.description ?? '')
  const [active, setActive] = useState(centre?.is_active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true); setError(null)
    try {
      await saveCostCentre(centre?.id ?? null, { cost_centre_code: code.trim().toUpperCase(), cost_centre_name: name.trim(), parent_cost_centre_id: parent || null,
        description: description.trim() || null, is_active: active })
      onSaved()
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{centre ? `Edit ${centre.cost_centre_code}` : 'New cost centre'}</DialogTitle>
          <DialogDescription>A cost centre cannot be placed under itself or one of its sub-centres.</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="cc-code">Code</Label><Input id="cc-code" value={code} disabled={Boolean(centre)} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} /></div>
          <div className="space-y-1"><Label htmlFor="cc-name">Name</Label><Input id="cc-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="cc-parent">Parent</Label>
            <SearchSelect id="cc-parent" value={parent} allowClear onChange={setParent} placeholder="None (top level)"
              options={all.filter((c) => c.id !== centre?.id).map((c) => ({ value: c.id, label: c.cost_centre_name, hint: c.cost_centre_code }))} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="cc-desc">Description</Label><Textarea id="cc-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <label className="flex items-center gap-2 text-sm"><Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} /> Active</label>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || name.trim().length < 2 || (!centre && !code.trim())}>{busy && <Loader2 className="animate-spin" />} Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

