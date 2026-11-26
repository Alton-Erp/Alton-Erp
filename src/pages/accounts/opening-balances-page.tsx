import { CheckCircle2, Download, FileSpreadsheet, Loader2, Plus, Trash2, Upload, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

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
import { Textarea } from '@/components/ui/textarea'
import {
  OPENING_CATEGORIES, OPENING_CATEGORY_LABELS, OPENING_TEMPLATE, formatAmount, isPositiveAmount, lineTotals, parseOpeningSheet,
  type Account, type OpeningBatch, type OpeningCategory, type OpeningCheck,
} from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingNotice, PartySelect, SetupGate } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  approveOpeningBatch, createOpeningBatch, discardOpeningBatch, fetchAccounts, fetchOpeningBatch, fetchOpeningBatches, postOpeningBatch, prefillOpeningParties,
  reopenOpeningBatch, replaceOpeningLines,
} from '@/services/accounting'

interface EditLine { key: string; account_id: string; party_id: string; balance_category: OpeningCategory; debit: string; credit: string; description: string }
let seq = 0
const newLine = (): EditLine => ({ key: `n${++seq}`, account_id: '', party_id: '', balance_category: 'LEDGER', debit: '', credit: '', description: '' })

export default function OpeningBalancesPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <Opening booksStart={s.settings!.books_start_date} />}</SetupGate>
}

function Opening({ booksStart }: { booksStart: string }) {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const batches = useAsync(() => fetchOpeningBatches(), [refresh])
  const current = (batches.data ?? []).find((b) => b.status === 'DRAFT' || b.status === 'APPROVED') ?? (batches.data ?? []).find((b) => b.status === 'POSTED') ?? null
  const create = async () => {
    setError(null)
    try { await createOpeningBatch(null); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) }
  }
  return (
    <>
      <PageHeader actions={has('accounting_opening.import') && !current ? <Button onClick={() => void create()}><Plus /> New opening balance batch</Button> : undefined} />
      <AccountingNotice>Opening balances are posted once, as one opening voucher dated the books start date ({formatDate(booksStart)}). ERP party opening balances
        and opening stock are compared with the batch, never added to it automatically and never changed.</AccountingNotice>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {batches.loading ? <LoadingState /> : batches.error ? <ErrorState message={describeDataError(batches.error)} onRetry={batches.reload} />
        : !current ? <EmptyState icon={FileSpreadsheet} title="No opening balances yet" description="Create a batch, enter or import the ledger and party balances as at the books start date, reconcile, approve and post." />
          : <BatchEditor key={`${current.id}-${refresh}`} batchId={current.id} onChanged={(m) => { setMessage(m); setRefresh((n) => n + 1) }} />}
      {(batches.data ?? []).filter((b) => b.id !== current?.id).length > 0 && (
        <Card className="mt-4"><CardHeader><div><CardTitle>Earlier batches</CardTitle></div></CardHeader>
          <CardContent><ul className="text-sm">{(batches.data ?? []).filter((b) => b.id !== current?.id).map((b) => (
            <li key={b.id}>{b.batch_number} · {b.status.toLowerCase()} · {b.line_count} line(s) · created {formatDateTime(b.created_at)}</li>))}</ul></CardContent></Card>
      )}
    </>
  )
}

/** Loads the batch and the accounts, then shows the form (whose line editor starts from the saved lines). */
function BatchEditor({ batchId, onChanged }: { batchId: string; onChanged: (message: string) => void }) {
  const batch = useAsync(() => fetchOpeningBatch(batchId), [batchId])
  const accounts = useAsync(() => fetchAccounts(null, false), [])
  if (batch.loading || accounts.loading) return <LoadingState variant="table" />
  if (batch.error || accounts.error) return <ErrorState message={describeDataError(batch.error ?? accounts.error)} onRetry={() => { batch.reload(); accounts.reload() }} />
  return <BatchForm b={batch.data!} accounts={accounts.data ?? []} onChanged={onChanged} />
}

