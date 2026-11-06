import { AlertTriangle, ArrowLeft, Loader2, Pencil, Printer, RotateCcw } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { RecordDocuments } from '@/features/admin/record-documents'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { DirectReceiptDialog } from '@/features/purchasing/direct-receipt-dialog'
import { GoodsReceiptDialog } from '@/features/purchasing/receipt-dialog'
import { SupplierRefs } from '@/features/purchasing/supplier-refs'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { ProductThumb } from '@/features/products/product-image'
import { useProductImagesById } from '@/features/products/product-image-hooks'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchGoodsReceipt, fetchPoLines, fetchPurchaseOrder, reverseGoodsReceipt } from '@/services/purchasing'

async function load(id: string) {
  const r = await fetchGoodsReceipt(id)
  const [po, poLines, corrected] = r.receipt.purchase_order_id
    ? await Promise.all([fetchPurchaseOrder(r.receipt.purchase_order_id), fetchPoLines(r.receipt.purchase_order_id), r.receipt.corrects_receipt_id ? fetchGoodsReceipt(r.receipt.corrects_receipt_id).catch(() => null) : null])
    : [null, [], r.receipt.corrects_receipt_id ? await fetchGoodsReceipt(r.receipt.corrects_receipt_id).catch(() => null) : null]
  return { ...r, po, poLines, corrects: corrected?.receipt ?? null }
}

