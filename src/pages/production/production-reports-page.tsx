import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Download, FileBarChart, GitBranch, Loader2, Search } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StockSourceBadge } from '@/features/inventory/inventory-badges'
import { TRANSACTION_TYPE_LABELS, formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import {
  DISPOSITION_LABELS,
  OUTSOURCING_STATUS_LABELS,
  OUTSOURCING_TYPE_LABELS,
  PRODUCTION_STATUS_LABELS,
  QUALITY_STATUS_LABELS,
} from '@/features/production/production-model'
import type { CellValue } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { ProductOption } from '@/services/inventory'
import { fetchBoms, fetchProductionReport, searchLots, traceBatch, type ProductionReportKey } from '@/services/production'
import type { DateRangeValue } from '@/types'

type Row = Record<string, unknown>
type Kind = 'text' | 'qty' | 'date' | 'money' | 'pct' | 'bool'
interface Col { id: string; header: string; kind?: Kind; labels?: Record<string, string> }
interface ReportDef {
  key: ProductionReportKey
  title: string
  description: string
  columns: Col[]
  filters: ('product' | 'bom' | 'status' | 'warehouse' | 'supplier')[]
  statuses?: Record<string, string>
  dates: string
  summary?: (rows: Row[]) => ReactNode
}

const q = (id: string, header: string): Col => ({ id, header, kind: 'qty' })
const d = (id: string, header: string): Col => ({ id, header, kind: 'date' })
const t = (id: string, header: string, labels?: Record<string, string>): Col => ({ id, header, labels })
const m = (id: string, header: string): Col => ({ id, header, kind: 'money' })
const COST_STATUS: Record<string, string> = { ACTUAL: 'Actual', COST_DATA_INCOMPLETE: 'Cost data incomplete', NO_MATERIAL_ISSUED: 'No material issued' }
const ASSESSMENT: Record<string, string> = { WITHIN_ALLOWANCE: 'Within allowance', OVER_ALLOWANCE: 'Over allowance', BELOW_STANDARD: 'Below standard', NO_OUTPUT: 'No output yet' }
const ORDER_FILTERS: ReportDef['filters'] = ['product', 'bom', 'status', 'warehouse']

const REPORTS: ReportDef[] = [
  { key: 'ORDERS_SUMMARY', title: 'Production Orders Summary', description: 'Orders planned to start in the period with quantities and dates.', dates: 'Planned start date', filters: ORDER_FILTERS, statuses: PRODUCTION_STATUS_LABELS,
    columns: [t('production_order_number', 'Order'), t('status', 'Status', PRODUCTION_STATUS_LABELS), t('priority', 'Priority'), t('sku', 'SKU'), t('product_name', 'Product'), t('bom_code', 'BOM'), t('bom_version', 'Ver.'), t('unit', 'Unit'),
      q('planned_quantity', 'Planned'), q('completed_quantity', 'Good'), q('rejected_quantity', 'Rejected'), q('scrap_quantity', 'Scrap'), d('planned_start_date', 'Planned start'), d('target_completion_date', 'Target'),
      d('actual_start_date', 'Started'), d('actual_completion_date', 'Completed'), t('source_warehouse', 'From'), t('destination_warehouse', 'To')] },
  { key: 'PLANNED_VS_ACTUAL', title: 'Planned versus Actual Production', description: 'Planned vs recorded output per order with a target date in the period.', dates: 'Target completion date', filters: ORDER_FILTERS, statuses: PRODUCTION_STATUS_LABELS,
    columns: [t('production_order_number', 'Order'), t('status', 'Status', PRODUCTION_STATUS_LABELS), t('sku', 'SKU'), t('product_name', 'Product'), t('unit', 'Unit'), q('planned_quantity', 'Planned'), q('good_quantity', 'Good'),
      q('total_output', 'Total output'), q('variance', 'Variance'), { id: 'good_percent_of_plan', header: 'Good % of plan', kind: 'pct' }, d('target_completion_date', 'Target'), d('actual_completion_date', 'Completed'), t('days_late', 'Days late')] },
  { key: 'RAW_MATERIAL_REQUIREMENTS', title: 'Raw Material Requirements', description: 'Outstanding material need of submitted, approved and running orders against usable stock in their source warehouse (current).', dates: 'Current (no period)', filters: ['product', 'warehouse'],
    columns: [t('sku', 'Material'), t('product_name', 'Name'), t('unit', 'Unit'), t('warehouse_code', 'Warehouse'), t('orders', 'Orders'), t('order_numbers', 'Order numbers'), q('planned', 'Planned'), q('issued', 'Issued'),
      q('outstanding', 'Outstanding'), q('reserved_for_orders', 'Reserved for orders'), q('available', 'Available'), q('shortage', 'Shortage')] },
  { key: 'MATERIAL_SHORTAGE', title: 'Material Shortage Report', description: 'Materials whose outstanding requirement is not covered by reservations and usable stock (current).', dates: 'Current (no period)', filters: ['product', 'warehouse'],
    columns: [t('sku', 'Material'), t('product_name', 'Name'), t('unit', 'Unit'), t('warehouse_code', 'Warehouse'), t('order_numbers', 'Orders'), q('outstanding', 'Outstanding'), q('reserved_for_orders', 'Reserved'), q('available', 'Available'), q('shortage', 'Shortage')] },
  { key: 'PLANNED_VS_ACTUAL_CONSUMPTION', title: 'Planned versus Actual Consumption', description: 'Planned material vs issued (net of reversals), with the standard for the output actually produced.', dates: 'Start date', filters: ORDER_FILTERS, statuses: PRODUCTION_STATUS_LABELS,
    columns: [t('production_order_number', 'Order'), t('status', 'Status', PRODUCTION_STATUS_LABELS), t('product_sku', 'Product'), t('component_sku', 'Material'), t('component_name', 'Name'), t('unit', 'Unit'), q('planned_quantity', 'Planned'),
      q('issued_quantity', 'Issued'), q('variance', 'Issued − planned'), q('actual_output', 'Output'), q('standard_for_actual_output', 'Standard for output')] },
  { key: 'OUTPUT_AND_REJECTIONS', title: 'Production Output and Rejections', description: 'Output receipts with good, rejected and scrap quantities.', dates: 'Production date', filters: ['product', 'bom', 'warehouse'],
    columns: [t('receipt_number', 'Receipt'), d('production_date', 'Date'), t('production_order_number', 'Order'), t('sku', 'SKU'), t('product_name', 'Product'), t('batch_number', 'Batch'), t('unit', 'Unit'), q('good_quantity', 'Good'),
      q('rejected_quantity', 'Rejected'), q('scrap_quantity', 'Scrap'), { id: 'reject_scrap_percent', header: 'Reject + scrap %', kind: 'pct' }, t('rejected_handling', 'Rejects'), t('rejection_reason', 'Reason'), t('quality_status', 'Quality', QUALITY_STATUS_LABELS)] },
  { key: 'FINISHED_GOODS_PRODUCED', title: 'Finished Goods Produced', description: 'In-house output per product in the period.', dates: 'Production date', filters: ['product', 'bom', 'warehouse'],
    columns: [t('sku', 'SKU'), t('product_name', 'Product'), t('unit', 'Unit'), t('orders', 'Orders'), t('receipts', 'Receipts'), q('good_quantity', 'Good'), q('rejected_quantity', 'Rejected'), q('scrap_quantity', 'Scrap'), d('first_date', 'First'), d('last_date', 'Last')] },
  { key: 'OUTSOURCING_REGISTER', title: 'Outsourcing Orders Register', description: 'Outsourcing orders created in the period.', dates: 'Order created', filters: ['product', 'status', 'warehouse', 'supplier'], statuses: OUTSOURCING_STATUS_LABELS,
    columns: [t('outsourcing_order_number', 'Order'), t('order_type', 'Type', OUTSOURCING_TYPE_LABELS), t('status', 'Status', OUTSOURCING_STATUS_LABELS), t('supplier_name', 'Supplier'), t('supplier_reference', 'Supplier ref.'), t('sku', 'SKU'), t('product_name', 'Product'), t('unit', 'Unit'),
      q('ordered_quantity', 'Ordered'), q('received_quantity', 'Received'), q('accepted_quantity', 'Accepted'), q('rejected_quantity', 'Rejected'), q('pending_quantity', 'Pending'), d('dispatch_date', 'Dispatched'), d('expected_return_date', 'Expected'),
      m('unit_cost', 'Unit price'), { id: 'overdue', header: 'Overdue', kind: 'bool' }] },
  { key: 'MATERIALS_HELD_BY_SUPPLIERS', title: 'Materials Held by Suppliers', description: 'Company-owned stock currently at external-processing locations (current).', dates: 'Current (no period)', filters: ['product', 'supplier'],
    columns: [t('external_holder', 'Held by'), t('warehouse_code', 'Warehouse'), t('location_code', 'Location'), t('sku', 'Material'), t('product_name', 'Name'), t('batch_number', 'Batch'), t('source_type', 'Source'), q('quantity_held', 'Held'), t('unit', 'Unit'), t('open_orders', 'Open orders')] },
  { key: 'OUTSOURCED_RECEIPTS', title: 'Outsourced Goods Receipt Report', description: 'Goods received from suppliers in the period.', dates: 'Receipt date', filters: ['product', 'warehouse', 'supplier'],
    columns: [t('receipt_number', 'Receipt'), d('receipt_date', 'Date'), t('outsourcing_order_number', 'Order'), t('order_type', 'Type', OUTSOURCING_TYPE_LABELS), t('supplier_name', 'Supplier'), t('supplier_document_number', 'Supplier doc.'), t('sku', 'SKU'), t('batch_number', 'Batch'), t('unit', 'Unit'),
      q('received_quantity', 'Received'), q('accepted_quantity', 'Accepted'), q('rejected_quantity', 'Rejected'), t('rejection_disposition', 'Disposition', DISPOSITION_LABELS), t('rejection_reason', 'Reason'), m('unit_cost', 'Unit cost')] },
  { key: 'IN_HOUSE_VS_OUTSOURCED', title: 'In-House versus Outsourced Output', description: 'Good in-house output vs accepted outsourced goods per product in the period.', dates: 'Production / receipt date', filters: ['product', 'warehouse', 'supplier'],
    columns: [t('sku', 'SKU'), t('product_name', 'Product'), t('unit', 'Unit'), q('in_house_good', 'In-house'), q('outsourced_accepted', 'Outsourced'), q('total', 'Total'), { id: 'in_house_percent', header: 'In-house %', kind: 'pct' }] },
  { key: 'BATCH_TRACEABILITY', title: 'Production Batch Traceability', description: 'Output batches with the material batches consumed for them (in-house and at suppliers). Use the explorer below for forward/backward tracing.', dates: 'Production / receipt date', filters: ['product', 'bom', 'supplier'],
    columns: [d('date', 'Date'), t('kind', 'Made'), t('order_number', 'Order'), t('output_sku', 'Output'), t('output_batch', 'Output batch'), q('output_quantity', 'Output qty'), t('material_sku', 'Material'), t('material_batch', 'Material batch'), q('material_quantity', 'Material qty'),
      t('material_unit', 'Unit'), { id: 'output_is_pooled_lot', header: 'Pooled lot', kind: 'bool' }] },
  { key: 'COST_SUMMARY', title: 'Production Cost Summary', description: 'Recorded costs only. Material at the weighted-average cost of the issued lots; outsourcing at the recorded price/charge.', dates: 'Output / receipt date', filters: ['product'],
    columns: [t('order_type', 'Type'), t('order_number', 'Order'), t('sku', 'SKU'), t('unit', 'Unit'), q('good_quantity', 'Good qty'), m('material_cost', 'Material'), m('outsourcing_cost', 'Outsourcing'), m('total_cost', 'Total'), m('cost_per_good_unit', 'Per good unit'),
      m('standard_estimate_for_output', 'Standard estimate'), m('variance', 'Variance'), t('cost_status', 'Cost status', COST_STATUS), t('notes', 'Notes')],
    summary: (rows) => {
      const incomplete = rows.filter((r) => r.cost_status !== 'ACTUAL').length
      return (
        <span>
          Costing method: material = quantity issued × weighted-average cost of the issued lot (from costed receipts); outsourcing = recorded price or processing charge × accepted quantity; the standard estimate uses products' standard cost and is shown only when every component has one.
          Selling prices are never used, missing costs are never treated as zero, and scrap is not assumed to have any value. {incomplete > 0 && <strong className="text-amber-800">{incomplete} order(s): cost data incomplete — no total is shown for them.</strong>}
        </span>
      )
    } },
  { key: 'VARIANCE', title: 'Production Variance Report', description: 'Output variance and material usage against the standard (BOM quantity × output) and allowance (standard + wastage).', dates: 'Start / completion date', filters: ORDER_FILTERS, statuses: PRODUCTION_STATUS_LABELS,
    columns: [t('production_order_number', 'Order'), t('status', 'Status', PRODUCTION_STATUS_LABELS), t('product_sku', 'Product'), q('planned_quantity', 'Planned'), q('actual_quantity', 'Output'), q('output_variance', 'Output variance'), t('component_sku', 'Material'), t('unit', 'Unit'),
      q('standard_for_output', 'Standard'), q('allowed_with_wastage', 'Allowed'), q('issued_quantity', 'Issued'), q('usage_variance', 'Usage variance'), t('assessment', 'Assessment', ASSESSMENT)] },
]

const display = (c: Col, r: Row): ReactNode => {
  const v = r[c.id]
  if (v === null || v === undefined || v === '') return c.kind === 'money' ? <span className="text-muted-foreground">Unknown</span> : '—'
  switch (c.kind) {
    case 'qty': return formatQty(Number(v))
    case 'money': return formatCurrency(Number(v))
    case 'date': return formatDate(String(v))
    case 'pct': return `${Number(v)}%`
    case 'bool': return v ? 'Yes' : 'No'
  }
  if (c.id === 'source_type') return <StockSourceBadge source={String(v)} />
  if (c.id === 'cost_status' && v !== 'ACTUAL') return <span className="font-medium text-amber-800">{c.labels?.[String(v)] ?? String(v)}</span>
  return c.labels?.[String(v)] ?? String(v)
}
const exportValue = (c: Col, r: Row): CellValue => {
  const v = r[c.id]
  if (v === null || v === undefined) return null
  if (c.kind === 'qty' || c.kind === 'money' || c.kind === 'pct') return Number(v)
  if (c.kind === 'bool') return v ? 'Yes' : 'No'
  return c.labels?.[String(v)] ?? String(v)
}

export default function ProductionReportsPage() {
  const storage = useStorage()
  const [active, setActive] = useState<ProductionReportKey | 'TRACE'>('ORDERS_SUMMARY')
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [bomId, setBomId] = useState('all')
  const [status, setStatus] = useState('all')
  const [warehouseId, setWarehouseId] = useState('all')
  const [supplierText, setSupplier] = useState('')
  const supplier = useDebouncedValue(supplierText, 400)
  const [exporting, setExporting] = useState(false)
  const boms = useAsync(() => fetchBoms(null), [])
  const report = REPORTS.find((r) => r.key === active)
  const filters = {
    from: toIsoDate(range.from),
    to: toIsoDate(range.to),
    productId: report?.filters.includes('product') ? (product?.product_id ?? null) : null,
    bomId: report?.filters.includes('bom') && bomId !== 'all' ? bomId : null,
    status: report?.filters.includes('status') && status !== 'all' && report.statuses?.[status] ? status : null,
    warehouseId: report?.filters.includes('warehouse') && warehouseId !== 'all' ? warehouseId : null,
    supplier: report?.filters.includes('supplier') && supplier.trim() ? supplier.trim() : null,
  }
  const result = useAsync(() => (report ? fetchProductionReport(report.key, filters) : Promise.resolve([])), [active, JSON.stringify(filters)])

  const columns: DataTableColumn<Row>[] = (report?.columns ?? []).map((c) => ({
    id: c.id,
    header: c.header,
    align: c.kind === 'qty' || c.kind === 'money' || c.kind === 'pct' ? 'right' : 'left',
    cell: (r) => display(c, r),
    searchValue: (r) => String(r[c.id] ?? ''),
    sortValue: (r) => (r[c.id] === null || r[c.id] === undefined ? null : c.kind === 'qty' || c.kind === 'money' || c.kind === 'pct' ? Number(r[c.id]) : String(r[c.id])),
  }))

  const exportReport = async (format: 'xlsx' | 'csv') => {
    if (!report || !result.data) return
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      const rows: CellValue[][] = [report.columns.map((c) => c.header), ...result.data.map((r) => report.columns.map((c) => exportValue(c, r)))]
      await downloadSheets([{ name: report.title.slice(0, 31), rows }], `${report.key.toLowerCase()}-${filters.from}-to-${filters.to}`, format)
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <PageHeader />
      <div className="grid gap-6 xl:grid-cols-[270px_minmax(0,1fr)]">
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
                <li className="border-t pt-1">
                  <button type="button" aria-current={active === 'TRACE' ? 'page' : undefined} onClick={() => setActive('TRACE')}
                    className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm', active === 'TRACE' ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted')}>
                    <GitBranch className="size-4" /> Trace a batch
                  </button>
                </li>
              </ul>
            </nav>
          </CardContent>
        </Card>

        {active === 'TRACE' ? <TraceExplorer /> : report && (
          <div className="min-w-0 space-y-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-base font-semibold">{report.title}</h2>
                <p className="text-sm text-muted-foreground">{report.description} <span className="text-xs">Period applies to: {report.dates}.</span></p>
              </div>
              <PermissionGate permission="production_reports.export">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={exporting || !result.data || result.data.length === 0}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void exportReport('xlsx')}>Excel (.xlsx)</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void exportReport('csv')}>CSV</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </PermissionGate>
            </div>
            <Card>
              <CardContent className="flex flex-wrap items-end gap-3 p-4">
                {!report.dates.startsWith('Current') && <DateRangeFilter value={range} onChange={setRange} presets={EXTENDED_DATE_RANGE_PRESETS} />}
                {report.filters.includes('product') && (
                  <div className="w-64 space-y-1"><Label htmlFor="rp-product">Product</Label><ProductPicker id="rp-product" value={product} onChange={setProduct} includeInactive /></div>
                )}
                {report.filters.includes('bom') && (
                  <div className="space-y-1"><Label htmlFor="rp-bom">BOM version</Label>
                    <Select value={bomId} onValueChange={setBomId}>
                      <SelectTrigger id="rp-bom" className="w-56"><SelectValue /></SelectTrigger>
                      <SelectContent className="max-h-72"><SelectItem value="all">All BOM versions</SelectItem>{(boms.data ?? []).map((b) => <SelectItem key={b.id} value={b.id}>{b.bom_code} v{b.version} · {b.sku}</SelectItem>)}</SelectContent>
                    </Select></div>
                )}
                {report.filters.includes('status') && report.statuses && (
                  <div className="space-y-1"><Label htmlFor="rp-status">Status</Label>
                    <Select value={report.statuses[status] ? status : 'all'} onValueChange={setStatus}>
                      <SelectTrigger id="rp-status" className="w-48"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(report.statuses).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent>
                    </Select></div>
                )}
                {report.filters.includes('warehouse') && (
                  <div className="space-y-1"><Label htmlFor="rp-wh">Warehouse</Label>
                    <Select value={warehouseId} onValueChange={setWarehouseId}>
                      <SelectTrigger id="rp-wh" className="w-48"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="all">All warehouses</SelectItem>{storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code}</SelectItem>)}</SelectContent>
                    </Select></div>
                )}
                {report.filters.includes('supplier') && (
                  <div className="space-y-1"><Label htmlFor="rp-supplier">Supplier</Label><Input id="rp-supplier" className="w-48" placeholder="Name contains…" value={supplierText} onChange={(e) => setSupplier(e.target.value)} /></div>
                )}
              </CardContent>
            </Card>
            {report.summary && result.data && <p className="rounded-lg border bg-background px-4 py-2.5 text-sm">{report.summary(result.data)}</p>}
            <DataTable
              columns={columns}
              data={result.data ?? []}
              getRowId={(r) => JSON.stringify(Object.values(r).slice(0, 8))}
              loading={result.loading}
              error={result.error ? new Error(describeDataError(result.error)) : null}
              onRetry={result.reload}
              pageSize={25}
              searchPlaceholder="Search this report…"
              emptyState={{ icon: FileBarChart, title: 'No records', description: 'Nothing matches this report, period and filters.' }}
            />
          </div>
        )}
      </div>
    </>
  )
}

