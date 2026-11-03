import { Download, Info, Loader2, Search, Unlock } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatQty } from '@/features/inventory/inventory-model'
import {
  INVOICE_STATUS_LABEL, NON_STOCK_LABEL, customerPending, customerPendingSheet, partialInvoiceSheet, reconciliationSheet, registerSheet, registerStatus,
  releaseProblem, releasedSheet, type TrackingLine,
} from '@/features/sales/pending-invoice-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import { fetchInvoiceTracking, releasePendingQuantity } from '@/services/sales-v2'

type Report = 'register' | 'partial' | 'reconciliation' | 'released' | 'customer'
const REPORTS: { value: Report; label: string }[] = [
  { value: 'register', label: 'Pending invoice quantity' },
  { value: 'partial', label: 'Partial invoices' },
  { value: 'reconciliation', label: 'Sales order vs invoice' },
  { value: 'released', label: 'Released quantities' },
  { value: 'customer', label: 'Customer-wise pending' },
]

/**
 * Inventory → Stock Register → Pending / Incomplete Invoice Orders: sales-order quantities
 * not yet invoiced, the related reports, and "Release Pending Quantity". A tracking
 * register only — never stock, never on-hand or available quantities.
 */
export function PendingInvoicePanel({ sectionTabs, initialSalesOrderId }: { sectionTabs: ReactNode; initialSalesOrderId?: string | null }) {
  const { has } = usePermissions()
  const [report, setReport] = useState<Report>('register')
  const [search, setSearch] = useState('')
  const term = useDebouncedValue(search)
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const invoiceTerm = useDebouncedValue(invoiceNumber)
  const [customerId, setCustomerId] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [salesOrderId, setSalesOrderId] = useState<string | null>(initialSalesOrderId ?? null)
  const [showClosed, setShowClosed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [releasing, setReleasing] = useState<TrackingLine | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const pendingOnly = report === 'register' && !showClosed
  const data = useAsync(() => fetchInvoiceTracking({
    search: term, invoice_number: invoiceTerm, customer_id: customerId === 'all' ? null : customerId, from, to,
    sales_order_id: salesOrderId, pending_only: pendingOnly,
  }), [term, invoiceTerm, customerId, from, to, salesOrderId, pendingOnly, refresh])
  const lines = useMemo(() => data.data?.lines ?? [], [data.data])
  const customers = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of lines) if (l.customer_id) m.set(l.customer_id, l.customer_name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [lines])

  const exportSheet = async () => {
    if (!data.data) return
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      const rows = report === 'register' ? registerSheet(lines) : report === 'partial' ? partialInvoiceSheet(data.data.partial_invoices)
        : report === 'reconciliation' ? reconciliationSheet(lines) : report === 'released' ? releasedSheet(data.data.releases) : customerPendingSheet(lines)
      await downloadSheets([{ name: REPORTS.find((r) => r.value === report)!.label.slice(0, 31), rows }], `pending-invoice-${report}-${toIsoDate(new Date())}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <PageHeader title="Stock Register" description="Pending / Incomplete Invoice Orders: sales-order quantities not yet invoiced."
        breadcrumbs={[{ label: 'Inventory Management' }, { label: 'Stock Register' }]}
        actions={<Button variant="outline" disabled={exporting || !data.data} onClick={() => void exportSheet()}>{exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel</Button>} />
      {sectionTabs}
      <p role="note" className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900" data-testid="non-stock-label">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span><span className="font-medium">{NON_STOCK_LABEL}</span> These quantities are what customers ordered and were not invoiced yet. They are not on-hand or available stock and create no stock entries.</span>
      </p>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="pending-invoice-totals">
        {(data.data?.totals ?? []).map((t) => [
          ['Sales order quantity', t.ordered], ['Invoiced quantity', t.invoiced], ['Pending invoice quantity', t.pending], ['Released quantity', t.released],
        ].map(([label, v]) => (
          <Card key={`${t.unit}-${label}`}><CardContent className="px-4 py-3">
            <p className="text-xs text-muted-foreground">{label} ({t.unit})</p>
            <p className="text-lg font-semibold tabular-nums">{formatQty(Number(v), t.unit)}</p>
          </CardContent></Card>
        )))}
      </div>

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b px-5 py-4">
          <FilterTabs<Report> label="Report" value={report} onChange={setReport} options={REPORTS} />
          <div className="flex flex-wrap items-end gap-2">
            <div className="relative w-full sm:w-64">
              <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search sales order, customer or product" placeholder="Sales order, customer, SKU…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Input aria-label="Invoice number" placeholder="Invoice no." className="w-36" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger className="w-48" aria-label="Customer"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All customers</SelectItem>
                {customers.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="space-y-1"><Label htmlFor="pi-from" className="text-xs">From</Label><Input id="pi-from" type="date" className="w-36" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="pi-to" className="text-xs">To</Label><Input id="pi-to" type="date" className="w-36" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            {report === 'register' && (
              <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={showClosed} onCheckedChange={(v) => setShowClosed(v === true)} /> Include fully invoiced / closed lines</label>
            )}
            {salesOrderId && <Button variant="ghost" size="sm" onClick={() => setSalesOrderId(null)}>Show all sales orders</Button>}
          </div>
        </div>
        {data.loading && !data.data ? <LoadingState label="Loading…" />
          : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
          : <div className="overflow-x-auto">{renderReport()}</div>}
      </Card>

      {releasing && (
        <ReleaseDialog line={releasing} onClose={() => setReleasing(null)}
          onDone={(m) => { setReleasing(null); setMessage(m); setRefresh((n) => n + 1) }} />
      )}
    </>
  )

  function renderReport() {
    const r = data.data!
    if (report === 'partial') {
      const rows = r.partial_invoices.flatMap((p) => p.lines.map((l, i) => ({ p, l, i })))
      if (rows.length === 0) return <EmptyState icon={Info} title="No partial invoices" description="Invoices posted for less than the remaining sales-order quantity appear here." />
      return (
        <Table><TableHeader><TableRow className="hover:bg-transparent">
          <TableHead>Invoice No.</TableHead><TableHead>Date</TableHead><TableHead>Customer</TableHead><TableHead>Sales Order</TableHead><TableHead>Product</TableHead>
          <TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Previously invoiced</TableHead><TableHead className="text-right">This invoice</TableHead>
          <TableHead className="text-right">Remaining at posting</TableHead><TableHead>Posted by</TableHead>
        </TableRow></TableHeader>
        <TableBody>{rows.map(({ p, l, i }) => (
          <TableRow key={`${p.invoice_id}-${i}`}>
            <TableCell><Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${p.invoice_id}`}>{p.invoice_number}</Link></TableCell>
            <TableCell>{formatDate(p.invoice_date)}</TableCell><TableCell>{p.customer}</TableCell><TableCell>{l.sales_order_number}</TableCell>
            <TableCell><span className="font-medium">{l.sku}</span> {l.product_name}</TableCell>
            <TableCell className="text-right tabular-nums">{formatQty(l.ordered, l.unit)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatQty(l.previously_invoiced, l.unit)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatQty(l.this_invoice, l.unit)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatQty(l.remaining, l.unit)}</TableCell>
            <TableCell className="text-xs">{p.posted_by}<br />{formatDateTime(p.posted_at)}</TableCell>
          </TableRow>))}</TableBody></Table>
      )
    }
    if (report === 'released') {
      if (r.releases.length === 0) return <EmptyState icon={Info} title="No released quantities" description="Pending quantities released with Release Pending Quantity appear here." />
      return (
        <Table><TableHeader><TableRow className="hover:bg-transparent">
          <TableHead>Sales Order</TableHead><TableHead>Customer</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Ordered</TableHead>
          <TableHead className="text-right">Invoiced</TableHead><TableHead className="text-right">Released</TableHead><TableHead>Invoices</TableHead><TableHead>Reason</TableHead><TableHead>Released by</TableHead>
        </TableRow></TableHeader>
        <TableBody>{r.releases.map((x, i) => (
          <TableRow key={i}>
            <TableCell><Link className="font-medium text-primary hover:underline" to={`/sales/orders/${x.sales_order_id}`}>{x.sales_order_number}</Link></TableCell>
            <TableCell>{x.customer}</TableCell><TableCell><span className="font-medium">{x.sku}</span> {x.product_name}</TableCell>
            <TableCell className="text-right tabular-nums">{formatQty(x.ordered, x.unit)}</TableCell><TableCell className="text-right tabular-nums">{formatQty(x.invoiced, x.unit)}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">{formatQty(x.quantity, x.unit)}</TableCell>
            <TableCell className="text-xs">{(x.invoice_numbers ?? []).join(', ') || '—'}</TableCell>
            <TableCell className="max-w-64 whitespace-normal text-xs">{x.reason}</TableCell>
            <TableCell className="text-xs">{x.released_by}<br />{formatDateTime(x.released_at)}</TableCell>
          </TableRow>))}</TableBody></Table>
      )
    }
    if (report === 'customer') {
      const rows = customerPending(lines)
      if (rows.length === 0) return <EmptyState icon={Info} title="Nothing to show" description="No sales orders match the filters." />
      return (
        <Table><TableHeader><TableRow className="hover:bg-transparent">
          <TableHead>Customer</TableHead><TableHead className="text-right">Sales orders</TableHead><TableHead className="text-right">Ordered</TableHead>
          <TableHead className="text-right">Invoiced</TableHead><TableHead className="text-right">Pending invoice</TableHead><TableHead className="text-right">Released</TableHead>
        </TableRow></TableHeader>
        <TableBody>{rows.map((c) => (
          <TableRow key={`${c.customer}-${c.unit}`}>
            <TableCell className="font-medium">{c.customer}</TableCell><TableCell className="text-right">{c.orders}</TableCell>
            <TableCell className="text-right tabular-nums">{formatQty(c.ordered, c.unit)}</TableCell><TableCell className="text-right tabular-nums">{formatQty(c.invoiced, c.unit)}</TableCell>
            <TableCell className="text-right font-medium tabular-nums">{formatQty(c.pending, c.unit)}</TableCell><TableCell className="text-right tabular-nums">{formatQty(c.released, c.unit)}</TableCell>
          </TableRow>))}</TableBody></Table>
      )
    }
    if (lines.length === 0) {
      return <EmptyState icon={Info} title={report === 'register' ? 'No pending invoice quantities' : 'Nothing to show'}
        description={report === 'register' ? 'Every confirmed sales order line is fully invoiced or released.' : 'No sales orders match the filters.'} />
    }
    const recon = report === 'reconciliation'
    return (
      <Table data-testid="pending-invoice-table"><TableHeader><TableRow className="hover:bg-transparent">
        <TableHead>Sales Order No.</TableHead><TableHead>Invoice No.</TableHead><TableHead>Customer</TableHead><TableHead>Product</TableHead>
        <TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Invoiced</TableHead>
        {recon && <TableHead className="text-right">On drafts</TableHead>}{recon && <TableHead className="text-right">Dispatched</TableHead>}
        <TableHead className="text-right">Released</TableHead><TableHead className="text-right">Pending invoice</TableHead>
        <TableHead>Order date</TableHead><TableHead>Invoice date</TableHead><TableHead>Status</TableHead>{!recon && <TableHead />}
      </TableRow></TableHeader>
      <TableBody>{lines.map((l) => (
        <TableRow key={l.line_id}>
          <TableCell><Link className="font-medium text-primary hover:underline" to={`/sales/orders/${l.sales_order_id}`}>{l.sales_order_number}</Link></TableCell>
          <TableCell className="text-xs">{l.latest_invoice_id
            ? <Link className="text-primary hover:underline" to={`/billing/invoices/${l.latest_invoice_id}`}>{(l.invoice_numbers ?? []).join(', ')}</Link> : '—'}</TableCell>
          <TableCell>{l.customer_name}</TableCell>
          <TableCell><span className="font-medium">{l.sku}</span> <span className="text-muted-foreground">{l.product_name}</span></TableCell>
          <TableCell className="text-right tabular-nums">{formatQty(l.ordered, l.unit)}</TableCell>
          <TableCell className="text-right tabular-nums">{formatQty(l.invoiced, l.unit)}</TableCell>
          {recon && <TableCell className="text-right tabular-nums">{formatQty(l.draft_invoiced, l.unit)}</TableCell>}
          {recon && <TableCell className="text-right tabular-nums">{formatQty(l.dispatched, l.unit)}</TableCell>}
          <TableCell className="text-right tabular-nums">{Number(l.released) > 0 ? formatQty(l.released, l.unit) : '—'}</TableCell>
          <TableCell className="text-right font-semibold tabular-nums">{formatQty(l.pending, l.unit)}</TableCell>
          <TableCell>{formatDate(l.order_date)}</TableCell>
          <TableCell>{l.latest_invoice_date ? formatDate(l.latest_invoice_date) : '—'}</TableCell>
          <TableCell>{recon ? INVOICE_STATUS_LABEL[l.status] : registerStatus(l)}</TableCell>
          {!recon && <TableCell>{has('sales_orders.cancel') && Number(l.releasable) > 0 && (
            <Button size="sm" variant="outline" onClick={() => setReleasing(l)}><Unlock /> Release</Button>)}</TableCell>}
        </TableRow>))}</TableBody></Table>
    )
  }
}

