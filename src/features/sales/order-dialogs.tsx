import { AlertTriangle, Loader2, Plus, Trash2, UserPlus } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { QuickAddPartyDialog } from '@/features/ledger/party-form'
import { PRIORITY_LABELS, parseQty } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchCustomers } from '@/services/customer-po'
import type { ProductOption } from '@/services/inventory'
import { createManualOrder, createOrderFromPo, fetchPoCandidates, fetchPoConversionPreview, type CreateOrderResult } from '@/services/sales'
import type { Priority } from '@/types/database-sales'

const ErrorBox = ({ message }: { message: string | null }) =>
  message ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p> : null

interface HeaderState { requested: string; shipping: string; billing: string; reference: string; priority: Priority; warehouse: string; notes: string }

function HeaderFields({ value, onChange, idPrefix }: { value: HeaderState; onChange: (v: HeaderState) => void; idPrefix: string }) {
  const storage = useStorage()
  const set = (patch: Partial<HeaderState>) => onChange({ ...value, ...patch })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1"><Label htmlFor={`${idPrefix}-req`}>Requested delivery date</Label><Input id={`${idPrefix}-req`} type="date" value={value.requested} onChange={(e) => set({ requested: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor={`${idPrefix}-prio`}>Priority</Label>
        <Select value={value.priority} onValueChange={(v) => set({ priority: v as Priority })}><SelectTrigger id={`${idPrefix}-prio`}><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(PRIORITY_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1"><Label htmlFor={`${idPrefix}-wh`}>Fulfil from</Label>
        <Select value={value.warehouse} onValueChange={(v) => set({ warehouse: v })}><SelectTrigger id={`${idPrefix}-wh`}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="any">Any warehouse</SelectItem>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent></Select></div>
      <div className="space-y-1"><Label htmlFor={`${idPrefix}-ref`}>Customer reference</Label><Input id={`${idPrefix}-ref`} maxLength={100} value={value.reference} onChange={(e) => set({ reference: e.target.value })} /></div>
      <div className="space-y-1 sm:col-span-2"><Label htmlFor={`${idPrefix}-ship`}>Shipping address (snapshot for this order)</Label><Textarea id={`${idPrefix}-ship`} rows={2} maxLength={1000} value={value.shipping} onChange={(e) => set({ shipping: e.target.value })} /></div>
      <div className="space-y-1 sm:col-span-2"><Label htmlFor={`${idPrefix}-bill`}>Billing address (optional)</Label><Textarea id={`${idPrefix}-bill`} rows={2} maxLength={1000} value={value.billing} onChange={(e) => set({ billing: e.target.value })} /></div>
      <div className="space-y-1 sm:col-span-2"><Label htmlFor={`${idPrefix}-notes`}>Internal notes</Label><Textarea id={`${idPrefix}-notes`} rows={2} maxLength={2000} value={value.notes} onChange={(e) => set({ notes: e.target.value })} /></div>
    </div>
  )
}

const headerPayload = (h: HeaderState) => ({
  requested_delivery_date: h.requested || null,
  shipping_address: h.shipping.trim() || null,
  billing_address: h.billing.trim() || null,
  customer_reference: h.reference.trim() || null,
  priority: h.priority,
  warehouse_id: h.warehouse === 'any' ? null : h.warehouse,
  internal_notes: h.notes.trim() || null,
})

