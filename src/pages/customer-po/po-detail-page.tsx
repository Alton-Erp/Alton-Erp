import { ArrowLeft, History, Loader2, Pencil, Undo2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { LineStatusBadge, PoStatusBadge } from '@/features/customer-po/po-badges'
import { EventTimeline } from '@/features/production/event-timeline'
import { PoSalesOrdersNotice } from '@/features/sales/po-sales-orders-notice'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchPo, fetchPoDispatches, fetchPoEvents, fetchPoLines, fetchRevisionDiff, poAction, reverseDispatch, updatePoHeader } from '@/services/customer-po'
import type { CustomerPoLineListRow, CustomerPoListRow } from '@/types/database-customer-po'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (<div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm font-medium">{children}</dd></div>)
}

function HeaderDialog({ po, onClose, onSaved }: { po: CustomerPoListRow; onClose: () => void; onSaved: () => void }) {
  const storage = useStorage()
  const [due, setDue] = useState(po.required_delivery_date ?? '')
  const [wh, setWh] = useState(po.fulfilment_warehouse_id ?? 'all')
  const [notes, setNotes] = useState(po.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit PO details</DialogTitle><DialogDescription>Customer, PO number and lines come from the customer's document and are not edited here; import a revision for changes.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3">
          <div className="space-y-1"><Label htmlFor="ph-due">Required delivery date</Label><Input id="ph-due" type="date" min={po.po_date} value={due} onChange={(e) => setDue(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ph-wh">Fulfil from</Label>
            <Select value={wh} onValueChange={setWh}><SelectTrigger id="ph-wh"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any warehouse</SelectItem>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent></Select>
            <p className="text-xs text-muted-foreground">Existing allocations are not moved; this affects availability and future allocation.</p></div>
          <div className="space-y-1"><Label htmlFor="ph-notes">Notes</Label><Textarea id="ph-notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try { await updatePoHeader(po.id, { requiredDeliveryDate: due || null, fulfilmentWarehouseId: wh === 'all' ? null : wh, notes: notes.trim() || null }); onSaved() } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function PoDetailPage() {
  const { poId = '' } = useParams()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const po = useAsync(() => fetchPo(poId), [poId, refresh])
  const lines = useAsync(() => fetchPoLines({ poId }), [poId, refresh])
  const events = useAsync(() => fetchPoEvents(poId), [poId, refresh])
  const diff = useAsync(() => fetchRevisionDiff(poId), [poId, refresh])
  const dispatches = useAsync(() => fetchPoDispatches(poId), [poId, refresh])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const done = (m: string) => { setAction(null); setEditing(false); setMessage(m); setRefresh((n) => n + 1) }

  const p = po.data
  const crumbs = [{ label: 'Purchase Orders & Fulfilment' }, { label: 'PO Register', to: '/customer-pos/register' }, { label: p?.customer_po_number ?? '…' }]
  if (po.loading && !p) return (<><PageHeader title="Customer PO" breadcrumbs={crumbs} /><LoadingState variant="cards" rows={4} /></>)
  if (po.error || !p) return (<><PageHeader title="Customer PO" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(po.error)} onRetry={po.reload} /></Card></>)
  const active = p.status !== 'CANCELLED' && p.status !== 'FULFILLED'

  const lineColumns: DataTableColumn<CustomerPoLineListRow>[] = [
    { id: 'line', header: 'Line', cell: (l) => l.line_no },
    { id: 'uploaded', header: 'Uploaded', cell: (l) => <span className="text-xs">{l.uploaded_sku ?? l.uploaded_customer_sku ?? l.uploaded_barcode ?? '—'}{l.uploaded_description && <span className="block text-muted-foreground">{l.uploaded_description}</span>}</span>, searchValue: (l) => `${l.uploaded_sku ?? ''} ${l.uploaded_description ?? ''}` },
    { id: 'product', header: 'Product', cell: (l) => (l.sku ? `${l.sku} — ${l.product_name}` : '—'), searchValue: (l) => l.sku ?? '' },
    { id: 'status', header: 'Status', cell: (l) => <LineStatusBadge status={l.line_status} /> },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (l) => formatQty(l.quantity_ordered, l.unit ?? undefined) },
    { id: 'price', header: 'Unit price', align: 'right', cell: (l) => (l.unit_price === null ? '—' : `${Number(l.unit_price).toLocaleString('en-IN')} ${l.currency ?? ''}`) },
    { id: 'alloc', header: 'Allocated', align: 'right', cell: (l) => formatQty(l.allocated_open) },
    { id: 'disp', header: 'Dispatched', align: 'right', cell: (l) => formatQty(l.quantity_dispatched) },
  ]
  type Dispatch = NonNullable<typeof dispatches.data>[number]
  const dispatchColumns: DataTableColumn<Dispatch>[] = [
    { id: 'tx', header: 'Transaction', cell: (d) => d.transaction_number },
    { id: 'at', header: 'Date', cell: (d) => formatDateTime(d.transaction_date) },
    { id: 'product', header: 'Product', cell: (d) => d.sku },
    { id: 'where', header: 'From', cell: (d) => `${d.warehouse_code}/${d.location_code}${d.batch_number ? ` · ${d.batch_number}` : ''}` },
    { id: 'qty', header: 'Quantity', align: 'right', cell: (d) => formatQty(d.quantity, d.unit) },
    { id: 'rev', header: '', cell: (d) => (d.reversed_by_number ? <span className="text-xs text-muted-foreground">Reversed by {d.reversed_by_number}</span>
      : has('customer_po.fulfil') && has('inventory.approve_adjustment') && p.status !== 'CANCELLED' ? (
        <Button variant="ghost" size="sm" onClick={() => setAction({
          title: `Reverse dispatch ${d.transaction_number}`, description: 'The stock returns to the same lot and location as available stock; the line\'s dispatched quantity is reduced and the PO status recalculated.',
          confirmLabel: 'Post reversal', note: 'required', destructive: true,
          run: async (note, key) => { const r = await reverseDispatch(d.id, note!, key); return `Reversed: ${r.reversal_numbers.join(', ')}.` },
        })}><Undo2 /> Reverse</Button>
      ) : null) },
  ]

  return (
    <>
      <PageHeader
        title={`${p.customer_po_number}${p.revision > 1 ? ` (revision ${p.revision})` : ''}`}
        description={`${p.customer_name_snapshot} · ${p.po_reference}`}
        breadcrumbs={crumbs}
        actions={<Button variant="outline" asChild><Link to="/customer-pos/register"><ArrowLeft /> PO Register</Link></Button>}
      />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <PoSalesOrdersNotice poId={p.id} poStatus={p.status} isCurrent={p.is_current} refreshKey={refresh} />
      {!p.is_current && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">This revision has been superseded by a newer revision of the same PO. It is kept for history; review and release any allocations it still holds.</p>}
      <Card className="mb-6">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2"><PoStatusBadge status={p.status} />{p.status === 'ON_HOLD' && p.hold_reason && <span className="text-sm">On hold: {p.hold_reason}</span>}</div>
          <dl className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Customer">{p.customer_name_snapshot}{p.customer_code ? ` (${p.customer_code})` : ' (external reference)'}</Stat>
            <Stat label="PO date / delivery">{formatDate(p.po_date)} / {p.required_delivery_date ? formatDate(p.required_delivery_date) : '—'}</Stat>
            <Stat label="Fulfil from">{p.fulfilment_warehouse_code ?? 'Any warehouse'}</Stat>
            <Stat label="Currency">{p.currency ?? '—'}</Stat>
            <Stat label="Source file">{p.source_filename ?? '—'}</Stat>
            <Stat label="Imported">{formatDateTime(p.created_at)}</Stat>
          </dl>
          {p.notes && <p className="text-sm"><span className="font-medium">Notes:</span> {p.notes}</p>}
          {p.cancel_reason && <p className="text-sm"><span className="font-medium">Cancelled:</span> {p.cancel_reason}</p>}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="outline" asChild><Link to={`/customer-pos/matching?po=${p.id}`}>Product matching</Link></Button>
            <Button variant="outline" asChild><Link to={`/customer-pos/availability?po=${p.id}`}>Stock availability</Link></Button>
            <Button asChild><Link to={`/customer-pos/fulfilment?po=${p.id}`}>Fulfilment planning</Link></Button>
            <Button variant="outline" asChild><Link to={`/customer-pos/allocations?po=${p.id}`}>Allocations</Link></Button>
            {active && has('customer_po.update') && <Button variant="outline" onClick={() => setEditing(true)}><Pencil /> Edit details</Button>}
            {active && p.status !== 'ON_HOLD' && has('customer_po.update') && <Button variant="outline" onClick={() => setAction({ title: 'Put PO on hold', description: 'Allocation and dispatch are blocked while on hold. Existing reservations are kept.', confirmLabel: 'Put on hold', note: 'required', run: async (note) => { const r = await poAction(p.id, 'HOLD', note); return `PO is ${r.status.replace(/_/g, ' ').toLowerCase()}.` } })}>Put on hold</Button>}
            {p.status === 'ON_HOLD' && has('customer_po.update') && <Button variant="outline" onClick={() => setAction({ title: 'Resume PO', description: 'The status is recalculated from its lines and reservations.', confirmLabel: 'Resume', note: 'none', run: async () => { const r = await poAction(p.id, 'RESUME', null); return `PO is ${r.status.replace(/_/g, ' ').toLowerCase()}.` } })}>Resume</Button>}
            {active && has('customer_po.cancel') && <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: `Cancel ${p.customer_po_number}`, description: 'All open reservations of this PO are released. Dispatched quantities are not reversed. The PO and its history are kept.', confirmLabel: 'Cancel PO', note: 'required', destructive: true, run: async (note) => { const r = await poAction(p.id, 'CANCEL', note); return `PO cancelled; ${formatQty(r.released_quantity)} released.` } })}>Cancel PO</Button>}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <DataTable title="Lines" description="Original uploaded values are kept; corrections and matches are recorded in the history."
          columns={lineColumns} data={lines.data ?? []} getRowId={(l) => l.id} loading={lines.loading}
          error={lines.error ? new Error(describeDataError(lines.error)) : null} onRetry={lines.reload} pageSize={25}
          emptyState={{ icon: History, title: 'No lines', description: '' }} />
        {diff.data?.previous_revision && (
          <Card>
            <CardHeader><div><CardTitle>Changes from revision {diff.data.previous_revision.revision}</CardTitle><CardDescription>Compared by product (or uploaded code). Reservations of the previous revision must be reviewed and released before this revision is allocated. <Link className="underline" to={`/customer-pos/${diff.data.previous_revision.po_id}`}>Open {diff.data.previous_revision.po_reference}</Link></CardDescription></div></CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Item</th><th className="pb-1 text-left">Change</th><th className="pb-1 text-right">Previous qty</th><th className="pb-1 text-right">New qty</th><th className="pb-1 text-right">Still reserved on previous</th></tr></thead>
                <tbody>{diff.data.changes.map((c) => (
                  <tr key={`${c.code}-${c.change}`} className="border-t"><td className="py-1">{c.code}</td><td className="py-1">{c.change.toLowerCase()}</td><td className="py-1 text-right">{formatQty(c.previous_quantity)}</td><td className="py-1 text-right">{formatQty(c.new_quantity)}</td><td className="py-1 text-right">{formatQty(c.previous_reserved)}</td></tr>
                ))}</tbody>
              </table>
            </CardContent>
          </Card>
        )}
        <DataTable title="Dispatches" description="Physical fulfilment recorded as stock issues against this PO's reservations."
          columns={dispatchColumns} data={dispatches.data ?? []} getRowId={(d) => d.id} loading={dispatches.loading} searchable={false}
          emptyState={{ icon: History, title: 'Nothing dispatched', description: 'Reserved stock is dispatched from Allocation & Reservations.' }} />
        <Card>
          <CardHeader><div><CardTitle>History</CardTitle><CardDescription>Every import, match, allocation, release, dispatch and status change.</CardDescription></div></CardHeader>
          <CardContent><EventTimeline events={events.data ?? []} loading={events.loading} /></CardContent>
        </Card>
      </div>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      {editing && <HeaderDialog po={p} onClose={() => setEditing(false)} onSaved={() => done('PO details saved.')} />}
    </>
  )
}
