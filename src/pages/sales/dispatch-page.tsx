import { Loader2, Truck } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { FulfilmentQueue } from '@/features/sales/fulfilment-queue'
import { FulfilmentStatusBadge } from '@/features/sales/sales-badges'
import { DISPATCH_FIELD_LABELS, TRANSPORT_MODE_LABELS } from '@/features/sales/sales-model'
import { useFulfilmentSelection } from '@/features/sales/use-fulfilment-selection'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { dispatchFulfilment, fetchFulfilment, fetchFulfilmentLines, fetchFulfilmentPolicy, fetchFulfilments, type DispatchDetails } from '@/services/sales'
import type { FulfilmentStatus } from '@/types/database-sales'

type Tab = 'READY' | 'DISPATCHED'
const TAB_STATUSES: Record<Tab, FulfilmentStatus[]> = { READY: ['READY_FOR_DISPATCH'], DISPATCHED: ['DISPATCHED', 'IN_TRANSIT', 'PARTIALLY_DELIVERED', 'DELIVERED', 'DELIVERY_EXCEPTION'] }

const localNow = () => { const d = new Date(); d.setSeconds(0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }

function Field({ id, label, required, children }: { id: string; label: string; required?: boolean; children: ReactNode }) {
  return <div className="space-y-1"><Label htmlFor={id}>{label}{required && <span className="text-shortage"> *</span>}</Label>{children}</div>
}

export default function DispatchPage() {
  const { has } = usePermissions()
  const { fulfilmentId, select } = useFulfilmentSelection()
  const [tab, setTab] = useState<Tab>('READY')
  const [refresh, setRefresh] = useState(0)
  const policy = useAsync(fetchFulfilmentPolicy, [])
  const required = new Set(policy.data?.dispatch_required_fields ?? [])
  const queue = useAsync(() => fetchFulfilments({ statuses: TAB_STATUSES[tab] }), [tab, refresh])
  const ful = useAsync(() => (fulfilmentId ? fetchFulfilment(fulfilmentId) : Promise.resolve(null)), [fulfilmentId, refresh])
  const lines = useAsync(() => (fulfilmentId ? fetchFulfilmentLines({ fulfilmentId }) : Promise.resolve([])), [fulfilmentId, refresh])
  const [opened] = useState(localNow)
  // The form draft belongs to one consignment; another consignment starts from its own defaults.
  const [draft, setDraft] = useState<{ id: string; d: DispatchDetails & { dispatched_local: string } } | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const f = ful.data
  const canDispatch = Boolean(f && f.fulfilment_status === 'READY_FOR_DISPATCH' && has('fulfilment.dispatch'))
  const d = draft && f && draft.id === f.id ? draft.d : { dispatched_local: opened, expected_delivery_date: f?.expected_delivery_date ?? '' }
  const setD = (next: typeof d) => { if (f) setDraft({ id: f.id, d: next }) }

  // Per order line: total ordered, previously dispatched, this consignment, remaining after.
  const totals = useMemo(() => {
    const map = new Map<string, { line: number; sku: string; unit: string; ordered: number; previous: number; now: number }>()
    for (const l of lines.data ?? []) {
      const t = map.get(l.sales_order_line_id) ?? { line: l.order_line_no, sku: l.sku, unit: l.unit, ordered: Number(l.quantity_ordered) - Number(l.quantity_cancelled), previous: Number(l.order_line_dispatched), now: 0 }
      t.now += f?.fulfilment_status === 'READY_FOR_DISPATCH' ? Number(l.quantity_packed) : Number(l.quantity_dispatched)
      map.set(l.sales_order_line_id, t)
    }
    return [...map.values()].sort((a, b) => a.line - b.line)
  }, [lines.data, f?.fulfilment_status])
  const set = (k: keyof DispatchDetails, v: string) => setD({ ...d, [k]: v })
  const missing = [...required].filter((k) => !String(d[k as keyof DispatchDetails] ?? '').trim())

  const post = async () => {
    if (!f) return
    setBusy(true); setError(null)
    try {
      const r = await dispatchFulfilment(f.id, {
        carrier_name: d.carrier_name?.trim() || null, transport_mode: d.transport_mode || null, vehicle_number: d.vehicle_number?.trim() || null, lr_number: d.lr_number?.trim() || null,
        tracking_number: d.tracking_number?.trim() || null, eway_bill_number: d.eway_bill_number?.trim() || null, delivery_reference: d.delivery_reference?.trim() || null,
        document_references: d.document_references?.trim() || null, notes: d.notes?.trim() || null,
        dispatched_at: d.dispatched_local ? new Date(d.dispatched_local).toISOString() : null, expected_delivery_date: d.expected_delivery_date || null,
      }, key)
      renew()
      setMessage(`${f.fulfilment_number} dispatched: ${formatQty(r.dispatched_quantity)} issued from stock (${r.transaction_numbers.join(', ')}). Order is ${r.order_status.replace(/_/g, ' ').toLowerCase()}.`)
      setRefresh((n) => n + 1)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <div className="mb-6">
        <FulfilmentQueue title="Consignments" rows={queue.data ?? []} loading={queue.loading} error={queue.error} onRetry={queue.reload} selectedId={fulfilmentId}
          onSelect={(id) => { setMessage(null); setError(null); select(id) }} extra={tab === 'READY' ? ['packed'] : ['dispatch']}
          toolbar={<FilterTabs<Tab> label="Dispatch stage" value={tab} onChange={setTab} options={[{ value: 'READY', label: 'Ready for dispatch' }, { value: 'DISPATCHED', label: 'Dispatched' }]} />}
          emptyTitle={tab === 'READY' ? 'Nothing ready for dispatch' : 'Nothing dispatched yet'} emptyDescription="Packed consignments marked ready for dispatch appear here." />
      </div>
      {f && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">{f.fulfilment_number} · {f.sales_order_number} <FulfilmentStatusBadge status={f.fulfilment_status} overdue={f.is_overdue} /></CardTitle>
              <CardDescription>{f.customer_name_snapshot} · from {f.warehouse_code}{f.shipping_address_snapshot ? ` · ship to: ${f.shipping_address_snapshot}` : ''}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">Order line</th><th className="pb-2 text-right">Total ordered</th><th className="pb-2 text-right">{canDispatch ? 'Previously dispatched' : 'Dispatched (all consignments)'}</th>
                  <th className="pb-2 text-right">{canDispatch ? 'Dispatching now' : 'In this consignment'}</th><th className="pb-2 text-right">Remaining to dispatch</th></tr></thead>
                <tbody>{totals.map((t) => (
                  <tr key={t.line} className="border-t">
                    <td className="py-2">{t.line} · {t.sku}</td>
                    <td className="py-2 text-right">{formatQty(t.ordered, t.unit)}</td>
                    <td className="py-2 text-right">{formatQty(t.previous)}</td>
                    <td className="py-2 text-right font-medium">{formatQty(t.now)}</td>
                    <td className="py-2 text-right">{formatQty(canDispatch ? t.ordered - t.previous - t.now : t.ordered - t.previous)}</td>
                  </tr>
                ))}</tbody>
              </table>
              {(lines.data ?? []).some((l) => Number(l.quantity_damaged) > 0) && <p className="mt-2 text-xs text-amber-800">Damaged / missing items recorded at packing are not dispatched; their reservation stays with the order.</p>}
            </div>
            {canDispatch ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Field id="dp-carrier" label={DISPATCH_FIELD_LABELS.carrier_name} required={required.has('carrier_name')}><Input id="dp-carrier" maxLength={120} value={d.carrier_name ?? ''} onChange={(e) => set('carrier_name', e.target.value)} /></Field>
                  <Field id="dp-mode" label={DISPATCH_FIELD_LABELS.transport_mode} required={required.has('transport_mode')}>
                    <Select value={d.transport_mode ?? ''} onValueChange={(v) => set('transport_mode', v)}><SelectTrigger id="dp-mode"><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>{Object.entries(TRANSPORT_MODE_LABELS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select></Field>
                  <Field id="dp-vehicle" label={DISPATCH_FIELD_LABELS.vehicle_number} required={required.has('vehicle_number')}><Input id="dp-vehicle" maxLength={20} value={d.vehicle_number ?? ''} onChange={(e) => set('vehicle_number', e.target.value)} /></Field>
                  <Field id="dp-lr" label={DISPATCH_FIELD_LABELS.lr_number} required={required.has('lr_number')}><Input id="dp-lr" maxLength={50} value={d.lr_number ?? ''} onChange={(e) => set('lr_number', e.target.value)} /></Field>
                  <Field id="dp-tracking" label={DISPATCH_FIELD_LABELS.tracking_number} required={required.has('tracking_number')}><Input id="dp-tracking" maxLength={100} value={d.tracking_number ?? ''} onChange={(e) => set('tracking_number', e.target.value)} /></Field>
                  <Field id="dp-eway" label={DISPATCH_FIELD_LABELS.eway_bill_number} required={required.has('eway_bill_number')}><Input id="dp-eway" maxLength={30} value={d.eway_bill_number ?? ''} onChange={(e) => set('eway_bill_number', e.target.value)} /></Field>
                  <Field id="dp-at" label="Dispatch date and time" required><Input id="dp-at" type="datetime-local" value={d.dispatched_local} onChange={(e) => setD({ ...d, dispatched_local: e.target.value })} /></Field>
                  <Field id="dp-exp" label="Expected delivery date"><Input id="dp-exp" type="date" min={(d.dispatched_local || opened).slice(0, 10)} value={d.expected_delivery_date ?? ''} onChange={(e) => set('expected_delivery_date', e.target.value)} /></Field>
                  <Field id="dp-ref" label="Delivery reference"><Input id="dp-ref" maxLength={100} value={d.delivery_reference ?? ''} onChange={(e) => set('delivery_reference', e.target.value)} /></Field>
                  <div className="sm:col-span-2 xl:col-span-3"><Field id="dp-docs" label="Supporting document references"><Input id="dp-docs" maxLength={500} placeholder="Delivery challan, packing list, invoice to follow…" value={d.document_references ?? ''} onChange={(e) => set('document_references', e.target.value)} /></Field></div>
                  <div className="sm:col-span-2 xl:col-span-4"><Field id="dp-notes" label="Dispatch notes"><Textarea id="dp-notes" rows={2} maxLength={1000} value={d.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></Field></div>
                </div>
                {required.size > 0 && <p className="text-xs text-muted-foreground">* Required by the company dispatch policy.</p>}
                <Button disabled={busy} onClick={() => { if (missing.length) setError(`Company dispatch policy requires: ${missing.map((m) => DISPATCH_FIELD_LABELS[m] ?? m).join(', ')}.`); else setAsking(true) }}>
                  {busy ? <Loader2 className="animate-spin" /> : <Truck />} Post dispatch
                </Button>
              </>
            ) : f.actual_dispatch_at ? (
              <dl className="grid gap-3 text-sm sm:grid-cols-3 xl:grid-cols-4">
                <div><dt className="text-xs text-muted-foreground">Dispatched</dt><dd className="font-medium">{formatDateTime(f.actual_dispatch_at)}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Carrier / mode</dt><dd className="font-medium">{f.carrier_name ?? '—'}{f.transport_mode ? ` · ${TRANSPORT_MODE_LABELS[f.transport_mode]}` : ''}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Vehicle / LR</dt><dd className="font-medium">{f.vehicle_number ?? '—'} / {f.lr_number ?? '—'}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Tracking / e-way bill</dt><dd className="font-medium">{f.tracking_number ?? '—'} / {f.eway_bill_number ?? '—'}</dd></div>
                <div className="sm:col-span-3 xl:col-span-4"><dt className="text-xs text-muted-foreground">Stock issues</dt><dd>{(lines.data ?? []).filter((l) => l.issue_transaction_number).map((l) => `${l.issue_transaction_number} (${l.sku} ${formatQty(l.quantity_dispatched)})`).join(', ') || '—'}</dd></div>
              </dl>
            ) : <p className="text-sm text-muted-foreground">This consignment is not ready for dispatch.</p>}
          </CardContent>
        </Card>
      )}
      <ConfirmDialog open={asking} onOpenChange={setAsking} title={`Post dispatch of ${f?.fulfilment_number ?? ''}?`} confirmLabel="Post dispatch"
        description={`The packed quantities (${totals.map((t) => `${t.sku} ${formatQty(t.now)}`).join(', ')}) will be issued from stock against this order's reservations. This is recorded in the stock ledger and cannot be undone by cancelling the order; returns are handled in Customer Returns.`}
        onConfirm={() => { setAsking(false); void post() }} />
    </>
  )
}
