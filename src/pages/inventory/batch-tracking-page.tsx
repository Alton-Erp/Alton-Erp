import { Layers } from 'lucide-react'
import { useState } from 'react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchAllStockDetail, fetchInventoryPolicy } from '@/services/inventory'
import type { StockDetailRow } from '@/types/database-inventory'

type ExpiryFilter = 'all' | 'expired' | 'expiring' | 'ok'

async function load() {
  const [rows, policy] = await Promise.all([
    fetchAllStockDetail({ search: '', productId: null, categoryId: null, productType: null, source: null, warehouseId: null, locationId: null }),
    fetchInventoryPolicy(),
  ])
  return { rows: rows.filter((r) => !r.is_system_lot), policy }
}

export default function BatchTrackingPage() {
  const { data, loading, error, reload } = useAsync(load, [])
  const [filter, setFilter] = useState<ExpiryFilter>('all')
  const today = data?.policy.today ?? ''
  const warnUntil = data ? new Date(new Date(`${today}T00:00:00`).getTime() + data.policy.expiry_warning_days * 86400000).toISOString().slice(0, 10) : ''

  const state = (r: StockDetailRow) => (!r.expiry_date ? 'none' : r.expiry_date < today ? 'expired' : r.expiry_date <= warnUntil ? 'expiring' : 'ok')
  const rows = (data?.rows ?? []).filter((r) => filter === 'all' || (filter === 'ok' ? ['ok', 'none'].includes(state(r)) : state(r) === filter))

  const columns: DataTableColumn<StockDetailRow>[] = [
    { id: 'batch', header: 'Batch/Lot', cell: (r) => <span className="font-medium">{r.batch_number}</span>, searchValue: (r) => r.batch_number ?? '' },
    { id: 'sku', header: 'SKU', cell: (r) => r.sku, searchValue: (r) => `${r.sku} ${r.product_name} ${r.barcode ?? ''}` },
    { id: 'product', header: 'Product', cell: (r) => r.product_name },
    { id: 'source', header: 'Source', cell: (r) => <StockSourceBadge source={r.source_type} /> },
    { id: 'loc', header: 'Location', cell: (r) => `${r.warehouse_code} / ${r.location_code}`, searchValue: (r) => r.location_code },
    { id: 'mfg', header: 'Mfg date', cell: (r) => r.manufacturing_date ?? '—' },
    {
      id: 'exp',
      header: 'Expiry',
      cell: (r) => {
        const s = state(r)
        return r.expiry_date ? (
          <span className="flex items-center gap-2">{r.expiry_date}
            {s === 'expired' && <StatusBadge label="Expired" tone="danger" />}
            {s === 'expiring' && <StatusBadge label="Expiring" tone="warning" />}
          </span>
        ) : '—'
      },
    },
    { id: 'oh', header: 'On hand', align: 'right', cell: (r) => formatQty(r.on_hand, r.base_unit) },
    { id: 'res', header: 'Reserved', align: 'right', cell: (r) => formatQty(r.reserved) },
    { id: 'av', header: 'Available', align: 'right', cell: (r) => <span className="font-medium text-green-700">{formatQty(r.available)}</span> },
  ]

  return (
    <>
      <PageHeader />
      <DataTable
        title="Batches with stock"
        description={data ? `Expiry warning period: ${data.policy.expiry_warning_days} days (company setting).` : undefined}
        columns={columns}
        data={rows}
        getRowId={(r) => r.balance_id}
        loading={loading}
        error={error ? new Error(describeDataError(error)) : null}
        onRetry={reload}
        searchPlaceholder="Search batch, SKU, product, barcode…"
        pageSize={25}
        toolbar={
          <FilterTabs<ExpiryFilter>
            label="Expiry"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'expired', label: 'Expired' },
              { value: 'expiring', label: 'Expiring soon' },
              { value: 'ok', label: 'Not expiring' },
            ]}
          />
        }
        emptyState={{ icon: Layers, title: 'No batch stock', description: 'Batch-tracked products appear here once their stock is received with batch numbers. Unit costs are shown in the valuation report.' }}
      />
      <p className="mt-3 text-xs text-muted-foreground">
        Only batch-tracked products have batch numbers. Products without batch tracking are held in one lot per source and are shown in the Stock Register.
      </p>
    </>
  )
}
