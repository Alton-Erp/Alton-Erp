import { ArrowLeft, Download, IndianRupee, ListChecks, Loader2, TrendingDown, TrendingUp } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import {
  formatPrice, formatSignedPercent, formatSignedPrice, productTrends, summariseVariance, varianceBySupplier, varianceValue,
} from '@/features/purchasing/grn-price'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { fetchPriceVariance } from '@/services/purchasing'
import type { GoodsReceiptPriceVarianceRow } from '@/types/database-purchasing'

type View = 'CHANGED' | 'INCREASE' | 'DECREASE' | 'ALL'

const signedMoney = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${money(Math.abs(v))}`
const tone = (v: number | null | undefined) => (v && v > 0 ? 'text-red-700' : v && v < 0 ? 'text-green-700' : '')

/** /goods-receipts/price-variance: PO price vs actual purchase price on posted GRNs. */
export default function GrnPriceVariancePage() {
  const navigate = useNavigate()
  const [today] = useState(() => toIsoDate(new Date()))
  const [from, setFrom] = useState(() => toIsoDate(new Date(Date.now() - 90 * 86_400_000)))
  const [to, setTo] = useState(today)
  const [supplier, setSupplier] = useState('ALL')
  const [view, setView] = useState<View>('CHANGED')
  const data = useAsync(() => fetchPriceVariance(from || null, to || null), [from, to])

  const all = useMemo(() => data.data ?? [], [data.data])
  const suppliers = useMemo(() => [...new Map(all.map((r) => [r.supplier_id, r.supplier_name ?? '—'])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all])
  const scoped = useMemo(() => (supplier === 'ALL' ? all : all.filter((r) => r.supplier_id === supplier)), [all, supplier])
  const summary = summariseVariance(scoped)
  const bySupplier = varianceBySupplier(scoped)
  const trends = productTrends(scoped).filter((t) => t.change !== 0 || t.variance !== 0)
  const posted = scoped.filter((r) => r.receipt_status === 'POSTED')
  const diff = (r: GoodsReceiptPriceVarianceRow) => Number(r.price_difference ?? 0)
  const rows = view === 'ALL' ? scoped : posted.filter((r) => r.price_recorded && (view === 'CHANGED' ? diff(r) !== 0 : view === 'INCREASE' ? diff(r) > 0 : diff(r) < 0))
  const num = (v: number | null) => (v === null ? null : Number(v))
  // GRNs posted before prices were recorded: no snapshot, so no PO / actual price is shown for them.
  const notRecorded = <span className="text-xs text-muted-foreground" title="Posted before prices were recorded on the GRN">Not recorded</span>
  const recorded = (r: GoodsReceiptPriceVarianceRow, node: () => ReactNode) => (r.price_recorded ? node() : notRecorded)

  const [exporting, setExporting] = useState(false)
  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([
        { name: 'GRN lines', rows: [
          ['GRN', 'Date', 'Status', 'Supplier', 'PO', 'SKU', 'Item', 'Accepted', 'Prices recorded', 'PO price', 'Actual price', 'Difference', 'Variance %',
            'PO cost after discount', 'Actual cost after discount', 'Value at PO', 'Value at actual', 'Variance value', 'Payable incl. GST', 'Reason'],
          ...rows.map((r) => [r.receipt_number, r.receipt_date, r.receipt_status, r.supplier_name, r.po_number, r.sku, r.description, Number(r.accepted_quantity),
            r.price_recorded ? 'Yes' : 'No (posted before prices were recorded)', num(r.po_unit_price), num(r.actual_unit_price), num(r.price_difference),
            num(r.variance_percent), num(r.po_unit_cost), num(r.actual_unit_cost), num(r.accepted_value_at_po), num(r.accepted_value),
            r.price_recorded ? varianceValue(r) : null, num(r.payable_value), r.price_variance_reason]),
        ] },
        { name: 'By supplier', rows: [['Supplier', 'GRN lines', 'Increases', 'Decreases', 'Variance value'], ...bySupplier.map((s) => [s.supplier, s.lines, s.increases, s.decreases, s.variance])] },
        { name: 'By product', rows: [['SKU', 'Item', 'Receipts', 'First price', 'Latest price', 'Change', 'Change %', 'Variance value'],
          ...trends.map((t) => [t.sku, t.description, t.receipts, t.firstPrice, t.lastPrice, t.change, t.percent, t.variance])] },
      ], `grn-price-variance-${today}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  const columns: DataTableColumn<GoodsReceiptPriceVarianceRow>[] = [
    { id: 'grn', header: 'GRN', cell: (r) => <span className="font-medium">{r.receipt_number}</span>, searchValue: (r) => `${r.receipt_number} ${r.po_number}`, sortValue: (r) => r.receipt_number },
    { id: 'date', header: 'Date', cell: (r) => formatDate(r.receipt_date), sortValue: (r) => r.receipt_date },
    { id: 'supplier', header: 'Supplier', cell: (r) => r.supplier_name ?? '—', searchValue: (r) => r.supplier_name ?? '', sortValue: (r) => r.supplier_name ?? '' },
    { id: 'item', header: 'Item', cell: (r) => <span className="whitespace-normal">{r.sku ? `${r.sku} — ` : ''}{r.description}</span>, searchValue: (r) => `${r.sku ?? ''} ${r.description}`, sortValue: (r) => r.sku ?? r.description },
    { id: 'acc', header: 'Accepted', align: 'right', cell: (r) => formatQty(r.accepted_quantity), sortValue: (r) => Number(r.accepted_quantity) },
    { id: 'po', header: 'PO price', align: 'right', cell: (r) => recorded(r, () => formatPrice(r.po_unit_price)), sortValue: (r) => Number(r.po_unit_price ?? 0) },
    { id: 'actual', header: 'Actual price', align: 'right', cell: (r) => recorded(r, () => formatPrice(r.actual_unit_price)), sortValue: (r) => Number(r.actual_unit_price ?? 0) },
    { id: 'diff', header: 'Difference', align: 'right', cell: (r) => recorded(r, () => <span className={tone(diff(r))}>{formatSignedPrice(diff(r))}</span>), sortValue: (r) => diff(r) },
    { id: 'pct', header: 'Variance %', align: 'right', cell: (r) => recorded(r, () => <span className={tone(diff(r))}>{formatSignedPercent(num(r.variance_percent))}</span>), sortValue: (r) => Number(r.variance_percent ?? 0) },
    { id: 'value', header: 'Variance value', align: 'right', cell: (r) => recorded(r, () => <span className={tone(varianceValue(r))}>{signedMoney(varianceValue(r))}</span>), sortValue: (r) => varianceValue(r) },
    { id: 'payable', header: 'Payable (incl. GST)', align: 'right', cell: (r) => recorded(r, () => (r.payable_value === null ? '—' : money(r.payable_value))), sortValue: (r) => Number(r.payable_value ?? 0) },
    { id: 'reason', header: 'Reason', cell: (r) => <span className="whitespace-normal text-xs">{r.price_variance_reason ?? (r.price_recorded ? '—' : 'Posted before prices were recorded')}</span>, searchValue: (r) => r.price_variance_reason ?? '' },
    { id: 'status', header: 'Status', cell: (r) => <StatusBadge label={r.receipt_status === 'POSTED' ? 'Posted' : 'Reversed'} tone={r.receipt_status === 'POSTED' ? 'success' : 'neutral'} />, sortValue: (r) => r.receipt_status },
  ]

  return (
    <>
      <PageHeader
        title="GRN price variance"
        description="PO price compared with the actual purchase unit cost entered on each goods receipt, as recorded when the goods were received (later PO amendments do not change them). Values exclude GST and use the accepted quantity after the order line's discount. Reversed GRNs, and older GRNs posted before prices were recorded, are excluded from the totals."
        breadcrumbs={[{ label: 'Orders' }, { label: 'Goods Received', to: '/goods-receipts' }, { label: 'Price variance' }]}
        actions={(
          <>
            <Button variant="outline" asChild><Link to="/goods-receipts"><ArrowLeft /> All GRNs</Link></Button>
            <Button variant="outline" onClick={() => void exportExcel()} disabled={exporting || !data.data}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export Excel</Button>
          </>
        )}
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1"><Label htmlFor="pv-from">From</Label><Input id="pv-from" type="date" max={to || today} value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="pv-to">To</Label><Input id="pv-to" type="date" min={from} max={today} value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="pv-supplier">Supplier</Label>
          <Select value={supplier} onValueChange={setSupplier}>
            <SelectTrigger id="pv-supplier" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All suppliers</SelectItem>
              {suppliers.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <section aria-label="Price variance summary" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="pv-kpis">
        <KpiCard label="Price changes" value={data.data ? formatNumber(summary.changed) : null} hint={`of ${formatNumber(summary.lines)} posted GRN lines with recorded prices${summary.notRecorded ? ` · ${formatNumber(summary.notRecorded)} older lines not recorded` : ''}`} icon={ListChecks} />
        <KpiCard label="Increases" value={data.data ? formatNumber(summary.increases) : null} hint="Actual above the PO price" icon={TrendingUp} accent={summary.increases ? 'shortage' : 'neutral'} />
        <KpiCard label="Decreases" value={data.data ? formatNumber(summary.decreases) : null} hint="Actual below the PO price" icon={TrendingDown} accent={summary.decreases ? 'available' : 'neutral'} />
        <KpiCard label="Total variance" value={data.data ? signedMoney(summary.totalVariance) : null} hint={`${money(summary.valueActual)} actual vs ${money(summary.valueAtPo)} at PO price`} icon={IndianRupee} accent={summary.totalVariance > 0 ? 'shortage' : summary.totalVariance < 0 ? 'available' : 'neutral'} />
      </section>

      <div className="mb-6 grid gap-6 2xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader><div><CardTitle>Supplier-wise price changes</CardTitle><CardDescription>Posted GRN lines per supplier; variance value = accepted value at actual − at PO price.</CardDescription></div></CardHeader>
          <Table data-testid="pv-suppliers">
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Supplier</TableHead><TableHead className="text-right">Lines</TableHead><TableHead className="text-right">Increases</TableHead><TableHead className="text-right">Decreases</TableHead><TableHead className="text-right">Variance value</TableHead></TableRow></TableHeader>
            <TableBody>
              {bySupplier.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No posted GRNs in this period.</TableCell></TableRow>}
              {bySupplier.map((s) => (
                <TableRow key={s.supplierId}>
                  <TableCell className="font-medium">{s.supplier}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.lines}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.increases}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.decreases}</TableCell>
                  <TableCell className={`text-right tabular-nums ${tone(s.variance)}`}>{signedMoney(s.variance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader><div><CardTitle>Product-wise price trend</CardTitle><CardDescription>Actual purchase price on the first and latest posted GRN in the period (products whose price moved).</CardDescription></div></CardHeader>
          <Table data-testid="pv-products">
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Item</TableHead><TableHead className="text-right">GRNs</TableHead><TableHead className="text-right">First</TableHead><TableHead className="text-right">Latest</TableHead><TableHead className="text-right">Change</TableHead><TableHead className="text-right">Variance value</TableHead></TableRow></TableHeader>
            <TableBody>
              {trends.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No price movement in this period.</TableCell></TableRow>}
              {trends.map((t) => (
                <TableRow key={t.productId}>
                  <TableCell className="min-w-48 whitespace-normal"><span className="block font-medium whitespace-nowrap">{t.sku}</span><span className="text-xs text-muted-foreground">{t.description}</span></TableCell>
                  <TableCell className="text-right tabular-nums">{t.receipts}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPrice(t.firstPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPrice(t.lastPrice)}</TableCell>
                  <TableCell className={`text-right tabular-nums ${tone(t.change)}`}>{formatSignedPrice(t.change)} <span className="text-xs">({formatSignedPercent(t.percent)})</span></TableCell>
                  <TableCell className={`text-right tabular-nums ${tone(t.variance)}`}>{signedMoney(t.variance)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>

      <FilterTabs label="Lines shown" className="mb-3" value={view} onChange={setView} options={[
        { value: 'CHANGED', label: 'Price changed', count: summary.changed },
        { value: 'INCREASE', label: 'Increases', count: summary.increases },
        { value: 'DECREASE', label: 'Decreases', count: summary.decreases },
        { value: 'ALL', label: 'All lines (incl. reversed)', count: scoped.length },
      ]} />
      <DataTable
        title="GRN lines"
        columns={columns}
        data={rows}
        getRowId={(r) => r.goods_receipt_line_id}
        loading={data.loading}
        error={data.error ? new Error(describeDataError(data.error)) : null}
        onRetry={data.reload}
        onRowClick={(r) => navigate(`/goods-receipts/${r.goods_receipt_id}`)}
        searchPlaceholder="Search GRN, PO, supplier, item, reason…"
        pageSize={25}
        emptyState={{ icon: ListChecks, title: view === 'ALL' ? 'No goods received in this period' : 'No price changes in this period', description: 'Change the dates or supplier, or show all lines.' }}
      />
    </>
  )
}
