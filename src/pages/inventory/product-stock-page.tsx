import { Factory, HelpCircle, Lock, PackageCheck, Truck, Warehouse } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ReservationStatusBadge, StockSourceBadge, StockStatusBadge, TransactionTypeBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { FractionFlag } from '@/features/inventory/fraction-flag'
import { isFractionalForUnit } from '@/features/inventory/whole-units'
import { useAsync } from '@/hooks/use-async'
import { getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchMovements, fetchProductStockRow, fetchReservations, fetchStockDetail } from '@/services/inventory'
import type { StockDetailRow, TransactionListRow } from '@/types/database-inventory'

async function load(productId: string) {
  const [product, lots, movements, reservations] = await Promise.all([
    fetchProductStockRow(productId),
    fetchStockDetail(
      { search: '', productId, categoryId: null, productType: null, source: null, warehouseId: null, locationId: null },
      { column: 'warehouse_code', ascending: true },
      0,
      500,
    ),
    fetchMovements(
      { ...getPresetRange('this_year'), from: new Date(2000, 0, 1), to: new Date(), search: '', productId, transactionType: null, source: null, warehouseId: null, locationId: null, batchId: null, userId: null, reference: '' },
      0,
      50,
    ),
    fetchReservations('OPEN'),
  ])
  return { product, lots: lots.rows, movements: movements.rows, reservations: reservations.filter((r) => r.product_id === productId) }
}

export default function ProductStockPage() {
  const { productId = '' } = useParams()
  const { data, loading, error, reload } = useAsync(() => load(productId), [productId])

  if (loading && !data) return <LoadingState label="Loading stock…" />
  if (error || !data) {
    return (
      <>
        <PageHeader title="Product stock" breadcrumbs={[{ label: 'Inventory' }, { label: 'Stock Register', to: '/inventory/stock' }, { label: 'Product' }]} />
        <Card>
          <ErrorState message={describeDataError(error)} onRetry={reload} />
        </Card>
      </>
    )
  }
  const p = data.product
  const u = p.base_unit

  const lotColumns: DataTableColumn<StockDetailRow>[] = [
    { id: 'wh', header: 'Warehouse', cell: (r) => r.warehouse_code, searchValue: (r) => r.warehouse_code },
    { id: 'loc', header: 'Location', cell: (r) => `${r.location_code} — ${r.location_name}`, searchValue: (r) => r.location_code },
    { id: 'batch', header: 'Batch/Lot', cell: (r) => r.batch_number ?? '—', searchValue: (r) => r.batch_number ?? '' },
    { id: 'src', header: 'Source', cell: (r) => <StockSourceBadge source={r.source_type} /> },
    { id: 'exp', header: 'Expiry', cell: (r) => r.expiry_date ?? '—' },
    { id: 'oh', header: 'On hand', align: 'right', cell: (r) => <>{formatQty(r.on_hand)}<FractionFlag values={[r.on_hand, r.reserved]} unit={r.base_unit} /></> },
    { id: 'res', header: 'Reserved', align: 'right', cell: (r) => <span className="text-amber-800">{formatQty(r.reserved)}</span> },
    { id: 'av', header: 'Available', align: 'right', cell: (r) => <span className="font-medium text-green-700">{formatQty(r.available)}</span> },
  ]
  const movementColumns: DataTableColumn<TransactionListRow>[] = [
    { id: 'no', header: 'Transaction', cell: (t) => <span className="font-medium">{t.transaction_number}</span>, searchValue: (t) => t.transaction_number },
    { id: 'date', header: 'Date', cell: (t) => formatDateTime(t.transaction_date) },
    { id: 'type', header: 'Type', cell: (t) => <TransactionTypeBadge type={t.transaction_type} direction={t.direction} /> },
    { id: 'loc', header: 'Location', cell: (t) => `${t.warehouse_code} / ${t.location_code}` },
    { id: 'in', header: 'In', align: 'right', cell: (t) => (t.quantity_in ? formatQty(t.quantity_in) : '') },
    { id: 'out', header: 'Out', align: 'right', cell: (t) => (t.quantity_out ? formatQty(t.quantity_out) : '') },
    { id: 'reason', header: 'Reason', cell: (t) => <span className="block max-w-xs truncate">{t.reason}</span>, searchValue: (t) => t.reason },
  ]

  return (
    <>
      <PageHeader
        title={`${p.sku} — ${p.product_name}`}
        description={`Unit ${u}${p.reorder_level === null ? '' : ` · earlier reorder quantity ${formatQty(p.reorder_level, u)}`} · days of cover under Reorder planning`}
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Stock Register', to: '/inventory/stock' }, { label: p.sku }]}
        actions={
          <>
            <StockStatusBadge status={p.stock_status} />
            <Button variant="outline" asChild>
              <Link to={`/products/${p.product_id}`}>Product master</Link>
            </Button>
          </>
        }
      />
      {(isFractionalForUnit(p.on_hand, u) || isFractionalForUnit(p.reserved, u)) && (
        <p role="status" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          {p.sku} is counted in whole {u}, but its recorded stock includes a fraction from postings made before whole-piece rules. The quantities are shown exactly as recorded.
          Count the item and request a stock adjustment to the whole number counted (see <Link className="underline" to="/inventory/whole-piece-audit">Whole-piece audit</Link>).
        </p>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <KpiCard label="On hand" value={formatQty(p.on_hand)} unit={u} icon={Warehouse} />
        <KpiCard label="Reserved" value={formatQty(p.reserved)} unit={u} icon={Lock} accent="pending" />
        <KpiCard label="Available" value={formatQty(p.available)} unit={u} icon={PackageCheck} accent="available" />
        <KpiCard label="In-house" value={formatQty(p.in_house_on_hand)} unit={u} icon={Factory} accent="manufacturing" />
        <KpiCard label="Outsourced" value={formatQty(p.outsourced_on_hand)} unit={u} icon={Truck} accent="outsourced" />
        <KpiCard label="Unverified source" value={formatQty(p.unknown_source_on_hand)} unit={u} hint="Needs source review" icon={HelpCircle} accent="pending" />
      </div>
      <div className="space-y-6">
        <DataTable title="Stock by location and lot" columns={lotColumns} data={data.lots} getRowId={(r) => r.balance_id}
          emptyState={{ icon: Warehouse, title: 'No stock on hand', description: 'This product has no stock in any location.' }} />
        <DataTable
          title="Open reservations"
          columns={[
            { id: 'no', header: 'Reservation', cell: (r) => r.reservation_number },
            { id: 'ref', header: 'Reference', cell: (r) => `${r.reference_type} ${r.reference_number}` },
            { id: 'loc', header: 'Location', cell: (r) => `${r.warehouse_code} / ${r.location_code}` },
            { id: 'q', header: 'Remaining', align: 'right', cell: (r) => formatQty(Number(r.quantity) - Number(r.fulfilled_quantity) - Number(r.released_quantity), u) },
            { id: 's', header: 'Status', cell: (r) => <ReservationStatusBadge status={r.reservation_status} /> },
          ]}
          data={data.reservations}
          getRowId={(r) => r.id}
          searchable={false}
          emptyState={{ icon: Lock, title: 'No open reservations', description: 'Reserved quantities appear here.' }}
        />
        <DataTable title="Latest movements" description="The 50 most recent ledger entries" columns={movementColumns} data={data.movements} getRowId={(t) => t.id}
          emptyState={{ icon: Warehouse, title: 'No movements yet', description: 'Ledger entries for this product appear here.' }} />
      </div>
    </>
  )
}
