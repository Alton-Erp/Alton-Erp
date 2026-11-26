import { ArrowLeft, Pencil } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { RecordDocuments } from '@/features/admin/record-documents'
import { formatAmount, isPositiveAmount, toPaise } from '@/features/accounting/accounting-model'
import { Field } from '@/features/accounting/accounting-ui'
import { OUTCOME_LABELS } from '@/features/accounting/gstr2b-model'
import { PI_TYPE_LABELS, SUPPLY_CATEGORY_LABELS, piActions, type PurchaseInvoice } from '@/features/accounting/purchase-invoice-model'
import { GstStatusBadge, PiIssues, PiStatusBadge, VarianceBadge } from '@/features/accounting/purchase-invoice-ui'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  allocateSupplierPayment, approvePurchaseInvoice, cancelPurchaseInvoice, fetchItc, fetchPurchaseInvoice, fetchSupplierPaymentOptions, itcAction, postPurchaseInvoice,
  returnPurchaseInvoice, reversePurchaseInvoice, submitPurchaseInvoice, unallocateSupplierPayment, verifyPurchaseInvoiceGst,
} from '@/services/accounting'

export default function PurchaseInvoiceDetailPage() {
  const { invoiceId = '' } = useParams()
  const arrived = (useLocation().state as { message?: string } | null)?.message ?? null
  const { has } = usePermissions()
  const inv = useAsync(() => fetchPurchaseInvoice(invoiceId), [invoiceId])
  // Phase 5 Gate C: ITC decisions are maker-checker; the pending proposal and the GSTR-2B evidence come from the ITC view.
  const itc = useAsync(() => fetchItc(invoiceId), [invoiceId])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [dialog, setDialog] = useState<'approve' | 'gst' | 'pay' | null>(null)
  const [message, setMessage] = useState<string | null>(arrived)
  const crumbs = [{ label: 'Purchase & GRN' }, { label: 'Supplier Invoices', to: '/purchases/invoices' }, { label: inv.data?.invoice_number ?? 'Invoice' }]
  if (inv.loading) return <><PageHeader title="Supplier invoice" breadcrumbs={crumbs} /><LoadingState /></>
  if (inv.error) return <><PageHeader title="Supplier invoice" breadcrumbs={crumbs} /><ErrorState message={describeDataError(inv.error)} onRetry={inv.reload} /></>
  const x = inv.data!
  const can = piActions(x, has)
  const done = (m: string) => { setAction(null); setDialog(null); setMessage(m); inv.reload(); itc.reload() }
  const proposal = itc.data?.stage === 'PROPOSED' ? itc.data.history.at(-1) ?? null : null
  const evidence = itc.data?.gstr2b ?? null
  const tax = toPaise(x.cgst_total) + toPaise(x.sgst_total) + toPaise(x.igst_total) + toPaise(x.cess_total)
  const matched = x.lines.some((l) => l.line_kind === 'GRN')

  return (
    <>
      <PageHeader title={`${x.invoice_number} · ${x.supplier_name}`} breadcrumbs={crumbs}
        description={`Supplier invoice ${x.supplier_invoice_number} of ${formatDate(x.supplier_invoice_date)} · ${PI_TYPE_LABELS[x.invoice_type]}`} actions={<>
          <Button variant="outline" asChild><Link to="/purchases/invoices"><ArrowLeft /> Register</Link></Button>
          {can.edit && <Button variant="outline" asChild><Link to={`/purchases/invoices/${x.id}/edit`}><Pencil /> Edit draft</Link></Button>}
          {can.submit && <Button onClick={() => setAction({ title: `Submit ${x.invoice_number}`, confirmLabel: 'Submit for approval', note: 'none',
            description: 'The database checks the invoice again (totals, GST, receipts, cost centres). Variances against the receipts are flagged for the approver.',
            run: async () => { const r = await submitPurchaseInvoice(x.id); return `${r.invoice_number} submitted.` } })}>Submit</Button>}
          {can.approve && <Button onClick={() => setDialog('approve')}>Approve</Button>}
          {can.post && <Button onClick={() => setAction({ title: `Post ${x.invoice_number}`, confirmLabel: 'Post to the accounts', note: 'none',
            description: matched ? <>Matched receipt lines post only their differences against the receipts (price variance, GST difference, Creditors adjustment);
              direct lines post Dr expense, Dr GST pending verification / Cr Creditors. If nothing differs, no voucher is needed.</>
              : <>Posts Dr expense lines (with their cost-centre split), Dr GST pending verification / Cr Creditors {formatAmount(x.grand_total)}.</>,
            run: async () => { const r = await postPurchaseInvoice(x.id); return r.voucher_number ? `Posted as voucher ${r.voucher_number}.` : 'Posted — it matches the goods receipts exactly, so no voucher was needed.' } })}>Post</Button>}
          {can.verifyGst && !proposal && <Button variant="outline" onClick={() => setDialog('gst')}>Propose GST decision</Button>}
          {can.verifyGst && proposal && <Button onClick={() => setAction({ title: `Approve the ITC decision of ${x.invoice_number}`, confirmLabel: 'Approve and post', note: 'none',
            description: <>Proposed {proposal.decision?.replace(/_/g, ' ').toLowerCase()} by {proposal.by ?? '—'}: {proposal.reason}. Maker-checker: the person who proposed it cannot approve it.
              Approval posts the GST voucher.</>,
            run: async () => { const r = await itcAction(x.id, 'APPROVE'); return `ITC decision approved — GST ${r.gst_status.replace(/_/g, ' ').toLowerCase()}.` } })}>Approve GST decision</Button>}
          {can.verifyGst && proposal && <Button variant="outline" onClick={() => setAction({ title: 'Reject the ITC proposal', confirmLabel: 'Reject proposal', note: 'required', minLength: 5,
            description: 'Nothing is posted; the GST stays pending for a new proposal.', run: async (n) => { await itcAction(x.id, 'REJECT', { reason: n! }); return 'ITC proposal rejected.' } })}>Reject GST proposal</Button>}
          {can.allocate && Number(x.outstanding) > 0 && <Button variant="outline" onClick={() => setDialog('pay')}>Allocate payment</Button>}
          {can.returnToDraft && <Button variant="outline" onClick={() => setAction({ title: 'Return to draft', confirmLabel: 'Return to draft', note: 'required', minLength: 5,
            description: 'The invoice goes back to draft for correction; submission and approval start again.',
            run: async (n) => { await returnPurchaseInvoice(x.id, n!); return 'Returned to draft.' } })}>Return to draft</Button>}
          {can.cancel && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: `Cancel ${x.invoice_number}`, confirmLabel: 'Cancel invoice', note: 'required',
            minLength: 3, destructive: true, description: 'A cancelled invoice never reaches the books and releases the goods receipt quantities it held.',
            run: async (n) => { await cancelPurchaseInvoice(x.id, n!); return 'Invoice cancelled.' } })}>Cancel</Button>}
          {can.reverse && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: `Reverse ${x.invoice_number}`, confirmLabel: 'Reverse invoice', note: 'required',
            minLength: 5, destructive: true, description: <>Linked reversal vouchers undo the invoice's posting{x.gst_voucher_id ? ' and its GST verification' : ''}. Payments must be
              unallocated first. The supplier invoice number can then be entered again.</>,
            run: async (n) => { await reversePurchaseInvoice(x.id, n!); return 'Invoice reversed.' } })}>Reverse</Button>}
        </>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {['DRAFT', 'SUBMITTED', 'APPROVED'].includes(x.status) && <PiIssues issues={x.issues ?? []} />}

      <Card className="mb-4">
        <CardContent className="p-4">
          <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Field label="Status"><span className="flex flex-wrap gap-1"><PiStatusBadge status={x.status} /><VarianceBadge status={x.variance_status} /></span></Field>
            <Field label="GST"><GstStatusBadge status={x.gst_status} /></Field>
            <Field label="Supplier">{x.supplier_code} {x.supplier_name}</Field>
            <Field label="Supplier GSTIN">{x.supplier_gstin ?? '—'}</Field>
            <Field label="Place of supply">{x.place_of_supply_state_code ?? '—'} · {x.tax_treatment === 'INTER_STATE' ? 'IGST' : 'CGST + SGST'}</Field>
            <Field label="Supply">{SUPPLY_CATEGORY_LABELS[x.supply_category]}{x.reverse_charge ? ' · reverse charge' : ''}</Field>
            <Field label="Recorded on">{formatDate(x.recorded_date)}</Field>
            <Field label="Due">{x.due_date ? formatDate(x.due_date) : '—'}</Field>
            {x.purchase_order_number && <Field label="Purchase order">{x.purchase_order_number}</Field>}
            <Field label="Voucher">{x.voucher_id ? <Link className="text-primary hover:underline" to={`/accounts/vouchers/${x.voucher_id}`}>{x.voucher_number}</Link>
              : x.status === 'POSTED' || x.status === 'REVERSED' ? 'None needed (matches the receipts)' : '—'}</Field>
            {x.gst_voucher_id && <Field label="GST voucher"><Link className="text-primary hover:underline" to={`/accounts/vouchers/${x.gst_voucher_id}`}>{x.gst_voucher_number}</Link></Field>}
            <Field label="Entered">{formatDateTime(x.created_at)} · {x.created_by_name ?? '—'}</Field>
            {x.approved_at && <Field label="Approved">{formatDateTime(x.approved_at)} · {x.approved_by_name ?? '—'}</Field>}
            {x.posted_at && <Field label="Posted">{formatDateTime(x.posted_at)} · {x.posted_by_name ?? '—'}</Field>}
            {x.variance_note && <Field label="Variance approval">{x.variance_note}</Field>}
            {x.gst_verification && <Field label="GST verification">{x.gst_verification.reason}</Field>}
            {proposal && <Field label="ITC proposal (awaiting approval)">{proposal.decision?.replace(/_/g, ' ').toLowerCase()} · {proposal.by ?? '—'} · {proposal.reason}</Field>}
            {evidence && toPaise(x.cgst_total) + toPaise(x.sgst_total) + toPaise(x.igst_total) + toPaise(x.cess_total) > 0 && <Field label="GSTR-2B">{evidence.match_status === 'NOT_MATCHED'
              ? 'Not matched to a GSTR-2B document' : `${evidence.match_status === 'APPROVED' ? 'Matched' : 'Match awaiting approval'}: ${evidence.doc_number} (${evidence.return_period})${
                evidence.outcome ? ` · ${OUTCOME_LABELS[evidence.outcome]}` : ''}${evidence.itc_availability ? ` · ITC availability ${evidence.itc_availability.toLowerCase()}` : ''}${
                evidence.needs_review ? ' · document changed, review' : ''}`}</Field>}
            {x.reversal_reason && <Field label="Reversal reason">{x.reversal_reason}</Field>}
            {x.cancel_reason && <Field label="Cancel reason">{x.cancel_reason}</Field>}
          </dl>
          {x.narration && <p className="mt-3 text-sm">{x.narration}</p>}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><div><CardTitle>Lines</CardTitle><CardDescription>{matched ? 'Receipt lines show the receipt\'s share for the invoiced quantity once posted.' : 'Direct lines.'}</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader><TableRow><TableHead className="w-10">#</TableHead><TableHead>Receipt line / ledger</TableHead><TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Price</TableHead><TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">GST %</TableHead>
              <TableHead className="text-right">GST</TableHead><TableHead className="text-right">Receipt share</TableHead><TableHead className="text-right">Difference</TableHead></TableRow></TableHeader>
            <TableBody>{x.lines.map((l) => {
              const lineTax = toPaise(l.cgst) + toPaise(l.sgst) + toPaise(l.igst) + toPaise(l.cess)
              const share = l.matched_payable === null ? null : toPaise(l.matched_payable)
              return (
                <TableRow key={l.id} data-testid="pi-detail-line">
                  <TableCell>{l.line_no}</TableCell>
                  <TableCell className="text-sm">{l.line_kind === 'GRN' ? <>{l.receipt_number} · {l.product_name ?? l.description}
                    <span className="block text-xs text-muted-foreground">Receipt cost {formatAmount(l.grn_unit_cost ?? l.grn_unit_cost_now)} @ {Number(l.grn_gst_rate ?? l.grn_rate)}%</span></>
                    : <>{l.account_code} {l.account_name}{l.description && <span className="block text-xs text-muted-foreground">{l.description}</span>}
                      {l.allocations.length > 0 && <span className="block text-xs text-muted-foreground">Cost centres: {l.allocations.map((a) => `${a.cost_centre_code} ${formatAmount(a.amount)}`).join(', ')}</span>}</>}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(l.unit_price)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(l.taxable_value)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(l.gst_rate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(lineTax / 100, true)}</TableCell>
                  <TableCell className="text-right tabular-nums">{share === null ? '—' : formatAmount(share / 100)}</TableCell>
                  <TableCell className="text-right tabular-nums">{share === null ? '—' : formatAmount((toPaise(l.taxable_value) + lineTax - share) / 100)}</TableCell>
                </TableRow>)
            })}</TableBody>
          </Table>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-t p-4 text-sm sm:max-w-md sm:ml-auto" data-testid="pi-detail-totals">
            <dt>Taxable value</dt><dd className="text-right tabular-nums">{formatAmount(x.taxable_value)}</dd>
            {toPaise(x.cgst_total) > 0 && <><dt>CGST</dt><dd className="text-right tabular-nums">{formatAmount(x.cgst_total)}</dd></>}
            {toPaise(x.sgst_total) > 0 && <><dt>SGST</dt><dd className="text-right tabular-nums">{formatAmount(x.sgst_total)}</dd></>}
            {toPaise(x.igst_total) > 0 && <><dt>IGST</dt><dd className="text-right tabular-nums">{formatAmount(x.igst_total)}</dd></>}
            {toPaise(x.cess_total) > 0 && <><dt>Cess</dt><dd className="text-right tabular-nums">{formatAmount(x.cess_total)}</dd></>}
            {toPaise(x.round_off) !== 0 && <><dt>Round-off</dt><dd className="text-right tabular-nums">{formatAmount(x.round_off)}</dd></>}
            <dt className="font-semibold">Invoice total{x.reverse_charge && tax > 0 ? ' (GST under reverse charge not included)' : ''}</dt>
            <dd className="text-right font-semibold tabular-nums">{formatAmount(x.grand_total)}</dd>
            {x.outstanding !== null && <><dt>Paid</dt><dd className="text-right tabular-nums">{formatAmount(x.paid)}</dd>
              <dt className="font-semibold">Outstanding</dt><dd className="text-right font-semibold tabular-nums" data-testid="pi-outstanding">{formatAmount(x.outstanding)}</dd></>}
          </dl>
        </CardContent>
      </Card>

      {x.reconciliation && x.reconciliation.lines.length > 0 && (
        <Card className="mb-4">
          <CardHeader><div><CardTitle>Reconciliation with the goods receipts</CardTitle>
            <CardDescription>{x.reconciliation.reconciled ? 'Reconciled: receipt shares + the Creditors posted by this invoice = the invoice total. No duplicate payable.' : 'Not reconciled.'}</CardDescription></div></CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Field label="Receipt payable share">{formatAmount(x.reconciliation.receipt_share_total)}</Field>
              <Field label="Creditors posted by this invoice">{formatAmount(x.reconciliation.creditors_posted_by_invoice)}</Field>
              <Field label="Invoice total">{formatAmount(x.reconciliation.invoice_total)}</Field>
            </dl>
          </CardContent>
        </Card>
      )}

      {x.payments.length > 0 && (
        <Card className="mb-4">
          <CardHeader><div><CardTitle>Payments</CardTitle><CardDescription>Supplier payments allocated to this invoice (the payments' own vouchers are unchanged).</CardDescription></div></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Payment</TableHead><TableHead>Date</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{x.payments.map((p) => (
                <TableRow key={p.id}><TableCell>{p.payment_number}</TableCell><TableCell>{formatDate(p.payment_date)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(p.amount)}</TableCell>
                  <TableCell className="text-sm">{p.status === 'REVERSED' ? `Removed: ${p.reversal_reason}` : p.payment_status === 'RECORDED' ? 'Allocated' : 'Payment reversed'}</TableCell>
                  <TableCell className="text-right">{p.status === 'ACTIVE' && has('supplier_payment.manage') && <Button variant="ghost" size="sm" onClick={() => setAction({
                    title: `Remove ${p.payment_number} from this invoice`, confirmLabel: 'Remove allocation', note: 'required', minLength: 3,
                    description: 'The payment becomes available again; the invoice outstanding goes up by the amount.',
                    run: async (n) => { await unallocateSupplierPayment(p.id, n!); return 'Allocation removed.' } })}>Remove</Button>}</TableCell></TableRow>))}</TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="mb-4"><RecordDocuments entityType="PURCHASE_INVOICE" entityId={x.id} defaultType="INVOICE_COPY" title="Attachments (supplier invoice copy, e-way bill…)" /></div>

      <Card>
        <CardHeader><div><CardTitle>History</CardTitle></div></CardHeader>
        <CardContent><ul className="space-y-1 text-sm" data-testid="pi-history">{x.history.map((h, i) => (
          <li key={i}><span className="text-muted-foreground">{formatDateTime(h.at)}</span> · {h.action.replace(/_/g, ' ').toLowerCase()} · {h.by ?? 'System'}{h.note ? ` — ${h.note}` : ''}</li>
        ))}</ul></CardContent>
      </Card>

      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      {dialog === 'approve' && <ApproveDialog invoice={x} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'gst' && <GstDialog invoice={x} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'pay' && <PaymentDialog invoice={x} onClose={() => setDialog(null)} onDone={done} />}
    </>
  )
}

