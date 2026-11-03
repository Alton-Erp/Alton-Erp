import { Camera, Info, Loader2, PackageSearch, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AVAILABILITY_EXPORT, SOURCE_SPLIT_EXPORT } from '@/features/customer-po/export-columns'
import { AvailabilityBadge } from '@/features/customer-po/po-badges'
import { ExportMenu } from '@/features/customer-po/po-export'
import { NoPoSelected, PoContextBar } from '@/features/customer-po/po-picker'
import { usePoSelection } from '@/features/customer-po/use-po-selection'
import { StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchLineStock, fetchPoAnalysis, fetchSnapshots, refreshAnalysis, type AnalysisLine } from '@/services/customer-po'

/** In-house / outsourced / total table for one line (values from the database). */
export function SourceSplitTable({ line }: { line: AnalysisLine }) {
  const u = line.line_unit ?? line.base_unit ?? ''
  const rows: [string, number | null, number | null, number | null][] = [
    ['On-hand stock', line.in_house_on_hand, line.outsourced_on_hand, line.on_hand],
    ['Existing reservations', line.in_house_reserved, line.outsourced_reserved, line.reserved],
    ['Available stock', line.in_house_available, line.outsourced_available, line.available],
  ]
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr><th className="pb-1 text-left">Metric ({u})</th><th className="pb-1 text-right text-blue-700">In-house</th><th className="pb-1 text-right text-violet-700">Outsourced</th><th className="pb-1 text-right">Total</th></tr>
      </thead>
      <tbody>
        {rows.map(([label, ih, os, total]) => (
          <tr key={label} className="border-t">
            <td className="py-1">{label}</td>
            <td className="py-1 text-right tabular-nums">{formatQty(ih)}</td>
            <td className="py-1 text-right tabular-nums">{formatQty(os)}</td>
            <td className="py-1 text-right font-medium tabular-nums">{formatQty(total)}</td>
          </tr>
        ))}
        <tr className="border-t"><td className="py-1">Allocated to this PO line</td><td colSpan={2} className="py-1 text-right text-xs text-muted-foreground">by lot (see Allocation & Reservations)</td><td className="py-1 text-right font-medium tabular-nums">{formatQty(line.allocated_open)}</td></tr>
        <tr className="border-t"><td className="py-1">Remaining availability after this line</td><td colSpan={2} /><td className="py-1 text-right font-medium tabular-nums">{formatQty(Math.max(Number(line.available) - Number(line.available_for_line), 0))}</td></tr>
        <tr className="border-t"><td className="py-1">Unfulfilled quantity</td><td colSpan={2} /><td className="py-1 text-right font-medium tabular-nums text-shortage">{formatQty(line.shortage_after)}</td></tr>
      </tbody>
    </table>
  )
}

