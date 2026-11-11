import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { money } from '@/features/billing/billing-model'
import {
  actualCostConfirmed, directionLabel, formatPrice, formatSignedPercent, formatSignedPrice, PRICE_REASONS, priceProblem, priceReasonText, priceVariance,
  receiptPayable, splitPriceReason, taxLabel,
} from '@/features/purchasing/grn-price'
import { isWholeUnit } from '@/features/inventory/whole-units'
import { useStorage } from '@/features/inventory/use-storage'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { checkActualCostSupport, correctGoodsReceipt, postGoodsReceipt, type ReceiptLineInput } from '@/services/purchasing'
import type { GoodsReceiptLineListRow, GoodsReceiptListRow, PurchaseOrderLineListRow, PurchaseOrderListRow } from '@/types/database-purchasing'

interface Row {
  line: PurchaseOrderLineListRow
  received: string
  accepted: string
  rejected: string
  acceptedLocation: string
  rejectedLocation: string
  batch: string
  mfg: string
  expiry: string
  serials: string
  reason: string
  overReason: string
  /** Actual purchase unit cost (before discount, excl. GST); starts as the PO price. */
  actual: string
  priceReason: string
  priceRemark: string
}

const QTY = /^\d+(\.\d{1,3})?$/
// Whole-piece items (PCS, NOS, SET, PAIR) are checked below; the server enforces it again.

/**
 * Records goods received against an approved order. Accepted goods are posted
 * to stock in the order's warehouse; rejected goods go to a rejected-goods /
 * quarantine location or are recorded only. The whole receipt and its stock
 * postings succeed or fail together (server side); retrying after an error
 * reuses the same request id so nothing is posted twice.
 */
/** A posted receipt being corrected: its lines prefill the form, and it is reversed when the correction is posted. */
export interface ReceiptCorrection {
  receipt: GoodsReceiptListRow
  lines: GoodsReceiptLineListRow[]
}

