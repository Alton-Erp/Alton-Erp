import { AlertTriangle, CheckCircle2, FileMinus, FilePlus2, HandCoins, Loader2, Pencil, Printer, RefreshCw, Send, Trash2, Wallet } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { RecordDocuments } from '@/features/admin/record-documents'
import { InvoiceStatusBadge, NoteStatusBadge } from '@/features/billing/billing-badges'
import { BILLING_EVENT_LABELS, GST_TYPE_LABELS, SUPPLY_CATEGORY_LABELS, TAX_TREATMENT_LABELS, isAmount, money } from '@/features/billing/billing-model'
import { ApplyAdvanceDialog, InvoicePaymentDialog, NoteDialog } from '@/features/billing/invoice-v2-dialogs'
import { documentTitle } from '@/features/billing/invoicing-v2-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { EventTimeline } from '@/features/production/event-timeline'
import { parseQty } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  fetchAllocations, fetchBillingEvents, fetchBillingSettings, fetchInvoice, fetchInvoiceLines, fetchNotes, invoiceAction, issueInvoice, reverseAllocation,
  updateInvoiceDraft, validateInvoice, type InvoiceHeaderInput,
} from '@/services/billing'
import { postingBlockedReason } from '@/features/billing/dispatch-status-model'
import { InvoiceDispatchPanel } from '@/features/billing/invoice-dispatch-panel'
import { PartialInvoiceDialog } from '@/features/billing/partial-invoice-dialog'
import { partialWarning } from '@/features/sales/pending-invoice-model'
import { fetchInvoiceDispatchStatus, fetchPartialPreview, issueInvoiceV2 } from '@/services/invoicing-v2'
import type { SalesInvoiceLineRow, SalesInvoiceListRow, SupplyCategory } from '@/types/database-billing'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm font-medium whitespace-pre-line">{children}</dd></div>
}

type LineEdit = { quantity?: string; unit_price?: string; discount_percent?: string; discount_amount?: string }

