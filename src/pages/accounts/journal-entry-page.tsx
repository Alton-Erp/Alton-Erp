import { CheckCircle2, Loader2, Plus, Save, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  emptyJournal, formatAmount, isBlankJournalLine, journalFromVoucher, journalPayload, lineTotals, newJournalLine, validateJournal,
  type Account, type JournalForm, type ValidationIssue, type Voucher,
} from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingNotice, SetupGate } from '@/features/accounting/accounting-ui'
import { AllocationDialog } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { createVoucher, discardVoucher, fetchAccounts, fetchCostCentres, fetchVoucher, postVoucher, updateVoucher, validateVoucher } from '@/services/accounting'

const crumbs = (label: string) => [{ label: 'Accounts' }, { label: 'Journal Register', to: '/accounts/journals' }, { label }]

/** /accounts/journals/new and /accounts/journals/:voucherId/edit */
export default function JournalEntryPage() {
  const status = useAccountingStatus()
  const { voucherId } = useParams()
  return <SetupGate status={status}>{(s) => (voucherId ? <EditLoader voucherId={voucherId} /> : <JournalEditor key="new" today={s.today} voucher={null} />)}</SetupGate>
}

function EditLoader({ voucherId }: { voucherId: string }) {
  const v = useAsync(() => fetchVoucher(voucherId), [voucherId])
  if (v.loading) return <><PageHeader title="Journal voucher" breadcrumbs={crumbs('Edit')} /><LoadingState /></>
  if (v.error) return <><PageHeader title="Journal voucher" breadcrumbs={crumbs('Edit')} /><ErrorState message={describeDataError(v.error)} onRetry={v.reload} /></>
  const x = v.data!
  if (x.status !== 'DRAFT' || x.source !== 'MANUAL' || x.voucher_type !== 'JV') {
    return (
      <>
        <PageHeader title={x.voucher_number ?? 'Journal voucher'} breadcrumbs={crumbs(x.voucher_number ?? 'Voucher')} />
        <ErrorState title="This voucher cannot be edited" message={`Only draft manual journal vouchers can be edited (this one is ${x.status.toLowerCase()}). Posted vouchers are corrected by reversal.`} />
        <Button asChild variant="outline" className="mt-3"><Link to={`/accounts/vouchers/${x.id}`}>Open the voucher</Link></Button>
      </>
    )
  }
  return <JournalEditor key={x.id} today={x.voucher_date} voucher={x} />
}

