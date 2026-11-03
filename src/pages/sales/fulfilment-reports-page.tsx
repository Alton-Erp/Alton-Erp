import { Download, FileBarChart, Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { PermissionGate } from '@/auth/permission-gate'
import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import type { CellValue } from '@/features/products/spreadsheet'
import {
  DISPOSITION_LABELS, FULFILMENT_STATUS_LABELS, ORDER_FULFILMENT_LABELS, ORDER_STATUS_LABELS, PRIORITY_LABELS, RETURN_REASON_LABELS, RETURN_STATUS_LABELS, TRANSPORT_MODE_LABELS,
} from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { EXTENDED_DATE_RANGE_PRESETS, getPresetRange } from '@/lib/date-range'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchCustomers } from '@/services/customer-po'
import type { ProductOption } from '@/services/inventory'
import { fetchFulfilmentReport, type FulfilmentReportKey } from '@/services/sales'
import type { DateRangeValue } from '@/types'

type Row = Record<string, unknown>
type Kind = 'text' | 'qty' | 'date' | 'datetime' | 'pct' | 'bool' | 'num'
interface Col { id: string; header: string; kind?: Kind; labels?: Record<string, string> }
interface ReportDef { key: FulfilmentReportKey; title: string; description: string; dates: string; columns: Col[]; filters: ('customer' | 'product' | 'warehouse' | 'status' | 'transporter')[]; statuses?: Record<string, string> }

const q = (id: string, header: string): Col => ({ id, header, kind: 'qty' })
const d = (id: string, header: string): Col => ({ id, header, kind: 'date' })
const dt = (id: string, header: string): Col => ({ id, header, kind: 'datetime' })
const t = (id: string, header: string, labels?: Record<string, string>): Col => ({ id, header, labels })
const n = (id: string, header: string): Col => ({ id, header, kind: 'num' })
const ALL: ReportDef['filters'] = ['customer', 'product', 'warehouse', 'status']
const SHIPPED: ReportDef['filters'] = ['customer', 'product', 'warehouse', 'status', 'transporter']
const ORDER_ST = Object.fromEntries(Object.entries(ORDER_STATUS_LABELS).filter(([k]) => k !== 'DRAFT'))