function DraftEditor({ inv, lines, onSaved }: { inv: SalesInvoiceListRow; lines: SalesInvoiceLineRow[]; onSaved: (m: string) => void }) {
  const settings = useAsync(fetchBillingSettings, [])
  const { states } = useGstStates()
  const s = settings.data
  const [h, setH] = useState({
    invoice_date: inv.invoice_date, payment_terms_days: String(inv.payment_terms_days), place_of_supply_state_code: inv.place_of_supply_state_code ?? '',
    supply_category: inv.supply_category as SupplyCategory, special_category_reason: inv.special_category_reason ?? '', notes: inv.notes ?? '', internal_notes: inv.internal_notes ?? '',
  })
  const [edits, setEdits] = useState<Record<string, LineEdit>>({})
  const charge = lines.find((l) => l.line_type === 'CHARGE')
  const [chargeAmount, setChargeAmount] = useState(charge ? String(Number(charge.unit_price ?? 0)) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const val = (l: SalesInvoiceLineRow, k: keyof LineEdit, current: number | null) => edits[l.id]?.[k] ?? (current === null ? '' : String(Number(current)))
  const setLine = (id: string, k: keyof LineEdit, v: string) => setEdits((x) => ({ ...x, [id]: { ...x[id], [k]: v } }))

  const save = async (removeLineId?: string) => {
    setError(null)
    const changed: { line_id: string; quantity?: number; unit_price?: number | null; discount_percent?: number; discount_amount?: number }[] = []
    for (const [id, e] of Object.entries(edits)) {
      const line: { line_id: string; quantity?: number; unit_price?: number | null; discount_percent?: number; discount_amount?: number } = { line_id: id }
      if (e.quantity !== undefined) { const q = parseQty(e.quantity); if (!q) return setError('Quantities must be greater than zero (up to 3 decimals).'); line.quantity = q }
      if (e.unit_price !== undefined) { if (e.unit_price.trim() !== '' && !isAmount(e.unit_price)) return setError('Prices must have at most 2 decimals.'); line.unit_price = e.unit_price.trim() === '' ? null : Number(e.unit_price) }
      if (e.discount_percent !== undefined) { if (e.discount_percent.trim() !== '' && !isAmount(e.discount_percent)) return setError('Discount % must be a number.'); line.discount_percent = Number(e.discount_percent || 0) }
      if (e.discount_amount !== undefined) { if (e.discount_amount.trim() !== '' && !isAmount(e.discount_amount)) return setError('Discount amounts must have at most 2 decimals.'); line.discount_amount = Number(e.discount_amount || 0) }
      changed.push(line)
    }
    if (!/^\d{1,3}$/.test(h.payment_terms_days.trim())) return setError('Payment terms must be 0–365 days.')
    if (chargeAmount.trim() !== '' && !isAmount(chargeAmount)) return setError('The charge must be an amount with at most 2 decimals.')
    const header: InvoiceHeaderInput = {
      invoice_date: h.invoice_date, payment_terms_days: Number(h.payment_terms_days), place_of_supply_state_code: h.place_of_supply_state_code || null,
      supply_category: h.supply_category, special_category_reason: h.special_category_reason.trim() || null, notes: h.notes.trim() || null, internal_notes: h.internal_notes.trim() || null,
    }
    setBusy(true)
    try {
      await updateInvoiceDraft(inv.id, {
        header, lines: changed.length ? changed : null, removeLineIds: removeLineId ? [removeLineId] : null,
        charge: s?.other_charge_enabled ? { amount: Number(chargeAmount || 0) } : null,
      })
      setEdits({})
      onSaved(removeLineId ? 'Line removed from the draft.' : 'Draft saved and recalculated by the server.')
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Card>
      <CardHeader><div><CardTitle>Edit draft</CardTitle><CardDescription>Totals and tax are recalculated by the database after each save. HSN and GST rates come from the Product Master (use "Refresh from masters" after correcting them there).</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1"><Label htmlFor="iv-date">Invoice date</Label><Input id="iv-date" type="date" value={h.invoice_date} onChange={(e) => setH({ ...h, invoice_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="iv-terms">Payment terms (days)</Label><Input id="iv-terms" inputMode="numeric" value={h.payment_terms_days} onChange={(e) => setH({ ...h, payment_terms_days: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="iv-pos">Place of supply</Label>
            <Select value={h.place_of_supply_state_code || 'none'} onValueChange={(v) => setH({ ...h, place_of_supply_state_code: v === 'none' ? '' : v })}>
              <SelectTrigger id="iv-pos"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72"><SelectItem value="none">Not set</SelectItem>{states.map((st) => <SelectItem key={st.code} value={st.code}>{st.code} — {st.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="iv-cat">Supply category</Label>
            <Select value={h.supply_category} onValueChange={(v) => setH({ ...h, supply_category: v as SupplyCategory })}>
              <SelectTrigger id="iv-cat"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(SUPPLY_CATEGORY_LABELS).filter(([k]) => k === 'TAXABLE' || s?.allowed_special_categories.includes(k)).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
            </Select></div>
          {h.supply_category !== 'TAXABLE' && <div className="space-y-1 sm:col-span-2 xl:col-span-4"><Label htmlFor="iv-reason">Basis for this treatment (required)</Label><Input id="iv-reason" maxLength={500} value={h.special_category_reason} onChange={(e) => setH({ ...h, special_category_reason: e.target.value })} /></div>}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="iv-notes">Notes printed on the invoice</Label><Textarea id="iv-notes" rows={2} maxLength={1000} value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="iv-int">Internal notes (not printed)</Label><Textarea id="iv-int" rows={2} maxLength={1000} value={h.internal_notes} onChange={(e) => setH({ ...h, internal_notes: e.target.value })} /></div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">Line</th><th className="pb-2 text-left">Item</th><th className="pb-2 text-right">Quantity</th>
              <th className="pb-2 text-right">Unit price</th>{s?.allow_line_discount && <><th className="pb-2 text-right">Discount %</th><th className="pb-2 text-right">or amount</th></>}<th className="pb-2" /></tr></thead>
            <tbody>{lines.filter((l) => l.line_type === 'PRODUCT').map((l) => (
              <tr key={l.id} className="border-t">
                <td className="py-2">{l.line_no}</td>
                <td className="py-2">{l.sku}<span className="block text-xs text-muted-foreground">{l.description}</span></td>
                <td className="py-2 text-right">{s?.allow_partial_dispatch_invoicing
                  ? <Input aria-label={`Quantity line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={val(l, 'quantity', l.quantity)} onChange={(e) => setLine(l.id, 'quantity', e.target.value)} />
                  : formatQty(l.quantity, l.unit ?? undefined)}</td>
                <td className="py-2 text-right"><Input aria-label={`Unit price line ${l.line_no}`} className="ml-auto h-8 w-28 text-right" inputMode="decimal" value={val(l, 'unit_price', l.unit_price)} onChange={(e) => setLine(l.id, 'unit_price', e.target.value)} /></td>
                {s?.allow_line_discount && <>
                  <td className="py-2 text-right"><Input aria-label={`Discount % line ${l.line_no}`} className="ml-auto h-8 w-20 text-right" inputMode="decimal" value={val(l, 'discount_percent', l.discount_percent)} onChange={(e) => setLine(l.id, 'discount_percent', e.target.value)} /></td>
                  <td className="py-2 text-right"><Input aria-label={`Discount amount line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={val(l, 'discount_amount', l.discount_amount)} onChange={(e) => setLine(l.id, 'discount_amount', e.target.value)} /></td>
                </>}
                <td className="py-2 text-right">{lines.filter((x) => x.line_type === 'PRODUCT').length > 1 && <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${l.line_no}`} disabled={busy} onClick={() => void save(l.id)}><Trash2 /></Button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {s?.other_charge_enabled && (
          <div className="flex flex-wrap items-end gap-2"><div className="space-y-1"><Label htmlFor="iv-charge">{s.other_charge_label} (taxable, SAC {s.other_charge_sac} @ {Number(s.other_charge_gst_rate)}%)</Label>
            <Input id="iv-charge" className="w-40" inputMode="decimal" placeholder="0.00" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} /></div></div>
        )}
        <Button disabled={busy} onClick={() => void save()}>{busy && <Loader2 className="animate-spin" />} Save draft</Button>
      </CardContent>
    </Card>
  )
}

export default function InvoiceDetailPage() {
  const { invoiceId = '' } = useParams()
  const [params] = useSearchParams()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const inv = useAsync(() => fetchInvoice(invoiceId), [invoiceId, refresh])
  const lines = useAsync(() => fetchInvoiceLines(invoiceId), [invoiceId, refresh])
  const issues = useAsync(() => (inv.data && ['DRAFT', 'PENDING_APPROVAL'].includes(inv.data.status) ? validateInvoice(invoiceId) : Promise.resolve([])), [invoiceId, refresh, inv.data?.status])
  const dispatch = useAsync(() => (inv.data && ['DRAFT', 'PENDING_APPROVAL'].includes(inv.data.status) ? fetchInvoiceDispatchStatus(invoiceId) : Promise.resolve(null)),
    [invoiceId, refresh, inv.data?.status])
  const allocations = useAsync(() => (has('payments.read') ? fetchAllocations({ invoiceId }) : Promise.resolve([])), [invoiceId, refresh])
  const notes = useAsync(() => fetchNotes({ invoiceId }), [invoiceId, refresh])
  const events = useAsync(() => fetchBillingEvents({ invoiceId }), [invoiceId, refresh])
  const settings = useAsync(fetchBillingSettings, [])
  const { label: stateLabel } = useGstStates()
  const location = useLocation()
  const navState = location.state as { message?: string; warnings?: string[] } | null
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [confirmIssue, setConfirmIssue] = useState(false)
  // Partial-invoice warning lines (null = not shown).
  const [partial, setPartial] = useState<string[] | null>(null)
  const [dialog, setDialog] = useState<null | 'payment' | 'advance' | 'credit' | 'debit'>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(navState?.message ?? (params.get('created') ? 'Draft invoice created. Review it, complete any missing data and issue it.' : null))
  const [warnings, setWarnings] = useState<string[]>(navState?.warnings ?? [])
  const { key, renew } = useRequestKey()
  const done = (m: string, w: string[] = []) => { setAction(null); setDialog(null); setMessage(m); setWarnings(w); setError(null); setRefresh((n) => n + 1) }

  const i = inv.data
  const crumbs = [{ label: 'Billing & Accounts' }, { label: 'Sales Invoices', to: '/billing/invoices' }, { label: i?.invoice_number ?? 'Draft' }]
  if (inv.loading && !i) return (<><PageHeader title="Invoice" breadcrumbs={crumbs} /><LoadingState variant="cards" rows={4} /></>)
  if (inv.error || !i) return (<><PageHeader title="Invoice" breadcrumbs={crumbs} /><ErrorState message={describeDataError(inv.error)} onRetry={inv.reload} /></>)

  const open = ['DRAFT', 'PENDING_APPROVAL'].includes(i.status)
  const blocking = (issues.data ?? []).filter((x) => x.severity === 'BLOCK')
  const reviews = (issues.data ?? []).filter((x) => x.severity === 'REVIEW')
  const requireApproval = Boolean(settings.data?.require_approval)
  // Single-operator mode (no approval): issuing confirms the review points in the same step.
  const canIssue = has('invoices.issue') && (requireApproval ? i.status === 'PENDING_APPROVAL' && has('invoices.approve') : open)
  const v2 = i.source !== 'DISPATCH'
  const title = documentTitle(i)

  const dispatchBlocked = postingBlockedReason(dispatch.data)
  // Before the usual confirmation: an invoice for less than the remaining order quantity
  // needs an explicit "Continue with Partial Invoice".
  const startIssue = async () => {
    setError(null)
    try {
      const preview = await fetchPartialPreview(i.id)
      const w = partialWarning(preview.lines)
      if (w) setPartial(w)
      else setConfirmIssue(true)
    } catch (e) { setError(describeDataError(e)) }
  }
  const issue = async () => {
    setBusy(true); setError(null)
    try {
      // Re-check dispatches just before posting (the server checks again in the posting transaction).
      const latest = await fetchInvoiceDispatchStatus(i.id)
      const blocked = postingBlockedReason(latest)
      if (blocked) { setError(blocked); setRefresh((n) => n + 1); return }
      const r: Awaited<ReturnType<typeof issueInvoiceV2>> = requireApproval ? { ...(await issueInvoice(i.id, key)), warnings: [] as string[] } : await issueInvoiceV2(i.id, i.is_proforma, key)
      renew()
      const dispatched = (r.dispatched_on_posting ?? []).reduce((s, d) => s + Number(d.dispatched_quantity ?? 0), 0)
      done(`${i.is_proforma ? `Proforma ${i.proforma_number} converted. ` : ''}Invoice ${r.invoice_number} issued (${money(r.grand_total)}).`
        + (dispatched > 0 ? ` ${formatQty(dispatched)} dispatched from reserved stock (stock entries ${(r.dispatched_on_posting ?? []).flatMap((d) => d.transaction_numbers ?? []).join(', ')}).` : '')
        + (r.partial_invoice?.partial ? ' Partial invoice: the remaining order quantity stays pending; Super Admins were notified.' : ''), r.warnings ?? [])
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader title={i.invoice_number ?? (i.is_proforma ? `Proforma ${i.proforma_number ?? ''} — ${i.customer_legal_name}` : `Draft invoice — ${i.customer_legal_name}`)}
        description={`${title.charAt(0)}${title.slice(1).toLowerCase()} · ${i.customer_legal_name}`} breadcrumbs={crumbs}
        actions={<Button variant="outline" asChild><Link to={`/billing/invoices/${i.id}/print`}><Printer /> {i.status === 'ISSUED' || i.status === 'CANCELLED' || i.is_proforma ? 'Print / PDF' : 'Print preview'}</Link></Button>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {warnings.length > 0 && <ul role="status" className="mb-4 list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 py-2.5 pr-4 pl-8 text-sm text-amber-900">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex flex-wrap items-center gap-2">
              <InvoiceStatusBadge status={i.display_status} />
              {i.status === 'ISSUED' && <span className="text-sm text-muted-foreground">Issued {formatDateTime(i.issued_at!)} · FY {i.financial_year}{i.days_overdue ? ` · ${i.days_overdue} day(s) overdue` : ''}</span>}
              {i.status === 'CANCELLED' && <span className="text-sm">Cancelled {formatDateTime(i.cancelled_at!)}: {i.cancellation_reason}</span>}
              {!i.invoice_number && <span className="text-sm text-muted-foreground">The official number is assigned when the invoice is issued.</span>}
              <span className="ml-auto text-xs text-muted-foreground">E-invoice / IRN: not configured (integration pending)</span>
            </div>
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Invoice date / due">{formatDate(i.invoice_date)} / {i.due_date ? formatDate(i.due_date) : '—'} ({i.payment_terms_days} days)</Stat>
              <Stat label="Customer">{i.customer_legal_name} ({i.customer_code_snapshot}){'\n'}{i.customer_gstin ?? (i.customer_registration_type ? GST_TYPE_LABELS[i.customer_registration_type] : 'GST type not set')}</Stat>
              <Stat label="Billing address">{i.customer_billing_address ?? '—'}</Stat>
              <Stat label="Shipping address">{i.customer_shipping_address ?? 'Same as billing'}</Stat>
              <Stat label="Seller">{i.seller_legal_name}{'\n'}{i.seller_gstin ?? 'GSTIN not configured'}</Stat>
              <Stat label="Place of supply">{stateLabel(i.place_of_supply_state_code)}</Stat>
              <Stat label="Tax treatment">{TAX_TREATMENT_LABELS[i.tax_treatment]} · {SUPPLY_CATEGORY_LABELS[i.supply_category]}</Stat>
              <Stat label="Orders / dispatches">{i.sales_order_id ? <Link className="text-primary hover:underline" to={`/sales/orders/${i.sales_order_id}`}>{i.order_references ?? 'Sales order'}</Link> : (i.order_references ?? '—')}{'\n'}{i.dispatch_references ?? ''}</Stat>
              {(i.transport_details || i.vehicle_number || i.eway_bill_number) && <Stat label="Transport">{[i.transport_details, i.vehicle_number && `Vehicle ${i.vehicle_number}`, i.eway_bill_number && `E-way bill ${i.eway_bill_number}`].filter(Boolean).join('\n')}</Stat>}
              {i.customer_pan && <Stat label="Customer PAN">{i.customer_pan}</Stat>}
              <Stat label="Created">{({ DISPATCH: 'From dispatches', SALES_ORDER: 'From a sales order', MANUAL: 'Manual', IMPORT: 'Excel import' } as Record<string, string>)[i.source] ?? i.source}{i.pricing_mode === 'INCLUSIVE' ? ' · prices incl. GST' : ''}</Stat>
            </dl>
            <dl className="grid gap-4 border-t pt-4 sm:grid-cols-3 xl:grid-cols-6">
              <Stat label="Taxable value">{money(i.taxable_subtotal)}</Stat>
              <Stat label="CGST / SGST">{money(i.cgst_total)} / {money(i.sgst_total)}</Stat>
              <Stat label="IGST">{money(i.igst_total)}</Stat>
              <Stat label="Round-off">{money(i.round_off)}</Stat>
              <Stat label="Grand total">{money(i.grand_total)}</Stat>
              {i.status === 'ISSUED' && <Stat label="Balance due">{money(i.balance_due)}{'\n'}<span className="text-xs font-normal text-muted-foreground">paid {money(i.paid)} · credited {money(i.credited)} · debited {money(i.debited)}</span></Stat>}
            </dl>
            <div className="flex flex-wrap gap-2 border-t pt-4">
              {i.status === 'DRAFT' && v2 && has('invoices.create') && <Button variant="outline" asChild><Link to={`/billing/invoices/${i.id}/edit`}><Pencil /> Edit {i.is_proforma ? 'proforma' : 'draft'}</Link></Button>}
              {i.status === 'DRAFT' && !v2 && has('invoices.create') && <Button variant="outline" disabled={busy} onClick={() => setAction({ title: 'Refresh from masters', description: 'Customer, seller and place-of-supply suggestions and line HSN / GST rates are re-read from the masters, and the draft is recalculated. Prices you entered are kept.', confirmLabel: 'Refresh', note: 'none', run: async () => { await invoiceAction(i.id, 'REFRESH', null); return 'Draft refreshed from master data.' } })}><RefreshCw /> Refresh from masters</Button>}
              {i.status === 'DRAFT' && requireApproval && has('invoices.create') && <Button variant="outline" onClick={() => setAction({ title: 'Submit for approval', description: 'An approver (not you) must issue it. Blocking validation problems must be fixed first.', confirmLabel: 'Submit', note: 'none', run: async () => { await invoiceAction(i.id, 'SUBMIT', null); return 'Submitted for approval.' } })}><Send /> Submit for approval</Button>}
              {i.status === 'PENDING_APPROVAL' && (has('invoices.create') || has('invoices.approve')) && <Button variant="outline" onClick={() => setAction({ title: 'Return to draft', description: 'The invoice becomes editable again.', confirmLabel: 'Return to draft', note: 'none', run: async () => { await invoiceAction(i.id, 'RETURN_TO_DRAFT', null); return 'Returned to draft.' } })}>Return to draft</Button>}
              {requireApproval && open && reviews.length > 0 && !i.tax_review_at && has('invoices.approve') && <Button variant="outline" onClick={() => setAction({ title: 'Acknowledge tax review', description: <ul className="list-disc pl-4">{reviews.map((r) => <li key={r.message}>{r.message}</li>)}</ul>, confirmLabel: 'Record review', note: 'required', minLength: 5, noteLabel: 'Review conclusion (required)', run: async (n) => { await invoiceAction(i.id, 'ACK_TAX_REVIEW', n); return 'Tax review recorded.' } })}><CheckCircle2 /> Acknowledge tax review</Button>}
              {canIssue && <Button disabled={busy || blocking.length > 0 || Boolean(dispatchBlocked) || dispatch.loading || (requireApproval && reviews.length > 0 && !i.tax_review_at)}
                title={dispatchBlocked ?? undefined} onClick={() => void startIssue()}>{busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} {requireApproval ? 'Approve and issue' : i.is_proforma ? 'Convert to tax invoice and issue' : 'Issue invoice'}</Button>}
              {open && has('invoices.create') && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: 'Discard draft', description: 'The draft is kept for audit but can no longer be used; its dispatch quantities become invoiceable again. No number was assigned.', confirmLabel: 'Discard', note: 'none', destructive: true, run: async () => { await invoiceAction(i.id, 'DISCARD', null); return 'Draft discarded.' } })}><Trash2 /> Discard</Button>}
              {i.status === 'ISSUED' && has('payments.manage') && Number(i.balance_due) > 0 && <Button variant="outline" onClick={() => setDialog('payment')}><Wallet /> Record payment</Button>}
              {i.status === 'ISSUED' && has('payments.manage') && Number(i.balance_due) > 0 && <Button variant="outline" onClick={() => setDialog('advance')}><HandCoins /> Apply advance</Button>}
              {i.status === 'ISSUED' && has('invoice_adjustments.issue') && !requireApproval && <>
                <Button variant="outline" onClick={() => setDialog('credit')}><FileMinus /> Credit note</Button>
                <Button variant="outline" onClick={() => setDialog('debit')}><FilePlus2 /> Debit note</Button></>}
              {i.status === 'ISSUED' && has('invoice_adjustments.create') && requireApproval && <Button variant="outline" asChild><Link to={`/billing/credit-notes?invoice=${i.id}`}><FileMinus /> Credit / debit note</Link></Button>}
              {i.status === 'ISSUED' && has('invoices.cancel') && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: `Cancel ${i.invoice_number}`, description: 'Allowed only when no payment is allocated and no credit/debit note exists. The number is never reused; dispatches and stock are not reversed (the dispatched quantity becomes invoiceable again).', confirmLabel: 'Cancel invoice', note: 'required', minLength: 5, destructive: true, run: async (n) => { await invoiceAction(i.id, 'CANCEL', n); return `Invoice ${i.invoice_number} cancelled.` } })}>Cancel invoice</Button>}
            </div>
          </CardContent>
        </Card>

        {open && <InvoiceDispatchPanel status={dispatch.data} loading={dispatch.loading} error={dispatch.error ? describeDataError(dispatch.error) : null} onRefresh={dispatch.reload} />}

        {open && (issues.data ?? []).length > 0 && (
          <Card>
            <CardHeader><div><CardTitle className="flex items-center gap-2"><AlertTriangle className="size-4" /> Validation</CardTitle><CardDescription>Checked by the server. Blocking items must be corrected; {requireApproval ? 'review items need an authorised acknowledgement before issue.' : 'review items are warnings — issuing records that you checked them.'}</CardDescription></div></CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {blocking.map((x) => <li key={x.message} className="flex gap-2 text-red-800"><span className="font-medium">Blocking:</span> {x.message}</li>)}
                {reviews.map((x) => <li key={x.message} className="flex gap-2 text-amber-800"><span className="font-medium">Review:</span> {x.message}</li>)}
              </ul>
              {i.tax_review_at && <p className="mt-2 text-sm text-green-800">Tax review recorded {formatDateTime(i.tax_review_at)}: {i.tax_review_note}</p>}
            </CardContent>
          </Card>
        )}

        {i.status === 'DRAFT' && !v2 && has('invoices.create') && lines.data && <DraftEditor key={`${i.id}-${i.updated_at}`} inv={i} lines={lines.data} onSaved={done} />}

        <Card>
          <CardHeader><div><CardTitle>Lines</CardTitle><CardDescription>Amounts as calculated by the database{i.status === 'ISSUED' ? ' and frozen at issue' : ''}.</CardDescription></div></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="text-xs text-muted-foreground"><tr>
                <th className="pb-2 text-left">#</th><th className="pb-2 text-left">Item</th><th className="pb-2 text-left">HSN/SAC</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Rate</th>
                <th className="pb-2 text-right">Discount</th><th className="pb-2 text-right">Taxable</th><th className="pb-2 text-right">GST %</th><th className="pb-2 text-right">CGST</th><th className="pb-2 text-right">SGST</th><th className="pb-2 text-right">IGST</th><th className="pb-2 text-right">Total</th>
              </tr></thead>
              <tbody>{(lines.data ?? []).map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-2">{l.line_no}</td>
                  <td className="py-2">{l.sku ?? ''}<span className="block text-xs text-muted-foreground">{l.description}</span></td>
                  <td className="py-2">{l.hsn_sac ?? <span className="text-shortage">missing</span>}</td>
                  <td className="py-2 text-right">{formatQty(l.quantity, l.unit ?? undefined)}</td>
                  <td className="py-2 text-right">{l.unit_price === null ? <span className="text-shortage">missing</span> : money(l.unit_price, false)}</td>
                  <td className="py-2 text-right">{Number(l.discount_amount) ? money(l.discount_amount, false) : '—'}</td>
                  <td className="py-2 text-right">{money(l.taxable_value, false)}</td>
                  <td className="py-2 text-right">{l.gst_rate === null ? <span className="text-shortage">missing</span> : `${Number(l.gst_rate)}%`}</td>
                  <td className="py-2 text-right">{money(l.cgst_amount, false)}</td>
                  <td className="py-2 text-right">{money(l.sgst_amount, false)}</td>
                  <td className="py-2 text-right">{money(l.igst_amount, false)}</td>
                  <td className="py-2 text-right font-medium">{money(l.line_total, false)}</td>
                </tr>
              ))}</tbody>
            </table>
          </CardContent>
        </Card>

        {(allocations.data ?? []).length > 0 && (
          <Card>
            <CardHeader><div><CardTitle>Payments allocated</CardTitle><CardDescription>Recorded receipts are not bank-verified. Reversals keep the history.</CardDescription></div></CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">{(allocations.data ?? []).map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-medium">{a.receipt_number}</span><span>{formatDate(a.receipt_date)}</span><span>{money(a.allocated_amount)}</span>
                  {a.status === 'REVERSED' ? <span className="text-xs text-muted-foreground">Reversed: {a.reversal_reason}</span>
                    : has('payments.reverse') && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setAction({ title: `Reverse allocation of ${money(a.allocated_amount)}`, description: 'The amount returns to the receipt as unallocated and the invoice balance increases. The allocation stays in history.', confirmLabel: 'Reverse allocation', note: 'required', minLength: 5, destructive: true, run: async (n) => { await reverseAllocation(a.id, n!); return 'Allocation reversed.' } })}>Reverse</Button>}
                </li>
              ))}</ul>
            </CardContent>
          </Card>
        )}

        {(notes.data ?? []).length > 0 && (
          <Card>
            <CardHeader><div><CardTitle>Credit and debit notes</CardTitle></div></CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">{(notes.data ?? []).map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-3 py-2"><Link className="font-medium text-primary hover:underline" to={`/billing/notes/${n.id}`}>{n.note_number ?? `Draft ${n.note_type.toLowerCase()} note`}</Link>
                  <NoteStatusBadge status={n.status} /><span>{n.note_type === 'CREDIT' ? '−' : '+'}{money(n.total_amount)}</span><span className="text-muted-foreground">{n.reason}</span></li>
              ))}</ul>
            </CardContent>
          </Card>
        )}

        <RecordDocuments entityType="INVOICE" entityId={i.id} title="Attachments (payment proof, signed copy…)" />

        <Card>
          <CardHeader><div><CardTitle>History</CardTitle><CardDescription>Every draft change, review, issue, payment allocation, note and cancellation (append-only).</CardDescription></div></CardHeader>
          <CardContent><EventTimeline events={events.data ?? []} loading={events.loading} labels={BILLING_EVENT_LABELS} /></CardContent>
        </Card>
      </div>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      {dialog === 'payment' && <InvoicePaymentDialog inv={i} settings={settings.data ?? null} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'advance' && <ApplyAdvanceDialog inv={i} onClose={() => setDialog(null)} onDone={done} />}
      {(dialog === 'credit' || dialog === 'debit') && lines.data && (
        <NoteDialog inv={i} lines={lines.data} type={dialog === 'credit' ? 'CREDIT' : 'DEBIT'} onClose={() => setDialog(null)} onDone={(m) => done(m)} />
      )}
      <ConfirmDialog open={confirmIssue} onOpenChange={setConfirmIssue} title={i.is_proforma ? 'Convert the proforma and issue it?' : 'Issue this invoice?'} confirmLabel={i.is_proforma ? 'Convert and issue' : 'Issue invoice'}
        description={`The server re-checks quantities (dispatch or sales order) and tax data${reviews.length ? ', records that you confirmed the review points listed above' : ''}, assigns the next official number and freezes the invoice (${money(i.grand_total)}). Issued invoices cannot be edited or deleted; corrections need a credit/debit note or cancellation.`}
        onConfirm={() => { setConfirmIssue(false); void issue() }} />
      <PartialInvoiceDialog warnings={partial} onBack={() => setPartial(null)} onContinue={() => { setPartial(null); setConfirmIssue(true) }} />
    </>
  )
}
