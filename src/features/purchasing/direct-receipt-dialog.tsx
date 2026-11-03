import { AlertTriangle, Loader2, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { isWholeUnit } from '@/features/inventory/whole-units'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import type { ProductOption } from '@/services/inventory'
import { correctGoodsReceipt, postDirectGoodsReceipt, type DirectReceiptLineInput } from '@/services/purchasing'
import { fetchSupplierOptions } from '@/services/suppliers'
import type { GoodsReceiptLineListRow, GoodsReceiptListRow } from '@/types/database-purchasing'

const QTY = /^\d+(\.\d{1,3})?$/
const MONEY = /^\d+(\.\d{1,4})?$/

interface Row {
  key: string
  product: ProductOption | null
  received: string
  rejected: string
  cost: string
  gst: string
  location: string
  rejectedLocation: string
  reason: string
  batch: string
  expiry: string
}

const blank = (): Row => ({ key: crypto.randomUUID(), product: null, received: '', rejected: '0', cost: '', gst: '', location: '', rejectedLocation: 'record', reason: '', batch: '', expiry: '' })

/**
 * Goods received without a purchase order. Always flagged as an unlinked
 * receipt. Accepted goods go to stock; a missing supplier or cost is allowed
 * (with a warning). With `correction`, the given direct receipt is reversed and
 * the corrected one posted in one step.
 */
export function DirectReceiptDialog({ onClose, onPosted, correction }: {
  onClose: () => void
  onPosted: (message: string, receiptId: string) => void
  correction?: { receipt: GoodsReceiptListRow; lines: GoodsReceiptLineListRow[] }
}) {
  const storage = useStorage()
  const suppliers = useAsync(() => fetchSupplierOptions(false).catch(() => []), [])
  const request = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const [header, setHeader] = useState({
    receipt_date: correction?.receipt.receipt_date ?? today, supplier_id: correction?.receipt.supplier_id ?? '',
    warehouse_id: correction?.receipt.warehouse_id ?? storage.warehouses.find((w) => w.is_default)?.id ?? '',
    supplier_document_number: correction?.receipt.supplier_document_number ?? '', supporting_document_ref: correction?.receipt.supporting_document_ref ?? '',
    notes: correction?.receipt.notes ?? '',
    supplier_invoice_number: correction?.receipt.supplier_invoice_number ?? '', supplier_challan_number: correction?.receipt.supplier_challan_number ?? '',
  })
  const [rows, setRows] = useState<Row[]>(() => correction
    ? correction.lines.map((l) => ({
      key: l.id, product: { product_id: l.product_id!, sku: l.sku ?? '', product_name: l.description, base_unit: l.unit, track_batches: false, track_expiry: false },
      received: String(Number(l.received_quantity)), rejected: String(Number(l.rejected_quantity)), cost: l.unit_cost === null ? '' : String(Number(l.unit_cost)),
      gst: l.gst_rate === null ? '' : String(Number(l.gst_rate)), location: l.accepted_location_id ?? '', rejectedLocation: l.rejected_location_id ?? 'record',
      reason: l.rejection_reason ?? '', batch: l.batch_number ?? '', expiry: l.expiry_date ?? '',
    }))
    : [blank()])
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const warehouseId = header.warehouse_id || storage.warehouses.find((w) => w.is_default)?.id || ''
  const locations = storage.activeLocations.filter((o) => o.warehouseId === warehouseId && o.usage === 'STORAGE')
  const rejectLocations = storage.activeLocations.filter((o) => o.usage === 'REJECTED' || o.usage === 'QUARANTINE')
  const defaultLoc = locations.find((o) => o.isDefault)?.id ?? locations[0]?.id ?? ''
  const update = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const submit = async () => {
    setError(null)
    const filled = rows.filter((r) => r.product || r.received.trim())
    const problems: string[] = []
    if (!warehouseId) problems.push('Choose the warehouse the goods were received into.')
    if (header.receipt_date > today) problems.push('The receipt date cannot be in the future.')
    if (!filled.length) problems.push('Add at least one product received.')
    if (correction && reason.trim().length < 5) problems.push('Enter the reason for the correction (at least 5 characters).')
    const seen = new Set<string>()
    filled.forEach((r, i) => {
      const n = `Line ${i + 1}`
      if (!r.product) return problems.push(`${n}: choose the product.`)
      if (seen.has(r.product.product_id)) problems.push(`${n}: ${r.product.sku} is listed twice; combine the quantities.`)
      seen.add(r.product.product_id)
      const rej = r.rejected.trim() || '0'
      if (!QTY.test(r.received.trim()) || Number(r.received) <= 0 || !QTY.test(rej)) return problems.push(`${n}: enter the quantity received (up to 3 decimals).`)
      if (Number(rej) > Number(r.received)) problems.push(`${n}: rejected cannot exceed received.`)
      if (isWholeUnit(r.product.base_unit) && (!Number.isInteger(Number(r.received)) || !Number.isInteger(Number(rej)))) problems.push(`${n}: ${r.product.base_unit} is counted in whole pieces.`)
      if (Number(rej) > 0 && !r.reason.trim()) problems.push(`${n}: enter the reason for the rejected / damaged quantity.`)
      if (r.cost.trim() && !MONEY.test(r.cost.trim())) problems.push(`${n}: unit cost must be a number (up to 4 decimals).`)
      if (r.gst.trim() && (!/^\d+(\.\d{1,2})?$/.test(r.gst.trim()) || Number(r.gst) > 100)) problems.push(`${n}: GST rate must be 0 to 100.`)
      if (Number(r.received) - Number(rej) > 0 && !(r.location || defaultLoc)) problems.push(`${n}: choose the storage location.`)
    })
    if (problems.length) { setError(problems.join(' ')); return }
    setBusy(true)
    try {
      const lines: DirectReceiptLineInput[] = filled.map((r) => {
        const rej = r.rejected.trim() || '0'
        const acc = String(Math.round((Number(r.received) - Number(rej)) * 1000) / 1000)
        return {
          product_id: r.product!.product_id, received_quantity: r.received.trim(), accepted_quantity: acc, rejected_quantity: rej,
          unit_cost: r.cost.trim() || null, gst_rate: r.gst.trim() || null,
          accepted_location_id: Number(acc) > 0 ? (r.location || defaultLoc) : null,
          rejected_location_id: Number(rej) > 0 && r.rejectedLocation !== 'record' ? r.rejectedLocation : null,
          batch_number: r.batch.trim() || null, manufacturing_date: null, expiry_date: r.expiry || null, serial_numbers: null, rejection_reason: r.reason.trim() || null,
        }
      })
      const head = {
        receipt_date: header.receipt_date, supplier_id: header.supplier_id || null, warehouse_id: warehouseId,
        supplier_document_number: header.supplier_document_number.trim() || null, supporting_document_ref: header.supporting_document_ref.trim() || null, notes: header.notes.trim() || null,
        supplier_invoice_number: header.supplier_invoice_number.trim() || null, supplier_challan_number: header.supplier_challan_number.trim() || null,
      }
      const res = correction
        ? await correctGoodsReceipt(correction.receipt.id, reason.trim(), head, lines, request.key)
        : await postDirectGoodsReceipt(head, lines, request.key)
      request.renew()
      const extra = (res.warnings ?? []).filter((w) => !w.includes('not linked'))
      onPosted(`${correction ? `${correction.receipt.receipt_number} reversed and corrected as ${res.receipt_number}` : `${res.receipt_number} posted without a purchase order`}.${extra.length ? ` Note: ${extra.join(' ')}` : ''}`, res.receipt_id)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{correction ? `Correct ${correction.receipt.receipt_number}` : 'Receive goods without a purchase order'}</DialogTitle>
          <DialogDescription>
            {correction
              ? `${correction.receipt.receipt_number} is reversed and the corrected receipt posted in one step; both stay in the history.`
              : 'Use this when goods arrive with no order in the system. Accepted goods are added to stock; rejected goods are never available.'}
          </DialogDescription>
        </DialogHeader>
        <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          This is an unlinked receipt: it is not matched to any purchase order, so ordered and pending quantities are not tracked for it. Prefer receiving against the order when there is one.
        </p>
        <form noValidate onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-4">
          {correction && (
            <div className="space-y-1"><Label htmlFor="dr-reason">Reason for the correction</Label>
              <Input id="dr-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1"><Label htmlFor="dr-date">Receipt date</Label><Input id="dr-date" type="date" max={today} value={header.receipt_date} onChange={(e) => setHeader((h) => ({ ...h, receipt_date: e.target.value }))} /></div>
            <div className="space-y-1"><Label htmlFor="dr-supplier">Supplier (optional)</Label>
              <Select value={header.supplier_id || 'none'} onValueChange={(v) => { if (v) setHeader((h) => ({ ...h, supplier_id: v === 'none' ? '' : v })) }}>
                <SelectTrigger id="dr-supplier"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72"><SelectItem value="none">No supplier</SelectItem>
                  {(suppliers.data ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.supplier_code} — {s.display_name ?? s.legal_name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1"><Label htmlFor="dr-wh">Warehouse</Label>
              <Select value={warehouseId || undefined} onValueChange={(v) => { if (v) { setHeader((h) => ({ ...h, warehouse_id: v })); setRows((rs) => rs.map((r) => ({ ...r, location: '' }))) } }}>
                <SelectTrigger id="dr-wh"><SelectValue placeholder="Choose" /></SelectTrigger>
                <SelectContent>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
              </Select></div>
            <div className="space-y-1"><Label htmlFor="dr-invoice">Supplier invoice no.</Label><Input id="dr-invoice" maxLength={100} autoComplete="off" placeholder="Optional" value={header.supplier_invoice_number} onChange={(e) => setHeader((h) => ({ ...h, supplier_invoice_number: e.target.value }))} /></div>
            <div className="space-y-1"><Label htmlFor="dr-challan">Supplier challan no.</Label><Input id="dr-challan" maxLength={100} autoComplete="off" placeholder="Optional" value={header.supplier_challan_number} onChange={(e) => setHeader((h) => ({ ...h, supplier_challan_number: e.target.value }))} />
              {header.supplier_document_number && <p className="text-xs text-muted-foreground">Earlier combined reference: {header.supplier_document_number}</p>}</div>
            <div className="space-y-1"><Label htmlFor="dr-ref">Supporting document reference</Label><Input id="dr-ref" maxLength={200} value={header.supporting_document_ref} onChange={(e) => setHeader((h) => ({ ...h, supporting_document_ref: e.target.value }))} /></div>
            <div className="space-y-1"><Label htmlFor="dr-notes">Remarks</Label><Input id="dr-notes" maxLength={2000} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} /></div>
          </div>
          {rows.map((r, i) => (
            <fieldset key={r.key} className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-semibold">Line {i + 1}</legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <div className="space-y-1 sm:col-span-2"><Label htmlFor={`dr-prod-${i}`}>Product</Label><ProductPicker id={`dr-prod-${i}`} value={r.product} onChange={(p) => update(r.key, { product: p })} /></div>
                <div className="space-y-1"><Label htmlFor={`dr-rec-${r.key}`}>Received{r.product ? ` (${r.product.base_unit})` : ''}</Label><Input id={`dr-rec-${r.key}`} inputMode="decimal" value={r.received} onChange={(e) => update(r.key, { received: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor={`dr-rej-${r.key}`}>Rejected / damaged</Label><Input id={`dr-rej-${r.key}`} inputMode="decimal" value={r.rejected} onChange={(e) => update(r.key, { rejected: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor={`dr-cost-${r.key}`}>Unit cost (₹, excl. GST)</Label><Input id={`dr-cost-${r.key}`} inputMode="decimal" placeholder="Product's standard" value={r.cost} onChange={(e) => update(r.key, { cost: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor={`dr-gst-${r.key}`}>GST %</Label><Input id={`dr-gst-${r.key}`} inputMode="decimal" placeholder="Product's rate" value={r.gst} onChange={(e) => update(r.key, { gst: e.target.value })} /></div>
                <div className="space-y-1 sm:col-span-2"><Label htmlFor={`dr-loc-${r.key}`}>Store accepted goods in</Label>
                  <Select value={r.location || defaultLoc || undefined} onValueChange={(v) => { if (v) update(r.key, { location: v }) }}>
                    <SelectTrigger id={`dr-loc-${r.key}`}><SelectValue placeholder={locations.length ? 'Choose a location' : 'No storage location in this warehouse'} /></SelectTrigger>
                    <SelectContent>{locations.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent>
                  </Select></div>
                <div className="space-y-1"><Label htmlFor={`dr-batch-${r.key}`}>Batch</Label><Input id={`dr-batch-${r.key}`} maxLength={50} value={r.batch} onChange={(e) => update(r.key, { batch: e.target.value })} /></div>
                <div className="space-y-1"><Label htmlFor={`dr-exp-${r.key}`}>Expiry</Label><Input id={`dr-exp-${r.key}`} type="date" value={r.expiry} onChange={(e) => update(r.key, { expiry: e.target.value })} /></div>
                <div className="flex items-end justify-end lg:col-span-2">
                  <Button type="button" variant="ghost" size="sm" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 /> Remove line</Button>
                </div>
              </div>
              {Number(r.rejected || 0) > 0 && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1"><Label htmlFor={`dr-reason-${r.key}`}>Rejection reason</Label><Input id={`dr-reason-${r.key}`} maxLength={500} value={r.reason} onChange={(e) => update(r.key, { reason: e.target.value })} /></div>
                  <div className="space-y-1"><Label htmlFor={`dr-rejloc-${r.key}`}>Rejected goods</Label>
                    <Select value={r.rejectedLocation} onValueChange={(v) => { if (v) update(r.key, { rejectedLocation: v }) }}>
                      <SelectTrigger id={`dr-rejloc-${r.key}`}><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="record">Record only (returned / not kept)</SelectItem>
                        {rejectLocations.map((o) => <SelectItem key={o.id} value={o.id}>Keep in {o.label}</SelectItem>)}</SelectContent>
                    </Select></div>
                </div>
              )}
            </fieldset>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, blank()])}><Plus /> Add product</Button>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || storage.loading}>{busy && <Loader2 className="animate-spin" />} {correction ? 'Reverse and post correction' : 'Post unlinked receipt'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
