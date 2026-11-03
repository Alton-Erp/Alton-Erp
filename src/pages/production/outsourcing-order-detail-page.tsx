import { ArrowLeft, History, Loader2, PackagePlus, Pencil, Send, Undo2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { EventTimeline } from '@/features/production/event-timeline'
import { MaterialMoveDialog, OutsourcedReceiptDialog, OutsourcingOrderDialog } from '@/features/production/outsourcing-dialogs'
import { MakeTypeBadge, OutsourcingStatusBadge, PostedBadge } from '@/features/production/production-badges'
import { DISPOSITION_LABELS, OUTSOURCING_ACTION_FROM, OUTSOURCING_TYPE_LABELS, canDo } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDate } from '@/lib/format'
import { fetchOutsourcingOrder, outsourcingOrderAction, releaseOutsourcingOrder, reverseOutsourcedReceipt, type OutsourcingAction } from '@/services/production'
import type { OutsourcingMaterialListRow, OutsourcingMovementListRow, OutsourcingReceiptListRow } from '@/types/database-production'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (<div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm font-medium">{children}</dd></div>)
}

const MOVEMENT_LABEL: Record<string, string> = { DISPATCH: 'Sent to supplier', RETURN: 'Returned by supplier', CONSUMPTION: 'Used by supplier' }

