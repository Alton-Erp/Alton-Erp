import { ArrowLeftRight, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatAmount, isPositiveAmount, toPaise } from '@/features/accounting/accounting-model'
import { AccountingExport, SearchSelect } from '@/features/accounting/accounting-ui'
import { TRANSFER_STATUS_META, type BankLookups, type Transfer, type TransferStatus } from '@/features/accounting/bank-cash-model'
import { MoneyAccountSelect } from '@/features/accounting/bank-cash-ui'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { cancelTransfer, fetchBankLookups, fetchTransfers, postTransfer, reverseTransfer, saveTransfer } from '@/services/accounting'

export default function TransfersPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? 'all'
  const [refresh, setRefresh] = useState(0)
  const [edit, setEdit] = useState<Transfer | 'new' | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const lookups = useAsync(() => fetchBankLookups(), [])
  const list = useAsync(() => fetchTransfers({ status: status === 'all' ? null : status }), [status, refresh])
  const done = (m: string) => { setAction(null); setEdit(null); setMessage(m); setRefresh((n) => n + 1) }
  const columns: DataTableColumn<Transfer>[] = [
    { id: 'no', header: 'Transfer', sortValue: (t) => t.transfer_number, searchValue: (t) => `${t.transfer_number} ${t.reference ?? ''}`, cell: (t) => <span className="text-sm font-medium">{t.transfer_number}
      {t.reference && <span className="block text-xs font-normal text-muted-foreground">Ref {t.reference}</span>}</span> },
    { id: 'date', header: 'Date', sortValue: (t) => t.transfer_date, cell: (t) => formatDate(t.transfer_date) },
    { id: 'from', header: 'From', cell: (t) => <span className="text-sm">{t.from_account_code} {t.from_account_name}</span> },
    { id: 'to', header: 'To', cell: (t) => <span className="text-sm">{t.to_account_code} {t.to_account_name}</span> },
    { id: 'amount', header: 'Amount', align: 'right', sortValue: (t) => toPaise(t.amount), cell: (t) => <span className="tabular-nums">{formatAmount(t.amount)}</span> },
    { id: 'charges', header: 'Charges', align: 'right', cell: (t) => <span className="tabular-nums">{formatAmount(t.charges, true)}</span> },
    { id: 'voucher', header: 'Voucher', cell: (t) => (t.voucher_id ? <Link className="text-sm text-primary hover:underline" to={`/accounts/vouchers/${t.voucher_id}`}>{t.voucher_number}</Link> : '—') },
    { id: 'status', header: 'Status', cell: (t) => <StatusBadge label={TRANSFER_STATUS_META[t.status].label} tone={TRANSFER_STATUS_META[t.status].tone} /> },
    { id: 'actions', header: '', align: 'right', cell: (t) => (
      <span className="flex justify-end gap-1">
        {t.status === 'DRAFT' && has('bank_transfers.create') && <Button variant="ghost" size="sm" onClick={() => setEdit(t)}>Edit</Button>}
        {t.status === 'DRAFT' && has('bank_transfers.post') && <Button variant="ghost" size="sm" onClick={() => setAction({ title: `Post ${t.transfer_number}`, confirmLabel: 'Post transfer', note: 'none',
          description: <>One contra voucher: Dr {t.to_account_name} {formatAmount(t.amount)} / Cr {t.from_account_name}{toPaise(t.charges) > 0 ? <>, plus charges {formatAmount(t.charges)} to {t.charges_account_name}</> : null}.
            Refused if it would take a cash (or no-overdraft bank) account below zero. A posted transfer can only be reversed.</>,
          run: async () => { const r = await postTransfer(t.id); return `${r.transfer_number} posted as ${r.voucher_number}.` } })}>Post</Button>}
        {t.status === 'DRAFT' && has('bank_transfers.create') && <Button variant="ghost" size="sm" onClick={() => setAction({ title: `Cancel ${t.transfer_number}`, confirmLabel: 'Cancel draft', note: 'required',
          minLength: 3, destructive: true, description: 'The draft is kept as cancelled and never posted.', run: async (n) => { await cancelTransfer(t.id, n!); return 'Draft cancelled.' } })}>Cancel</Button>}
        {t.status === 'POSTED' && has('bank_transfers.post') && <Button variant="ghost" size="sm" className="text-shortage" onClick={() => setAction({ title: `Reverse ${t.transfer_number}`,
          confirmLabel: 'Reverse transfer', note: 'required', minLength: 5, destructive: true, description: 'A linked reversal voucher with the opposite entries is posted today.',
          run: async (n) => { const r = await reverseTransfer(t.id, n!); return `${r.transfer_number} reversed by ${r.reversal_voucher_number}.` } })}>Reverse</Button>}
      </span>) },
  ]
  return (
    <>
      <PageHeader title="Bank & Cash Transfers" breadcrumbs={[{ label: 'Accounts' }, { label: 'Transfers' }]}
        description="Bank to bank, cash to bank, bank to cash and cash to cash. Transfers never touch income or expense (charges go to an expense ledger you choose)."
        actions={<>
          <AccountingExport title="Transfer register" fileStem="transfers" rows={list.data ?? []} columns={[
            { header: 'Transfer', value: (t) => t.transfer_number }, { header: 'Date', value: (t) => t.transfer_date }, { header: 'From', value: (t) => t.from_account_code },
            { header: 'To', value: (t) => t.to_account_code }, { header: 'Amount', value: (t) => Number(t.amount) }, { header: 'Charges', value: (t) => Number(t.charges) },
            { header: 'Reference', value: (t) => t.reference }, { header: 'Status', value: (t) => TRANSFER_STATUS_META[t.status].label }, { header: 'Voucher', value: (t) => t.voucher_number }]} />
          {has('bank_transfers.create') && <Button onClick={() => setEdit('new')}><Plus /> New transfer</Button>}
        </>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="tr-status">Status</Label>
          <Select value={status} onValueChange={(v) => setParams((p) => { const n = new URLSearchParams(p); if (v === 'all') n.delete('status'); else n.set('status', v); return n }, { replace: true })}>
            <SelectTrigger id="tr-status" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{(Object.keys(TRANSFER_STATUS_META) as TransferStatus[]).map((s) => <SelectItem key={s} value={s}>{TRANSFER_STATUS_META[s].label}</SelectItem>)}</SelectContent></Select></div>
      </CardContent></Card>
      <DataTable columns={columns} data={list.data ?? []} getRowId={(t) => t.id} loading={list.loading} error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: ArrowLeftRight, title: 'No transfers', description: 'Transfers between bank and cash accounts appear here.' }} />
      {edit && <TransferDialog transfer={edit === 'new' ? null : edit} lookups={lookups.data} onClose={() => setEdit(null)} onDone={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}

function TransferDialog({ transfer, lookups, onClose, onDone }: { transfer: Transfer | null; lookups: BankLookups | undefined; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ transfer_date: transfer?.transfer_date ?? lookups?.today ?? '', from_account_id: transfer?.from_account_id ?? '', to_account_id: transfer?.to_account_id ?? '',
    amount: transfer ? Number(transfer.amount).toFixed(2) : '', charges: transfer && toPaise(transfer.charges) ? Number(transfer.charges).toFixed(2) : '',
    charges_account_id: transfer?.charges_account_id ?? '', reference: transfer?.reference ?? '', narration: transfer?.narration ?? '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const errs = [
    !f.transfer_date && 'Enter the transfer date.', (!f.from_account_id || !f.to_account_id) && 'Choose the source and destination accounts.',
    f.from_account_id && f.from_account_id === f.to_account_id && 'The source and destination must be different.', !isPositiveAmount(f.amount) && 'Enter an amount greater than zero (2 decimals).',
    f.charges.trim() && !isPositiveAmount(f.charges) && 'Charges: an amount with at most 2 decimals.', f.charges.trim() && !f.charges_account_id && 'Choose the expense ledger for the charges.',
  ].filter(Boolean) as string[]
  const save = async () => {
    if (errs.length) return
    setBusy(true); setError(null)
    try {
      const r = await saveTransfer(transfer?.id ?? null, { ...f, charges: f.charges.trim() || '0', charges_account_id: f.charges.trim() ? f.charges_account_id : null,
        reference: f.reference.trim() || null, narration: f.narration.trim() || null }, transfer?.row_version ?? null)
      onDone(`Draft ${r.transfer_number} saved. Post it to put it in the books.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{transfer ? `Edit ${transfer.transfer_number}` : 'New transfer'}</DialogTitle>
          <DialogDescription>Saved as a draft; posting creates one contra voucher (Dr destination / Cr source).</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="tr-date">Date</Label><Input id="tr-date" type="date" value={f.transfer_date} onChange={(e) => set({ transfer_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-amount">Amount</Label><Input id="tr-amount" inputMode="decimal" className="text-right" value={f.amount} onChange={(e) => set({ amount: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-from">From (source)</Label><MoneyAccountSelect id="tr-from" value={f.from_account_id} lookups={lookups} onChange={(v) => set({ from_account_id: v })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-to">To (destination)</Label><MoneyAccountSelect id="tr-to" value={f.to_account_id} lookups={lookups} onChange={(v) => set({ to_account_id: v })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-charges">Bank charges (optional)</Label><Input id="tr-charges" inputMode="decimal" className="text-right" value={f.charges} onChange={(e) => set({ charges: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-chacc">Charges ledger</Label><SearchSelect id="tr-chacc" value={f.charges_account_id} allowClear placeholder="Expense ledger"
            options={(lookups?.expense_ledgers ?? []).map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}` }))} onChange={(v) => set({ charges_account_id: v })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-ref">Reference (UTR / cheque no.)</Label><Input id="tr-ref" maxLength={100} value={f.reference} onChange={(e) => set({ reference: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="tr-narr">Narration</Label><Input id="tr-narr" maxLength={500} value={f.narration} onChange={(e) => set({ narration: e.target.value })} /></div>
        </div>
        {errs.length > 0 && f.amount && <ul className="list-disc pl-5 text-sm text-amber-800">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || errs.length > 0} onClick={() => void save()}>Save draft</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