const REPORTS: ReportDef[] = [
  { key: 'SALES_ORDER_REGISTER', title: 'Sales Order Register', description: 'Orders dated in the period, one row per order and unit.', dates: 'Order date', filters: ALL, statuses: ORDER_ST,
    columns: [t('sales_order_number', 'Order'), d('order_date', 'Date'), t('customer', 'Customer'), t('customer_po_number', 'Customer PO'), t('source', 'Source'), t('order_status', 'Status', ORDER_STATUS_LABELS),
      t('fulfilment_status', 'Dispatch / delivery', ORDER_FULFILMENT_LABELS), t('priority', 'Priority', PRIORITY_LABELS), t('warehouse_code', 'Warehouse'), d('requested_delivery_date', 'Requested'), t('unit', 'Unit'), n('lines', 'Lines'),
      q('ordered', 'Ordered'), q('cancelled', 'Cancelled'), q('dispatched', 'Dispatched'), q('delivered', 'Delivered'), q('returned', 'Returned'), q('remaining', 'Remaining'), dt('confirmed_at', 'Confirmed')] },
  { key: 'PENDING_FULFILMENT', title: 'Pending Fulfilment', description: 'Open order lines with quantity still to dispatch (current).', dates: 'Current (no period)', filters: ALL, statuses: ORDER_ST,
    columns: [t('sales_order_number', 'Order'), d('order_date', 'Ordered'), d('requested_delivery_date', 'Requested'), t('customer', 'Customer'), t('order_status', 'Status', ORDER_STATUS_LABELS), t('priority', 'Priority', PRIORITY_LABELS),
      n('line_no', 'Line'), t('sku', 'SKU'), t('product_name', 'Product'), t('unit', 'Unit'), q('ordered', 'Ordered'), q('dispatched', 'Dispatched'), q('reserved', 'Reserved'), q('on_pick_lists', 'On pick lists'),
      q('remaining', 'Remaining'), q('unreserved', 'Unreserved'), n('days_open', 'Days open')] },
  { key: 'PICKING', title: 'Warehouse Picking Report', description: 'Pick-list lines created in the period with picked quantities and exceptions.', dates: 'Pick list created', filters: ALL, statuses: FULFILMENT_STATUS_LABELS,
    columns: [t('fulfilment_number', 'Pick list'), t('fulfilment_status', 'Status', FULFILMENT_STATUS_LABELS), d('created_date', 'Created'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('warehouse_code', 'Warehouse'),
      t('location_code', 'Location'), t('batch_number', 'Batch'), t('sku', 'SKU'), t('unit', 'Unit'), q('to_pick', 'To pick'), q('picked', 'Picked'), q('short_picked', 'Short'), t('pick_exception', 'Exception'), dt('picked_at', 'Picked at')] },
  { key: 'PACKING_STATUS', title: 'Packing Status Report', description: 'Consignments created in the period with picked, packed and damaged quantities.', dates: 'Pick list created', filters: ALL, statuses: FULFILMENT_STATUS_LABELS,
    columns: [t('fulfilment_number', 'Consignment'), t('fulfilment_status', 'Status', FULFILMENT_STATUS_LABELS), d('created_date', 'Created'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('warehouse_code', 'Warehouse'),
      t('units', 'Units'), q('picked', 'Picked'), q('packed', 'Packed'), q('damaged', 'Damaged / missing'), n('pack_exceptions', 'Exceptions'), t('packing_notes', 'Packing notes'), t('reopen_reason', 'Reopened'), dt('packed_at', 'Packed'), dt('ready_at', 'Ready')] },
  { key: 'DISPATCH_REGISTER', title: 'Dispatch Register', description: 'Consignments by actual dispatch date with transport details and stock issues.', dates: 'Dispatch date', filters: SHIPPED, statuses: FULFILMENT_STATUS_LABELS,
    columns: [t('fulfilment_number', 'Consignment'), dt('dispatched_at', 'Dispatched'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('customer_po_number', 'Customer PO'), t('warehouse_code', 'Warehouse'),
      t('carrier_name', 'Carrier'), t('transport_mode', 'Mode', TRANSPORT_MODE_LABELS), t('vehicle_number', 'Vehicle'), t('lr_number', 'LR'), t('tracking_number', 'Tracking'), t('eway_bill_number', 'E-way bill'),
      t('fulfilment_status', 'Status', FULFILMENT_STATUS_LABELS), t('units', 'Units'), q('dispatched', 'Dispatched'), t('transaction_numbers', 'Stock issues'), d('expected_delivery_date', 'Expected')] },
  { key: 'PARTIAL_DISPATCH', title: 'Partial Dispatch Report', description: 'Order lines dispatched in the period in several consignments or with quantity still remaining.', dates: 'Dispatch date', filters: ALL, statuses: ORDER_ST,
    columns: [t('sales_order_number', 'Order'), t('customer', 'Customer'), t('order_status', 'Status', ORDER_STATUS_LABELS), n('line_no', 'Line'), t('sku', 'SKU'), t('unit', 'Unit'), q('ordered', 'Ordered'), q('dispatched', 'Dispatched'),
      q('remaining', 'Remaining'), n('consignments', 'Consignments'), dt('first_dispatch', 'First dispatch'), dt('last_dispatch', 'Last dispatch')] },
  { key: 'BACKORDER', title: 'Backorder Report', description: 'Confirmed order lines whose remaining quantity is not covered by reservations (current), with eligible stock available now.', dates: 'Current (no period)', filters: ALL, statuses: ORDER_ST,
    columns: [t('sales_order_number', 'Order'), d('order_date', 'Ordered'), d('requested_delivery_date', 'Requested'), t('customer', 'Customer'), t('order_status', 'Status', ORDER_STATUS_LABELS), n('line_no', 'Line'), t('sku', 'SKU'),
      t('product_name', 'Product'), t('unit', 'Unit'), q('remaining', 'Remaining'), q('reserved', 'Reserved'), q('backordered', 'Backordered'), q('available_now', 'Available now'), t('backorder_reason', 'Reason'), d('expected_fulfilment_date', 'Expected')] },
  { key: 'DELIVERY_TRACKING', title: 'Delivery Tracking Report', description: 'Consignments dispatched in the period: expected vs actual delivery and the latest event (manually recorded).', dates: 'Dispatch date', filters: SHIPPED, statuses: FULFILMENT_STATUS_LABELS,
    columns: [t('fulfilment_number', 'Consignment'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('fulfilment_status', 'Status', FULFILMENT_STATUS_LABELS), dt('dispatched_at', 'Dispatched'), t('carrier_name', 'Carrier'),
      t('tracking_number', 'Tracking'), t('lr_number', 'LR'), d('expected_delivery_date', 'Expected'), dt('delivered_at', 'Delivered'), n('days_late', 'Days late'), t('last_event', 'Last event'), dt('last_event_at', 'Last event at'), t('exception_reason', 'Exception')] },
  { key: 'OVERDUE_DELIVERY', title: 'Overdue Delivery Report', description: 'Undelivered consignments past their expected delivery date (current).', dates: 'Current (no period)', filters: SHIPPED, statuses: FULFILMENT_STATUS_LABELS,
    columns: [t('fulfilment_number', 'Consignment'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('fulfilment_status', 'Status', FULFILMENT_STATUS_LABELS), dt('dispatched_at', 'Dispatched'), d('expected_delivery_date', 'Expected'),
      n('days_overdue', 'Days overdue'), t('carrier_name', 'Carrier'), t('tracking_number', 'Tracking'), t('last_event', 'Last event'), dt('last_event_at', 'Last event at'), t('exception_reason', 'Exception')] },
  { key: 'RETURNS_REGISTER', title: 'Customer Returns Register', description: 'Return lines by return date with inspection result and disposition.', dates: 'Return date', filters: ALL, statuses: RETURN_STATUS_LABELS,
    columns: [t('return_number', 'Return'), d('return_date', 'Date'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('status', 'Status', RETURN_STATUS_LABELS), t('reason_code', 'Reason', RETURN_REASON_LABELS),
      t('fulfilment_number', 'Consignment'), t('sku', 'SKU'), t('batch_number', 'Batch'), t('unit', 'Unit'), q('requested', 'Requested'), q('received', 'Received'), t('disposition', 'Disposition', DISPOSITION_LABELS),
      { id: 'disposition_posted', header: 'Posted', kind: 'bool' }, t('inspection_note', 'Inspection note')] },
  { key: 'EXCEPTIONS', title: 'Fulfilment Exceptions', description: 'Short picks, damaged/missing items at packing, failed deliveries and cancelled consignments.', dates: 'Exception date', filters: ['customer', 'product', 'warehouse'],
    columns: [d('date', 'Date'), t('exception_type', 'Exception'), t('sales_order_number', 'Order'), t('fulfilment_number', 'Consignment'), t('sku', 'SKU'), q('quantity', 'Quantity'), t('unit', 'Unit'), t('detail', 'Detail')] },
  { key: 'TRACEABILITY', title: 'Order-to-Dispatch Traceability', description: 'Customer PO → sales order → consignment → lot / location → stock issue → delivery and returns.', dates: 'Dispatch date', filters: ['customer', 'product', 'warehouse'],
    columns: [t('customer_po_number', 'Customer PO'), t('source_po_reference', 'PO ref.'), t('source_filename', 'PO file'), t('sales_order_number', 'Order'), t('customer', 'Customer'), t('fulfilment_number', 'Consignment'),
      dt('dispatched_at', 'Dispatched'), t('sku', 'SKU'), t('batch_number', 'Batch'), t('source_type', 'Source'), t('warehouse_code', 'Warehouse'), t('location_code', 'Location'), t('reservation_number', 'Reservation'),
      q('dispatched', 'Dispatched'), t('transaction_number', 'Stock issue'), q('delivered', 'Delivered'), q('returned', 'Returned')] },
  { key: 'PRODUCT_DISPATCH_QTY', title: 'Product Dispatch Quantity', description: 'Dispatched, delivered and returned quantity per product by dispatch date.', dates: 'Dispatch date', filters: ['customer', 'product', 'warehouse'],
    columns: [t('sku', 'SKU'), t('product_name', 'Product'), t('unit', 'Unit'), n('consignments', 'Consignments'), n('orders', 'Orders'), q('dispatched', 'Dispatched'), q('delivered', 'Delivered'), q('returned', 'Returned')] },
  { key: 'WAREHOUSE_PERFORMANCE', title: 'Warehouse Fulfilment Performance', description: 'Consignments dispatched per warehouse, order-to-dispatch time and on-time delivery (where delivery dates exist).', dates: 'Dispatch date', filters: ['customer', 'product', 'warehouse'],
    columns: [t('warehouse_code', 'Warehouse'), t('warehouse_name', 'Name'), n('consignments', 'Consignments'), n('orders', 'Orders'), n('avg_days_order_to_dispatch', 'Avg days order → dispatch'), n('delivered', 'Delivered'),
      n('on_time', 'On time'), n('late', 'Late'), { id: 'on_time_percent', header: 'On-time %', kind: 'pct' }, n('delivery_exceptions', 'Exceptions'), n('open_pick_lists', 'Open pick lists (now)')] },
]

const display = (c: Col, r: Row): ReactNode => {
  const v = r[c.id]
  if (v === null || v === undefined || v === '') return '—'
  switch (c.kind) {
    case 'qty': return formatQty(Number(v))
    case 'date': return formatDate(String(v))
    case 'datetime': return formatDateTime(String(v))
    case 'pct': return `${Number(v)}%`
    case 'bool': return v ? 'Yes' : 'No'
    case 'num': return String(v)
  }
  return c.labels?.[String(v)] ?? String(v)
}
const exportValue = (c: Col, r: Row): CellValue => {
  const v = r[c.id]
  if (v === null || v === undefined) return null
  if (c.kind === 'qty' || c.kind === 'pct' || c.kind === 'num') return Number(v)
  if (c.kind === 'bool') return v ? 'Yes' : 'No'
  if (c.kind === 'datetime') return formatDateTime(String(v))
  return c.labels?.[String(v)] ?? String(v)
}

export default function FulfilmentReportsPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const customers = useAsync(() => (has('customers.read') || has('customer_po.read') ? fetchCustomers(true) : Promise.resolve([])), [])
  const [active, setActive] = useState<FulfilmentReportKey>('SALES_ORDER_REGISTER')
  const [range, setRange] = useState<DateRangeValue>(() => getPresetRange('this_month'))
  const [customer, setCustomer] = useState('all')
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [warehouse, setWarehouse] = useState('all')
  const [status, setStatus] = useState('all')
  const [carrierText, setCarrier] = useState('')
  const carrier = useDebouncedValue(carrierText, 400)
  const [exporting, setExporting] = useState(false)
  const report = REPORTS.find((r) => r.key === active)!
  const has_ = (f: ReportDef['filters'][number]) => report.filters.includes(f)
  const filters = {
    from: toIsoDate(range.from), to: toIsoDate(range.to),
    customerId: has_('customer') && customer !== 'all' ? customer : null,
    productId: has_('product') ? (product?.product_id ?? null) : null,
    warehouseId: has_('warehouse') && warehouse !== 'all' ? warehouse : null,
    status: has_('status') && status !== 'all' && report.statuses?.[status] ? status : null,
    transporter: has_('transporter') && carrier.trim() ? carrier.trim() : null,
  }
  const result = useAsync(() => fetchFulfilmentReport(report.key, filters), [active, JSON.stringify(filters)])

  const columns: DataTableColumn<Row>[] = report.columns.map((c) => ({
    id: c.id, header: c.header, align: c.kind === 'qty' || c.kind === 'pct' || c.kind === 'num' ? 'right' : 'left', cell: (r) => display(c, r),
    searchValue: (r) => String(r[c.id] ?? ''),
    sortValue: (r) => (r[c.id] === null || r[c.id] === undefined ? null : c.kind === 'qty' || c.kind === 'pct' || c.kind === 'num' ? Number(r[c.id]) : String(r[c.id])),
  }))

  const exportReport = async (format: 'xlsx' | 'csv') => {
    if (!result.data) return
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      const rows: CellValue[][] = [report.columns.map((c) => c.header), ...result.data.map((r) => report.columns.map((c) => exportValue(c, r)))]
      await downloadSheets([{ name: report.title.slice(0, 31), rows }], `${report.key.toLowerCase()}-${filters.from}-to-${filters.to}`, format)
    } finally { setExporting(false) }
  }

  return (
    <>
      <PageHeader />
      <div className="grid gap-6 xl:grid-cols-[270px_minmax(0,1fr)]">
        <Card>
          <CardContent className="p-2">
            <nav aria-label="Reports"><ul className="space-y-0.5">
              {REPORTS.map((r, i) => (
                <li key={r.key}><button type="button" aria-current={active === r.key ? 'page' : undefined} onClick={() => setActive(r.key)}
                  className={cn('w-full rounded-md px-3 py-2 text-left text-sm', active === r.key ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted')}>
                  <span className="mr-1.5 text-xs text-muted-foreground">{i + 1}.</span>{r.title}</button></li>
              ))}
            </ul></nav>
          </CardContent>
        </Card>
        <div className="min-w-0 space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div><h2 className="text-base font-semibold">{report.title}</h2><p className="text-sm text-muted-foreground">{report.description} <span className="text-xs">Period applies to: {report.dates}.</span></p></div>
            <PermissionGate permission="fulfilment_reports.export">
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="outline" disabled={exporting || !result.data || result.data.length === 0}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export</Button></DropdownMenuTrigger>
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
              {has_('customer') && (
                <div className="space-y-1"><Label htmlFor="fr-customer">Customer</Label>
                  <Select value={customer} onValueChange={setCustomer}><SelectTrigger id="fr-customer" className="w-52"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all">All customers</SelectItem>{(customers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent></Select></div>
              )}
              {has_('product') && <div className="w-64 space-y-1"><Label htmlFor="fr-product">Product</Label><ProductPicker id="fr-product" value={product} onChange={setProduct} includeInactive /></div>}
              {has_('warehouse') && (
                <div className="space-y-1"><Label htmlFor="fr-wh">Warehouse</Label>
                  <Select value={warehouse} onValueChange={setWarehouse}><SelectTrigger id="fr-wh" className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all">All warehouses</SelectItem>{storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code}</SelectItem>)}</SelectContent></Select></div>
              )}
              {has_('status') && report.statuses && (
                <div className="space-y-1"><Label htmlFor="fr-status">Status</Label>
                  <Select value={report.statuses[status] ? status : 'all'} onValueChange={setStatus}><SelectTrigger id="fr-status" className="w-52"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(report.statuses).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
              )}
              {has_('transporter') && <div className="space-y-1"><Label htmlFor="fr-carrier">Transporter</Label><Input id="fr-carrier" className="w-48" placeholder="Name contains…" value={carrierText} onChange={(e) => setCarrier(e.target.value)} /></div>}
            </CardContent>
          </Card>
          <DataTable columns={columns} data={result.data ?? []} getRowId={(r) => JSON.stringify(Object.values(r).slice(0, 10))} loading={result.loading}
            error={result.error ? new Error(describeDataError(result.error)) : null} onRetry={result.reload} pageSize={25} searchPlaceholder="Search this report…"
            emptyState={{ icon: FileBarChart, title: 'No records', description: 'Nothing matches this report, period and filters.' }} />
        </div>
      </div>
    </>
  )
}