function BatchForm({ b, accounts, onChanged }: { b: OpeningBatch; accounts: Account[]; onChanged: (message: string) => void }) {
  const { has } = usePermissions()
  const batchId = b.id
  const [lines, setLines] = useState<EditLine[]>(() => b.lines.map((l) => ({ key: l.id, account_id: l.account_id, party_id: l.party_id ?? '',
    balance_category: l.balance_category, debit: Number(l.debit) ? String(l.debit) : '', credit: Number(l.credit) ? String(l.credit) : '', description: l.description ?? '' })))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [acks, setAcks] = useState<Record<string, string>>({})
  const [action, setAction] = useState<ActionRequest | null>(null)
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts])
  const totals = lineTotals(lines.map((l) => ({ debit: l.debit || 0, credit: l.credit || 0 })))
  const draft = b.status === 'DRAFT'
  const canEdit = draft && has('accounting_opening.import')
  const canApprove = has('accounting_opening.approve')

  const run = async (label: string, fn: () => Promise<OpeningBatch | unknown>, ok: string) => {
    setBusy(label); setError(null)
    try { await fn(); onChanged(ok) } catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  const lineErrors = lines.map((l) => {
    const a = accountById.get(l.account_id)
    if (!l.account_id) return 'Select an account'
    if ((l.debit.trim() !== '') === (l.credit.trim() !== '')) return 'Enter a debit or a credit'
    const v = l.debit.trim() || l.credit.trim()
    if (!isPositiveAmount(v)) return 'Amount: digits, up to 2 decimals'
    if (a?.requires_party && !l.party_id) return 'Select the customer / supplier'
    return null
  })
  const saveLines = () => run('save', () => replaceOpeningLines(batchId, lines.map((l) => ({ account_id: l.account_id, party_id: l.party_id || null,
    balance_category: l.balance_category, debit: l.debit.trim() || null, credit: l.credit.trim() || null, description: l.description.trim() || null })), 'MANUAL', null), 'Opening balance lines saved.')
  const onFile = async (file: File | null) => {
    if (!file) return
    setImportErrors([]); setError(null)
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await file.arrayBuffer())
      const parsed = parseOpeningSheet(wb.rows(wb.sheetNames[0]))
      if (parsed.errors.length) { setImportErrors(parsed.errors); return }
      await run('import', () => replaceOpeningLines(batchId, parsed.lines, 'IMPORT', file.name), `${parsed.lines.length} line(s) imported from ${file.name}.`)
    } catch (e) { setError(describeDataError(e)) }
  }
  const template = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    const rows = [...OPENING_TEMPLATE, [], ['Accounts (code — name)'], ...accounts.map((a: Account) => [a.account_code, a.account_name, a.requires_party ? 'needs a party code' : ''])]
    await downloadSheets([{ name: 'Opening balances', rows }], 'opening-balances-template', 'xlsx')
  }
  const set = (key: string, patch: Partial<EditLine>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); setDirty(true) }

  const failed = (b.checks ?? []).filter((c) => c.status === 'FAIL')
  const blocking = failed.filter((c) => !c.acknowledgeable)
  const needAck = failed.filter((c) => c.acknowledgeable)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div><CardTitle>{b.batch_number} <StatusBadge label={b.status === 'DRAFT' ? 'Draft' : b.status === 'APPROVED' ? 'Approved' : b.status === 'POSTED' ? 'Posted' : 'Discarded'}
            tone={b.status === 'POSTED' ? 'success' : b.status === 'APPROVED' ? 'info' : 'warning'} /></CardTitle>
            <CardDescription>As at {formatDate(b.as_of_date)} · {b.source === 'IMPORT' ? `imported from ${b.file_name}` : 'entered manually'} · created by {b.created_by_name ?? '—'}
              {b.approved_by_name ? ` · approved by ${b.approved_by_name}` : ''}{b.voucher_number ? ` · posted as ` : ''}
              {b.voucher_number && <Link className="text-primary hover:underline" to={`/accounts/vouchers?type=OPN&status=POSTED`}>{b.voucher_number}</Link>}</CardDescription></div>
          {canEdit && <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void template()}><Download /> Template</Button>
            <Button variant="outline" asChild><label className="cursor-pointer"><Upload /> Import CSV / Excel
              <input type="file" className="sr-only" accept=".csv,.xlsx,.xls" onChange={(e) => { void onFile(e.target.files?.[0] ?? null); e.target.value = '' }} /></label></Button>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run('prefill', async () => { const r = await prefillOpeningParties(batchId); return r }, 'ERP party opening balances added (parties already in the batch were skipped).')}>
              Add ERP party balances</Button>
          </div>}
        </CardHeader>
        <CardContent className="space-y-3 p-0">
          {importErrors.length > 0 && <div role="alert" className="mx-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
            <p className="font-medium">The file was not imported:</p><ul className="list-disc pl-5">{importErrors.slice(0, 20).map((e) => <li key={e}>{e}</li>)}</ul></div>}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead className="w-80">Ledger account</TableHead><TableHead className="w-64">Customer / supplier</TableHead><TableHead>Category</TableHead>
                <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead>Description</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {lines.map((l, i) => {
                  const a = accountById.get(l.account_id)
                  return canEdit ? (
                    <TableRow key={l.key}>
                      <TableCell><AccountSelect value={l.account_id} accounts={accounts} onChange={(v, acc) => set(l.key, { account_id: v, party_id: acc?.requires_party ? l.party_id : '',
                        balance_category: acc?.requires_party ? 'PARTY' : acc?.account_nature === 'BANK' || acc?.account_nature === 'CASH' ? 'CASH_BANK' : acc?.account_nature === 'INVENTORY' ? 'INVENTORY'
                          : acc?.account_nature === 'CAPITAL' ? 'CAPITAL' : acc?.account_nature === 'LOAN' ? 'LOAN' : acc?.account_nature === 'FIXED_ASSET' ? 'FIXED_ASSET' : l.balance_category })} />
                        {lineErrors[i] && <span className="text-xs text-red-700">{lineErrors[i]}</span>}</TableCell>
                      <TableCell>{a?.requires_party ? <PartySelect value={l.party_id} type={a.account_nature === 'PAYABLE_CONTROL' ? 'SUPPLIER' : 'CUSTOMER'} onChange={(v) => set(l.key, { party_id: v })} />
                        : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                      <TableCell><Select value={l.balance_category} onValueChange={(v) => set(l.key, { balance_category: v as OpeningCategory })}>
                        <SelectTrigger className="w-36" aria-label="Category"><SelectValue /></SelectTrigger>
                        <SelectContent>{OPENING_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{OPENING_CATEGORY_LABELS[c]}</SelectItem>)}</SelectContent></Select></TableCell>
                      <TableCell><Input className="w-32 text-right" inputMode="decimal" aria-label="Debit" value={l.debit} onChange={(e) => set(l.key, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></TableCell>
                      <TableCell><Input className="w-32 text-right" inputMode="decimal" aria-label="Credit" value={l.credit} onChange={(e) => set(l.key, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></TableCell>
                      <TableCell><Input aria-label="Description" value={l.description} maxLength={300} onChange={(e) => set(l.key, { description: e.target.value })} /></TableCell>
                      <TableCell><Button variant="ghost" size="icon" aria-label="Remove line" onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); setDirty(true) }}><Trash2 /></Button></TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={l.key}><TableCell>{a ? `${a.account_code} — ${a.account_name}` : b.lines[i]?.account_name}</TableCell><TableCell>{b.lines[i]?.party_name ?? '—'}</TableCell>
                      <TableCell>{OPENING_CATEGORY_LABELS[l.balance_category]}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(l.debit, true)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(l.credit, true)}</TableCell><TableCell className="text-sm">{l.description}</TableCell><TableCell /></TableRow>
                  )
                })}
                <TableRow className="border-t-2 font-semibold"><TableCell colSpan={3}>Total {totals.balanced ? '(balanced)' : `(difference ${formatAmount(Math.abs(totals.difference))})`}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(totals.debit)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(totals.credit)}</TableCell><TableCell colSpan={2} /></TableRow>
              </TableBody>
            </Table>
          </div>
          {canEdit && <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
            <Button variant="outline" onClick={() => { setLines((ls) => [...ls, newLine()]); setDirty(true) }}><Plus /> Add line</Button>
            <Button disabled={!dirty || Boolean(busy) || lineErrors.some(Boolean)} onClick={() => void saveLines()}>{busy === 'save' && <Loader2 className="animate-spin" />} Save lines</Button>
            {dirty && <span className="text-sm text-amber-700">Unsaved changes — the checks below are for the saved lines.</span>}
          </div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div><CardTitle>Reconciliation</CardTitle><CardDescription>Checked again by the database when approving and posting.</CardDescription></div></CardHeader>
        <CardContent className="space-y-2">
          {(b.checks ?? []).map((c) => <CheckRow key={c.code} check={c} ack={acks[c.code] ?? ''} editable={draft && canApprove && c.status === 'FAIL' && c.acknowledgeable}
            onAck={(v) => setAcks((s) => ({ ...s, [c.code]: v }))} acknowledged={b.acknowledgements.find((a) => a.code === c.code)?.reason} />)}
        </CardContent>
      </Card>

      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {draft && canApprove && <Button disabled={dirty || Boolean(busy) || blocking.length > 0 || needAck.some((c) => (acks[c.code] ?? '').trim().length < 10)}
          onClick={() => void run('approve', () => approveOpeningBatch(batchId, needAck.map((c) => ({ code: c.code, reason: acks[c.code].trim() }))), 'Opening balances approved.')}>
          {busy === 'approve' && <Loader2 className="animate-spin" />} Approve</Button>}
        {b.status === 'APPROVED' && canApprove && <Button onClick={() => setAction({
          title: 'Post the opening balances', description: <>One opening voucher of {formatAmount(b.line_total_debit)} is posted on {formatDate(b.as_of_date)}. It can never be edited
            or reversed; later corrections are journal vouchers.</>, confirmLabel: 'Post opening balances', note: 'none',
          run: async () => { const r = await postOpeningBatch(batchId); return `Opening balances posted as ${r.voucher_number}.` },
        })}>Post opening balances</Button>}
        {b.status === 'APPROVED' && canApprove && <Button variant="outline" onClick={() => setAction({ title: 'Return to draft', description: 'The approval is removed so the lines can be changed.',
          confirmLabel: 'Return to draft', note: 'required', minLength: 5, run: async (n) => { await reopenOpeningBatch(batchId, n!); return 'Batch returned to draft.' } })}>Return to draft</Button>}
        {(draft || b.status === 'APPROVED') && has('accounting_opening.import') && <Button variant="outline" className="text-shortage" onClick={() => setAction({
          title: `Discard ${b.batch_number}`, description: 'The batch is kept as discarded and never posted.', confirmLabel: 'Discard batch', note: 'required', minLength: 3, destructive: true,
          run: async (n) => { await discardOpeningBatch(batchId, n!); return 'Batch discarded.' } })}>Discard</Button>}
      </div>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={onChanged} />
    </div>
  )
}