function JournalEditor({ today, voucher }: { today: string; voucher: Voucher | null }) {
  const { has } = usePermissions()
  const navigate = useNavigate()
  const accounts = useAsync(() => fetchAccounts(null, false), [])
  const [saved, setSaved] = useState<Voucher | null>(voucher)
  const [form, setForm] = useState<JournalForm>(() => (voucher ? journalFromVoucher(voucher) : emptyJournal(today)))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[] | null>(voucher?.issues ?? null)
  const [shown, setShown] = useState(false)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [splitting, setSplitting] = useState<string | null>(null)
  const centres = useAsync(() => fetchCostCentres(), [])

  const used = form.lines.filter((l) => !isBlankJournalLine(l))
  const totals = lineTotals(used.map((l) => ({ debit: l.debit.trim() || 0, credit: l.credit.trim() || 0 })))
  const check = validateJournal(form, false)
  const postCheck = validateJournal(form, true)
  const manualAccounts = (accounts.data ?? []).filter((a: Account) => a.allow_manual_posting)
  const policyOf = (accountId: string) => manualAccounts.find((a) => a.id === accountId)?.cost_centre_policy

  const change = (patch: Partial<JournalForm>) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); setNotice(null); setIssues(null) }
  const changeLine = (key: string, patch: Partial<JournalForm['lines'][number]>) =>
    change({ lines: form.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) })

  /** Saves the draft (create or update) and returns it. */
  const save = async (): Promise<Voucher | null> => {
    setShown(true)
    if (check.errors.length || Object.keys(check.lineErrors).length) { setError('Correct the highlighted lines first.'); return null }
    setError(null)
    const payload = journalPayload(form)
    const v = saved ? await updateVoucher(saved.id, payload, saved.row_version) : await createVoucher(payload)
    // The editor stays mounted after the first save (the draft is reopened from the register via its edit link).
    setSaved(v); setDirty(false); setIssues(v.issues ?? null)
    return v
  }
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setError(null); setNotice(null)
    try { await fn() } catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  const saveDraft = () => run('save', async () => { const v = await save(); if (v) setNotice('Draft saved. It does not affect any report until it is posted.') })
  const validate = () => run('validate', async () => {
    const v = dirty || !saved ? await save() : saved
    if (!v) return
    const r = await validateVoucher(v.id)
    setIssues(r.issues)
    setNotice(r.valid ? 'The journal is valid and can be posted.' : null)
  })
  const askPost = () => run('post-check', async () => {
    setShown(true)
    if (postCheck.errors.length || Object.keys(postCheck.lineErrors).length) { setError(postCheck.errors[0] ?? 'Correct the highlighted lines first.'); return }
    const v = dirty || !saved ? await save() : saved
    if (!v) return
    const r = await validateVoucher(v.id)
    setIssues(r.issues)
    if (!r.valid) { setError('The journal cannot be posted yet — see the issues below.'); return }
    setAction({
      title: 'Post this journal voucher',
      description: <>Posting assigns the voucher number and puts {formatAmount(r.total_debit)} into the books dated {formatDate(v.voucher_date)}. A posted journal can never
        be edited or deleted — only reversed by a linked reversal voucher.</>,
      confirmLabel: 'Post journal', note: 'none',
      run: async () => {
        const p = await postVoucher(v.id, v.row_version)
        navigate(`/accounts/vouchers/${p.id}`, { replace: true })
        return `Journal ${p.voucher_number} posted.`
      },
    })
  })
  const askDiscard = () => {
    if (!saved) { setForm(emptyJournal(today)); setDirty(false); setShown(false); setIssues(null); return }
    setAction({
      title: 'Discard this draft', description: 'The draft stays in the register as discarded and never reaches the books. This cannot be undone.',
      confirmLabel: 'Discard draft', note: 'required', minLength: 3, destructive: true,
      run: async (n) => { await discardVoucher(saved.id, n!); navigate('/accounts/journals', { replace: true }); return 'Draft discarded.' },
    })
  }

  return (
    <>
      <PageHeader title={saved ? 'Edit draft journal voucher' : 'New journal voucher'} breadcrumbs={crumbs(saved ? 'Edit draft' : 'New journal')}
        description="Multiple debit and credit lines. Debtors / Creditors control accounts are posted automatically only and are not offered here." />
      <AccountingNotice>Drafts never reach the trial balance, general ledger or day book; only posted journals do.</AccountingNotice>
      <Card className="mb-4">
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1"><Label htmlFor="jv-date">Voucher date</Label>
            <Input id="jv-date" type="date" value={form.voucher_date} onChange={(e) => change({ voucher_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="jv-number">Voucher number</Label>
            <Input id="jv-number" value={saved?.voucher_number ?? 'Assigned automatically on posting'} disabled readOnly /></div>
          <div className="space-y-1"><Label htmlFor="jv-ref">Reference number</Label>
            <Input id="jv-ref" value={form.reference_number} maxLength={100} onChange={(e) => change({ reference_number: e.target.value })} placeholder="e.g. bill or memo number" /></div>
          <div className="space-y-1"><Label>Status</Label>
            <div className="flex h-9 items-center gap-2">{saved ? <StatusBadge label="Draft (saved)" tone="warning" /> : <StatusBadge label="Not saved" />}
              {dirty && saved && <span className="text-xs text-amber-700">unsaved changes</span>}</div></div>
          <div className="space-y-1 sm:col-span-2 xl:col-span-4"><Label htmlFor="jv-narr">Narration</Label>
            <Textarea id="jv-narr" rows={2} maxLength={1000} value={form.narration} onChange={(e) => change({ narration: e.target.value })} /></div>
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><div><CardTitle>Lines</CardTitle><CardDescription>Each line is a debit or a credit to one ledger account. Search accounts by code, name or group.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow><TableHead className="w-10">#</TableHead><TableHead className="min-w-72">Ledger account</TableHead>
              <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead>Cost centres</TableHead><TableHead>Line narration (optional)</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {form.lines.map((l, i) => {
                const err = shown ? check.lineErrors[l.key] ?? postCheck.lineErrors[l.key] : undefined
                const serverIssues = (issues ?? []).filter((x) => x.line_no && used.indexOf(l) + 1 === x.line_no)
                return (
                  <TableRow key={l.key} data-testid="journal-line">
                    <TableCell className="align-top text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="align-top">
                      <AccountSelect id={`jv-acc-${i}`} value={l.account_id} accounts={manualAccounts} manualOnly onChange={(v) => changeLine(l.key, { account_id: v })} />
                      {err && <p className="mt-1 text-xs text-red-700">{err}</p>}
                      {serverIssues.map((x) => <p key={x.code} className="mt-1 text-xs text-red-700">{x.message}</p>)}
                    </TableCell>
                    <TableCell className="align-top"><Input className="w-36 text-right tabular-nums" inputMode="decimal" aria-label={`Line ${i + 1} debit`} value={l.debit}
                      onChange={(e) => changeLine(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></TableCell>
                    <TableCell className="align-top"><Input className="w-36 text-right tabular-nums" inputMode="decimal" aria-label={`Line ${i + 1} credit`} value={l.credit}
                      onChange={(e) => changeLine(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></TableCell>
                    <TableCell className="align-top">{(() => {
                      const policy = policyOf(l.account_id)
                      const n = l.allocations.filter((a) => a.cost_centre_id).length
                      if (!l.account_id || policy === 'NOT_APPLICABLE') return <span className="text-xs text-muted-foreground">{l.account_id ? 'Not applicable' : '—'}</span>
                      return <Button variant="outline" size="sm" data-testid={`jv-split-${i}`} className={policy === 'REQUIRED' && !n ? 'border-amber-400 text-amber-800' : ''}
                        onClick={() => setSplitting(l.key)}>{n ? `${n} cost centre${n > 1 ? 's' : ''}` : policy === 'REQUIRED' ? 'Required — allocate' : 'Allocate'}</Button>
                    })()}</TableCell>
                    <TableCell className="align-top"><Input aria-label={`Line ${i + 1} narration`} value={l.narration} maxLength={500} onChange={(e) => changeLine(l.key, { narration: e.target.value })} /></TableCell>
                    <TableCell className="align-top"><Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={form.lines.length <= 1}
                      onClick={() => change({ lines: form.lines.filter((x) => x.key !== l.key) })}><Trash2 /></Button></TableCell>
                  </TableRow>
                )
              })}
              <TableRow className="border-t-2 font-semibold" data-testid="journal-totals">
                <TableCell /><TableCell>Total {totals.balanced
                  ? <span className="ml-2 inline-flex items-center gap-1 text-green-700"><CheckCircle2 className="size-4" /> Balanced</span>
                  : <span className="ml-2 inline-flex items-center gap-1 text-red-700"><XCircle className="size-4" /> Unbalanced</span>}
                  <span className="ml-3 font-normal text-muted-foreground">Difference {formatAmount(Math.abs(totals.difference))}</span></TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(totals.debit)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(totals.credit)}</TableCell>
                <TableCell colSpan={3} />
              </TableRow>
            </TableBody>
          </Table>
          <div className="p-4"><Button variant="outline" onClick={() => change({ lines: [...form.lines, newJournalLine()] })} disabled={form.lines.length >= 500}><Plus /> Add line</Button></div>
        </CardContent>
      </Card>

      {shown && check.errors.length > 0 && <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{check.errors.join(' ')}</div>}
      {issues && issues.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900" data-testid="journal-issues">
          <p className="font-medium">Not postable yet:</p><ul className="list-disc pl-5">{issues.map((x, k) => <li key={k}>{x.message}</li>)}</ul></div>
      )}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {notice && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{notice}</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void saveDraft()} disabled={Boolean(busy) || accounts.loading || (!dirty && Boolean(saved))}>
          {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} Save draft</Button>
        <Button variant="outline" onClick={() => void validate()} disabled={Boolean(busy) || accounts.loading || used.length === 0}>
          {busy === 'validate' ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Validate</Button>
        {has('vouchers.post') && <Button onClick={() => void askPost()} disabled={Boolean(busy) || accounts.loading || !totals.balanced}>
          {busy === 'post-check' && <Loader2 className="animate-spin" />} Post</Button>}
        <Button variant="outline" className="text-shortage" onClick={askDiscard} disabled={Boolean(busy)}>{saved ? 'Discard draft' : 'Clear'}</Button>
        {saved && <Button variant="ghost" asChild><Link to={`/accounts/vouchers/${saved.id}`}>Open details</Link></Button>}
      </div>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); setNotice(m) }} />
      {splitting && (() => {
        const idx = form.lines.findIndex((x) => x.key === splitting)
        const line = form.lines[idx]
        return line ? <AllocationDialog line={line} lineNo={idx + 1} policy={policyOf(line.account_id)} centres={centres.data ?? []} onClose={() => setSplitting(null)}
          onSave={(allocations) => { changeLine(line.key, { allocations }); setSplitting(null) }} /> : null
      })()}
    </>
  )
}
