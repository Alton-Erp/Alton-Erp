import { AlertTriangle, Ban, Loader2 } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import { FulfilmentStatusBadge } from '@/features/sales/sales-badges'
import { NoOrderSelected, OrderContextBar } from '@/features/sales/so-picker'
import { useSoSelection } from '@/features/sales/use-so-selection'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { cancelOrder, fetchCancelPreview } from '@/services/sales'
import type { SalesOrderStatus } from '@/types/database-sales'

const CANCELLABLE: SalesOrderStatus[] = ['PENDING_CONFIRMATION', 'CONFIRMED', 'PARTIALLY_ALLOCATED', 'READY_FOR_FULFILMENT', 'IN_FULFILMENT', 'PARTIALLY_FULFILLED', 'ON_HOLD']

export default function CancellationPage() {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const selection = useSoSelection(CANCELLABLE, refresh)
  const so = selection.selected
  const preview = useAsync(() => (so ? fetchCancelPreview(so.id) : Promise.resolve(null)), [so?.id, refresh])
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const p = preview.data
  const canCancel = Boolean(p?.can_cancel && has('sales_orders.cancel'))

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <OrderContextBar selection={selection} emptyHint="No orders that can still be cancelled." />
      {!so ? <NoOrderSelected description="Choose an open order to see what cancelling it would affect." /> : preview.loading && !p ? <p className="text-sm text-muted-foreground">Checking the order…</p> : p && (
        <div className="space-y-6">
          {preview.error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{describeDataError(preview.error)}</p>}
          <Card>
            <CardHeader><div><CardTitle>What cancelling {p.sales_order_number} does</CardTitle>
              <CardDescription>Cancelling stops all further picking and dispatch. Only this order's own reservations are released. Dispatched goods and their stock postings are kept.</CardDescription></div></CardHeader>
            <CardContent className="space-y-4 text-sm">
              {p.has_dispatches && (
                <p className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"><AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  Part of this order has been dispatched. Only the remaining quantity is cancelled; dispatched quantities stay on the order and in the ledger.</p>
              )}
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Line</th><th className="pb-1 text-right">Ordered</th><th className="pb-1 text-right">Dispatched</th><th className="pb-1 text-right">Delivered</th><th className="pb-1 text-right">Reserved (on pick lists)</th><th className="pb-1 text-right">Will be cancelled</th></tr></thead>
                <tbody>{p.lines.map((l) => (
                  <tr key={l.line_no} className="border-t"><td className="py-1.5">{l.line_no} · {l.sku}</td><td className="py-1.5 text-right">{formatQty(Number(l.ordered) - Number(l.cancelled), l.unit)}</td><td className="py-1.5 text-right">{formatQty(l.dispatched)}</td>
                    <td className="py-1.5 text-right">{formatQty(l.delivered)}</td><td className="py-1.5 text-right">{formatQty(l.reserved)} ({formatQty(l.planned)})</td><td className="py-1.5 text-right font-medium">{formatQty(l.will_cancel)}</td></tr>
                ))}</tbody>
              </table>
              <div className="grid gap-4 lg:grid-cols-3">
                <div>
                  <p className="mb-1 font-medium">Pick lists / consignments</p>
                  {p.fulfilments.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul className="space-y-1">{p.fulfilments.map((f) => (
                    <li key={f.fulfilment_number} className="flex flex-wrap items-center gap-2">{f.fulfilment_number} <FulfilmentStatusBadge status={f.status} />
                      <span className="text-xs text-muted-foreground">{f.will_cancel ? `picked ${formatQty(f.picked)}, packed ${formatQty(f.packed)} — will be cancelled (no stock was issued)` : `dispatched ${formatQty(f.dispatched)} — kept`}</span></li>
                  ))}</ul>}
                </div>
                <div>
                  <p className="mb-1 font-medium">Reservations to release</p>
                  {p.reservations.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul className="space-y-1 text-xs">{p.reservations.map((r) => (
                    <li key={r.reservation_number}>{r.reservation_number}: line {r.line_no} {r.sku} · {formatQty(r.remaining)} at {r.warehouse_code}/{r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''}</li>
                  ))}</ul>}
                </div>
                <div>
                  <p className="mb-1 font-medium">Completed stock movements (kept)</p>
                  {p.movements.length === 0 ? <p className="text-muted-foreground">None.</p> : <ul className="space-y-1 text-xs">{p.movements.map((m) => (
                    <li key={m.transaction_number}>{m.transaction_number} · {m.transaction_type.toLowerCase()} {formatQty(m.quantity, m.unit)} · {formatDateTime(m.transaction_date)}</li>
                  ))}</ul>}
                </div>
              </div>
            </CardContent>
          </Card>
          {!p.can_cancel ? <p className="rounded-lg border bg-background px-4 py-2.5 text-sm">{p.blocked_reason}</p> : !has('sales_orders.cancel') ? (
            <p className="rounded-lg border bg-background px-4 py-2.5 text-sm">You can review this order, but cancelling needs the sales_orders.cancel permission.</p>
          ) : (
            <Card>
              <CardContent className="space-y-3 p-5">
                {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
                <div className="space-y-1"><Label htmlFor="cx-reason">Reason for cancellation (required)</Label><Textarea id="cx-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                <Button variant="destructive" disabled={busy || !canCancel} onClick={() => { if (reason.trim().length < 3) setError('Enter the reason for the cancellation.'); else { setError(null); setAsking(true) } }}>
                  {busy ? <Loader2 className="animate-spin" /> : <Ban />} Cancel {p.has_dispatches ? 'remaining quantity' : 'order'}
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      )}
      <ConfirmDialog open={asking} onOpenChange={setAsking} destructive title={`Cancel ${p?.sales_order_number ?? ''}?`} confirmLabel="Cancel order"
        description={`${p?.reservations.length ?? 0} reservation(s) will be released and ${p?.fulfilments.filter((f) => f.will_cancel).length ?? 0} open pick list(s) cancelled. This cannot be undone; the order and its history are kept.`}
        onConfirm={async () => {
          setAsking(false)
          if (!so) return
          setBusy(true); setError(null)
          try {
            const r = await cancelOrder(so.id, reason.trim(), key)
            renew(); setReason('')
            setMessage(`${p?.sales_order_number} cancelled: ${formatQty(r.released_quantity)} released, ${r.fulfilments_cancelled} pick list(s) cancelled${Number(r.dispatched_kept) > 0 ? `, ${formatQty(r.dispatched_kept)} already dispatched kept` : ''}.`)
            setRefresh((n) => n + 1)
          } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
        }} />
    </>
  )
}
