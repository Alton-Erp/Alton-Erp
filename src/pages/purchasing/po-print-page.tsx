import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { Button } from '@/components/ui/button'
import { LOGO_ALT } from '@/components/layout/company-logo'
import { useDocumentLogo } from '@/features/management/erp-preferences'
import { amountInWords } from '@/features/billing/amount-in-words'
import { money } from '@/features/billing/billing-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { formatQty } from '@/features/inventory/inventory-model'
import { PO_STATUS_LABELS } from '@/features/purchasing/po-model'
import { paymentTermsLabel } from '@/features/suppliers/supplier-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchPoLines, fetchPurchaseOrder } from '@/services/purchasing'

/** Sums 2-decimal database values exactly (integer paise). */
const paise = (v: number | string) => Math.round(Number(v) * 100)
const fromPaise = (p: number) => (p / 100).toFixed(2)

/**
 * A4 print layout of a purchase order from its saved snapshots (buyer,
 * supplier, delivery, lines, totals). "Save as PDF" uses the browser's print
 * dialog, as for invoices; the application does not generate PDF files itself.
 * Table headers repeat on every printed page and rows are not split.
 */
export default function PoPrintPage() {
  const documentLogo = useDocumentLogo()
  const { poId = '' } = useParams()
  const po = useAsync(() => fetchPurchaseOrder(poId), [poId])
  const lines = useAsync(() => fetchPoLines(poId), [poId])
  const { label } = useGstStates()
  const o = po.data
  if (po.loading || lines.loading) return <LoadingState variant="cards" rows={3} />
  if (po.error || !o) return <ErrorState message={describeDataError(po.error)} onRetry={po.reload} />
  const ls = lines.data ?? []
  const notFinal = ['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(o.status)
  const intra = o.tax_treatment === 'INTRA_STATE'
  const inter = o.tax_treatment === 'INTER_STATE'
  const byRate = new Map<string, { taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const l of ls) {
    const k = l.gst_rate === null ? '—' : `${Number(l.gst_rate)}%`
    const r = byRate.get(k) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    r.taxable += paise(l.taxable_value); r.cgst += paise(l.cgst_amount); r.sgst += paise(l.sgst_amount); r.igst += paise(l.igst_amount)
    byRate.set(k, r)
  }
  const reconciles = ls.reduce((s, l) => s + paise(l.line_total), 0) + paise(o.round_off) === paise(o.grand_total)

  return (
    <>
      <div className="print-hidden mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" asChild><Link to={`/purchase-orders/${o.id}`}><ArrowLeft /> Back to order</Link></Button>
        <Button onClick={() => window.print()}><Printer /> Print</Button>
        <span className="text-sm text-muted-foreground">To save a PDF, choose "Save as PDF" as the printer. The application does not generate PDF files itself.</span>
        {notFinal && <span className="text-sm font-medium text-amber-800">{PO_STATUS_LABELS[o.status]}: not a valid purchase order to send.</span>}
        {!reconciles && <span className="text-sm font-medium text-shortage">Line totals do not reconcile with the order total — do not use this print.</span>}
      </div>
      <article className="print-area relative mx-auto max-w-[210mm] border bg-white p-8 text-[11px] leading-snug text-gray-900 shadow-sm">
        {notFinal && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-bold text-gray-200 rotate-[-30deg]">{o.status === 'CANCELLED' ? 'CANCELLED' : 'DRAFT'}</div>}
        <header className="relative flex items-start justify-between gap-6 border-b pb-3">
          <div>
            <img src={documentLogo} alt={LOGO_ALT} className="mb-2 h-10 w-auto object-contain" />
            <p className="text-base font-bold">{o.buyer_legal_name}</p>
            {o.buyer_address && <p className="whitespace-pre-line">{o.buyer_address}</p>}
            {o.buyer_gstin && <p>GSTIN: {o.buyer_gstin} · State: {label(o.place_of_supply_state_code)}</p>}
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tracking-wide">PURCHASE ORDER</p>
            <p>PO no.: <span className="font-semibold">{o.po_number}</span>{o.revision ? ` (revision ${o.revision})` : ''}</p>
            <p>PO date: {formatDate(o.po_date)}</p>
            {o.expected_delivery_date && <p>Expected delivery: {formatDate(o.expected_delivery_date)}</p>}
            {o.reference_number && <p>Your reference: {o.reference_number}</p>}
            {o.supplier_invoice_number && <p>Your invoice no.: {o.supplier_invoice_number}</p>}
            {o.supplier_challan_number && <p>Your challan no.: {o.supplier_challan_number}</p>}
          </div>
        </header>
        <section className="relative grid grid-cols-2 gap-6 border-b py-3">
          <div>
            <p className="font-semibold">Supplier</p>
            <p className="font-medium">{o.supplier_name} ({o.supplier_code})</p>
            {o.supplier_billing_address && <p className="whitespace-pre-line">{o.supplier_billing_address}</p>}
            {o.supplier_state_code && <p>State: {label(o.supplier_state_code)}</p>}
            <p>GSTIN: {o.supplier_gstin ?? 'Unregistered'}</p>
            {(o.supplier_contact_person || o.supplier_phone || o.supplier_email) && <p>{[o.supplier_contact_person, o.supplier_phone, o.supplier_email].filter(Boolean).join(' · ')}</p>}
          </div>
          <div>
            <p className="font-semibold">Deliver to</p>
            <p className="font-medium">{o.buyer_legal_name}{o.warehouse_name ? ` — ${o.warehouse_name}` : ''}</p>
            <p className="whitespace-pre-line">{o.delivery_address ?? o.buyer_address ?? '—'}</p>
            {o.delivery_instructions && <p className="mt-1 whitespace-pre-line">Instructions: {o.delivery_instructions}</p>}
          </div>
        </section>
        <table className="relative mt-3 w-full border-collapse">
          <thead><tr className="border-y bg-gray-50 text-left">
            <th className="p-1">#</th><th className="p-1">Description</th><th className="p-1">HSN/SAC</th><th className="p-1 text-right">Qty</th><th className="p-1 text-right">Rate</th>
            <th className="p-1 text-right">Discount</th><th className="p-1 text-right">Taxable</th>
            {intra && <><th className="p-1 text-right">CGST</th><th className="p-1 text-right">SGST</th></>}
            {inter && <th className="p-1 text-right">IGST</th>}
            <th className="p-1 text-right">Total</th>
          </tr></thead>
          <tbody>{ls.map((l) => (
            <tr key={l.id} className="print-avoid-break border-b align-top">
              <td className="p-1">{l.line_no}</td>
              <td className="p-1">{l.sku ? `${l.sku} — ` : ''}{l.description}</td>
              <td className="p-1">{l.hsn_sac}</td>
              <td className="p-1 text-right">{formatQty(l.ordered_quantity, l.unit)}</td>
              <td className="p-1 text-right">{l.unit_price === null ? '—' : money(l.unit_price, false)}</td>
              <td className="p-1 text-right">{Number(l.discount_amount) ? money(l.discount_amount, false) : ''}</td>
              <td className="p-1 text-right">{money(l.taxable_value, false)}</td>
              {intra && <>
                <td className="p-1 text-right">{money(l.cgst_amount, false)}<span className="block text-[9px] text-gray-500">{Number(l.cgst_rate)}%</span></td>
                <td className="p-1 text-right">{money(l.sgst_amount, false)}<span className="block text-[9px] text-gray-500">{Number(l.sgst_rate)}%</span></td>
              </>}
              {inter && <td className="p-1 text-right">{money(l.igst_amount, false)}<span className="block text-[9px] text-gray-500">{Number(l.igst_rate)}%</span></td>}
              <td className="p-1 text-right">{money(l.line_total, false)}</td>
            </tr>
          ))}</tbody>
        </table>
        <section className="print-avoid-break relative mt-3 grid grid-cols-2 gap-6">
          <div>
            {(intra || inter) ? (
              <>
                <p className="font-semibold">Tax summary</p>
                <table className="mt-1 w-full border-collapse">
                  <thead><tr className="border-b text-left"><th className="p-1">GST rate</th><th className="p-1 text-right">Taxable</th><th className="p-1 text-right">CGST</th><th className="p-1 text-right">SGST</th><th className="p-1 text-right">IGST</th></tr></thead>
                  <tbody>{[...byRate.entries()].map(([k, r]) => (
                    <tr key={k} className="border-b"><td className="p-1">{k}</td><td className="p-1 text-right">{fromPaise(r.taxable)}</td><td className="p-1 text-right">{fromPaise(r.cgst)}</td><td className="p-1 text-right">{fromPaise(r.sgst)}</td><td className="p-1 text-right">{fromPaise(r.igst)}</td></tr>
                  ))}</tbody>
                </table>
              </>
            ) : (
              <p>{o.tax_treatment === 'NO_GST' ? 'No GST: the supplier is not GST-registered.' : o.tax_treatment === 'IMPORT' ? 'Import: customs duty and IGST on import are not included.' : 'Tax not determined.'}</p>
            )}
            <p className="mt-2">Amount in words: <span className="font-medium">{amountInWords(Number(o.grand_total).toFixed(2))}</span></p>
          </div>
          <dl className="space-y-0.5">
            {[['Subtotal', o.gross_total], ['Discount', o.discount_total], ['Taxable amount', o.taxable_total], ['Other charges (incl. above)', o.other_charges_total],
              ['CGST', o.cgst_total], ['SGST', o.sgst_total], ['IGST', o.igst_total], ['Round-off', o.round_off]].map(([k, v]) => (
              <div key={k as string} className="flex justify-between"><dt>{k as string}</dt><dd>{money(v as number)}</dd></div>
            ))}
            <div className="flex justify-between border-t pt-1 text-sm font-bold"><dt>Grand total (INR)</dt><dd>{money(o.grand_total)}</dd></div>
          </dl>
        </section>
        <footer className="print-avoid-break relative mt-4 grid grid-cols-2 gap-6 border-t pt-3">
          <div className="space-y-1">
            <p>Payment terms: {paymentTermsLabel(o.payment_terms, o.custom_payment_days)}</p>
            <p>Delivery: to the address above{o.expected_delivery_date ? ` by ${formatDate(o.expected_delivery_date)}` : ''}. Please quote the PO number on your challan and invoice.</p>
            {o.purchase_conditions && <p className="whitespace-pre-line text-[10px]">Conditions: {o.purchase_conditions}</p>}
          </div>
          <div className="text-right">
            <p>For {o.buyer_legal_name}</p>
            <p className="mt-10">Authorised signatory</p>
          </div>
        </footer>
      </article>
    </>
  )
}
