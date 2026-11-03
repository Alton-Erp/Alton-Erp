import { PackagePlus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { MakeTypeBadge, PostedBadge } from '@/features/production/production-badges'
import { DISPOSITION_LABELS, OUTSOURCING_TYPE_LABELS } from '@/features/production/production-model'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { fetchOutsourcingOrders, fetchOutsourcingReceipts } from '@/services/production'
import type { DateRangeValue } from '@/types'
import type { OutsourcingReceiptListRow } from '@/types/database-production'

export default function OutsourcedReceiptsPage() {
  const { has } = usePermissions()
  const navigate = useNavigate()
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [orderId, setOrderId] = useState('')
  const rows = useAsync(() => fetchOutsourcingReceipts({ from: toIsoDate(range.from), to: toIsoDate(range.to) }), [range])
  const canReceive = has('outsourcing_receipt.create')
  const receivable = useAsync(
    () => (canReceive ? fetchOutsourcingOrders('OPEN').then((r) => r.filter((o) => ['APPROVED', 'MATERIALS_DISPATCHED', 'PARTIALLY_RECEIVED'].includes(o.status))) : Promise.resolve([])),
    [canReceive],
  )

  const columns: DataTableColumn<OutsourcingReceiptListRow>[] = [
    { id: 'no', header: 'Receipt', cell: (r) => <span className="font-medium">{r.receipt_number}</span>, searchValue: (r) => r.receipt_number, sortValue: (r) => r.receipt_number },
    { id: 'date', header: 'Date', cell: (r) => formatDate(r.receipt_date), sortValue: (r) => r.receipt_date },
    { id: 'order', header: 'Order', cell: (r) => <Link className="text-primary hover:underline" to={`/production/outsourcing/${r.outsourcing_order_id}`}>{r.outsourcing_order_number}</Link>, searchValue: (r) => r.outsourcing_order_number },
    { id: 'supplier', header: 'Supplier', cell: (r) => <span>{r.supplier_name}{r.supplier_document_number && <span className="block text-xs text-muted-foreground">Doc {r.supplier_document_number}</span>}</span>, searchValue: (r) => `${r.supplier_name} ${r.supplier_document_number ?? ''}` },
    { id: 'type', header: 'Type', cell: (r) => <span className="inline-flex flex-col gap-1"><MakeTypeBadge kind="OUTSOURCED" /><span className="text-xs text-muted-foreground">{OUTSOURCING_TYPE_LABELS[r.order_type]}</span></span> },
    { id: 'product', header: 'Product', cell: (r) => <span>{r.sku}<span className="block text-xs text-muted-foreground">{r.batch_number ? `Batch ${r.batch_number}` : r.product_name}</span></span>, searchValue: (r) => `${r.sku} ${r.product_name} ${r.batch_number ?? ''}` },
    { id: 'recv', header: 'Received', align: 'right', cell: (r) => formatQty(r.received_quantity, r.unit) },
    { id: 'acc', header: 'Accepted', align: 'right', cell: (r) => <span>{formatQty(r.accepted_quantity)}{r.accepted_location_code && <span className="block text-xs text-muted-foreground">{r.accepted_warehouse_code} / {r.accepted_location_code}</span>}</span> },
    { id: 'rej', header: 'Rejected', align: 'right', cell: (r) => (Number(r.rejected_quantity) > 0 ? <span>{formatQty(r.rejected_quantity)}<span className="block text-xs text-muted-foreground">{DISPOSITION_LABELS[r.rejection_disposition ?? '']}{r.rejected_location_code ? ` · ${r.rejected_location_code}` : ' · not stocked'}</span></span> : '0') },
    { id: 'status', header: 'Status', cell: (r) => <PostedBadge status={r.status} /> },
  ]

  return (
    <>
      <PageHeader />
      {canReceive && (
        <Card className="mb-6">
          <CardContent className="flex flex-wrap items-center gap-3 p-4">
            <span className="text-sm font-medium">Receive goods for</span>
            <Select value={orderId} onValueChange={setOrderId}>
              <SelectTrigger aria-label="Outsourcing order" className="w-80"><SelectValue placeholder={receivable.loading ? 'Loading…' : 'Select an approved outsourcing order'} /></SelectTrigger>
              <SelectContent className="max-h-72">
                {(receivable.data ?? []).length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No approved outsourcing orders awaiting goods.</div>}
                {(receivable.data ?? []).map((o) => <SelectItem key={o.id} value={o.id}>{o.outsourcing_order_number} — {o.sku} · {o.supplier_name} · pending {formatQty(o.pending_quantity, o.unit)}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button disabled={!orderId} onClick={() => navigate(`/production/outsourcing/${orderId}`)}><PackagePlus /> Open order to receive</Button>
            <span className="text-xs text-muted-foreground">Receipts are posted from the order so material used by the supplier is recorded with them.</span>
          </CardContent>
        </Card>
      )}
      <DataTable
        title="Outsourced goods receipts"
        description="Received, accepted and rejected quantities per receipt. Only accepted goods are in usable stock."
        columns={columns}
        data={rows.data ?? []}
        getRowId={(r) => r.id}
        loading={rows.loading}
        error={rows.error ? new Error(describeDataError(rows.error)) : null}
        onRetry={rows.reload}
        pageSize={25}
        searchPlaceholder="Search receipt, order, supplier, product or batch…"
        toolbar={<DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />}
        emptyState={{ icon: PackagePlus, title: 'No outsourced goods received in this period', description: 'Receipts appear here after they are posted on an outsourcing order.' }}
      />
    </>
  )
}
