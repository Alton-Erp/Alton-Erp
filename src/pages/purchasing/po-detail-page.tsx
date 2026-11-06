import { AlertTriangle, Ban, CalendarClock, Check, Copy, FileX2, Info, Loader2, PackagePlus, Pencil, Printer, RotateCcw, Send, Undo2, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { RecordDocuments } from '@/features/admin/record-documents'
import { money } from '@/features/billing/billing-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { formatQty } from '@/features/inventory/inventory-model'
import { CostTrend } from '@/features/products/purchase-cost-badge'
import { costChange, type ProductPurchaseCost } from '@/features/products/purchase-cost'
import { PoActionDialog, PoStatusBadge } from '@/features/purchasing/po-components'
import { availablePoActions, LINE_TYPE_LABELS, PO_EVENT_LABELS, PO_STATUS_LABELS, PURCHASE_TYPE_LABELS, refsText, TAX_TREATMENT_LABELS } from '@/features/purchasing/po-model'
import { GoodsReceiptDialog } from '@/features/purchasing/receipt-dialog'
import { SupplierRefs } from '@/features/purchasing/supplier-refs'
import { paymentTermsLabel } from '@/features/suppliers/supplier-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchInventoryPolicy } from '@/services/inventory'
import { fetchPurchaseCosts } from '@/services/purchase-costs'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImagesById } from '@/features/products/product-image-hooks'
import { fetchDisplayNames } from '@/services/products'
import {
  fetchGoodsReceipts, fetchPoAmendments, fetchPoEvents, fetchPoLines, fetchPurchaseOrder, fetchReceiptLines, openPurchaseOrder, purchaseOrderAction, reverseGoodsReceipt,
  updatePoDetails, validatePurchaseOrder, type PoWorkflowAction,
} from '@/services/purchasing'
import type { GoodsReceiptListRow, PoStatus, PurchaseOrderListRow } from '@/types/database-purchasing'

async function loadPo(id: string, canSeeInventory: boolean) {
  const [po, lines, receipts, receiptLines, events, amendments] = await Promise.all([
    fetchPurchaseOrder(id), fetchPoLines(id), fetchGoodsReceipts({ poId: id }), fetchReceiptLines(id), fetchPoEvents(id), fetchPoAmendments(id),
  ])
  const issues = po.status === 'DRAFT' ? await validatePurchaseOrder(id).catch(() => []) : []
  const sod = canSeeInventory ? await fetchInventoryPolicy().then((p) => p.segregation_of_duties).catch(() => false) : false
  const names = await fetchDisplayNames([po.created_by, po.submitted_by, po.approved_by, po.rejected_by, po.sent_by, po.cancelled_by, po.closed_by,
    ...events.map((e) => e.actor_user_id), ...receipts.map((r) => r.created_by), ...amendments.map((a) => a.created_by)])
  return { po, lines, receipts, receiptLines, events, amendments, issues, sod, names }
}

