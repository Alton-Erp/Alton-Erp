import { Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { STOCK_SOURCE_LABELS, formatQty, type StockSourceCode } from '@/features/inventory/inventory-model'
import { Field, StockFormDialog } from '@/features/inventory/stock-dialogs'
import { useStorage } from '@/features/inventory/use-storage'
import { isWholeUnit, parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { PRIORITY_LABELS, QUALITY_STATUS_LABELS, parseNonNegativeQty } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import {
  fetchEffectiveBoms,
  fetchOrderReservations,
  fetchProductFlags,
  fetchUsableLots,
  issueMaterials,
  receiveOutput,
  saveProductionOrder,
  type OrderRequirementLine,
} from '@/services/production'
import type { StockDetailRow } from '@/types/database-inventory'
import type { ProductionOrderListRow, ProductionPriority, QualityStatus } from '@/types/database-production'

const today = () => toIsoDate(new Date())

// ---------------------------------------------------------------------------
// Create / edit a draft production order
// ---------------------------------------------------------------------------
export interface OrderPreset {
  bomId?: string
  quantity?: string
  sourceWarehouseId?: string
  destinationWarehouseId?: string
  plannedStartDate?: string
  targetCompletionDate?: string
}

export function OrderFormDialog({
  order,
  preset,
  onClose,
  onSaved,
}: {
  order: ProductionOrderListRow | null
  preset?: OrderPreset
  onClose: () => void
  onSaved: (result: { order_id: string; production_order_number: string }) => void
}) {
  const storage = useStorage()
  const [now] = useState(today)
  const boms = useAsync(() => fetchEffectiveBoms(now), [now])
  const { key, renew } = useRequestKey()
  const [bomId, setBomId] = useState(order?.bom_id ?? preset?.bomId ?? '')
  const [quantity, setQuantity] = useState(order ? String(order.planned_quantity) : (preset?.quantity ?? ''))
  const [source, setSource] = useState(order?.source_warehouse_id ?? preset?.sourceWarehouseId ?? '')
  const [dest, setDest] = useState(order?.destination_warehouse_id ?? preset?.destinationWarehouseId ?? '')
  const [start, setStart] = useState(order?.planned_start_date ?? preset?.plannedStartDate ?? now)
  const [target, setTarget] = useState(order?.target_completion_date ?? preset?.targetCompletionDate ?? '')
  const [priority, setPriority] = useState<ProductionPriority>(order?.priority ?? 'NORMAL')
  const [notes, setNotes] = useState(order?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeWarehouses = storage.warehouses.filter((w) => w.status === 'ACTIVE')
  const selectedBom = boms.data?.find((b) => b.id === bomId)
  const bomMissing = Boolean(order && boms.data && !selectedBom)

  const save = async () => {
    setError(null)
    const q = parseUnitQty(quantity, selectedBom?.output_unit)
    if (!bomId || !selectedBom) return setError('Select an approved, currently effective BOM.')
    if (!q) return setError(`Enter a planned quantity greater than zero (${quantityRule(selectedBom.output_unit)}).`)
    if (!source || !dest) return setError('Select the source and destination warehouses.')
    if (!start || !target) return setError('Enter the planned start and target completion dates.')
    if (target < start) return setError('The target completion date cannot be before the planned start date.')
    setBusy(true)
    try {
      const result = await saveProductionOrder(
        {
          orderId: order?.id ?? null,
          bomId,
          plannedQuantity: q,
          sourceWarehouseId: source,
          destinationWarehouseId: dest,
          plannedStartDate: start,
          targetCompletionDate: target,
          priority,
          notes: notes.trim() || null,
        },
        key,
      )
      renew()
      onSaved(result)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{order ? `Edit ${order.production_order_number}` : 'New production order'}</DialogTitle>
          <DialogDescription>
            Saved as a draft. Nothing is reserved or issued until the order is approved and materials are reserved or issued.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {bomMissing && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The BOM version on this draft ({order?.bom_code} v{order?.bom_version}) is no longer approved and effective. Select the current version.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Finished product and BOM version" htmlFor="po-bom" full>
            <Select value={selectedBom ? bomId : ''} onValueChange={setBomId}>
              <SelectTrigger id="po-bom"><SelectValue placeholder={boms.loading ? 'Loading BOMs…' : 'Select an approved BOM'} /></SelectTrigger>
              <SelectContent className="max-h-72">
                {(boms.data ?? []).length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No approved, currently effective BOMs.</div>}
                {(boms.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.sku} — {b.product_name} · {b.bom_code} v{b.version}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={`Planned quantity${selectedBom ? ` (${selectedBom.output_unit})` : ''}`} htmlFor="po-qty">
            <Input id="po-qty" inputMode={qtyInputMode(selectedBom?.output_unit)} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Priority" htmlFor="po-priority">
            <Select value={priority} onValueChange={(v) => setPriority(v as ProductionPriority)}>
              <SelectTrigger id="po-priority"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PRIORITY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Raw materials from (source warehouse)" htmlFor="po-src">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="po-src"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>{activeWarehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Finished goods to (destination warehouse)" htmlFor="po-dst">
            <Select value={dest} onValueChange={setDest}>
              <SelectTrigger id="po-dst"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>{activeWarehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Planned start" htmlFor="po-start">
            <Input id="po-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Target completion" htmlFor="po-target">
            <Input id="po-target" type="date" min={start} value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="Notes" htmlFor="po-notes" full>
            <Textarea id="po-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} {order ? 'Save draft' : 'Create draft order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Issue materials to a production order
// ---------------------------------------------------------------------------
const lotKey = (l: { batch_id: string; location_id: string }) => `${l.batch_id}|${l.location_id}`

export function IssueMaterialsDialog({
  order,
  lines,
  open,
  onOpenChange,
  onPosted,
}: {
  order: ProductionOrderListRow
  lines: OrderRequirementLine[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: (message: string) => void
}) {
  const issuable = lines.filter((l) => l.line_status !== 'UNIT_MISMATCH')
  const productIds = issuable.map((l) => l.component_product_id)
  const lots = useAsync(() => (open ? fetchUsableLots(productIds, order.source_warehouse_id) : Promise.resolve([])), [open, order.id, productIds.join(',')])
  const reservations = useAsync(() => (open ? fetchOrderReservations(order.id) : Promise.resolve([])), [open, order.id])
  const [picks, setPicks] = useState<Record<string, { lot: string; qty: string }>>({})
  const [date, setDate] = useState(today)
  const [overReason, setOverReason] = useState('')
  const [notes, setNotes] = useState('')

  // Reserved for THIS order per lot/location: usable by this issue in addition to free stock.
  const ownReserved = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of reservations.data ?? []) {
      if (r.reservation_status !== 'ACTIVE' && r.reservation_status !== 'PARTIALLY_FULFILLED') continue
      const k = lotKey(r)
      m.set(k, (m.get(k) ?? 0) + Number(r.quantity) - Number(r.fulfilled_quantity) - Number(r.released_quantity))
    }
    return m
  }, [reservations.data])
  const lotsFor = (productId: string) => (lots.data ?? []).filter((l) => l.product_id === productId)
  const usable = (l: StockDetailRow) => Number(l.available) + (ownReserved.get(lotKey(l)) ?? 0)

  const chosen = issuable
    .map((line) => {
      const p = picks[line.order_material_id]
      const lot = p?.lot ? lotsFor(line.component_product_id).find((l) => lotKey(l) === p.lot) : undefined
      return { line, lot, qty: p ? parseUnitQty(p.qty, line.unit) : null, raw: p?.qty ?? '' }
    })
    .filter((c) => c.raw.trim() !== '')
  const over = chosen.filter((c) => c.qty !== null && Number(c.line.issued_quantity) + c.qty > Number(c.line.planned_quantity))

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Issue materials to ${order.production_order_number}`}
      description={`Deducts stock from the source warehouse (${order.source_warehouse_code}). This order's reservations on the chosen lot are used first.`}
      validate={() => {
        if (chosen.length === 0) return 'Enter a quantity for at least one material.'
        for (const c of chosen) {
          if (!c.lot) return `${c.line.sku}: choose the lot and location to issue from.`
          if (!c.qty) return `${c.line.sku}: enter a quantity greater than zero (${quantityRule(c.line.unit)}).`
          if (c.qty > usable(c.lot)) return `${c.line.sku}: only ${formatQty(usable(c.lot), c.line.unit)} usable at the chosen lot.`
        }
        if (over.length && overReason.trim().length < 5) return 'Some quantities exceed the plan: document the reason (requires exception approval rights).'
        if (date > today()) return 'The consumption date cannot be in the future.'
        return null
      }}
      review={() => [
        ...chosen.map((c) => ({
          label: c.line.sku,
          value: `${formatQty(c.qty, c.line.unit)} from ${c.lot?.location_code}${c.lot?.batch_number ? ` · batch ${c.lot.batch_number}` : ''}${over.includes(c) ? ' (over plan)' : ''}`,
        })),
        { label: 'Consumption date', value: date },
        ...(over.length ? [{ label: 'Over-issue reason', value: overReason }] : []),
      ]}
      confirmLabel="Post issue"
      submit={async (key) => {
        const result = await issueMaterials(
          {
            orderId: order.id,
            lines: chosen.map((c) => ({ order_material_id: c.line.order_material_id, batch_id: c.lot!.batch_id, location_id: c.lot!.location_id, quantity: c.qty! })),
            consumptionDate: date,
            overIssueReason: over.length ? overReason.trim() : null,
            notes: notes.trim() || null,
          },
          key,
        )
        onPosted(`Issued: ${result.transaction_numbers.join(', ')}.`)
        setPicks({})
        setOverReason('')
        setNotes('')
        return result.transaction_numbers.join(', ')
      }}
    >
      {lots.error && <p className="mb-3 text-sm text-shortage">{describeDataError(lots.error)}</p>}
      <div className="max-h-[50vh] overflow-y-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted/60 text-xs text-muted-foreground">
            <tr><th className="p-2 text-left">Material</th><th className="p-2 text-right">Outstanding</th><th className="p-2 text-left">Lot / location</th><th className="p-2 text-right">Issue now</th></tr>
          </thead>
          <tbody>
            {issuable.map((line) => {
              const options = lotsFor(line.component_product_id)
              const pick = picks[line.order_material_id] ?? { lot: '', qty: '' }
              const set = (patch: Partial<typeof pick>) => setPicks((p) => ({ ...p, [line.order_material_id]: { ...pick, ...patch } }))
              return (
                <tr key={line.order_material_id} className="border-t align-top">
                  <td className="p-2"><span className="font-medium">{line.sku}</span><div className="text-xs text-muted-foreground">{line.product_name}</div></td>
                  <td className="p-2 text-right tabular-nums">{formatQty(line.outstanding_quantity, line.unit)}</td>
                  <td className="p-2">
                    {lots.loading ? <span className="text-xs text-muted-foreground">Loading…</span> : options.length === 0 ? (
                      <span className="text-xs text-shortage">No usable stock in {order.source_warehouse_code}</span>
                    ) : (
                      <Select value={pick.lot} onValueChange={(v) => {
                        const lot = options.find((o) => lotKey(o) === v)
                        const suggested = lot ? Math.min(usable(lot), Number(line.outstanding_quantity)) : 0
                        set({ lot: v, qty: pick.qty || (lot ? String(isWholeUnit(line.unit) ? Math.floor(suggested) : suggested) : '') })
                      }}>
                        <SelectTrigger aria-label={`Lot for ${line.sku}`} className="h-8"><SelectValue placeholder="Select lot" /></SelectTrigger>
                        <SelectContent>
                          {options.map((o) => (
                            <SelectItem key={lotKey(o)} value={lotKey(o)}>
                              {o.location_code}{o.batch_number ? ` · ${o.batch_number}` : ''} · {STOCK_SOURCE_LABELS[o.source_type as StockSourceCode]} · usable {formatQty(usable(o))}
                              {(ownReserved.get(lotKey(o)) ?? 0) > 0 ? ` (incl. ${formatQty(ownReserved.get(lotKey(o)) ?? 0)} reserved for this order)` : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="p-2"><Input aria-label={`Quantity of ${line.sku}`} inputMode={qtyInputMode(line.unit)} className="h-8 w-28 text-right" value={pick.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {lines.length > issuable.length && <p className="mt-2 text-xs text-shortage">Lines with a unit conversion error cannot be issued.</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Consumption date" htmlFor="is-date"><Input id="is-date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Notes" htmlFor="is-notes"><Input id="is-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {over.length > 0 && (
          <Field label="Reason for issuing more than planned" htmlFor="is-over" full hint="Over-consumption requires the production exception permission.">
            <Textarea id="is-over" rows={2} maxLength={500} value={overReason} onChange={(e) => setOverReason(e.target.value)} />
          </Field>
        )}
      </div>
    </StockFormDialog>
  )
}

// ---------------------------------------------------------------------------
// Finished-goods output receipt
// ---------------------------------------------------------------------------
export function OutputDialog({
  order,
  open,
  onOpenChange,
  onPosted,
}: {
  order: ProductionOrderListRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: (message: string) => void
}) {
  const storage = useStorage()
  const product = useAsync(() => fetchProductFlags(order.finished_product_id), [order.finished_product_id])
  const [good, setGood] = useState('')
  const [rejected, setRejected] = useState('')
  const [scrap, setScrap] = useState('')
  const [chosenGoodLoc, setGoodLoc] = useState('')
  const [rejHandling, setRejHandling] = useState<'STOCK' | 'RECORD'>('STOCK')
  const [rejLoc, setRejLoc] = useState('')
  const [batch, setBatch] = useState('')
  const [mfg, setMfg] = useState('')
  const [expiry, setExpiry] = useState('')
  const [date, setDate] = useState(today)
  const [cost, setCost] = useState('')
  const [quality, setQuality] = useState<QualityStatus>('NOT_INSPECTED')
  const [rejReason, setRejReason] = useState('')
  const [overReason, setOverReason] = useState('')
  const [notes, setNotes] = useState('')

  const goodLocations = storage.activeLocations.filter((l) => l.warehouseId === order.destination_warehouse_id && l.usage === 'STORAGE')
  const rejectLocations = storage.activeLocations.filter((l) => l.usage === 'REJECTED')
  const goodLoc = chosenGoodLoc || goodLocations.find((l) => storage.locationById.get(l.id)?.is_default)?.id || goodLocations[0]?.id || ''
  const qty = (v: string) => parseNonNegativeQty(v, order.unit)
  const g = qty(good)
  const r = qty(rejected)
  const s = qty(scrap)
  const total = (g ?? 0) + (r ?? 0) + (s ?? 0)
  const remaining = Math.max(Number(order.planned_quantity) - Number(order.actual_quantity), 0)
  const isOver = total > remaining
  const u = order.unit

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Record output for ${order.production_order_number}`}
      description={`Good output is added to ${order.destination_warehouse_code} as in-house stock. Rejected goods are never added to sellable stock; scrap is recorded only.`}
      validate={() => {
        if (g === null || r === null || s === null) return `Quantities must be zero or more (${quantityRule(u)}).`
        if (total <= 0) return 'Enter the good, rejected and/or scrap quantity.'
        if (g > 0 && !goodLoc) return 'Select the storage location for good output.'
        if (r > 0 && rejHandling === 'STOCK' && !rejLoc) return 'Select the rejected-goods location, or choose to record rejects only.'
        if ((r > 0 || s > 0) && rejReason.trim().length < 3) return 'Enter the reason for the rejected / scrap quantity.'
        if ((g > 0 || (r > 0 && rejHandling === 'STOCK')) && product.data?.track_batches && !batch.trim()) return 'This product is batch-tracked: enter the batch number.'
        if (product.data?.track_expiry && !expiry && (g > 0 || (r > 0 && rejHandling === 'STOCK'))) return 'This product tracks expiry: enter the expiry date.'
        if (cost && (Number.isNaN(Number(cost)) || Number(cost) < 0)) return 'Unit cost must be zero or more.'
        if (isOver && overReason.trim().length < 5) return `This exceeds the remaining planned quantity (${formatQty(remaining, u)}): document the reason (requires exception approval rights).`
        if (date > today()) return 'The production date cannot be in the future.'
        return null
      }}
      review={() => [
        { label: 'Good (to stock)', value: g ? `${formatQty(g, u)} → ${storage.locationLabel(goodLoc)}` : '—' },
        { label: 'Rejected', value: r ? `${formatQty(r, u)} — ${rejHandling === 'STOCK' ? storage.locationLabel(rejLoc) + ' (non-saleable)' : 'recorded only, not stocked'}` : '—' },
        { label: 'Scrap (recorded only)', value: s ? formatQty(s, u) : '—' },
        { label: 'Batch', value: batch || (product.data?.track_batches ? '' : 'Not batch-tracked') },
        { label: 'Production date', value: date },
        { label: 'Quality', value: QUALITY_STATUS_LABELS[quality] },
        { label: 'Unit cost', value: cost ? `₹${cost}` : 'Not recorded (unknown)' },
        ...(isOver ? [{ label: 'Over-production reason', value: overReason }] : []),
      ]}
      confirmLabel="Post output"
      submit={async (key) => {
        const result = await receiveOutput(
          {
            orderId: order.id,
            goodQuantity: g ?? 0,
            rejectedQuantity: r ?? 0,
            scrapQuantity: s ?? 0,
            goodLocationId: g ? goodLoc : null,
            rejectedLocationId: r && rejHandling === 'STOCK' ? rejLoc : null,
            batchNumber: batch.trim() || null,
            manufacturingDate: mfg || null,
            expiryDate: expiry || null,
            productionDate: date,
            unitCost: cost === '' ? null : Number(cost),
            qualityStatus: quality,
            rejectionReason: rejReason.trim() || null,
            overProductionReason: isOver ? overReason.trim() : null,
            notes: notes.trim() || null,
          },
          key,
        )
        onPosted(`Posted ${result.receipt_number}.`)
        setGood('')
        setRejected('')
        setScrap('')
        setRejReason('')
        setOverReason('')
        setNotes('')
        return result.receipt_number
      }}
    >
      <p className="mb-3 text-xs text-muted-foreground">
        Planned {formatQty(order.planned_quantity, u)} · recorded so far {formatQty(order.actual_quantity, u)} (good {formatQty(order.completed_quantity)}) · remaining {formatQty(remaining, u)}
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={`Good quantity (${u})`} htmlFor="out-good"><Input id="out-good" inputMode={qtyInputMode(u)} value={good} onChange={(e) => setGood(e.target.value)} /></Field>
        <Field label={`Rejected (${u})`} htmlFor="out-rej"><Input id="out-rej" inputMode={qtyInputMode(u)} value={rejected} onChange={(e) => setRejected(e.target.value)} /></Field>
        <Field label={`Scrap (${u})`} htmlFor="out-scrap"><Input id="out-scrap" inputMode={qtyInputMode(u)} value={scrap} onChange={(e) => setScrap(e.target.value)} /></Field>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Good output to (storage location)" htmlFor="out-loc" full>
          <Select value={goodLoc} onValueChange={setGoodLoc}>
            <SelectTrigger id="out-loc"><SelectValue placeholder="Select location" /></SelectTrigger>
            <SelectContent>{goodLocations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {(r ?? 0) > 0 && (
          <>
            <Field label="Rejected goods" htmlFor="out-rej-handling">
              <Select value={rejHandling} onValueChange={(v) => setRejHandling(v as 'STOCK' | 'RECORD')}>
                <SelectTrigger id="out-rej-handling"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="STOCK">Keep in a rejected-goods location</SelectItem>
                  <SelectItem value="RECORD">Record only (not kept in stock)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {rejHandling === 'STOCK' && (
              <Field label="Rejected-goods location" htmlFor="out-rej-loc">
                <Select value={rejLoc} onValueChange={setRejLoc}>
                  <SelectTrigger id="out-rej-loc"><SelectValue placeholder={rejectLocations.length ? 'Select location' : 'None set up'} /></SelectTrigger>
                  <SelectContent>
                    {rejectLocations.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">Create a location used for rejected goods in Warehouses &amp; Locations.</div>}
                    {rejectLocations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </>
        )}
        {((r ?? 0) > 0 || (s ?? 0) > 0) && (
          <Field label="Reason for rejection / scrap" htmlFor="out-rej-reason" full>
            <Input id="out-rej-reason" maxLength={500} value={rejReason} onChange={(e) => setRejReason(e.target.value)} />
          </Field>
        )}
        <Field label={`Batch / lot number${product.data?.track_batches ? ' (required)' : ''}`} htmlFor="out-batch">
          <Input id="out-batch" maxLength={50} value={batch} onChange={(e) => setBatch(e.target.value)} disabled={product.data ? !product.data.track_batches : false}
            placeholder={product.data && !product.data.track_batches ? 'Not batch-tracked' : ''} />
        </Field>
        <Field label="Production date" htmlFor="out-date"><Input id="out-date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {product.data?.track_batches && (
          <>
            <Field label="Manufacturing date (optional)" htmlFor="out-mfg"><Input id="out-mfg" type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} /></Field>
            <Field label={`Expiry date${product.data.track_expiry ? ' (required)' : ''}`} htmlFor="out-exp"><Input id="out-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
          </>
        )}
        <Field label="Quality status" htmlFor="out-quality" hint="The quality module is not built yet; record the inspection outcome here.">
          <Select value={quality} onValueChange={(v) => setQuality(v as QualityStatus)}>
            <SelectTrigger id="out-quality"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(QUALITY_STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Unit cost (₹, optional)" htmlFor="out-cost" hint="Only if reliably determined. Leave blank if unknown; it is never assumed to be zero.">
          <Input id="out-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        {isOver && (
          <Field label="Reason for exceeding the planned quantity" htmlFor="out-over" full hint="Over-production requires the production exception permission.">
            <Textarea id="out-over" rows={2} maxLength={500} value={overReason} onChange={(e) => setOverReason(e.target.value)} />
          </Field>
        )}
        <Field label="Notes" htmlFor="out-notes" full><Input id="out-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </StockFormDialog>
  )
}
