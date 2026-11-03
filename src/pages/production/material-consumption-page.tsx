import { PackageMinus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { PostedBadge } from '@/features/production/production-badges'
import { IssueMaterialsDialog } from '@/features/production/production-dialogs'
import { RunningOrderSelect } from '@/features/production/running-order-select'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { fetchConsumption, fetchOrderRequirements, fetchRunningOrders } from '@/services/production'
import type { DateRangeValue } from '@/types'
import type { ConsumptionListRow } from '@/types/database-production'

export default function MaterialConsumptionPage() {
  const { has } = usePermissions()
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [refresh, setRefresh] = useState(0)
  const [orderId, setOrderId] = useState('')
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const rows = useAsync(() => fetchConsumption({ from: toIsoDate(range.from), to: toIsoDate(range.to) }), [range, refresh])
  const canIssue = has('production_material.issue')
  const running = useAsync(() => (canIssue ? fetchRunningOrders() : Promise.resolve([])), [canIssue, refresh])
  const order = running.data?.find((o) => o.id === orderId)
  const lines = useAsync(() => (orderId ? fetchOrderRequirements(orderId) : Promise.resolve([])), [orderId, refresh])

  const columns: DataTableColumn<ConsumptionListRow>[] = [
    { id: 'date', header: 'Date', cell: (c) => formatDate(c.consumption_date), sortValue: (c) => c.consumption_date },
    { id: 'order', header: 'Production order', cell: (c) => <Link className="font-medium text-primary hover:underline" to={`/production/orders/${c.production_order_id}`} onClick={(e) => e.stopPropagation()}>{c.production_order_number}</Link>, searchValue: (c) => c.production_order_number },
    { id: 'material', header: 'Material', cell: (c) => <span>{c.sku}<span className="block text-xs text-muted-foreground">{c.product_name}</span></span>, searchValue: (c) => `${c.sku} ${c.product_name}`, sortValue: (c) => c.sku },
    { id: 'lot', header: 'Lot / location', cell: (c) => <span className="text-xs">{c.batch_number ? `${c.batch_number} · ` : ''}{c.warehouse_code} / {c.location_code}</span>, searchValue: (c) => c.batch_number ?? '' },
    { id: 'source', header: 'Source', cell: (c) => (c.source_type ? <StockSourceBadge source={c.source_type} /> : '—') },
    { id: 'planned', header: 'Line planned', align: 'right', cell: (c) => formatQty(c.planned_quantity, c.unit) },
    { id: 'qty', header: 'Issued', align: 'right', cell: (c) => formatQty(c.actual_quantity, c.unit), sortValue: (c) => Number(c.actual_quantity) },
    { id: 'reserved', header: 'From reservation', align: 'right', cell: (c) => formatQty(c.reserved_quantity_used) },
    { id: 'tx', header: 'Ledger', cell: (c) => <span className="text-xs">{c.transaction_number ?? '—'}{c.reversal_transaction_ids?.length ? ` ↺ ${c.reversal_transaction_ids.join(', ')}` : ''}</span>, searchValue: (c) => c.transaction_number ?? '' },
    { id: 'note', header: 'Over-issue reason', cell: (c) => c.over_issue_reason ?? '' },
    { id: 'status', header: 'Status', cell: (c) => <PostedBadge status={c.status} />, sortValue: (c) => c.status },
  ]

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {canIssue && (
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <span className="text-sm font-medium">Issue materials to</span>
            <RunningOrderSelect orders={running.data ?? []} value={orderId} onChange={setOrderId} loading={running.loading} />
            <Button disabled={!order || lines.loading} onClick={() => setOpen(true)}><PackageMinus /> Issue materials</Button>
            <span className="text-xs text-muted-foreground">Stock is deducted only when the issue is posted. Reversals are made from the order page.</span>
          </CardContent>
        </Card>
      )}
      <DataTable
        title="Material issues"
        description="Raw materials issued to production orders in the period (reversed issues are shown and excluded from totals elsewhere)."
        columns={columns}
        data={rows.data ?? []}
        getRowId={(c) => c.id}
        loading={rows.loading}
        error={rows.error ? new Error(describeDataError(rows.error)) : null}
        onRetry={rows.reload}
        pageSize={25}
        searchPlaceholder="Search order, material or batch…"
        toolbar={<DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />}
        emptyState={{ icon: PackageMinus, title: 'No materials issued in this period', description: 'Issues appear here after they are posted against an order in production.' }}
      />
      {order && (
        <IssueMaterialsDialog order={order} lines={lines.data ?? []} open={open} onOpenChange={setOpen}
          onPosted={(m) => { setMessage(`${order.production_order_number}: ${m}`); setRefresh((n) => n + 1) }} />
      )}
    </>
  )
}
