import { Download, FileSpreadsheet, Loader2, Search, SearchX, Table2, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { SortableHead } from '@/components/common/sortable-head'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { StockSourceBadge, StockStatusBadge } from '@/features/inventory/inventory-badges'
import { STOCK_SOURCE_LABELS, STOCK_STATUS_LABELS, formatQty, type StockSourceCode } from '@/features/inventory/inventory-model'
import { FractionFlag } from '@/features/inventory/fraction-flag'
import { useStorage } from '@/features/inventory/use-storage'
import { PRODUCT_TYPES, PRODUCT_TYPE_LABELS } from '@/features/products/product-model'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImagesById } from '@/features/products/product-image-hooks'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { requireSupabase } from '@/lib/supabase'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import {
  fetchAllStockDetail,
  fetchStockDetail,
  fetchStockPosition,
  type DetailFilters,
  type RegisterFilters,
  type StockPositionFilters,
} from '@/services/inventory'
import { StockPositionPanel } from '@/features/inventory/stock-position-panel'
import { PendingInvoicePanel } from '@/features/sales/pending-invoice-panel'
import { stockPositionSheet } from '@/features/inventory/stock-position-model'
import { listCategories } from '@/services/products'
import type { ProductStockRow, StockDetailRow } from '@/types/database-inventory'

type Mode = 'product' | 'detail'

/**
 * Inventory → Stock Register. Two sections: actual stock (unchanged) and Pending /
 * Incomplete Invoice Orders (sales-order quantities not yet invoiced; tracking only,
 * never part of stock). ?view=pending-invoice opens the second section.
 */
export default function StockRegisterPage() {
  const [params, setParams] = useSearchParams()
  const section = params.get('view') === 'pending-invoice' ? 'pending' : 'stock'
  const tabs = (
    <div className="mb-4">
      <FilterTabs<'stock' | 'pending'> label="Stock register section" value={section}
        onChange={(v) => setParams(v === 'pending' ? { view: 'pending-invoice' } : {})}
        options={[{ value: 'stock', label: 'Stock' }, { value: 'pending', label: 'Pending / Incomplete Invoice Orders' }]} />
    </div>
  )
  return section === 'pending' ? <PendingInvoicePanel sectionTabs={tabs} initialSalesOrderId={params.get('so')} /> : <StockRegisterStock sectionTabs={tabs} />
}