function useRun(onDone: (m: string) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setError(null)
    try { onDone(await fn()) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return { busy, error, run }
}

function ApproveDialog({ invoice, onClose, onDone }: { invoice: PurchaseInvoice; onClose: () => void; onDone: (m: string) => void }) {
  const exception = invoice.variance_status === 'EXCEPTION'
  const [accept, setAccept] = useState(false)
  const [note, setNote] = useState('')
  const { busy, error, run } = useRun(onDone)
  const ok = !exception || (accept && note.trim().length >= 10)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Approve {invoice.invoice_number}</DialogTitle>
          <DialogDescription>{exception ? 'Price or GST-rate differences against the goods receipts are outside the tolerance. Approve them explicitly with a reason.'
            : 'The invoice matches its receipts within the tolerance (or has no receipt lines).'}</DialogDescription></DialogHeader>
        {exception && <PiIssues issues={(invoice.issues ?? []).filter((i) => !i.blocking)} />}
        {exception && <label className="flex items-center gap-2 text-sm"><Checkbox checked={accept} onCheckedChange={(c) => setAccept(c === true)} /> I accept these variances</label>}
        <div className="space-y-1"><Label htmlFor="pi-approve-note">{exception ? 'Reason (at least 10 characters)' : 'Note (optional)'}</Label>
          <Textarea id="pi-approve-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !ok} onClick={() => run(async () => { await approvePurchaseInvoice(invoice.id, note.trim() || null, exception && accept); return 'Invoice approved.' })}>Approve</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const GST_CHECKS: { key: string; label: string }[] = [
  { key: 'invoice_verified', label: 'Supplier invoice checked (number, date, amounts, tax)' },
  { key: 'goods_services_received', label: 'Goods / services received' },
  { key: 'gstin_valid', label: 'Supplier GSTIN valid and active' },
]

function GstDialog({ invoice, onClose, onDone }: { invoice: PurchaseInvoice; onClose: () => void; onDone: (m: string) => void }) {
  const [status, setStatus] = useState<'ELIGIBLE' | 'INELIGIBLE'>('ELIGIBLE')
  const [checks, setChecks] = useState<Record<string, boolean>>({})
  const [reason, setReason] = useState('')
  const { busy, error, run } = useRun(onDone)
  const allChecked = GST_CHECKS.every((c) => checks[c.key])
  const ok = reason.trim().length >= 10 && (status === 'INELIGIBLE' || allChecked)
  const total = toPaise(invoice.cgst_total) + toPaise(invoice.sgst_total) + toPaise(invoice.igst_total) + toPaise(invoice.cess_total)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Propose the input GST decision of {invoice.invoice_number}</DialogTitle>
          <DialogDescription>{formatAmount(total / 100)} is held in GST input pending verification. Eligible GST moves to the input CGST / SGST / IGST / cess ledgers; ineligible
            GST becomes an expense — but only after another user approves this proposal (maker-checker). A GSTR-2B match is evidence only; record what you checked.</DialogDescription></DialogHeader>
        <div className="space-y-1"><Label htmlFor="pi-gst-status">Result</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as 'ELIGIBLE' | 'INELIGIBLE')}><SelectTrigger id="pi-gst-status"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="ELIGIBLE">Eligible input tax credit</SelectItem><SelectItem value="INELIGIBLE">Ineligible (blocked credit)</SelectItem></SelectContent></Select></div>
        {status === 'ELIGIBLE' && <div className="space-y-2">{GST_CHECKS.map((c) => (
          <label key={c.key} className="flex items-center gap-2 text-sm"><Checkbox checked={!!checks[c.key]} onCheckedChange={(v) => setChecks((x) => ({ ...x, [c.key]: v === true }))} />{c.label}</label>))}</div>}
        <div className="space-y-1"><Label htmlFor="pi-gst-reason">What was checked (at least 10 characters)</Label>
          <Textarea id="pi-gst-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !ok} onClick={() => run(async () => {
            await verifyPurchaseInvoiceGst(invoice.id, status, reason.trim(), status === 'ELIGIBLE' ? checks : {})
            return `ITC decision proposed (${status.toLowerCase()}). Another user with GST verification rights must approve it before it is posted.`
          })}>Propose decision</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PaymentDialog({ invoice, onClose, onDone }: { invoice: PurchaseInvoice; onClose: () => void; onDone: (m: string) => void }) {
  const options = useAsync(() => fetchSupplierPaymentOptions(invoice.supplier_id), [invoice.supplier_id])
  const [paymentId, setPaymentId] = useState('')
  const [amount, setAmount] = useState('')
  const { busy, error, run } = useRun(onDone)
  const usable = (options.data ?? []).filter((p) => toPaise(p.unallocated) > 0)
  const p = usable.find((o) => o.id === paymentId)
  const max = p ? Math.min(toPaise(p.unallocated), toPaise(invoice.outstanding)) : 0
  const ok = p && isPositiveAmount(amount) && toPaise(amount) <= max
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Allocate a supplier payment</DialogTitle>
          <DialogDescription>Outstanding {formatAmount(invoice.outstanding)}. Payments are recorded in the Ledger; this only links them to the invoice.</DialogDescription></DialogHeader>
        {options.loading ? <LoadingState /> : options.error ? <ErrorState message={describeDataError(options.error)} onRetry={options.reload} /> : usable.length === 0
          ? <p className="text-sm text-muted-foreground">No unallocated payments for this supplier. Record the payment in the Ledger first.</p> : (<>
            <div className="space-y-1"><Label htmlFor="pi-pay">Payment</Label>
              <Select value={paymentId} onValueChange={(v) => { setPaymentId(v); const o = usable.find((x) => x.id === v)
                if (o) setAmount((Math.min(toPaise(o.unallocated), toPaise(invoice.outstanding)) / 100).toFixed(2)) }}>
                <SelectTrigger id="pi-pay"><SelectValue placeholder="Select a payment" /></SelectTrigger>
                <SelectContent>{usable.map((o) => <SelectItem key={o.id} value={o.id}>{o.payment_number} · {formatDate(o.payment_date)} · unallocated {formatAmount(o.unallocated)}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-1"><Label htmlFor="pi-pay-amount">Amount</Label>
              <Input id="pi-pay-amount" inputMode="decimal" className="text-right" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {p && <p className="text-xs text-muted-foreground">At most {formatAmount(max / 100)}.</p>}</div>
          </>)}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !ok} onClick={() => run(async () => { await allocateSupplierPayment(invoice.id, paymentId, amount.trim()); return 'Payment allocated.' })}>Allocate</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
