import { AlertTriangle, CheckCircle2, Loader2, Printer, Send, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { NoteStatusBadge } from '@/features/billing/billing-badges'
import { BILLING_EVENT_LABELS, NOTE_REASON_LABELS, TAX_TREATMENT_LABELS, money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { EventTimeline } from '@/features/production/event-timeline'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchBillingEvents, fetchBillingSettings, fetchNote, fetchNoteLines, issueNote, noteAction, validateNote } from '@/services/billing'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm font-medium whitespace-pre-line">{children}</dd></div>
}

export default function NoteDetailPage() {
  const { noteId = '' } = useParams()
  const [params] = useSearchParams()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const note = useAsync(() => fetchNote(noteId), [noteId, refresh])
  const lines = useAsync(() => fetchNoteLines(noteId), [noteId, refresh])
  const issues = useAsync(() => (note.data && ['DRAFT', 'PENDING_APPROVAL'].includes(note.data.status) ? validateNote(noteId) : Promise.resolve([])), [noteId, refresh, note.data?.status])
  const events = useAsync(() => fetchBillingEvents({ entityId: noteId }), [noteId, refresh])
  const settings = useAsync(fetchBillingSettings, [])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [confirmIssue, setConfirmIssue] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(params.get('created') ? 'Draft note created. Review it and issue it when ready.' : null)
  const { key, renew } = useRequestKey()
  const done = (m: string) => { setAction(null); setMessage(m); setError(null); setRefresh((x) => x + 1) }

  const n = note.data
  const typeLabel = n?.note_type === 'DEBIT' ? 'Debit note' : 'Credit note'
  const crumbs = [{ label: 'Billing & Accounts' }, { label: n?.note_type === 'DEBIT' ? 'Debit Notes' : 'Credit Notes', to: n?.note_type === 'DEBIT' ? '/billing/debit-notes' : '/billing/credit-notes' }, { label: n?.note_number ?? 'Draft' }]
  if (note.loading && !n) return (<><PageHeader title="Note" breadcrumbs={crumbs} /><LoadingState variant="cards" rows={3} /></>)
  if (note.error || !n) return (<><PageHeader title="Note" breadcrumbs={crumbs} /><ErrorState message={describeDataError(note.error)} onRetry={note.reload} /></>)

  const open = ['DRAFT', 'PENDING_APPROVAL'].includes(n.status)
  const blocking = (issues.data ?? []).filter((x) => x.severity === 'BLOCK')
  const reviews = (issues.data ?? []).filter((x) => x.severity === 'REVIEW')
  const requireApproval = Boolean(settings.data?.require_approval)
  const canIssue = has('invoice_adjustments.issue') && (requireApproval ? n.status === 'PENDING_APPROVAL' && has('invoices.approve') : open)
  const sign = n.note_type === 'CREDIT' ? '−' : '+'

  const issue = async () => {
    setBusy(true); setError(null)
    try { const r = await issueNote(n.id, key); renew(); done(`${typeLabel} ${r.note_number} issued (${money(r.total)}).`) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader title={n.note_number ?? `Draft ${typeLabel.toLowerCase()}`} description={`${typeLabel} against ${n.invoice_number} · ${n.customer_name}`} breadcrumbs={crumbs}
        actions={<Button variant="outline" asChild><Link to={`/billing/notes/${n.id}/print`}><Printer /> Print / PDF</Link></Button>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <NoteStatusBadge status={n.status} />
              {n.status === 'ISSUED' && <span className="text-sm text-muted-foreground">Issued {formatDateTime(n.issued_at!)} · FY {n.financial_year}</span>}
              {n.status === 'CANCELLED' && <span className="text-sm">Cancelled {formatDateTime(n.cancelled_at!)}: {n.cancellation_reason}</span>}
              {!n.note_number && <span className="text-sm text-muted-foreground">The official number is assigned when the note is issued.</span>}
            </div>
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Note date">{formatDate(n.note_date)}</Stat>
              <Stat label="Original invoice"><Link className="text-primary hover:underline" to={`/billing/invoices/${n.original_invoice_id}`}>{n.invoice_number}</Link> ({formatDate(n.invoice_date)}, {money(n.invoice_total)})</Stat>
              <Stat label="Reason">{NOTE_REASON_LABELS[n.reason_code]}{'\n'}<span className="font-normal">{n.reason}</span></Stat>
              <Stat label="Reference / return">{n.supporting_reference ?? '—'}{n.return_number ? `\nReturn ${n.return_number}` : ''}</Stat>
              <Stat label="Tax treatment">{TAX_TREATMENT_LABELS[n.tax_treatment]} (from the invoice)</Stat>
              <Stat label="Taxable">{sign}{money(n.taxable_amount)}</Stat>
              <Stat label="CGST / SGST / IGST">{money(n.cgst_amount)} / {money(n.sgst_amount)} / {money(n.igst_amount)}</Stat>
              <Stat label="Total">{sign}{money(n.total_amount)}</Stat>
            </dl>
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {n.status === 'DRAFT' && requireApproval && has('invoice_adjustments.create') && <Button variant="outline" onClick={() => setAction({ title: 'Submit for approval', description: 'An approver (not you) must issue it.', confirmLabel: 'Submit', note: 'none', run: async () => { await noteAction(n.id, 'SUBMIT', null); return 'Submitted for approval.' } })}><Send /> Submit for approval</Button>}
              {n.status === 'PENDING_APPROVAL' && (has('invoice_adjustments.create') || has('invoices.approve')) && <Button variant="outline" onClick={() => setAction({ title: 'Return to draft', description: 'The note goes back to draft.', confirmLabel: 'Return to draft', note: 'none', run: async () => { await noteAction(n.id, 'RETURN_TO_DRAFT', null); return 'Returned to draft.' } })}>Return to draft</Button>}
              {open && reviews.length > 0 && !n.tax_review_at && has('invoices.approve') && <Button variant="outline" onClick={() => setAction({ title: 'Acknowledge tax review', description: <ul className="list-disc pl-4">{reviews.map((r) => <li key={r.message}>{r.message}</li>)}</ul>, confirmLabel: 'Record review', note: 'required', minLength: 5, noteLabel: 'Review conclusion (required)', run: async (t) => { await noteAction(n.id, 'ACK_TAX_REVIEW', t); return 'Tax review recorded.' } })}><CheckCircle2 /> Acknowledge tax review</Button>}
              {canIssue && <Button disabled={busy || blocking.length > 0 || (reviews.length > 0 && !n.tax_review_at)} onClick={() => setConfirmIssue(true)}>{busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {requireApproval ? 'Approve and issue' : 'Issue note'}</Button>}
              {open && has('invoice_adjustments.create') && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: 'Discard draft note', description: 'The draft is kept for audit but can no longer be issued. No number was assigned.', confirmLabel: 'Discard', note: 'none', destructive: true, run: async () => { await noteAction(n.id, 'DISCARD', null); return 'Draft note discarded.' } })}><Trash2 /> Discard</Button>}
              {n.status === 'ISSUED' && has('invoice_adjustments.issue') && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: `Cancel ${n.note_number}`, description: `The note stops affecting the invoice balance. Its number is never reused.${n.note_type === 'DEBIT' ? ' Refused if payments already allocated would then exceed the invoice.' : ''}`, confirmLabel: 'Cancel note', note: 'required', minLength: 5, destructive: true, run: async (t) => { await noteAction(n.id, 'CANCEL', t); return `${typeLabel} ${n.note_number} cancelled.` } })}>Cancel note</Button>}
            </div>
          </CardContent>
        </Card>

        {open && (issues.data ?? []).length > 0 && (
          <Card>
            <CardHeader><div><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4" /> Validation</CardTitle><CardDescription>Checked by the server.</CardDescription></div></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {blocking.map((x) => <li key={x.message} className="text-red-800"><span className="font-medium">Blocking:</span> {x.message}</li>)}
                {reviews.map((x) => <li key={x.message} className="text-amber-800"><span className="font-medium">Review:</span> {x.message}</li>)}
              </ul>
              {n.tax_review_at && <p className="mt-2 text-sm text-green-800">Tax review recorded {formatDateTime(n.tax_review_at)}: {n.tax_review_note}</p>}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><div><CardTitle>Lines</CardTitle><CardDescription>Tax calculated by the database with the original invoice line rates.</CardDescription></div></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">#</th><th className="pb-2 text-left">Item</th><th className="pb-2 text-left">HSN/SAC</th><th className="pb-2 text-right">Qty</th>
                <th className="pb-2 text-right">Taxable</th><th className="pb-2 text-right">GST %</th><th className="pb-2 text-right">CGST</th><th className="pb-2 text-right">SGST</th><th className="pb-2 text-right">IGST</th><th className="pb-2 text-right">Total</th></tr></thead>
              <tbody>{(lines.data ?? []).map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-2">{l.line_no}</td><td className="py-2">{l.description}</td><td className="py-2">{l.hsn_sac ?? '—'}</td>
                  <td className="py-2 text-right">{l.quantity === null ? 'value only' : formatQty(l.quantity)}</td>
                  <td className="py-2 text-right">{money(l.taxable_amount, false)}</td><td className="py-2 text-right">{l.gst_rate === null ? '—' : `${Number(l.gst_rate)}%`}</td>
                  <td className="py-2 text-right">{money(l.cgst_amount, false)}</td><td className="py-2 text-right">{money(l.sgst_amount, false)}</td><td className="py-2 text-right">{money(l.igst_amount, false)}</td>
                  <td className="py-2 text-right font-medium">{money(l.line_total, false)}</td>
                </tr>
              ))}</tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>History</CardTitle></div></CardHeader>
          <CardContent><EventTimeline events={events.data ?? []} loading={events.loading} labels={BILLING_EVENT_LABELS} /></CardContent>
        </Card>
      </div>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      <ConfirmDialog open={confirmIssue} onOpenChange={setConfirmIssue} title={`Issue this ${typeLabel.toLowerCase()}?`} confirmLabel="Issue note"
        description={`The server re-checks the limits against the invoice, assigns the next ${typeLabel.toLowerCase()} number and freezes the note (${sign}${money(n.total_amount)} on ${n.invoice_number}). Issued notes cannot be edited.`}
        onConfirm={() => { setConfirmIssue(false); void issue() }} />
    </>
  )
}
