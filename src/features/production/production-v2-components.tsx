import { AlertTriangle, Loader2, Plus, ShoppingCart, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { qtyInputMode } from '@/features/inventory/whole-units'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { SOURCE_TYPE_LABELS, defaultConsumption, standardFor, validateCompletion } from '@/features/production/production-v2-model'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ProductOption } from '@/services/inventory'
import { addBomComponents, completeProductionV2, correctProductionV2, type CompletionData, type V2Line } from '@/services/production-v2'

/** Component-wise requirement table: required, available, reserved, shortage, unit and source. */
export function RequirementsTable({ lines, showIssued = false, emptyText }: { lines: V2Line[]; showIssued?: boolean; emptyText?: string }) {
  if (lines.length === 0) return <p className="px-6 pb-6 text-sm text-muted-foreground">{emptyText ?? 'No materials.'}</p>
  return (
    <Table>
      <TableHeader><TableRow className="hover:bg-transparent">
        <TableHead>Component</TableHead><TableHead>SKU</TableHead><TableHead className="text-right">Required</TableHead>
        {showIssued && <TableHead className="text-right">Consumed</TableHead>}
        <TableHead className="text-right">Available</TableHead><TableHead className="text-right">Reserved</TableHead>
        <TableHead className="text-right">Shortage</TableHead><TableHead>Unit</TableHead><TableHead>Source</TableHead>
      </TableRow></TableHeader>
      <TableBody>{lines.map((l) => (
        <TableRow key={l.component_product_id}>
          <TableCell className="min-w-44 whitespace-normal">{l.product_name}
            <span className="block text-xs text-muted-foreground">{formatQty(l.quantity_per_unit)} per unit{Number(l.wastage_percentage) > 0 ? ` + ${Number(l.wastage_percentage)}% wastage` : ''}</span></TableCell>
          <TableCell className="font-medium">{l.sku}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQty(l.required)}</TableCell>
          {showIssued && <TableCell className="text-right tabular-nums">{formatQty(l.issued ?? 0)}</TableCell>}
          <TableCell className="text-right tabular-nums">{formatQty(l.available)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQty(l.reserved)}</TableCell>
          <TableCell className={cn('text-right tabular-nums', Number(l.shortage) > 0 && 'font-medium text-shortage')}>{formatQty(l.shortage)}</TableCell>
          <TableCell>{l.unit}</TableCell>
          <TableCell>{SOURCE_TYPE_LABELS[l.source_type] ?? l.source_type}</TableCell>
        </TableRow>
      ))}</TableBody>
    </Table>
  )
}

/** Warnings (shortages, no BOM …) with a purchase shortcut when something is short. */
export function WarningList({ warnings, showPurchase }: { warnings: string[]; showPurchase?: boolean }) {
  const { has } = usePermissions()
  if (warnings.length === 0) return null
  return (
    <div role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
      <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4" /> Warnings (production is not blocked)</p>
      <ul className="mt-1 list-disc pl-6">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      {showPurchase && has('purchase_order.create') && warnings.some((w) => w.includes('short by')) && (
        <Button size="sm" variant="outline" className="mt-2" asChild><Link to="/purchase-orders/new"><ShoppingCart /> Create purchase order for the shortage</Link></Button>
      )}
    </div>
  )
}

interface NewComponent { key: string; product: ProductOption | null; qty: string; wastage: string; source: string }
const blankComponent = (): NewComponent => ({ key: crypto.randomUUID(), product: null, qty: '', wastage: '', source: 'default' })

