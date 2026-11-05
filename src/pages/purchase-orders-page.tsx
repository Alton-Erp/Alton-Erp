import {
  Ban, CheckCircle2, ClipboardList, Clock, Download, FileEdit, IndianRupee, Loader2, PackageCheck, PackageOpen, Plus, Send, Truck, X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { PoStatusBadge } from '@/features/purchasing/po-components'
import { OPEN_PO_STATUSES, PO_STATUS_LABELS, PO_STATUSES, PURCHASE_TYPE_LABELS, poExportRows } from '@/features/purchasing/po-model'
import { useAsync } from '@/hooks/use-async'
import { useDrill, useUrlDateRange } from '@/features/drilldown/use-drill'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { fetchDisplayNames } from '@/services/products'
import { fetchPoDashboard, fetchPurchaseOrders, PO_LIST_LIMIT } from '@/services/purchasing'
import type { PurchaseOrderListRow, PurchaseType } from '@/types/database-purchasing'

interface Filters {
  status: string
  supplier: string
  createdBy: string
  type: string
  product: string
  poFrom: string
  poTo: string
  expFrom: string
  expTo: string
}
const NO_FILTERS: Filters = { status: 'all', supplier: 'all', createdBy: 'all', type: 'all', product: '', poFrom: '', poTo: '', expFrom: '', expTo: '' }

/**
 * Supplier purchase orders: dashboard figures from the database (never
 * hard-coded) and the order register with filters. Orders are created,
 * approved and received on their own pages.
 */
export default function PurchaseOrdersPage() {
  const { has } = usePermissions()
  const navigate = useNavigate()
  const location = useLocation()
  // Period and register filters live in the address, so Back from an order returns to the same list.
  const [period, setPeriod] = useUrlDateRange('this_month')
  const [params, setParams] = useSearchParams()
  const f: Filters = useMemo(() => Object.fromEntries((Object.keys(NO_FILTERS) as (keyof Filters)[])
    .map((k) => [k, params.get(`f_${k}`) ?? NO_FILTERS[k]])) as unknown as Filters, [params])
  const setF = (next: Filters | ((x: Filters) => Filters)) => {
    const v = typeof next === 'function' ? next(f) : next
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      for (const k of Object.keys(NO_FILTERS) as (keyof Filters)[]) {
        if (v[k] === NO_FILTERS[k]) p.delete(`f_${k}`)
        else p.set(`f_${k}`, v[k])
      }
      return p
    }, { replace: true })
  }
  const set = (k: keyof Filters) => (val: string) => setF((x) => ({ ...x, [k]: val }))
  const { href } = useDrill('purchase_orders')
  const periodCtx = { from: toIsoDate(period.from), to: toIsoDate(period.to) }
  const [notice, setNotice] = useState<string | null>((location.state as { message?: string } | null)?.message ?? null)

  const orders = useAsync(() => fetchPurchaseOrders(), [])
  const dash = useAsync(() => fetchPoDashboard(toIsoDate(period.from), toIsoDate(period.to)), [period.from.getTime(), period.to.getTime()])
  const all = useMemo(() => orders.data ?? [], [orders.data])
  const names = useAsync(() => fetchDisplayNames(all.map((o) => o.created_by)), [all])
  const [today] = useState(() => toIsoDate(new Date()))

  const suppliers = useMemo(() => [...new Map(all.map((o) => [o.supplier_id, `${o.supplier_code} — ${o.supplier_name}`])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all])
  const creators = useMemo(() => [...new Set(all.map((o) => o.created_by).filter((x): x is string => Boolean(x)))], [all])
  const product = f.product.trim().toLowerCase()
  const rows = all.filter((o) =>
    (f.status === 'all' || (f.status === 'OPEN' ? OPEN_PO_STATUSES.includes(o.status) : o.status === f.status))
    && (f.supplier === 'all' || o.supplier_id === f.supplier)
    && (f.createdBy === 'all' || o.created_by === f.createdBy)
    && (f.type === 'all' || o.purchase_type === f.type)
    && (!product || o.skus.toLowerCase().includes(product))
    && (!f.poFrom || o.po_date >= f.poFrom) && (!f.poTo || o.po_date <= f.poTo)
    && (!f.expFrom || (o.expected_delivery_date ?? '') >= f.expFrom) && (!f.expTo || (o.expected_delivery_date !== null && o.expected_delivery_date <= f.expTo)))
  const filtersActive = JSON.stringify(f) !== JSON.stringify(NO_FILTERS)
  const [exporting, setExporting] = useState(false)
  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: 'Purchase orders', rows: poExportRows(rows) }], `purchase-orders-${today}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  const d = dash.data
  const kpi = (n: number | undefined) => (dash.loading || dash.error || n === undefined ? null : formatNumber(n))
  const count = (s: string) => kpi(d ? (d.by_status[s] ?? 0) : undefined)

  const columns: DataTableColumn<PurchaseOrderListRow>[] = [
    {
      id: 'po', header: 'PO No.', sortValue: (o) => o.po_number,
      searchValue: (o) => [o.po_number, o.reference_number, o.supplier_invoice_number, o.supplier_challan_number, o.receipt_invoice_numbers, o.receipt_challan_numbers].filter(Boolean).join(' '),
      cell: (o) => (
        <div className="whitespace-nowrap">
          <Link to={`/purchase-orders/${o.id}`} className="font-medium text-foreground hover:underline" onClick={(e) => e.stopPropagation()}>{o.po_number}</Link>
          {o.revision > 0 && <span className="ml-1 text-xs text-muted-foreground">rev {o.revision}</span>}
          {o.reference_number && <p className="text-xs text-muted-foreground">Ref {o.reference_number}</p>}
          {(o.supplier_invoice_number || o.supplier_challan_number) && (
            <p className="text-xs text-muted-foreground">{[o.supplier_invoice_number && `Inv ${o.supplier_invoice_number}`, o.supplier_challan_number && `DC ${o.supplier_challan_number}`].filter(Boolean).join(' · ')}</p>
          )}
        </div>
      ),
    },
    { id: 'supplier', header: 'Supplier', className: 'min-w-44 whitespace-normal', sortValue: (o) => o.supplier_name.toLowerCase(), searchValue: (o) => `${o.supplier_name} ${o.supplier_code}`,
      cell: (o) => <div><p className="font-medium">{o.supplier_name}</p><p className="text-xs text-muted-foreground">{o.supplier_code} · {PURCHASE_TYPE_LABELS[o.purchase_type]}</p></div> },
    { id: 'date', header: 'PO date', sortValue: (o) => o.po_date, cell: (o) => <span className="whitespace-nowrap">{formatDate(o.po_date)}</span> },
    {
      id: 'expected', header: 'Expected', sortValue: (o) => o.expected_delivery_date,
      cell: (o) => (o.expected_delivery_date ? (
        <span className="whitespace-nowrap">
          {formatDate(o.expected_delivery_date)}
          {OPEN_PO_STATUSES.includes(o.status) && o.expected_delivery_date < today && <span className="ml-1 rounded bg-red-50 px-1 text-xs font-medium text-red-700">Overdue</span>}
        </span>
      ) : '—'),
    },
    { id: 'wh', header: 'Deliver to', cell: (o) => o.warehouse_code ?? '—', searchValue: (o) => o.warehouse_code ?? '' },
    { id: 'qty', header: 'Ordered / accepted', align: 'right', cell: (o) => <span className="whitespace-nowrap tabular-nums">{formatQty(o.total_ordered_quantity)} / {formatQty(o.total_accepted_quantity)}</span> },
    { id: 'total', header: 'Total', align: 'right', sortValue: (o) => Number(o.grand_total), cell: (o) => <span className="tabular-nums">{money(o.grand_total)}</span> },
    { id: 'pending', header: 'Pending value', align: 'right', sortValue: (o) => Number(o.pending_value),
      cell: (o) => (OPEN_PO_STATUSES.includes(o.status) ? <span className="tabular-nums">{money(o.pending_value)}</span> : <span className="text-muted-foreground">—</span>) },
    { id: 'status', header: 'Status', sortValue: (o) => o.status, cell: (o) => <PoStatusBadge status={o.status} /> },
  ]

  return (
    <>
      <PageHeader
        description="Purchase orders placed with suppliers: ordered, received and pending quantities, and goods received into stock."
        actions={(
          <>
            <Button variant="outline" asChild><Link to="/goods-receipts"><PackageCheck /> Goods received</Link></Button>
            {has('purchase_order.create') && <Button asChild><Link to="/purchase-orders/new"><Plus /> New Purchase Order</Link></Button>}
          </>
        )}
      />

      {notice && (
        <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss message" className="rounded p-0.5 opacity-70 hover:opacity-100" onClick={() => setNotice(null)}><X className="size-4" /></button>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Current position</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Order value period:</span>
          <DateRangeFilter value={period} onChange={setPeriod} />
        </div>
      </div>
      {dash.error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">Dashboard figures could not be loaded: {describeDataError(dash.error)}</p>}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <KpiCard to={href('purchase.total')} label="Total purchase orders" value={kpi(d?.total)} icon={ClipboardList} />
        <KpiCard to={href('purchase.status', { segment: 'DRAFT' })} label="Draft" value={count('DRAFT')} icon={FileEdit} />
        <KpiCard to={href('purchase.status', { segment: 'PENDING_APPROVAL' })} label="Pending approval" value={count('PENDING_APPROVAL')} icon={Clock} accent="pending" />
        <KpiCard to={href('purchase.status', { segment: 'APPROVED' })} label="Approved, not sent" value={count('APPROVED')} icon={CheckCircle2} accent="manufacturing" />
        <KpiCard to={href('purchase.open')} label="Open (awaiting goods)" value={kpi(d?.open)} icon={Send} accent="manufacturing" hint={d && d.overdue > 0 ? `${d.overdue} past expected delivery` : 'Approved, sent or partially received'} />
        <KpiCard to={href('purchase.status', { segment: 'PARTIALLY_RECEIVED' })} label="Partially received" value={count('PARTIALLY_RECEIVED')} icon={PackageOpen} accent="pending" />
        <KpiCard to={href('purchase.status', { segment: 'RECEIVED' })} label="Fully received" value={count('RECEIVED')} icon={PackageCheck} accent="available" hint={d?.by_status.CLOSED ? `${d.by_status.CLOSED} short-closed` : undefined} />
        <KpiCard to={href('purchase.status', { segment: 'CANCELLED' })} label="Cancelled" value={count('CANCELLED')} icon={Ban} accent="shortage" />
        <KpiCard to={href('purchase.period', periodCtx)} label="Approved PO value" value={dash.loading || !d ? null : money(d.period_value)} icon={IndianRupee}
          hint={d ? `${d.period_orders} order(s) dated in the period, incl. GST` : undefined} />
        <KpiCard to={href('purchase.pending_value')} label="Outstanding receipt value" value={dash.loading || !d ? null : money(d.outstanding_receipt_value)} icon={Truck} accent="pending"
          hint="Pending quantities of open orders × order price, incl. GST" />
      </div>

      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect id="f-status" label="Status" value={f.status} onChange={set('status')}
            options={[['all', 'All statuses'], ['OPEN', 'Open (awaiting goods)'], ...PO_STATUSES.map((s) => [s, PO_STATUS_LABELS[s]] as [string, string])]} />
          <FilterSelect id="f-supplier" label="Supplier" value={f.supplier} onChange={set('supplier')} options={[['all', 'All suppliers'], ...suppliers]} />
          <FilterSelect id="f-type" label="Purchase type" value={f.type} onChange={set('type')}
            options={[['all', 'All types'], ...Object.entries(PURCHASE_TYPE_LABELS) as [PurchaseType, string][]]} />
          <FilterSelect id="f-created" label="Created by" value={f.createdBy} onChange={set('createdBy')}
            options={[['all', 'Anyone'], ...creators.map((c) => [c, names.data?.get(c) ?? 'User'] as [string, string])]} />
          <div className="space-y-1"><Label htmlFor="f-product">Product or SKU</Label><Input id="f-product" value={f.product} onChange={(e) => set('product')(e.target.value)} placeholder="e.g. WB-101" /></div>
          <DateRange idPrefix="f-po" label="PO date" from={f.poFrom} to={f.poTo} onFrom={set('poFrom')} onTo={set('poTo')} />
          <DateRange idPrefix="f-exp" label="Expected delivery" from={f.expFrom} to={f.expTo} onFrom={set('expFrom')} onTo={set('expTo')} />
          <div className="flex items-end">{filtersActive && <Button variant="ghost" onClick={() => setF(NO_FILTERS)}>Clear filters</Button>}</div>
        </div>
      </Card>

      <DataTable
        title="Purchase orders"
        description={all.length >= PO_LIST_LIMIT ? `Showing the latest ${PO_LIST_LIMIT} orders; use the filters to narrow down.` : undefined}
        columns={columns}
        data={rows}
        getRowId={(o) => o.id}
        onRowClick={(o) => navigate(`/purchase-orders/${o.id}`)}
        loading={orders.loading}
        error={orders.error ? new Error(describeDataError(orders.error)) : null}
        onRetry={orders.reload}
        pageSize={25}
        searchPlaceholder="Search PO no., reference, supplier, invoice, challan…"
        toolbar={has('purchase_order.export') ? (
          <Button variant="outline" size="sm" disabled={exporting || rows.length === 0} onClick={() => void exportExcel()}>
            {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel
          </Button>
        ) : undefined}
        emptyState={all.length === 0
          ? { icon: ClipboardList, title: 'No purchase orders yet', description: 'Purchase orders you raise with suppliers will be listed here.',
              action: has('purchase_order.create') ? <Button size="sm" asChild><Link to="/purchase-orders/new"><Plus /> New Purchase Order</Link></Button> : undefined }
          : { icon: ClipboardList, title: 'No orders match these filters', description: 'Change or clear the filters to see more orders.' }}
      />
    </>
  )
}

function FilterSelect({ id, label, value, onChange, options }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-72">{options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  )
}

function DateRange({ idPrefix, label, from, to, onFrom, onTo }: { idPrefix: string; label: string; from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <fieldset className="min-w-0 space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex items-center gap-1.5">
        <Input id={`${idPrefix}-from`} type="date" className="min-w-0 px-2" aria-label={`${label} from`} value={from} onChange={(e) => onFrom(e.target.value)} />
        <span aria-hidden className="text-muted-foreground">–</span>
        <Input id={`${idPrefix}-to`} type="date" className="min-w-0 px-2" aria-label={`${label} to`} value={to} onChange={(e) => onTo(e.target.value)} />
      </div>
    </fieldset>
  )
}
