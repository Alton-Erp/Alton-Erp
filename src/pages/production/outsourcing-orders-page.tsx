import { Plus, Truck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { formatQty } from '@/features/inventory/inventory-model'
import { MakeTypeBadge, OutsourcingStatusBadge } from '@/features/production/production-badges'
import { OUTSOURCING_TYPE_LABELS } from '@/features/production/production-model'
import { OutsourcingOrderDialog } from '@/features/production/outsourcing-dialogs'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchOutsourcingOrders } from '@/services/production'
import type { OutsourcingOrderListRow, OutsourcingStatus } from '@/types/database-production'

type Filter = 'OPEN' | OutsourcingStatus | 'ALL'

export default function OutsourcingOrdersPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('OPEN')
  const [creating, setCreating] = useState(false)
  const [today] = useState(() => toIsoDate(new Date()))
  const orders = useAsync(() => fetchOutsourcingOrders(filter === 'ALL' ? null : filter), [filter])
  const overdue = (o: OutsourcingOrderListRow) => !['COMPLETED', 'CANCELLED'].includes(o.status) && o.expected_return_date < today

  const columns: DataTableColumn<OutsourcingOrderListRow>[] = [
    { id: 'no', header: 'Order', cell: (o) => <span className="font-medium">{o.outsourcing_order_number}</span>, searchValue: (o) => o.outsourcing_order_number, sortValue: (o) => o.outsourcing_order_number },
    { id: 'type', header: 'Type', cell: (o) => <span className="inline-flex flex-col gap-1"><MakeTypeBadge kind="OUTSOURCED" /><span className="text-xs text-muted-foreground">{OUTSOURCING_TYPE_LABELS[o.order_type]}</span></span> },
    { id: 'supplier', header: 'Supplier', cell: (o) => <span>{o.supplier_name}{o.supplier_reference && <span className="block text-xs text-muted-foreground">{o.supplier_reference}</span>}</span>, searchValue: (o) => o.supplier_name, sortValue: (o) => o.supplier_name },
    { id: 'product', header: 'Product', cell: (o) => <span>{o.sku}<span className="block text-xs text-muted-foreground">{o.product_name}</span></span>, searchValue: (o) => `${o.sku} ${o.product_name}` },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (o) => formatQty(o.ordered_quantity, o.unit) },
    { id: 'recv', header: 'Accepted / rejected', align: 'right', cell: (o) => `${formatQty(o.accepted_quantity)} / ${formatQty(o.rejected_quantity)}` },
    { id: 'pending', header: 'Pending', align: 'right', cell: (o) => formatQty(o.pending_quantity) },
    { id: 'held', header: 'Material at supplier', cell: (o) => (o.material_lines === 0 ? '—' : o.material_lines_held > 0 ? <span className="text-violet-700">{o.material_lines_held} material(s) held</span> : 'None held') },
    { id: 'expected', header: 'Expected', cell: (o) => <span className={cn(overdue(o) && 'font-medium text-shortage')}>{formatDate(o.expected_return_date)}{overdue(o) && ' (overdue)'}</span>, sortValue: (o) => o.expected_return_date },
    { id: 'status', header: 'Status', cell: (o) => <OutsourcingStatusBadge status={o.status} />, sortValue: (o) => o.status },
  ]

  return (
    <>
      <PageHeader actions={<PermissionGate permission="outsourcing_order.create"><Button onClick={() => setCreating(true)}><Plus /> New outsourcing order</Button></PermissionGate>} />
      <DataTable
        columns={columns}
        data={orders.data ?? []}
        getRowId={(o) => o.id}
        loading={orders.loading}
        error={orders.error ? new Error(describeDataError(orders.error)) : null}
        onRetry={orders.reload}
        onRowClick={(o) => navigate(`/production/outsourcing/${o.id}`)}
        pageSize={20}
        searchPlaceholder="Search order, supplier or product…"
        toolbar={
          <FilterTabs<Filter>
            label="Status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'OPEN', label: 'Open' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'MATERIALS_DISPATCHED', label: 'Material sent' },
              { value: 'PARTIALLY_RECEIVED', label: 'Partially received' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'ALL', label: 'All' },
            ]}
          />
        }
        emptyState={{ icon: Truck, title: 'No outsourcing orders', description: 'Record goods bought from outside manufacturers or company material sent out for processing.' }}
      />
      {creating && <OutsourcingOrderDialog order={null} materials={[]} onClose={() => setCreating(false)} onSaved={(r) => navigate(`/production/outsourcing/${r.order_id}`)} />}
    </>
  )
}
