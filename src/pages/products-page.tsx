import {
  Archive,
  ArchiveRestore,
  Blend,
  Download,
  Eye,
  Factory,
  FileSpreadsheet,
  FolderTree,
  Loader2,
  MoreHorizontal,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  SearchX,
  Truck,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { SortableHead } from '@/components/common/sortable-head'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ProductSourceBadge, ProductStatusBadge } from '@/features/products/product-badges'
import { productExportRows } from '@/features/products/product-export'
import { PRODUCT_TYPES, PRODUCT_TYPE_LABELS, SOURCE_TYPES, SOURCE_TYPE_LABELS, type ProductType, type SourceType } from '@/features/products/product-model'
import { DrillBanner } from '@/features/drilldown/drill-banner'
import { contextFromParams, DASHBOARDS, METRICS, type DashboardKey } from '@/features/drilldown/drill-registry'
import { useCompanyClock } from '@/features/drilldown/use-drill'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatNumber, toIsoDate } from '@/lib/format'
import {
  fetchProductKpis,
  listAllProducts,
  listCategories,
  listProducts,
  setProductArchived,
  setProductStatus,
  type ProductListParams,
  type ProductSortColumn,
  type ProductStatusFilter,
} from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'
import type { ProductRow } from '@/types/database'

type BoolFilter = 'any' | 'yes' | 'no'
const toBool = (v: BoolFilter) => (v === 'any' ? null : v === 'yes')

type PendingAction = { product: ProductRow; kind: 'activate' | 'deactivate' | 'archive' | 'unarchive' }

const ACTION_COPY: Record<PendingAction['kind'], { title: string; body: string; confirm: string; destructive: boolean }> = {
  activate: { title: 'Activate product?', body: 'The product becomes available for new transactions again.', confirm: 'Activate', destructive: false },
  deactivate: {
    title: 'Deactivate product?',
    body: 'The product will no longer be offered for new transactions. All history and references are kept.',
    confirm: 'Deactivate',
    destructive: true,
  },
  archive: {
    title: 'Archive product?',
    body: 'Archived products are hidden from the default list but never deleted, so historical references stay intact. You can restore it later.',
    confirm: 'Archive',
    destructive: true,
  },
  unarchive: { title: 'Restore from archive?', body: 'The product returns to the list as inactive. Activate it separately if needed.', confirm: 'Restore', destructive: false },
}