function LineStockDialog({ line, onClose }: { line: AnalysisLine; onClose: () => void }) {
  const stock = useAsync(() => fetchLineStock(line.line_id), [line.line_id])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Line {line.line_no}: {line.sku} — {line.product_name}</DialogTitle>
          <DialogDescription>Stock by warehouse, location, lot and actual source. Ineligible stock is listed with the reason it cannot be allocated.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="max-h-[60vh] overflow-auto rounded-lg border">
            {stock.loading ? <p className="p-3 text-sm text-muted-foreground">Loading…</p> : stock.error ? <p className="p-3 text-sm text-shortage">{describeDataError(stock.error)}</p> : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-muted text-xs text-muted-foreground">
                  <tr><th className="p-2 text-left">Warehouse / location</th><th className="p-2 text-left">Lot</th><th className="p-2 text-left">Source</th><th className="p-2 text-right">On hand</th><th className="p-2 text-right">Reserved</th><th className="p-2 text-right">Available</th><th className="p-2 text-left">Eligibility</th></tr>
                </thead>
                <tbody>
                  {(stock.data ?? []).length === 0 && <tr><td colSpan={7} className="p-3 text-muted-foreground">No stock of this product.</td></tr>}
                  {(stock.data ?? []).map((s) => (
                    <tr key={s.balance_id} className={cn('border-t', !s.eligible && 'text-muted-foreground')}>
                      <td className="p-2">{s.warehouse_code} / {s.location_code}</td>
                      <td className="p-2">{s.batch_number ?? '—'}{s.expiry_date ? <span className="block text-xs">exp {formatDate(s.expiry_date)}</span> : null}</td>
                      <td className="p-2"><StockSourceBadge source={s.source_type} /></td>
                      <td className="p-2 text-right tabular-nums">{formatQty(s.on_hand)}</td>
                      <td className="p-2 text-right tabular-nums">{formatQty(s.reserved)}{Number(s.reserved_for_line) > 0 && <span className="block text-xs">({formatQty(s.reserved_for_line)} this line)</span>}</td>
                      <td className="p-2 text-right font-medium tabular-nums">{s.eligible ? formatQty(s.available) : '—'}</td>
                      <td className="p-2 text-xs">{s.eligible ? <span className="text-green-700">Eligible</span> : <span className="text-amber-800">{s.ineligible_reason}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div><SourceSplitTable line={line} /></div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default function PoAvailabilityPage() {
  const { hasAny } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const selection = usePoSelection()
  const analysis = useAsync(() => (selection.poId ? fetchPoAnalysis(selection.poId) : Promise.resolve(null)), [selection.poId, refresh])
  const snapshots = useAsync(() => (selection.poId ? fetchSnapshots(selection.poId) : Promise.resolve([])), [selection.poId, refresh])
  const [detail, setDetail] = useState<AnalysisLine | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const po = selection.selected
  const a = analysis.data
  const lines = a?.lines ?? []

  const columns: DataTableColumn<AnalysisLine>[] = [
    { id: 'line', header: 'Line', cell: (l) => l.line_no, sortValue: (l) => l.line_no },
    { id: 'product', header: 'Product', cell: (l) => (l.sku ? <span>{l.sku}<span className="block text-xs text-muted-foreground">{l.product_name}</span></span> : <span className="text-muted-foreground">{l.uploaded_sku ?? l.uploaded_customer_sku ?? l.uploaded_description}</span>), searchValue: (l) => `${l.sku ?? ''} ${l.product_name ?? ''} ${l.uploaded_sku ?? ''}` },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (l) => formatQty(l.quantity_ordered, l.line_unit ?? undefined) },
    { id: 'on_hand', header: 'On hand', align: 'right', cell: (l) => formatQty(l.on_hand) },
    { id: 'reserved', header: 'Existing reserved', align: 'right', cell: (l) => formatQty(l.reserved) },
    { id: 'available', header: 'Available before PO', align: 'right', cell: (l) => formatQty(l.available) },
    { id: 'ih', header: 'In-house avail.', align: 'right', cell: (l) => <span className="text-blue-700">{formatQty(l.in_house_available)}</span> },
    { id: 'os', header: 'Outsourced avail.', align: 'right', cell: (l) => <span className="text-violet-700">{formatQty(l.outsourced_available)}</span> },
    { id: 'allocated', header: 'Allocated to PO', align: 'right', cell: (l) => formatQty(Number(l.allocated_open) + Number(l.quantity_dispatched)) },
    { id: 'remaining', header: 'Remaining available', align: 'right', cell: (l) => formatQty(Math.max(Number(l.available) - Number(l.available_for_line), 0)) },
    { id: 'short_before', header: 'Shortage before alloc.', align: 'right', cell: (l) => (l.shortage_before === null ? '—' : <span className={cn(Number(l.shortage_before) > 0 && 'font-medium text-shortage')}>{formatQty(l.shortage_before)}</span>), sortValue: (l) => Number(l.shortage_before ?? -1) },
    { id: 'short_after', header: 'Shortage after alloc.', align: 'right', cell: (l) => (l.shortage_after === null ? '—' : formatQty(l.shortage_after)) },
    { id: 'reorder', header: 'Reorder level', align: 'right', cell: (l) => (l.reorder_level === null ? '—' : formatQty(l.reorder_level)) },
    { id: 'status', header: 'Availability', cell: (l) => (
      <span className="inline-flex max-w-56 flex-col gap-1"><AvailabilityBadge status={l.availability_status} />{l.review_warning && <span className="text-xs text-amber-800">{l.review_warning}</span>}</span>
    ), sortValue: (l) => l.availability_status },
  ]

  return (
    <>
      <PageHeader />
      <PoContextBar selection={selection}>
        <Button variant="outline" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={analysis.loading ? 'animate-spin' : undefined} /> Recalculate</Button>
        {po && hasAny(['customer_po.update', 'customer_po_shortages.read']) && (
          <Button variant="outline" disabled={busy} onClick={async () => {
            setBusy(true); setError(null)
            try { const r = await refreshAnalysis(selection.poId); setMessage(`Snapshot saved at ${formatDateTime(r.taken_at)}.`); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
          }}>{busy ? <Loader2 className="animate-spin" /> : <Camera />} Save snapshot</Button>
        )}
        {po && <ExportMenu title="Stock availability" fileStem={`po-availability-${po.customer_po_number}`} label="Availability report" columns={AVAILABILITY_EXPORT} rows={lines} />}
        {po && <ExportMenu title="In-house vs outsourced" fileStem={`po-source-split-${po.customer_po_number}`} label="Source split report" columns={SOURCE_SPLIT_EXPORT} rows={lines.filter((l) => l.product_id)} />}
      </PoContextBar>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {!po ? <NoPoSelected /> : (
        <>
          <div className="mb-4 flex flex-wrap items-start gap-3">
            {a && <span className="inline-flex items-center gap-2 text-sm">Overall: <AvailabilityBadge status={a.availability_status} /></span>}
            {a && <span className="text-xs text-muted-foreground">Calculated {formatDateTime(a.calculated_at)} from live balances.</span>}
            {(a?.units ?? []).map((u) => (
              <span key={u.unit} className="rounded-md border bg-background px-2.5 py-1 text-xs">
                {u.unit}: ordered {formatQty(u.ordered)} · allocated {formatQty(u.allocated)} · available for lines {formatQty(u.available_for_lines)} · shortage {formatQty(u.shortage_before)}
              </span>
            ))}
          </div>
          <p className="mb-4 flex items-start gap-2 rounded-lg border bg-background px-4 py-2.5 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            Available = on hand − active reservations, counting only eligible stock: storage locations of active warehouses{po.fulfilment_warehouse_code ? ` (${po.fulfilment_warehouse_code} only)` : ''}, not expired, known source. Lines of the same product share stock in line order. Totals are per unit and never added across units. Click a line for its warehouse / lot / source breakdown.
          </p>
          <DataTable
            title="Availability by line"
            columns={columns}
            data={lines}
            getRowId={(l) => l.line_id}
            loading={analysis.loading}
            error={analysis.error ? new Error(describeDataError(analysis.error)) : null}
            onRetry={analysis.reload}
            onRowClick={(l) => l.product_id && setDetail(l)}
            pageSize={25}
            searchPlaceholder="Search lines…"
            emptyState={{ icon: PackageSearch, title: 'No lines', description: 'This PO has no lines.' }}
          />
          <Card className="mt-6">
            <CardHeader><div><CardTitle>Saved analyses</CardTitle><CardDescription>Snapshots keep earlier results when stock changes; the table above is always recalculated live.</CardDescription></div></CardHeader>
            <CardContent>
              {(snapshots.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No snapshots saved yet.</p> : (
                <ul className="space-y-1 text-sm">
                  {(snapshots.data ?? []).map((s) => {
                    const sum = s.summary as { availability_status?: string }
                    return <li key={s.id} className="flex items-center gap-3"><span className="tabular-nums">{formatDateTime(s.taken_at)}</span>{sum.availability_status && <AvailabilityBadge status={sum.availability_status} />}</li>
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
      {detail && <LineStockDialog line={detail} onClose={() => setDetail(null)} />}
    </>
  )
}