export default function OutsourcingOrderDetailPage() {
  const { orderId = '' } = useParams()
  const { user } = useAuth()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const data = useAsync(() => fetchOutsourcingOrder(orderId), [orderId, refresh])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [dialog, setDialog] = useState<'edit' | 'dispatch' | 'return' | 'receive' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const reload = () => setRefresh((n) => n + 1)

  const o = data.data?.order
  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Outsourcing Orders', to: '/production/outsourcing' }, { label: o?.outsourcing_order_number ?? '…' }]
  if (data.loading && !o) return (<><PageHeader title="Outsourcing order" breadcrumbs={crumbs} /><LoadingState variant="cards" rows={4} /></>)
  if (data.error || !o || !data.data) return (<><PageHeader title="Outsourcing order" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)
  const { materials, receipts, movements, events } = data.data

  const can = (a: string) => canDo(OUTSOURCING_ACTION_FROM, a, o.status)
  // V2 single-operator: submit + approve in one click, no confirmation step.
  const release = async () => {
    setReleasing(true)
    setReleaseError(null)
    try {
      await releaseOutsourcingOrder(o.id, null)
      setMessage(`${o.outsourcing_order_number} is released. You can send material and receive goods.`)
      reload()
    } catch (e) {
      setReleaseError(describeDataError(e))
    } finally {
      setReleasing(false)
    }
  }
  const heldTotal = materials.some((m) => Number(m.held_quantity) > 0)
  const canEdit = o.status === 'DRAFT' && has('outsourcing_order.create') && (o.created_by === user?.id || has('outsourcing_order.approve'))
  const mayReverse = has('production_exception.approve') && o.status !== 'COMPLETED' && o.status !== 'CANCELLED'

  const workflow = (kind: OutsourcingAction): ActionRequest => {
    const run = async (note: string | null, key: string) => {
      const r = await outsourcingOrderAction(o.id, kind, note, key)
      return `${o.outsourcing_order_number} is now ${r.status.replace(/_/g, ' ').toLowerCase()}.`
    }
    switch (kind) {
      case 'SUBMIT': return { run, title: 'Submit for approval', description: 'The order cannot be edited while awaiting approval.', confirmLabel: 'Submit', note: 'none' }
      case 'WITHDRAW': return { run, title: 'Withdraw from approval', description: 'The order returns to draft.', confirmLabel: 'Withdraw', note: 'none' }
      case 'APPROVE': return { run, title: `Approve ${o.outsourcing_order_number}`, description: 'Approval allows material to be dispatched and goods to be received. It does not move stock.', confirmLabel: 'Approve', note: 'optional' }
      case 'REJECT': return { run, title: 'Reject order', description: 'The order returns to draft with your reason.', confirmLabel: 'Reject', note: 'required', destructive: true }
      case 'HOLD': return { run, title: 'Put on hold', description: 'No dispatches or receipts can be posted while on hold (returns of material are still possible).', confirmLabel: 'Put on hold', note: 'required' }
      case 'RESUME': return { run, title: 'Resume order', description: 'Returns the order to its previous status.', confirmLabel: 'Resume', note: 'none' }
      case 'CANCEL': return { run, title: `Cancel ${o.outsourcing_order_number}`, description: 'Only possible when no goods have been received (or receipts were reversed) and no company material is still at the supplier.', confirmLabel: 'Cancel order', note: 'required', destructive: true }
      case 'COMPLETE': {
        const disc: string[] = []
        if (Number(o.received_quantity) < Number(o.ordered_quantity)) disc.push(`Received ${formatQty(o.received_quantity, o.unit)} of ${formatQty(o.ordered_quantity, o.unit)} ordered.`)
        for (const m of materials) if (Number(m.held_quantity) > 0) disc.push(`${m.sku}: ${formatQty(m.held_quantity, m.unit)} of company material is still at the supplier.`)
        return {
          run,
          title: `Complete ${o.outsourcing_order_number}`,
          description: disc.length ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
              <p className="font-medium">Open items — completing requires the production exception permission and a documented reason:</p>
              <ul className="mt-1 list-disc pl-5">{disc.map((d) => <li key={d}>{d}</li>)}</ul>
            </div>
          ) : <p className="text-green-700">Everything ordered has been received and no company material is left at the supplier.</p>,
          confirmLabel: 'Complete order',
          note: disc.length ? 'required' : 'optional',
          minLength: disc.length ? 5 : undefined,
        }
      }
    }
  }

  const materialColumns: DataTableColumn<OutsourcingMaterialListRow>[] = [
    { id: 'sku', header: 'Material', cell: (m) => <span><span className="font-medium">{m.sku}</span><span className="block text-xs text-muted-foreground">{m.product_name}</span></span> },
    { id: 'planned', header: 'Planned', align: 'right', cell: (m) => formatQty(m.planned_quantity, m.unit) },
    { id: 'sent', header: 'Sent', align: 'right', cell: (m) => formatQty(m.dispatched_quantity) },
    { id: 'returned', header: 'Returned', align: 'right', cell: (m) => formatQty(m.returned_quantity) },
    { id: 'used', header: 'Used by supplier', align: 'right', cell: (m) => formatQty(m.consumed_quantity) },
    { id: 'held', header: 'Held at supplier', align: 'right', cell: (m) => <span className={Number(m.held_quantity) > 0 ? 'font-medium text-violet-700' : undefined}>{formatQty(m.held_quantity, m.unit)}</span> },
  ]
  const receiptColumns: DataTableColumn<OutsourcingReceiptListRow>[] = [
    { id: 'no', header: 'Receipt', cell: (r) => r.receipt_number },
    { id: 'date', header: 'Date', cell: (r) => formatDate(r.receipt_date) },
    { id: 'doc', header: 'Supplier doc.', cell: (r) => r.supplier_document_number ?? '' },
    { id: 'batch', header: 'Batch', cell: (r) => r.batch_number ?? (r.batch_id ? 'System lot' : '—') },
    { id: 'recv', header: 'Received', align: 'right', cell: (r) => formatQty(r.received_quantity, r.unit) },
    { id: 'acc', header: 'Accepted', align: 'right', cell: (r) => formatQty(r.accepted_quantity) },
    { id: 'rej', header: 'Rejected', align: 'right', cell: (r) => (Number(r.rejected_quantity) > 0 ? `${formatQty(r.rejected_quantity)} · ${DISPOSITION_LABELS[r.rejection_disposition ?? ''] ?? ''}${r.rejected_location_code ? ` (${r.rejected_location_code})` : ''}` : '0') },
    { id: 'status', header: 'Status', cell: (r) => <PostedBadge status={r.status} /> },
    { id: 'act', header: '', cell: (r) => mayReverse && r.status === 'POSTED' ? (
      <Button variant="ghost" size="sm" onClick={() => setAction({
        title: `Reverse ${r.receipt_number}`,
        description: 'Removes the received goods from stock (they must still be there) and restores the material recorded as used by the supplier to the supplier location. The receipt is kept and marked reversed.',
        confirmLabel: 'Post reversal', note: 'required', destructive: true,
        run: async (note, key) => { const x = await reverseOutsourcedReceipt(r.id, note!, key); return `Reversed: ${x.reversal_numbers.join(', ')}.` },
      })}><Undo2 /> Reverse</Button>
    ) : null },
  ]
  const movementColumns: DataTableColumn<OutsourcingMovementListRow>[] = [
    { id: 'date', header: 'Date', cell: (m) => formatDate(m.movement_date) },
    { id: 'type', header: 'Movement', cell: (m) => MOVEMENT_LABEL[m.movement_type] },
    { id: 'sku', header: 'Material', cell: (m) => m.sku },
    { id: 'batch', header: 'Batch', cell: (m) => m.batch_number ?? '—' },
    { id: 'route', header: 'From → to', cell: (m) => <span className="text-xs">{m.from_location_code} → {m.to_location_code ?? 'consumed'}</span> },
    { id: 'qty', header: 'Quantity', align: 'right', cell: (m) => formatQty(m.quantity, m.unit) },
    { id: 'tx', header: 'Ledger', cell: (m) => m.out_transaction_number ?? '' },
    { id: 'status', header: 'Status', cell: (m) => <PostedBadge status={m.status} /> },
  ]

  return (
    <>
      <PageHeader title={o.outsourcing_order_number} description={`${o.sku} — ${o.product_name} · ${o.supplier_name}`} breadcrumbs={crumbs}
        actions={<Button variant="outline" asChild><Link to="/production/outsourcing"><ArrowLeft /> All outsourcing orders</Link></Button>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {releaseError && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{releaseError}</p>}

      <Card className="mb-6">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <OutsourcingStatusBadge status={o.status} />
            <MakeTypeBadge kind="OUTSOURCED" />
            <span className="text-sm text-muted-foreground">{OUTSOURCING_TYPE_LABELS[o.order_type]}</span>
          </div>
          <dl className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Ordered">{formatQty(o.ordered_quantity, o.unit)}</Stat>
            <Stat label="Received / accepted / rejected">{formatQty(o.received_quantity)} / {formatQty(o.accepted_quantity)} / {formatQty(o.rejected_quantity)}</Stat>
            <Stat label="Pending">{formatQty(o.pending_quantity, o.unit)}</Stat>
            <Stat label="Supplier">{o.supplier_name}{o.supplier_reference ? ` (${o.supplier_reference})` : ''}</Stat>
            <Stat label="Expected / first dispatch">{formatDate(o.expected_return_date)} / {o.dispatch_date ? formatDate(o.dispatch_date) : '—'}</Stat>
            <Stat label="Goods to / material held at">{o.destination_warehouse_code} / {o.external_location_code ? `${o.external_location_code} (${o.external_holder})` : '—'}</Stat>
            <Stat label={o.order_type === 'OUTSOURCED_PROCESSING' ? 'Processing charge / unit' : 'Agreed price / unit'}>{o.unit_cost !== null ? formatCurrency(Number(o.unit_cost)) : 'Not recorded'}</Stat>
            {o.bom_code && <Stat label="Materials from BOM">{o.bom_code} v{o.bom_version}</Stat>}
            {o.reference_number && <Stat label="Reference">{o.reference_number}</Stat>}
          </dl>
          <p className="text-xs text-muted-foreground">Supplier master integration is pending: the supplier is stored as a controlled name/reference on the order.</p>
          {(o.notes || o.review_note || o.hold_reason || o.cancel_reason || o.completion_note) && (
            <div className="space-y-1 text-sm">
              {o.notes && <p><span className="font-medium">Notes:</span> {o.notes}</p>}
              {o.review_note && <p><span className="font-medium">Review note:</span> {o.review_note}</p>}
              {o.status === 'ON_HOLD' && o.hold_reason && <p><span className="font-medium">On hold:</span> {o.hold_reason}</p>}
              {o.cancel_reason && <p><span className="font-medium">Cancelled:</span> {o.cancel_reason}</p>}
              {o.completion_note && <p><span className="font-medium">Completion note:</span> {o.completion_note}</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-t pt-4">
            {canEdit && <Button variant="outline" onClick={() => setDialog('edit')}><Pencil /> Edit draft</Button>}
            {can('SUBMIT') && canEdit && (has('outsourcing_order.approve')
              ? <Button disabled={releasing} onClick={() => void release()}>{releasing && <Loader2 className="animate-spin" />} Release order</Button>
              : <Button onClick={() => setAction(workflow('SUBMIT'))}>Submit for approval</Button>)}
            {can('WITHDRAW') && (o.submitted_by === user?.id || has('outsourcing_order.approve')) && <Button variant="outline" onClick={() => setAction(workflow('WITHDRAW'))}>Withdraw</Button>}
            {can('APPROVE') && has('outsourcing_order.approve') && (
              <>
                <Button onClick={() => setAction(workflow('APPROVE'))}>Approve</Button>
                <Button variant="outline" onClick={() => setAction(workflow('REJECT'))}>Reject</Button>
              </>
            )}
            {can('DISPATCH') && materials.length > 0 && has('outsourcing_material.dispatch') && <Button onClick={() => setDialog('dispatch')}><Send /> Send material</Button>}
            {can('RETURN') && heldTotal && has('outsourcing_material.dispatch') && <Button variant="outline" onClick={() => setDialog('return')}>Record material returned</Button>}
            {can('RECEIVE') && has('outsourcing_receipt.create') && <Button onClick={() => setDialog('receive')}><PackagePlus /> Receive goods</Button>}
            {can('COMPLETE') && has('outsourcing_order.complete') && Number(o.received_quantity) > 0 && <Button variant="outline" onClick={() => setAction(workflow('COMPLETE'))}>Complete order</Button>}
            {can('HOLD') && has('outsourcing_order.approve') && <Button variant="outline" onClick={() => setAction(workflow('HOLD'))}>Put on hold</Button>}
            {can('RESUME') && has('outsourcing_order.approve') && <Button variant="outline" onClick={() => setAction(workflow('RESUME'))}>Resume</Button>}
            {can('CANCEL') && has('outsourcing_order.approve') && <Button variant="outline" className="text-shortage" onClick={() => setAction(workflow('CANCEL'))}>Cancel order</Button>}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <DataTable title="Company material" description="Material stays company-owned while at the supplier. Held = sent − returned − used by the supplier."
          columns={materialColumns} data={materials} getRowId={(m) => m.id} searchable={false}
          emptyState={{ icon: Send, title: 'No company material', description: 'This order does not send company material to the supplier.' }} />
        <DataTable title="Goods received" description="Only accepted quantities are added to usable stock (source: outsourced)."
          columns={receiptColumns} data={receipts} getRowId={(r) => r.id} searchable={false}
          emptyState={{ icon: PackagePlus, title: 'Nothing received yet', description: 'Partial receipts are supported.' }} />
        <DataTable title="Material movements" description="Dispatches and returns are transfers to/from the supplier location; use by the supplier is posted when goods are received."
          columns={movementColumns} data={movements} getRowId={(m) => m.id} searchable={false}
          emptyState={{ icon: Send, title: 'No material movements', description: 'Nothing has been sent to the supplier.' }} />
        <Card>
          <CardHeader><div><CardTitle>History</CardTitle><CardDescription>Every status change and posting on this order.</CardDescription></div><History className="size-4 text-muted-foreground" /></CardHeader>
          <CardContent><EventTimeline events={events} loading={false} /></CardContent>
        </Card>
      </div>

      <ActionDialog request={action} onClose={() => setAction(null)} onDone={(m) => { setAction(null); setMessage(m); reload() }} />
      {dialog === 'edit' && <OutsourcingOrderDialog order={o} materials={materials} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setMessage('Draft saved.'); reload() }} />}
      <MaterialMoveDialog order={o} materials={materials} mode="DISPATCH" open={dialog === 'dispatch'} onOpenChange={(v) => setDialog(v ? 'dispatch' : null)} onPosted={(m) => { setMessage(m); reload() }} />
      <MaterialMoveDialog order={o} materials={materials.filter((m) => Number(m.held_quantity) > 0)} mode="RETURN" open={dialog === 'return'} onOpenChange={(v) => setDialog(v ? 'return' : null)} onPosted={(m) => { setMessage(m); reload() }} />
      <OutsourcedReceiptDialog order={o} materials={materials} open={dialog === 'receive'} onOpenChange={(v) => setDialog(v ? 'receive' : null)} onPosted={(m) => { setMessage(m); reload() }} />
    </>
  )
}