/** /goods-receipts/:receiptId */
export default function GoodsReceiptDetailPage() {
  const { receiptId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const data = useAsync(() => load(receiptId), [receiptId, refresh])
  // Product thumbnails beside the line items (display only).
  const lineImages = useProductImagesById((data.data?.lines ?? []).map((l) => l.product_id))
  const [notice, setNotice] = useState<string | null>((location.state as { message?: string } | null)?.message ?? null)
  const [reversing, setReversing] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const crumbs = [{ label: 'Orders' }, { label: 'Goods Received', to: '/goods-receipts' }, { label: data.data?.receipt.receipt_number ?? 'GRN' }]

  if (data.loading && !data.data) return <LoadingState label="Loading goods receipt…" />
  if (data.error || !data.data) return (<><PageHeader title="Goods receipt" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)
  const { receipt: r, lines, correctedBy, po, poLines, corrects } = data.data
  const direct = r.receipt_type === 'DIRECT'
  const canChange = r.status === 'POSTED' && has('purchase_exception.approve') && !(po && ['CLOSED', 'CANCELLED'].includes(po.status))
  const poLine = (id: string | null) => poLines.find((l) => l.id === id)

  return (
    <>
      <PageHeader
        title={r.receipt_number}
        description={`${direct ? 'Received without a purchase order' : `Against ${r.po_number}`} · ${r.supplier_name ?? 'no supplier'} · ${formatDate(r.receipt_date)}`}
        breadcrumbs={crumbs}
        actions={
          <>
            <Button variant="outline" asChild><Link to="/goods-receipts"><ArrowLeft /> All GRNs</Link></Button>
            <Button variant="outline" asChild><Link to={`/goods-receipts/${r.id}/print`}><Printer /> Print / PDF</Link></Button>
            {canChange && has('purchase_receipt.create') && <Button variant="outline" onClick={() => setCorrecting(true)}><Pencil /> Correct</Button>}
            {canChange && <Button variant="outline" onClick={() => setReversing(true)}><RotateCcw /> Reverse</Button>}
          </>
        }
      />
      {notice && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{notice}</p>}
      {direct && (
        <p className="mb-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Unlinked receipt: these goods were received without a purchase order, so no ordered or pending quantities apply.
        </p>
      )}
      {r.status === 'REVERSED' && (
        <p className="mb-4 rounded-lg border bg-surface-muted/60 px-4 py-2.5 text-sm">
          Reversed {r.reversed_at ? formatDateTime(r.reversed_at) : ''}: {r.reversal_reason} {r.reversal_transaction_ids?.length ? `(${r.reversal_transaction_ids.join(', ')})` : ''}
          {correctedBy && <> · corrected by <Link className="font-medium text-primary hover:underline" to={`/goods-receipts/${correctedBy.id}`}>{correctedBy.receipt_number}</Link></>}
        </p>
      )}
      {corrects && <p className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">This receipt corrects <Link className="font-medium underline-offset-2 hover:underline" to={`/goods-receipts/${corrects.id}`}>{corrects.receipt_number}</Link>, which was reversed.</p>}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Info label="Status"><StatusBadge label={r.status === 'POSTED' ? 'Posted' : 'Reversed'} tone={r.status === 'POSTED' ? 'success' : 'neutral'} /> <StatusBadge label={direct ? 'Unlinked' : 'Against PO'} tone={direct ? 'warning' : 'info'} /></Info>
        <Info label="Purchase order">{po ? <Link className="font-medium text-primary hover:underline" to={`/purchase-orders/${po.id}`}>{po.po_number}</Link> : '—'}</Info>
        <Info label="Supplier / warehouse">{r.supplier_name ?? 'No supplier'} · {r.warehouse_code ?? '—'}</Info>
        <Info label="Other documents">{[r.supplier_document_number && `Earlier ref. ${r.supplier_document_number}`, r.supporting_document_ref].filter(Boolean).join(' · ') || '—'}</Info>
      </div>
      <Card className="mb-6">
        <CardHeader><div><CardTitle>Supplier invoice and challan</CardTitle>
          <CardDescription>This receipt's own supplier references ({r.receipt_number} is the Alton GRN number{r.po_number ? `, ${r.po_number} the order` : ''}). Each GRN keeps its own; editing them does not change other receipts or stock.</CardDescription></div></CardHeader>
        <CardContent>
          <SupplierRefs target={{ receiptId: r.id }} documentLabel={r.receipt_number} invoice={r.supplier_invoice_number} challan={r.supplier_challan_number}
            canEdit={r.status === 'POSTED' && (has('purchase_receipt.create') || has('purchase_exception.approve'))}
            onSaved={(m) => { setNotice(m); setRefresh((n) => n + 1) }} />
        </CardContent>
      </Card>

      <Card className="mb-6 overflow-hidden">
        <CardHeader><div><CardTitle>Items received</CardTitle><CardDescription>Accepted goods were added to stock; rejected goods are never available stock.{r.notes ? ` Remarks: ${r.notes}` : ''}</CardDescription></div></CardHeader>
        <Table>
          <TableHeader><TableRow className="hover:bg-transparent">
            <TableHead>Item</TableHead>
            {!direct && <TableHead className="text-right">Ordered</TableHead>}
            <TableHead className="text-right">Received</TableHead><TableHead className="text-right">Accepted</TableHead><TableHead className="text-right">Rejected</TableHead>
            {!direct && <><TableHead className="text-right">Shortage now</TableHead><TableHead className="text-right">Excess</TableHead></>}
            <TableHead>Stored in</TableHead><TableHead>Batch</TableHead><TableHead>Stock posting</TableHead>{direct && <TableHead className="text-right">Value (incl. GST)</TableHead>}
          </TableRow></TableHeader>
          <TableBody>{lines.map((l) => {
            const pl = poLine(l.purchase_order_line_id)
            return (
              <TableRow key={l.id}>
                <TableCell className="min-w-48 whitespace-normal"><div className="flex items-start gap-2">{l.product_id && <ProductThumb size="xs" src={lineImages.get(l.product_id)} alt={l.description} />}<div className="min-w-0"><p className="font-medium">{l.sku ? `${l.sku} — ` : ''}{l.description}</p>{l.po_line_no && <p className="text-xs text-muted-foreground">PO line {l.po_line_no}</p>}</div></div></TableCell>
                {!direct && <TableCell className="text-right tabular-nums">{l.ordered_quantity === null ? '—' : formatQty(l.ordered_quantity, l.unit)}</TableCell>}
                <TableCell className="text-right tabular-nums">{formatQty(l.received_quantity, l.unit)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatQty(l.accepted_quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(l.rejected_quantity) > 0 ? <span className="text-red-700">{formatQty(l.rejected_quantity)}<span className="block text-xs">{l.rejection_reason}{l.rejected_location_code ? ` → ${l.rejected_location_code}` : ' (recorded only)'}</span></span> : '0'}</TableCell>
                {!direct && <><TableCell className="text-right tabular-nums">{pl && Number(pl.pending_quantity) > 0 ? <span className="text-amber-800">{formatQty(pl.pending_quantity)}</span> : '0'}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.over_receipt_reason ? <span className="text-amber-800" title={l.over_receipt_reason}>yes</span> : '—'}</TableCell></>}
                <TableCell>{l.accepted_location_code ?? '—'}</TableCell>
                <TableCell>{l.batch_number ?? '—'}{l.expiry_date ? <span className="block text-xs text-muted-foreground">exp {formatDate(l.expiry_date)}</span> : null}</TableCell>
                <TableCell className="text-xs">{[l.accepted_transaction_number, l.rejected_transaction_number].filter(Boolean).join(', ') || '—'}</TableCell>
                {direct && <TableCell className="text-right tabular-nums">{l.line_value === null ? <span className="text-amber-800">Cost not set</span> : money(l.line_value)}</TableCell>}
              </TableRow>
            )
          })}</TableBody>
        </Table>
      </Card>

      <RecordDocuments entityType="GOODS_RECEIPT" entityId={r.id} defaultType="DELIVERY_PROOF" />

      {reversing && <ReverseDialog number={r.receipt_number} receiptId={r.id} onClose={() => setReversing(false)} onDone={(m) => { setReversing(false); setNotice(m); setRefresh((n) => n + 1) }} />}
      {correcting && po && (
        <GoodsReceiptDialog po={po} lines={poLines} correction={{ receipt: r, lines }} onClose={() => setCorrecting(false)}
          onPosted={(m) => { setCorrecting(false); setNotice(m); setRefresh((n) => n + 1) }} />
      )}
      {correcting && direct && (
        <DirectReceiptDialog correction={{ receipt: r, lines }} onClose={() => setCorrecting(false)}
          onPosted={(m, id) => { setCorrecting(false); navigate(`/goods-receipts/${id}`, { state: { message: m } }) }} />
      )}
    </>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return <Card><CardContent className="space-y-1 p-4"><p className="text-xs text-muted-foreground">{label}</p><div className="text-sm">{children}</div></CardContent></Card>
}

export function ReverseDialog({ number, receiptId, onClose, onDone }: { number: string; receiptId: string; onClose: () => void; onDone: (m: string) => void }) {
  const request = useRequestKey()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Reverse {number}?</DialogTitle>
          <DialogDescription>All stock posted by this receipt is taken back out (it must still be in stock) and the order's pending quantities go back up. The receipt stays in the history as reversed. To fix quantities instead, use Correct.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-1"><Label htmlFor="rv-reason">Reason</Label><Textarea id="rv-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" disabled={busy || reason.trim().length < 5} onClick={async () => {
            setBusy(true); setError(null)
            try {
              const res = await reverseGoodsReceipt(receiptId, reason.trim(), request.key)
              request.renew()
              onDone(`${number} reversed (${res.reversal_numbers.join(', ') || 'no stock postings'}).`)
            } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Reverse receipt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
