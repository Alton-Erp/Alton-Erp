import {
  AlertTriangle,
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
  Trash2,
  Truck,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
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
import { BulkDeleteDialog, type SelectedProduct } from '@/features/products/bulk-delete-dialog'
import { ProductSourceBadge, ProductStatusBadge } from '@/features/products/product-badges'
import { duplicateText, type BulkDeleteResult, type DuplicateHint } from '@/features/products/product-bulk-delete'
import { productExportRows } from '@/features/products/product-export'
import { PRODUCT_TYPES, PRODUCT_TYPE_LABELS, SOURCE_TYPES, SOURCE_TYPE_LABELS, type ProductType, type SourceType } from '@/features/products/product-model'
import { DrillBanner } from '@/features/drilldown/drill-banner'
import { contextFromParams, DASHBOARDS, METRICS, type DashboardKey } from '@/features/drilldown/drill-registry'
import { useCompanyClock, useDrill } from '@/features/drilldown/use-drill'
import { formatCost, formatMrp, gstText, hsnText } from '@/features/products/product-list-format'
import { missingInfo } from '@/features/products/product-missing-info'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import {
  fetchDuplicateHints,
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
const BOOL_FILTERS: readonly BoolFilter[] = ['any', 'yes', 'no']
const STATUS_FILTERS: readonly ProductStatusFilter[] = ['current', 'active', 'inactive', 'archived', 'all']
const SORT_COLUMNS: readonly ProductSortColumn[] = ['sku', 'product_name', 'product_type', 'default_source_type', 'status', 'selling_price', 'updated_at',
  'standard_manufacturing_cost', 'mrp', 'hsn_code', 'gst_rate', 'base_unit']
const PAGE_SIZES = [10, 25, 50, 100]
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
  const { has, hasRole } = usePermissions()

  // Filters, sort and page live in the address, so Back from a product returns to the same list.
  const [urlParams, setUrlParams] = useSearchParams()
  const setParams = useCallback((changes: Record<string, string | null>, keepPage = false) => {
    setUrlParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      // Any filter change returns to the first page.
      if (!keepPage) next.delete('page')
      return next
    }, { replace: true })
  }, [setUrlParams])
  const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const v = urlParams.get(name)
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
  }
  const q = urlParams.get('q') ?? ''
  const [search, setSearch] = useState(q)
  const debouncedSearch = useDebouncedValue(search)
  useEffect(() => {
    if (debouncedSearch !== q) setParams({ q: debouncedSearch.trim() ? debouncedSearch : null })
    // Only when the typed text settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch])
  const categoryId = urlParams.get('category') || 'all'
  const sourceType = pick<SourceType | 'all'>('source', [...SOURCE_TYPES, 'all'], 'all')
  const productType = pick<ProductType | 'all'>('type', [...PRODUCT_TYPES, 'all'], 'all')
  const status = pick<ProductStatusFilter>('status', STATUS_FILTERS, 'current')
  const manufacturable = pick<BoolFilter>('mfg', BOOL_FILTERS, 'any')
  const hasBom = pick<BoolFilter>('bom', BOOL_FILTERS, 'any')
  const sortParam = urlParams.get('sort') ?? 'sku'
  const sortName = sortParam.replace(/^-/, '')
  const sortColumn: ProductSortColumn = (SORT_COLUMNS as readonly string[]).includes(sortName) ? (sortName as ProductSortColumn) : 'sku'
  const sort = useMemo(() => ({ column: sortColumn, ascending: !sortParam.startsWith('-') }), [sortColumn, sortParam])
  const page = Math.max(0, (Number(urlParams.get('page')) || 1) - 1)
  const pageSize = PAGE_SIZES.includes(Number(urlParams.get('size'))) ? Number(urlParams.get('size')) : 25
  const setCategoryId = (v: string) => setParams({ category: v === 'all' ? null : v })
  const setSourceType = (v: SourceType | 'all') => setParams({ source: v === 'all' ? null : v })
  const setProductType = (v: ProductType | 'all') => setParams({ type: v === 'all' ? null : v })
  const setStatus = (v: ProductStatusFilter) => setParams({ status: v === 'current' ? null : v })
  const setManufacturable = (v: BoolFilter) => setParams({ mfg: v === 'any' ? null : v })
  const setHasBom = (v: BoolFilter) => setParams({ bom: v === 'any' ? null : v })
  const setSort = (s: { column: ProductSortColumn; ascending: boolean }) => setParams({ sort: s.column === 'sku' && s.ascending ? null : `${s.ascending ? '' : '-'}${s.column}` })
  const setPage = (p: number) => setParams({ page: p > 0 ? String(p + 1) : null }, true)
  const setPageSize = (n: number) => setParams({ size: n === 25 ? null : String(n) })
  const [refreshKey, setRefreshKey] = useState(0)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [exporting, setExporting] = useState(false)

  // Opened from a figure (?drill=…: a Product Master card or a dashboard figure): its rule is applied on top of the filters.
  const clock = useCompanyClock()
  const { href } = useDrill('product_master')
  const drillKey = urlParams.get('drill')
  const drillMetric = drillKey && METRICS[drillKey]?.target === 'products' ? METRICS[drillKey] : null
  const drillCtx = useMemo(() => contextFromParams(urlParams, clock), [urlParams, clock])
  const drill = useMemo(() => (drillMetric ? drillMetric.conditions(drillCtx) : null), [drillMetric, drillCtx])
  const via = urlParams.get('via') as DashboardKey | null
  // Removes the figure's rule only; the list's own filters stay.
  const clearDrill = () => setParams({ drill: null, via: null, from: null, to: null, today: null, tz: null, seg: null, sf: null, st: null, unit: null })
  const missingView = drillKey === 'pm.incomplete'

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

  const list = useAsync(() => listProducts({ ...filters, page, pageSize }), [filters, page, pageSize, refreshKey])
  const kpis = useAsync(fetchProductKpis, [refreshKey])
  const categories = useAsync(listCategories, [refreshKey])

  const categoryName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, c.name])), [categories.data])
  const filtersActive =
    search !== '' || categoryId !== 'all' || sourceType !== 'all' || productType !== 'all' || status !== 'current' || manufacturable !== 'any' || hasBom !== 'any'

  const clearFilters = () => {
    setSearch('')
    setParams({ q: null, category: null, source: null, type: null, status: null, mfg: null, bom: null })
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

  // Missing Information: a Super Admin can select products (kept across pages) and delete the never-used ones.
  const bulkMode = missingView && hasRole('SUPER_ADMIN')
  const [selected, setSelected] = useState<Map<string, SelectedProduct>>(() => new Map())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [selectingAll, setSelectingAll] = useState(false)
  const filterKey = JSON.stringify(filters)
  // Another filter or view is another result set: the selection starts again.
  useEffect(() => setSelected(new Map()), [filterKey, bulkMode])
  const pick1 = (p: ProductRow): SelectedProduct => ({ id: p.id, sku: p.sku, product_name: p.product_name })
  const toggle = (p: ProductRow, on: boolean) => setSelected((prev) => {
    const next = new Map(prev)
    if (on) next.set(p.id, pick1(p))
    else next.delete(p.id)
    return next
  })
  const pageSelected = rows.filter((p) => selected.has(p.id)).length
  const headerState: boolean | 'indeterminate' = rows.length > 0 && pageSelected === rows.length ? true : pageSelected > 0 ? 'indeterminate' : false
  const togglePage = (on: boolean) => setSelected((prev) => {
    const next = new Map(prev)
    for (const p of rows) {
      if (on) next.set(p.id, pick1(p))
      else next.delete(p.id)
    }
    return next
  })
  const MAX_BULK = 1000
  const selectAllMatching = async () => {
    setSelectingAll(true)
    setNotice(null)
    try {
      const all = await listAllProducts(filters)
      setSelected(new Map(all.slice(0, MAX_BULK).map((p) => [p.id, pick1(p)])))
      if (all.length > MAX_BULK) setNotice({ tone: 'error', text: `Only the first ${formatNumber(MAX_BULK)} of ${formatNumber(all.length)} products were selected (at most ${formatNumber(MAX_BULK)} at a time).` })
    } catch (error) {
      setNotice({ tone: 'error', text: describeDataError(error) })
    } finally {
      setSelectingAll(false)
    }
  }
  const afterBulkDelete = (r: BulkDeleteResult) => {
    if (r.status !== 'COMPLETED') return
    // Deleted and archived products leave the list; the protected ones stay selected for another look.
    setSelected((prev) => {
      const next = new Map(prev)
      for (const d of r.deleted) next.delete(d.id)
      for (const b of r.blocked) if (b.archived_now) next.delete(b.id)
      for (const id of r.not_found) next.delete(id)
      return next
    })
    refresh()
  }
  // A page that no longer exists after a delete shows the last page instead.
  useEffect(() => {
    if (list.data && page > 0 && page * pageSize >= list.data.total) setPage(Math.max(0, Math.ceil(list.data.total / pageSize) - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data, page, pageSize])
  const pageIds = rows.map((p) => p.id).join(',')
  const hints = useAsync(() => (bulkMode && pageIds ? fetchDuplicateHints(pageIds.split(',')) : Promise.resolve([] as DuplicateHint[])), [bulkMode, pageIds, refreshKey])
  const hintsByProduct = useMemo(() => {
    const m = new Map<string, DuplicateHint[]>()
    for (const h of hints.data ?? []) m.set(h.product_id, [...(m.get(h.product_id) ?? []), h])
    return m
  }, [hints.data])

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
              to={href('pm.active')}
              active={drillKey === 'pm.active'}
              testId="pm-card-active"
              label="Total Active Products"
              value={formatNumber(kpis.data?.active ?? 0)}
              hint={`${formatNumber(kpis.data?.in_house ?? 0)} in-house · ${formatNumber(kpis.data?.outsourced ?? 0)} outsourced · ${formatNumber(kpis.data?.hybrid ?? 0)} hybrid · ${formatNumber(kpis.data?.inactive ?? 0)} inactive`}
              icon={PackageCheck}
              accent="available"
            />
            <KpiCard to={href('pm.finished_goods')} active={drillKey === 'pm.finished_goods'} label="Finished Goods" value={formatNumber(kpis.data?.finished_goods ?? 0)} hint={`${formatNumber(kpis.data?.subassemblies ?? 0)} subassemblies`} icon={Factory} accent="manufacturing" />
            <KpiCard to={href('pm.raw_materials')} active={drillKey === 'pm.raw_materials'} label="Raw Materials" value={formatNumber(kpis.data?.raw_materials ?? 0)} hint={`${formatNumber(kpis.data?.packaging ?? 0)} packing · ${formatNumber(kpis.data?.consumables ?? 0)} consumables`} icon={Package} accent="neutral" />
            <KpiCard to={href('pm.components')} active={drillKey === 'pm.components'} label="Components" value={formatNumber(kpis.data?.components ?? 0)} hint={`${formatNumber(kpis.data?.outsourced_components ?? 0)} outsourced components`} icon={Truck} accent="outsourced" />
            <KpiCard to={href('pm.without_bom')} active={drillKey === 'pm.without_bom'} label="Without BOM" value={formatNumber(kpis.data?.without_bom ?? 0)} hint="Finished goods & subassemblies" icon={Blend} accent={(kpis.data?.without_bom ?? 0) > 0 ? 'pending' : 'neutral'} />
            <KpiCard to={href('pm.incomplete')} active={missingView} testId="pm-card-incomplete" label="Missing Information" value={formatNumber(kpis.data?.incomplete ?? 0)} hint="No HSN, GST, category or price/cost" icon={Search} accent={(kpis.data?.incomplete ?? 0) > 0 ? 'pending' : 'neutral'} />
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
                { value: 'current', label: 'All current', count: kpis.data ? kpis.data.active + kpis.data.inactive : undefined },
                { value: 'active', label: 'Active', count: kpis.data?.active },
                { value: 'inactive', label: 'Inactive', count: kpis.data?.inactive },
                { value: 'archived', label: 'Archived', count: kpis.data?.archived },
                { value: 'all', label: 'Everything', count: kpis.data?.total },
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
            {bulkMode && (
              <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5 text-sm" data-testid="bulk-bar">
                <span className="font-medium tabular-nums" data-testid="bulk-count">{formatNumber(selected.size)} {selected.size === 1 ? 'product' : 'products'} selected</span>
                <span aria-hidden className="text-muted-foreground">|</span>
                <Button size="sm" variant="destructive" disabled={selected.size === 0} onClick={() => setBulkOpen(true)} data-testid="bulk-delete">
                  <Trash2 />
                  Delete Selected{selected.size > 0 ? ` (${formatNumber(selected.size)})` : ''}
                </Button>
                {selected.size < Math.min(total, MAX_BULK) && (
                  <Button size="sm" variant="outline" onClick={() => void selectAllMatching()} disabled={selectingAll}>
                    {selectingAll && <Loader2 className="animate-spin" />}
                    Select all {formatNumber(total)} matching
                  </Button>
                )}
                {selected.size > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
                    <X />
                    Clear selection
                  </Button>
                )}
                <span className="w-full text-xs text-muted-foreground sm:ml-auto sm:w-auto">Only products never used in any transaction are deleted; the others are protected.</span>
              </div>
            )}
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {bulkMode && (
                    <TableHead className="w-10">
                      <Checkbox checked={headerState} onCheckedChange={(v) => togglePage(v === true)} aria-label="Select All" title="Select All (this page)" data-testid="select-all" />
                    </TableHead>
                  )}
                  <SortableHead column="product_name" label="Product Name" sort={sort} onSort={setSort} />
                  <SortableHead column="sku" label="SKU" sort={sort} onSort={setSort} />
                  <TableHead>Category</TableHead>
                  <SortableHead column="standard_manufacturing_cost" label="Cost" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="mrp" label="MRP" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="hsn_code" label="HSN" sort={sort} onSort={setSort} />
                  <SortableHead column="gst_rate" label="GST" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="base_unit" label="Unit" sort={sort} onSort={setSort} />
                  <SortableHead column="status" label="Status" sort={sort} onSort={setSort} />
                  {missingView && <TableHead>Missing information</TableHead>}
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={p.id} data-state={selected.has(p.id) ? 'selected' : undefined}>
                    {bulkMode && (
                      <TableCell className="w-10">
                        <Checkbox checked={selected.has(p.id)} onCheckedChange={(v) => toggle(p, v === true)} aria-label={`Select ${p.sku}`} data-testid="select-row" data-sku={p.sku} />
                      </TableCell>
                    )}
                    <TableCell className="min-w-48 max-w-72 whitespace-normal">
                      <p className="font-medium">{p.product_name}</p>
                      {bulkMode && (hintsByProduct.get(p.id) ?? []).length > 0 && (
                        <p className="mt-0.5 flex flex-wrap gap-1" data-testid="dup-hints">
                          {hintsByProduct.get(p.id)!.map((h) => (
                            <span key={h.kind} className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-900" data-kind={h.kind}>
                              <AlertTriangle aria-hidden className="size-3" /> {duplicateText(h)}
                            </span>
                          ))}
                        </p>
                      )}
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {PRODUCT_TYPE_LABELS[p.product_type]} <ProductSourceBadge source={p.default_source_type} />
                      </p>
                      {(p.brand || p.model_number) && (
                        <p className="text-xs text-muted-foreground">{[p.brand, p.model_number].filter(Boolean).join(' · ')}</p>
                      )}
                      {(p.supplier_model_number || p.supplier_product_name) && (
                        <p className="text-xs text-muted-foreground">Supplier: {[p.supplier_model_number, p.supplier_product_name].filter(Boolean).join(' · ')}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Link to={`/products/${p.id}`} className="font-medium text-primary hover:underline">
                        {p.sku}
                      </Link>
                      {p.ean && <p className="text-xs text-muted-foreground tabular-nums" title="EAN">EAN {p.ean}</p>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.category_id ? (categoryName.get(p.category_id) ?? '—') : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums" data-col="cost">{formatCost(p.standard_manufacturing_cost)}</TableCell>
                    <TableCell className="text-right tabular-nums" data-col="mrp">{formatMrp(p.mrp)}</TableCell>
                    <TableCell className="tabular-nums" data-col="hsn">{hsnText(p.hsn_code) ?? <MissingValue />}</TableCell>
                    <TableCell className="text-right tabular-nums" data-col="gst">{gstText(p.gst_rate) ?? <MissingValue />}</TableCell>
                    <TableCell>{p.base_unit}</TableCell>
                    <TableCell>
                      <ProductStatusBadge product={p} />
                    </TableCell>
                    {missingView && (() => {
                      const c = missingInfo(p)
                      return (
                        <TableCell className="min-w-48 whitespace-normal" data-testid="pm-missing">
                          <p className="text-sm text-amber-800">{c.missing.join(', ') || 'Nothing missing'}</p>
                          <p className="text-xs text-muted-foreground">{c.done} of {c.total} complete ({c.percent}%) · <Link className="text-primary hover:underline" to={`/products/${p.id}/edit`}>Complete it</Link></p>
                        </TableCell>
                      )
                    })()}
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

      {bulkMode && (
        <BulkDeleteDialog open={bulkOpen} onOpenChange={setBulkOpen} selected={selected} onFinished={afterBulkDelete} />
      )}

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

/** A required value that is not entered yet (HSN, GST): shown, not hidden. */
function MissingValue() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700" title="Not entered yet">
      <AlertTriangle aria-hidden className="size-3.5" /> Missing
    </span>
  )
}
