import { Factory, HelpCircle, IndianRupee, Lock, PackageCheck, Scale, Truck, Warehouse } from 'lucide-react'
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
import { useDrill } from '@/features/drilldown/use-drill'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImagesById } from '@/features/products/product-image-hooks'
import { useAsync } from '@/hooks/use-async'
import { getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { money } from '@/features/billing/billing-model'
import { fetchMovements, fetchProductStockRow, fetchProductStockValuation, fetchReservations, fetchStockDetail, type ProductStockValuation } from '@/services/inventory'
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
  // Valuation is read separately so the stock card still opens if it cannot be loaded (e.g. before database update 20261125090000).
  const valuation = await fetchProductStockValuation(productId).then((v): ProductStockValuation | Error => v, (e: unknown) => new Error(describeDataError(e)))
  return { product, lots: lots.rows, movements: movements.rows, reservations: reservations.filter((r) => r.product_id === productId), valuation }
}

export default function ProductStockPage() {
  const { productId = '' } = useParams()
  const { data, loading, error, reload } = useAsync(() => load(productId), [productId])
  const images = useProductImagesById([productId])
  // Each figure opens this product's stock lots behind it.
  const { href } = useDrill('stock_card')
  const drill = (key: string) => href(key, { segment: productId })

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
  const val = data.valuation instanceof Error ? null : data.valuation
  const valError = data.valuation instanceof Error ? data.valuation.message : null
  // Each lot keeps its own cost: a location's value is its lots at their costs, never the product average.
  const lotValue = (r: StockDetailRow) => val?.lots.get(r.balance_id)
  const notValued = (r: StockDetailRow) => (Number(r.on_hand) > 0 ? 'Not Valued' : '—')
  const valueHint = !val ? (valError ? 'Valuation could not be loaded' : undefined)
    : val.valuation_status === 'PARTIAL' ? `${formatQty(val.unvalued_on_hand, u)} not valued (no cost recorded)`
    : val.valuation_status === 'NOT_VALUED' ? 'No cost recorded for the stock on hand'
    : 'On hand × lot average cost'

  const lotColumns: DataTableColumn<StockDetailRow>[] = [
    { id: 'wh', header: 'Warehouse', cell: (r) => r.warehouse_code, searchValue: (r) => r.warehouse_code },
    { id: 'loc', header: 'Location', cell: (r) => `${r.location_code} — ${r.location_name}`, searchValue: (r) => r.location_code },
    { id: 'batch', header: 'Batch/Lot', cell: (r) => r.batch_number ?? '—', searchValue: (r) => r.batch_number ?? '' },
    { id: 'src', header: 'Source', cell: (r) => <StockSourceBadge source={r.source_type} /> },
    { id: 'exp', header: 'Expiry', cell: (r) => r.expiry_date ?? '—' },
    { id: 'oh', header: 'On hand', align: 'right', cell: (r) => <>{formatQty(r.on_hand)}<FractionFlag values={[r.on_hand, r.reserved]} unit={r.base_unit} /></> },
    { id: 'res', header: 'Reserved', align: 'right', cell: (r) => <span className="text-amber-800">{formatQty(r.reserved)}</span> },
    { id: 'av', header: 'Available', align: 'right', cell: (r) => <span className="font-medium text-green-700">{formatQty(r.available)}</span> },
    { id: 'cost', header: 'Unit cost (₹)', align: 'right', cell: (r) => { const v = lotValue(r); return v?.unit_cost === null || v?.unit_cost === undefined ? <span className="text-muted-foreground">{val ? notValued(r) : '—'}</span> : money(v.unit_cost) } },
    { id: 'value', header: 'Stock value excl. GST (₹)', align: 'right', cell: (r) => { const v = lotValue(r); return v?.stock_value === null || v?.stock_value === undefined ? <span className="text-muted-foreground">{val ? notValued(r) : '—'}</span> : <span className="font-medium">{money(v.stock_value)}</span> } },
  ]
  // Per warehouse: quantities and the value of its lots (each at its own lot cost).
  const byWarehouse = [...data.lots.reduce((m, r) => {
    const w = m.get(r.warehouse_code) ?? { warehouse: r.warehouse_code, name: r.warehouse_name, on_hand: 0, reserved: 0, available: 0, value: 0, unvalued: 0 }
    const v = lotValue(r)
    w.on_hand += Number(r.on_hand)
    w.reserved += Number(r.reserved)
    w.available += Number(r.available)
    if (v?.stock_value !== null && v?.stock_value !== undefined) w.value += v.stock_value
    else if (Number(r.on_hand) > 0) w.unvalued += Number(r.on_hand)
    m.set(r.warehouse_code, w)
    return m
  }, new Map<string, { warehouse: string; name: string; on_hand: number; reserved: number; available: number; value: number; unvalued: number }>()).values()]
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
            <ProductThumb size="md" src={images.get(p.product_id)} alt={p.product_name} />
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
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard to={drill('stock.product_on_hand')} label="On hand" value={formatQty(p.on_hand)} unit={u} icon={Warehouse} />
        <KpiCard to={drill('stock.product_reserved')} label="Reserved" value={formatQty(p.reserved)} unit={u} icon={Lock} accent="pending" />
        <KpiCard to={drill('stock.product_available')} label="Available" value={formatQty(p.available)} unit={u} icon={PackageCheck} accent="available" />
        <KpiCard testId="ps-avg-cost" label="Average Inventory Cost" icon={Scale}
          value={val ? (val.unit_cost === null ? (val.valuation_status === 'NO_STOCK' ? '—' : 'Not Valued') : money(val.unit_cost)) : '—'}
          unit={val?.unit_cost !== null && val ? `per ${u}` : undefined} hint={val ? 'Weighted-average lot cost, as in the stock reports' : valError ?? undefined} />
        <KpiCard testId="ps-stock-value" label="Total Stock Value" icon={IndianRupee}
          value={val ? (val.stock_value === null ? (val.valuation_status === 'NO_STOCK' ? money(0) : 'Not Valued') : money(val.stock_value)) : '—'} hint={valueHint} />
        <KpiCard to={drill('stock.product_in_house')} label="In-house" value={formatQty(p.in_house_on_hand)} unit={u} icon={Factory} accent="manufacturing" />
        <KpiCard to={drill('stock.product_outsourced')} label="Outsourced" value={formatQty(p.outsourced_on_hand)} unit={u} icon={Truck} accent="outsourced" />
        <KpiCard to={drill('stock.product_unknown')} label="Unverified source" value={formatQty(p.unknown_source_on_hand)} unit={u} hint="Needs source review" icon={HelpCircle} accent="pending" />
      </div>
      <div className="space-y-6">
        {byWarehouse.length > 1 && (
          <DataTable title="Stock by warehouse" searchable={false} data={byWarehouse} getRowId={(w) => w.warehouse}
            columns={[
              { id: 'wh', header: 'Warehouse', cell: (w) => `${w.warehouse} — ${w.name}` },
              { id: 'oh', header: 'On hand', align: 'right', cell: (w) => formatQty(w.on_hand) },
              { id: 'res', header: 'Reserved', align: 'right', cell: (w) => formatQty(w.reserved) },
              { id: 'av', header: 'Available', align: 'right', cell: (w) => formatQty(w.available) },
              { id: 'value', header: 'Stock value excl. GST (₹)', align: 'right', cell: (w) => (!val ? '—' : w.value === 0 && w.unvalued > 0 ? 'Not Valued'
                : <>{money(w.value)}{w.unvalued > 0 && <span className="ml-1 text-xs text-muted-foreground">({formatQty(w.unvalued, u)} not valued)</span>}</>) },
            ]}
            emptyState={{ icon: Warehouse, title: 'No stock', description: '' }} />
        )}
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