function ReleaseDialog({ line, onClose, onDone }: { line: TrackingLine; onClose: () => void; onDone: (m: string) => void }) {
  const [quantity, setQuantity] = useState(String(Number(line.releasable)))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRequestKey()
  const submit = async () => {
    const problem = releaseProblem(quantity, Number(line.releasable), line.unit, reason)
    if (problem) return setError(problem)
    setBusy(true); setError(null)
    try {
      const r = await releasePendingQuantity(line.line_id, Number(quantity), reason.trim(), request.key)
      request.renew()
      onDone(`Released ${formatQty(r.released, line.unit)} of ${line.sku} on ${line.sales_order_number}; ${formatQty(r.pending, line.unit)} still pending. No stock was moved${Number(r.reservation_released ?? 0) > 0 ? `; ${formatQty(Number(r.reservation_released), line.unit)} of reserved stock was freed` : ''}.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onClose() }}>
      <DialogContent data-testid="release-dialog">
        <DialogHeader>
          <DialogTitle>Release Pending Quantity</DialogTitle>
          <DialogDescription>
            {line.sales_order_number} · {line.sku} {line.product_name}: ordered {formatQty(line.ordered, line.unit)}, invoiced {formatQty(line.invoiced, line.unit)},
            pending {formatQty(line.pending, line.unit)}. Releasing closes this quantity on the order. It creates no stock entry and does not add to inventory;
            only its reservation is freed. The release is recorded with your name and reason, and Super Admins are notified.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="rel-qty">Quantity to release ({line.unit}; up to {formatQty(line.releasable, line.unit)})</Label>
            <Input id="rel-qty" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="rel-reason">Reason</Label>
            <Textarea id="rel-reason" rows={2} maxLength={500} placeholder="e.g. Customer no longer requires the remaining quantity" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy ? <Loader2 className="animate-spin" /> : <Unlock />} Release</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
