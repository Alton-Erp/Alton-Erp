import { ShoppingCart } from 'lucide-react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { Button } from '@/components/ui/button'
import { SalesOrderStatusBadge } from '@/features/sales/sales-badges'
import { useAsync } from '@/hooks/use-async'
import { fetchOrdersForPo } from '@/services/sales'

const CONVERTIBLE = ['READY_FOR_ALLOCATION', 'PARTIALLY_ALLOCATED', 'FULLY_ALLOCATED', 'PARTIALLY_FULFILLED']

/**
 * On customer PO pages: the sales orders created from the PO. Once a PO has a
 * (non-cancelled) sales order, its stock is allocated, picked and dispatched
 * from the sales order; the database refuses PO allocation / dispatch.
 */
export function PoSalesOrdersNotice({ poId, poStatus, isCurrent, refreshKey = 0 }: { poId: string; poStatus: string; isCurrent: boolean; refreshKey?: number }) {
  const { has } = usePermissions()
  const orders = useAsync(() => (has('sales_orders.read') ? fetchOrdersForPo(poId) : Promise.resolve([])), [poId, refreshKey])
  const active = (orders.data ?? []).filter((o) => o.order_status !== 'CANCELLED')
  const canConvert = isCurrent && CONVERTIBLE.includes(poStatus) && has('sales_orders.create')
  if (active.length === 0 && !canConvert) return null
  return (
    <div className={active.length ? 'mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900' : 'mb-4 rounded-lg border bg-background px-4 py-3 text-sm'}>
      <div className="flex flex-wrap items-center gap-3">
        <ShoppingCart className="size-4 shrink-0" />
        {active.length ? (
          <span className="flex flex-wrap items-center gap-2">Fulfilled through sales order{active.length > 1 ? 's' : ''}
            {active.map((o) => <span key={o.id} className="inline-flex items-center gap-1"><Link className="font-medium underline" to={`/sales/order-details?so=${o.id}`}>{o.sales_order_number}</Link><SalesOrderStatusBadge status={o.order_status} /></span>)}
            — allocate, pick and dispatch from the sales order. The PO's matched lines can no longer be changed here.</span>
        ) : <span>This PO is matched and can be converted into a sales order for picking, packing and dispatch.</span>}
        {canConvert && <Button size="sm" variant="outline" className="ml-auto" asChild><Link to={`/sales/orders?convert=${poId}`}>{active.length ? 'Split remaining quantity' : 'Create sales order'}</Link></Button>}
      </div>
    </div>
  )
}
