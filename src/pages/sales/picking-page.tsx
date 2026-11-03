import { AlertTriangle, CheckCircle2, Loader2, Plus, ScanLine, X } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { FulfilmentQueue } from '@/features/sales/fulfilment-queue'
import { FulfilmentStatusBadge } from '@/features/sales/sales-badges'
import { WORKABLE_ORDER_STATUSES, parseQty } from '@/features/sales/sales-model'
import { OrderContextBar } from '@/features/sales/so-picker'
import { useFulfilmentSelection } from '@/features/sales/use-fulfilment-selection'
import { useSoSelection } from '@/features/sales/use-so-selection'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import { createFulfilment, fetchFulfilment, fetchFulfilmentLines, fetchFulfilments, fetchOrderReservations, fulfilmentAction, recordPick } from '@/services/sales'
import type { SalesOrderStatus } from '@/types/database-sales'

const Alert = ({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) => (
  <p role={tone === 'error' ? 'alert' : 'status'} className={tone === 'error' ? 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
    : tone === 'success' ? 'rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800' : 'rounded-lg border bg-background px-3 py-2 text-sm'}>{children}</p>
)

/** New pick list from an order's reserved stock that is not on another open pick list. */
function NewPickList({ onCreated }: { onCreated: (id: string, number: string) => void }) {
  const selection = useSoSelection([...WORKABLE_ORDER_STATUSES] as SalesOrderStatus[])
  const so = selection.selected
  const reservations = useAsync(() => (so ? fetchOrderReservations(so.id) : Promise.resolve([])), [so?.id])
  const open = (reservations.data ?? []).filter((r) => ['ACTIVE', 'PARTIALLY_FULFILLED'].includes(r.reservation_status) && Number(r.remaining) > Number(r.planned))
  const warehouses = [...new Map(open.map((r) => [r.warehouse_id, r.warehouse_code])).entries()]
  const [warehouse, setWarehouse] = useState('')
  const [qtyEdits, setQty] = useState<Record<string, string>>({})
  const [planned, setPlanned] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const wh = warehouse && warehouses.some(([id]) => id === warehouse) ? warehouse : (warehouses[0]?.[0] ?? '')
  const rows = open.filter((r) => r.warehouse_id === wh)
  // Suggested quantity = everything free on the reservation; the user may lower it.
  const qty: Record<string, string> = { ...Object.fromEntries(open.map((r) => [r.id, String(Number(r.remaining) - Number(r.planned))])), ...qtyEdits }

  return (
    <Card className="mb-6">
      <CardHeader><div><CardTitle>New pick list</CardTitle><CardDescription>Choose a confirmed order; reserved stock not already on an open pick list is listed per warehouse. Creating a pick list moves no stock.</CardDescription></div></CardHeader>
      <CardContent className="space-y-3">
        <OrderContextBar selection={selection} emptyHint="No confirmed orders with work to do." />
        {error && <Alert tone="error">{error}</Alert>}
        {so && (reservations.loading ? <p className="text-sm text-muted-foreground">Loading reservations…</p> : open.length === 0 ? (
          <Alert tone="info">Nothing of {so.sales_order_number} is free to pick: allocate stock first (Order Details), or its reserved stock is already on an open pick list.</Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1"><Label htmlFor="np-wh">Pick from warehouse</Label>
                <Select value={wh} onValueChange={setWarehouse}><SelectTrigger id="np-wh" className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>{warehouses.map(([id, code]) => <SelectItem key={id} value={id}>{code}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1"><Label htmlFor="np-date">Planned dispatch date</Label><Input id="np-date" type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} /></div>
              <div className="min-w-64 flex-1 space-y-1"><Label htmlFor="np-notes">Notes</Label><Input id="np-notes" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">Line</th><th className="pb-2 text-left">Product</th><th className="pb-2 text-left">Location / lot</th><th className="pb-2 text-right">Free to pick</th><th className="pb-2 text-right">Put on this list</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-2">{r.line_no}</td>
                    <td className="py-2">{r.sku}<span className="block text-xs text-muted-foreground">{r.product_name}</span></td>
                    <td className="py-2 text-xs">{r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''} · {r.reservation_number}</td>
                    <td className="py-2 text-right">{formatQty(Number(r.remaining) - Number(r.planned), r.unit)}</td>
                    <td className="py-2 text-right"><Input aria-label={`Quantity to pick for ${r.reservation_number}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={qty[r.id] ?? ''} onChange={(e) => setQty((q) => ({ ...q, [r.id]: e.target.value }))} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Button disabled={busy} onClick={async () => {
              const lines = rows.map((r) => ({ reservation_id: r.id, quantity: parseQty(qty[r.id] ?? '') }))
              if (lines.some((l) => l.quantity === null)) return setError('Enter quantities as numbers (up to 3 decimals).')
              const chosen = lines.filter((l) => (l.quantity ?? 0) > 0) as { reservation_id: string; quantity: number }[]
              if (chosen.length === 0) return setError('Enter at least one quantity to pick.')
              setBusy(true); setError(null)
              try {
                const r = await createFulfilment({ orderId: so.id, warehouseId: wh, lines: chosen, plannedDispatchDate: planned || null, notes: notes.trim() || null }, key)
                renew(); setNotes(''); setPlanned('')
                onCreated(r.fulfilment_id, r.fulfilment_number)
              } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
            }}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Create pick list</Button>
          </>
        ))}
      </CardContent>
    </Card>
  )
}

export default function PickingPage() {
  const { has } = usePermissions()
  const { fulfilmentId, select } = useFulfilmentSelection()
  const [params] = useSearchParams()
  const [refresh, setRefresh] = useState(0)
  const [showNew, setShowNew] = useState(Boolean(params.get('so')))
  const queue = useAsync(() => fetchFulfilments({ statuses: ['PENDING', 'PICKING'] }), [refresh])
  const ful = useAsync(() => (fulfilmentId ? fetchFulfilment(fulfilmentId) : Promise.resolve(null)), [fulfilmentId, refresh])
  const lines = useAsync(() => (fulfilmentId ? fetchFulfilmentLines({ fulfilmentId }) : Promise.resolve([])), [fulfilmentId, refresh])
  const names = useAsync(() => fetchDisplayNames((lines.data ?? []).map((l) => l.picked_by)), [lines.data])
  const [pickedEdits, setPicked] = useState<Record<string, string>>({})
  const [exceptionEdits, setExceptions] = useState<Record<string, string>>({})
  const [scan, setScan] = useState('')
  const [scanMsg, setScanMsg] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmComplete, setConfirmComplete] = useState(false)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const f = ful.data
  const editable = Boolean(f && ['PENDING', 'PICKING'].includes(f.fulfilment_status) && has('fulfilment.pick'))

  // Unsaved edits on top of the recorded values; cleared after saving or switching pick list.
  const picked: Record<string, string> = { ...Object.fromEntries((lines.data ?? []).map((l) => [l.id, String(Number(l.quantity_picked))])), ...pickedEdits }
  const exceptions: Record<string, string> = { ...Object.fromEntries((lines.data ?? []).map((l) => [l.id, l.pick_exception ?? ''])), ...exceptionEdits }
  const clearEdits = () => { setPicked({}); setExceptions({}) }

  const payload = (lines.data ?? []).map((l) => ({ line_id: l.id, quantity_picked: parseQty(picked[l.id] ?? '0'), exception: (exceptions[l.id] ?? '').trim() || null }))

  const save = async (complete: boolean) => {
    if (!f) return
    const bad = payload.find((p) => p.quantity_picked === null)
    if (bad) { setError('Enter picked quantities as numbers (up to 3 decimals).'); return }
    setBusy(true); setError(null)
    try {
      const r = await recordPick(f.id, payload as { line_id: string; quantity_picked: number; exception: string | null }[], complete)
      setMessage(complete ? `Picking of ${f.fulfilment_number} completed (${formatQty(r.picked)} picked). It is now ready for packing.` : `Picking saved (${formatQty(r.picked)} picked so far).`)
      clearEdits()
      setRefresh((n) => n + 1)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  // Scanner / keyboard entry: SKU, barcode or batch number + Enter adds one unit to the matching line.
  const onScan = () => {
    const code = scan.trim().toLowerCase()
    if (!code) return
    const matches = (lines.data ?? []).filter((l) => [l.sku, l.barcode, l.batch_number].some((v) => v && v.toLowerCase() === code))
    if (matches.length === 0) setScanMsg(`"${scan.trim()}" is not on this pick list.`)
    else {
      const line = matches.find((l) => (parseQty(picked[l.id] ?? '0') ?? 0) < Number(l.quantity_to_pick)) ?? matches[0]
      const now = parseQty(picked[line.id] ?? '0') ?? 0
      if (now >= Number(line.quantity_to_pick)) setScanMsg(`Line ${line.line_no} (${line.sku}) is already fully picked.`)
      else {
        setPicked((p) => ({ ...p, [line.id]: String(now + 1) }))
        setScanMsg(`Line ${line.line_no} ${line.sku}: ${formatQty(now + 1)} of ${formatQty(line.quantity_to_pick)} picked (not saved yet).`)
        inputs.current[line.id]?.focus()
      }
    }
    setScan('')
  }

  return (
    <>
      <PageHeader actions={has('fulfilment.pick') ? <Button variant={showNew ? 'outline' : 'default'} onClick={() => setShowNew((s) => !s)}>{showNew ? <X /> : <Plus />} {showNew ? 'Close' : 'New pick list'}</Button> : undefined} />
      {message && <div className="mb-4"><Alert tone="success">{message}</Alert></div>}
      {showNew && <NewPickList onCreated={(id, number) => { setShowNew(false); setMessage(`Pick list ${number} created.`); setRefresh((n) => n + 1); select(id) }} />}
      <div className="mb-6">
        <FulfilmentQueue title="Pick lists to work on" description="Consignments waiting to be picked or being picked." rows={queue.data ?? []} loading={queue.loading} error={queue.error} onRetry={queue.reload}
          selectedId={fulfilmentId} onSelect={(id) => { setMessage(null); setError(null); clearEdits(); select(id) }} extra={['picked']}
          emptyTitle="Nothing to pick" emptyDescription="Create a pick list from a confirmed order with reserved stock." />
      </div>
      {f && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">{f.fulfilment_number} · {f.sales_order_number} <FulfilmentStatusBadge status={f.fulfilment_status} /></CardTitle>
              <CardDescription>{f.customer_name_snapshot} · from {f.warehouse_code} · created {formatDateTime(f.created_at)}{f.notes ? ` · ${f.notes}` : ''}. Picking records who picked what; stock is only deducted when the consignment is dispatched.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <Alert tone="error">{error}</Alert>}
            {editable && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1"><Label htmlFor="pk-scan">Scan or type SKU, barcode or batch</Label>
                  <div className="flex gap-2">
                    <Input id="pk-scan" className="w-72" value={scan} onChange={(e) => setScan(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onScan() } }} placeholder="e.g. 8901234567890" />
                    <Button variant="outline" onClick={onScan}><ScanLine /> Add 1</Button>
                  </div></div>
                {scanMsg && <p className="pb-2 text-sm text-muted-foreground" role="status">{scanMsg}</p>}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1100px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr>
                  <th className="pb-2 text-left">Line</th><th className="pb-2 text-left">SKU / product</th><th className="pb-2 text-right">Ordered</th><th className="pb-2 text-right">Reserved</th>
                  <th className="pb-2 text-right">Prev. fulfilled</th><th className="pb-2 text-right">Remaining</th><th className="pb-2 text-left">Warehouse / location / batch</th>
                  <th className="pb-2 text-right">To pick</th><th className="pb-2 text-right">Picked</th><th className="pb-2 text-right">Left</th><th className="pb-2 text-left">Exception</th>
                </tr></thead>
                <tbody>{(lines.data ?? []).map((l) => {
                  const p = parseQty(picked[l.id] ?? '0')
                  return (
                    <tr key={l.id} className="border-t align-top">
                      <td className="py-2">{l.line_no}</td>
                      <td className="py-2"><span className="font-medium">{l.sku}</span><span className="block text-xs text-muted-foreground">{l.product_name}</span>
                        {l.stock_problem && <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-shortage"><AlertTriangle className="size-3" /> Cannot pick: {l.stock_problem}</span>}</td>
                      <td className="py-2 text-right">{formatQty(Number(l.quantity_ordered) - Number(l.quantity_cancelled), l.unit)}</td>
                      <td className="py-2 text-right">{formatQty(l.reservation_remaining)}</td>
                      <td className="py-2 text-right">{formatQty(l.order_line_dispatched)}</td>
                      <td className="py-2 text-right">{formatQty(l.order_line_remaining)}</td>
                      <td className="py-2 text-xs">{l.warehouse_code} / <span className="font-medium">{l.location_code}</span>{l.batch_number ? ` · ${l.batch_number}` : ''}<span className="block text-muted-foreground">{l.reservation_number}</span></td>
                      <td className="py-2 text-right font-medium">{formatQty(l.quantity_to_pick)}</td>
                      <td className="py-2 text-right">{editable ? (
                        <Input ref={(el) => { inputs.current[l.id] = el }} aria-label={`Picked quantity line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal"
                          value={picked[l.id] ?? ''} onChange={(e) => setPicked((x) => ({ ...x, [l.id]: e.target.value }))} />
                      ) : formatQty(l.quantity_picked)}
                        {l.picked_at && <span className="mt-0.5 block text-xs text-muted-foreground">{(l.picked_by && names.data?.get(l.picked_by)) || 'User'} · {formatDateTime(l.picked_at)}</span>}</td>
                      <td className={p !== null && p < Number(l.quantity_to_pick) ? 'py-2 text-right text-amber-800' : 'py-2 text-right'}>{p === null ? '—' : formatQty(Number(l.quantity_to_pick) - p)}</td>
                      <td className="py-2">{editable ? (
                        <Input aria-label={`Pick exception line ${l.line_no}`} className="h-8 w-56" maxLength={500} placeholder={p !== null && p < Number(l.quantity_to_pick) ? 'Reason for the short pick (required)' : 'Optional'}
                          value={exceptions[l.id] ?? ''} onChange={(e) => setExceptions((x) => ({ ...x, [l.id]: e.target.value }))} />
                      ) : <span className="text-xs">{l.pick_exception ?? ''}</span>}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
            {editable && (
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button variant="outline" disabled={busy} onClick={() => void save(false)}>{busy && <Loader2 className="animate-spin" />} Save progress</Button>
                <Button disabled={busy} onClick={() => setConfirmComplete(true)}><CheckCircle2 /> Complete picking</Button>
                {(has('fulfilment.pick') || has('sales_orders.cancel')) && (
                  <Button variant="outline" className="text-shortage" onClick={() => setAction({
                    title: `Cancel pick list ${f.fulfilment_number}`, description: 'Nothing was issued, so no stock changes. The reserved stock stays with the order and can go on a new pick list.',
                    confirmLabel: 'Cancel pick list', note: 'required', destructive: true,
                    run: async (note) => { await fulfilmentAction(f.id, 'CANCEL', note); return `Pick list ${f.fulfilment_number} cancelled.` },
                  })}>Cancel pick list</Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={confirmComplete} onOpenChange={setConfirmComplete} title="Complete picking?" confirmLabel="Complete picking"
        description="Every line must be fully picked or have an exception reason. The consignment then moves to packing; no stock is deducted yet."
        onConfirm={() => { setConfirmComplete(false); void save(true) }} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); setMessage(m); select(''); setRefresh((n) => n + 1) }} />
    </>
  )
}
