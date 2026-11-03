import { ShoppingCart } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SalesOrderStatusBadge } from '@/features/sales/sales-badges'
import type { useSoSelection } from '@/features/sales/use-so-selection'
import { formatDate } from '@/lib/format'

/** Header strip: sales order selector + summary of the chosen order. */
export function OrderContextBar({ selection, children, emptyHint }: { selection: ReturnType<typeof useSoSelection>; children?: ReactNode; emptyHint?: string }) {
  const so = selection.selected
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <Select value={selection.soId} onValueChange={selection.select}>
          <SelectTrigger aria-label="Sales order" className="w-[26rem] max-w-full"><SelectValue placeholder={selection.loading ? 'Loading orders…' : 'Select a sales order'} /></SelectTrigger>
          <SelectContent className="max-h-80">
            {selection.options.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">{emptyHint ?? 'No sales orders yet.'}</div>}
            {selection.options.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.sales_order_number} · {o.customer_name_snapshot}{o.customer_po_number ? ` · PO ${o.customer_po_number}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {so && (
          <>
            <SalesOrderStatusBadge status={so.order_status} />
            <span className="text-sm text-muted-foreground">
              Ordered {formatDate(so.order_date)}{so.requested_delivery_date ? ` · deliver by ${formatDate(so.requested_delivery_date)}` : ''}
              {so.warehouse_code ? ` · from ${so.warehouse_code}` : ''}
            </span>
            <Link className="text-sm text-primary underline-offset-2 hover:underline" to={`/sales/orders/${so.id}`}>Order details</Link>
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">{children}</div>
      </CardContent>
    </Card>
  )
}

export function NoOrderSelected({ description }: { description?: string }) {
  return (
    <Card>
      <EmptyState icon={ShoppingCart} title="Select a sales order" description={description ?? 'Choose an order above.'} />
    </Card>
  )
}
