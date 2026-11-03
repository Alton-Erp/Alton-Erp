import { AlertTriangle, FilePlus, Loader2, Truck } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PageHeader } from '@/components/common/page-header'
import { EmptyState } from '@/components/common/empty-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { parseQty } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { createInvoiceDraft, fetchBillingSettings, fetchInvoiceableDispatches } from '@/services/billing'
import type { InvoiceableDispatchRow } from '@/types/database-billing'

/**
 * Draft invoices are created only from actual dispatches (quantity dispatched,
 * or delivered when the billing basis is delivery) that are not on another
 * invoice. The server re-checks every quantity; nothing is reserved by viewing.
 */
export default function CreateInvoicePage() {
  const navigate = useNavigate()
  const settings = useAsync(fetchBillingSettings, [])
  const [customer, setCustomer] = useState('all')
  const rows = useAsync(() => fetchInvoiceableDispatches(customer === 'all' ? null : customer), [customer])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const s = settings.data
  const partial = Boolean(s?.allow_partial_dispatch_invoicing)
  const list = rows.data ?? []
  const chosen = list.filter((r) => r.fulfilment_line_id in selected)
  const chosenCustomer = chosen[0]?.customer_id ?? null

  const toggle = (r: InvoiceableDispatchRow, on: boolean) => setSelected((x) => {
    const next = { ...x }
    if (on) next[r.fulfilment_line_id] = String(Number(r.quantity_invoiceable))
    else delete next[r.fulfilment_line_id]
    return next
  })

  const create = async () => {
    setError(null)
    const lines = chosen.map((r) => ({ fulfilment_line_id: r.fulfilment_line_id, quantity: parseQty(selected[r.fulfilment_line_id] ?? '') }))
    const bad = lines.find((l, i) => l.quantity === null || !l.quantity || l.quantity > Number(chosen[i].quantity_invoiceable))
    if (bad) return setError('Enter quantities between 0 and the invoiceable quantity (up to 3 decimals).')
    setBusy(true)
    try {
      const r = await createInvoiceDraft(lines.map((l) => ({ fulfilment_line_id: l.fulfilment_line_id, quantity: l.quantity as number })), {}, key)
      renew()
      navigate(`/billing/invoices/${r.invoice_id}?created=1`)
    } catch (e) { setError(describeDataError(e)); setBusy(false) }
  }

  return (
    <>
      <PageHeader />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4 text-sm">
          <div className="space-y-1"><Label htmlFor="ci-customer">Customer</Label><CustomerSelect id="ci-customer" value={customer} onChange={(v) => { setCustomer(v); setSelected({}) }} allowAll /></div>
          <p className="max-w-3xl text-muted-foreground">
            Only quantities {s?.billing_basis === 'DELIVERY' ? 'confirmed as delivered' : 'actually dispatched'} and not yet on an invoice are listed. Reserved, picked or packed goods cannot be invoiced.
            {partial ? ' Partial invoicing of a dispatch is allowed by company policy.' : ' Company policy: each dispatch line is invoiced in full.'}
          </p>
        </CardContent>
      </Card>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card>
        <CardHeader>
          <div><CardTitle>Dispatches ready to invoice</CardTitle><CardDescription>Select lines of one customer. The draft takes prices from the sales order (or the Product Master), and HSN / GST rates from the Product Master.</CardDescription></div>
          <Button disabled={busy || chosen.length === 0} onClick={() => void create()}>{busy ? <Loader2 className="animate-spin" /> : <FilePlus />} Create draft invoice ({chosen.length})</Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {rows.loading ? <LoadingState variant="table" rows={4} /> : rows.error ? <p className="text-sm text-shortage">{describeDataError(rows.error)}</p> : list.length === 0 ? (
            <EmptyState icon={Truck} title="Nothing to invoice" description="Dispatched quantities appear here once goods have been dispatched from a sales order." action={<Button variant="outline" asChild><Link to="/sales/orders">Sales Orders</Link></Button>} />
          ) : (
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="text-xs text-muted-foreground"><tr>
                <th className="pb-2 text-left" />
                <th className="pb-2 text-left">Dispatch</th><th className="pb-2 text-left">Customer / order</th><th className="pb-2 text-left">Product</th>
                <th className="pb-2 text-right">Ordered</th><th className="pb-2 text-right">Order dispatched</th><th className="pb-2 text-right">This dispatch</th>
                <th className="pb-2 text-right">Returned</th><th className="pb-2 text-right">Invoiced</th><th className="pb-2 text-right">Invoiceable</th>
                <th className="pb-2 text-right">To invoice</th><th className="pb-2 text-left">Price / tax data</th>
              </tr></thead>
              <tbody>{list.map((r) => {
                const disabled = !r.customer_id || (chosenCustomer !== null && r.customer_id !== chosenCustomer)
                const on = r.fulfilment_line_id in selected
                const price = r.unit_price_snapshot ?? r.selling_price
                return (
                  <tr key={r.fulfilment_line_id} className={disabled ? 'border-t opacity-60' : 'border-t'}>
                    <td className="py-2"><Checkbox aria-label={`Select ${r.fulfilment_number} ${r.sku}`} checked={on} disabled={disabled} onCheckedChange={(v) => toggle(r, v === true)} /></td>
                    <td className="py-2">{r.fulfilment_number}<span className="block text-xs text-muted-foreground">{formatDate(r.actual_dispatch_at)}</span></td>
                    <td className="py-2">{r.customer_name_snapshot}<span className="block text-xs text-muted-foreground">{r.sales_order_number}{r.customer_po_number ? ` · PO ${r.customer_po_number}` : ''}</span>
                      {!r.customer_id && <span className="block text-xs text-shortage">No customer record — link the order to a customer to invoice it</span>}</td>
                    <td className="py-2">{r.sku}<span className="block text-xs text-muted-foreground">{r.product_name}</span></td>
                    <td className="py-2 text-right">{formatQty(r.quantity_ordered, r.unit)}</td>
                    <td className="py-2 text-right">{formatQty(r.order_line_dispatched)}</td>
                    <td className="py-2 text-right">{formatQty(r.quantity_dispatched)}</td>
                    <td className="py-2 text-right">{formatQty(r.quantity_returned)}</td>
                    <td className="py-2 text-right">{formatQty(r.quantity_invoiced)}</td>
                    <td className="py-2 text-right font-medium">{formatQty(r.quantity_invoiceable)}</td>
                    <td className="py-2 text-right">{on ? (partial
                      ? <Input aria-label={`Quantity to invoice ${r.sku}`} className="ml-auto h-8 w-24 text-right" inputMode="decimal" value={selected[r.fulfilment_line_id]} onChange={(e) => setSelected((x) => ({ ...x, [r.fulfilment_line_id]: e.target.value }))} />
                      : formatQty(r.quantity_invoiceable)) : '—'}</td>
                    <td className="py-2 text-xs">{price === null ? <span className="text-shortage">no price</span> : money(price)}
                      <span className="block text-muted-foreground">{r.hsn_code ?? <span className="text-shortage">no HSN</span>} · {r.gst_rate === null ? <span className="text-shortage">no GST rate</span> : `${Number(r.gst_rate)}%`}</span></td>
                  </tr>
                )
              })}</tbody>
            </table>
          )}
          {chosen.some((r) => r.hsn_code === null || r.gst_rate === null || (r.unit_price_snapshot ?? r.selling_price) === null) && (
            <p className="mt-3 flex items-center gap-2 text-sm text-amber-800"><AlertTriangle className="size-4" /> Some selected lines lack price or tax data. The draft can be created, but it cannot be issued until this is completed.</p>
          )}
        </CardContent>
      </Card>
    </>
  )
}
