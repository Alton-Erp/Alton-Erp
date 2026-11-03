import { ArrowLeft, CheckCircle2, History, Loader2, Lock, PackageCheck, PackageMinus, Pencil, RefreshCw, RotateCcw, Undo2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ReservationStatusBadge, StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { MaterialStatusBadge, PostedBadge, PriorityBadge, ProductionStatusBadge, RequirementBadge } from '@/features/production/production-badges'
import { IssueMaterialsDialog, OrderFormDialog, OutputDialog } from '@/features/production/production-dialogs'
import { PRODUCTION_ACTION_FROM, QUALITY_STATUS_LABELS, canDo, ceilQty } from '@/features/production/production-model'
import { isFractionalForUnit, isWholeUnit } from '@/features/inventory/whole-units'
import { EventTimeline } from '@/features/production/event-timeline'
import { CompleteProductionDialog, RequirementsTable, WarningList } from '@/features/production/production-v2-components'
import { fetchOrderRequirementsV2, saveProductionOrderV2 } from '@/services/production-v2'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  fetchConsumption,
  fetchOrderRequirements,
  fetchOrderReservations,
  fetchOutputs,
  fetchProductionEvents,
  fetchProductionOrder,
  productionOrderAction,
  releaseOrderReservations,
  releaseProductionOrder,
  reserveMaterials,
  reverseConsumption,
  reverseOutput,
  type OrderAction,
  type OrderRequirementLine,
} from '@/services/production'
import type { ReservationRow } from '@/types/database-inventory'
import type { ConsumptionListRow, OutputListRow } from '@/types/database-production'

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  )
}

