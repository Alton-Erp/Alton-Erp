import { Loader2, RefreshCw, Truck } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  DISPATCH_STATUS_LABEL, INVOICE_DISPATCH_STATE_LABEL, invoiceDispatchState, ordersToDispatch,
  type DispatchLineStatus, type InvoiceDispatchState, type InvoiceDispatchStatus,
} from '@/features/billing/dispatch-status-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { cn } from '@/lib/utils'

const LINE_TONE: Record<DispatchLineStatus, string> = {
  NOT_APPLICABLE: 'border-slate-200 bg-slate-50 text-slate-700',
  AWAITING_DISPATCH: 'border-red-200 bg-red-50 text-red-800',
  PARTIALLY_DISPATCHED: 'border-amber-200 bg-amber-50 text-amber-900',
  FULLY_DISPATCHED: 'border-green-200 bg-green-50 text-green-800',
  DISPATCH_ON_POSTING: 'border-blue-200 bg-blue-50 text-blue-800',
}
const STATE_TONE: Record<InvoiceDispatchState, string> = {
  READY_TO_POST: LINE_TONE.FULLY_DISPATCHED,
  NO_STOCK_LINES: LINE_TONE.FULLY_DISPATCHED,
  PARTIALLY_DISPATCHED: LINE_TONE.PARTIALLY_DISPATCHED,
  AWAITING_DISPATCH: LINE_TONE.AWAITING_DISPATCH,
  DISPATCH_ON_POSTING: LINE_TONE.DISPATCH_ON_POSTING,
}

function Pill({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', tone)}>{children}</span>
}

/**
 * Dispatch status of each invoice line: an invoice with stock-tracked goods can be
 * posted only after posted dispatches cover every line (checked again on the server
 * when posting).
 */
export function InvoiceDispatchPanel({ status, loading, error, onRefresh }: {
  status: InvoiceDispatchStatus | null | undefined
  loading?: boolean
  error?: string | null
  onRefresh?: () => void
}) {
  const state = status ? invoiceDispatchState(status) : null
  const orders = ordersToDispatch(status)
  return (
    <Card data-testid="invoice-dispatch-panel">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2"><Truck className="size-4" /> Dispatch status {state && <Pill tone={STATE_TONE[state]}>{INVOICE_DISPATCH_STATE_LABEL[state]}</Pill>}</CardTitle>
          <CardDescription>Posting a sales-order invoice dispatches its stock items (taken from the order's reserved stock) in the same step, so stock is deducted once. Goods already dispatched are not dispatched again. Services, non-stock items and charges need no dispatch; manual lines of stock items cannot be posted.</CardDescription>
        </div>
        {onRefresh && <Button variant="outline" size="sm" disabled={loading} onClick={onRefresh}>{loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again</Button>}
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p role="alert" className="text-sm text-red-800">Dispatch status could not be loaded: {error}</p>}
        {!status && !error && <p className="text-sm text-muted-foreground">{loading ? 'Checking dispatches…' : 'Save the draft to check its dispatch status.'}</p>}
        {status && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2">#</th><th className="py-2 pr-2">Item</th><th className="py-2 pr-2 text-right">Invoiced</th>
                <th className="py-2 pr-2 text-right">Dispatched</th><th className="py-2 pr-6 text-right">Remaining</th><th className="py-2">Status</th>
              </tr></thead>
              <tbody>
                {status.lines.map((l) => (
                  <tr key={l.line_no} className="border-b last:border-0 align-top">
                    <td className="py-2 pr-2">{l.line_no}</td>
                    <td className="py-2 pr-2"><span className="font-medium">{l.sku ?? ''}</span> {l.product_name}
                      {l.sales_order_number && <span className="block text-xs text-muted-foreground">Order {l.sales_order_number}</span>}
                      {l.reason && l.applies && <span className="block text-xs text-red-800">{l.reason}</span>}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatQty(l.required)} {l.unit ?? ''}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{l.applies ? formatQty(l.dispatched ?? 0) : '—'}</td>
                    <td className="py-2 pr-6 text-right tabular-nums">{l.applies ? formatQty(l.remaining) : '—'}</td>
                    <td className="py-2"><Pill tone={LINE_TONE[l.status]}>{l.applies ? DISPATCH_STATUS_LABEL[l.status] : l.reason ?? DISPATCH_STATUS_LABEL.NOT_APPLICABLE}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {status && !status.ready && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span>Posting is disabled until the remaining quantities are dispatched.</span>
            {orders.map((o) => <Button key={o.id} size="sm" variant="outline" asChild><Link to={`/sales/orders/${o.id}`}><Truck /> Dispatch on {o.number}</Link></Button>)}
            {orders.length === 0 && <span>Lines not linked to a sales order cannot be covered by a dispatch: create the invoice from the sales order or its dispatch instead.</span>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
