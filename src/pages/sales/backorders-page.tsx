import { ListTodo, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { AllocateDialog } from '@/features/sales/allocate-dialog'
import { SalesOrderStatusBadge } from '@/features/sales/sales-badges'
import { WORKABLE_ORDER_STATUSES, parseQty } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchOrderLines, releaseOrder, updateOrderLine } from '@/services/sales'
import type { SalesOrderLineListRow } from '@/types/database-sales'
import { useUrlEnum } from '@/hooks/use-url-state'

type Tab = 'BACKORDERED' | 'OUTSTANDING'

function LineDialog({ line, onClose, onDone }: { line: SalesOrderLineListRow; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState(line.backorder_reason ?? '')
  const [expected, setExpected] = useState(line.expected_fulfilment_date ?? '')
  const [reduce, setReduce] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const maxReduce = Math.max(Number(line.quantity_remaining) - Number(line.quantity_planned), 0)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{line.sales_order_number} line {line.line_no} · {line.sku_snapshot}</DialogTitle>
          <DialogDescription>Remaining {formatQty(line.quantity_remaining, line.unit)} (reserved {formatQty(line.quantity_reserved)}, on pick lists {formatQty(line.quantity_planned)}). The remainder stays open after partial deliveries until you change it here.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3">
          <div className="space-y-1"><Label htmlFor="bo-reason">Backorder reason</Label><Input id="bo-reason" maxLength={500} placeholder="e.g. awaiting production / supplier delivery" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="bo-date">Expected next fulfilment date</Label><Input id="bo-date" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="bo-reduce">Reduce quantity by (customer-approved, optional)</Label><Input id="bo-reduce" inputMode="decimal" placeholder={`0 – ${formatQty(maxReduce)}`} value={reduce} onChange={(e) => setReduce(e.target.value)} />
            <p className="text-xs text-muted-foreground">Dispatched quantity and quantity on open pick lists cannot be reduced. Reservations above the new quantity are released.</p></div>
          <div className="space-y-1"><Label htmlFor="bo-note">Customer approval / note{reduce.trim() && Number(reduce) > 0 ? ' (required)' : ''}</Label><Textarea id="bo-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            const r = parseQty(reduce)
            if (r === null || r > maxReduce) return setError(`Reduce by between 0 and ${formatQty(maxReduce)} (up to 3 decimals).`)
            if (r > 0 && note.trim().length < 3) return setError('Record the customer approval for the quantity change.')
            setBusy(true); setError(null)
            try {
              const res = await updateOrderLine(line.id, { backorderReason: reason.trim(), expectedDate: expected || null, cancelQuantity: r || null, note: note.trim() || null })
              onDone(r > 0 ? `Line ${line.line_no} reduced by ${formatQty(r)}${res.released_quantity ? `; ${formatQty(res.released_quantity)} released` : ''}.` : `Line ${line.line_no} backorder details saved.`)
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function BackordersPage() {
  const { has } = usePermissions()
  // Kept in the address, so Back from a record returns to the same tab.
  const [tab, setTab] = useUrlEnum<Tab>('lines', ['BACKORDERED', 'OUTSTANDING'], 'BACKORDERED')
  const [refresh, setRefresh] = useState(0)
  const lines = useAsync(() => fetchOrderLines({ openOnly: true, backorderedOnly: tab === 'BACKORDERED' }), [tab, refresh])
  const [editing, setEditing] = useState<SalesOrderLineListRow | null>(null)
  const [allocating, setAllocating] = useState<SalesOrderLineListRow | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const done = (m: string) => { setEditing(null); setAllocating(null); setAction(null); setMessage(m); setRefresh((n) => n + 1) }
  const workable = (l: SalesOrderLineListRow) => (WORKABLE_ORDER_STATUSES as readonly string[]).includes(l.order_status)

  const columns: DataTableColumn<SalesOrderLineListRow>[] = [
    { id: 'order', header: 'Order', cell: (l) => <span><Link className="font-medium text-primary hover:underline" to={`/sales/orders/${l.sales_order_id}`}>{l.sales_order_number}</Link><span className="block text-xs text-muted-foreground">{l.customer_name_snapshot}</span></span>,
      searchValue: (l) => `${l.sales_order_number} ${l.customer_name_snapshot} ${l.customer_po_number ?? ''}` },
    { id: 'status', header: 'Order status', cell: (l) => <SalesOrderStatusBadge status={l.order_status} /> },
    { id: 'product', header: 'Line / product', cell: (l) => <span>{l.line_no} · {l.sku_snapshot}<span className="block text-xs text-muted-foreground">{l.product_name_snapshot}</span></span>, searchValue: (l) => `${l.sku_snapshot} ${l.product_name_snapshot}` },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (l) => formatQty(l.quantity_effective, l.unit), sortValue: (l) => Number(l.quantity_effective) },
    { id: 'reserved', header: 'Reserved', align: 'right', cell: (l) => formatQty(l.quantity_reserved) },
    { id: 'picked', header: 'Picked / packed', align: 'right', cell: (l) => `${formatQty(l.quantity_picked)} / ${formatQty(l.quantity_packed)}` },
    { id: 'dispatched', header: 'Dispatched', align: 'right', cell: (l) => formatQty(l.quantity_dispatched) },
    { id: 'delivered', header: 'Delivered', align: 'right', cell: (l) => formatQty(l.quantity_delivered) },
    { id: 'returned', header: 'Returned', align: 'right', cell: (l) => formatQty(l.quantity_returned) },
    { id: 'remaining', header: 'Remaining', align: 'right', cell: (l) => <span className="font-medium">{formatQty(l.quantity_remaining)}</span>, sortValue: (l) => Number(l.quantity_remaining) },
    { id: 'unreserved', header: 'Unreserved / available now', align: 'right', cell: (l) => (
      <span className={Number(l.quantity_unreserved) > 0 ? 'text-shortage' : ''}>{formatQty(l.quantity_unreserved)}<span className="block text-xs text-muted-foreground">{formatQty(l.available_now)} eligible in stock</span></span>
    ), sortValue: (l) => Number(l.quantity_unreserved) },
    { id: 'reason', header: 'Backorder', cell: (l) => <span className="text-xs">{l.backorder_reason ?? '—'}{l.expected_fulfilment_date && <span className="block text-muted-foreground">expected {formatDate(l.expected_fulfilment_date)}</span>}</span> },
    { id: 'due', header: 'Requested', cell: (l) => (l.requested_delivery_date ? formatDate(l.requested_delivery_date) : '—'), sortValue: (l) => l.requested_delivery_date },
    { id: 'act', header: '', cell: (l) => (
      <div className="flex flex-wrap justify-end gap-0.5">
        {workable(l) && has('customer_po.allocate') && Number(l.quantity_unreserved) > 0 && Number(l.available_now) > 0 && <Button variant="ghost" size="sm" onClick={() => setAllocating(l)}>Allocate</Button>}
        {has('sales_orders.update') && l.order_status !== 'CANCELLED' && <Button variant="ghost" size="sm" onClick={() => setEditing(l)}>Update</Button>}
        {has('fulfilment_reservations.release') && Number(l.quantity_reserved) > Number(l.quantity_planned) && (
          <Button variant="ghost" size="sm" onClick={() => setAction({ title: `Release stock reserved for ${l.sales_order_number} line ${l.line_no}`,
            description: 'Reserved stock not on an open pick list returns to available stock. The line stays open as a backorder.', confirmLabel: 'Release', note: 'optional',
            run: async (note) => { const r = await releaseOrder(l.sales_order_id, l.id, null, note); return `${formatQty(r.released_quantity)} released.` } })}>Release</Button>
        )}
      </div>
    ) },
  ]

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <p className="mb-4 rounded-lg border bg-background px-4 py-2.5 text-sm">
        Remaining = ordered − cancelled − dispatched. Reserved, picked and packed are stages towards dispatch, not fulfilled quantity, and returned goods are not available again until inspected and restocked.
        Nothing here creates production or purchase orders automatically, and remaining quantities are never cancelled because another consignment was delivered.
      </p>
      <DataTable title="Outstanding order lines" columns={columns} data={lines.data ?? []} getRowId={(l) => l.id} loading={lines.loading} pageSize={25}
        error={lines.error ? new Error(describeDataError(lines.error)) : null} onRetry={lines.reload} searchPlaceholder="Search order, customer or SKU…"
        toolbar={<FilterTabs<Tab> label="Lines" value={tab} onChange={setTab} options={[{ value: 'BACKORDERED', label: 'Not covered by stock' }, { value: 'OUTSTANDING', label: 'All outstanding' }]} />}
        emptyState={{ icon: ListTodo, title: tab === 'BACKORDERED' ? 'No backorders' : 'Nothing outstanding', description: 'Open order lines with quantity still to dispatch appear here.' }} />
      {editing && <LineDialog line={editing} onClose={() => setEditing(null)} onDone={done} />}
      {allocating && <AllocateDialog orderId={allocating.sales_order_id} orderNumber={allocating.sales_order_number} lineId={allocating.id} lineLabel={`line ${allocating.line_no} ${allocating.sku_snapshot}`} onClose={() => setAllocating(null)} onDone={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