export default function ProductionOrderDetailPage() {
  const { orderId = '' } = useParams()
  const { user } = useAuth()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const reload = () => setRefresh((n) => n + 1)
  const order = useAsync(() => fetchProductionOrder(orderId), [orderId, refresh])
  const requirements = useAsync(() => fetchOrderRequirements(orderId), [orderId, refresh])
  const reservations = useAsync(() => fetchOrderReservations(orderId), [orderId, refresh])
  const consumption = useAsync(() => fetchConsumption({ orderId }), [orderId, refresh])
  const outputs = useAsync(() => fetchOutputs({ orderId }), [orderId, refresh])
  const events = useAsync(() => fetchProductionEvents(orderId), [orderId, refresh])
  const v2Lines = useAsync(() => fetchOrderRequirementsV2(orderId), [orderId, refresh])
  const location = useLocation()
  const initial = location.state as { message?: string; warnings?: string[] } | null
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [dialog, setDialog] = useState<'edit' | 'issue' | 'output' | 'complete' | 'correct' | null>(null)
  const [message, setMessage] = useState<string | null>(initial?.message ?? null)
  const [warnings, setWarnings] = useState<string[]>(initial?.warnings ?? [])
  const [recalculating, setRecalculating] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)

  const o = order.data
  const crumbs = [{ label: 'Production & Outsourcing' }, { label: 'Production Orders', to: '/production/orders' }, { label: o?.production_order_number ?? '…' }]
  if (order.loading && !o) return (<><PageHeader title="Production order" breadcrumbs={crumbs} /><LoadingState variant="cards" rows={4} /></>)
  if (order.error || !o) return (<><PageHeader title="Production order" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(order.error)} onRetry={order.reload} /></Card></>)

  const lines = requirements.data ?? []
  const openReservations = (reservations.data ?? []).filter((r) => r.reservation_status === 'ACTIVE' || r.reservation_status === 'PARTIALLY_FULFILLED')
  const can = (a: string) => canDo(PRODUCTION_ACTION_FROM, a, o.status)
  const done = (m: string) => { setAction(null); setReleaseError(null); setMessage(m); reload() }
  // V2 single-operator: submit + approve in one click, no confirmation step.
  const release = async () => {
    setReleasing(true)
    setReleaseError(null)
    try {
      await releaseProductionOrder(o.id, null)
      done(`${o.production_order_number} is released. You can reserve materials and start production.`)
    } catch (e) {
      setReleaseError(describeDataError(e))
    } finally {
      setReleasing(false)
    }
  }

  const workflow = (kind: OrderAction): ActionRequest => {
    const base = { run: async (note: string | null, key: string) => {
      const r = await productionOrderAction(o.id, kind, note, key)
      return `${o.production_order_number} is now ${r.status.replace(/_/g, ' ').toLowerCase()}.${r.released_reservation_quantity > 0 ? ` Released ${formatQty(r.released_reservation_quantity)} reserved.` : ''}`
    } }
    switch (kind) {
      case 'SUBMIT': return { ...base, title: 'Submit for approval', description: 'The order cannot be edited while awaiting approval.', confirmLabel: 'Submit', note: 'none' }
      case 'WITHDRAW': return { ...base, title: 'Withdraw from approval', description: 'The order returns to draft.', confirmLabel: 'Withdraw', note: 'none' }
      case 'APPROVE': return { ...base, title: `Approve ${o.production_order_number}`, description: 'Approval allows materials to be reserved and production to start. It does not move stock.', confirmLabel: 'Approve', note: 'optional' }
      case 'REJECT': return { ...base, title: 'Reject order', description: 'The order returns to draft with your reason.', confirmLabel: 'Reject', note: 'required', destructive: true }
      case 'START': return { ...base, title: 'Start production', description: 'Records the actual start date. Starting does not deduct materials; issue them separately.', confirmLabel: 'Start production', note: 'none' }
      case 'HOLD': return { ...base, title: 'Put on hold', description: 'Reservations are kept. Resume returns the order to its previous status.', confirmLabel: 'Put on hold', note: 'required' }
      case 'RESUME': return { ...base, title: 'Resume order', description: `Returns to ${o.status_before_hold?.replace(/_/g, ' ').toLowerCase()}.`, confirmLabel: 'Resume', note: 'none' }
      case 'CANCEL': return { ...base, title: `Cancel ${o.production_order_number}`, description: 'Open reservations are released. Orders with posted issues or output cannot be cancelled until those are reversed.', confirmLabel: 'Cancel order', note: 'required', destructive: true }
      case 'COMPLETE': {
        const disc: string[] = []
        if (Number(o.actual_quantity) < Number(o.planned_quantity)) disc.push(`Output ${formatQty(o.actual_quantity, o.unit)} is below the planned ${formatQty(o.planned_quantity, o.unit)}.`)
        for (const l of lines) {
          // Same rule as the server: whole pieces rounded up for items counted in pieces.
          const exact = Number(l.quantity_per_unit) * Number(o.actual_quantity)
          const expected = isWholeUnit(l.unit) ? Math.ceil(Math.round(exact * 1e4) / 1e4) : ceilQty(exact)
          if (Number(l.issued_quantity) < expected) disc.push(`${l.sku}: issued ${formatQty(l.issued_quantity, l.unit)}, standard for the output is ${formatQty(expected, l.unit)}.`)
        }
        return {
          ...base,
          title: `Complete ${o.production_order_number}`,
          description: (
            <>
              <p>Remaining reservations are released. Completion is final; posted issues and output can no longer be reversed.</p>
              {disc.length > 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-900">
                  <p className="font-medium">Unresolved discrepancies — completing requires the production exception permission and a documented reason:</p>
                  <ul className="mt-1 list-disc pl-5">{disc.map((d) => <li key={d}>{d}</li>)}</ul>
                </div>
              ) : <p className="text-green-700">Output and material issues are consistent with the plan.</p>}
            </>
          ),
          confirmLabel: 'Complete order',
          note: disc.length ? 'required' : 'optional',
          noteLabel: disc.length ? 'Reason for completing with discrepancies' : undefined,
          minLength: disc.length ? 5 : undefined,
        }
      }
    }
  }

  const reserve = (partial: boolean): ActionRequest => ({
    title: partial ? 'Reserve available materials' : 'Reserve materials',
    description: partial
      ? 'Reserves whatever usable stock is available in the source warehouse for the outstanding requirement (earliest expiry first) and reports the shortfall.'
      : 'Reserves the full outstanding requirement from usable stock in the source warehouse (earliest expiry first). If any material is short, nothing is reserved.',
    confirmLabel: partial ? 'Reserve available' : 'Reserve all',
    note: 'none',
    run: async (_n, key) => {
      const r = await reserveMaterials(o.id, partial, key)
      const shortText = r.shortages.length ? ` Short: ${r.shortages.map((s) => `${s.sku} ${formatQty(s.short, s.unit)}`).join(', ')}.` : ''
      return `Reserved ${r.reservations.length} lot(s).${shortText}`
    },
  })

  const reversal = (kind: 'issue' | 'output', id: string, label: string): ActionRequest => ({
    title: `Reverse ${label}`,
    description: kind === 'issue'
      ? 'Posts a reversal that returns the material to the same lot and location. The original record is kept and marked reversed. Re-issue the correct material afterwards if needed.'
      : 'Posts a reversal that removes the received goods from stock (they must still be there). The original receipt is kept and marked reversed.',
    confirmLabel: 'Post reversal',
    note: 'required',
    destructive: true,
    run: async (note, key) => {
      const r = kind === 'issue' ? await reverseConsumption(id, note!, key) : await reverseOutput(id, note!, key)
      return `Reversed: ${r.reversal_numbers.join(', ')}.`
    },
  })

  const canEdit = o.status === 'DRAFT' && (has('production_order.update') || (has('production_order.create') && o.created_by === user?.id))
  const mayReverse = has('production_exception.approve') && o.status !== 'COMPLETED' && o.status !== 'CANCELLED'
  // V2 simple flow
  const posted = (consumption.data ?? []).some((c) => c.status === 'POSTED') || (outputs.data ?? []).some((r) => r.status === 'POSTED')
  const openStatus = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'IN_PROGRESS'].includes(o.status)
  const canEditV2 = openStatus && !posted && (has('production_order.update') || (has('production_order.create') && o.created_by === user?.id))
  const canComplete = !['COMPLETED', 'CANCELLED', 'ON_HOLD'].includes(o.status) && has('production_order.complete') && has('production_material.issue') && has('production_output.receive')
  const canCorrect = (o.status === 'COMPLETED' || posted) && o.status !== 'CANCELLED' && has('production_exception.approve')
  const doneV2 = (m: string, w: string[]) => { setDialog(null); setMessage(m); setWarnings(w); reload() }
  const recalculate = async () => {
    setRecalculating(true)
    setReleaseError(null)
    try {
      const r = await saveProductionOrderV2(o.id, {}, null)
      doneV2(`${o.production_order_number} recalculated from ${r.bom_code} v${r.bom_version}; reservations renewed.`, r.warnings)
    } catch (e) {
      setReleaseError(describeDataError(e))
    } finally {
      setRecalculating(false)
    }
  }
  const completionOrder = {
    id: o.id, production_order_number: o.production_order_number, unit: o.unit, planned_quantity: o.planned_quantity, completed_quantity: o.completed_quantity,
    rejected_quantity: o.rejected_quantity, scrap_quantity: o.scrap_quantity, sku: o.sku, planned_start_date: o.planned_start_date, notes: o.notes,
  }

  const materialColumns: DataTableColumn<OrderRequirementLine>[] = [
    { id: 'sku', header: 'Material', cell: (l) => <span><span className="font-medium">{l.sku}</span><span className="block text-xs text-muted-foreground">{l.product_name}</span></span> },
    { id: 'per', header: 'BOM ratio per unit', align: 'right', cell: (l) => <span className="text-muted-foreground">{formatQty(l.quantity_per_unit)} (+{Number(l.wastage_percentage)}%)</span> },
    { id: 'theoretical', header: 'Theoretical', align: 'right', cell: (l) => <span className="text-muted-foreground">{formatQty(l.base_quantity)}</span> },
    {
      id: 'planned',
      header: 'Planned',
      align: 'right',
      cell: (l) => isFractionalForUnit(l.planned_quantity, l.unit)
        ? <span className="font-medium text-shortage" title="Planned before whole-piece rules: cancel and re-create the order">{formatQty(l.planned_quantity, l.unit)} · not whole</span>
        : formatQty(l.planned_quantity, l.unit),
    },
    { id: 'issued', header: 'Issued', align: 'right', cell: (l) => formatQty(l.issued_quantity) },
    { id: 'outstanding', header: 'Outstanding', align: 'right', cell: (l) => formatQty(l.outstanding_quantity) },
    { id: 'reserved', header: 'Reserved for order', align: 'right', cell: (l) => formatQty(l.reserved_for_order) },
    { id: 'available', header: `Available in ${o.source_warehouse_code}`, align: 'right', cell: (l) => formatQty(l.available_in_source) },
    { id: 'shortage', header: 'Shortage', align: 'right', cell: (l) => (l.shortage === null ? '—' : <span className={Number(l.shortage) > 0 ? 'font-medium text-shortage' : undefined}>{formatQty(l.shortage)}</span>) },
    { id: 'status', header: 'Status', cell: (l) => <RequirementBadge status={l.line_status} /> },
  ]
  const reservationColumns: DataTableColumn<ReservationRow>[] = [
    { id: 'no', header: 'Reservation', cell: (r) => r.reservation_number },
    { id: 'qty', header: 'Reserved', align: 'right', cell: (r) => formatQty(r.quantity) },
    { id: 'ful', header: 'Issued', align: 'right', cell: (r) => formatQty(r.fulfilled_quantity) },
    { id: 'rel', header: 'Released', align: 'right', cell: (r) => formatQty(r.released_quantity) },
    { id: 'at', header: 'Reserved at', cell: (r) => formatDateTime(r.reserved_at) },
    { id: 'status', header: 'Status', cell: (r) => <ReservationStatusBadge status={r.reservation_status} /> },
  ]
  const consumptionColumns: DataTableColumn<ConsumptionListRow>[] = [
    { id: 'date', header: 'Date', cell: (c) => formatDate(c.consumption_date) },
    { id: 'tx', header: 'Transaction', cell: (c) => c.transaction_number ?? '—' },
    { id: 'sku', header: 'Material', cell: (c) => c.sku, searchValue: (c) => `${c.sku} ${c.batch_number ?? ''}` },
    { id: 'lot', header: 'Lot / location', cell: (c) => <span className="text-xs">{c.batch_number ? `${c.batch_number} · ` : ''}{c.warehouse_code} / {c.location_code} {c.source_type && <StockSourceBadge source={c.source_type} className="ml-1" />}</span> },
    { id: 'qty', header: 'Quantity', align: 'right', cell: (c) => formatQty(c.actual_quantity, c.unit) },
    { id: 'reason', header: 'Over-issue reason', cell: (c) => c.over_issue_reason ?? '' },
    { id: 'status', header: 'Status', cell: (c) => <PostedBadge status={c.status} /> },
    { id: 'act', header: '', cell: (c) => mayReverse && c.status === 'POSTED' ? (
      <Button variant="ghost" size="sm" onClick={() => setAction(reversal('issue', c.id, `issue ${c.transaction_number ?? ''}`))}><Undo2 /> Reverse</Button>
    ) : null },
  ]
  const outputColumns: DataTableColumn<OutputListRow>[] = [
    { id: 'no', header: 'Receipt', cell: (r) => r.receipt_number },
    { id: 'date', header: 'Date', cell: (r) => formatDate(r.production_date) },
    { id: 'batch', header: 'Batch', cell: (r) => r.batch_number ?? (r.batch_id ? 'System lot' : '—') },
    { id: 'good', header: 'Good', align: 'right', cell: (r) => formatQty(r.good_quantity, r.unit) },
    { id: 'rej', header: 'Rejected', align: 'right', cell: (r) => `${formatQty(r.rejected_quantity)}${Number(r.rejected_quantity) > 0 ? (r.rejected_location_code ? ` (${r.rejected_location_code})` : ' (not stocked)') : ''}` },
    { id: 'scrap', header: 'Scrap', align: 'right', cell: (r) => formatQty(r.scrap_quantity) },
    { id: 'quality', header: 'Quality', cell: (r) => QUALITY_STATUS_LABELS[r.quality_status] },
    { id: 'status', header: 'Status', cell: (r) => <PostedBadge status={r.status} /> },
    { id: 'act', header: '', cell: (r) => mayReverse && r.status === 'POSTED' ? (
      <Button variant="ghost" size="sm" onClick={() => setAction(reversal('output', r.id, `receipt ${r.receipt_number}`))}><Undo2 /> Reverse</Button>
    ) : null },
  ]

  return (
    <>
      <PageHeader
        title={o.production_order_number}
        description={`${o.sku} — ${o.product_name} · ${o.bom_code} v${o.bom_version}`}
        breadcrumbs={crumbs}
        actions={<Button variant="outline" asChild><Link to="/production/orders"><ArrowLeft /> All orders</Link></Button>}
      />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <WarningList warnings={warnings} showPurchase />
      {releaseError && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{releaseError}</p>}

      <Card className="mb-6">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <ProductionStatusBadge status={o.status} />
            <PriorityBadge priority={o.priority} />
            <MaterialStatusBadge status={o.material_status} />
            {o.is_overdue && <span className="text-xs font-medium text-shortage">Past target date</span>}
          </div>
          <dl className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Planned">{formatQty(o.planned_quantity, o.unit)}</Stat>
            <Stat label="Good (in stock)">{formatQty(o.completed_quantity, o.unit)}</Stat>
            <Stat label="Rejected / scrap">{formatQty(o.rejected_quantity)} / {formatQty(o.scrap_quantity)}</Stat>
            <Stat label="Materials from → goods to">{o.source_warehouse_code} → {o.destination_warehouse_code}</Stat>
            <Stat label="Planned start / target">{formatDate(o.planned_start_date)} / {formatDate(o.target_completion_date)}</Stat>
            <Stat label="Actual start / completion">{o.actual_start_date ? formatDate(o.actual_start_date) : '—'} / {o.actual_completion_date ? formatDate(o.actual_completion_date) : '—'}</Stat>
          </dl>
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
            {canComplete && <Button onClick={() => setDialog('complete')}><CheckCircle2 /> Complete production</Button>}
            {canEditV2 && <Button variant="outline" asChild><Link to={`/production/orders/${o.id}/edit`}><Pencil /> Edit order</Link></Button>}
            {canEditV2 && <Button variant="outline" disabled={recalculating} onClick={() => void recalculate()}>{recalculating ? <Loader2 className="animate-spin" /> : <RefreshCw />} Recalculate materials</Button>}
            {canCorrect && <Button variant="outline" onClick={() => setDialog('correct')}><RotateCcw /> Correct production</Button>}
            {can('CANCEL') && has('production_order.cancel') && <Button variant="outline" className="text-shortage" onClick={() => setAction(workflow('CANCEL'))}>Cancel order</Button>}
          </div>
          <div className="rounded-lg border px-3 py-2 text-sm">
            <p className="font-medium text-muted-foreground">Step-by-step tools (optional): reserve, issue materials lot by lot, record partial output, hold</p>
          <div className="flex flex-wrap gap-2 pt-3">
            {canEdit && <Button variant="outline" onClick={() => setDialog('edit')}><Pencil /> Edit draft</Button>}
            {can('SUBMIT') && (canEdit || has('production_order.update')) && (has('production_order.approve')
              ? <Button disabled={releasing} onClick={() => void release()}>{releasing && <Loader2 className="animate-spin" />} Release order</Button>
              : <Button onClick={() => setAction(workflow('SUBMIT'))}>Submit for approval</Button>)}
            {can('WITHDRAW') && (has('production_order.update') || o.submitted_by === user?.id) && <Button variant="outline" onClick={() => setAction(workflow('WITHDRAW'))}>Withdraw</Button>}
            {can('APPROVE') && has('production_order.approve') && (
              <>
                <Button onClick={() => setAction(workflow('APPROVE'))}>Approve</Button>
                <Button variant="outline" onClick={() => setAction(workflow('REJECT'))}>Reject</Button>
              </>
            )}
            {can('RESERVE') && has('production_material.reserve') && (
              <>
                <Button variant="outline" onClick={() => setAction(reserve(false))}><Lock /> Reserve materials</Button>
                <Button variant="outline" onClick={() => setAction(reserve(true))}>Reserve available</Button>
              </>
            )}
            {openReservations.length > 0 && has('production_material.reserve') && o.status !== 'COMPLETED' && o.status !== 'CANCELLED' && (
              <Button variant="outline" onClick={() => setAction({
                title: 'Release reservations', description: 'Releases all open reservations of this order back to available stock.', confirmLabel: 'Release', note: 'optional',
                run: async (note) => { const r = await releaseOrderReservations(o.id, note); return `Released ${formatQty(r.released_quantity)}.` },
              })}>Release reservations</Button>
            )}
            {can('START') && has('production_order.update') && <Button onClick={() => setAction(workflow('START'))}>Start production</Button>}
            {can('ISSUE') && has('production_material.issue') && <Button onClick={() => setDialog('issue')}><PackageMinus /> Issue materials</Button>}
            {can('OUTPUT') && has('production_output.receive') && <Button onClick={() => setDialog('output')}><PackageCheck /> Record output</Button>}
            {can('COMPLETE') && has('production_order.complete') && <Button variant="outline" onClick={() => setAction(workflow('COMPLETE'))}>Complete order</Button>}
            {can('HOLD') && has('production_order.update') && <Button variant="outline" onClick={() => setAction(workflow('HOLD'))}>Put on hold</Button>}
            {can('RESUME') && has('production_order.update') && <Button variant="outline" onClick={() => setAction(workflow('RESUME'))}>Resume</Button>}
          </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Card className="overflow-hidden">
          <CardHeader><div><CardTitle>Material requirement</CardTitle><CardDescription>From {o.bom_code} v{o.bom_version} for {formatQty(o.planned_quantity, o.unit)}, including BOM wastage. Reserved = held for this order; available = free stock in {o.source_warehouse_code}.</CardDescription></div></CardHeader>
          {v2Lines.error ? <CardContent><ErrorState message={describeDataError(v2Lines.error)} onRetry={v2Lines.reload} /></CardContent>
            : <RequirementsTable lines={v2Lines.data ?? []} showIssued emptyText={v2Lines.loading ? 'Loading…' : 'This order has no material plan.'} />}
        </Card>
        <DataTable title="Material plan detail" description="Plan from the BOM version on this order (base requirement plus wastage). Issued quantities are net of reversals."
          columns={materialColumns} data={lines} getRowId={(l) => l.order_material_id} loading={requirements.loading}
          error={requirements.error ? new Error(describeDataError(requirements.error)) : null} onRetry={requirements.reload} searchable={false} pageSize={50}
          emptyState={{ icon: PackageMinus, title: 'No materials', description: 'This order has no material plan.' }} />
        <DataTable title="Reservations" description="Stock reserved for this order (existing reservation ledger). Issues consume them first."
          columns={reservationColumns} data={reservations.data ?? []} getRowId={(r) => r.id} loading={reservations.loading}
          error={reservations.error ? new Error(describeDataError(reservations.error)) : null} onRetry={reservations.reload} searchable={false}
          emptyState={{ icon: Lock, title: 'No reservations', description: 'Materials have not been reserved for this order.' }} />
        <DataTable title="Material issues" description="Each issue is a PRODUCTION_ISSUE ledger entry. Corrections are reversals; history is never overwritten."
          columns={consumptionColumns} data={consumption.data ?? []} getRowId={(c) => c.id} loading={consumption.loading}
          error={consumption.error ? new Error(describeDataError(consumption.error)) : null} onRetry={consumption.reload}
          emptyState={{ icon: PackageMinus, title: 'No materials issued', description: 'Raw materials are deducted only when issued here.' }} />
        <DataTable title="Output receipts" description="Good output is added to stock; rejected goods go to a non-saleable location or are recorded only; scrap is recorded only."
          columns={outputColumns} data={outputs.data ?? []} getRowId={(r) => r.id} loading={outputs.loading}
          error={outputs.error ? new Error(describeDataError(outputs.error)) : null} onRetry={outputs.reload} searchable={false}
          emptyState={{ icon: PackageCheck, title: 'No output recorded', description: 'Record finished goods as they are produced; partial receipts are supported.' }} />
        <Card>
          <CardHeader><div><CardTitle>History</CardTitle><CardDescription>Every status change and posting on this order.</CardDescription></div><History className="size-4 text-muted-foreground" /></CardHeader>
          <CardContent><EventTimeline events={events.data ?? []} loading={events.loading} /></CardContent>
        </Card>
      </div>

      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
      {dialog === 'edit' && <OrderFormDialog order={o} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); setMessage('Draft saved.'); reload() }} />}
      <IssueMaterialsDialog order={o} lines={lines.filter((l) => Number(l.outstanding_quantity) > 0 || l.line_status !== 'ISSUED')} open={dialog === 'issue'}
        onOpenChange={(open) => setDialog(open ? 'issue' : null)} onPosted={(m) => { setMessage(m); reload() }} />
      {(dialog === 'complete' || dialog === 'correct') && v2Lines.data && (
        <CompleteProductionDialog order={completionOrder} lines={v2Lines.data} mode={dialog} onClose={() => setDialog(null)} onDone={doneV2} />
      )}
      <OutputDialog order={o} open={dialog === 'output'} onOpenChange={(open) => setDialog(open ? 'output' : null)} onPosted={(m) => { setMessage(m); reload() }} />
    </>
  )
}