export function GoodsReceiptDialog({ po, lines: poLines, onClose, onPosted, onPostedWithWarning, correction }: {
  po: PurchaseOrderListRow
  lines: PurchaseOrderLineListRow[]
  onClose: () => void
  onPosted: (message: string) => void
  /** A receipt was posted but the server did not confirm the actual prices (shown as an error, not a success). */
  onPostedWithWarning?: (message: string) => void
  correction?: ReceiptCorrection
}) {
  const { has } = usePermissions()
  const storage = useStorage()
  const request = useRequestKey()
  // While correcting, the original receipt is reversed first, so its quantities count as pending again.
  const lines = correction
    ? poLines.map((l) => {
      const orig = correction.lines.filter((g) => g.purchase_order_line_id === l.id)
      const acc = orig.reduce((s, g) => s + Number(g.accepted_quantity), 0)
      const rec = orig.reduce((s, g) => s + Number(g.received_quantity), 0)
      const rej = orig.reduce((s, g) => s + Number(g.rejected_quantity), 0)
      return { ...l, received_quantity: Number(l.received_quantity) - rec, accepted_quantity: Number(l.accepted_quantity) - acc,
        rejected_quantity: Number(l.rejected_quantity) - rej, pending_quantity: Math.max(0, Number(l.ordered_quantity) - (Number(l.accepted_quantity) - acc)) }
    })
    : poLines
  const receivable = lines.filter((l) => l.line_type !== 'CHARGE')
  const storageLocations = storage.activeLocations.filter((o) => o.warehouseId === po.warehouse_id && o.usage === 'STORAGE')
  const rejectLocations = storage.activeLocations.filter((o) => o.usage === 'REJECTED' || o.usage === 'QUARANTINE')
  const defaultLoc = storageLocations.find((o) => o.isDefault)?.id ?? storageLocations[0]?.id ?? ''
  const [rows, setRows] = useState<Row[]>(() => receivable.map((l) => {
    const g = correction?.lines.find((x) => x.purchase_order_line_id === l.id)
    const price = g?.actual_unit_price ?? l.unit_price ?? 0
    const why = splitPriceReason(g?.price_variance_reason)
    return {
      line: l, received: g ? String(Number(g.received_quantity)) : '', accepted: g ? String(Number(g.accepted_quantity)) : '',
      rejected: g ? String(Number(g.rejected_quantity)) : '0', acceptedLocation: g?.accepted_location_id ?? '', rejectedLocation: g?.rejected_location_id ?? 'record',
      batch: g?.batch_number ?? '', mfg: g?.manufacturing_date ?? '', expiry: g?.expiry_date ?? '', serials: g?.serial_numbers ?? '',
      reason: g?.rejection_reason ?? '', overReason: g?.over_receipt_reason ?? '',
      actual: String(Number(price)), priceReason: why.reason, priceRemark: why.remark,
    }
  }))
  const [today] = useState(() => toIsoDate(new Date()))
  const [header, setHeader] = useState({
    receipt_date: correction?.receipt.receipt_date ?? today, supplier_document_number: correction?.receipt.supplier_document_number ?? '',
    supporting_document_ref: correction?.receipt.supporting_document_ref ?? '', notes: correction?.receipt.notes ?? '',
    supplier_invoice_number: correction?.receipt.supplier_invoice_number ?? '', supplier_challan_number: correction?.receipt.supplier_challan_number ?? '',
  })
  const [correctionReason, setCorrectionReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Posted, but the server did not confirm that the changed prices were applied: nothing more may be posted here.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null)
  // Auto-saved working copy (entered quantities only; PO quantities always come fresh from the server).
  const draft = usePersistentFormDraft({
    formKey: 'purchase.receipt', recordId: correction ? correction.receipt.id : po.id, scope: correction ? 'correction' : 'receipt',
    baseVersion: correction ? null : po.updated_at,
    enabled: has('purchase_receipt.create'),
    value: { header, correctionReason, rows: rows.map(({ line, ...r }) => ({ lineId: line.id, ...r })) },
    onRestore: (d) => {
      setHeader((h) => ({ ...h, ...d.header }))
      setCorrectionReason(d.correctionReason)
      setRows((rs) => rs.map((r) => {
        const saved = d.rows.find((x) => x.lineId === r.line.id)
        if (!saved) return r
        const { lineId: _lineId, ...fields } = saved
        return { ...r, ...fields }
      }))
    },
  })
  const update = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => {
    if (j !== i) return r
    const next = { ...r, ...p }
    // Keep accepted = received - rejected while the user types the received quantity.
    const diff = (a: string, b: string) => String(Math.max(0, Math.round((Number(a) - Number(b || 0)) * 1000) / 1000))
    if ('received' in p && QTY.test(p.received ?? '') && QTY.test(next.rejected || '0')) next.accepted = diff(p.received ?? '0', next.rejected)
    if ('rejected' in p && QTY.test(p.rejected || '0') && QTY.test(next.received)) next.accepted = diff(next.received, p.rejected ?? '0')
    return next
  }))

  const submit = async () => {
    setError(null)
    const active = rows.filter((r) => r.received.trim() !== '' && Number(r.received) > 0)
    const problems: string[] = []
    if (!active.length) problems.push('Enter the quantity received for at least one line.')
    if (correction && correctionReason.trim().length < 5) problems.push('Enter the reason for the correction (at least 5 characters).')
    if (header.receipt_date > today) problems.push('The receipt date cannot be in the future.')
    if (header.receipt_date < po.po_date) problems.push('The receipt date cannot be before the PO date.')
    for (const r of active) {
      const n = `Line ${r.line.line_no}`
      const rec = Number(r.received); const acc = Number(r.accepted || 0); const rej = Number(r.rejected || 0)
      if (![r.received, r.accepted || '0', r.rejected || '0'].every((x) => QTY.test(x.trim()))) { problems.push(`${n}: quantities must be numbers (up to 3 decimals).`); continue }
      if (r.line.line_type === 'GOODS' && isWholeUnit(r.line.unit) && ![rec, acc, rej].every(Number.isInteger)) {
        problems.push(`${n}: ${r.line.unit} is counted in whole pieces; enter whole quantities.`); continue
      }
      if (Math.abs(acc + rej - rec) > 0.0005) problems.push(`${n}: accepted plus rejected must equal the quantity received.`)
      if (rej > 0 && !r.reason.trim()) problems.push(`${n}: enter the reason for the rejected / damaged quantity.`)
      const priceIssue = priceProblem(r.line.unit_price, r.actual, r.priceReason, r.priceRemark, r.line, r.accepted || '0')
      if (priceIssue) problems.push(`${n}: ${priceIssue}`)
      if (r.line.line_type === 'GOODS' && acc > 0 && !(r.acceptedLocation || defaultLoc)) problems.push(`${n}: choose the storage location.`)
      if (rec > Number(r.line.pending_quantity) + 0.0005) {
        if (!has('purchase_exception.approve')) problems.push(`${n}: only ${formatQty(r.line.pending_quantity, r.line.unit)} is pending. Receiving more needs an authorised exception.`)
        else if (r.overReason.trim().length < 5) problems.push(`${n}: document why more than the pending quantity is being received.`)
      }
    }
    if (problems.length) { setError(problems.join(' ')); return }
    const priceChanged = active.some((r) => priceVariance(r.line.unit_price, r.actual).changed)
    setBusy(true)
    try {
      // A changed price needs a database that records it; an older one would post at the PO price.
      if (priceChanged && !(await checkActualCostSupport())) {
        setError('The database has not been updated for actual purchase costs yet (migration 20261202090000), so a changed price cannot be posted. Nothing was posted. Keep the PO price, or ask the administrator to apply the update.')
        setBusy(false)
        return
      }
      const payload: ReceiptLineInput[] = active.map((r) => ({
        po_line_id: r.line.id, received_quantity: r.received.trim(), accepted_quantity: (r.accepted || '0').trim(), rejected_quantity: (r.rejected || '0').trim(),
        accepted_location_id: r.line.line_type === 'GOODS' && Number(r.accepted || 0) > 0 ? (r.acceptedLocation || defaultLoc) : null,
        rejected_location_id: r.line.line_type === 'GOODS' && Number(r.rejected || 0) > 0 && r.rejectedLocation !== 'record' ? r.rejectedLocation : null,
        batch_number: r.batch.trim() || null, manufacturing_date: r.mfg || null, expiry_date: r.expiry || null, serial_numbers: r.serials.trim() || null,
        rejection_reason: r.reason.trim() || null, over_receipt_reason: r.overReason.trim() || null,
        // Unchanged price: sent as the PO price with no reason (the server keeps the order line's cost).
        actual_unit_price: r.actual.trim() || null,
        price_variance_reason: priceVariance(r.line.unit_price, r.actual).changed ? priceReasonText(r.priceReason, r.priceRemark) : null,
      }))
      const head = {
        receipt_date: header.receipt_date, supplier_document_number: header.supplier_document_number.trim() || null,
        supporting_document_ref: header.supporting_document_ref.trim() || null, notes: header.notes.trim() || null,
        supplier_invoice_number: header.supplier_invoice_number.trim() || null, supplier_challan_number: header.supplier_challan_number.trim() || null,
      }
      if (correction) {
        const res = await correctGoodsReceipt(correction.receipt.id, correctionReason.trim(), head, payload, request.key)
        void draft.markSubmitted()
        if (priceChanged && !actualCostConfirmed(res)) { notConfirmed(res.receipt_number); return }
        request.renew()
        onPosted(`${correction.receipt.receipt_number} reversed and corrected as ${res.receipt_number}. Stock now reflects the corrected quantities.`)
        return
      }
      const res = await postGoodsReceipt(po.id, head, payload, request.key)
      void draft.markSubmitted()
      if (priceChanged && !actualCostConfirmed(res)) { notConfirmed(res.receipt_number); return }
      request.renew()
      onPosted(`${res.receipt_number} posted${res.transaction_numbers.length ? `: stock transactions ${res.transaction_numbers.join(', ')}` : ' (no stock postings)'}.${res.duplicate ? ' (This receipt had already been posted.)' : ''}`)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  // The request id is kept, so a retry can only return this same receipt (never post a second one).
  const notConfirmed = (number: string) => {
    const text = `${number} was posted, but the server did not confirm the actual purchase cost: it may have been recorded at the PO price, not the price you entered. Check ${number} and correct it if needed.`
    setUnconfirmed(text)
    setError(text)
    setBusy(false)
  }
  const close = () => (unconfirmed ? (onPostedWithWarning ?? (() => onClose()))(unconfirmed) : onClose())

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{correction ? `Correct ${correction.receipt.receipt_number} — ${po.po_number}` : `Record goods receipt — ${po.po_number}`}</DialogTitle>
          <DialogDescription>
            {correction
              ? `Change the quantities as they really were. ${correction.receipt.receipt_number} is reversed and the corrected receipt is posted in one step; both stay in the history. Pending quantities below already exclude ${correction.receipt.receipt_number}.`
              : `${po.supplier_name} · deliver to ${po.warehouse_code ?? '(warehouse not set)'}. Enter only the lines delivered now. Accepted goods are added to stock; rejected goods are never available stock. A posted receipt can be corrected or reversed later.`}
          </DialogDescription>
        </DialogHeader>
        <FormDraftBar draft={draft} className="mb-0" />
        <form noValidate onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-4">
          {correction && (
            <div className="space-y-1"><Label htmlFor="gr-correction">Reason for the correction</Label>
              <Input id="gr-correction" maxLength={500} value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="e.g. recounted at the gate: 5 received, not 4" /></div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1"><Label htmlFor="gr-date">Receipt date</Label><Input id="gr-date" type="date" max={today} min={po.po_date} value={header.receipt_date} onChange={(e) => setHeader((h) => ({ ...h, receipt_date: e.target.value }))} /></div>
            <div className="space-y-1"><Label htmlFor="gr-invoice">Supplier invoice no.</Label><Input id="gr-invoice" maxLength={100} autoComplete="off" value={header.supplier_invoice_number} onChange={(e) => setHeader((h) => ({ ...h, supplier_invoice_number: e.target.value }))} placeholder="Optional" /></div>
            <div className="space-y-1"><Label htmlFor="gr-challan">Supplier challan no.</Label><Input id="gr-challan" maxLength={100} autoComplete="off" value={header.supplier_challan_number} onChange={(e) => setHeader((h) => ({ ...h, supplier_challan_number: e.target.value }))} placeholder="Optional" /></div>
            <div className="space-y-1"><Label htmlFor="gr-ref">Supporting document reference</Label><Input id="gr-ref" maxLength={200} value={header.supporting_document_ref} onChange={(e) => setHeader((h) => ({ ...h, supporting_document_ref: e.target.value }))} placeholder="e.g. LR no., e-way bill" /></div>
            <div className="space-y-1"><Label htmlFor="gr-notes">Notes</Label><Input id="gr-notes" maxLength={2000} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} /></div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Invoice and challan numbers are the supplier's own references for this delivery ({po.po_number} stays the Alton order number). They can be added later on the GRN when the documents arrive.
            {header.supplier_document_number && ` Earlier combined reference on the original receipt: ${header.supplier_document_number}.`}
          </p>

          {rows.map((r, i) => {
            const id = (f: string) => `gr-${r.line.id}-${f}`
            const goods = r.line.line_type === 'GOODS'
            const over = Number(r.received || 0) > Number(r.line.pending_quantity) + 0.0005
            return (
              <fieldset key={r.line.id} className="rounded-lg border p-3">
                <legend className="px-1 text-sm font-semibold">Line {r.line.line_no}: {r.line.sku ? `${r.line.sku} — ` : ''}{r.line.description}{goods ? '' : ' (service — not stocked)'}</legend>
                <p className="mb-2 text-xs text-muted-foreground">
                  Ordered {formatQty(r.line.ordered_quantity, r.line.unit)} · previously received {formatQty(r.line.received_quantity)} (accepted {formatQty(r.line.accepted_quantity)}, rejected {formatQty(r.line.rejected_quantity)}) · <span className="font-medium text-foreground">pending {formatQty(r.line.pending_quantity, r.line.unit)}</span>
                </p>
                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <div className="space-y-1"><Label htmlFor={id('rec')}>Received now</Label><Input id={id('rec')} inputMode="decimal" value={r.received} onChange={(e) => update(i, { received: e.target.value })} placeholder="0" /></div>
                  <div className="space-y-1"><Label htmlFor={id('acc')}>Accepted</Label><Input id={id('acc')} inputMode="decimal" value={r.accepted} onChange={(e) => update(i, { accepted: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor={id('rej')}>Rejected / damaged</Label><Input id={id('rej')} inputMode="decimal" value={r.rejected} onChange={(e) => update(i, { rejected: e.target.value })} /></div>
                  {goods && (
                    <div className="space-y-1 sm:col-span-3">
                      <Label htmlFor={id('loc')}>Store accepted goods in</Label>
                      <Select value={r.acceptedLocation || defaultLoc || undefined} onValueChange={(v) => update(i, { acceptedLocation: v })}>
                        <SelectTrigger id={id('loc')} className="w-full"><SelectValue placeholder={storageLocations.length ? 'Choose a location' : 'No storage location in this warehouse'} /></SelectTrigger>
                        <SelectContent>{storageLocations.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
                <PriceRow row={r} id={id} editable={goods} onChange={(p) => update(i, p)} />
                {Number(r.rejected || 0) > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1"><Label htmlFor={id('reason')}>Rejection reason</Label><Input id={id('reason')} maxLength={500} value={r.reason} onChange={(e) => update(i, { reason: e.target.value })} placeholder="e.g. cracked in transit" /></div>
                    {goods && (
                      <div className="space-y-1">
                        <Label htmlFor={id('rejloc')}>Rejected goods</Label>
                        <Select value={r.rejectedLocation} onValueChange={(v) => update(i, { rejectedLocation: v })}>
                          <SelectTrigger id={id('rejloc')} className="w-full"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="record">Record only (returned / not kept)</SelectItem>
                            {rejectLocations.map((o) => <SelectItem key={o.id} value={o.id}>Keep in {o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                )}
                {goods && Number(r.received || 0) > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1"><Label htmlFor={id('batch')}>Batch / lot</Label><Input id={id('batch')} maxLength={50} value={r.batch} onChange={(e) => update(i, { batch: e.target.value })} placeholder="If the product is batch-tracked" /></div>
                    <div className="space-y-1"><Label htmlFor={id('mfg')}>Manufacturing date</Label><Input id={id('mfg')} type="date" value={r.mfg} onChange={(e) => update(i, { mfg: e.target.value })} /></div>
                    <div className="space-y-1"><Label htmlFor={id('exp')}>Expiry date</Label><Input id={id('exp')} type="date" value={r.expiry} onChange={(e) => update(i, { expiry: e.target.value })} /></div>
                    <div className="space-y-1"><Label htmlFor={id('serial')}>Serial numbers (reference)</Label><Input id={id('serial')} maxLength={2000} value={r.serials} onChange={(e) => update(i, { serials: e.target.value })} /></div>
                  </div>
                )}
                {over && (
                  <div className="mt-3 space-y-1">
                    <Label htmlFor={id('over')}>Reason for receiving more than pending</Label>
                    <Textarea id={id('over')} rows={2} maxLength={500} value={r.overReason} disabled={!has('purchase_exception.approve')} onChange={(e) => update(i, { overReason: e.target.value })}
                      placeholder={has('purchase_exception.approve') ? 'Required: document the exception' : 'Only a user with purchase_exception.approve can receive more than ordered'} />
                  </div>
                )}
              </fieldset>
            )
          })}

          {error && <p role="alert" data-testid="gr-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <DialogFooter>
            {unconfirmed ? <Button type="button" onClick={close}>Close</Button> : <>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button type="submit" disabled={busy || storage.loading}>{busy && <Loader2 className="animate-spin" />} {correction ? 'Reverse and post correction' : 'Post goods receipt'}</Button>
            </>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * PO price, editable actual purchase unit cost (goods lines), variance, accepted value and the supplier
 * payable incl. GST, calculated exactly as the server stores it.
 */
function PriceRow({ row: r, id, editable, onChange }: { row: Row; id: (f: string) => string; editable: boolean; onChange: (p: Partial<Row>) => void }) {
  const v = priceVariance(r.line.unit_price, r.actual)
  const acc = (r.accepted || '0').trim()
  const val = v.actual !== null && /^\d+(\.\d{1,3})?$/.test(acc) ? receiptPayable(r.line, v.actual === v.poPrice ? (r.line.unit_price ?? 0) : r.actual.trim(), acc) : null
  const tone = v.direction === 'INCREASE' ? 'text-red-700' : v.direction === 'DECREASE' ? 'text-green-700' : 'text-muted-foreground'
  const discount = Number(r.line.discount_percent ?? 0) > 0 ? `${Number(r.line.discount_percent)}%` : Number(r.line.discount_amount) > 0 ? money(r.line.discount_amount) : 'None'
  return (
    <div className="mt-3 rounded-md border bg-surface-muted/40 p-3" data-testid={`gr-price-${r.line.line_no}`}>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <div className="space-y-1"><p className="text-xs text-muted-foreground">PO unit price</p><p className="text-sm font-medium tabular-nums">{formatPrice(r.line.unit_price ?? 0)}</p></div>
        <div className="space-y-1 lg:col-span-2">
          <Label htmlFor={id('actual')}>Actual Purchase Unit Cost (₹)</Label>
          <Input id={id('actual')} inputMode="decimal" value={r.actual} aria-invalid={Boolean(v.error)} disabled={!editable} onChange={(e) => onChange({ actual: e.target.value })} />
          {!editable && <p className="text-xs text-muted-foreground">Services are received at the PO price.</p>}
        </div>
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Price difference</p><p className={`text-sm font-medium tabular-nums ${tone}`} data-testid={`gr-price-diff-${r.line.line_no}`}>{formatSignedPrice(v.difference)}</p></div>
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Variance</p><p className={`text-sm font-medium tabular-nums ${tone}`}>{formatSignedPercent(v.percent)} <span className="block text-xs font-normal">{directionLabel(v.direction)}</span></p></div>
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Discount · GST</p><p className="text-sm tabular-nums" data-testid={`gr-price-tax-${r.line.line_no}`}>{discount} · {taxLabel(r.line)}</p></div>
        <div className="space-y-1"><p className="text-xs text-muted-foreground">Accepted goods value</p><p className="text-sm font-medium tabular-nums" data-testid={`gr-price-value-${r.line.line_no}`}>{val ? money(val.taxable) : '—'}</p>
          {val && <p className="text-xs text-muted-foreground" data-testid={`gr-price-payable-${r.line.line_no}`}>excl. GST · payable {money(val.payable)} incl. GST</p>}</div>
      </div>
      {(v.error ?? val?.error) && <p className="mt-2 text-xs text-red-700">{v.error ?? val?.error}</p>}
      {v.changed && !v.error && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={id('price-reason')}>Reason for the price change</Label>
            <Select value={r.priceReason || undefined} onValueChange={(x) => onChange({ priceReason: x })}>
              <SelectTrigger id={id('price-reason')} className="w-full"><SelectValue placeholder="Select a reason (required)" /></SelectTrigger>
              <SelectContent>{PRICE_REASONS.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={id('price-remark')}>{r.priceReason === 'Other' ? 'Describe the reason' : 'Remark (optional)'}</Label>
            <Input id={id('price-remark')} maxLength={400} value={r.priceRemark} onChange={(e) => onChange({ priceRemark: e.target.value })} placeholder="e.g. supplier invoice INV-1042" />
          </div>
          {v.large && (
            <p role="status" className="sm:col-span-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid={`gr-price-warning-${r.line.line_no}`}>
              Large price change ({formatSignedPercent(v.percent)}). Check it against the supplier invoice before posting. The PO price stays {formatPrice(v.poPrice)}; stock and the supplier payable use {formatPrice(v.actual)} less the order line's discount{val && !val.error ? ` (unit cost ${formatPrice(val.cost)}, payable ${money(val.payable)} incl. GST)` : ''}.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
