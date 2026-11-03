import { Download, FileChartColumn, Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { PermissionGate } from '@/auth/permission-gate'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ADJUSTMENT_REASONS, APPROVAL_STATUS_LABELS, RESERVATION_STATUS_LABELS, STOCK_SOURCE_LABELS, STOCK_STATUS_LABELS, TRANSACTION_TYPE_LABELS, formatQty } from '@/features/inventory/inventory-model'
import type { CellValue } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  fetchAdjustments,
  fetchAllCountLines,
  fetchAllMovements,
  fetchAllProductStock,
  fetchAllStockDetail,
  fetchInventoryOverview,
  fetchInventoryPolicy,
  fetchOpeningLines,
  fetchReservations,
  fetchStockAsOf,
  fetchValuation,
} from '@/services/inventory'
import type { DateRangeValue } from '@/types'

type Value = string | number | null
type ReportRow = Record<string, unknown>

interface ReportColumn {
  id: string
  header: string
  value: (row: ReportRow) => Value
  render?: (row: ReportRow) => ReactNode
  align?: 'left' | 'right'
}

interface ReportResult {
  rows: ReportRow[]
  columns: ReportColumn[]
  summary?: ReactNode
}

interface ReportContext {
  range: DateRangeValue
  cutoff: string
}

interface ReportDef {
  key: string
  title: string
  description: string
  dates: 'none' | 'range' | 'cutoff'
  load: (ctx: ReportContext) => Promise<ReportResult>
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
const inRange = (iso: string | null | undefined, range: DateRangeValue) => {
  if (!iso) return false
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return d >= range.from && d <= range.to
}
const qtyCol = (id: string, header: string): ReportColumn => ({ id, header, align: 'right', value: (r) => n(r[id]), render: (r) => formatQty(n(r[id])) })
const allDetail = { search: '', productId: null, categoryId: null, productType: null, source: null, warehouseId: null, locationId: null }
const allProducts = { search: '', categoryId: null, productType: null, stockStatus: null, includeInactive: true }
const productCols: ReportColumn[] = [
  { id: 'sku', header: 'SKU', value: (r) => r.sku as string },
  { id: 'product_name', header: 'Product', value: (r) => r.product_name as string },
]

function groupSum<T extends ReportRow>(rows: T[], keys: string[], sums: string[]): ReportRow[] {
  const map = new Map<string, ReportRow>()
  for (const r of rows) {
    const k = keys.map((x) => String(r[x] ?? '')).join('|')
    const acc = map.get(k) ?? Object.fromEntries([...keys.map((x) => [x, r[x] ?? null]), ...sums.map((s) => [s, 0])])
    for (const s of sums) acc[s] = Number(acc[s]) + Number(r[s] ?? 0)
    map.set(k, acc)
  }
  return [...map.values()]
}

const REPORTS: ReportDef[] = [
  {
    key: 'summary',
    title: 'Current Stock Summary',
    description: 'Company totals per unit of measure (current position).',
    dates: 'none',
    load: async () => {
      const o = await fetchInventoryOverview()
      return {
        rows: o.units as unknown as ReportRow[],
        columns: [{ id: 'unit', header: 'Unit', value: (r) => r.unit as string }, qtyCol('on_hand', 'On hand'), qtyCol('reserved', 'Reserved'), qtyCol('available', 'Available'), qtyCol('in_house', 'In-house'), qtyCol('outsourced', 'Outsourced'), qtyCol('unknown', 'Unverified source')],
        summary: `${formatNumber(o.active_products)} active products · ${formatNumber(o.products_with_stock)} with stock · ${formatNumber(o.low_stock + o.fully_reserved)} low · ${formatNumber(o.out_of_stock)} out of stock. Quantities are never added across different units.`,
      }
    },
  },
  {
    key: 'by-product',
    title: 'Stock by Product',
    description: 'On hand, reserved and available per product, with status.',
    dates: 'none',
    load: async () => ({
      rows: (await fetchAllProductStock(allProducts)).filter((p) => !p.archived_at) as unknown as ReportRow[],
      columns: [...productCols, { id: 'category_name', header: 'Category', value: (r) => (r.category_name as string) ?? '' }, { id: 'base_unit', header: 'Unit', value: (r) => r.base_unit as string },
        qtyCol('on_hand', 'On hand'), qtyCol('reserved', 'Reserved'), qtyCol('available', 'Available'), qtyCol('reorder_level', 'Reorder level'),
        { id: 'stock_status', header: 'Status', value: (r) => STOCK_STATUS_LABELS[r.stock_status as string] }],
    }),
  },
  {
    key: 'by-category',
    title: 'Stock by Category',
    description: 'On hand per category and unit.',
    dates: 'none',
    load: async () => {
      const rows = (await fetchAllProductStock(allProducts)).filter((p) => !p.archived_at).map((p) => ({ ...p, category_name: p.category_name ?? 'Uncategorised' }))
      return {
        rows: groupSum(rows as unknown as ReportRow[], ['category_name', 'base_unit'], ['on_hand', 'reserved', 'available']),
        columns: [{ id: 'category_name', header: 'Category', value: (r) => r.category_name as string }, { id: 'base_unit', header: 'Unit', value: (r) => r.base_unit as string }, qtyCol('on_hand', 'On hand'), qtyCol('reserved', 'Reserved'), qtyCol('available', 'Available')],
      }
    },
  },
  {
    key: 'source',
    title: 'In-House versus Outsourced Stock',
    description: 'Actual source of current stock per product (from receipts/lots, not the product default).',
    dates: 'none',
    load: async () => ({
      rows: (await fetchAllProductStock(allProducts)).filter((p) => Number(p.on_hand) > 0) as unknown as ReportRow[],
      columns: [...productCols, { id: 'default_source_type', header: 'Default source', value: (r) => r.default_source_type as string }, { id: 'base_unit', header: 'Unit', value: (r) => r.base_unit as string },
        qtyCol('in_house_on_hand', 'In-house'), qtyCol('outsourced_on_hand', 'Outsourced'), qtyCol('unknown_source_on_hand', 'Unverified'), qtyCol('on_hand', 'Total')],
    }),
  },
  {
    key: 'location',
    title: 'Warehouse and Location Stock',
    description: 'Stock per warehouse, location and product.',
    dates: 'none',
    load: async () => ({
      rows: (await fetchAllStockDetail(allDetail)) as unknown as ReportRow[],
      columns: [{ id: 'warehouse_code', header: 'Warehouse', value: (r) => r.warehouse_code as string }, { id: 'location_code', header: 'Location', value: (r) => r.location_code as string }, ...productCols,
        { id: 'source_type', header: 'Source', value: (r) => STOCK_SOURCE_LABELS[r.source_type as 'IN_HOUSE'] }, { id: 'base_unit', header: 'Unit', value: (r) => r.base_unit as string }, qtyCol('on_hand', 'On hand'), qtyCol('reserved', 'Reserved'), qtyCol('available', 'Available')],
    }),
  },
  {
    key: 'batch',
    title: 'Batch / Lot Stock',
    description: 'Batch-tracked stock with manufacturing and expiry dates.',
    dates: 'none',
    load: async () => ({
      rows: (await fetchAllStockDetail(allDetail)).filter((r) => !r.is_system_lot) as unknown as ReportRow[],
      columns: [{ id: 'batch_number', header: 'Batch', value: (r) => r.batch_number as string }, ...productCols, { id: 'source_type', header: 'Source', value: (r) => STOCK_SOURCE_LABELS[r.source_type as 'IN_HOUSE'] },
        { id: 'location', header: 'Location', value: (r) => `${r.warehouse_code} / ${r.location_code}` }, { id: 'manufacturing_date', header: 'Mfg', value: (r) => r.manufacturing_date as string }, { id: 'expiry_date', header: 'Expiry', value: (r) => r.expiry_date as string },
        qtyCol('on_hand', 'On hand'), qtyCol('available', 'Available')],
    }),
  },
  {
    key: 'movements',
    title: 'Stock Movement Report',
    description: 'Ledger entries effective in the selected period.',
    dates: 'range',
    load: async ({ range }) => ({
      rows: (await fetchAllMovements({ from: range.from, to: range.to, search: '', productId: null, transactionType: null, source: null, warehouseId: null, locationId: null, batchId: null, userId: null, reference: '' })) as unknown as ReportRow[],
      columns: [{ id: 'transaction_number', header: 'Transaction', value: (r) => r.transaction_number as string }, { id: 'transaction_date', header: 'Date', value: (r) => r.transaction_date as string, render: (r) => formatDateTime(r.transaction_date as string) },
        { id: 'transaction_type', header: 'Type', value: (r) => TRANSACTION_TYPE_LABELS[r.transaction_type as string] }, ...productCols, { id: 'location', header: 'Location', value: (r) => `${r.warehouse_code} / ${r.location_code}` },
        qtyCol('quantity_in', 'In'), qtyCol('quantity_out', 'Out'), { id: 'unit', header: 'Unit', value: (r) => r.unit as string }, { id: 'reference_number', header: 'Reference', value: (r) => (r.reference_number as string) ?? '' }, { id: 'reason', header: 'Reason', value: (r) => r.reason as string }],
    }),
  },
  {
    key: 'opening',
    title: 'Opening Stock Register',
    description: 'Opening stock lines by effective date and approval status.',
    dates: 'range',
    load: async ({ range }) => ({
      rows: (await fetchOpeningLines(null)).filter((l) => inRange(l.effective_date, range)) as unknown as ReportRow[],
      columns: [{ id: 'effective_date', header: 'Effective', value: (r) => r.effective_date as string }, ...productCols, { id: 'location', header: 'Location', value: (r) => `${r.warehouse_code} / ${r.location_code}` },
        { id: 'source_type', header: 'Source', value: (r) => STOCK_SOURCE_LABELS[r.source_type as 'IN_HOUSE'] }, { id: 'batch_number', header: 'Batch', value: (r) => (r.batch_number as string) ?? '' },
        qtyCol('quantity', 'Quantity'), { id: 'unit_cost', header: 'Unit cost', align: 'right', value: (r) => n(r.unit_cost), render: (r) => (r.unit_cost === null ? 'Unknown' : formatCurrency(Number(r.unit_cost))) },
        { id: 'status', header: 'Status', value: (r) => APPROVAL_STATUS_LABELS[r.status as string] }],
    }),
  },
  {
    key: 'low',
    title: 'Low Stock and Out-of-Stock',
    description: 'Active products at or below reorder level, fully reserved, or out of stock.',
    dates: 'none',
    load: async () => ({
      rows: (await fetchAllProductStock({ ...allProducts, includeInactive: false })).filter((p) => ['LOW_STOCK', 'OUT_OF_STOCK', 'FULLY_RESERVED'].includes(p.stock_status) && (p.has_history || p.reorder_level !== null)) as unknown as ReportRow[],
      columns: [...productCols, { id: 'base_unit', header: 'Unit', value: (r) => r.base_unit as string }, qtyCol('on_hand', 'On hand'), qtyCol('reserved', 'Reserved'), qtyCol('available', 'Available'), qtyCol('reorder_level', 'Reorder level'),
        { id: 'stock_status', header: 'Status', value: (r) => STOCK_STATUS_LABELS[r.stock_status as string] }],
    }),
  },
  {
    key: 'adjustments',
    title: 'Stock Adjustment Report',
    description: 'Adjustment requests raised in the period with their outcome.',
    dates: 'range',
    load: async ({ range }) => ({
      rows: (await fetchAdjustments(null)).filter((a) => inRange(a.requested_at, range)) as unknown as ReportRow[],
      columns: [{ id: 'adjustment_number', header: 'Adjustment', value: (r) => r.adjustment_number as string }, { id: 'requested_at', header: 'Requested', value: (r) => r.requested_at as string, render: (r) => formatDateTime(r.requested_at as string) }, ...productCols,
        { id: 'reason_code', header: 'Reason', value: (r) => ADJUSTMENT_REASONS.find((x) => x.code === r.reason_code)?.label ?? String(r.reason_code) }, qtyCol('system_quantity', 'System qty'), qtyCol('difference', 'Difference'),
        { id: 'status', header: 'Status', value: (r) => APPROVAL_STATUS_LABELS[r.status as string] }],
    }),
  },
  {
    key: 'counts',
    title: 'Physical Count Variance Report',
    description: 'Counted lines with system quantity and variance.',
    dates: 'range',
    load: async ({ range }) => ({
      rows: (await fetchAllCountLines()).filter((l) => inRange(l.counted_at, range)) as unknown as ReportRow[],
      columns: [...productCols, { id: 'location', header: 'Location', value: (r) => `${r.warehouse_code} / ${r.location_code}` }, { id: 'batch_number', header: 'Batch', value: (r) => (r.batch_number as string) ?? '' },
        qtyCol('system_quantity', 'System qty'), qtyCol('counted_quantity', 'Counted'), qtyCol('variance', 'Variance'), { id: 'counted_at', header: 'Counted at', value: (r) => r.counted_at as string, render: (r) => formatDateTime(r.counted_at as string) },
        { id: 'posted', header: 'Posted', value: (r) => (r.posted_transaction_id ? 'Yes' : 'No') }],
    }),
  },
  {
    key: 'reservations',
    title: 'Stock Reservation Report',
    description: 'Reservations made in the period and their status.',
    dates: 'range',
    load: async ({ range }) => ({
      rows: (await fetchReservations(null)).filter((r) => inRange(r.reserved_at, range)) as unknown as ReportRow[],
      columns: [{ id: 'reservation_number', header: 'Reservation', value: (r) => r.reservation_number as string }, { id: 'reference', header: 'Reference', value: (r) => `${r.reference_type} ${r.reference_number}` }, ...productCols,
        qtyCol('quantity', 'Reserved'), qtyCol('fulfilled_quantity', 'Fulfilled'), qtyCol('released_quantity', 'Released'), { id: 'reservation_status', header: 'Status', value: (r) => RESERVATION_STATUS_LABELS[r.reservation_status as string] }],
    }),
  },
  {
    key: 'valuation',
    title: 'Inventory Valuation',
    description: 'Lot-level weighted-average cost of costed receipts. Lots with any uncosted receipt are shown as cost unknown (never zero).',
    dates: 'none',
    load: async () => {
      const rows = await fetchValuation()
      const known = rows.filter((r) => r.unit_cost !== null)
      const total = known.reduce((s, r) => s + Number(r.value), 0)
      const units = groupSum(rows.map((r) => ({ unit: r.unit, on_hand: r.on_hand, missing: r.unit_cost === null ? r.on_hand : 0 })) as unknown as ReportRow[], ['unit'], ['on_hand', 'missing'])
      return {
        rows: rows as unknown as ReportRow[],
        columns: [...productCols, { id: 'source_type', header: 'Source', value: (r) => STOCK_SOURCE_LABELS[r.source_type as 'IN_HOUSE'] }, { id: 'location', header: 'Location', value: (r) => `${r.warehouse_code} / ${r.location_code}` },
          { id: 'batch_number', header: 'Batch', value: (r) => (r.batch_number as string) ?? '' }, qtyCol('on_hand', 'On hand'), { id: 'unit', header: 'Unit', value: (r) => r.unit as string },
          { id: 'unit_cost', header: 'Avg unit cost', align: 'right', value: (r) => n(r.unit_cost), render: (r) => (r.unit_cost === null ? <span className="text-amber-800">Unknown</span> : formatCurrency(Number(r.unit_cost))) },
          { id: 'value', header: 'Value', align: 'right', value: (r) => n(r.value), render: (r) => (r.value === null ? '—' : formatCurrency(Number(r.value))) }],
        summary: (
          <span>
            Valued stock: <strong>{formatCurrency(total)}</strong> across {formatNumber(known.length)} of {formatNumber(rows.length)} lots. Missing cost:{' '}
            {units.map((u) => `${formatQty(Number(u.missing))} of ${formatQty(Number(u.on_hand), String(u.unit))} (${Number(u.on_hand) ? Math.round((Number(u.missing) / Number(u.on_hand)) * 100) : 0}%)`).join(', ') || 'none'}.
          </span>
        ),
      }
    },
  },
  {
    key: 'as-of',
    title: 'Stock as of a Selected Date',
    description: 'Balances rebuilt from posted ledger entries effective up to the end of the selected day (company timezone).',
    dates: 'cutoff',
    load: async ({ cutoff }) => {
      const [rows, overview, policy] = await Promise.all([fetchStockAsOf(cutoff), fetchInventoryOverview(), fetchInventoryPolicy()])
      const first = overview.first_transaction_at
      const before = !first || cutoff < toIsoDate(new Date(first))
      return {
        rows: rows as unknown as ReportRow[],
        columns: [...productCols, { id: 'location', header: 'Location', value: (r) => `${r.warehouse_code} / ${r.location_code}` }, { id: 'batch_number', header: 'Batch', value: (r) => (r.batch_number as string) ?? '' },
          { id: 'source_type', header: 'Source', value: (r) => STOCK_SOURCE_LABELS[r.source_type as 'IN_HOUSE'] }, qtyCol('quantity', 'Quantity'), { id: 'unit', header: 'Unit', value: (r) => r.unit as string }],
        summary: before
          ? `No inventory was recorded on or before ${cutoff}. The first ledger entry is ${first ? formatDateTime(first, policy.timezone) : 'not yet posted'}; balances before it are not fabricated.`
          : `Position at the end of ${cutoff} (${policy.timezone}), including reversals effective by then and excluding unapproved documents.`,
      }
    },
  },
]

export default function InventoryReportsPage() {
  const [active, setActive] = useState(REPORTS[0].key)
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [today] = useState(() => toIsoDate(new Date()))
  const [cutoff, setCutoff] = useState(today)
  const [exporting, setExporting] = useState(false)
  const report = REPORTS.find((r) => r.key === active)!
  const result = useAsync(() => report.load({ range, cutoff }), [active, report.dates === 'range' ? range : null, report.dates === 'cutoff' ? cutoff : null])

  const columns: DataTableColumn<ReportRow>[] = (result.data?.columns ?? []).map((c) => ({
    id: c.id,
    header: c.header,
    align: c.align,
    cell: (r) => c.render?.(r) ?? (c.value(r) ?? '—'),
    searchValue: (r) => String(c.value(r) ?? ''),
    sortValue: (r) => c.value(r),
  }))

  const exportReport = async (format: 'xlsx' | 'csv') => {
    if (!result.data) return
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      const rows: CellValue[][] = [result.data.columns.map((c) => c.header), ...result.data.rows.map((r) => result.data!.columns.map((c) => c.value(r)))]
      const suffix = report.dates === 'range' ? `${toIsoDate(range.from)}-to-${toIsoDate(range.to)}` : report.dates === 'cutoff' ? `as-of-${cutoff}` : toIsoDate(new Date())
      await downloadSheets([{ name: report.title.slice(0, 31), rows }], `${report.key}-${suffix}`, format)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <PageHeader />
      <div className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)]">
        <Card>
          <CardContent className="p-2">
            <nav aria-label="Reports">
              <ul className="space-y-0.5">
                {REPORTS.map((r, i) => (
                  <li key={r.key}>
                    <button type="button" aria-current={active === r.key ? 'page' : undefined} onClick={() => setActive(r.key)}
                      className={cn('w-full rounded-md px-3 py-2 text-left text-sm', active === r.key ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted')}>
                      <span className="mr-1.5 text-xs text-muted-foreground">{i + 1}.</span>{r.title}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          </CardContent>
        </Card>
        <div className="min-w-0 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-base font-semibold">{report.title}</h2>
              <p className="text-sm text-muted-foreground">{report.description}</p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              {report.dates === 'range' && <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />}
              {report.dates === 'cutoff' && (
                <div className="space-y-1"><Label htmlFor="rep-cutoff">As of end of</Label><Input id="rep-cutoff" type="date" max={today} value={cutoff} onChange={(e) => setCutoff(e.target.value)} className="w-44" /></div>
              )}
              <PermissionGate permission="inventory.export">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={exporting || !result.data || result.data.rows.length === 0}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void exportReport('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void exportReport('csv')}>CSV</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </PermissionGate>
            </div>
          </div>
          {result.data?.summary && <p className="rounded-lg border bg-background px-4 py-2.5 text-sm">{result.data.summary}</p>}
          <DataTable
            columns={columns}
            data={result.data?.rows ?? []}
            getRowId={(r) => JSON.stringify(Object.values(r).slice(0, 6))}
            loading={result.loading}
            error={result.error ? new Error(describeDataError(result.error)) : null}
            onRetry={result.reload}
            pageSize={25}
            searchPlaceholder="Search this report…"
            emptyState={{ icon: FileChartColumn, title: 'No records', description: 'Nothing matches this report and period yet.' }}
          />
        </div>
      </div>
    </>
  )
}
