import { PackageCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { formatQty } from '@/features/inventory/inventory-model'
import { MakeTypeBadge, PostedBadge } from '@/features/production/production-badges'
import { OutputDialog } from '@/features/production/production-dialogs'
import { QUALITY_STATUS_LABELS } from '@/features/production/production-model'
import { RunningOrderSelect } from '@/features/production/running-order-select'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { fetchOutputs, fetchRunningOrders } from '@/services/production'
import type { DateRangeValue } from '@/types'
import type { OutputListRow } from '@/types/database-production'

export default function FinishedGoodsReceiptsPage() {
  const { has } = usePermissions()
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [refresh, setRefresh] = useState(0)
  const [orderId, setOrderId] = useState('')
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const rows = useAsync(() => fetchOutputs({ from: toIsoDate(range.from), to: toIsoDate(range.to) }), [range, refresh])
  const canReceive = has('production_output.receive')
  const running = useAsync(() => (canReceive ? fetchRunningOrders() : Promise.resolve([])), [canReceive, refresh])
  const order = running.data?.find((o) => o.id === orderId)

  const columns: DataTableColumn<OutputListRow>[] = [
    { id: 'no', header: 'Receipt', cell: (r) => <span className="font-medium">{r.receipt_number}</span>, searchValue: (r) => r.receipt_number, sortValue: (r) => r.receipt_number },
    { id: 'date', header: 'Production date', cell: (r) => formatDate(r.production_date), sortValue: (r) => r.production_date },
    { id: 'order', header: 'Order', cell: (r) => <Link className="text-primary hover:underline" to={`/production/orders/${r.production_order_id}`}>{r.production_order_number}</Link>, searchValue: (r) => r.production_order_number },
    { id: 'product', header: 'Product', cell: (r) => <span>{r.sku}<span className="block text-xs text-muted-foreground">{r.product_name}</span></span>, searchValue: (r) => `${r.sku} ${r.product_name}` },
    { id: 'source', header: 'Source', cell: () => <MakeTypeBadge kind="IN_HOUSE" /> },
    { id: 'batch', header: 'Batch', cell: (r) => r.batch_number ?? (r.batch_id ? 'System lot' : '—'), searchValue: (r) => r.batch_number ?? '' },
    { id: 'good', header: 'Good', align: 'right', cell: (r) => <span>{formatQty(r.good_quantity, r.unit)}{r.good_location_code && <span className="block text-xs text-muted-foreground">{r.good_warehouse_code} / {r.good_location_code}</span>}</span>, sortValue: (r) => Number(r.good_quantity) },
    { id: 'rej', header: 'Rejected', align: 'right', cell: (r) => <span>{formatQty(r.rejected_quantity)}{Number(r.rejected_quantity) > 0 && <span className="block text-xs text-muted-foreground">{r.rejected_location_code ?? 'not stocked'}</span>}</span> },
    { id: 'scrap', header: 'Scrap', align: 'right', cell: (r) => formatQty(r.scrap_quantity) },
    { id: 'quality', header: 'Quality', cell: (r) => QUALITY_STATUS_LABELS[r.quality_status] },
    { id: 'tx', header: 'Ledger', cell: (r) => <span className="text-xs">{[r.good_transaction_number, r.rejected_transaction_number].filter(Boolean).join(', ') || '—'}</span> },
    { id: 'status', header: 'Status', cell: (r) => <PostedBadge status={r.status} /> },
  ]

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {canReceive && (
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <span className="text-sm font-medium">Record output for</span>
            <RunningOrderSelect orders={running.data ?? []} value={orderId} onChange={setOrderId} loading={running.loading} />
            <Button disabled={!order} onClick={() => setOpen(true)}><PackageCheck /> Record output</Button>
            <span className="text-xs text-muted-foreground">Partial receipts are supported. Good output is added to stock once posted.</span>
          </CardContent>
        </Card>
      )}
      <DataTable
        title="Finished goods receipts"
        description="Production output recorded in the period. Good, rejected and scrap quantities are kept separate."
        columns={columns}
        data={rows.data ?? []}
        getRowId={(r) => r.id}
        loading={rows.loading}
        error={rows.error ? new Error(describeDataError(rows.error)) : null}
        onRetry={rows.reload}
        pageSize={25}
        searchPlaceholder="Search receipt, order, product or batch…"
        toolbar={<DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />}
        emptyState={{ icon: PackageCheck, title: 'No output recorded in this period', description: 'Output is recorded against production orders in progress.' }}
      />
      {order && (
        <OutputDialog order={order} open={open} onOpenChange={setOpen}
          onPosted={(m) => { setMessage(`${order.production_order_number}: ${m}`); setRefresh((n) => n + 1) }} />
      )}
    </>
  )
}