/** Adds missing components to the product's BOM (new active version; old versions kept). */
export function AddComponentsDialog({ product, onClose, onAdded }: {
  product: { id: string; sku: string; unit: string }
  onClose: () => void
  onAdded: (message: string) => void
}) {
  const request = useRequestKey()
  const [rows, setRows] = useState<NewComponent[]>([blankComponent()])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = (key: string, p: Partial<NewComponent>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  const submit = async () => {
    setError(null)
    const filled = rows.filter((r) => r.product || r.qty.trim())
    const problems: string[] = []
    if (!filled.length) problems.push('Add at least one component.')
    filled.forEach((r, i) => {
      if (!r.product) problems.push(`Line ${i + 1}: choose the component.`)
      else if (r.product.product_id === product.id) problems.push(`Line ${i + 1}: a product cannot be its own component.`)
      if (!/^\d+(\.\d{1,6})?$/.test(r.qty.trim()) || Number(r.qty) <= 0) problems.push(`Line ${i + 1}: enter the quantity for one ${product.unit} of ${product.sku}.`)
      if (r.wastage.trim() && (!/^\d+(\.\d{1,2})?$/.test(r.wastage.trim()) || Number(r.wastage) >= 100)) problems.push(`Line ${i + 1}: wastage must be 0 to 99.99 %.`)
    })
    if (problems.length) return setError(problems.join(' '))
    setBusy(true)
    try {
      const res = await addBomComponents(product.id, filled.map((r) => ({
        component_product_id: r.product!.product_id, quantity_per_unit: r.qty.trim(), wastage_percentage: r.wastage.trim() || '0',
        source_type: r.source === 'default' ? null : r.source,
      })), request.key)
      request.renew()
      onAdded(`${res.bom_code} v${res.version} is now active with ${res.components} component(s)${res.replaced_version ? ` (replaces v${res.replaced_version}, which is kept)` : ''}.`)
    } catch (e) { setError(describeDataError(e)); setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Add missing components to {product.sku}</DialogTitle>
          <DialogDescription>Saved as a new BOM version and activated. Earlier versions are kept, and orders already open keep their version until you recalculate them.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={r.key} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-12">
              <div className="space-y-1 sm:col-span-5"><Label htmlFor={`ac-prod-${i}`}>Component</Label><ProductPicker id={`ac-prod-${i}`} value={r.product} onChange={(p) => update(r.key, { product: p })} /></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor={`ac-qty-${i}`}>Per 1 {product.unit}{r.product ? ` (${r.product.base_unit})` : ''}</Label>
                <Input id={`ac-qty-${i}`} inputMode="decimal" value={r.qty} onChange={(e) => update(r.key, { qty: e.target.value })} /></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor={`ac-w-${i}`}>Wastage %</Label><Input id={`ac-w-${i}`} inputMode="decimal" placeholder="0" value={r.wastage} onChange={(e) => update(r.key, { wastage: e.target.value })} /></div>
              <div className="space-y-1 sm:col-span-2"><Label htmlFor={`ac-src-${i}`}>Source</Label>
                <Select value={r.source} onValueChange={(v) => { if (v) update(r.key, { source: v }) }}>
                  <SelectTrigger id={`ac-src-${i}`}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="default">From product</SelectItem>
                    {Object.entries(SOURCE_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                </Select></div>
              <div className="flex items-end sm:col-span-1">
                <Button type="button" variant="ghost" size="icon" aria-label="Remove line" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 /></Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, blankComponent()])}><Plus /> Another component</Button>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Add to BOM</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface CompletionOrder {
  id: string
  production_order_number: string
  unit: string
  planned_quantity: number | string
  completed_quantity?: number | string
  rejected_quantity?: number | string
  scrap_quantity?: number | string
  sku: string
  track_batches?: boolean
  track_expiry?: boolean
  planned_start_date: string
  notes?: string | null
}

/**
 * Complete production (actual output and actual consumption), or correct a
 * completed one (mode "correct": everything recorded is reversed and the
 * corrected production posted in one step; "undo" only reverses and reopens).
 */
export function CompleteProductionDialog({ order, lines, mode, onClose, onDone }: {
  order: CompletionOrder
  lines: V2Line[]
  mode: 'complete' | 'correct'
  onClose: () => void
  onDone: (message: string, warnings: string[]) => void
}) {
  const storage = useStorage()
  const request = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const correcting = mode === 'correct'
  const initialActual = correcting ? String(Number(order.completed_quantity ?? 0) + Number(order.rejected_quantity ?? 0)) : String(Number(order.planned_quantity))
  const [date, setDate] = useState(order.planned_start_date > today ? today : order.planned_start_date)
  const [actual, setActual] = useState(initialActual)
  const [rejected, setRejected] = useState(correcting ? String(Number(order.rejected_quantity ?? 0)) : '0')
  const [wastage, setWastage] = useState(correcting ? String(Number(order.scrap_quantity ?? 0)) : '0')
  const [rejLoc, setRejLoc] = useState('record')
  const [batch, setBatch] = useState('')
  const [expiry, setExpiry] = useState('')
  const [remarks, setRemarks] = useState(correcting ? '' : (order.notes ?? ''))
  const [reason, setReason] = useState('')
  const [undo, setUndo] = useState(false)
  // In a correction all earlier consumption is reversed first, so nothing counts as issued.
  const matLines = useMemo(() => lines.filter((l) => l.order_material_id).map((l) => ({
    order_material_id: l.order_material_id!, sku: l.sku, unit: l.unit, quantity_per_unit: l.quantity_per_unit,
    wastage_percentage: l.wastage_percentage, issued: correcting ? 0 : Number(l.issued ?? 0),
  })), [lines, correcting])
  const produced = (Number(actual) || 0) + (Number(wastage) || 0)
  // ERP Settings → Production: pre-fill with the BOM standard, or leave blank for actuals.
  const blankPrefill = useErpPreferences().prefs?.['production.consumption_prefill'] === 'BLANK'
  const [consumed, setConsumed] = useState<Record<string, string>>(() => blankPrefill ? Object.fromEntries(Object.keys(defaultConsumption(matLines, 0)).map((k) => [k, ''])) : defaultConsumption(matLines, (Number(initialActual) || 0)))
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rejectLocations = storage.activeLocations.filter((o) => o.usage === 'REJECTED')

  const setProduced = (a: string, w: string) => { if (!touched && !blankPrefill) setConsumed(defaultConsumption(matLines, (Number(a) || 0) + (Number(w) || 0))) }

  const submit = async () => {
    setError(null)
    if (correcting && reason.trim().length < 5) return setError('Enter the reason for the correction (at least 5 characters).')
    if (correcting && undo) {
      setBusy(true)
      try {
        const r = await correctProductionV2(order.id, reason.trim(), null, request.key)
        request.renew()
        return onDone(`${order.production_order_number} reopened: production reversed (${r.reversal_numbers.join(', ')}) and materials reserved again.`, r.warnings ?? [])
      } catch (e) { setError(describeDataError(e)); setBusy(false); return }
    }
    const problems = validateCompletion({ actual, rejected, wastage, consumed }, order.unit, matLines)
    if (date > today) problems.push('The production date cannot be in the future.')
    if (Number(rejected) > 0 && rejLoc !== 'record' && !rejLoc) problems.push('Choose where the rejected goods are kept.')
    if (problems.length) return setError(problems.join(' '))
    const data: CompletionData = {
      production_date: date, actual_quantity: actual.trim(), rejected_quantity: rejected.trim() || '0', wastage_quantity: wastage.trim() || '0',
      remarks: remarks.trim() || null, batch_number: batch.trim() || null, expiry_date: expiry || null,
      rejected_location_id: Number(rejected) > 0 && rejLoc !== 'record' ? rejLoc : null,
      materials: matLines.map((l) => ({ order_material_id: l.order_material_id, quantity: (consumed[l.order_material_id] ?? '0').trim() || '0' })),
    }
    setBusy(true)
    try {
      if (correcting) {
        const r = await correctProductionV2(order.id, reason.trim(), data, request.key)
        request.renew()
        onDone(`${order.production_order_number} corrected: earlier postings reversed (${r.reversal_numbers.join(', ')}) and ${formatQty(r.completion?.accepted ?? 0, order.unit)} accepted (${r.completion?.receipt_number}).`, r.warnings ?? [])
      } else {
        const r = await completeProductionV2(order.id, data, request.key)
        request.renew()
        onDone(`${order.production_order_number} completed: ${formatQty(r.accepted, order.unit)} accepted into stock${Number(r.rejected) > 0 ? `, ${formatQty(r.rejected)} rejected` : ''}${Number(r.wastage) > 0 ? `, ${formatQty(r.wastage)} wasted` : ''} (${r.receipt_number}).`, r.warnings ?? [])
      }
    } catch (e) { setError(describeDataError(e)); setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{correcting ? `Correct ${order.production_order_number}` : `Complete ${order.production_order_number}`}</DialogTitle>
          <DialogDescription>
            {correcting
              ? 'Everything recorded for this order is reversed with new ledger entries (nothing is overwritten) and the corrected production is posted in the same step. It is refused if the finished goods have already been used or sold.'
              : 'Enter what was actually produced and consumed. Materials are deducted (this order\'s reservations first), accepted goods are added to stock, rejected goods are kept apart, and unused reservations are released.'}
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-4">
          {correcting && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2"><Label htmlFor="cp-reason">Reason for the correction</Label><Input id="cp-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 4 rejected units were reworked" /></div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={undo} onChange={(e) => setUndo(e.target.checked)} /> Only undo the completion (reverse it and reopen the order)</label>
            </div>
          )}
          {!(correcting && undo) && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1"><Label htmlFor="cp-date">Production date</Label><Input id="cp-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="cp-actual">Actual quantity ({order.unit})</Label>
                  <Input id="cp-actual" inputMode={qtyInputMode(order.unit)} value={actual} onChange={(e) => { setActual(e.target.value); setProduced(e.target.value, wastage) }} />
                  <p className="text-xs text-muted-foreground">Planned {formatQty(Number(order.planned_quantity), order.unit)}; includes rejected units</p></div>
                <div className="space-y-1"><Label htmlFor="cp-rej">Rejected quantity</Label><Input id="cp-rej" inputMode={qtyInputMode(order.unit)} value={rejected} onChange={(e) => setRejected(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Accepted = {formatQty(Math.max((Number(actual) || 0) - (Number(rejected) || 0), 0), order.unit)}</p></div>
                <div className="space-y-1"><Label htmlFor="cp-waste">Wastage ({order.unit})</Label><Input id="cp-waste" inputMode={qtyInputMode(order.unit)} value={wastage} onChange={(e) => { setWastage(e.target.value); setProduced(actual, e.target.value) }} />
                  <p className="text-xs text-muted-foreground">Units scrapped in production (not stocked)</p></div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {Number(rejected) > 0 && (
                  <div className="space-y-1 sm:col-span-2"><Label htmlFor="cp-rejloc">Rejected goods</Label>
                    <Select value={rejLoc} onValueChange={(v) => { if (v) setRejLoc(v) }}>
                      <SelectTrigger id="cp-rejloc"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="record">Record only (scrapped / not kept)</SelectItem>
                        {rejectLocations.map((o) => <SelectItem key={o.id} value={o.id}>Keep in {o.label}</SelectItem>)}</SelectContent>
                    </Select></div>
                )}
                {order.track_batches && <div className="space-y-1"><Label htmlFor="cp-batch">Batch</Label><Input id="cp-batch" maxLength={50} placeholder={order.production_order_number} value={batch} onChange={(e) => setBatch(e.target.value)} /></div>}
                {order.track_expiry && <div className="space-y-1"><Label htmlFor="cp-exp">Expiry</Label><Input id="cp-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>}
              </div>
              <div className="overflow-hidden rounded-lg border">
                <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2 text-sm">
                  <span className="font-medium">Actual material consumption</span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setConsumed(defaultConsumption(matLines, produced)); setTouched(false) }}>Reset to standard</Button>
                </div>
                <Table>
                  <TableHeader><TableRow className="hover:bg-transparent">
                    <TableHead>Material</TableHead><TableHead className="text-right">Standard for {formatQty(produced)}</TableHead>
                    {!correcting && <TableHead className="text-right">Already consumed</TableHead>}
                    <TableHead className="text-right">Reserved + available</TableHead><TableHead className="w-40">Consumed now</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{matLines.map((l) => {
                    const src = lines.find((x) => x.order_material_id === l.order_material_id)!
                    const std = standardFor(l, produced)
                    const now = Number(consumed[l.order_material_id] ?? 0)
                    const diff = now + Number(l.issued) - std
                    return (
                      <TableRow key={l.order_material_id}>
                        <TableCell><span className="font-medium">{l.sku}</span><span className="block text-xs text-muted-foreground">{src.product_name}</span></TableCell>
                        <TableCell className="text-right tabular-nums">{formatQty(std, l.unit)}</TableCell>
                        {!correcting && <TableCell className="text-right tabular-nums">{formatQty(l.issued)}</TableCell>}
                        <TableCell className="text-right tabular-nums">{formatQty(Number(src.reserved) + Number(src.available))}</TableCell>
                        <TableCell>
                          <Input aria-label={`${l.sku} consumed`} id={`cp-mat-${l.sku}`} inputMode={qtyInputMode(l.unit)} value={consumed[l.order_material_id] ?? ''}
                            onChange={(e) => { setTouched(true); setConsumed((c) => ({ ...c, [l.order_material_id]: e.target.value })) }} />
                          {Math.abs(diff) > 0.0005 && <span className={cn('text-xs', diff > 0 ? 'text-amber-800' : 'text-muted-foreground')}>{diff > 0 ? `+${formatQty(diff)} over standard` : `${formatQty(-diff)} under standard`}</span>}
                        </TableCell>
                      </TableRow>
                    )
                  })}</TableBody>
                </Table>
              </div>
              <div className="space-y-1"><Label htmlFor="cp-remarks">Remarks</Label><Textarea id="cp-remarks" rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></div>
            </>
          )}
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || storage.loading}>{busy && <Loader2 className="animate-spin" />}
              {correcting ? (undo ? 'Reverse and reopen' : 'Reverse and post correction') : 'Complete production'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SimpleStatusBadge({ label, tone }: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }) {
  return <StatusBadge label={label} tone={tone} />
}