function TraceExplorer() {
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const lots = useAsync(() => searchLots(search), [search])
  const [batchId, setBatchId] = useState<string | null>(null)
  const trace = useAsync(() => (batchId ? traceBatch(batchId) : Promise.resolve(null)), [batchId])
  const tr = trace.data

  const lotLink = (id: string | null, text: string) => (id ? <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setBatchId(id)}>{text}</button> : <span>{text}</span>)

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h2 className="text-base font-semibold">Batch traceability</h2>
        <p className="text-sm text-muted-foreground">Backward (what a lot was made from) and forward (where it was used). Links exist only where batches were recorded; gaps are flagged.</p>
      </div>
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="relative max-w-md">
            <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search batch, SKU or product" className="pl-9" placeholder="Batch number, SKU or product name" value={term} onChange={(e) => setTerm(e.target.value)} />
          </div>
          {search.trim() && (
            <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
              {lots.loading && <li className="px-3 py-2 text-muted-foreground">Searching…</li>}
              {!lots.loading && (lots.data ?? []).length === 0 && <li className="px-3 py-2 text-muted-foreground">No lots found.</li>}
              {(lots.data ?? []).map((l) => (
                <li key={l.id}>
                  <button type="button" onClick={() => setBatchId(l.id)} className={cn('flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-muted', batchId === l.id && 'bg-accent')}>
                    <span className="font-medium">{l.batch_number ?? 'Pooled lot (not batch-tracked)'}</span>
                    <span className="text-muted-foreground">{l.sku} — {l.product_name}</span>
                    <StockSourceBadge source={l.source_type} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {trace.loading && batchId && <p className="text-sm text-muted-foreground">Tracing…</p>}
      {trace.error && <p className="text-sm text-shortage">{describeDataError(trace.error)}</p>}
      {tr && (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>{tr.batch.batch_number ? `Batch ${tr.batch.batch_number}` : 'Pooled lot'} · {tr.batch.sku}</CardTitle>
                <CardDescription>{tr.batch.product_name} · on hand {formatQty(tr.batch.on_hand, tr.batch.unit)}{tr.batch.expiry_date ? ` · expires ${formatDate(tr.batch.expiry_date)}` : ''}</CardDescription>
              </div>
              <StockSourceBadge source={tr.batch.source_type} />
            </CardHeader>
            {tr.completeness.warnings.length > 0 && (
              <CardContent>
                <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  {tr.completeness.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</li>)}
                </ul>
              </CardContent>
            )}
          </Card>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card>
              <CardHeader><div><CardTitle className="flex items-center gap-2"><ArrowDownLeft className="size-4" /> Made from (backward)</CardTitle><CardDescription>Orders that produced this lot and the material lots they consumed.</CardDescription></div></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {tr.produced_by.length === 0 && <p className="text-muted-foreground">No production or outsourcing receipt is linked to this lot.</p>}
                {tr.produced_by.map((p) => (
                  <div key={p.receipt_number} className="rounded-md border p-3">
                    <p className="font-medium">
                      {p.kind === 'PRODUCTION' ? <Link className="text-primary hover:underline" to={`/production/orders/${p.order_id}`}>{p.order_number}</Link> : p.order_number}
                      {p.supplier_name && <span className="font-normal text-muted-foreground"> · {p.supplier_name}</span>} · {p.receipt_number} · {formatDate(p.date)} · good {formatQty(p.good, p.unit)}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {p.materials.length === 0 && <li className="text-muted-foreground">No material consumption recorded.</li>}
                      {p.materials.map((mt) => <li key={`${mt.batch_id}-${mt.date}-${mt.quantity}`}>{mt.sku}: {lotLink(mt.batch_id, mt.batch_number ?? 'pooled lot')} · {formatQty(mt.quantity, mt.unit)} · {formatDate(mt.date)}</li>)}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><div><CardTitle className="flex items-center gap-2"><ArrowUpRight className="size-4" /> Used in (forward)</CardTitle><CardDescription>Orders that consumed this lot and the output lots they produced.</CardDescription></div></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {tr.used_in.length === 0 && <p className="text-muted-foreground">This lot has not been consumed by production or a supplier.</p>}
                {tr.used_in.map((u) => (
                  <div key={u.order_id} className="rounded-md border p-3">
                    <p className="font-medium">
                      {u.kind === 'PRODUCTION' ? <Link className="text-primary hover:underline" to={`/production/orders/${u.order_id}`}>{u.order_number}</Link> : u.order_number}
                      {u.supplier_name && <span className="font-normal text-muted-foreground"> · {u.supplier_name}</span>} · used {formatQty(u.quantity, u.unit)}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {u.outputs.length === 0 && <li className="text-muted-foreground">No output recorded yet.</li>}
                      {u.outputs.map((op) => <li key={op.receipt_number}>{op.sku}: {lotLink(op.batch_id, op.batch_number ?? 'pooled lot')} · {formatQty(op.good)} · {op.receipt_number}</li>)}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><div><CardTitle>Ledger history of this lot</CardTitle><CardDescription>Receipts, transfers, issues, adjustments and reversals (latest 300).</CardDescription></div></CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-xs text-muted-foreground"><tr><th className="pb-2 text-left">Date</th><th className="pb-2 text-left">Transaction</th><th className="pb-2 text-left">Type</th><th className="pb-2 text-left">Location</th><th className="pb-2 text-right">In</th><th className="pb-2 text-right">Out</th><th className="pb-2 text-left">Reference</th></tr></thead>
                <tbody>
                  {tr.history.map((h) => (
                    <tr key={h.transaction_number} className="border-t">
                      <td className="py-1.5">{formatDateTime(h.transaction_date)}</td>
                      <td className="py-1.5">{h.transaction_number}</td>
                      <td className="py-1.5">{TRANSACTION_TYPE_LABELS[h.transaction_type] ?? h.transaction_type}</td>
                      <td className="py-1.5">{h.warehouse_code} / {h.location_code}{h.stock_usage !== 'STORAGE' && <span className="text-xs text-muted-foreground"> ({h.stock_usage === 'REJECTED' ? 'rejected' : h.stock_usage === 'QUARANTINE' ? 'quarantine' : 'at supplier'})</span>}</td>
                      <td className="py-1.5 text-right tabular-nums">{h.direction > 0 ? formatQty(h.quantity) : ''}</td>
                      <td className="py-1.5 text-right tabular-nums">{h.direction < 0 ? formatQty(h.quantity) : ''}</td>
                      <td className="py-1.5 text-xs">{h.reference_number ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
