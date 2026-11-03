import { Loader2, MapPinned, Plus, Search } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { FilterTabs } from '@/components/common/filter-tabs'
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
import { FulfilmentQueue } from '@/features/sales/fulfilment-queue'
import { FulfilmentStatusBadge } from '@/features/sales/sales-badges'
import { DELIVERY_EVENT_LABELS, TRANSPORT_MODE_LABELS, parseQty } from '@/features/sales/sales-model'
import { useFulfilmentSelection } from '@/features/sales/use-fulfilment-selection'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import { fetchDeliveryEvents, fetchFulfilment, fetchFulfilmentLines, fetchFulfilments, recordDelivery } from '@/services/sales'
import type { DeliveryEventType, FulfilmentLineListRow, FulfilmentListRow, FulfilmentStatus } from '@/types/database-sales'

type Tab = 'TRANSIT' | 'OVERDUE' | 'EXCEPTION' | 'DELIVERED' | 'ALL'
const TAB_STATUSES: Record<Tab, FulfilmentStatus[]> = {
  TRANSIT: ['DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION'],
  OVERDUE: ['DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION'],
  EXCEPTION: ['DELIVERY_EXCEPTION'],
  DELIVERED: ['DELIVERED'],
  ALL: ['DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'DELIVERY_EXCEPTION'],
}
type ManualEvent = Exclude<DeliveryEventType, 'DISPATCHED'>
const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

function EventDialog({ ful, lines, onClose, onDone }: { ful: FulfilmentListRow; lines: FulfilmentLineListRow[]; onClose: () => void; onDone: (m: string) => void }) {
  const [type, setType] = useState<ManualEvent>('IN_TRANSIT')
  const [at, setAt] = useState(localNow())
  const [location, setLocation] = useState('')
  const [description, setDescription] = useState('')
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')
  const [qty, setQty] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const delivering = type === 'PARTIALLY_DELIVERED' || type === 'DELIVERED'
  const failing = type === 'DELIVERY_FAILED' || type === 'RETURNED_TO_SENDER' || type === 'EXCEPTION'

  const submit = async () => {
    let payload: { line_id: string; quantity: number }[] | null = null
    if (delivering) {
      const entries = lines.map((l) => ({ line: l, q: parseQty(qty[l.id] ?? '') }))
      if (entries.some((e) => e.q === null)) return setError('Enter delivered quantities as numbers.')
      const over = entries.find((e) => (e.q ?? 0) > Number(e.line.quantity_dispatched) - Number(e.line.quantity_delivered))
      if (over) return setError(`Line ${over.line.line_no}: at most ${formatQty(Number(over.line.quantity_dispatched) - Number(over.line.quantity_delivered))} is still undelivered.`)
      const chosen = entries.filter((e) => (e.q ?? 0) > 0).map((e) => ({ line_id: e.line.id, quantity: e.q as number }))
      if (type === 'PARTIALLY_DELIVERED' && chosen.length === 0) return setError('Enter the delivered quantity for at least one line.')
      payload = chosen.length ? chosen : null
    }
    if (failing && !reason.trim() && !description.trim()) return setError('Record the reason for the failure or exception.')
    setBusy(true); setError(null)
    try {
      const r = await recordDelivery(ful.id, { eventType: type, eventAt: at ? new Date(at).toISOString() : null, location: location.trim() || null, description: description.trim() || null,
        reference: reference.trim() || null, failureReason: reason.trim() || null, lines: payload }, key)
      renew()
      onDone(`${DELIVERY_EVENT_LABELS[type]} recorded for ${ful.fulfilment_number}; status ${r.status.replace(/_/g, ' ').toLowerCase()}.`)
    } catch (e) { setError(describeDataError(e)); setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Record delivery event · {ful.fulfilment_number}</DialogTitle>
          <DialogDescription>Manually recorded events are marked as unverified (no carrier integration is configured). Delivery events never change stock; goods coming back are handled in Customer Returns.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="ev-type">Event</Label>
            <Select value={type} onValueChange={(v) => setType(v as ManualEvent)}><SelectTrigger id="ev-type"><SelectValue /></SelectTrigger>
              <SelectContent>{Object.entries(DELIVERY_EVENT_LABELS).filter(([k]) => k !== 'DISPATCHED').map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="ev-at">Date and time</Label><Input id="ev-at" type="datetime-local" max={localNow()} value={at} onChange={(e) => setAt(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ev-loc">Location</Label><Input id="ev-loc" maxLength={200} value={location} onChange={(e) => setLocation(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ev-ref">Reference (POD, docket…)</Label><Input id="ev-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          {failing && <div className="space-y-1 sm:col-span-2"><Label htmlFor="ev-reason">Failure / exception reason (required)</Label><Input id="ev-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="ev-desc">Description</Label><Textarea id="ev-desc" rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        {delivering && (
          <div className="space-y-2">
            <p className="text-sm font-medium">Delivered in this event{type === 'DELIVERED' ? ' (leave empty to deliver everything still outstanding)' : ''}</p>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Line</th><th className="pb-1 text-right">Dispatched</th><th className="pb-1 text-right">Delivered so far</th><th className="pb-1 text-right">Delivered now</th></tr></thead>
              <tbody>{lines.filter((l) => Number(l.quantity_dispatched) > 0).map((l) => (
                <tr key={l.id} className="border-t"><td className="py-1.5">{l.line_no} · {l.sku}</td><td className="py-1.5 text-right">{formatQty(l.quantity_dispatched, l.unit)}</td><td className="py-1.5 text-right">{formatQty(l.quantity_delivered)}</td>
                  <td className="py-1.5 text-right"><Input aria-label={`Delivered quantity line ${l.line_no}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={qty[l.id] ?? ''} onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Record event</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function DeliveryPage() {
  const { has } = usePermissions()
  const { fulfilmentId, select } = useFulfilmentSelection()
  const [tab, setTab] = useState<Tab>('TRANSIT')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [refresh, setRefresh] = useState(0)
  const queue = useAsync(() => fetchFulfilments({ statuses: TAB_STATUSES[tab], search, overdueOnly: tab === 'OVERDUE' }), [tab, search, refresh])
  const ful = useAsync(() => (fulfilmentId ? fetchFulfilment(fulfilmentId) : Promise.resolve(null)), [fulfilmentId, refresh])
  const lines = useAsync(() => (fulfilmentId ? fetchFulfilmentLines({ fulfilmentId }) : Promise.resolve([])), [fulfilmentId, refresh])
  const events = useAsync(() => (fulfilmentId ? fetchDeliveryEvents(fulfilmentId) : Promise.resolve([])), [fulfilmentId, refresh])
  const names = useAsync(() => fetchDisplayNames((events.data ?? []).map((e) => e.recorded_by)), [events.data])
  const [recording, setRecording] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const f = ful.data
  const shipped = Boolean(f?.actual_dispatch_at)
  const canRecord = Boolean(f && ['DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERY_EXCEPTION'].includes(f.fulfilment_status) && has('fulfilment_delivery.update'))

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <div className="mb-6">
        <FulfilmentQueue title="Dispatched consignments" description="Expected vs actual delivery. Tracking is recorded manually; no real-time carrier tracking is connected."
          rows={queue.data ?? []} loading={queue.loading} error={queue.error} onRetry={queue.reload} selectedId={fulfilmentId}
          onSelect={(id) => { setMessage(null); select(id) }} extra={['delivery']}
          toolbar={
            <div className="flex flex-wrap items-center gap-3">
              <FilterTabs<Tab> label="Delivery view" value={tab} onChange={setTab} options={[
                { value: 'TRANSIT', label: 'Not delivered' }, { value: 'OVERDUE', label: 'Overdue' }, { value: 'EXCEPTION', label: 'Exceptions' },
                { value: 'DELIVERED', label: 'Delivered' }, { value: 'ALL', label: 'All' }]} />
              <div className="relative w-64"><Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input aria-label="Search tracking number" className="pl-9" placeholder="Tracking / LR / order / customer" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
            </div>
          }
          emptyTitle={tab === 'OVERDUE' ? 'No overdue deliveries' : 'No consignments'} emptyDescription="Consignments appear here once their dispatch has been posted." />
      </div>
      {f && shipped && (
        <div className="grid gap-6 xl:grid-cols-5">
          <Card className="xl:col-span-2">
            <CardHeader>
              <div>
                <CardTitle className="flex flex-wrap items-center gap-2">{f.fulfilment_number} <FulfilmentStatusBadge status={f.fulfilment_status} overdue={f.is_overdue} /></CardTitle>
                <CardDescription>{f.sales_order_number} · {f.customer_name_snapshot}</CardDescription>
              </div>
              {canRecord && <Button size="sm" onClick={() => setRecording(true)}><Plus /> Record event</Button>}
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">Dispatched</dt><dd className="font-medium">{formatDateTime(f.actual_dispatch_at!)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Carrier</dt><dd className="font-medium">{f.carrier_name ?? '—'}{f.transport_mode ? ` · ${TRANSPORT_MODE_LABELS[f.transport_mode]}` : ''}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Tracking / LR</dt><dd className="font-medium">{f.tracking_number ?? '—'} / {f.lr_number ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Vehicle / e-way bill</dt><dd className="font-medium">{f.vehicle_number ?? '—'} / {f.eway_bill_number ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Expected delivery</dt><dd className="font-medium">{f.expected_delivery_date ? formatDate(f.expected_delivery_date) : 'Not set'}{f.is_overdue && <span className="ml-1 text-shortage">(overdue)</span>}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Actual delivery</dt><dd className="font-medium">{f.delivered_at ? formatDateTime(f.delivered_at) : '—'}{f.delivery_days_late !== null && <span className={f.delivery_days_late > 0 ? 'ml-1 text-shortage' : 'ml-1 text-green-700'}>({f.delivery_days_late > 0 ? `${f.delivery_days_late} day(s) late` : 'on time'})</span>}</dd></div>
                {f.exception_reason && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Exception</dt><dd className="font-medium text-shortage">{f.exception_reason}</dd></div>}
              </dl>
              <table className="mt-4 w-full text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Line</th><th className="pb-1 text-right">Dispatched</th><th className="pb-1 text-right">Delivered</th></tr></thead>
                <tbody>{(lines.data ?? []).filter((l) => Number(l.quantity_dispatched) > 0).map((l) => (
                  <tr key={l.id} className="border-t"><td className="py-1.5">{l.sku}{l.batch_number ? ` · ${l.batch_number}` : ''}</td><td className="py-1.5 text-right">{formatQty(l.quantity_dispatched, l.unit)}</td><td className="py-1.5 text-right">{formatQty(l.quantity_delivered)}</td></tr>
                ))}</tbody>
              </table>
            </CardContent>
          </Card>
          <Card className="xl:col-span-3">
            <CardHeader><div><CardTitle className="flex items-center gap-2"><MapPinned className="size-4" /> Delivery history</CardTitle><CardDescription>Chronological; who recorded each event and when.</CardDescription></div></CardHeader>
            <CardContent>
              {(events.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No events yet.</p> : (
                <ol className="space-y-3 border-l pl-4">
                  {(events.data ?? []).map((e) => (
                    <li key={e.id} className="relative text-sm">
                      <span aria-hidden className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background bg-gray-400" />
                      <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{DELIVERY_EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                        <StatusBadge label={e.source === 'SYSTEM' ? 'Dispatch posting' : e.verified ? 'Verified carrier event' : 'Manual (unverified)'} tone={e.source === 'SYSTEM' ? 'info' : e.verified ? 'success' : 'neutral'} /></p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(e.event_at)}{e.location ? ` · ${e.location}` : ''}{e.reference_number ? ` · ${e.reference_number}` : ''} · recorded by {(e.recorded_by && names.data?.get(e.recorded_by)) || 'User'} at {formatDateTime(e.created_at)}</p>
                      {(e.failure_reason || e.description) && <p className="mt-0.5 text-xs">{e.failure_reason ? <span className="text-shortage">{e.failure_reason}. </span> : null}{e.description}</p>}
                      {Array.isArray(e.delivered_quantities) && e.delivered_quantities.length > 0 && (
                        <p className="mt-0.5 text-xs">Delivered: {(e.delivered_quantities as { line_no: number; quantity: number }[]).map((x) => `line ${x.line_no} ${formatQty(x.quantity)}`).join(', ')}</p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {recording && f && <EventDialog ful={f} lines={lines.data ?? []} onClose={() => setRecording(false)} onDone={(m) => { setRecording(false); setMessage(m); setRefresh((n) => n + 1) }} />}
    </>
  )
}