export default function ProductsPage() {
  const navigate = useNavigate()
  const { has } = usePermissions()

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search)
  const [categoryId, setCategoryId] = useState<string>('all')
  const [sourceType, setSourceType] = useState<SourceType | 'all'>('all')
  const [productType, setProductType] = useState<ProductType | 'all'>('all')
  const [status, setStatus] = useState<ProductStatusFilter>('current')
  const [manufacturable, setManufacturable] = useState<BoolFilter>('any')
  const [hasBom, setHasBom] = useState<BoolFilter>('any')
  const [sort, setSort] = useState<{ column: ProductSortColumn; ascending: boolean }>({ column: 'sku', ascending: true })
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [refreshKey, setRefreshKey] = useState(0)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [exporting, setExporting] = useState(false)

  // Opened from a dashboard figure (?drill=…): that figure's rule is applied on top of the filters below.
  const [urlParams, setUrlParams] = useSearchParams()
  const clock = useCompanyClock()
  const drillKey = urlParams.get('drill')
  const drillMetric = drillKey && METRICS[drillKey]?.target === 'products' ? METRICS[drillKey] : null
  const drillCtx = useMemo(() => contextFromParams(urlParams, clock), [urlParams, clock])
  const drill = useMemo(() => (drillMetric ? drillMetric.conditions(drillCtx) : null), [drillMetric, drillCtx])
  const via = urlParams.get('via') as DashboardKey | null
  const clearDrill = () => setUrlParams(new URLSearchParams(), { replace: true })

  const filters = useMemo<Omit<ProductListParams, 'page' | 'pageSize'>>(
    () => ({
      search: debouncedSearch,
      categoryId: categoryId === 'all' ? null : categoryId,
      sourceType: sourceType === 'all' ? null : sourceType,
      productType: productType === 'all' ? null : productType,
      status,
      manufacturable: toBool(manufacturable),
      hasBom: toBool(hasBom),
      sort,
      drill,
    }),
    [debouncedSearch, categoryId, sourceType, productType, status, manufacturable, hasBom, sort, drill],
  )

  // Any filter change returns to the first page.
  const [lastFilters, setLastFilters] = useState(filters)
  if (lastFilters !== filters) {
    setLastFilters(filters)
    setPage(0)
  }

  const list = useAsync(() => listProducts({ ...filters, page, pageSize }), [filters, page, pageSize, refreshKey])
  const kpis = useAsync(fetchProductKpis, [refreshKey])
  const categories = useAsync(listCategories, [refreshKey])

  const categoryName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data])
  const filtersActive =
    search !== '' || categoryId !== 'all' || sourceType !== 'all' || productType !== 'all' || status !== 'current' || manufacturable !== 'any' || hasBom !== 'any'

  const clearFilters = () => {
    setSearch('')
    setCategoryId('all')
    setSourceType('all')
    setProductType('all')
    setStatus('current')
    setManufacturable('any')
    setHasBom('any')
  }

  const refresh = () => setRefreshKey((k) => k + 1)

  const runAction = async ({ product, kind }: PendingAction) => {
    setNotice(null)
    try {
      if (kind === 'activate') await setProductStatus(product.id, 'ACTIVE')
      if (kind === 'deactivate') await setProductStatus(product.id, 'INACTIVE')
      if (kind === 'archive') await setProductArchived(product.id, true)
      if (kind === 'unarchive') await setProductArchived(product.id, false)
      setNotice({ tone: 'success', text: `${product.sku}: ${ACTION_COPY[kind].confirm.toLowerCase()} completed.` })
      refresh()
    } catch (error) {
      setNotice({ tone: 'error', text: describeDataError(error) })
    }
  }

  const exportProducts = async (format: 'xlsx' | 'csv') => {
    setExporting(true)
    setNotice(null)
    try {
      const [{ downloadSheets }, rows, suppliers] = await Promise.all([
        import('@/features/products/spreadsheet'), listAllProducts(filters), fetchSupplierOptions(true).catch(() => []),
      ])
      const supplierCodes = new Map(suppliers.map((s) => [s.id, s.supplier_code]))
      await downloadSheets([{ name: 'Products', rows: productExportRows(rows, categories.data ?? [], supplierCodes) }], `products-${toIsoDate(new Date())}`, format)
      setNotice({ tone: 'success', text: `Exported ${formatNumber(rows.length)} products matching the current filters.` })
    } catch (error) {
      setNotice({ tone: 'error', text: describeDataError(error) })
    } finally {
      setExporting(false)
    }
  }

  const rows = list.data?.rows ?? []
  const total = list.data?.total ?? 0
  const catalogueEmpty = kpis.data?.total === 0

  return (
    <>
      <PageHeader
        title="Product Master"
        description="Manage product information, SKUs, sourcing and classification."
        actions={
          <>
            <Button variant="outline" size="icon" onClick={refresh} aria-label="Refresh" title="Refresh">
              <RefreshCw className={list.loading ? 'animate-spin' : undefined} />
            </Button>
            <Button variant="outline" asChild>
              <Link to="/products/categories">
                <FolderTree />
                Categories
              </Link>
            </Button>
            <PermissionGate permission="products.export">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" disabled={exporting || total === 0}>
                    {exporting ? <Loader2 className="animate-spin" /> : <Download />}
                    Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Exports the current filtered list</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => void exportProducts('xlsx')}>
                    <FileSpreadsheet />
                    Excel (.xlsx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportProducts('csv')}>
                    <FileSpreadsheet />
                    CSV
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </PermissionGate>
            {has('products.import') && has('products.create') && (
              <Button variant="outline" asChild>
                <Link to="/products/import">
                  <FileSpreadsheet />
                  Import from Excel
                </Link>
              </Button>
            )}
            <PermissionGate permission="products.create">
              <Button asChild>
                <Link to="/products/new">
                  <Plus />
                  Add Product
                </Link>
              </Button>
            </PermissionGate>
          </>
        }
      />
      {drillMetric && <DrillBanner metric={drillMetric} ctx={drillCtx} via={via && via in DASHBOARDS ? via : null} total={list.data ? total : null} onClear={clearDrill} />}

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={
            notice.tone === 'error'
              ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800'
              : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'
          }
        >
          {notice.text}
        </div>
      )}

      <section aria-label="Product summary" className="mb-6">
        {kpis.loading && !kpis.data ? (
          <LoadingState variant="cards" rows={4} />
        ) : kpis.error ? (
          <Card>
            <ErrorState compact message={describeDataError(kpis.error)} onRetry={kpis.reload} />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
            <KpiCard
              label="Total Active Products"
              value={formatNumber(kpis.data?.active ?? 0)}
              hint={`${formatNumber(kpis.data?.in_house ?? 0)} in-house · ${formatNumber(kpis.data?.outsourced ?? 0)} outsourced · ${formatNumber(kpis.data?.hybrid ?? 0)} hybrid · ${formatNumber(kpis.data?.inactive ?? 0)} inactive`}
              icon={PackageCheck}
              accent="available"
            />
            <KpiCard label="Finished Goods" value={formatNumber(kpis.data?.finished_goods ?? 0)} hint={`${formatNumber(kpis.data?.subassemblies ?? 0)} subassemblies`} icon={Factory} accent="manufacturing" />
            <KpiCard label="Raw Materials" value={formatNumber(kpis.data?.raw_materials ?? 0)} hint={`${formatNumber(kpis.data?.packaging ?? 0)} packing · ${formatNumber(kpis.data?.consumables ?? 0)} consumables`} icon={Package} accent="neutral" />
            <KpiCard label="Components" value={formatNumber(kpis.data?.components ?? 0)} hint={`${formatNumber(kpis.data?.outsourced_components ?? 0)} outsourced components`} icon={Truck} accent="outsourced" />
            <button type="button" className="rounded-xl text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              title="Show finished goods without a BOM" onClick={() => { setProductType('FINISHED_GOOD'); setHasBom('no') }}>
              <KpiCard label="Without BOM" value={formatNumber(kpis.data?.without_bom ?? 0)} hint="Finished goods & subassemblies" icon={Blend} accent={(kpis.data?.without_bom ?? 0) > 0 ? 'pending' : 'neutral'} className="h-full" />
            </button>
            <KpiCard label="Missing Information" value={formatNumber(kpis.data?.incomplete ?? 0)} hint="No HSN, GST, category or price/cost" icon={Search} accent={(kpis.data?.incomplete ?? 0) > 0 ? 'pending' : 'neutral'} />
          </div>
        )}
      </section>

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative w-full lg:max-w-sm">
              <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SKU, name, barcode, EAN, model, brand, supplier model…"
                aria-label="Search products"
                className="pr-8 pl-9"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
            <FilterTabs<ProductStatusFilter>
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'current', label: 'All current' },
                { value: 'active', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
                { value: 'archived', label: 'Archived' },
                { value: 'all', label: 'Everything' },
              ]}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-48" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                <SelectItem value="none">Uncategorised</SelectItem>
                {(categories.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {!c.is_active && ' (inactive)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sourceType} onValueChange={(v) => setSourceType(v as SourceType | 'all')}>
              <SelectTrigger className="w-40" aria-label="Source type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {SOURCE_TYPES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SOURCE_TYPE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={productType} onValueChange={(v) => setProductType(v as ProductType | 'all')}>
              <SelectTrigger className="w-44" aria-label="Product type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All product types</SelectItem>
                {PRODUCT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {PRODUCT_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={manufacturable} onValueChange={(v) => setManufacturable(v as BoolFilter)}>
              <SelectTrigger className="w-44" aria-label="Manufacturable">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Manufacturable: any</SelectItem>
                <SelectItem value="yes">Manufacturable: yes</SelectItem>
                <SelectItem value="no">Manufacturable: no</SelectItem>
              </SelectContent>
            </Select>
            <Select value={hasBom} onValueChange={(v) => setHasBom(v as BoolFilter)}>
              <SelectTrigger className="w-36" aria-label="Has BOM">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">BOM: any</SelectItem>
                <SelectItem value="yes">BOM: yes</SelectItem>
                <SelectItem value="no">BOM: no</SelectItem>
              </SelectContent>
            </Select>
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X />
                Clear filters
              </Button>
            )}
          </div>
        </div>

        {list.loading && !list.data ? (
          <LoadingState variant="table" rows={6} />
        ) : list.error ? (
          <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          catalogueEmpty && !filtersActive ? (
            <EmptyState
              icon={Package}
              title="No products yet"
              description="Add products one at a time or import them from an Excel file. Nothing is pre-filled: the catalogue starts empty."
              action={
                <>
                  {has('products.import') && has('products.create') && (
                    <Button variant="outline" asChild>
                      <Link to="/products/import">
                        <FileSpreadsheet />
                        Import from Excel
                      </Link>
                    </Button>
                  )}
                  <PermissionGate permission="products.create">
                    <Button asChild>
                      <Link to="/products/new">
                        <Plus />
                        Add Product
                      </Link>
                    </Button>
                  </PermissionGate>
                </>
              }
            />
          ) : (
            <EmptyState
              icon={SearchX}
              title="No products match"
              description="Try a different search term or clear the filters."
              action={
                <Button variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          )
        ) : (
          <div className={list.loading ? 'opacity-60 transition-opacity' : undefined} aria-busy={list.loading}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableHead column="sku" label="SKU" sort={sort} onSort={setSort} />
                  <SortableHead column="product_name" label="Product" sort={sort} onSort={setSort} />
                  <TableHead>Category</TableHead>
                  <SortableHead column="product_type" label="Type" sort={sort} onSort={setSort} />
                  <SortableHead column="default_source_type" label="Source" sort={sort} onSort={setSort} />
                  <TableHead>Unit</TableHead>
                  <TableHead>HSN / GST</TableHead>
                  <TableHead className="text-right">MRP</TableHead>
                  <SortableHead column="selling_price" label="Selling Price" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="status" label="Status" sort={sort} onSort={setSort} />
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <Link to={`/products/${p.id}`} className="font-medium text-primary hover:underline">
                        {p.sku}
                      </Link>
                      {p.ean && <p className="text-xs text-muted-foreground tabular-nums" title="EAN">EAN {p.ean}</p>}
                    </TableCell>
                    <TableCell className="min-w-48 max-w-72 whitespace-normal">
                      <p className="font-medium">{p.product_name}</p>
                      {(p.brand || p.model_number) && (
                        <p className="text-xs text-muted-foreground">{[p.brand, p.model_number].filter(Boolean).join(' · ')}</p>
                      )}
                      {(p.supplier_model_number || p.supplier_product_name) && (
                        <p className="text-xs text-muted-foreground">Supplier: {[p.supplier_model_number, p.supplier_product_name].filter(Boolean).join(' · ')}</p>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.category_id ? (categoryName.get(p.category_id) ?? '—') : '—'}</TableCell>
                    <TableCell>{PRODUCT_TYPE_LABELS[p.product_type]}</TableCell>
                    <TableCell>
                      <ProductSourceBadge source={p.default_source_type} />
                    </TableCell>
                    <TableCell>{p.base_unit}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.hsn_code ?? '—'}
                      {p.gst_rate !== null && <span> · {Number(p.gst_rate)}%</span>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{p.mrp === null || p.mrp === undefined ? '—' : formatCurrency(Number(p.mrp))}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.selling_price === null ? '—' : formatCurrency(Number(p.selling_price))}</TableCell>
                    <TableCell>
                      <ProductStatusBadge product={p} />
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions product={p} onView={() => navigate(`/products/${p.id}`)} onEdit={() => navigate(`/products/${p.id}/edit`)} onAction={setPending} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <PaginationBar
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size)
                setPage(0)
              }}
              disabled={list.loading}
            />
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={pending ? ACTION_COPY[pending.kind].title : ''}
        description={pending ? `${pending.product.sku} — ${pending.product.product_name}. ${ACTION_COPY[pending.kind].body}` : ''}
        confirmLabel={pending ? ACTION_COPY[pending.kind].confirm : 'Confirm'}
        destructive={pending ? ACTION_COPY[pending.kind].destructive : false}
        onConfirm={() => pending && void runAction(pending)}
      />
    </>
  )
}

function RowActions({
  product,
  onView,
  onEdit,
  onAction,
}: {
  product: ProductRow
  onView: () => void
  onEdit: () => void
  onAction: (action: PendingAction) => void
}) {
  const { has } = usePermissions()
  const archived = Boolean(product.archived_at)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${product.sku}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onView}>
          <Eye />
          View
        </DropdownMenuItem>
        {has('products.update') && !archived && (
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            Edit
          </DropdownMenuItem>
        )}
        {has('products.archive') && (
          <>
            <DropdownMenuSeparator />
            {!archived && product.status === 'INACTIVE' && (
              <DropdownMenuItem onSelect={() => onAction({ product, kind: 'activate' })}>
                <Power />
                Activate
              </DropdownMenuItem>
            )}
            {!archived && product.status === 'ACTIVE' && (
              <DropdownMenuItem onSelect={() => onAction({ product, kind: 'deactivate' })}>
                <PowerOff />
                Deactivate
              </DropdownMenuItem>
            )}
            {!archived && product.status === 'INACTIVE' && (
              <DropdownMenuItem onSelect={() => onAction({ product, kind: 'archive' })}>
                <Archive />
                Archive
              </DropdownMenuItem>
            )}
            {archived && (
              <DropdownMenuItem onSelect={() => onAction({ product, kind: 'unarchive' })}>
                <ArchiveRestore />
                Restore from archive
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
