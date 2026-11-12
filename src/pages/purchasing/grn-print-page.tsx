import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { LOGO_ALT } from '@/components/layout/company-logo'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/auth/use-auth'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { useDocumentLogo } from '@/features/management/erp-preferences'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchGoodsReceipt } from '@/services/purchasing'

/**
 * A4 print layout of a goods received note: Alton GRN number, the order, the
 * supplier's invoice and challan numbers, and every line received / accepted /
 * rejected. "Save as PDF" uses the browser's print dialog, as for purchase orders.
 */
export default function GrnPrintPage() {
  const documentLogo = useDocumentLogo()
  const { access } = useAuth()
  const { receiptId = '' } = useParams()
  const grn = useAsync(() => fetchGoodsReceipt(receiptId), [receiptId])
  if (grn.loading) return <LoadingState variant="cards" rows={3} />
  if (grn.error || !grn.data) return <ErrorState message={describeDataError(grn.error)} onRetry={grn.reload} />
  const { receipt: r, lines } = grn.data
  const direct = r.receipt_type === 'DIRECT'
  const company = access?.company

  return (
    <>
      <div className="print-hidden mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" asChild><Link to={`/goods-receipts/${r.id}`}><ArrowLeft /> Back to GRN</Link></Button>
        <Button onClick={() => window.print()}><Printer /> Print</Button>
        <span className="text-sm text-muted-foreground">To save a PDF, choose "Save as PDF" as the printer. The application does not generate PDF files itself.</span>
        {r.status === 'REVERSED' && <span className="text-sm font-medium text-amber-800">This receipt was reversed.</span>}
      </div>
      <article className="print-area relative mx-auto max-w-[210mm] border bg-white p-8 text-[11px] leading-snug text-gray-900 shadow-sm">
        {r.status === 'REVERSED' && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-bold text-gray-200 rotate-[-30deg]">REVERSED</div>}
        <header className="relative flex items-start justify-between gap-6 border-b pb-3">
          <div>
            <img src={documentLogo} alt={LOGO_ALT} className="mb-2 h-10 w-auto object-contain" />
            <p className="text-base font-bold">{company?.legal_name ?? company?.display_name ?? ''}</p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tracking-wide">GOODS RECEIVED NOTE</p>
            <p>GRN no.: <span className="font-semibold">{r.receipt_number}</span></p>
            <p>Receipt date: {formatDate(r.receipt_date)}</p>
            <p>{direct ? 'Received without a purchase order' : <>Against PO: <span className="font-semibold">{r.po_number}</span></>}</p>
            {r.corrects_receipt_id && <p>Corrects an earlier (reversed) receipt</p>}
          </div>
        </header>
        <section className="relative grid grid-cols-2 gap-6 border-b py-3">
          <div>
            <p className="font-semibold">Supplier</p>
            <p className="font-medium">{r.supplier_name ?? 'No supplier recorded'}{r.supplier_code ? ` (${r.supplier_code})` : ''}</p>
            <p>Received into: {r.warehouse_code ?? '—'}</p>
          </div>
          <dl className="space-y-0.5">
            <div className="flex justify-between gap-4"><dt>Supplier invoice no.</dt><dd className="font-semibold">{r.supplier_invoice_number ?? '—'}</dd></div>
            <div className="flex justify-between gap-4"><dt>Supplier challan no.</dt><dd className="font-semibold">{r.supplier_challan_number ?? '—'}</dd></div>
            {r.supplier_document_number && <div className="flex justify-between gap-4"><dt>Earlier supplier reference</dt><dd>{r.supplier_document_number}</dd></div>}
            {r.supporting_document_ref && <div className="flex justify-between gap-4"><dt>Supporting document</dt><dd>{r.supporting_document_ref}</dd></div>}
          </dl>
        </section>
        <table className="relative mt-3 w-full border-collapse">
          <thead><tr className="border-y bg-gray-50 text-left">
            <th className="p-1">#</th><th className="p-1">Item</th><th className="p-1">HSN</th>{!direct && <th className="p-1 text-right">Ordered</th>}
            <th className="p-1 text-right">Received</th><th className="p-1 text-right">Accepted</th><th className="p-1 text-right">Rejected</th>
            <th className="p-1">Stored in</th><th className="p-1">Batch</th><th className="p-1 text-right">Value (incl. GST)</th>
          </tr></thead>
          <tbody>{lines.map((l, i) => (
            <tr key={l.id} className="print-avoid-break border-b align-top">
              <td className="p-1">{l.po_line_no ?? i + 1}</td>
              <td className="p-1">{l.sku ? `${l.sku} — ` : ''}{l.description}{Number(l.rejected_quantity) > 0 && l.rejection_reason && <span className="block text-[9px] text-gray-600">Rejected: {l.rejection_reason}</span>}</td>
              <td className="p-1" data-testid="grn-print-hsn">{l.hsn_code ?? '—'}</td>
              {!direct && <td className="p-1 text-right">{l.ordered_quantity === null ? '—' : formatQty(l.ordered_quantity, l.unit)}</td>}
              <td className="p-1 text-right">{formatQty(l.received_quantity, l.unit)}</td>
              <td className="p-1 text-right">{formatQty(l.accepted_quantity)}</td>
              <td className="p-1 text-right">{formatQty(l.rejected_quantity)}</td>
              <td className="p-1">{l.accepted_location_code ?? '—'}</td>
              <td className="p-1">{l.batch_number ?? '—'}{l.expiry_date ? ` (exp ${formatDate(l.expiry_date)})` : ''}</td>
              <td className="p-1 text-right">{l.line_value === null ? '—' : money(l.line_value, false)}</td>
            </tr>
          ))}</tbody>
        </table>
        {r.notes && <p className="relative mt-3 whitespace-pre-line">Remarks: {r.notes}</p>}
        <footer className="print-avoid-break relative mt-8 grid grid-cols-2 gap-6 border-t pt-3">
          <p>Only accepted quantities were added to stock. Rejected goods are never available stock.</p>
          <div className="text-right">
            <p>Received by</p>
            <p className="mt-10">Authorised signatory</p>
          </div>
        </footer>
      </article>
    </>
  )
}
