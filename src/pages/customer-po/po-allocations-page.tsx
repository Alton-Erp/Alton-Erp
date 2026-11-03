import { Lock, Loader2, Truck, Unlock } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ReservationStatusBadge } from '@/features/inventory/inventory-badges'
import { formatQty, parseQuantity } from '@/features/inventory/inventory-model'
import { ALLOCATION_EXPORT, RUNS_EXPORT } from '@/features/customer-po/export-columns'
import { ExportMenu } from '@/features/customer-po/po-export'
import { STRATEGY_LABELS } from '@/features/customer-po/po-import'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import { dispatchPo, fetchAllocationRuns, fetchPoAllocations, releasePo } from '@/services/customer-po'
import type { PoAllocationListRow, PoAllocationRunRow } from '@/types/database-customer-po'

function DispatchDialog({ row, onClose, onDone }: { row: PoAllocationListRow; onClose: () => void; onDone: (m: string) => void }) {
  const remaining = Number(row.quantity) - Number(row.fulfilled_quantity) - Number(row.released_quantity)
  const [qty, setQty] = useState(String(remaining))
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record dispatch — {row.reservation_number}</DialogTitle>
          <DialogDescription>Issues the reserved stock ({row.sku} at {row.warehouse_code}/{row.location_code}{row.batch_number ? `, batch ${row.batch_number}` : ''}) for {row.customer_po_number}. This reduces on-hand stock. No invoice or shipping label is created.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="dp-qty">Quantity (max {formatQty(remaining, row.base_unit)})</Label><Input id="dp-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="dp-ref">Delivery note / reference</Label><Input id="dp-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            const q = parseQuantity(qty)
            if (!q || q > remaining) return setError(`Enter a quantity between 0 and ${formatQty(remaining)}.`)
            setBusy(true); setError(null)
            try {
              const r = await dispatchPo(row.purchase_order_id, [{ reservation_id: row.id, quantity: q }], reference.trim() || null, null, key)
              renew()
              onDone(`Dispatched: ${r.transaction_numbers.join(', ')}. PO is ${r.status.replace(/_/g, ' ').toLowerCase()}.`)
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Post dispatch</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function PoAllocationsPage() {
  const { has } = usePermissions()
  const [params] = useSearchParams()
  const poId = params.get('po')
  const [filter, setFilter] = useState<'OPEN' | 'ALL'>('OPEN')
  const [refresh, setRefresh] = useState(0)
  const rows = useAsync(() => fetchPoAllocations({ poId, openOnly: filter === 'OPEN' }), [poId, filter, refresh])
  const runs = useAsync(() => fetchAllocationRuns(poId), [poId, refresh])
  const names = useAsync(() => fetchDisplayNames((runs.data ?? []).map((r) => r.created_by)), [runs.data])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [dispatching, setDispatching] = useState<PoAllocationListRow | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const done = (m: string) => { setAction(null); setDispatching(null); setMessage(m); setRefresh((n) => n + 1) }
  const open = (r: PoAllocationListRow) => r.reservation_status === 'ACTIVE' || r.reservation_status === 'PARTIALLY_FULFILLED'

  const columns: DataTableColumn<PoAllocationListRow>[] = [
    { id: 'res', header: 'Reservation', cell: (r) => <span className="font-medium">{r.reservation_number}</span>, searchValue: (r) => r.reservation_number },
    { id: 'po', header: 'PO', cell: (r) => <Link className="text-primary hover:underline" to={`/customer-pos/${r.purchase_order_id}`}>{r.customer_po_number}</Link>, searchValue: (r) => `${r.customer_po_number} ${r.po_reference} ${r.customer_name_snapshot}` },
    { id: 'customer', header: 'Customer', cell: (r) => r.customer_name_snapshot },
    { id: 'line', header: 'Line', cell: (r) => r.line_no },
    { id: 'product', header: 'Product', cell: (r) => <span>{r.sku}<span className="block text-xs text-muted-foreground">{r.product_name}</span></span>, searchValue: (r) => `${r.sku} ${r.product_name}` },
    { id: 'where', header: 'Warehouse / location / batch', cell: (r) => <span className="text-xs">{r.warehouse_code} / {r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''}{r.expiry_date ? ` · exp ${formatDate(r.expiry_date)}` : ''}</span> },
    { id: 'qty', header: 'Reserved', align: 'right', cell: (r) => formatQty(r.quantity, r.base_unit) },
    { id: 'disp', header: 'Dispatched', align: 'right', cell: (r) => formatQty(r.fulfilled_quantity) },
    { id: 'rel', header: 'Released', align: 'right', cell: (r) => formatQty(r.released_quantity) },
    { id: 'at', header: 'Reserved at', cell: (r) => formatDateTime(r.reserved_at), sortValue: (r) => r.reserved_at },
    { id: 'status', header: 'Status', cell: (r) => <ReservationStatusBadge status={r.reservation_status} /> },
    { id: 'act', header: '', cell: (r) => open(r) ? (
      <span className="flex justify-end gap-0.5">
        {has('customer_po.fulfil') && r.po_status !== 'ON_HOLD' && <Button variant="ghost" size="sm" onClick={() => setDispatching(r)}><Truck /> Dispatch</Button>}
        {has('customer_po.release') && <Button variant="ghost" size="sm" onClick={() => setAction({
          title: `Release ${r.reservation_number}`,
          description: 'The remaining reserved quantity returns to available stock and the PO status is recalculated. The reservation is kept in history.',
          confirmLabel: 'Release', note: 'optional', destructive: true,
          run: async (note) => { const x = await releasePo(r.purchase_order_id, null, r.id, note); return `Released ${formatQty(x.released_quantity)}. PO is ${x.status.replace(/_/g, ' ').toLowerCase()}.` },
        })}><Unlock /> Release</Button>}
      </span>
    ) : null },
  ]
  const runColumns: DataTableColumn<PoAllocationRunRow>[] = [
    { id: 'at', header: 'Time', cell: (r) => formatDateTime(r.created_at) },
    { id: 'type', header: 'Type', cell: (r) => (r.run_type === 'COMMITTED' ? 'Committed' : 'Draft (no reservation)') },
    { id: 'strategy', header: 'Strategy', cell: (r) => STRATEGY_LABELS[r.strategy] },
    { id: 'user', header: 'User', cell: (r) => (r.created_by && names.data?.get(r.created_by)) || '—' },
    { id: 'result', header: 'Result', cell: (r) => {
      const res = r.result as { reservations?: unknown[]; shortages?: unknown[] }
      return r.run_type === 'COMMITTED' ? `${res.reservations?.length ?? 0} reservation(s), ${res.shortages?.length ?? 0} line(s) short` : `${Array.isArray(r.plan) ? r.plan.length : 0} planned lot(s)`
    } },
    { id: 'note', header: 'Note', cell: (r) => r.note ?? '' },
  ]

  return (
    <>
      <PageHeader actions={
        <>
          <ExportMenu title="Allocations" fileStem="po-allocations" label="Allocation report" columns={ALLOCATION_EXPORT} rows={rows.data ?? []} />
          <ExportMenu title="Allocation audit" fileStem="po-allocation-audit" label="Allocation audit" columns={RUNS_EXPORT}
            rows={(runs.data ?? []).map((r) => ({ ...r, actor: (r.created_by && names.data?.get(r.created_by)) || undefined }))} />
        </>
      } />
      {poId && <p className="mb-4 text-sm">Showing one PO. <Link className="text-primary underline" to="/customer-pos/allocations">Show all POs</Link></p>}
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <DataTable
        title="Stock reserved for customer POs"
        description="Allocations are inventory reservations: they reduce available stock but not on-hand stock until dispatched."
        columns={columns}
        data={rows.data ?? []}
        getRowId={(r) => r.id}
        loading={rows.loading}
        error={rows.error ? new Error(describeDataError(rows.error)) : null}
        onRetry={rows.reload}
        pageSize={25}
        searchPlaceholder="Search reservation, PO, customer or product…"
        toolbar={<FilterTabs<'OPEN' | 'ALL'> label="Reservation filter" value={filter} onChange={setFilter} options={[{ value: 'OPEN', label: 'Open' }, { value: 'ALL', label: 'All' }]} />}
        emptyState={{ icon: Lock, title: 'No allocations', description: 'Allocate stock to a PO in Fulfilment Planning.' }}
      />
      <DataTable className="mt-6" title="Allocation runs" description="Who allocated, when, with which strategy, and the result. Drafts reserve nothing."
        columns={runColumns} data={runs.data ?? []} getRowId={(r) => r.id} loading={runs.loading} searchable={false} pageSize={10}
        emptyState={{ icon: Lock, title: 'No allocation runs', description: 'Nothing has been allocated yet.' }} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      {dispatching && <DispatchDialog row={dispatching} onClose={() => setDispatching(null)} onDone={done} />}
    </>
  )
}