function CheckRow({ check, ack, editable, onAck, acknowledged }: { check: OpeningCheck; ack: string; editable: boolean; onAck: (v: string) => void; acknowledged?: string }) {
  const pass = check.status === 'PASS'
  const details = Array.isArray(check.details) ? (check.details as Record<string, unknown>[]) : []
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="flex items-center gap-2 text-sm">
        {pass ? <CheckCircle2 className="size-4 text-green-600" /> : <XCircle className="size-4 text-red-600" />}
        <span className="font-medium">{check.label}</span>
        {check.expected !== undefined && !pass && <span className="text-muted-foreground">· ERP {formatAmount(check.expected)} · batch {formatAmount(check.actual)} · difference {formatAmount(check.difference)}</span>}
        {!pass && !check.acknowledgeable && <StatusBadge label="Must be fixed" tone="danger" />}
        {check.unvalued_lines ? <span className="text-muted-foreground">· {check.unvalued_lines} opening stock line(s) have no unit cost</span> : null}
      </p>
      {!pass && details.length > 0 && <ul className="mt-1 list-disc pl-10 text-xs text-muted-foreground">{details.slice(0, 15).map((d, i) => (
        <li key={i}>{String(d.party ?? d.account ?? '')}{d.erp !== undefined ? `: ERP ${formatAmount(d.erp as number)} vs batch ${formatAmount(d.batch as number)}` : ''}{d.problem ? ` — ${String(d.problem)}` : ''}{d.line_no ? ` (line ${String(d.line_no)})` : ''}</li>))}</ul>}
      {acknowledged && <p className="mt-1 text-xs text-muted-foreground">Acknowledged: {acknowledged}</p>}
      {editable && <div className="mt-2 space-y-1"><Label htmlFor={`ack-${check.code}`} className="text-xs">Reason for accepting this difference (at least 10 characters)</Label>
        <Textarea id={`ack-${check.code}`} rows={2} value={ack} onChange={(e) => onAck(e.target.value)} /></div>}
    </div>
  )
}
