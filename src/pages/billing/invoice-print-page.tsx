import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { LOGO_ALT } from '@/components/layout/company-logo'
import { useDocumentLogo } from '@/features/management/erp-preferences'
import { Button } from '@/components/ui/button'
import { amountInWords } from '@/features/billing/amount-in-words'
import { money } from '@/features/billing/billing-model'
import { documentTitle } from '@/features/billing/invoicing-v2-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBillingSettings, fetchInvoice, fetchInvoiceLines } from '@/services/billing'

/** Sums 2-decimal database values exactly (integer paise) for the rate summary. */
const paise = (v: number | string) => Math.round(Number(v) * 100)
const fromPaise = (p: number) => (p / 100).toFixed(2)

/**
 * A4 print layout of an invoice from its saved snapshots (seller, customer,
 * place of supply, lines, totals). Printing an old invoice never re-reads the
 * masters. "Save as PDF" in the browser's print dialog produces the PDF.
 * Headings: TAX INVOICE, BILL OF SUPPLY or PROFORMA INVOICE (a proforma is
 * never shown as a tax invoice).
 */
export default function InvoicePrintPage() {
  const documentLogo = useDocumentLogo()
  const { invoiceId = '' } = useParams()
  const inv = useAsync(() => fetchInvoice(invoiceId), [invoiceId])
  const lines = useAsync(() => fetchInvoiceLines(invoiceId), [invoiceId])
  const settings = useAsync(fetchBillingSettings, [])
  const { label } = useGstStates()
  const i = inv.data
  if (inv.loading || lines.loading) return <LoadingState variant="cards" rows={3} />
  if (inv.error || !i) return <ErrorState message={describeDataError(inv.error)} onRetry={inv.reload} />
  const s = settings.data
  const ls = lines.data ?? []
  const proforma = Boolean(i.is_proforma)
  const draft = i.status !== 'ISSUED' && i.status !== 'CANCELLED' && !proforma
  const intra = i.tax_treatment === 'INTRA_STATE'
  const byRate = new Map<string, { taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const l of ls) {
    const k = l.gst_rate === null ? '—' : `${Number(l.gst_rate)}%`
    const r = byRate.get(k) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    r.taxable += paise(l.taxable_value); r.cgst += paise(l.cgst_amount); r.sgst += paise(l.sgst_amount); r.igst += paise(l.igst_amount)
    byRate.set(k, r)
  }
  const reconciles = ls.reduce((sum, l) => sum + paise(l.line_total), 0) + paise(i.round_off) === paise(i.grand_total)
  const heading = documentTitle(i)
  const numberLabel = proforma ? 'Proforma no.' : heading === 'BILL OF SUPPLY' ? 'Bill no.' : 'Invoice no.'
  const number = proforma ? i.proforma_number : i.invoice_number
  const bank = i.bank_snapshot ?? (s?.bank_accounts?.[0] ? { account_name: s.bank_accounts[0].account_name ?? s.company.legal_name, bank_name: s.bank_accounts[0].bank_name ?? null,
    account_number: s.bank_accounts[0].account_number, ifsc: s.bank_accounts[0].ifsc, branch: s.bank_accounts[0].branch ?? null }
    : s?.show_bank_details && s.bank_account_number ? { account_name: s.bank_account_name ?? '', bank_name: s.bank_name, account_number: s.bank_account_number, ifsc: s.bank_ifsc ?? '', branch: s.bank_branch } : null)
  const terms = i.status === 'ISSUED' || i.status === 'CANCELLED' ? i.terms_snapshot : s?.terms_text
  const footer = i.status === 'ISSUED' || i.status === 'CANCELLED' ? i.footer_snapshot : s?.footer_text
  const lineDiscount = (l: (typeof ls)[number]) => Number(l.discount_amount) + Number(l.invoice_discount_share ?? 0)

  return (
    <>
      <div className="print-hidden mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" asChild><Link to={`/billing/invoices/${i.id}`}><ArrowLeft /> Back to invoice</Link></Button>
        <Button onClick={() => window.print()}><Printer /> Print / Save as PDF</Button>
        <span className="text-sm text-muted-foreground">A4. To download, choose "Save as PDF" as the printer.</span>
        {draft && <span className="text-sm font-medium text-amber-800">Draft preview — not a valid invoice until issued.</span>}
        {proforma && <span className="text-sm font-medium text-blue-800">Proforma invoice — not a tax invoice; no GST liability arises from it.</span>}
        {!reconciles && <span className="text-sm font-medium text-shortage">Line totals do not reconcile with the invoice total — do not use this print.</span>}
      </div>
      <article className="print-area relative mx-auto max-w-[210mm] border border-t-4 border-t-blue-700 bg-white p-8 text-[11px] leading-snug text-gray-900 shadow-sm" data-testid="invoice-print">
        {(draft || i.status === 'CANCELLED') && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-bold text-gray-200 rotate-[-30deg]">{draft ? 'DRAFT' : 'CANCELLED'}</div>}
        <header className="relative flex items-start justify-between gap-6 border-b-2 border-blue-700 pb-3">
          <div className="flex items-start gap-4">
            {(s?.show_logo ?? true) && <img src={documentLogo} alt={LOGO_ALT} className="h-10 w-auto" />}
            <div>
              <p className="text-base font-bold text-blue-900">{i.seller_legal_name}</p>
              <p className="whitespace-pre-line">{i.seller_address}</p>
              {i.seller_gstin && <p>GSTIN: <span className="font-medium">{i.seller_gstin}</span> · State: {label(i.seller_state_code)}</p>}
              {i.seller_pan && <p>PAN: {i.seller_pan}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tracking-wide text-blue-800">{heading}</p>
            {i.status === 'CANCELLED' && <p className="font-bold text-red-700">CANCELLED</p>}
            <p>{numberLabel}: <span className="font-semibold">{number ?? '(assigned on issue)'}</span></p>
            {proforma && i.invoice_number && <p>Invoice no.: {i.invoice_number}</p>}
            <p>Date: {formatDate(i.invoice_date)}</p>
            {i.due_date && <p>{proforma ? 'Valid / payable by' : 'Due date'}: {formatDate(i.due_date)}</p>}
            {i.financial_year && <p>Financial year: {i.financial_year}</p>}
          </div>
        </header>
        <section className="relative grid grid-cols-2 gap-6 border-b py-3">
          <div>
            <p className="font-semibold text-blue-800">Bill to</p>
            <p className="font-medium">{i.customer_legal_name}</p>
            <p className="whitespace-pre-line">{i.customer_billing_address}</p>
            {i.customer_billing_state_code && <p>State: {label(i.customer_billing_state_code)}</p>}
            <p>GSTIN: {i.customer_gstin ?? 'Unregistered'}</p>
            {i.customer_pan && <p>PAN: {i.customer_pan}</p>}
          </div>
          <div>
            <p className="font-semibold text-blue-800">Ship to</p>
            <p className="whitespace-pre-line">{i.customer_shipping_address ?? 'Same as billing address'}</p>
            {i.customer_shipping_state_code && <p>State: {label(i.customer_shipping_state_code)}</p>}
            <p className="mt-1">Place of supply: <span className="font-medium">{label(i.place_of_supply_state_code)}</span></p>
            {i.order_references && <p>Sales order: {i.order_references}</p>}
            {i.dispatch_references && <p>Dispatches: {i.dispatch_references}</p>}
            {i.transport_details && <p>Transport: {i.transport_details}</p>}
            {i.vehicle_number && <p>Vehicle no.: {i.vehicle_number}</p>}
            {i.eway_bill_number && <p>E-way bill no.: {i.eway_bill_number}</p>}
          </div>
        </section>
        <table className="relative mt-3 w-full border-collapse">
          <thead><tr className="border-y border-blue-700 bg-blue-50 text-left text-blue-900">
            <th className="p-1">#</th><th className="p-1">Description</th><th className="p-1">HSN/SAC</th><th className="p-1 text-right">Qty</th><th className="p-1 text-right">Rate</th>
            <th className="p-1 text-right">Discount</th><th className="p-1 text-right">Taxable</th>
            {intra ? <><th className="p-1 text-right">CGST</th><th className="p-1 text-right">SGST</th></> : <th className="p-1 text-right">IGST</th>}
            <th className="p-1 text-right">Total</th>
          </tr></thead>
          <tbody>{ls.map((l) => (
            <tr key={l.id} className="print-avoid-break border-b align-top">
              <td className="p-1">{l.line_no}</td>
              <td className="p-1">{l.sku ? `${l.sku} — ` : ''}{l.description}</td>
              <td className="p-1">{l.hsn_sac}</td>
              <td className="p-1 text-right">{formatQty(l.quantity, l.unit ?? undefined)}</td>
              <td className="p-1 text-right">{money(l.unit_price, false)}</td>
              <td className="p-1 text-right">{lineDiscount(l) ? money(lineDiscount(l), false) : ''}</td>
              <td className="p-1 text-right">{money(l.taxable_value, false)}</td>
              {intra ? <>
                <td className="p-1 text-right">{money(l.cgst_amount, false)}<span className="block text-[9px] text-gray-500">{Number(l.cgst_rate)}%</span></td>
                <td className="p-1 text-right">{money(l.sgst_amount, false)}<span className="block text-[9px] text-gray-500">{Number(l.sgst_rate)}%</span></td>
              </> : <td className="p-1 text-right">{money(l.igst_amount, false)}<span className="block text-[9px] text-gray-500">{Number(l.igst_rate)}%</span></td>}
              <td className="p-1 text-right">{money(l.line_total, false)}</td>
            </tr>
          ))}</tbody>
        </table>
        {i.pricing_mode === 'INCLUSIVE' && <p className="relative mt-1 text-[9px] text-gray-500">Rates include GST; the taxable value is the rate less the GST included in it.</p>}
        <section className="print-avoid-break relative mt-3 grid grid-cols-2 gap-6">
          <div>
            <p className="font-semibold text-blue-800">Tax summary</p>
            <table className="mt-1 w-full border-collapse">
              <thead><tr className="border-b text-left"><th className="p-1">GST rate</th><th className="p-1 text-right">Taxable</th><th className="p-1 text-right">CGST</th><th className="p-1 text-right">SGST</th><th className="p-1 text-right">IGST</th></tr></thead>
              <tbody>{[...byRate.entries()].map(([k, r]) => (
                <tr key={k} className="border-b"><td className="p-1">{k}</td><td className="p-1 text-right">{fromPaise(r.taxable)}</td><td className="p-1 text-right">{fromPaise(r.cgst)}</td><td className="p-1 text-right">{fromPaise(r.sgst)}</td><td className="p-1 text-right">{fromPaise(r.igst)}</td></tr>
              ))}</tbody>
            </table>
            <p className="mt-2">Amount in words: <span className="font-medium">{amountInWords(Number(i.grand_total).toFixed(2))}</span></p>
          </div>
          <dl className="space-y-0.5">
            {([['Gross value', i.gross_total], ['Discount', i.discount_total], ['Freight / packing / other', i.other_charges_total], ['Taxable value', i.taxable_subtotal],
              ...(intra ? [['CGST', i.cgst_total], ['SGST', i.sgst_total]] : [['IGST', i.igst_total]]), ['Round-off', i.round_off]] as [string, number][])
              .filter(([k, v]) => k !== 'Freight / packing / other' || Number(v) !== 0).map(([k, v]) => (
                <div key={k} className="flex justify-between"><dt>{k}</dt><dd>{money(v)}</dd></div>
              ))}
            <div className="flex justify-between border-t-2 border-blue-700 pt-1 text-sm font-bold text-blue-900"><dt>Grand total</dt><dd>{money(i.grand_total)}</dd></div>
            {i.status === 'ISSUED' && Number(i.paid) > 0 && <>
              <div className="flex justify-between"><dt>Amount received</dt><dd>{money(i.paid)}</dd></div>
              <div className="flex justify-between font-semibold"><dt>Balance due</dt><dd>{money(i.balance_due)}</dd></div></>}
          </dl>
        </section>
        <footer className="print-avoid-break relative mt-4 grid grid-cols-2 gap-6 border-t pt-3">
          <div className="space-y-1">
            <p>Payment terms: {i.payment_terms_days} days{i.due_date ? ` (due ${formatDate(i.due_date)})` : ''}</p>
            {i.notes && <p className="whitespace-pre-line">{i.notes}</p>}
            {bank && (
              <div className="rounded border border-blue-200 bg-blue-50/50 p-2 text-[10px]"><p className="font-semibold text-blue-900">Bank details</p>
                <p>{bank.account_name}{bank.bank_name ? ` · ${bank.bank_name}` : ''}</p><p>A/c {bank.account_number} · IFSC {bank.ifsc}{bank.branch ? ` · ${bank.branch}` : ''}</p></div>
            )}
            {terms && <div className="text-[10px]"><p className="font-semibold">Terms and conditions</p><p className="whitespace-pre-line">{terms}</p></div>}
          </div>
          <div className="flex flex-col items-end justify-between text-right">
            <p>For <span className="font-semibold">{i.seller_legal_name}</span></p>
            <div><div className="mt-12 border-t border-gray-400 pt-1">{s?.authorized_signatory ? `${s.authorized_signatory} — ` : ''}Authorised signatory</div></div>
          </div>
          {footer && <p className="col-span-2 text-center text-[10px] text-gray-600">{footer}</p>}
          <p className="col-span-2 text-center text-[9px] text-gray-500">{proforma ? 'This is a proforma invoice for quotation / advance payment only. A tax invoice is issued on supply.' : 'Computer-generated invoice. E-invoice (IRN) not generated: no e-invoicing integration is configured.'}</p>
        </footer>
      </article>
    </>
  )
}
