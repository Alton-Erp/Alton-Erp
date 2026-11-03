import { Ban, History, Loader2, Lock, Pencil, ScanLine, Undo2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { EventTimeline } from '@/features/production/event-timeline'
import { AllocateDialog } from '@/features/sales/allocate-dialog'
import { FulfilmentStatusBadge, OrderFulfilmentBadge, ReturnStatusBadge, SalesOrderStatusBadge } from '@/features/sales/sales-badges'
import { LINE_STATUS_LABELS, PRIORITY_LABELS, SALES_EVENT_LABELS, WORKABLE_ORDER_STATUSES, fulfilmentPath } from '@/features/sales/sales-model'
import { NoOrderSelected, OrderContextBar } from '@/features/sales/so-picker'
import { useSoSelection } from '@/features/sales/use-so-selection'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import {
  confirmOrder, fetchFulfilments, fetchOrderEvents, fetchOrderLines, fetchOrderMovements, fetchOrderReservations, fetchReturns, orderAction, releaseOrder, updateOrder,
} from '@/services/sales'
import type { FulfilmentListRow, Priority, SalesOrderLineListRow, SalesOrderListRow, SalesOrderReservationRow } from '@/types/database-sales'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (<div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm font-medium whitespace-pre-line">{children}</dd></div>)
}

function EditDialog({ so, onClose, onSaved }: { so: SalesOrderListRow; onClose: () => void; onSaved: () => void }) {
  const storage = useStorage()
  const [requested, setRequested] = useState(so.requested_delivery_date ?? '')
  const [shipping, setShipping] = useState(so.shipping_address_snapshot ?? '')
  const [billing, setBilling] = useState(so.billing_address_snapshot ?? '')
  const [reference, setReference] = useState(so.customer_reference ?? '')
  const [priority, setPriority] = useState<Priority>(so.priority)
  const [warehouse, setWarehouse] = useState(so.warehouse_id ?? 'any')
  const [notes, setNotes] = useState(so.internal_notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Edit {so.sales_order_number}</DialogTitle><DialogDescription>Customer, lines and quantities are not edited here. Quantity reductions are recorded per line with the customer's approval (Partial Fulfilment).</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="eo-req">Requested delivery date</Label><Input id="eo-req" type="date" value={requested} onChange={(e) => setRequested(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="eo-prio">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}><SelectTrigger id="eo-prio"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(PRIORITY_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="eo-wh">Fulfil from</Label>
            <Select value={warehouse} onValueChange={setWarehouse}><SelectTrigger id="eo-wh"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="any">Any warehouse</SelectItem>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent></Select>
            <p className="text-xs text-muted-foreground">Existing reservations are not moved; this applies to future allocation.</p></div>
          <div className="space-y-1"><Label htmlFor="eo-ref">Customer reference</Label><Input id="eo-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="eo-ship">Shipping address</Label><Textarea id="eo-ship" rows={2} maxLength={1000} value={shipping} onChange={(e) => setShipping(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="eo-bill">Billing address</Label><Textarea id="eo-bill" rows={2} maxLength={1000} value={billing} onChange={(e) => setBilling(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="eo-notes">Internal notes</Label><Textarea id="eo-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try {
              await updateOrder(so.id, { requested_delivery_date: requested || null, shipping_address: shipping.trim() || null, billing_address: billing.trim() || null,
                customer_reference: reference.trim() || null, priority, warehouse_id: warehouse === 'any' ? null : warehouse, internal_notes: notes.trim() || null })
              onSaved()
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function OrderDetailsPage() {
  const { has } = usePermissions()
  const [params] = useSearchParams()
  const [refresh, setRefresh] = useState(0)
  const selection = useSoSelection(null, refresh)
  const id = selection.soId
  const lines = useAsync(() => (id ? fetchOrderLines({ orderId: id }) : Promise.resolve([])), [id, refresh])
  const reservations = useAsync(() => (id ? fetchOrderReservations(id) : Promise.resolve([])), [id, refresh])
  const fulfilments = useAsync(() => (id ? fetchFulfilments({ orderId: id }) : Promise.resolve([])), [id, refresh])
  const movements = useAsync(() => (id ? fetchOrderMovements(id) : Promise.resolve([])), [id, refresh])
  const returns = useAsync(() => (id && has('fulfilment.read') ? fetchReturns({ orderId: id }) : Promise.resolve([])), [id, refresh])
  const events = useAsync(() => (id ? fetchOrderEvents(id) : Promise.resolve([])), [id, refresh])
  const so = selection.selected
  const names = useAsync(() => fetchDisplayNames([so?.created_by ?? null, so?.confirmed_by ?? null, so?.cancelled_by ?? null]), [so?.id, so?.confirmed_by, so?.cancelled_by])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [editing, setEditing] = useState(false)
  const [allocating, setAllocating] = useState(false)
  const [message, setMessage] = useState<string | null>(params.get('created') ? `Sales order ${params.get('created')} created.` : null)
  const done = (m: string) => { setAction(null); setEditing(false); setAllocating(false); setMessage(m); setRefresh((n) => n + 1); selection.reload() }
  const who = (uid: string | null) => (uid && names.data?.get(uid)) || '—'

  const workable = so ? (WORKABLE_ORDER_STATUSES as readonly string[]).includes(so.order_status) : false
  const active = so ? !['CANCELLED', 'FULFILLED'].includes(so.order_status) : false

  const lineColumns: DataTableColumn<SalesOrderLineListRow>[] = [
    { id: 'line', header: 'Line', cell: (l) => <span>{l.line_no}{l.po_line_no && <span className="block text-xs text-muted-foreground">PO line {l.po_line_no}</span>}</span> },
    { id: 'product', header: 'Product', cell: (l) => <span>{l.sku_snapshot}<span className="block text-xs text-muted-foreground">{l.product_name_snapshot}</span></span>, searchValue: (l) => `${l.sku_snapshot} ${l.product_name_snapshot}` },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (l) => <span>{formatQty(l.quantity_ordered, l.unit)}{Number(l.quantity_cancelled) > 0 && <span className="block text-xs text-muted-foreground">−{formatQty(l.quantity_cancelled)} cancelled</span>}</span> },
    { id: 'reserved', header: 'Reserved', align: 'right', cell: (l) => formatQty(l.quantity_reserved) },
    { id: 'planned', header: 'On pick lists', align: 'right', cell: (l) => formatQty(l.quantity_planned) },
    { id: 'picked', header: 'Picked / packed', align: 'right', cell: (l) => `${formatQty(l.quantity_picked)} / ${formatQty(l.quantity_packed)}` },
    { id: 'dispatched', header: 'Dispatched', align: 'right', cell: (l) => formatQty(l.quantity_dispatched) },
    { id: 'delivered', header: 'Delivered', align: 'right', cell: (l) => formatQty(l.quantity_delivered) },
    { id: 'returned', header: 'Returned', align: 'right', cell: (l) => formatQty(l.quantity_returned) },
    { id: 'remaining', header: 'Remaining', align: 'right', cell: (l) => <span className={Number(l.quantity_remaining) > 0 ? 'font-medium' : ''}>{formatQty(l.quantity_remaining)}{Number(l.quantity_unreserved) > 0 && <span className="block text-xs text-shortage">{formatQty(l.quantity_unreserved)} unreserved</span>}</span> },
    { id: 'status', header: 'Status', cell: (l) => <StatusBadge label={LINE_STATUS_LABELS[l.line_status] ?? l.line_status} tone={l.line_status === 'FULFILLED' ? 'success' : l.line_status === 'CANCELLED' ? 'neutral' : l.line_status === 'OPEN' ? 'warning' : 'info'} /> },
    { id: 'price', header: 'PO price', align: 'right', cell: (l) => (l.unit_price_snapshot === null ? '—' : `${Number(l.unit_price_snapshot).toLocaleString('en-IN')} ${l.currency ?? ''}`) },
  ]
  const resColumns: DataTableColumn<SalesOrderReservationRow>[] = [
    { id: 'number', header: 'Reservation', cell: (r) => <span>{r.reservation_number}<span className="block text-xs text-muted-foreground">{formatDateTime(r.reserved_at)}</span></span> },
    { id: 'line', header: 'Line', cell: (r) => `${r.line_no} · ${r.sku}` },
    { id: 'where', header: 'Warehouse / location / lot', cell: (r) => <span className="text-xs">{r.warehouse_code} / {r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''}{r.expiry_date ? ` · exp ${formatDate(r.expiry_date)}` : ''}<span className="block text-muted-foreground">{r.source_type.replace('_', '-').toLowerCase()}</span></span> },
    { id: 'qty', header: 'Reserved / dispatched / released', align: 'right', cell: (r) => `${formatQty(r.quantity)} / ${formatQty(r.fulfilled_quantity)} / ${formatQty(r.released_quantity)}` },
    { id: 'open', header: 'Open (on pick lists)', align: 'right', cell: (r) => `${formatQty(r.remaining)} (${formatQty(r.planned)})` },
    { id: 'status', header: 'Status', cell: (r) => r.reservation_status.replace(/_/g, ' ').toLowerCase() },
    { id: 'act', header: '', cell: (r) => (has('fulfilment_reservations.release') && ['ACTIVE', 'PARTIALLY_FULFILLED'].includes(r.reservation_status) && Number(r.remaining) > Number(r.planned) ? (
      <Button variant="ghost" size="sm" onClick={() => setAction({
        title: `Release ${r.reservation_number}`, description: `Releases ${formatQty(Number(r.remaining) - Number(r.planned))} not already on an open pick list back to available stock. The order line becomes (partly) unreserved.`,
        confirmLabel: 'Release', note: 'optional', run: async (note) => { const x = await releaseOrder(so!.id, null, r.id, note); return `${formatQty(x.released_quantity)} released.` },
      })}>Release</Button>) : null) },
  ]
  const fulColumns: DataTableColumn<FulfilmentListRow>[] = [
    { id: 'number', header: 'Consignment', cell: (f) => <Link className="font-medium text-primary hover:underline" to={fulfilmentPath(f)}>{f.fulfilment_number}</Link> },
    { id: 'status', header: 'Status', cell: (f) => <FulfilmentStatusBadge status={f.fulfilment_status} overdue={f.is_overdue} /> },
    { id: 'wh', header: 'From', cell: (f) => f.warehouse_code },
    { id: 'qty', header: 'To pick / picked / packed / dispatched / delivered', cell: (f) => <span className="text-xs tabular-nums">{[f.to_pick, f.picked, f.packed, f.dispatched, f.delivered].map((x) => formatQty(x)).join(' / ')} {f.units}</span> },
    { id: 'dispatch', header: 'Dispatched', cell: (f) => (f.actual_dispatch_at ? <span className="text-xs">{formatDateTime(f.actual_dispatch_at)}<span className="block text-muted-foreground">{[f.carrier_name, f.tracking_number ?? f.lr_number].filter(Boolean).join(' · ')}</span></span> : '—') },
    { id: 'expected', header: 'Expected / delivered', cell: (f) => <span className="text-xs">{f.expected_delivery_date ? formatDate(f.expected_delivery_date) : '—'} / {f.delivered_at ? formatDate(f.delivered_at) : '—'}</span> },
  ]
  type Movement = NonNullable<typeof movements.data>[number]
  const moveColumns: DataTableColumn<Movement>[] = [
    { id: 'tx', header: 'Transaction', cell: (t) => t.transaction_number },
    { id: 'at', header: 'Date', cell: (t) => formatDateTime(t.transaction_date) },
    { id: 'product', header: 'Product', cell: (t) => t.sku },
    { id: 'where', header: 'From', cell: (t) => `${t.warehouse_code}/${t.location_code}${t.batch_number ? ` · ${t.batch_number}` : ''}` },
    { id: 'qty', header: 'Quantity', align: 'right', cell: (t) => formatQty(t.quantity, t.unit) },
    { id: 'ref', header: 'Consignment', cell: (t) => t.reference_number ?? '—' },
  ]

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <OrderContextBar selection={selection} emptyHint="No sales orders yet. Create one under Sales Orders." />
      {!so ? <NoOrderSelected description="Choose a sales order above, or open one from Sales Orders." /> : (
        <div className="space-y-6">
          <Card>
            <CardContent className="space-y-4 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <SalesOrderStatusBadge status={so.order_status} /><OrderFulfilmentBadge status={so.fulfilment_status} />
                {so.order_status === 'ON_HOLD' && so.hold_reason && <span className="text-sm">On hold: {so.hold_reason}</span>}
                {so.order_status === 'CANCELLED' && so.cancel_reason && <span className="text-sm">Cancelled: {so.cancel_reason} ({who(so.cancelled_by)}, {so.cancelled_at ? formatDateTime(so.cancelled_at) : ''})</span>}
              </div>
              <dl className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
                <Stat label="Customer">{so.customer_name_snapshot}{so.customer_code ? ` (${so.customer_code})` : ' (external reference)'}</Stat>
                <Stat label="Source">{so.source === 'CUSTOMER_PO' ? <>PO {so.customer_po_number} · {so.source_po_reference}{so.source_filename && <span className="block text-xs font-normal text-muted-foreground">{so.source_filename}</span>}</> : `Manual${so.customer_po_number ? ` · PO ${so.customer_po_number}` : ''}`}</Stat>
                <Stat label="Order date / requested">{formatDate(so.order_date)} / {so.requested_delivery_date ? formatDate(so.requested_delivery_date) : '—'}</Stat>
                <Stat label="Fulfil from / priority">{so.warehouse_code ?? 'Any warehouse'} · {PRIORITY_LABELS[so.priority]}</Stat>
                <Stat label="Created">{formatDateTime(so.created_at)} · {who(so.created_by)}</Stat>
                <Stat label="Confirmed">{so.confirmed_at ? `${formatDateTime(so.confirmed_at)} · ${who(so.confirmed_by)}` : '—'}</Stat>
                <Stat label="Shipping address">{so.shipping_address_snapshot ?? '—'}</Stat>
                <Stat label="Billing address">{so.billing_address_snapshot ?? '—'}</Stat>
                <Stat label="Customer reference">{so.customer_reference ?? '—'}</Stat>
              </dl>
              {so.internal_notes && <p className="text-sm"><span className="font-medium">Notes:</span> {so.internal_notes}</p>}
              <div className="flex flex-wrap gap-2 border-t pt-4">
                {so.order_status === 'PENDING_CONFIRMATION' && has('sales_orders.confirm') && (
                  <Button onClick={() => setAction({ title: `Confirm ${so.sales_order_number}`, description: 'The order becomes available for allocation and fulfilment. Its status is then calculated from its reservations and dispatches.', confirmLabel: 'Confirm order', note: 'optional',
                    run: async (note) => { const r = await confirmOrder(so.id, note); return `Order confirmed (${r.status.replace(/_/g, ' ').toLowerCase()}).` } })}>Confirm order</Button>
                )}
                {workable && has('customer_po.allocate') && lines.data?.some((l) => Number(l.quantity_unreserved) > 0) && <Button variant="outline" onClick={() => setAllocating(true)}><Lock /> Allocate stock</Button>}
                {workable && has('fulfilment.pick') && <Button variant="outline" asChild><Link to={`/sales/picking?so=${so.id}`}><ScanLine /> Create pick list</Link></Button>}
                {active && has('sales_orders.update') && <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit details</Button>}
                {active && so.order_status !== 'ON_HOLD' && has('sales_orders.update') && (
                  <Button variant="outline" onClick={() => setAction({ title: 'Put order on hold', description: 'New pick lists, picking, packing and dispatch are blocked while on hold. Reservations are kept.', confirmLabel: 'Put on hold', note: 'required',
                    run: async (note) => { const r = await orderAction(so.id, 'HOLD', note); return `Order is ${r.status.replace(/_/g, ' ').toLowerCase()}.` } })}>Put on hold</Button>
                )}
                {so.order_status === 'ON_HOLD' && has('sales_orders.update') && (
                  <Button variant="outline" onClick={() => setAction({ title: 'Resume order', description: 'The status is recalculated from its records.', confirmLabel: 'Resume', note: 'none',
                    run: async () => { const r = await orderAction(so.id, 'RESUME', null); return `Order is ${r.status.replace(/_/g, ' ').toLowerCase()}.` } })}>Resume</Button>
                )}
                {Number(so.unit_totals?.reduce((s, u) => s + Number(u.dispatched), 0) ?? 0) > 0 && has('fulfilment_returns.create') && <Button variant="outline" asChild><Link to={`/sales/returns?so=${so.id}`}><Undo2 /> Record return</Link></Button>}
                {active && has('sales_orders.cancel') && <Button variant="outline" className="text-shortage" asChild><Link to={`/sales/cancellation?so=${so.id}`}><Ban /> Cancel order…</Link></Button>}
              </div>
            </CardContent>
          </Card>

          <DataTable title="Lines" description="Remaining = ordered − cancelled − dispatched. Reserved, picked and packed are stages, not fulfilled quantity."
            columns={lineColumns} data={lines.data ?? []} getRowId={(l) => l.id} loading={lines.loading} pageSize={50}
            error={lines.error ? new Error(describeDataError(lines.error)) : null} onRetry={lines.reload}
            emptyState={{ icon: History, title: 'No lines', description: '' }} />
          <DataTable title="Reservations" description="Stock reserved for this order (lot and location). Dispatch consumes them; cancellation releases what is left."
            columns={resColumns} data={reservations.data ?? []} getRowId={(r) => r.id} loading={reservations.loading} searchable={false} pageSize={25}
            emptyState={{ icon: Lock, title: 'Nothing reserved', description: 'Allocate stock to reserve it for this order.' }} />
          <DataTable title="Pick lists and consignments" columns={fulColumns} data={fulfilments.data ?? []} getRowId={(f) => f.id} loading={fulfilments.loading} searchable={false} pageSize={25}
            emptyState={{ icon: ScanLine, title: 'No pick lists yet', description: 'Create a pick list from the reserved stock.' }} />
          <DataTable title="Stock movements" description="Dispatch postings in the inventory ledger for this order." columns={moveColumns} data={movements.data ?? []} getRowId={(t) => t.id}
            loading={movements.loading} searchable={false} pageSize={25} emptyState={{ icon: History, title: 'Nothing dispatched', description: 'Stock leaves the ledger only when a consignment is dispatched.' }} />
          {(returns.data ?? []).length > 0 && (
            <Card>
              <CardHeader><div><CardTitle>Returns</CardTitle></div></CardHeader>
              <CardContent>
                <ul className="divide-y text-sm">{(returns.data ?? []).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 py-2"><Link className="font-medium text-primary hover:underline" to={`/sales/returns?r=${r.id}`}>{r.return_number}</Link>
                    <ReturnStatusBadge status={r.status} /><span className="text-muted-foreground">{formatDate(r.return_date)} · requested {formatQty(r.requested)} · received {formatQty(r.received)} {r.units}</span></li>
                ))}</ul>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><div><CardTitle>History</CardTitle><CardDescription>Conversion, confirmation, allocation, picking, packing, dispatch, delivery, returns and cancellation (append-only).</CardDescription></div></CardHeader>
            <CardContent><EventTimeline events={events.data ?? []} loading={events.loading} labels={SALES_EVENT_LABELS} /></CardContent>
          </Card>
        </div>
      )}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      {editing && so && <EditDialog so={so} onClose={() => setEditing(false)} onSaved={() => done('Order details saved.')} />}
      {allocating && so && <AllocateDialog orderId={so.id} orderNumber={so.sales_order_number} onClose={() => setAllocating(false)} onDone={done} />}
    </>
  )
}