/** Converts a validated customer PO into a sales order (server re-validates everything). */
export function CreateFromPoDialog({ initialPoId, onClose, onCreated }: { initialPoId?: string | null; onClose: () => void; onCreated: (r: CreateOrderResult) => void }) {
  const { has } = usePermissions()
  const candidates = useAsync(fetchPoCandidates, [])
  const [poId, setPoId] = useState(initialPoId ?? '')
  const preview = useAsync(() => (poId ? fetchPoConversionPreview(poId) : Promise.resolve(null)), [poId])
  // User edits on top of the values suggested by the PO (reset when another PO is chosen).
  const [qtyEdits, setQty] = useState<Record<string, string>>({})
  const [headerEdit, setHeader] = useState<HeaderState | null>(null)
  const [split, setSplit] = useState(false)
  const [confirmNow, setConfirmNow] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const p = preview.data
  const qty: Record<string, string> = { ...Object.fromEntries((p?.lines ?? []).filter((l) => l.line_status === 'MATCHED').map((l) => [l.po_line_id, String(Number(l.convertible))])), ...qtyEdits }
  const header: HeaderState = headerEdit ?? { requested: p?.po.required_delivery_date ?? '', shipping: '', billing: '', reference: '', priority: 'NORMAL', warehouse: p?.po.fulfilment_warehouse_id ?? 'any', notes: '' }
  const choosePo = (id: string) => { setPoId(id); setQty({}); setHeader(null); setSplit(false); setError(null) }

  const activeSos = (p?.existing_sales_orders ?? []).filter((s) => s.order_status !== 'CANCELLED')
  const parsed = (p?.lines ?? []).map((l) => ({ line: l, value: parseQty(qty[l.po_line_id] ?? '0') }))
  const invalid = parsed.find((x) => x.value === null || (x.value ?? 0) > Number(x.line.convertible))
  const total = parsed.reduce((s, x) => s + (x.value ?? 0), 0)
  const blocked = !p || p.blockers.length > 0 || (activeSos.length > 0 && !split) || total === 0 || Boolean(invalid)

  const submit = async () => {
    if (!p) return
    setBusy(true); setError(null)
    try {
      const r = await createOrderFromPo({
        poId: p.po.po_id, header: headerPayload(header), split, confirm: confirmNow,
        lines: parsed.filter((x) => (x.value ?? 0) > 0).map((x) => ({ po_line_id: x.line.po_line_id, quantity: x.value as number })),
      }, key)
      renew()
      onCreated(r)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Create sales order from customer PO</DialogTitle>
          <DialogDescription>The PO's stock reservations move to the new order lines (nothing is reserved twice). Quantities can be lower than ordered for a split delivery; the rest stays on the PO for another order.</DialogDescription>
        </DialogHeader>
        <ErrorBox message={error} />
        <div className="space-y-1">
          <Label htmlFor="cpo-po">Customer PO</Label>
          <Select value={poId} onValueChange={choosePo}>
            <SelectTrigger id="cpo-po"><SelectValue placeholder={candidates.loading ? 'Loading POs…' : 'Select a matched customer PO'} /></SelectTrigger>
            <SelectContent className="max-h-80">
              {(candidates.data ?? []).length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No POs ready for conversion (all lines must be matched and valid, with quantity not yet on a sales order).</div>}
              {(candidates.data ?? []).map((c) => (
                <SelectItem key={c.po_id} value={c.po_id}>{c.customer_po_number}{c.revision > 1 ? ` rev ${c.revision}` : ''} · {c.customer_name} · {c.po_reference}{c.sales_orders ? ` · on ${c.sales_orders}` : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {preview.loading && poId && <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline size-4 animate-spin" />Checking the PO…</p>}
        {preview.error && <ErrorBox message={describeDataError(preview.error)} />}
        {p && (
          <div className="space-y-4">
            <dl className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">Customer</dt><dd className="font-medium">{p.po.customer_name}{p.po.customer_code ? ` (${p.po.customer_code})` : ' (external reference)'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Customer PO</dt><dd className="font-medium">{p.po.customer_po_number}{p.po.revision > 1 ? ` rev ${p.po.revision}` : ''} · {p.po.po_reference}</dd></div>
              <div><dt className="text-xs text-muted-foreground">PO date / required</dt><dd className="font-medium">{formatDate(p.po.po_date)} / {p.po.required_delivery_date ? formatDate(p.po.required_delivery_date) : '—'}</dd></div>
              <div className="sm:col-span-3"><dt className="text-xs text-muted-foreground">Source file</dt><dd>{p.po.source_filename ?? '—'}</dd></div>
            </dl>
            {p.blockers.length > 0 && (
              <ul className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {p.blockers.map((b) => <li key={b} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{b}</li>)}
              </ul>
            )}
            {activeSos.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                This PO already has sales order {activeSos.map((s) => s.sales_order_number).join(', ')}. Only quantity not yet on an order can be converted.
                <label className="mt-2 flex items-center gap-2 font-medium"><Checkbox checked={split} onCheckedChange={(v) => setSplit(v === true)} /> Create a separate (split) delivery order for the remaining quantity</label>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr>
                  <th className="pb-2 text-left">Line</th><th className="pb-2 text-left">Product</th><th className="pb-2 text-right">Ordered</th><th className="pb-2 text-right">Dispatched / on orders</th>
                  <th className="pb-2 text-right">Available to convert</th><th className="pb-2 text-left">Reserved by the PO (moves to the order)</th><th className="pb-2 text-right">Quantity</th>
                </tr></thead>
                <tbody>
                  {p.lines.map((l) => (
                    <tr key={l.po_line_id} className="border-t align-top">
                      <td className="py-2">{l.line_no}</td>
                      <td className="py-2">{l.sku ? <>{l.sku}<span className="block text-xs text-muted-foreground">{l.product_name}</span></> : <span className="text-shortage">not matched</span>}</td>
                      <td className="py-2 text-right">{formatQty(l.quantity_ordered, l.unit ?? undefined)}</td>
                      <td className="py-2 text-right">{formatQty(Number(l.dispatched_by_po) + Number(l.converted))}</td>
                      <td className="py-2 text-right">{formatQty(l.convertible)}</td>
                      <td className="py-2 text-xs">{l.reservations.length === 0 ? <span className="text-muted-foreground">none — allocate on the order</span> : l.reservations.map((r) => (
                        <span key={r.reservation_number} className="block">{r.reservation_number}: {formatQty(r.remaining)} at {r.warehouse_code}/{r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''}</span>
                      ))}</td>
                      <td className="py-2 text-right">
                        {l.line_status === 'MATCHED' ? (
                          <Input aria-label={`Quantity for line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={qty[l.po_line_id] ?? ''}
                            onChange={(e) => setQty((q) => ({ ...q, [l.po_line_id]: e.target.value }))} />
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {invalid && <p className="mt-1 text-sm text-shortage">Line {invalid.line.line_no}: enter a quantity between 0 and {formatQty(invalid.line.convertible)} (up to 3 decimals).</p>}
            </div>
            <HeaderFields value={header} onChange={setHeader} idPrefix="cpo" />
            {has('sales_orders.confirm') && (
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmNow} onCheckedChange={(v) => setConfirmNow(v === true)} /> Confirm the order now (otherwise it waits for confirmation)</label>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={blocked || busy} onClick={() => setAsking(true)}>{busy && <Loader2 className="animate-spin" />} Create sales order</Button>
        </DialogFooter>
        <ConfirmDialog open={asking} onOpenChange={setAsking} title="Create the sales order?" confirmLabel="Create order"
          description={p ? `A sales order for ${p.po.customer_name} (PO ${p.po.customer_po_number}) will be created with ${parsed.filter((x) => (x.value ?? 0) > 0).length} line(s). Reserved stock of these PO lines moves to the order.${confirmNow ? ' It will be confirmed immediately.' : ''}` : ''}
          onConfirm={() => { setAsking(false); void submit() }} />
      </DialogContent>
    </Dialog>
  )
}

interface ManualLine { key: string; product: ProductOption | null; quantity: string; price: string }
const blank = (): ManualLine => ({ key: crypto.randomUUID(), product: null, quantity: '', price: '' })

/** Manual order (authorised users): existing customer + Product Master lines. */
export function ManualOrderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (r: CreateOrderResult) => void }) {
  const { has } = usePermissions()
  const customers = useAsync(() => fetchCustomers(false), [])
  const [customer, setCustomer] = useState('')
  const [quickAdd, setQuickAdd] = useState(false)
  const [poNumber, setPoNumber] = useState('')
  const [currency, setCurrency] = useState('INR')
  const [header, setHeader] = useState<HeaderState>({ requested: '', shipping: '', billing: '', reference: '', priority: 'NORMAL', warehouse: 'any', notes: '' })
  const [lines, setLines] = useState<ManualLine[]>([blank()])
  const [confirmNow, setConfirmNow] = useState(false)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()

  const check = (): string | null => {
    if (!customer) return 'Choose the customer.'
    const filled = lines.filter((l) => l.product || l.quantity.trim())
    if (filled.length === 0) return 'Add at least one product line.'
    for (const [i, l] of filled.entries()) {
      if (!l.product) return `Line ${i + 1}: choose a product.`
      const q = parseQty(l.quantity)
      if (!q) return `Line ${i + 1}: enter a quantity greater than zero (up to 3 decimals).`
      if (l.price.trim() && !/^\d+(\.\d{1,4})?$/.test(l.price.trim())) return `Line ${i + 1}: the price must be a non-negative number.`
    }
    if (currency.trim() && !/^[A-Za-z]{3}$/.test(currency.trim())) return 'Currency must be a 3-letter code.'
    return null
  }

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      const r = await createManualOrder(
        { ...headerPayload(header), customer_id: customer, customer_po_number: poNumber.trim() || null, currency: currency.trim().toUpperCase() || null },
        lines.filter((l) => l.product).map((l) => ({ product_id: l.product!.product_id, quantity: parseQty(l.quantity) as number, unit_price: l.price.trim() ? Number(l.price) : null })),
        confirmNow, key)
      renew()
      onCreated(r)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>New manual sales order</DialogTitle>
          <DialogDescription>Use for orders that did not arrive as a PO file. Choose the customer (or add a new one here); every line must be a Product Master item. If the customer's PO was imported, convert that PO instead.</DialogDescription>
        </DialogHeader>
        <ErrorBox message={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="mo-customer">Customer</Label>
            <div className="flex gap-2">
              <Select value={customer} onValueChange={setCustomer}><SelectTrigger id="mo-customer"><SelectValue placeholder={customers.loading ? 'Loading…' : 'Select a customer'} /></SelectTrigger>
                <SelectContent className="max-h-72">{(customers.data ?? []).length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No active customers yet. Use New customer.</div>}
                  {(customers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent></Select>
              {has('customers.manage') && <Button type="button" variant="outline" onClick={() => setQuickAdd(true)}><UserPlus /> New customer</Button>}
            </div></div>
          <div className="space-y-1"><Label htmlFor="mo-po">Customer PO no. (optional)</Label><Input id="mo-po" maxLength={100} value={poNumber} onChange={(e) => setPoNumber(e.target.value)} /></div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between"><p className="text-sm font-medium">Lines</p><Label htmlFor="mo-cur" className="flex items-center gap-2 text-xs font-normal">Currency <Input id="mo-cur" className="h-8 w-20" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} /></Label></div>
          {lines.map((l, i) => (
            <div key={l.key} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_110px_120px_auto]">
              <div className="space-y-1"><Label htmlFor={`mo-p-${l.key}`} className="text-xs">Product {i + 1}</Label><ProductPicker id={`mo-p-${l.key}`} value={l.product} onChange={(p) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, product: p } : x)))} /></div>
              <div className="space-y-1"><Label htmlFor={`mo-q-${l.key}`} className="text-xs">Quantity{l.product ? ` (${l.product.base_unit})` : ''}</Label><Input id={`mo-q-${l.key}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, quantity: e.target.value } : x)))} /></div>
              <div className="space-y-1"><Label htmlFor={`mo-pr-${l.key}`} className="text-xs">Unit price (optional)</Label><Input id={`mo-pr-${l.key}`} inputMode="decimal" value={l.price} onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, price: e.target.value } : x)))} /></div>
              <Button variant="ghost" size="icon" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Trash2 /></Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blank()])}><Plus /> Add line</Button>
          <p className="text-xs text-muted-foreground">Prices are kept on the order line only; they are not revenue and do not change the Product Master.</p>
        </div>
        <HeaderFields value={header} onChange={setHeader} idPrefix="mo" />
        {has('sales_orders.confirm') && <label className="flex items-center gap-2 text-sm"><Checkbox checked={confirmNow} onCheckedChange={(v) => setConfirmNow(v === true)} /> Confirm the order now</label>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={() => { const m = check(); if (m) setError(m); else { setError(null); setAsking(true) } }}>{busy && <Loader2 className="animate-spin" />} Create sales order</Button>
        </DialogFooter>
        {quickAdd && (
          <QuickAddPartyDialog role="CUSTOMER" onClose={() => setQuickAdd(false)} onCreated={(r) => {
            setQuickAdd(false)
            customers.reload()
            setCustomer(r.roleId)
            setError(null)
          }} />
        )}
        <ConfirmDialog open={asking} onOpenChange={setAsking} title="Create the manual sales order?" confirmLabel="Create order"
          description={`${lines.filter((l) => l.product).length} line(s) for ${(customers.data ?? []).find((c) => c.id === customer)?.customer_name ?? 'the customer'}. Stock is not reserved until the order is confirmed and allocated.`}
          onConfirm={() => { setAsking(false); void submit() }} />
      </DialogContent>
    </Dialog>
  )
}
