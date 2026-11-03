import { ExternalLink } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { inr, qty, STATUS_LABEL } from '@/features/analytics/analytics-format'
import { describePeriod } from '@/features/analytics/analytics-period'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchDrilldown, type DrillSource, type DrillSpec } from '@/services/analytics'

type Row = Record<string, unknown>
const s = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))

const COLUMNS: Record<DrillSource, { header: string; cell: (r: Row) => ReactNode; right?: boolean }[]> = {
  sales_orders: [
    { header: 'Order', cell: (r) => <Link className="font-medium text-primary hover:underline" to={`/sales/order-details?so=${s(r.id)}`}>{s(r.sales_order_number)}</Link> },
    { header: 'Date', cell: (r) => formatDate(String(r.order_date)) },
    { header: 'Customer', cell: (r) => s(r.customer_name_snapshot) },
    { header: 'Customer PO', cell: (r) => s(r.customer_po_number) },
    { header: 'Status', cell: (r) => STATUS_LABEL(s(r.order_status)) },
    { header: 'Fulfilment', cell: (r) => STATUS_LABEL(s(r.fulfilment_status)) },
  ],
  dispatches: [
    { header: 'Consignment', cell: (r) => <Link className="font-medium text-primary hover:underline" to={`/sales/delivery?f=${s(r.id)}`}>{s(r.fulfilment_number)}</Link> },
    { header: 'Dispatched', cell: (r) => formatDateTime(String(r.actual_dispatch_at)) },
    { header: 'Order', cell: (r) => s(r.sales_order_number) },
    { header: 'Customer', cell: (r) => s(r.customer_name_snapshot) },
    { header: 'Warehouse', cell: (r) => s(r.warehouse_code) },
    { header: 'Quantity', cell: (r) => `${qty(Number(r.dispatched ?? 0))} ${s(r.units)}`, right: true },
  ],
  invoices: [
    { header: 'Invoice', cell: (r) => <Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${s(r.id)}`}>{s(r.invoice_number)}</Link> },
    { header: 'Date', cell: (r) => formatDate(String(r.invoice_date)) },
    { header: 'Customer', cell: (r) => s(r.customer_legal_name) },
    { header: 'Status', cell: (r) => STATUS_LABEL(s(r.display_status)) },
    { header: 'Taxable', cell: (r) => inr(Number(r.taxable_subtotal), true), right: true },
    { header: 'Total', cell: (r) => inr(Number(r.grand_total), true), right: true },
    { header: 'Balance', cell: (r) => inr(r.balance_due as number | null, true), right: true },
  ],
  receipts: [
    { header: 'Receipt', cell: (r) => <Link className="font-medium text-primary hover:underline" to={`/billing/payments?receipt=${s(r.id)}`}>{s(r.receipt_number)}</Link> },
    { header: 'Date', cell: (r) => formatDate(String(r.receipt_date)) },
    { header: 'Customer', cell: (r) => s(r.customer_name) },
    { header: 'Method', cell: (r) => STATUS_LABEL(s(r.payment_method)) },
    { header: 'Amount', cell: (r) => inr(Number(r.amount_received), true), right: true },
    { header: 'Unallocated', cell: (r) => inr(Number(r.unallocated_amount), true), right: true },
  ],
  stock: [
    { header: 'Product', cell: (r) => <Link className="font-medium text-primary hover:underline" to={`/inventory/stock/${s(r.product_id)}`}>{s(r.sku)}</Link> },
    { header: 'Warehouse / location', cell: (r) => `${s(r.warehouse_code)} / ${s(r.location_code)}` },
    { header: 'Lot', cell: (r) => s(r.batch_number ?? (r.is_system_lot ? 'Untracked' : null)) },
    { header: 'Source', cell: (r) => STATUS_LABEL(s(r.source_type)) },
    { header: 'On hand', cell: (r) => `${qty(Number(r.on_hand))} ${s(r.base_unit)}`, right: true },
    { header: 'Reserved', cell: (r) => qty(Number(r.reserved)), right: true },
    { header: 'Available', cell: (r) => qty(Number(r.available)), right: true },
  ],
}

function DrillBody({ spec }: { spec: DrillSpec }) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const res = useAsync(() => fetchDrilldown(spec, page, pageSize), [JSON.stringify(spec), page, pageSize])
  const cols = COLUMNS[spec.source]
  if (res.loading && !res.data) return <LoadingState variant="table" rows={5} />
  if (res.error) return <ErrorState compact message={describeDataError(res.error)} onRetry={res.reload} />
  if (!res.data?.rows.length) return <EmptyState compact icon={ExternalLink} title="No records" description="No authorised records match this selection." />
  return (
    <div className="space-y-2">
      <div className="max-h-[55vh] overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-muted text-xs text-muted-foreground"><tr>{cols.map((c) => <th key={c.header} className={`px-3 py-2 font-medium ${c.right ? 'text-right' : 'text-left'}`}>{c.header}</th>)}</tr></thead>
          <tbody>{res.data.rows.map((r, i) => (
            <tr key={String(r.id ?? r.balance_id ?? i)} className="border-t">{cols.map((c) => <td key={c.header} className={`px-3 py-1.5 ${c.right ? 'text-right tabular-nums' : ''}`}>{c.cell(r)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      <PaginationBar page={page} pageSize={pageSize} total={res.data.total} onPageChange={setPage} onPageSizeChange={(n) => { setPageSize(n); setPage(0) }} disabled={res.loading} />
    </div>
  )
}

/** Paged list of the source records behind a figure (opened through useDrilldown). */
export function DrilldownDialog({ spec, onClose }: { spec: DrillSpec | null; onClose: () => void }) {
  return (
    <Dialog open={spec !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        {spec && (
          <>
            <DialogHeader>
              <DialogTitle>{spec.title}</DialogTitle>
              <DialogDescription>
                {spec.from && spec.to ? `${describePeriod({ from: spec.from, to: spec.to })} · ` : spec.source === 'stock' ? 'Current stock · ' : ''}
                Source records you are authorised to see. Open a record to work on it in its module.
              </DialogDescription>
            </DialogHeader>
            <DrillBody key={JSON.stringify(spec)} spec={spec} />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
