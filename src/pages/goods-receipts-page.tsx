import { AlertTriangle, CalendarDays, CheckCircle2, ClipboardList, Download, Loader2, PackageCheck, PackagePlus, PackageX, TrendingUp, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { useDrill } from '@/features/drilldown/use-drill'
import { useUrlEnum } from '@/hooks/use-url-state'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatQty } from '@/features/inventory/inventory-model'
import { DirectReceiptDialog } from '@/features/purchasing/direct-receipt-dialog'
import { OPEN_PO_STATUSES, grnExportRows } from '@/features/purchasing/po-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { fetchGoodsReceipts, fetchPurchaseOrders } from '@/services/purchasing'
import type { GoodsReceiptListRow } from '@/types/database-purchasing'

type Filter = 'ALL' | 'PURCHASE_ORDER' | 'DIRECT' | 'REVERSED'

/** /goods-receipts — every goods received note, against orders and unlinked. */
export default function GoodsReceiptsPage() {
  const navigate = useNavigate()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const receipts = useAsync(() => fetchGoodsReceipts(), [refresh])
  // Kept in the address, so Back from a receipt returns to the same tab.
  const [filter, setFilter] = useUrlEnum<Filter>('view', ['ALL', 'PURCHASE_ORDER', 'DIRECT', 'REVERSED'], 'ALL')
  const { href } = useDrill('goods_receipts')
  const [params] = useSearchParams()
  // ?receive=po|direct opens the receipt dialogs directly (quick actions).
  const [direct, setDirect] = useState(params.get('receive') === 'direct')
  const [choosePo, setChoosePo] = useState(params.get('receive') === 'po')
  const [today] = useState(() => toIsoDate(new Date()))
  const canReceive = has('purchase_receipt.create')

  const all = useMemo(() => receipts.data ?? [], [receipts.data])
  const posted = all.filter((r) => r.status === 'POSTED')
  const month = today.slice(0, 7)
  const kpi = {
    total: posted.length,
    today: posted.filter((r) => r.receipt_date === today).length,
    month: posted.filter((r) => r.receipt_date.startsWith(month)).length,
    unlinked: posted.filter((r) => r.receipt_type === 'DIRECT').length,
    rejected: posted.reduce((s, r) => s + Number(r.total_rejected), 0),
    reversed: all.length - posted.length,
  }
  const rows = all.filter((r) => filter === 'ALL' ? true : filter === 'REVERSED' ? r.status === 'REVERSED' : r.receipt_type === filter && r.status === 'POSTED')
  const [exporting, setExporting] = useState(false)
  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: 'Goods received', rows: grnExportRows(rows) }], `goods-received-${today}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  const columns: DataTableColumn<GoodsReceiptListRow>[] = [
    { id: 'no', header: 'GRN', cell: (r) => <span className="font-medium">{r.receipt_number}</span>,
      searchValue: (r) => `${r.receipt_number} ${r.supplier_document_number ?? ''} ${r.supplier_invoice_number ?? ''} ${r.supplier_challan_number ?? ''}`, sortValue: (r) => r.receipt_number },
    { id: 'date', header: 'Date', cell: (r) => formatDate(r.receipt_date), sortValue: (r) => r.receipt_date },
    { id: 'po', header: 'Purchase order', cell: (r) => r.po_number ?? <StatusBadge label="Unlinked" tone="warning" />, searchValue: (r) => r.po_number ?? 'unlinked direct', sortValue: (r) => r.po_number ?? '' },
    { id: 'supplier', header: 'Supplier', cell: (r) => r.supplier_name ?? <span className="text-muted-foreground">—</span>, searchValue: (r) => `${r.supplier_name ?? ''} ${r.supplier_code ?? ''}`, sortValue: (r) => r.supplier_name ?? '' },
    { id: 'wh', header: 'Warehouse', cell: (r) => r.warehouse_code ?? '—' },
    { id: 'inv', header: 'Supplier invoice', cell: (r) => r.supplier_invoice_number ?? (r.supplier_document_number ? <span className="text-muted-foreground" title="Earlier combined reference">{r.supplier_document_number}</span> : '—'), sortValue: (r) => r.supplier_invoice_number ?? '' },
    { id: 'dc', header: 'Challan', cell: (r) => r.supplier_challan_number ?? '—', sortValue: (r) => r.supplier_challan_number ?? '' },
    { id: 'acc', header: 'Accepted', align: 'right', cell: (r) => formatQty(r.total_accepted), sortValue: (r) => Number(r.total_accepted) },
    { id: 'rej', header: 'Rejected', align: 'right', cell: (r) => (Number(r.total_rejected) > 0 ? <span className="text-red-700">{formatQty(r.total_rejected)}</span> : '0'), sortValue: (r) => Number(r.total_rejected) },
    { id: 'status', header: 'Status', cell: (r) => <StatusBadge label={r.status === 'POSTED' ? (r.corrects_receipt_id ? 'Posted (correction)' : 'Posted') : 'Reversed'} tone={r.status === 'POSTED' ? 'success' : 'neutral'} />, sortValue: (r) => r.status },
  ]

  return (
    <>
      <PageHeader
        title="Goods Received (GRN)"
        description="Goods received against purchase orders and without one. Only accepted quantities are added to stock."
        actions={(
          <>
            <Button variant="outline" onClick={() => navigate('/goods-receipts/price-variance')} data-testid="grn-price-variance"><TrendingUp /> Price variance</Button>
            {canReceive && <Button variant="outline" onClick={() => setDirect(true)}><PackagePlus /> Receive without PO</Button>}
            {canReceive && <Button onClick={() => setChoosePo(true)}><ClipboardList /> Receive against PO</Button>}
          </>
        )}
      />
      <section aria-label="Goods received summary" className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <KpiCard to={href('grn.total')} label="Total GRNs" value={receipts.data ? formatNumber(kpi.total) : null} hint="Posted receipts" icon={PackageCheck} accent="available" />
        <KpiCard to={href('grn.today', { today })} label="Received Today" value={receipts.data ? formatNumber(kpi.today) : null} icon={CalendarDays} accent="manufacturing" />
        <KpiCard to={href('grn.month', { today })} label="This Month" value={receipts.data ? formatNumber(kpi.month) : null} icon={CheckCircle2} />
        <KpiCard to={href('grn.unlinked')} label="Unlinked GRNs" value={receipts.data ? formatNumber(kpi.unlinked) : null} hint="Received without a purchase order" icon={AlertTriangle} accent={kpi.unlinked > 0 ? 'pending' : 'neutral'} />
        <KpiCard to={href('grn.rejected_all')} label="Rejected Quantity" value={receipts.data ? formatQty(kpi.rejected) : null} hint="All units, posted receipts" icon={PackageX} accent={kpi.rejected > 0 ? 'shortage' : 'neutral'} />
        <KpiCard to={href('grn.reversed')} label="Reversed" value={receipts.data ? formatNumber(kpi.reversed) : null} hint="Kept in the history" icon={Undo2} />
      </section>
      <DataTable
        title="Goods received notes"
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        loading={receipts.loading}
        error={receipts.error ? new Error(describeDataError(receipts.error)) : null}
        onRetry={receipts.reload}
        onRowClick={(r) => navigate(`/goods-receipts/${r.id}`)}
        searchPlaceholder="Search GRN, PO, supplier, invoice, challan…"
        pageSize={25}
        toolbar={<>
          <FilterTabs<Filter> label="Receipt type" value={filter} onChange={setFilter}
            options={[{ value: 'ALL', label: 'All' }, { value: 'PURCHASE_ORDER', label: 'Against PO' }, { value: 'DIRECT', label: 'Unlinked' }, { value: 'REVERSED', label: 'Reversed' }]} />
          {has('purchase_order.export') && (
            <Button variant="outline" size="sm" disabled={exporting || rows.length === 0} onClick={() => void exportExcel()}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel
            </Button>
          )}
        </>}
        emptyState={{ icon: PackageCheck, title: 'No goods received yet', description: canReceive ? 'Receive goods against an open purchase order, or without one.' : 'Receipts will appear here.' }}
      />
      {direct && <DirectReceiptDialog onClose={() => setDirect(false)} onPosted={(_m, id) => { setDirect(false); setRefresh((n) => n + 1); navigate(`/goods-receipts/${id}`, { state: { message: _m } }) }} />}
      {choosePo && <ChoosePoDialog onClose={() => setChoosePo(false)} onChoose={(id) => navigate(`/purchase-orders/${id}?receive=1`)} />}
    </>
  )
}

function ChoosePoDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (poId: string) => void }) {
  const pos = useAsync(() => fetchPurchaseOrders(), [])
  const [term, setTerm] = useState('')
  const t = term.trim().toLowerCase()
  const open = (pos.data ?? []).filter((p) => OPEN_PO_STATUSES.includes(p.status))
    .filter((p) => !t || `${p.po_number} ${p.supplier_name} ${p.skus}`.toLowerCase().includes(t))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Receive against a purchase order</DialogTitle>
          <DialogDescription>Open orders with goods still to come. Draft orders must be opened first.</DialogDescription></DialogHeader>
        <Input aria-label="Search orders" placeholder="PO number, supplier or SKU" value={term} onChange={(e) => setTerm(e.target.value)} autoFocus />
        <div className="max-h-80 overflow-y-auto rounded-lg border">
          {pos.loading ? <p className="p-3 text-sm text-muted-foreground">Loading…</p>
            : open.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No open purchase order matches. Use “Receive without PO” if the goods have no order.</p>
            : open.map((p) => (
              <button key={p.id} type="button" onClick={() => onChoose(p.id)} className="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted">
                <span><span className="font-medium">{p.po_number}</span> · {p.supplier_name}
                  <span className="block text-xs text-muted-foreground">{formatDate(p.po_date)}{p.expected_delivery_date ? ` · expected ${formatDate(p.expected_delivery_date)}` : ''} · {p.skus}</span></span>
                <span className="text-right text-xs">pending {formatQty(p.total_pending_quantity)}</span>
              </button>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
