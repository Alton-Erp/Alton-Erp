import { ClipboardCheck, Plus, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { formatQty } from '@/features/inventory/inventory-model'
import { MaterialStatusBadge, PriorityBadge, ProductionStatusBadge } from '@/features/production/production-badges'
import { OrderFormDialog } from '@/features/production/production-dialogs'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchProductionOrders } from '@/services/production'
import type { ProductionOrderListRow } from '@/types/database-production'
import { useUrlEnum } from '@/hooks/use-url-state'

type Filter = 'OPEN' | 'PENDING_APPROVAL' | 'RUNNING' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED' | 'ALL'

export default function ProductionOrdersPage() {
  const navigate = useNavigate()
  // Kept in the address, so Back from a record returns to the same tab.
  const [filter, setFilter] = useUrlEnum<Filter>('status', ['OPEN', 'PENDING_APPROVAL', 'RUNNING', 'ON_HOLD', 'COMPLETED', 'CANCELLED', 'ALL'], 'OPEN')
  const [creating, setCreating] = useState(false)
  const orders = useAsync(
    () => fetchProductionOrders(filter === 'ALL' || filter === 'RUNNING' ? (filter === 'RUNNING' ? 'OPEN' : null) : filter),
    [filter],
  )
  const rows = (orders.data ?? []).filter((o) => filter !== 'RUNNING' || o.status === 'IN_PROGRESS' || o.status === 'PARTIALLY_COMPLETED')

  const columns: DataTableColumn<ProductionOrderListRow>[] = [
    { id: 'number', header: 'Order', cell: (o) => <span className="font-medium">{o.production_order_number}</span>, searchValue: (o) => o.production_order_number, sortValue: (o) => o.production_order_number },
    { id: 'product', header: 'Product', cell: (o) => <span>{o.sku} — {o.product_name}<span className="block text-xs text-muted-foreground">{o.bom_code} v{o.bom_version}</span></span>, searchValue: (o) => `${o.sku} ${o.product_name}`, sortValue: (o) => o.sku },
    { id: 'planned', header: 'Planned', align: 'right', cell: (o) => formatQty(o.planned_quantity, o.unit), sortValue: (o) => Number(o.planned_quantity) },
    { id: 'output', header: 'Good / rejected / scrap', align: 'right', cell: (o) => `${formatQty(o.completed_quantity)} / ${formatQty(o.rejected_quantity)} / ${formatQty(o.scrap_quantity)}` },
    { id: 'materials', header: 'Materials', cell: (o) => <MaterialStatusBadge status={o.material_status} /> },
    { id: 'wh', header: 'From → to', cell: (o) => <span className="text-xs">{o.source_warehouse_code} → {o.destination_warehouse_code}</span> },
    { id: 'start', header: 'Start', cell: (o) => formatDate(o.actual_start_date ?? o.planned_start_date), sortValue: (o) => o.planned_start_date },
    { id: 'target', header: 'Target', cell: (o) => <span className={cn(o.is_overdue && 'font-medium text-shortage')}>{formatDate(o.target_completion_date)}{o.is_overdue && ' (overdue)'}</span>, sortValue: (o) => o.target_completion_date },
    { id: 'priority', header: 'Priority', cell: (o) => <PriorityBadge priority={o.priority} />, sortValue: (o) => ['LOW', 'NORMAL', 'HIGH', 'URGENT'].indexOf(o.priority) },
    { id: 'status', header: 'Status', cell: (o) => <ProductionStatusBadge status={o.status} />, sortValue: (o) => o.status },
  ]

  return (
    <>
      <PageHeader
        actions={
          <PermissionGate permission="production_order.create">
            <Button variant="outline" asChild><Link to="/production/import"><Upload /> Import from Excel</Link></Button>
            <Button variant="outline" onClick={() => setCreating(true)}>Advanced order</Button>
            <Button asChild><Link to="/production/new"><Plus /> New production</Link></Button>
          </PermissionGate>
        }
      />
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(o) => o.id}
        loading={orders.loading}
        error={orders.error ? new Error(describeDataError(orders.error)) : null}
        onRetry={orders.reload}
        onRowClick={(o) => navigate(`/production/orders/${o.id}`)}
        pageSize={20}
        searchPlaceholder="Search order, SKU or product…"
        toolbar={
          <FilterTabs<Filter>
            label="Order status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'OPEN', label: 'Open' },
              { value: 'PENDING_APPROVAL', label: 'Pending approval' },
              { value: 'RUNNING', label: 'In production' },
              { value: 'ON_HOLD', label: 'On hold' },
              { value: 'COMPLETED', label: 'Completed' },
              { value: 'CANCELLED', label: 'Cancelled' },
              { value: 'ALL', label: 'All' },
            ]}
          />
        }
        emptyState={{
          icon: ClipboardCheck,
          title: 'No production orders',
          description: 'Create an order from an approved BOM (or from Production Planning). Orders move stock only when materials are issued and output is received.',
        }}
      />
      {creating && (
        <OrderFormDialog order={null} onClose={() => setCreating(false)} onSaved={(r) => navigate(`/production/orders/${r.order_id}`)} />
      )}
    </>
  )
}
