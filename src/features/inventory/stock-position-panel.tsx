import { AlertTriangle, ChevronDown, ChevronRight, ClipboardList, Download, Factory, Loader2, PackageSearch, Scale, SearchX, Table2, Truck } from 'lucide-react'
import { Fragment, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PaginationBar } from '@/components/common/pagination-bar'
import { SortableHead } from '@/components/common/sortable-head'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { StockStatusBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import {
  INDICATOR_LABELS, PROBLEM_LABELS, indicators, reconciliationSheet, sortPositions, stockPositionSheet, type Indicator, type PositionSortKey,
} from '@/features/inventory/stock-position-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchStockPosition, fetchStockPositionDetail, fetchStockReconciliation, type StockPositionFilters, type StockPositionRow } from '@/services/inventory'

export type PositionView = 'all' | 'low' | 'shortage' | 'pending' | 'discrepancy'

const INDICATOR_STYLE: Record<Indicator, { icon: typeof AlertTriangle; className: string }> = {
  LOW: { icon: AlertTriangle, className: 'text-amber-700' },
  SHORTAGE: { icon: Factory, className: 'text-shortage' },
  PENDING_PO: { icon: Truck, className: 'text-blue-700' },
  DISCREPANCY: { icon: Scale, className: 'text-violet-700' },
}

/**
 * Stock register by product: on hand, reserved, available, pending purchase
 * orders, expected incoming, BOM requirement and shortage, with indicators,
 * expandable details, Excel export and the stock reconciliation.
 */
export function StockPositionPanel({ filters, stockStatus, onClearFilters, filtersActive }: {
  filters: StockPositionFilters
  /** Stock status chosen in the page filters ('all' = any). */
  stockStatus: string
  onClearFilters: () => void
  filtersActive: boolean
}) {
  const { has } = usePermissions()
  const [view, setView] = useState<PositionView>('all')
  const [sort, setSort] = useState<{ column: PositionSortKey; ascending: boolean }>({ column: 'sku', ascending: true })
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const [open, setOpen] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const key = JSON.stringify(filters)
  const data = useAsync(() => fetchStockPosition(filters), [key])
  const [lastKey, setLastKey] = useState(key + view + stockStatus)
  if (lastKey !== key + view + stockStatus) {
    setLastKey(key + view + stockStatus)
    setPage(0)
  }

  const all = useMemo(() => (data.data?.rows ?? []).filter((r) => stockStatus === 'all' || r.stock_status === stockStatus), [data.data, stockStatus])
  const counts = useMemo(() => ({
    low: all.filter((r) => r.low_stock).length,
    shortage: all.filter((r) => Number(r.bom_shortage_quantity) > 0).length,
    pending: all.filter((r) => Number(r.pending_po_quantity) > 0).length,
    discrepancy: all.filter((r) => r.discrepancy).length,
  }), [all])
  const shown = sortPositions(all.filter((r) => view === 'all' || (view === 'low' ? r.low_stock : view === 'shortage' ? Number(r.bom_shortage_quantity) > 0
    : view === 'pending' ? Number(r.pending_po_quantity) > 0 : r.discrepancy)), sort.column, sort.ascending)
  const pageRows = shown.slice(page * pageSize, page * pageSize + pageSize)

  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: 'Stock register', rows: stockPositionSheet(shown) }], `stock-register-${toIsoDate(new Date())}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  const qty = (v: number, unit?: string) => (Number(v) === 0 ? <span className="text-muted-foreground">0</span> : formatQty(v, unit))

  return (
    <>
      <div className="flex flex-col gap-3 border-b px-5 py-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterTabs<PositionView> label="Show" value={view} onChange={setView} options={[
          { value: 'all', label: `All (${all.length})` },
          { value: 'low', label: `Low stock (${counts.low})` },
          { value: 'shortage', label: `BOM shortage (${counts.shortage})` },
          { value: 'pending', label: `Pending PO (${counts.pending})` },
          { value: 'discrepancy', label: `Discrepancy (${counts.discrepancy})` },
        ]} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setReconciling(true)}><Scale /> Stock reconciliation</Button>
          {has('inventory.export') && (
            <Button variant="outline" size="sm" disabled={exporting || shown.length === 0} onClick={() => void exportExcel()}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />} Excel
            </Button>
          )}
        </div>
      </div>

      {data.loading && !data.data ? <LoadingState variant="table" rows={6} />
        : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : shown.length === 0 ? (
          filtersActive || view !== 'all'
            ? <EmptyState icon={SearchX} title="Nothing matches" description="Try a different search or clear the filters."
                action={<Button variant="outline" size="sm" onClick={() => { setView('all'); onClearFilters() }}>Clear filters</Button>} />
            : <EmptyState icon={Table2} title="No active products" description="Stock appears here once opening stock or receipts are posted." />
        ) : (
          <div className={data.loading ? 'opacity-60 transition-opacity' : undefined} aria-busy={data.loading}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="w-8"><span className="sr-only">Details</span></TableHead>
                  <SortableHead column="sku" label="Product" sort={sort} onSort={setSort} />
                  <SortableHead column="on_hand" label="On hand" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="reserved" label="Reserved" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="available" label="Available" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="pending_po_quantity" label="Pending PO" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="expected_incoming_quantity" label="Expected in" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="bom_required_quantity" label="BOM required" sort={sort} onSort={setSort} align="right" />
                  <SortableHead column="bom_shortage_quantity" label="BOM shortage" sort={sort} onSort={setSort} align="right" />
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((r) => {
                  const isOpen = open === r.product_id
                  return (
                    <Fragment key={r.product_id}>
                      <TableRow className={cn('cursor-pointer', isOpen && 'bg-muted/40')} onClick={() => setOpen(isOpen ? null : r.product_id)}>
                        <TableCell>
                          <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} details of ${r.sku}`}
                            onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : r.product_id) }} className="rounded p-0.5 text-muted-foreground hover:text-foreground">
                            {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </TableCell>
                        <TableCell className="min-w-48 whitespace-normal">
                          <Link to={`/inventory/stock/${r.product_id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-primary hover:underline">{r.sku}</Link>
                          <span className="block text-xs text-muted-foreground">{r.product_name} · {r.unit}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.on_hand)}</TableCell>
                        <TableCell className="text-right tabular-nums text-amber-800">{qty(r.reserved)}</TableCell>
                        <TableCell className={cn('text-right font-medium tabular-nums', r.low_stock ? 'text-amber-700' : 'text-green-700')}>{qty(r.available)}</TableCell>
                        <TableCell className="text-right tabular-nums text-blue-700">{qty(r.pending_po_quantity)}
                          {Number(r.open_po_count) > 0 && <span className="block text-xs text-muted-foreground">{r.open_po_count} PO</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.expected_incoming_quantity)}</TableCell>
                        <TableCell className="text-right tabular-nums">{qty(r.bom_required_quantity)}</TableCell>
                        <TableCell className={cn('text-right tabular-nums', Number(r.bom_shortage_quantity) > 0 && 'font-semibold text-shortage')}>{qty(r.bom_shortage_quantity)}</TableCell>
                        <TableCell>
                          <span className="flex flex-wrap items-center gap-1.5">
                            {r.stock_status && <StockStatusBadge status={r.stock_status} />}
                            {indicators(r).map((i) => {
                              const S = INDICATOR_STYLE[i]
                              return <span key={i} role="img" aria-label={INDICATOR_LABELS[i]} title={INDICATOR_LABELS[i]} data-indicator={i}><S.icon aria-hidden className={cn('size-4', S.className)} /></span>
                            })}
                          </span>
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={10} className="bg-muted/20 p-0 whitespace-normal">
                            <PositionDetail row={r} warehouseId={filters.warehouse_id ?? null} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
            <PaginationBar page={page} pageSize={pageSize} total={shown.length} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(0) }} />
          </div>
        )}
      <p className="border-t px-5 py-3 text-xs text-muted-foreground">
        Available = on hand in storage − reserved. Pending PO = ordered − accepted on posted GRNs of open orders (never part of on hand). Expected incoming = pending PO + pending
        production output. BOM required = material still to issue to open production orders (BOM incl. wastage) not yet reserved; BOM shortage = BOM required − available, not below 0.
        A discrepancy means a balance differs from the sum of its stock ledger movements.{data.data ? ` Calculated ${formatDateTime(data.data.as_of)}.` : ''}
      </p>
      {reconciling && <ReconciliationDialog onClose={() => setReconciling(false)} />}
    </>
  )
}

function Section({ title, icon: Icon, children, empty }: { title: string; icon: typeof AlertTriangle; children: ReactNode; empty: boolean }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background p-3">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"><Icon className="size-3.5" /> {title}</p>
      {empty ? <p className="text-xs text-muted-foreground">None.</p> : children}
    </div>
  )
}

function PositionDetail({ row, warehouseId }: { row: StockPositionRow; warehouseId: string | null }) {
  const d = useAsync(() => fetchStockPositionDetail(row.product_id, warehouseId), [row.product_id, warehouseId])
  if (d.loading && !d.data) return <p className="px-5 py-4 text-sm text-muted-foreground">Loading details…</p>
  if (d.error || !d.data) return <p className="px-5 py-4 text-sm text-shortage">{describeDataError(d.error)}</p>
  const x = d.data
  const u = row.unit
  return (
    // Pinned to the visible part of the (horizontally scrollable) table.
    <div className="sticky left-0 grid w-[calc(100vw-3rem)] gap-3 px-5 py-4 md:grid-cols-2 lg:w-[calc(100vw-22rem)] xl:grid-cols-3" data-testid={`position-detail-${row.sku}`}>
      <Section title="Warehouse & location" icon={PackageSearch} empty={x.locations.length === 0}>
        <ul className="space-y-1 text-xs">{x.locations.map((l, i) => (
          <li key={i} className="flex justify-between gap-2">
            <span>{l.warehouse_code} / {l.location_code}{l.batch_number ? ` · ${l.batch_number}` : ''}{l.stock_usage !== 'STORAGE' && <span className="text-muted-foreground"> ({l.stock_usage.toLowerCase()})</span>}</span>
            <span className="tabular-nums">{formatQty(l.on_hand, u)}{Number(l.reserved) > 0 && <span className="text-amber-800"> · {formatQty(l.reserved)} res.</span>}
              {Number(l.ledger_on_hand) !== Number(l.on_hand) && <span className="font-medium text-violet-700"> · ledger {formatQty(l.ledger_on_hand)}</span>}</span>
          </li>))}</ul>
      </Section>
      {x.purchase_orders !== null && (
        <Section title="Open purchase orders" icon={ClipboardList} empty={x.purchase_orders.length === 0}>
          <ul className="space-y-1 text-xs">{x.purchase_orders.map((p) => (
            <li key={p.id} className="flex justify-between gap-2">
              <span><Link className="font-medium text-primary hover:underline" to={`/purchase-orders/${p.id}`}>{p.po_number}</Link> · {p.supplier}{p.expected ? ` · due ${formatDate(p.expected)}` : ''}</span>
              <span className="tabular-nums text-blue-700">{formatQty(p.pending, u)} of {formatQty(p.ordered)}</span>
            </li>))}</ul>
        </Section>
      )}
      {x.goods_receipts !== null && (
        <Section title="Recent goods receipts" icon={Truck} empty={x.goods_receipts.length === 0}>
          <ul className="space-y-1 text-xs">{x.goods_receipts.map((g) => (
            <li key={g.id + g.date} className="flex justify-between gap-2">
              <span><Link className="font-medium text-primary hover:underline" to={`/goods-receipts/${g.id}`}>{g.receipt_number}</Link> · {formatDate(g.date)}
                {g.po_number ? ` · ${g.po_number}` : ''}{g.supplier_invoice_number ? ` · inv ${g.supplier_invoice_number}` : ''}{g.status === 'REVERSED' && <StatusBadge label="Reversed" tone="neutral" />}</span>
              <span className="tabular-nums">{formatQty(g.accepted, u)}{Number(g.rejected) > 0 && <span className="text-red-700"> · {formatQty(g.rejected)} rej.</span>}</span>
            </li>))}</ul>
        </Section>
      )}
      {x.production_orders !== null && (
        <Section title="Production orders" icon={Factory} empty={x.production_orders.length === 0}>
          <ul className="space-y-1 text-xs">{x.production_orders.map((o) => (
            <li key={o.id + o.role} className="flex justify-between gap-2">
              <span><Link className="font-medium text-primary hover:underline" to={`/production/orders/${o.id}`}>{o.production_order_number}</Link> · {o.role === 'OUTPUT' ? 'makes it' : 'uses it'}</span>
              <span className="tabular-nums">{o.role === 'OUTPUT' ? `${formatQty(o.pending ?? 0, u)} to come` : `${formatQty(o.planned, u)} planned · ${formatQty(o.issued ?? 0)} issued · ${formatQty(o.reserved ?? 0)} res.`}</span>
            </li>))}</ul>
        </Section>
      )}
      {x.bom_components !== null && (
        <Section title="BOM components (active version)" icon={Factory} empty={x.bom_components.length === 0 && (x.used_in?.length ?? 0) === 0}>
          <ul className="space-y-1 text-xs">
            {x.bom_components.map((c) => (
              <li key={c.sku} className="flex justify-between gap-2"><span>{c.sku} — {c.product_name}</span>
                <span className="tabular-nums">{formatQty(c.quantity_per_output, c.unit)} per {formatQty(c.output_quantity)}{Number(c.wastage_percentage) > 0 ? ` +${Number(c.wastage_percentage)}%` : ''}</span></li>))}
            {(x.used_in ?? []).map((c) => (
              <li key={`u-${c.sku}-${c.version}`} className="flex justify-between gap-2"><span className="text-muted-foreground">Used in {c.sku} ({c.bom_code} v{c.version})</span>
                <span className="tabular-nums">{formatQty(c.quantity_per_output, u)} per {formatQty(c.output_quantity)}{Number(c.wastage_percentage) > 0 ? ` +${Number(c.wastage_percentage)}%` : ''}</span></li>))}
          </ul>
        </Section>
      )}
    </div>
  )
}

function ReconciliationDialog({ onClose }: { onClose: () => void }) {
  const rec = useAsync(() => fetchStockReconciliation(null), [])
  const [exporting, setExporting] = useState(false)
  const rows = rec.data?.rows ?? []
  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: 'Stock reconciliation', rows: reconciliationSheet(rows) }], `stock-reconciliation-${toIsoDate(new Date())}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Stock reconciliation</DialogTitle>
          <DialogDescription>Every lot and location is checked: balance = sum of stock ledger movements, reserved = active reservations, no negative or over-reserved stock. Read only; nothing is changed.</DialogDescription>
        </DialogHeader>
        {rec.loading ? <LoadingState rows={3} /> : rec.error ? <ErrorState message={describeDataError(rec.error)} onRetry={rec.reload} /> : rec.data && (
          <div className="space-y-3">
            <p role="status" className={cn('rounded-lg border px-3 py-2 text-sm', rows.length === 0 ? 'border-green-200 bg-green-50 text-green-800' : 'border-red-200 bg-red-50 text-red-800')}>
              {rows.length === 0
                ? `No discrepancies: ${rec.data.checked_lots} lot / location balances agree with ${rec.data.checked_movements} ledger movements.`
                : `${rows.length} discrepanc${rows.length === 1 ? 'y' : 'ies'} found in ${rec.data.checked_lots} lot / location balances.`}
              {' '}Checked {formatDateTime(rec.data.as_of)}.
            </p>
            {rows.length > 0 && (
              <>
                <Table>
                  <TableHeader><TableRow className="hover:bg-transparent">
                    <TableHead>Product</TableHead><TableHead>Where</TableHead><TableHead className="text-right">Balance</TableHead><TableHead className="text-right">Ledger</TableHead>
                    <TableHead className="text-right">Reserved / reservations</TableHead><TableHead>Problem</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>{rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell><span className="font-medium">{r.sku}</span><span className="block text-xs text-muted-foreground">{r.product_name}</span></TableCell>
                      <TableCell className="text-xs">{r.warehouse_code} / {r.location_code}{r.batch_number ? ` · ${r.batch_number}` : ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.on_hand === null ? '—' : formatQty(r.on_hand, r.unit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatQty(r.ledger_on_hand)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.reserved === null ? '—' : formatQty(r.reserved)} / {formatQty(r.active_reservations)}</TableCell>
                      <TableCell className="text-xs text-shortage">{r.problems.map((p) => PROBLEM_LABELS[p] ?? p).join('; ')}</TableCell>
                    </TableRow>))}</TableBody>
                </Table>
                <Button variant="outline" size="sm" disabled={exporting} onClick={() => void exportExcel()}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel</Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
