import { FileMinus, FilePlus2, Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { NoteStatusBadge } from '@/features/billing/billing-badges'
import { BillingExport } from '@/features/billing/billing-export'
import { CREDIT_REASONS, DEBIT_REASONS, NOTE_REASON_LABELS, NOTE_STATUS_LABELS, isAmount, money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { parseQty } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { createNote, fetchInvoice, fetchInvoiceLines, fetchIssuedInvoices, fetchNotes } from '@/services/billing'
import { fetchReturnLines, fetchReturns } from '@/services/sales'
import type { AdjustmentNoteListRow, NoteReason, NoteStatus, NoteType } from '@/types/database-billing'
import type { CustomerReturnLineListRow } from '@/types/database-sales'
import { useUrlEnum } from '@/hooks/use-url-state'

type LineInput = { mode: 'qty' | 'amount'; value: string; returnLineId: string | null }

/** Returns raised against the invoice's sales orders (optional link for sales-return credit notes). */
function useInvoiceReturns(orderIds: string[]) {
  return useAsync(async () => {
    if (!orderIds.length) return { returns: [], lines: [] as CustomerReturnLineListRow[] }
    const returns = (await Promise.all(orderIds.map((id) => fetchReturns({ orderId: id })))).flat().filter((r) => r.received > 0)
    const lines = (await Promise.all(returns.map((r) => fetchReturnLines(r.id)))).flat()
    return { returns, lines }
  }, [orderIds.join(',')])
}

function CreateNoteDialog({ type, initialInvoice, onClose, onCreated }: { type: NoteType; initialInvoice: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [invoiceId, setInvoiceId] = useState(initialInvoice ?? '')
  const invoices = useAsync(() => fetchIssuedInvoices(null), [])
  const inv = useAsync(() => (invoiceId ? fetchInvoice(invoiceId) : Promise.resolve(null)), [invoiceId])
  const lines = useAsync(() => (invoiceId ? fetchInvoiceLines(invoiceId) : Promise.resolve([])), [invoiceId])
  const orderIds = [...new Set((lines.data ?? []).map((l) => l.sales_order_id).filter((x): x is string => Boolean(x)))]
  const [h, setH] = useState(() => ({ note_date: toIsoDate(new Date()), reason_code: '' as NoteReason | '', reason: '', supporting_reference: '', customer_return_id: '' }))
  const returns = useInvoiceReturns(type === 'CREDIT' && h.reason_code === 'SALES_RETURN' ? orderIds : [])
  const [inputs, setInputs] = useState<Record<string, LineInput>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const reasons = type === 'CREDIT' ? CREDIT_REASONS : DEBIT_REASONS
  const setLine = (id: string, patch: Pick<LineInput, 'mode' | 'value'>) => setInputs((x) => ({ ...x, [id]: { returnLineId: x[id]?.returnLineId ?? null, ...patch } }))

  const pickReturn = (returnId: string) => {
    setH((x) => ({ ...x, customer_return_id: returnId }))
    if (!returnId) return
    const next: Record<string, LineInput> = {}
    for (const rl of (returns.data?.lines ?? []).filter((l) => l.return_id === returnId && l.quantity_received > 0)) {
      const il = (lines.data ?? []).find((l) => l.fulfilment_line_id === rl.fulfilment_line_id)
      if (il) next[il.id] = { mode: 'qty', value: String(Number(rl.quantity_received)), returnLineId: rl.id }
    }
    setInputs(next)
  }

  const submit = async () => {
    setError(null)
    if (!invoiceId) return setError('Select the issued invoice.')
    if (!h.reason_code) return setError('Choose a reason.')
    if (h.reason.trim().length < 3) return setError('Describe the reason (at least 3 characters).')
    const payload: { invoice_line_id: string; quantity?: string; taxable_amount?: string; customer_return_line_id?: string | null }[] = []
    for (const [id, v] of Object.entries(inputs)) {
      if (!v.value.trim()) continue
      if (v.mode === 'qty') {
        if (!parseQty(v.value)) return setError('Quantities must be greater than zero (up to 3 decimals).')
        payload.push({ invoice_line_id: id, quantity: v.value.trim(), customer_return_line_id: v.returnLineId })
      } else {
        if (!isAmount(v.value) || Number(v.value) <= 0) return setError('Taxable amounts must be greater than zero with at most 2 decimals.')
        payload.push({ invoice_line_id: id, taxable_amount: v.value.trim(), customer_return_line_id: v.returnLineId })
      }
    }
    if (!payload.length) return setError('Enter a quantity or taxable amount for at least one invoice line.')
    setBusy(true)
    try {
      const r = await createNote(invoiceId, type, {
        note_date: h.note_date, reason_code: h.reason_code, reason: h.reason.trim(), supporting_reference: h.supporting_reference.trim() || null, customer_return_id: h.customer_return_id || null,
      }, payload, key)
      renew()
      onCreated(r.note_id)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New draft {type === 'CREDIT' ? 'credit' : 'debit'} note</DialogTitle>
          <DialogDescription>
            {type === 'CREDIT'
              ? 'Reduces the amount the customer owes on an issued invoice. Tax is calculated by the server with the invoice’s rates and treatment. Credited quantities and values can never exceed what was invoiced. Stock is not changed — returned goods are handled in Sales Returns.'
              : 'Adds to the amount owed on an issued invoice (value only). Tax is calculated by the server with the invoice’s rates and treatment.'}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="nt-inv">Original invoice</Label>
            <Select value={invoiceId} onValueChange={(v) => { setInvoiceId(v); setInputs({}); setH((x) => ({ ...x, customer_return_id: '' })) }}>
              <SelectTrigger id="nt-inv"><SelectValue placeholder={invoices.loading ? 'Loading invoices…' : 'Select an issued invoice'} /></SelectTrigger>
              <SelectContent className="max-h-72">{(invoices.data ?? []).map((i) => <SelectItem key={i.id} value={i.id}>{i.invoice_number} — {i.customer_legal_name} ({money(i.grand_total)})</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="nt-date">Note date</Label><Input id="nt-date" type="date" value={h.note_date} onChange={(e) => setH({ ...h, note_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="nt-reason-code">Reason</Label>
            <Select value={h.reason_code} onValueChange={(v) => setH({ ...h, reason_code: v as NoteReason, customer_return_id: '' })}>
              <SelectTrigger id="nt-reason-code"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>{reasons.map((r) => <SelectItem key={r} value={r}>{NOTE_REASON_LABELS[r]}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="nt-reason">Description (printed on the note)</Label><Input id="nt-reason" maxLength={500} value={h.reason} onChange={(e) => setH({ ...h, reason: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="nt-ref">Supporting reference (optional)</Label><Input id="nt-ref" maxLength={100} value={h.supporting_reference} onChange={(e) => setH({ ...h, supporting_reference: e.target.value })} /></div>
          {type === 'CREDIT' && h.reason_code === 'SALES_RETURN' && invoiceId && (
            <div className="space-y-1"><Label htmlFor="nt-return">Received return (optional)</Label>
              <Select value={h.customer_return_id || 'none'} onValueChange={(v) => pickReturn(v === 'none' ? '' : v)}>
                <SelectTrigger id="nt-return"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">{returns.loading ? 'Loading…' : returns.error ? 'Returns not visible' : 'Not linked'}</SelectItem>
                  {(returns.data?.returns ?? []).map((r) => <SelectItem key={r.id} value={r.id}>{r.return_number} · {r.sales_order_number} · received {formatQty(r.received, r.units ?? undefined)}</SelectItem>)}</SelectContent>
              </Select></div>
          )}
        </div>
        {inv.data && (
          <div className="max-h-72 overflow-auto rounded-lg border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="sticky top-0 bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Item</th><th className="px-2 py-1.5 text-right">Invoiced</th>
                <th className="px-2 py-1.5 text-right">Taxable</th><th className="px-2 py-1.5 text-right">GST %</th><th className="px-2 py-1.5 text-left">{type === 'CREDIT' ? 'Credit by' : 'Debit'}</th><th className="px-2 py-1.5 text-right">Value</th></tr></thead>
              <tbody>{(lines.data ?? []).map((l) => {
                const v = inputs[l.id] ?? { mode: type === 'DEBIT' || l.line_type === 'CHARGE' ? 'amount' : 'qty', value: '', returnLineId: null }
                return (
                  <tr key={l.id} className="border-t">
                    <td className="px-2 py-1.5">{l.line_no}</td>
                    <td className="px-2 py-1.5">{l.sku ?? ''}<span className="block text-xs text-muted-foreground">{l.description}</span>{v.returnLineId && <span className="block text-xs text-primary">linked to return line</span>}</td>
                    <td className="px-2 py-1.5 text-right">{formatQty(l.quantity, l.unit ?? undefined)}</td>
                    <td className="px-2 py-1.5 text-right">{money(l.taxable_value, false)}</td>
                    <td className="px-2 py-1.5 text-right">{l.gst_rate === null ? '—' : `${Number(l.gst_rate)}%`}</td>
                    <td className="px-2 py-1.5">{type === 'CREDIT' && l.line_type === 'PRODUCT' ? (
                      <Select value={v.mode} onValueChange={(m) => setLine(l.id, { mode: m as LineInput['mode'], value: '' })}>
                        <SelectTrigger aria-label={`Credit mode line ${l.line_no}`} className="h-8 w-36"><SelectValue /></SelectTrigger>
                        <SelectContent><SelectItem value="qty">Quantity</SelectItem><SelectItem value="amount">Taxable amount</SelectItem></SelectContent>
                      </Select>) : <span className="text-xs text-muted-foreground">Taxable amount</span>}</td>
                    <td className="px-2 py-1.5 text-right"><Input aria-label={`${v.mode === 'qty' ? 'Quantity' : 'Taxable amount'} line ${l.line_no}`} className="ml-auto h-8 w-28 text-right" inputMode="decimal"
                      placeholder={v.mode === 'qty' ? 'qty' : '0.00'} value={v.value} onChange={(e) => setLine(l.id, { mode: v.mode, value: e.target.value })} /></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">The note is saved as a draft. It gets its official number only when issued, and only an issued note changes the invoice balance.</p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Create draft</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Tab = 'ALL' | NoteStatus
export function NotesView({ type }: { type: NoteType }) {
  const { has } = usePermissions()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [creating, setCreating] = useState(Boolean(params.get('invoice')) && has('invoice_adjustments.create'))
  // Kept in the address, so Back from a record returns to the same tab.
  const [tab, setTab] = useUrlEnum<Tab>('status', ['ALL', 'DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'CANCELLED', 'DISCARDED'], 'ALL')
  const list = useAsync(() => fetchNotes({ type, status: tab === 'ALL' ? null : tab }), [type, tab])
  const Icon = type === 'CREDIT' ? FileMinus : FilePlus2
  const label = type === 'CREDIT' ? 'credit' : 'debit'

  const columns: DataTableColumn<AdjustmentNoteListRow>[] = [
    { id: 'number', header: 'Note', searchValue: (n) => n.note_number ?? '', cell: (n) => (
      <span><Link className="font-medium text-primary hover:underline" to={`/billing/notes/${n.id}`}>{n.note_number ?? 'Draft'}</Link><span className="block text-xs text-muted-foreground">{formatDate(n.note_date)}</span></span>
    ) },
    { id: 'invoice', header: 'Original invoice', searchValue: (n) => n.invoice_number ?? '', cell: (n) => <Link className="text-primary hover:underline" to={`/billing/invoices/${n.original_invoice_id}`}>{n.invoice_number}</Link> },
    { id: 'customer', header: 'Customer', searchValue: (n) => `${n.customer_name} ${n.customer_code}`, cell: (n) => n.customer_name },
    { id: 'reason', header: 'Reason', searchValue: (n) => n.reason, cell: (n) => <span className="text-xs">{NOTE_REASON_LABELS[n.reason_code]}<span className="block text-muted-foreground">{n.reason}</span>{n.return_number && <span className="block">Return {n.return_number}</span>}</span> },
    { id: 'taxable', header: 'Taxable', align: 'right', cell: (n) => money(n.taxable_amount, false) },
    { id: 'tax', header: 'GST', align: 'right', cell: (n) => money(Number(n.cgst_amount) + Number(n.sgst_amount) + Number(n.igst_amount), false) },
    { id: 'total', header: 'Total', align: 'right', sortValue: (n) => Number(n.total_amount), cell: (n) => <span className="font-medium">{money(n.total_amount)}</span> },
    { id: 'status', header: 'Status', cell: (n) => <NoteStatusBadge status={n.status} /> },
  ]

  return (
    <>
      <PageHeader actions={<>
        <BillingExport title={`${type === 'CREDIT' ? 'Credit' : 'Debit'} notes`} fileStem={`${label}-notes`} rows={list.data ?? []} columns={[
          { header: 'Note no.', value: (n) => n.note_number }, { header: 'Note date', value: (n) => n.note_date }, { header: 'Invoice no.', value: (n) => n.invoice_number },
          { header: 'Customer', value: (n) => n.customer_name }, { header: 'Reason', value: (n) => NOTE_REASON_LABELS[n.reason_code] }, { header: 'Description', value: (n) => n.reason },
          { header: 'Taxable', value: (n) => Number(n.taxable_amount) }, { header: 'CGST', value: (n) => Number(n.cgst_amount) }, { header: 'SGST', value: (n) => Number(n.sgst_amount) },
          { header: 'IGST', value: (n) => Number(n.igst_amount) }, { header: 'Total', value: (n) => Number(n.total_amount) }, { header: 'Status', value: (n) => NOTE_STATUS_LABELS[n.status] },
        ]} />
        {has('invoice_adjustments.create') && <Button onClick={() => setCreating(true)}><Plus /> New {label} note</Button>}
      </>} />
      <Card className="mb-4">
        <CardContent className="p-4">
          <FilterTabs<Tab> label="Note status" value={tab} onChange={setTab} options={[
            { value: 'ALL', label: 'All' }, { value: 'DRAFT', label: 'Draft' }, { value: 'PENDING_APPROVAL', label: 'Pending approval' }, { value: 'ISSUED', label: 'Issued' }, { value: 'CANCELLED', label: 'Cancelled' }]} />
        </CardContent>
      </Card>
      <DataTable columns={columns} data={list.data ?? []} getRowId={(n) => n.id} loading={list.loading} searchPlaceholder={`Search ${label} notes…`} pageSize={25}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: Icon, title: `No ${label} notes`, description: `${type === 'CREDIT' ? 'Credit' : 'Debit'} notes are raised against issued invoices (from the invoice or with “New ${label} note”).` }} />
      {creating && <CreateNoteDialog type={type} initialInvoice={params.get('invoice')}
        onClose={() => { setCreating(false); setParams({}, { replace: true }) }}
        onCreated={(id) => navigate(`/billing/notes/${id}?created=1`)} />}
    </>
  )
}
