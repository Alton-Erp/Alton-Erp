import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { STOCK_SOURCE_LABELS, formatQty, type StockSourceCode } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { Field, StockFormDialog } from '@/features/inventory/stock-dialogs'
import { useStorage } from '@/features/inventory/use-storage'
import { parseUnitQty, planQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { DISPOSITION_LABELS, OUTSOURCING_TYPE_LABELS, parseNonNegativeQty } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import type { ProductOption } from '@/services/inventory'
import {
  fetchEffectiveBoms,
  fetchLotsAtLocation,
  fetchProductFlags,
  fetchUsableLots,
  moveOutsourcingMaterials,
  receiveOutsourcedGoods,
  saveOutsourcingOrder,
} from '@/services/production'
import type { StockDetailRow } from '@/types/database-inventory'
import type { OutsourcingMaterialListRow, OutsourcingOrderListRow, OutsourcingType, RejectionDisposition } from '@/types/database-production'

const today = () => toIsoDate(new Date())
const lotKey = (l: { batch_id: string; location_id: string }) => `${l.batch_id}|${l.location_id}`
const lotLabel = (l: StockDetailRow, qty: number) =>
  `${l.warehouse_code} / ${l.location_code}${l.batch_number ? ` · ${l.batch_number}` : ''} · ${STOCK_SOURCE_LABELS[l.source_type as StockSourceCode]} · ${formatQty(qty, l.base_unit)}`

// ---------------------------------------------------------------------------
// Create / edit a draft outsourcing order
// ---------------------------------------------------------------------------
interface MaterialLine {
  key: string
  product: ProductOption | null
  quantity: string
}

export function OutsourcingOrderDialog({
  order,
  materials,
  onClose,
  onSaved,
}: {
  order: OutsourcingOrderListRow | null
  materials: OutsourcingMaterialListRow[]
  onClose: () => void
  onSaved: (r: { order_id: string; outsourcing_order_number: string }) => void
}) {
  const storage = useStorage()
  const { key, renew } = useRequestKey()
  const [now] = useState(today)
  const [type, setType] = useState<OutsourcingType>(order?.order_type ?? 'OUTSOURCED_FINISHED_GOODS')
  const [product, setProduct] = useState<ProductOption | null>(
    order ? { product_id: order.product_id, sku: order.sku, product_name: order.product_name, base_unit: order.unit, track_batches: false, track_expiry: false } : null,
  )
  const boms = useAsync(() => (product ? fetchEffectiveBoms(now, product.product_id) : Promise.resolve([])), [product?.product_id, now])
  const [bomId, setBomId] = useState(order?.bom_id ?? 'none')
  const [qty, setQty] = useState(order ? String(order.ordered_quantity) : '')
  const [supplier, setSupplier] = useState(order?.supplier_name ?? '')
  const [supplierRef, setSupplierRef] = useState(order?.supplier_reference ?? '')
  const [expected, setExpected] = useState(order?.expected_return_date ?? '')
  const [chosenDest, setDest] = useState(order?.destination_warehouse_id ?? '')
  const [ext, setExt] = useState(order?.external_location_id ?? '')
  const [reference, setReference] = useState(order?.reference_number ?? '')
  const [cost, setCost] = useState(order?.unit_cost !== null && order?.unit_cost !== undefined ? String(order.unit_cost) : '')
  const [notes, setNotes] = useState(order?.notes ?? '')
  const [lines, setLines] = useState<MaterialLine[]>(
    order && !order.bom_id
      ? materials.map((m) => ({ key: m.id, product: { product_id: m.component_product_id, sku: m.sku, product_name: m.product_name, base_unit: m.inventory_unit, track_batches: false, track_expiry: false }, quantity: String(m.planned_quantity) }))
      : [],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeWarehouses = storage.warehouses.filter((w) => w.status === 'ACTIVE')
  const dest = chosenDest || activeWarehouses.find((w) => w.is_default)?.id || ''
  const externalLocations = storage.activeLocations.filter((l) => l.usage === 'EXTERNAL_PROCESSING')
  const useBom = bomId !== 'none' && Boolean(boms.data?.some((b) => b.id === bomId))
  const filled = lines.filter((l) => l.product || l.quantity.trim())
  const hasMaterials = useBom || filled.length > 0

  const save = async () => {
    setError(null)
    const q = parseUnitQty(qty, product?.base_unit)
    if (!product) return setError('Select the product to be supplied or processed.')
    if (!q) return setError(`Enter an ordered quantity greater than zero (${quantityRule(product.base_unit)}).`)
    if (!supplier.trim()) return setError('Enter the supplier (name / reference until the supplier master exists).')
    if (!expected) return setError('Enter the expected return / delivery date.')
    if (!dest) return setError('Select the destination warehouse.')
    if (type === 'OUTSOURCED_PROCESSING' && !hasMaterials) return setError('A processing order needs the company materials to send (a BOM or a material list).')
    if (hasMaterials && !ext) return setError('Select the external-processing location where material held by this supplier is tracked.')
    for (const [i, l] of filled.entries()) {
      if (!l.product) return setError(`Material line ${i + 1}: select the material.`)
      if (!parseUnitQty(l.quantity, l.product.base_unit)) return setError(`Material line ${i + 1}: enter a quantity greater than zero (${quantityRule(l.product.base_unit)}).`)
    }
    if (cost && (Number.isNaN(Number(cost)) || Number(cost) < 0)) return setError('Unit cost must be zero or more.')
    setBusy(true)
    try {
      const r = await saveOutsourcingOrder(
        {
          orderId: order?.id ?? null,
          orderType: type,
          productId: product.product_id,
          bomId: useBom ? bomId : null,
          orderedQuantity: q,
          supplierName: supplier.trim(),
          supplierReference: supplierRef.trim() || null,
          expectedReturnDate: expected,
          destinationWarehouseId: dest,
          externalLocationId: hasMaterials ? ext : null,
          referenceNumber: reference.trim() || null,
          unitCost: cost === '' ? null : Number(cost),
          notes: notes.trim() || null,
          materials: useBom ? [] : filled.map((l) => ({ product_id: l.product!.product_id, quantity: parseUnitQty(l.quantity, l.product!.base_unit)! })),
        },
        key,
      )
      renew()
      onSaved(r)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{order ? `Edit ${order.outsourcing_order_number}` : 'New outsourcing order'}</DialogTitle>
          <DialogDescription>Saved as a draft for approval. Nothing is dispatched or received until those steps are posted.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1 sm:grid-cols-2">
          <Field label="Order type" htmlFor="oo-type">
            <Select value={type} onValueChange={(v) => setType(v as OutsourcingType)}>
              <SelectTrigger id="oo-type"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(OUTSOURCING_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Product to be supplied / produced" htmlFor="oo-product">
            <ProductPicker id="oo-product" value={product} onChange={(p) => { setProduct(p); setBomId('none') }} />
          </Field>
          <Field label={`Ordered quantity${product ? ` (${product.base_unit})` : ''}`} htmlFor="oo-qty"><Input id="oo-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="Expected return / delivery" htmlFor="oo-expected"><Input id="oo-expected" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
          <Field label="Supplier" htmlFor="oo-supplier" hint="The supplier master is not built yet: enter the supplier's name. It is stored as a controlled reference, not a supplier record.">
            <Input id="oo-supplier" maxLength={200} value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </Field>
          <Field label="Supplier reference (optional)" htmlFor="oo-supref" hint="e.g. vendor code or GSTIN"><Input id="oo-supref" maxLength={100} value={supplierRef} onChange={(e) => setSupplierRef(e.target.value)} /></Field>
          <Field label="Goods received into (warehouse)" htmlFor="oo-dest">
            <Select value={dest} onValueChange={setDest}>
              <SelectTrigger id="oo-dest"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
              <SelectContent>{activeWarehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label={type === 'OUTSOURCED_PROCESSING' ? 'Agreed processing charge per unit (₹, optional)' : 'Agreed price per unit (₹, optional)'} htmlFor="oo-cost"
            hint="Used for costing only when recorded; never assumed.">
            <Input id="oo-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
          <Field label="Company material to send" htmlFor="oo-bom" full
            hint={type === 'OUTSOURCED_PROCESSING' ? 'Required for processing orders: from the product\'s approved BOM, or listed manually.' : 'Optional: only if you supply material (e.g. packaging) for bought-in goods.'}>
            <Select value={useBom ? bomId : 'none'} onValueChange={setBomId}>
              <SelectTrigger id="oo-bom"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{filled.length ? 'Manual material list (below)' : 'No BOM — list materials manually or none'}</SelectItem>
                {(boms.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>From BOM {b.bom_code} v{b.version} (scaled to the ordered quantity)</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {!useBom && (
            <div className="space-y-2 sm:col-span-2">
              {lines.map((l, i) => (
                <div key={l.key} className="flex items-start gap-2">
                  <div className="flex-1"><ProductPicker value={l.product} onChange={(p) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, product: p } : x)))} /></div>
                  <Input aria-label={`Material quantity ${i + 1}`} className="w-32 text-right" inputMode={qtyInputMode(l.product?.base_unit)} placeholder={l.product?.base_unit ?? 'Qty'} value={l.quantity}
                    onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))} />
                  <Button variant="ghost" size="icon" aria-label={`Remove material ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), product: null, quantity: '' }])}><Plus /> Add material</Button>
            </div>
          )}
          {hasMaterials && (
            <Field label="Material held at (external-processing location)" htmlFor="oo-ext" full
              hint="Dispatched material stays company stock at this location until it is returned or used by the supplier.">
              <Select value={ext} onValueChange={setExt}>
                <SelectTrigger id="oo-ext"><SelectValue placeholder={externalLocations.length ? 'Select location' : 'None set up'} /></SelectTrigger>
                <SelectContent>
                  {externalLocations.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">Create a location "Held by outside processor" in Warehouses &amp; Locations.</div>}
                  {externalLocations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label="Reference (optional)" htmlFor="oo-ref"><Input id="oo-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
          <Field label="Notes" htmlFor="oo-notes"><Textarea id="oo-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {order ? 'Save draft' : 'Create draft order'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Dispatch material to / record material returned by the supplier
// ---------------------------------------------------------------------------
export function MaterialMoveDialog({
  order,
  materials,
  mode,
  open,
  onOpenChange,
  onPosted,
}: {
  order: OutsourcingOrderListRow
  materials: OutsourcingMaterialListRow[]
  mode: 'DISPATCH' | 'RETURN'
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: (message: string) => void
}) {
  const storage = useStorage()
  const productIds = materials.map((m) => m.component_product_id)
  const lots = useAsync(
    () => (!open ? Promise.resolve([]) : mode === 'DISPATCH' ? fetchUsableLots(productIds, null) : fetchLotsAtLocation(productIds, order.external_location_id ?? '')),
    [open, mode, order.id, productIds.join(',')],
  )
  const [picks, setPicks] = useState<Record<string, { lot: string; qty: string }>>({})
  const [returnTo, setReturnTo] = useState('')
  const [date, setDate] = useState(today)
  const [overReason, setOverReason] = useState('')
  const [notes, setNotes] = useState('')
  const storageLocations = storage.activeLocations.filter((l) => l.usage === 'STORAGE')
  const lotsFor = (productId: string) => (lots.data ?? []).filter((l) => l.product_id === productId && (mode === 'RETURN' || Number(l.available) > 0))
  const qtyOf = (l: StockDetailRow) => (mode === 'DISPATCH' ? Number(l.available) : Number(l.on_hand))

  const chosen = materials
    .map((m) => {
      const p = picks[m.id]
      const lot = p?.lot ? lotsFor(m.component_product_id).find((l) => lotKey(l) === p.lot) : undefined
      return { m, lot, qty: p ? parseUnitQty(p.qty, m.unit) : null, raw: p?.qty ?? '' }
    })
    .filter((c) => c.raw.trim() !== '')
  const over = mode === 'DISPATCH' ? chosen.filter((c) => c.qty !== null && Number(c.m.dispatched_quantity) - Number(c.m.returned_quantity) + c.qty > Number(c.m.planned_quantity)) : []

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'DISPATCH' ? `Send material to ${order.supplier_name}` : `Material returned by ${order.supplier_name}`}
      description={mode === 'DISPATCH'
        ? `Transfers company stock to ${order.external_location_code ?? 'the supplier location'}. Ownership does not change; nothing is consumed or purchased.`
        : `Transfers unused material from ${order.external_location_code ?? 'the supplier location'} back into storage.`}
      validate={() => {
        if (chosen.length === 0) return 'Enter a quantity for at least one material.'
        if (mode === 'RETURN' && !returnTo) return 'Select the storage location the material returns to.'
        for (const c of chosen) {
          if (!c.lot) return `${c.m.sku}: choose the lot.`
          if (!c.qty) return `${c.m.sku}: enter a quantity greater than zero (${quantityRule(c.m.unit)}).`
          if (c.qty > qtyOf(c.lot)) return `${c.m.sku}: only ${formatQty(qtyOf(c.lot), c.m.unit)} at the chosen lot.`
          if (mode === 'RETURN' && c.qty > Number(c.m.held_quantity)) return `${c.m.sku}: only ${formatQty(c.m.held_quantity, c.m.unit)} is held for this order.`
        }
        if (over.length && overReason.trim().length < 5) return 'Some quantities exceed the plan: document the reason (requires exception approval rights).'
        if (date > today()) return 'The date cannot be in the future.'
        return null
      }}
      review={() => [
        ...chosen.map((c) => ({ label: c.m.sku, value: `${formatQty(c.qty, c.m.unit)} · ${c.lot ? lotLabel(c.lot, c.qty ?? 0).split(' · ').slice(0, 2).join(' · ') : ''}` })),
        ...(mode === 'RETURN' ? [{ label: 'Returned to', value: storage.locationLabel(returnTo) }] : [{ label: 'Sent to', value: order.external_location_code ?? '' }]),
        { label: 'Date', value: date },
      ]}
      confirmLabel={mode === 'DISPATCH' ? 'Post dispatch' : 'Post return'}
      submit={async (key) => {
        const r = await moveOutsourcingMaterials(
          {
            orderId: order.id,
            movementType: mode,
            lines: chosen.map((c) => ({ order_material_id: c.m.id, batch_id: c.lot!.batch_id, location_id: mode === 'DISPATCH' ? c.lot!.location_id : returnTo, quantity: c.qty! })),
            movementDate: date,
            overReason: over.length ? overReason.trim() : null,
            notes: notes.trim() || null,
          },
          key,
        )
        onPosted(`${mode === 'DISPATCH' ? 'Dispatched' : 'Returned'}: ${r.transaction_numbers.join(', ')}.`)
        setPicks({})
        return r.transaction_numbers.join(', ')
      }}
    >
      {lots.error && <p className="mb-3 text-sm text-shortage">{describeDataError(lots.error)}</p>}
      <div className="max-h-[45vh] overflow-y-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted/60 text-xs text-muted-foreground">
            <tr><th className="p-2 text-left">Material</th><th className="p-2 text-right">{mode === 'DISPATCH' ? 'Planned / sent' : 'Held'}</th><th className="p-2 text-left">{mode === 'DISPATCH' ? 'From lot / location' : 'Lot at supplier'}</th><th className="p-2 text-right">Quantity</th></tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const options = lotsFor(m.component_product_id)
              const pick = picks[m.id] ?? { lot: '', qty: '' }
              const set = (patch: Partial<typeof pick>) => setPicks((p) => ({ ...p, [m.id]: { ...pick, ...patch } }))
              return (
                <tr key={m.id} className="border-t align-top">
                  <td className="p-2"><span className="font-medium">{m.sku}</span><div className="text-xs text-muted-foreground">{m.product_name}</div></td>
                  <td className="p-2 text-right tabular-nums">{mode === 'DISPATCH' ? `${formatQty(m.planned_quantity)} / ${formatQty(Number(m.dispatched_quantity) - Number(m.returned_quantity))}` : formatQty(m.held_quantity, m.unit)}</td>
                  <td className="p-2">
                    {lots.loading ? <span className="text-xs text-muted-foreground">Loading…</span> : options.length === 0 ? <span className="text-xs text-shortage">No stock</span> : (
                      <Select value={pick.lot} onValueChange={(v) => set({ lot: v })}>
                        <SelectTrigger aria-label={`Lot for ${m.sku}`} className="h-8"><SelectValue placeholder="Select lot" /></SelectTrigger>
                        <SelectContent>{options.map((o) => <SelectItem key={lotKey(o)} value={lotKey(o)}>{lotLabel(o, qtyOf(o))}</SelectItem>)}</SelectContent>
                      </Select>
                    )}
                  </td>
                  <td className="p-2"><Input aria-label={`Quantity of ${m.sku}`} inputMode={qtyInputMode(m.unit)} className="h-8 w-28 text-right" value={pick.qty} onChange={(e) => set({ qty: e.target.value })} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {mode === 'RETURN' && (
          <Field label="Return into (storage location)" htmlFor="mv-to" full>
            <Select value={returnTo} onValueChange={setReturnTo}>
              <SelectTrigger id="mv-to"><SelectValue placeholder="Select location" /></SelectTrigger>
              <SelectContent>{storageLocations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        <Field label="Date" htmlFor="mv-date"><Input id="mv-date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Notes (e.g. delivery challan)" htmlFor="mv-notes"><Input id="mv-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {over.length > 0 && (
          <Field label="Reason for sending more than planned" htmlFor="mv-over" full hint="Requires the production exception permission.">
            <Textarea id="mv-over" rows={2} maxLength={500} value={overReason} onChange={(e) => setOverReason(e.target.value)} />
          </Field>
        )}
      </div>
    </StockFormDialog>
  )
}

// ---------------------------------------------------------------------------
// Goods received from the supplier
// ---------------------------------------------------------------------------
export function OutsourcedReceiptDialog({
  order,
  materials,
  open,
  onOpenChange,
  onPosted,
}: {
  order: OutsourcingOrderListRow
  materials: OutsourcingMaterialListRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onPosted: (message: string) => void
}) {
  const storage = useStorage()
  const product = useAsync(() => fetchProductFlags(order.product_id), [order.product_id])
  const held = materials.filter((m) => Number(m.held_quantity) > 0)
  const extLots = useAsync(
    () => (open && order.external_location_id && held.length ? fetchLotsAtLocation(held.map((m) => m.component_product_id), order.external_location_id) : Promise.resolve([])),
    [open, order.id, held.map((m) => m.id).join(',')],
  )
  const [received, setReceived] = useState('')
  const [accepted, setAccepted] = useState('')
  const [rejected, setRejected] = useState('0')
  const [chosenLoc, setLoc] = useState('')
  const [rejHandling, setRejHandling] = useState<'STOCK' | 'RECORD'>('RECORD')
  const [rejLoc, setRejLoc] = useState('')
  const [disposition, setDisposition] = useState<RejectionDisposition>('RETURN_TO_SUPPLIER')
  const [rejReason, setRejReason] = useState('')
  const [batch, setBatch] = useState('')
  const [mfg, setMfg] = useState('')
  const [expiry, setExpiry] = useState('')
  const [date, setDate] = useState(today)
  const [cost, setCost] = useState(order.order_type === 'OUTSOURCED_FINISHED_GOODS' && order.unit_cost !== null ? String(order.unit_cost) : '')
  const [docNo, setDocNo] = useState('')
  const [overReason, setOverReason] = useState('')
  const [notes, setNotes] = useState('')
  const [use, setUse] = useState<Record<string, { lot: string; qty: string }>>({})

  const storageLocations = storage.activeLocations.filter((l) => l.warehouseId === order.destination_warehouse_id && l.usage === 'STORAGE')
  const loc = chosenLoc || storageLocations.find((l) => storage.locationById.get(l.id)?.is_default)?.id || storageLocations[0]?.id || ''
  const rejectLocations = storage.activeLocations.filter((l) => l.usage === 'REJECTED')
  const recv = parseUnitQty(received, order.unit)
  const acc = parseNonNegativeQty(accepted, order.unit)
  const rej = parseNonNegativeQty(rejected, order.unit)
  const pending = Math.max(Number(order.ordered_quantity) - Number(order.received_quantity), 0)
  const isOver = recv !== null && recv > pending
  const u = order.unit
  const lotsFor = (productId: string) => (extLots.data ?? []).filter((l) => l.product_id === productId)

  // Suggested consumption: the material's share of the planned quantity for what was received.
  const suggestion = useMemo(() => {
    const m = new Map<string, number>()
    if (!recv) return m
    for (const h of held) {
      const per = h.quantity_per_unit !== null ? Number(h.quantity_per_unit) : Number(h.planned_quantity) / Number(order.ordered_quantity)
      m.set(h.id, Math.min(planQty(per * recv, h.unit), Number(h.held_quantity)))
    }
    return m
  }, [recv, held, order.ordered_quantity])

  const consumption = held
    .map((h) => {
      const p = use[h.id]
      const options = lotsFor(h.component_product_id)
      const lot = p?.lot ? options.find((l) => lotKey(l) === p.lot) : options.length === 1 ? options[0] : undefined
      const raw = p?.qty ?? (suggestion.get(h.id) ? String(suggestion.get(h.id)) : '')
      return { h, lot, qty: raw.trim() === '' ? null : parseUnitQty(raw, h.unit), raw }
    })
    .filter((c) => c.raw.trim() !== '' && c.raw.trim() !== '0')

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Receive goods from ${order.supplier_name}`}
      description={`${order.outsourcing_order_number}: ${order.sku}. Only accepted goods are added to usable stock (source: outsourced).`}
      validate={() => {
        if (!recv) return `Enter the quantity received (greater than zero, ${quantityRule(u)}).`
        if (acc === null || rej === null) return `Accepted and rejected must be zero or more (${quantityRule(u)}).`
        if (acc + rej > recv) return 'Accepted plus rejected cannot exceed the quantity received.'
        if (acc + rej < recv) return `Classify every received unit: ${formatQty(recv - acc - rej, u)} is neither accepted nor rejected.`
        if (acc > 0 && !loc) return 'Select the storage location for accepted goods.'
        if (rej > 0 && rejReason.trim().length < 3) return 'Enter the reason for the rejection.'
        if (rej > 0 && rejHandling === 'STOCK' && !rejLoc) return 'Select the rejected-goods location, or record the rejects only.'
        if ((acc > 0 || (rej > 0 && rejHandling === 'STOCK')) && product.data?.track_batches && !batch.trim()) return 'This product is batch-tracked: enter the batch number.'
        if ((acc > 0 || (rej > 0 && rejHandling === 'STOCK')) && product.data?.track_expiry && !expiry) return 'This product tracks expiry: enter the expiry date.'
        if (order.order_type === 'OUTSOURCED_PROCESSING' && consumption.length === 0) return 'Record the company material the supplier used for these goods.'
        for (const c of consumption) {
          if (!c.lot) return `${c.h.sku}: choose the lot held at the supplier.`
          if (!c.qty) return `${c.h.sku}: consumed quantity must be greater than zero (${quantityRule(c.h.unit)}).`
          if (c.qty > Number(c.h.held_quantity)) return `${c.h.sku}: only ${formatQty(c.h.held_quantity, c.h.unit)} is held at the supplier.`
        }
        if (cost && (Number.isNaN(Number(cost)) || Number(cost) < 0)) return 'Unit cost must be zero or more.'
        if (isOver && overReason.trim().length < 5) return `This exceeds the outstanding quantity (${formatQty(pending, u)}): document the reason (requires exception approval rights).`
        if (date > today()) return 'The receipt date cannot be in the future.'
        return null
      }}
      review={() => [
        { label: 'Received', value: formatQty(recv, u) },
        { label: 'Accepted (to stock)', value: acc ? `${formatQty(acc, u)} → ${storage.locationLabel(loc)}` : '—' },
        { label: 'Rejected', value: rej ? `${formatQty(rej, u)} · ${DISPOSITION_LABELS[disposition]} · ${rejHandling === 'STOCK' ? storage.locationLabel(rejLoc) : 'not stocked'}` : '—' },
        ...consumption.map((c) => ({ label: `Used by supplier: ${c.h.sku}`, value: formatQty(c.qty, c.h.unit) })),
        { label: 'Batch', value: batch || (product.data?.track_batches ? '' : 'Not batch-tracked') },
        { label: 'Unit cost', value: cost ? `₹${cost}` : 'Not recorded (unknown)' },
        { label: 'Supplier document', value: docNo },
      ]}
      confirmLabel="Post receipt"
      submit={async (key) => {
        const r = await receiveOutsourcedGoods(
          {
            orderId: order.id,
            receivedQuantity: recv!,
            acceptedQuantity: acc ?? 0,
            rejectedQuantity: rej ?? 0,
            acceptedLocationId: acc ? loc : null,
            rejectedLocationId: rej && rejHandling === 'STOCK' ? rejLoc : null,
            batchNumber: batch.trim() || null,
            manufacturingDate: mfg || null,
            expiryDate: expiry || null,
            receiptDate: date,
            unitCost: cost === '' ? null : Number(cost),
            supplierDocumentNumber: docNo.trim() || null,
            rejectionDisposition: rej ? disposition : null,
            rejectionReason: rej ? rejReason.trim() : null,
            overReceiptReason: isOver ? overReason.trim() : null,
            consumption: consumption.map((c) => ({ order_material_id: c.h.id, batch_id: c.lot!.batch_id, quantity: c.qty! })),
            notes: notes.trim() || null,
          },
          key,
        )
        onPosted(`Posted ${r.receipt_number}.`)
        setReceived('')
        setAccepted('')
        setRejected('0')
        setUse({})
        return r.receipt_number
      }}
    >
      <p className="mb-3 text-xs text-muted-foreground">
        Ordered {formatQty(order.ordered_quantity, u)} · received so far {formatQty(order.received_quantity)} (accepted {formatQty(order.accepted_quantity)}, rejected {formatQty(order.rejected_quantity)}) · outstanding {formatQty(pending, u)}
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={`Received (${u})`} htmlFor="or-recv"><Input id="or-recv" inputMode={qtyInputMode(u)} value={received} onChange={(e) => { setReceived(e.target.value); if (!accepted) setAccepted(e.target.value) }} /></Field>
        <Field label={`Accepted (${u})`} htmlFor="or-acc"><Input id="or-acc" inputMode={qtyInputMode(u)} value={accepted} onChange={(e) => setAccepted(e.target.value)} /></Field>
        <Field label={`Rejected (${u})`} htmlFor="or-rej"><Input id="or-rej" inputMode={qtyInputMode(u)} value={rejected} onChange={(e) => setRejected(e.target.value)} /></Field>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Accepted goods to (storage location)" htmlFor="or-loc" full>
          <Select value={loc} onValueChange={setLoc}>
            <SelectTrigger id="or-loc"><SelectValue placeholder="Select location" /></SelectTrigger>
            <SelectContent>{storageLocations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {(rej ?? 0) > 0 && (
          <>
            <Field label="What happens to the rejected goods" htmlFor="or-disp">
              <Select value={disposition} onValueChange={(v) => setDisposition(v as RejectionDisposition)}>
                <SelectTrigger id="or-disp"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(DISPOSITION_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Rejected goods are" htmlFor="or-rej-handling">
              <Select value={rejHandling} onValueChange={(v) => setRejHandling(v as 'STOCK' | 'RECORD')}>
                <SelectTrigger id="or-rej-handling"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="RECORD">Recorded only (e.g. sent back with the supplier)</SelectItem>
                  <SelectItem value="STOCK">Kept in a rejected-goods location</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {rejHandling === 'STOCK' && (
              <Field label="Rejected-goods location" htmlFor="or-rej-loc">
                <Select value={rejLoc} onValueChange={setRejLoc}>
                  <SelectTrigger id="or-rej-loc"><SelectValue placeholder="Select location" /></SelectTrigger>
                  <SelectContent>{rejectLocations.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            )}
            <Field label="Rejection reason" htmlFor="or-rej-reason"><Input id="or-rej-reason" maxLength={500} value={rejReason} onChange={(e) => setRejReason(e.target.value)} /></Field>
          </>
        )}
        <Field label={`Batch / lot number${product.data?.track_batches ? ' (required)' : ''}`} htmlFor="or-batch">
          <Input id="or-batch" maxLength={50} value={batch} onChange={(e) => setBatch(e.target.value)} disabled={product.data ? !product.data.track_batches : false}
            placeholder={product.data && !product.data.track_batches ? 'Not batch-tracked' : ''} />
        </Field>
        <Field label="Receipt date" htmlFor="or-date"><Input id="or-date" type="date" max={today()} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        {product.data?.track_batches && (
          <>
            <Field label="Manufacturing date (optional)" htmlFor="or-mfg"><Input id="or-mfg" type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} /></Field>
            <Field label={`Expiry date${product.data.track_expiry ? ' (required)' : ''}`} htmlFor="or-exp"><Input id="or-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
          </>
        )}
        <Field label="Supplier document / challan no." htmlFor="or-doc"><Input id="or-doc" maxLength={100} value={docNo} onChange={(e) => setDocNo(e.target.value)} /></Field>
        <Field label="Unit cost (₹, optional)" htmlFor="or-cost"
          hint={order.order_type === 'OUTSOURCED_PROCESSING' ? 'For processing, the full cost includes the company material used; leave blank unless known.' : 'Defaults to the agreed price on the order.'}>
          <Input id="or-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        {isOver && (
          <Field label="Reason for receiving more than ordered" htmlFor="or-over" full hint="Requires the production exception permission.">
            <Textarea id="or-over" rows={2} maxLength={500} value={overReason} onChange={(e) => setOverReason(e.target.value)} />
          </Field>
        )}
        <Field label="Notes" htmlFor="or-notes" full><Input id="or-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
      {held.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-sm font-medium">Company material used by the supplier{order.order_type === 'OUTSOURCED_PROCESSING' ? ' (required)' : ''}</p>
          <p className="mb-2 text-xs text-muted-foreground">Posted as consumption at the supplier location, so the material is not counted twice once the goods are back.</p>
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground"><tr><th className="p-1 text-left">Material</th><th className="p-1 text-right">Held</th><th className="p-1 text-left">Lot</th><th className="p-1 text-right">Used</th></tr></thead>
            <tbody>
              {held.map((h) => {
                const options = lotsFor(h.component_product_id)
                const cur = use[h.id] ?? { lot: options.length === 1 ? lotKey(options[0]) : '', qty: suggestion.get(h.id) ? String(suggestion.get(h.id)) : '' }
                return (
                  <tr key={h.id} className="border-t">
                    <td className="p-1">{h.sku}</td>
                    <td className="p-1 text-right tabular-nums">{formatQty(h.held_quantity, h.unit)}</td>
                    <td className="p-1">
                      <Select value={cur.lot} onValueChange={(v) => setUse((s) => ({ ...s, [h.id]: { ...cur, lot: v } }))}>
                        <SelectTrigger aria-label={`Lot used for ${h.sku}`} className="h-8"><SelectValue placeholder="Select lot" /></SelectTrigger>
                        <SelectContent>{options.map((o) => <SelectItem key={lotKey(o)} value={lotKey(o)}>{o.batch_number ?? STOCK_SOURCE_LABELS[o.source_type as StockSourceCode]} · {formatQty(o.on_hand)}</SelectItem>)}</SelectContent>
                      </Select>
                    </td>
                    <td className="p-1"><Input aria-label={`Used quantity of ${h.sku}`} className="h-8 w-28 text-right" inputMode={qtyInputMode(h.unit)} value={cur.qty}
                      onChange={(e) => setUse((s) => ({ ...s, [h.id]: { ...cur, qty: e.target.value } }))} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </StockFormDialog>
  )
}