function StockRegisterStock({ sectionTabs }: { sectionTabs: ReactNode }) {
  const navigate = useNavigate()
  const storage = useStorage()
  const categories = useAsync(listCategories, [])
  const [mode, setMode] = useState<Mode>('product')
  const [search, setSearch] = useState('')
  const term = useDebouncedValue(search)
  const [categoryId, setCategoryId] = useState('all')
  const [productType, setProductType] = useState('all')
  const [stockStatus, setStockStatus] = useState('all')
  const [source, setSource] = useState('all')
  const [warehouseId, setWarehouseId] = useState('all')
  const [locationId, setLocationId] = useState('all')
  const [includeInactive, setIncludeInactive] = useState(false)
  const [sort, setSort] = useState<{ column: string; ascending: boolean }>({ column: 'sku', ascending: true })
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [exporting, setExporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const positionFilters: StockPositionFilters = useMemo(
    () => ({
      search: term,
      category_id: categoryId === 'all' ? null : categoryId,
      product_type: productType === 'all' ? null : productType,
      warehouse_id: warehouseId === 'all' ? null : warehouseId,
      include_inactive: includeInactive,
    }),
    [term, categoryId, productType, warehouseId, includeInactive],
  )
  const productFilters: RegisterFilters = useMemo(
    () => ({
      search: term,
      categoryId: categoryId === 'all' ? null : categoryId,
      productType: productType === 'all' ? null : productType,
      stockStatus: stockStatus === 'all' ? null : stockStatus,
      includeInactive,
    }),
    [term, categoryId, productType, stockStatus, includeInactive],
  )
  const detailFilters: DetailFilters = useMemo(
    () => ({
      search: term,
      productId: null,
      categoryId: categoryId === 'all' ? null : categoryId,
      productType: productType === 'all' ? null : productType,
      source: source === 'all' ? null : source,
      warehouseId: warehouseId === 'all' ? null : warehouseId,
      locationId: locationId === 'all' ? null : locationId,
    }),
    [term, categoryId, productType, source, warehouseId, locationId],
  )

  const filterKey = JSON.stringify([mode, productFilters, detailFilters, sort, pageSize])
  const [lastKey, setLastKey] = useState(filterKey)
  if (lastKey !== filterKey) {
    setLastKey(filterKey)
    setPage(0)
  }

  const list = useAsync<{ rows: (ProductStockRow | StockDetailRow)[]; total: number }>(
    () => (mode === 'product' ? Promise.resolve({ rows: [], total: 0 }) : fetchStockDetail(detailFilters, sort, page, pageSize)),
    [filterKey, page],
  )

  // Product-level stock status for detail rows (current page only).
  const detailRows = mode === 'detail' ? ((list.data?.rows ?? []) as StockDetailRow[]) : []
  const rowImages = useProductImagesById((list.data?.rows ?? []).map((r) => r.product_id))
  const statusLookup = useAsync(async () => {
    const ids = [...new Set(detailRows.map((r) => r.product_id))]
    if (ids.length === 0) return new Map<string, string>()
    const { data, error } = await requireSupabase().from('inventory_product_stock').select('product_id, stock_status').in('product_id', ids)
    if (error) throw error
    return new Map((data ?? []).map((r) => [r.product_id, r.stock_status as string]))
  }, [list.data])

  const changeMode = (m: Mode) => {
    setMode(m)
    setSort({ column: 'sku', ascending: true })
  }

  const exportRows = async (format: 'xlsx' | 'csv') => {
    setExporting(true)
    setNotice(null)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      if (mode === 'product') {
        const rows = (await fetchStockPosition(positionFilters)).rows.filter((r) => stockStatus === 'all' || r.stock_status === stockStatus)
        await downloadSheets([{ name: 'Stock by product', rows: stockPositionSheet(rows) }], `stock-by-product-${toIsoDate(new Date())}`, format)
        setNotice(`Exported ${formatNumber(rows.length)} products.`)
      } else {
        const rows = await fetchAllStockDetail(detailFilters)
        await downloadSheets(
          [{
            name: 'Stock detail',
            rows: [
              ['SKU', 'Product Name', 'Category', 'Unit', 'Product Type', 'Source', 'Warehouse', 'Location', 'Batch/Lot', 'Expiry', 'On Hand', 'Reserved', 'Available', 'Reorder Qty (earlier)', 'Last Movement'],
              ...rows.map((r) => [r.sku, r.product_name, r.category_name, r.base_unit, PRODUCT_TYPE_LABELS[r.product_type as keyof typeof PRODUCT_TYPE_LABELS] ?? r.product_type,
                STOCK_SOURCE_LABELS[r.source_type as StockSourceCode], r.warehouse_code, r.location_code, r.batch_number, r.expiry_date,
                Number(r.on_hand), Number(r.reserved), Number(r.available), r.reorder_level === null ? null : Number(r.reorder_level),
                r.last_movement_at ? formatDateTime(r.last_movement_at) : null]),
            ],
          }],
          `stock-detail-${toIsoDate(new Date())}`,
          format,
        )
        setNotice(`Exported ${formatNumber(rows.length)} stock lines.`)
      }
    } catch (error) {
      setNotice(describeDataError(error))
    } finally {
      setExporting(false)
    }
  }

  const filtersActive = search !== '' || categoryId !== 'all' || productType !== 'all' || stockStatus !== 'all' || source !== 'all' || warehouseId !== 'all' || locationId !== 'all'
  const clear = () => {
    setSearch('')
    setCategoryId('all')
    setProductType('all')
    setStockStatus('all')
    setSource('all')
    setWarehouseId('all')
    setLocationId('all')
  }

  const locationOptions = storage.allLocations.filter((l) => warehouseId === 'all' || l.warehouseId === warehouseId)
  const total = list.data?.total ?? 0

  return (
    <>
      <PageHeader
        actions={
          <PermissionGate permission="inventory.export">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={exporting || total === 0}>
                  {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void exportRows('xlsx')}>
                  <FileSpreadsheet /> Excel (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void exportRows('csv')}>
                  <FileSpreadsheet /> CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </PermissionGate>
        }
      />
      {sectionTabs}
      {notice && <p role="status" className="mb-4 rounded-lg border bg-background px-4 py-2.5 text-sm">{notice}</p>}

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <FilterTabs<Mode>
              label="Register view"
              value={mode}
              onChange={changeMode}
              options={[
                { value: 'product', label: 'By product' },
                { value: 'detail', label: 'By warehouse / location / batch' },
              ]}
            />
            <div className="relative w-full lg:max-w-sm">
              <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={mode === 'product' ? 'Search or scan SKU, name, barcode…' : 'Search SKU, name, barcode, batch…'}
                aria-label="Search stock"
                className="pr-8 pl-9"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-44" aria-label="Category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {(categories.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={productType} onValueChange={setProductType}>
              <SelectTrigger className="w-44" aria-label="Product type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All product types</SelectItem>
                {PRODUCT_TYPES.map((t) => <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</SelectItem>)}
              </SelectContent>
            </Select>
            {mode === 'product' ? (
              <>
                <Select value={stockStatus} onValueChange={setStockStatus}>
                  <SelectTrigger className="w-44" aria-label="Stock status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stock statuses</SelectItem>
                    {Object.entries(STOCK_STATUS_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger className="w-44" aria-label="Warehouse"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All warehouses</SelectItem>
                    {storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-2 pl-1">
                  <Checkbox id="reg-inactive" checked={includeInactive} onCheckedChange={(v) => setIncludeInactive(v === true)} />
                  <Label htmlFor="reg-inactive" className="font-normal">Include inactive products</Label>
                </div>
              </>
            ) : (
              <>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className="w-44" aria-label="Source"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {Object.entries(STOCK_SOURCE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={warehouseId} onValueChange={(v) => { setWarehouseId(v); setLocationId('all') }}>
                  <SelectTrigger className="w-44" aria-label="Warehouse"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All warehouses</SelectItem>
                    {storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger className="w-56" aria-label="Location"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value="all">All locations</SelectItem>
                    {locationOptions.map((l) => <SelectItem key={l.id} value={l.id}>{l.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </>
            )}
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clear}>
                <X /> Clear filters
              </Button>
            )}
          </div>
        </div>

        {mode === 'product' ? (
          <StockPositionPanel filters={positionFilters} stockStatus={stockStatus} onClearFilters={clear} filtersActive={filtersActive} />
        ) : list.loading && !list.data ? (
          <LoadingState variant="table" rows={6} />
        ) : list.error ? (
          <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        ) : (list.data?.rows ?? []).length === 0 ? (
          filtersActive ? (
            <EmptyState icon={SearchX} title="Nothing matches" description="Try a different search or clear the filters." action={<Button variant="outline" size="sm" onClick={clear}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={Table2} title="No stock on hand" description="Stock appears here once opening stock or receipts are posted." />
          )
        ) : (
          <div className={list.loading ? 'opacity-60 transition-opacity' : undefined} aria-busy={list.loading}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead column="sku" label="SKU" sort={sort} onSort={setSort} />
                  <SortableHead column="product_name" label="Product" sort={sort} onSort={setSort} />
                  <SortableHead column="category_name" label="Category" sort={sort} onSort={setSort} />
                  <TableHead>Unit</TableHead>
                  <SortableHead column="product_type" label="Type" sort={sort} onSort={setSort} />
                  <SortableHead column="source_type" label="Source" sort={sort} onSort={setSort} />
                  <SortableHead column="warehouse_code" label="Warehouse" sort={sort} onSort={setSort} />
                  <SortableHead column="location_code" label="Location" sort={sort} onSort={setSort} />
                  <SortableHead column="batch_number" label="Batch/Lot" sort={sort} onSort={setSort} />
                  <SortableHead column="on_hand" label="On Hand" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="reserved" label="Reserved" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="available" label="Available" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="reorder_level" label="Reorder qty" sort={sort} onSort={setSort} align="right" />
                  <TableHead>Product status</TableHead>
                  <SortableHead column="last_movement_at" label="Last movement" sort={sort} onSort={setSort} />
                </TableRow>
              </TableHeader>
              <TableBody>
                {detailRows.map((r) => (
                      <TableRow key={r.balance_id} className="cursor-pointer" onClick={() => navigate(`/inventory/stock/${r.product_id}`)}>
                        <TableCell className="font-medium text-primary">{r.sku}</TableCell>
                        <TableCell className="min-w-48 whitespace-normal"><span className="flex items-center gap-2"><ProductThumb size="xs" src={rowImages.get(r.product_id)} alt={r.product_name} preview={false} />{r.product_name}</span></TableCell>
                        <TableCell className="text-muted-foreground">{r.category_name ?? '—'}</TableCell>
                        <TableCell>{r.base_unit}</TableCell>
                        <TableCell>{PRODUCT_TYPE_LABELS[r.product_type as keyof typeof PRODUCT_TYPE_LABELS] ?? r.product_type}</TableCell>
                        <TableCell><StockSourceBadge source={r.source_type} /></TableCell>
                        <TableCell>{r.warehouse_code}</TableCell>
                        <TableCell>
                          {r.location_code}
                          {r.location_status !== 'ACTIVE' && <span className="ml-1 text-xs text-shortage">(inactive)</span>}
                        </TableCell>
                        <TableCell>{r.batch_number ?? '—'}{r.expiry_date && <span className="block text-xs text-muted-foreground">exp {r.expiry_date}</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatQty(r.on_hand)}<FractionFlag values={[r.on_hand, r.reserved]} unit={r.base_unit} /></TableCell>
                        <TableCell className="text-right tabular-nums text-amber-800">{formatQty(r.reserved)}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums text-green-700">{formatQty(r.available)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{r.reorder_level === null ? '—' : formatQty(r.reorder_level)}</TableCell>
                        <TableCell>{statusLookup.data?.get(r.product_id) ? <StockStatusBadge status={statusLookup.data.get(r.product_id)!} /> : '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{r.last_movement_at ? formatDateTime(r.last_movement_at) : '—'}</TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
            <PaginationBar page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={setPageSize} disabled={list.loading} />
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">
        Quantities are shown in each product's own unit and are never added across different units. Stock status: Out of stock = nothing on hand;
        Low = days of cover at or below the product's Reorder Level (Days), or available at or below an earlier reorder quantity (Reorder qty); Fully reserved = on hand but nothing available. Detail rows show the product-level status. Days of cover, lead times and suggested order quantities are under <Link className="text-primary hover:underline" to="/inventory/alerts?tab=planning">Reorder planning</Link>.
      </p>
    </>
  )
}