export default function PoDetailPage() {
  const { poId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { access } = useAuth()
  const { has, hasAny } = usePermissions()
  const tz = access?.company?.timezone
  const [refresh, setRefresh] = useState(0)
  const data = useAsync(() => loadPo(poId, has('inventory.read')), [poId, refresh])
  // Proposed price comparison only (an order never changes the Last Purchase Cost; posted receipts do).
  // Product thumbnails beside the line items (display only).
  const lineImages = useProductImagesById((data.data?.lines ?? []).map((l) => l.product_id))
  const costKey = (data.data?.lines ?? []).filter((l) => l.line_type === 'GOODS' && l.product_id).map((l) => l.product_id).join(',')
  const lastCosts = useAsync(() => (costKey ? fetchPurchaseCosts(costKey.split(','), data.data?.po.supplier_id ?? null).catch(() => new Map<string, ProductPurchaseCost>())
    : Promise.resolve(new Map<string, ProductPurchaseCost>())), [costKey])
  const initial = location.state as { message?: string; tone?: 'error' } | null
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(initial?.message ? { tone: initial.tone ?? 'success', text: initial.message } : null)
  const [action, setAction] = useState<PoWorkflowAction | null>(null)
  const [searchParams] = useSearchParams()
  const [receiving, setReceiving] = useState(() => searchParams.get('receive') === '1')
  const [opening, setOpening] = useState(false)
  const [reversing, setReversing] = useState<GoodsReceiptListRow | null>(null)
  const [correcting, setCorrecting] = useState<GoodsReceiptListRow | null>(null)
  const [editingDetails, setEditingDetails] = useState(false)
  const { label: stateLabel } = useGstStates()
  const crumbs = (last: string) => [{ label: 'Orders' }, { label: 'Supplier Purchase Orders', to: '/purchase-orders' }, { label: last }]

  if (data.loading && !data.data) return <LoadingState label="Loading purchase order…" />
  if (data.error || !data.data) {
    return (
      <>
        <PageHeader title="Purchase order" breadcrumbs={crumbs('Purchase order')} />
        <Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card>
      </>
    )
  }
  const { po, lines, receipts, receiptLines, events, amendments, issues, sod, names } = data.data
  const name = (id: string | null) => (id ? (names.get(id) ?? 'User') : '—')
  const actions = availablePoActions(po, has, access?.profile?.id, { hasReceipts: po.receipt_count > 0, segregationOfDuties: sod })
  const selfBlocked = po.status === 'PENDING_APPROVAL' && has('purchase_order.approve') && !actions.includes('APPROVE')
  const done = (text: string) => { setNotice({ tone: 'success', text }); setRefresh((n) => n + 1) }
  const openOrder = async () => {
    setOpening(true)
    try {
      await openPurchaseOrder(po.id, po.updated_at)
      done(`${po.po_number} is open. You can now record goods receipts against it.`)
    } catch (err) {
      setNotice({ tone: 'error', text: describeDataError(err) })
    } finally {
      setOpening(false)
    }
  }
  const goods = lines.filter((l) => l.line_type !== 'CHARGE')
  const sum = (f: (l: (typeof lines)[number]) => number) => goods.reduce((s, l) => s + Number(f(l)), 0)
  const intra = po.tax_treatment === 'INTRA_STATE'
  const canEditDetails = !['CANCELLED', 'CLOSED'].includes(po.status) && (has('purchase_order.update') || has('purchase_order.amend'))
  const canFixReceipts = has('purchase_exception.approve') && !['CLOSED', 'CANCELLED'].includes(po.status)
  const btn = (a: PoWorkflowAction, label: string, icon: ReactNode, variant: 'default' | 'outline' = 'outline') =>
    <Button key={a} variant={variant} onClick={() => setAction(a)}>{icon} {label}</Button>

  return (
    <>
      <PageHeader
        title={`${po.po_number}${po.revision ? ` · rev ${po.revision}` : ''}`}
        description={`${po.supplier_name} · ${PURCHASE_TYPE_LABELS[po.purchase_type]} · ${money(po.grand_total)}`}
        breadcrumbs={crumbs(po.po_number)}
        actions={
          <>
            {actions.includes('EDIT') && <Button variant="outline" asChild><Link to={`/purchase-orders/${po.id}/edit`}><Pencil /> Edit draft</Link></Button>}
            {actions.includes('OPEN') && (
              <Button disabled={opening} onClick={() => void openOrder()}>{opening ? <Loader2 className="animate-spin" /> : <Check />} Open order</Button>
            )}
            {actions.includes('SUBMIT') && btn('SUBMIT', 'Submit for approval', <Send />, 'default')}
            {actions.includes('WITHDRAW') && btn('WITHDRAW', 'Withdraw', <Undo2 />)}
            {actions.includes('REJECT') && btn('REJECT', 'Reject', <X />)}
            {actions.includes('APPROVE') && btn('APPROVE', 'Approve', <Check />, 'default')}
            {actions.includes('SEND') && btn('SEND', 'Mark as sent', <Send />)}
            {actions.includes('RECEIVE') && <Button onClick={() => setReceiving(true)}><PackagePlus /> Record goods receipt</Button>}
            {canEditDetails && <Button variant="outline" onClick={() => setEditingDetails(true)}><CalendarClock /> Delivery date / notes</Button>}
            {actions.includes('AMEND') && btn('AMEND', 'Edit order (new revision)', <Pencil />)}
            {actions.includes('PRINT') && <Button variant="outline" asChild><Link to={`/purchase-orders/${po.id}/print`}><Printer /> Print / PDF</Link></Button>}
            {has('purchase_order.create') && <Button variant="outline" asChild><Link to={`/purchase-orders/new?copy=${po.id}`}><Copy /> Duplicate</Link></Button>}
            {actions.includes('CLOSE') && btn('CLOSE', 'Short-close', <FileX2 />)}
            {actions.includes('CANCEL') && btn('CANCEL', 'Cancel order', <Ban />)}
          </>
        }
      />

      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={cn('mb-4 flex items-start justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm', notice.tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-green-200 bg-green-50 text-green-800')}>
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss message" className="rounded p-0.5 opacity-70 hover:opacity-100" onClick={() => setNotice(null)}><X className="size-4" /></button>
        </div>
      )}
      {po.status === 'DRAFT' && po.rejection_reason && <Banner tone="warning">Rejected by {name(po.rejected_by)} on {formatDateTime(po.rejected_at!, tz)}: {po.rejection_reason}</Banner>}
      {po.status === 'DRAFT' && po.revision > 0 && <Banner tone="info">Amendment in progress (revision {po.revision}). The order must be approved again before more goods can be received.</Banner>}
      {po.status === 'DRAFT' && issues.length > 0 && (
        <Banner tone="warning">
          <span className="font-medium">Fix before submitting:</span>
          <ul className="mt-1 list-disc pl-5">{issues.map((i) => <li key={i.code + (i.line_no ?? '')}>{i.message}</li>)}</ul>
        </Banner>
      )}
      {selfBlocked && <Banner tone="info">Segregation of duties: you created or submitted this order, so another authorised user must approve it.</Banner>}
      {po.status === 'CANCELLED' && <Banner tone="danger">Cancelled by {name(po.cancelled_by)} on {formatDateTime(po.cancelled_at!, tz)}: {po.cancel_reason}</Banner>}
      {po.status === 'CLOSED' && <Banner tone="info">Short-closed by {name(po.closed_by)} on {formatDateTime(po.closed_at!, tz)}: {po.close_reason}</Banner>}
      {po.payment_terms_overridden && ['DRAFT', 'PENDING_APPROVAL'].includes(po.status) && <Banner tone="info">Payment terms differ from the supplier's standard terms.</Banner>}

      <div className="grid gap-6 xl:grid-cols-3">
        <Info2 title="Supplier">
          <Item label="Supplier">{po.supplier_code} — {po.supplier_name}</Item>
          <Item label="GSTIN">{po.supplier_gstin ?? 'Not registered'}</Item>
          <Item label="State">{po.supplier_state_code ? stateLabel(po.supplier_state_code) : '—'}{po.supplier_country !== 'India' ? ` · ${po.supplier_country}` : ''}</Item>
          <Item label="Contact">{[po.supplier_contact_person, po.supplier_phone, po.supplier_email].filter(Boolean).join(' · ') || '—'}</Item>
          <Item label="Billing address" full><span className="whitespace-pre-line">{po.supplier_billing_address ?? '—'}</span></Item>
          <Item label="Dispatch address" full><span className="whitespace-pre-line">{po.supplier_shipping_address ?? (po.supplier_billing_address ? 'Same as billing' : '—')}</span></Item>
        </Info2>
        <Info2 title="Order">
          <Item label="Status"><PoStatusBadge status={po.status} /></Item>
          <Item label="PO date">{formatDate(po.po_date)}</Item>
          <Item label="Expected delivery">{po.expected_delivery_date ? formatDate(po.expected_delivery_date) : '—'}</Item>
          <Item label="Deliver to">{po.warehouse_code ? `${po.warehouse_code} — ${po.warehouse_name}` : '—'}</Item>
          <Item label="Payment terms">{paymentTermsLabel(po.payment_terms, po.custom_payment_days)}{po.payment_terms_overridden ? ' (overridden)' : ''}</Item>
          <Item label="Reference">{po.reference_number ?? '—'}</Item>
          <Item label="Supplier invoice / challan (order level)" full>
            <SupplierRefs target={{ poId: po.id }} documentLabel={po.po_number} invoice={po.supplier_invoice_number} challan={po.supplier_challan_number}
              canEdit={hasAny(['purchase_order.create', 'purchase_order.update', 'purchase_order.amend', 'purchase_receipt.create'])} onSaved={done} />
            {(po.receipt_invoice_numbers || po.receipt_challan_numbers) && (
              <span className="mt-1 block text-xs text-muted-foreground">On goods receipts: {refsText(po.receipt_invoice_numbers, po.receipt_challan_numbers)}</span>
            )}
          </Item>
          <Item label="Created">{formatDateTime(po.created_at, tz)} by {name(po.created_by)}</Item>
          <Item label="Opened">{po.approved_at ? `${formatDateTime(po.approved_at, tz)} by ${name(po.approved_by)}` : 'Still a draft'}</Item>
          {po.sent_at && <Item label="Sent to supplier" full>{formatDateTime(po.sent_at, tz)} by {name(po.sent_by)}</Item>}
        </Info2>
        <Card>
          <CardHeader><div><CardTitle>Totals</CardTitle><CardDescription>{TAX_TREATMENT_LABELS[po.tax_treatment]}</CardDescription></div></CardHeader>
          <CardContent><dl className="space-y-1 text-sm">
            {([['Subtotal', po.gross_total], ['Discount', -Number(po.discount_total)], ['Taxable amount', po.taxable_total], ['of which other charges', po.other_charges_total],
              ['CGST', po.cgst_total], ['SGST', po.sgst_total], ['IGST', po.igst_total], ['Round-off', po.round_off]] as [string, number][]).map(([k, v]) => (
              <div key={k} className={cn('flex justify-between gap-4', k.startsWith('of which') && 'pl-3 text-xs text-muted-foreground')}><dt>{k}</dt><dd className="tabular-nums">{money(v)}</dd></div>
            ))}
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold"><dt>Grand total</dt><dd className="tabular-nums">{money(po.grand_total)}</dd></div>
          </dl></CardContent>
        </Card>
      </div>

      <div className="my-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {([['Total ordered', formatQty(sum((l) => l.ordered_quantity))], ['Total received', formatQty(sum((l) => l.received_quantity))],
          ['Accepted', formatQty(sum((l) => l.accepted_quantity))], ['Pending receipt', formatQty(sum((l) => l.pending_quantity))],
          ['Pending value (incl. GST)', ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(po.status) ? money(po.pending_value) : '—']] as [string, string][]).map(([k, v]) => (
          <Card key={k} className="gap-1 p-4"><p className="text-xs font-medium text-muted-foreground">{k}</p><p className="text-lg font-semibold tabular-nums">{v}</p></Card>
        ))}
      </div>

      <Card className="mb-6 overflow-hidden">
        <CardHeader><div><CardTitle>Line items</CardTitle><CardDescription>Prices, tax rates and product details as ordered (snapshots). Received quantities come from posted goods receipts.</CardDescription></div></CardHeader>
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead>#</TableHead><TableHead>Item</TableHead><TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Received</TableHead>
            <TableHead className="text-right">Pending</TableHead><TableHead className="text-right">Unit price</TableHead><TableHead className="text-right">Discount</TableHead>
            <TableHead className="text-right">Taxable</TableHead>
            {intra ? <><TableHead className="text-right">CGST</TableHead><TableHead className="text-right">SGST</TableHead></> : <TableHead className="text-right">IGST</TableHead>}
            <TableHead className="text-right">Total</TableHead>
          </TableRow></TableHeader>
          <TableBody>{lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>{l.line_no}</TableCell>
              <TableCell className="min-w-56 whitespace-normal">
                <div className="flex items-start gap-2">
                {l.product_id && <ProductThumb size="xs" src={lineImages.get(l.product_id)} alt={l.description} />}
                <div className="min-w-0">
                <p className="font-medium">{l.sku ? `${l.sku} — ` : ''}{l.description}</p>
                <p className="text-xs text-muted-foreground">{LINE_TYPE_LABELS[l.line_type]}{l.hsn_sac ? ` · HSN/SAC ${l.hsn_sac}` : ''} · GST {l.gst_rate === null ? 'not set' : `${Number(l.gst_rate)}%`}</p>
                </div>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatQty(l.ordered_quantity, l.unit)}</TableCell>
              <TableCell className="text-right tabular-nums">{l.line_type === 'CHARGE' ? '—' : <>{formatQty(l.accepted_quantity)}{Number(l.rejected_quantity) > 0 && <span className="block text-xs text-red-700">{formatQty(l.rejected_quantity)} rejected</span>}</>}</TableCell>
              <TableCell className="text-right tabular-nums">{l.line_type === 'CHARGE' ? '—' : formatQty(l.pending_quantity)}</TableCell>
              <TableCell className="text-right tabular-nums">{l.unit_price === null ? <span className="text-amber-800">Not set</span> : money(l.unit_price)}
                {l.line_type === 'GOODS' && l.product_id && Number(l.ordered_quantity) > 0 && (() => {
                  const last = lastCosts.data?.get(l.product_id)?.last_cost ?? null
                  if (last === null) return null
                  const c = costChange(last, Math.round((Number(l.taxable_value) / Number(l.ordered_quantity)) * 10000) / 10000)
                  return <span className="block text-xs text-muted-foreground" data-testid="po-line-last-cost" title="Net quoted cost (after discount, excl. GST) against the Last Purchase Cost">vs last {money(last)} <CostTrend trend={c.trend} percent={c.percent} /></span>
                })()}
              </TableCell>
              <TableCell className="text-right tabular-nums">{Number(l.discount_amount) ? money(l.discount_amount) : '—'}</TableCell>
              <TableCell className="text-right tabular-nums">{money(l.taxable_value)}</TableCell>
              {intra ? <><TableCell className="text-right tabular-nums">{money(l.cgst_amount)}</TableCell><TableCell className="text-right tabular-nums">{money(l.sgst_amount)}</TableCell></>
                : <TableCell className="text-right tabular-nums">{money(l.igst_amount)}</TableCell>}
              <TableCell className="text-right font-medium tabular-nums">{money(l.line_total)}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="overflow-hidden xl:col-span-2">
          <CardHeader><div><CardTitle>Goods receipts</CardTitle><CardDescription>Each receipt and its stock postings. A wrong receipt can be corrected (reversed and posted again) or reversed.</CardDescription></div></CardHeader>
          <CardContent>
            {receipts.length === 0 ? <p className="text-sm text-muted-foreground">No goods received yet.</p> : (
              <ol className="space-y-4">{receipts.map((r) => (
                <li key={r.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p><Link className="font-semibold text-primary hover:underline" to={`/goods-receipts/${r.id}`}>{r.receipt_number}</Link> · {formatDate(r.receipt_date)} · by {name(r.created_by)}
                      {refsText(r.supplier_invoice_number, r.supplier_challan_number) && <> · {refsText(r.supplier_invoice_number, r.supplier_challan_number)}</>}
                      {r.supplier_document_number && <> · earlier ref. {r.supplier_document_number}</>}{r.supporting_document_ref && <> · {r.supporting_document_ref}</>}</p>
                    <span className="flex items-center gap-2">
                      <StatusBadge label={r.status === 'POSTED' ? 'Posted' : 'Reversed'} tone={r.status === 'POSTED' ? 'success' : 'neutral'} />
                      {r.status === 'POSTED' && canFixReceipts && has('purchase_receipt.create') && (
                        <Button variant="ghost" size="sm" onClick={() => setCorrecting(r)}><Pencil /> Correct</Button>
                      )}
                      {r.status === 'POSTED' && canFixReceipts && (
                        <Button variant="ghost" size="sm" onClick={() => setReversing(r)}><RotateCcw /> Reverse</Button>
                      )}
                    </span>
                  </div>
                  {r.status === 'REVERSED' && <p className="text-xs text-muted-foreground">Reversed {r.reversed_at ? formatDateTime(r.reversed_at, tz) : ''}: {r.reversal_reason} ({(r.reversal_transaction_ids ?? []).join(', ')})</p>}
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {receiptLines.filter((l) => l.goods_receipt_id === r.id).map((l) => (
                      <li key={l.id}>
                        Line {l.po_line_no} {l.sku ?? l.description}: received {formatQty(l.received_quantity, l.unit)}, accepted {formatQty(l.accepted_quantity)}
                        {l.accepted_location_code && ` → ${l.accepted_location_code}`}{l.accepted_transaction_number && ` (${l.accepted_transaction_number})`}
                        {Number(l.rejected_quantity) > 0 && <span className="text-red-700"> · rejected {formatQty(l.rejected_quantity)}: {l.rejection_reason}{l.rejected_location_code ? ` → ${l.rejected_location_code}` : ' (recorded only)'}</span>}
                        {l.batch_number && ` · batch ${l.batch_number}`}{l.expiry_date && ` · exp ${formatDate(l.expiry_date)}`}{l.serial_numbers && ` · serials ${l.serial_numbers}`}
                        {l.over_receipt_reason && <span className="text-amber-800"> · over-receipt: {l.over_receipt_reason}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}</ol>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>Approval and amendment history</CardTitle><CardDescription>Also recorded in the audit log.</CardDescription></div></CardHeader>
          <CardContent>
            {amendments.length > 0 && (
              <div className="mb-4 space-y-2">
                {amendments.map((a) => {
                  const prev = a.previous_version as { grand_total?: number; status?: PoStatus }
                  return <p key={a.id} className="rounded-md border bg-surface-muted/50 px-3 py-2 text-xs">Revision {a.from_revision} → {a.to_revision} by {name(a.created_by)} on {formatDateTime(a.created_at, tz)}: {a.reason}. Previous total {money(prev.grand_total ?? null)}{prev.status ? ` (${PO_STATUS_LABELS[prev.status]})` : ''}.</p>
                })}
              </div>
            )}
            <ol className="space-y-3 border-l pl-4">{events.map((e) => (
              <li key={e.id} className="relative text-sm">
                <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-gray-400" />
                <p className="font-medium">{PO_EVENT_LABELS[e.event_type] ?? e.event_type}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(e.created_at, tz)} · {name(e.actor_user_id)}</p>
                {e.note && <p className="text-xs">{e.note}</p>}
              </li>
            ))}</ol>
          </CardContent>
        </Card>
      </div>

      {(po.delivery_instructions || po.purchase_conditions || po.internal_notes) && (
        <Info2 title="Notes" className="mt-6">
          {po.delivery_instructions && <Item label="Delivery instructions" full><span className="whitespace-pre-line">{po.delivery_instructions}</span></Item>}
          {po.purchase_conditions && <Item label="Purchase conditions" full><span className="whitespace-pre-line">{po.purchase_conditions}</span></Item>}
          {po.internal_notes && <Item label="Internal notes" full><span className="whitespace-pre-line">{po.internal_notes}</span></Item>}
        </Info2>
      )}
      <div className="mt-6"><RecordDocuments entityType="SUPPLIER_PO" entityId={po.id} defaultType="PURCHASE_ORDER" /></div>

      {action && (
        <PoActionDialog action={action} poNumber={po.po_number} onClose={() => setAction(null)}
          onConfirm={async (note) => {
            await purchaseOrderAction(po.id, action, note, po.updated_at)
            setAction(null)
            if (action === 'AMEND') navigate(`/purchase-orders/${po.id}/edit`, { state: { message: `Revision ${po.revision + 1} started. Save and open the order again when done.` } })
            else done(`${po.po_number}: ${PO_EVENT_LABELS[{ SUBMIT: 'SUBMITTED', WITHDRAW: 'WITHDRAWN', APPROVE: 'APPROVED', REJECT: 'REJECTED', SEND: 'SENT', AMEND: 'AMENDED', CANCEL: 'CANCELLED', CLOSE: 'CLOSED' }[action]].toLowerCase()}.`)
          }} />
      )}
      {receiving && actions.includes('RECEIVE') && <GoodsReceiptDialog po={po} lines={lines} onClose={() => setReceiving(false)} onPosted={(m) => { setReceiving(false); done(m) }} />}
      {reversing && <ReverseReceiptDialog receipt={reversing} onClose={() => setReversing(null)} onDone={(m) => { setReversing(null); done(m) }} />}
      {correcting && (
        <GoodsReceiptDialog po={po} lines={lines} correction={{ receipt: correcting, lines: receiptLines.filter((l) => l.goods_receipt_id === correcting.id) }}
          onClose={() => setCorrecting(null)} onPosted={(m) => { setCorrecting(null); done(m) }} />
      )}
      {editingDetails && <PoDetailsDialog po={po} onClose={() => setEditingDetails(false)} onDone={(m) => { setEditingDetails(false); done(m) }} />}
    </>
  )
}

function ReverseReceiptDialog({ receipt, onClose, onDone }: { receipt: GoodsReceiptListRow; onClose: () => void; onDone: (m: string) => void }) {
  const request = useRequestKey()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reverse {receipt.receipt_number}?</DialogTitle>
          <DialogDescription>All stock posted by this receipt is reversed in the inventory ledger (the original entries stay). This fails if the stock has already been used or reserved.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="rev-reason">Reason</Label>
          <Textarea id="rev-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => {
            if (reason.trim().length < 5) { setError('Enter the reason (at least 5 characters).'); return }
            setBusy(true)
            try {
              const r = await reverseGoodsReceipt(receipt.id, reason.trim(), request.key)
              request.renew()
              onDone(`${receipt.receipt_number} reversed (${r.reversal_numbers.join(', ')}).`)
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Reverse receipt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Delivery date, reference and notes change without a new revision; prices and quantities need "Edit order". */
function PoDetailsDialog({ po, onClose, onDone }: { po: PurchaseOrderListRow; onClose: () => void; onDone: (m: string) => void }) {
  const [date, setDate] = useState(po.expected_delivery_date ?? '')
  const [ref, setRef] = useState(po.reference_number ?? '')
  const [instructions, setInstructions] = useState(po.delivery_instructions ?? '')
  const [internal, setInternal] = useState(po.internal_notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const orNull = (s: string) => (s.trim() ? s.trim() : null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Delivery date and notes</DialogTitle>
          <DialogDescription>Saved straight away, without a new revision. To change items, quantities or prices use “Edit order (new revision)”.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="pd-date">Expected delivery</Label><Input id="pd-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="pd-ref">Reference</Label><Input id="pd-ref" maxLength={100} value={ref} onChange={(e) => setRef(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="pd-ins">Delivery instructions</Label><Textarea id="pd-ins" rows={2} maxLength={2000} value={instructions} onChange={(e) => setInstructions(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="pd-int">Internal notes</Label><Textarea id="pd-int" rows={2} maxLength={2000} value={internal} onChange={(e) => setInternal(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try {
              await updatePoDetails(po.id, { expected_delivery_date: orNull(date), reference_number: orNull(ref), delivery_instructions: orNull(instructions), internal_notes: orNull(internal) }, po.updated_at)
              onDone(`${po.po_number}: delivery date and notes saved.`)
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Banner({ tone, children }: { tone: 'warning' | 'info' | 'danger'; children: ReactNode }) {
  const cls = { warning: 'border-amber-200 bg-amber-50 text-amber-900', info: 'border-blue-200 bg-blue-50 text-blue-900', danger: 'border-red-200 bg-red-50 text-red-800' }[tone]
  return <div className={cn('mb-4 flex gap-2 rounded-lg border px-4 py-2.5 text-sm', cls)}>{tone === 'info' ? <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />}<div>{children}</div></div>
}

function Info2({ title, description, className, children }: { title: string; description?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={className}>
      <CardHeader><div><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</div></CardHeader>
      <CardContent><dl className="grid gap-3 sm:grid-cols-2">{children}</dl></CardContent>
    </Card>
  )
}

function Item({ label, full, children }: { label: string; full?: boolean; children: ReactNode }) {
  return <div className={full ? 'sm:col-span-2' : undefined}><dt className="text-xs font-medium text-muted-foreground">{label}</dt><dd className="mt-0.5 text-sm break-words">{children}</dd></div>
}
