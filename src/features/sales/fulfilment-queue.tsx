import { AlertTriangle, PackageOpen } from 'lucide-react'
import type { ReactNode } from 'react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { formatQty } from '@/features/inventory/inventory-model'
import { FulfilmentStatusBadge } from '@/features/sales/sales-badges'
import { PRIORITY_LABELS } from '@/features/sales/sales-model'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { FulfilmentListRow } from '@/types/database-sales'

type Extra = 'picked' | 'packed' | 'dispatch' | 'delivery'

/** Table of consignments; clicking a row selects it (the page keeps it in ?f=). */
export function FulfilmentQueue({ title, description, rows, loading, error, onRetry, selectedId, onSelect, extra, emptyTitle, emptyDescription, toolbar }: {
  title: string
  description?: string
  rows: FulfilmentListRow[]
  loading: boolean
  error: unknown
  onRetry: () => void
  selectedId: string
  onSelect: (id: string) => void
  extra: Extra[]
  emptyTitle: string
  emptyDescription: string
  toolbar?: ReactNode
}) {
  const columns: DataTableColumn<FulfilmentListRow>[] = [
    { id: 'number', header: 'Consignment', cell: (f) => (
      <span className={cn('font-medium', f.id === selectedId && 'text-primary')}>{f.id === selectedId ? '▸ ' : ''}{f.fulfilment_number}
        <span className="block text-xs font-normal text-muted-foreground">{formatDateTime(f.created_at)}</span></span>
    ), searchValue: (f) => `${f.fulfilment_number} ${f.tracking_number ?? ''} ${f.lr_number ?? ''}` },
    { id: 'order', header: 'Order / customer', cell: (f) => <span>{f.sales_order_number}<span className="block text-xs text-muted-foreground">{f.customer_name_snapshot}</span></span>,
      searchValue: (f) => `${f.sales_order_number} ${f.customer_name_snapshot} ${f.customer_po_number ?? ''}` },
    { id: 'status', header: 'Status', cell: (f) => (
      <span className="inline-flex flex-col gap-1"><FulfilmentStatusBadge status={f.fulfilment_status} overdue={f.is_overdue} />
        {(f.pick_exceptions > 0 || f.pack_exceptions > 0) && <span className="inline-flex items-center gap-1 text-xs text-amber-800"><AlertTriangle className="size-3" /> {f.pick_exceptions + f.pack_exceptions} exception(s)</span>}</span>
    ) },
    { id: 'wh', header: 'Warehouse', cell: (f) => f.warehouse_code },
    { id: 'priority', header: 'Priority', cell: (f) => <span className={f.priority === 'URGENT' || f.priority === 'HIGH' ? 'font-medium text-amber-800' : ''}>{PRIORITY_LABELS[f.priority]}</span> },
    { id: 'qty', header: extra.includes('dispatch') || extra.includes('delivery') ? 'Dispatched / delivered' : extra.includes('packed') ? 'Picked / packed' : 'To pick / picked', align: 'right', cell: (f) => (
      <span className="tabular-nums">{extra.includes('dispatch') || extra.includes('delivery') ? `${formatQty(f.dispatched)} / ${formatQty(f.delivered)}` : extra.includes('packed') ? `${formatQty(f.picked)} / ${formatQty(f.packed)}` : `${formatQty(f.to_pick)} / ${formatQty(f.picked)}`} <span className="text-xs text-muted-foreground">{f.units}</span></span>
    ) },
    ...(extra.includes('dispatch') || extra.includes('delivery') ? [
      { id: 'carrier', header: 'Carrier / tracking', cell: (f: FulfilmentListRow) => <span className="text-xs">{f.carrier_name ?? '—'}<span className="block text-muted-foreground">{f.tracking_number ?? f.lr_number ?? ''}</span></span> },
      { id: 'dates', header: 'Dispatched · expected · delivered', cell: (f: FulfilmentListRow) => (
        <span className="text-xs">{f.actual_dispatch_at ? formatDate(f.actual_dispatch_at) : '—'} · {f.expected_delivery_date ? formatDate(f.expected_delivery_date) : '—'} · {f.delivered_at ? formatDate(f.delivered_at) : '—'}
          {f.delivery_days_late !== null && f.delivery_days_late > 0 && <span className="block text-shortage">{f.delivery_days_late} day(s) late</span>}</span>
      ) },
    ] : [
      { id: 'planned', header: 'Planned dispatch', cell: (f: FulfilmentListRow) => (f.planned_dispatch_date ? formatDate(f.planned_dispatch_date) : '—') },
    ]),
  ]
  return (
    <DataTable title={title} description={description} columns={columns} data={rows} getRowId={(f) => f.id} loading={loading}
      error={error ? new Error(describeDataError(error)) : null} onRetry={onRetry} pageSize={10} toolbar={toolbar} onRowClick={(f) => onSelect(f.id)}
      searchPlaceholder="Search consignment, order, customer or tracking no.…"
      emptyState={{ icon: PackageOpen, title: emptyTitle, description: emptyDescription }} />
  )
}
