import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { LOGO_ALT } from '@/components/layout/company-logo'
import { useDocumentLogo } from '@/features/management/erp-preferences'
import { Button } from '@/components/ui/button'
import { amountInWords } from '@/features/billing/amount-in-words'
import { NOTE_REASON_LABELS, money } from '@/features/billing/billing-model'
import { useGstStates } from '@/features/billing/use-gst-states'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBillingSettings, fetchInvoice, fetchNote, fetchNoteLines } from '@/services/billing'

async function load(noteId: string) {
  const [note, lines] = await Promise.all([fetchNote(noteId), fetchNoteLines(noteId)])
  const invoice = await fetchInvoice(note.original_invoice_id)
  return { note, lines, invoice }
}

/** /billing/notes/:noteId/print — A4 credit or debit note linked to its original invoice. */
export default function NotePrintPage() {
  const documentLogo = useDocumentLogo()
  const { noteId = '' } = useParams()
  const data = useAsync(() => load(noteId), [noteId])
  const settings = useAsync(fetchBillingSettings, [])
  const { label } = useGstStates()
  if (data.loading && !data.data) return <LoadingState variant="cards" rows={3} />
  if (data.error || !data.data) return <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
  const { note: n, lines, invoice: i } = data.data
  const s = settings.data
  const intra = n.tax_treatment === 'INTRA_STATE'
  const heading = n.note_type === 'CREDIT' ? 'CREDIT NOTE' : 'DEBIT NOTE'
  const issued = n.status === 'ISSUED' || n.status === 'CANCELLED'

  return (
    <>
      <div className="print-hidden mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" asChild><Link to={`/billing/notes/${n.id}`}><ArrowLeft /> Back to note</Link></Button>
        <Button onClick={() => window.print()}><Printer /> Print / Save as PDF</Button>
        {!issued && <span className="text-sm font-medium text-amber-800">Draft preview — not valid until issued.</span>}
      </div>
      <article className="print-area relative mx-auto max-w-[210mm] border border-t-4 border-t-blue-700 bg-white p-8 text-[11px] leading-snug text-gray-900 shadow-sm" data-testid="note-print">
        {(!issued || n.status === 'CANCELLED') && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-7xl font-bold text-gray-200 rotate-[-30deg]">{issued ? 'CANCELLED' : 'DRAFT'}</div>}
        <header className="relative flex items-start justify-between gap-6 border-b-2 border-blue-700 pb-3">
          <div className="flex items-start gap-4">
            {(s?.show_logo ?? true) && <img src={documentLogo} alt={LOGO_ALT} className="h-10 w-auto" />}
            <div>
              <p className="text-base font-bold text-blue-900">{i.seller_legal_name}</p>
              <p className="whitespace-pre-line">{i.seller_address}</p>
              {i.seller_gstin && <p>GSTIN: <span className="font-medium">{i.seller_gstin}</span> · State: {label(i.seller_state_code)}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold tracking-wide text-blue-800">{heading}</p>
            <p>Note no.: <span className="font-semibold">{n.note_number ?? '(assigned on issue)'}</span></p>
            <p>Date: {formatDate(n.note_date)}</p>
            <p>Against invoice: <span className="font-semibold">{i.invoice_number}</span> dated {formatDate(i.invoice_date)}</p>
          </div>
        </header>
        <section className="relative grid grid-cols-2 gap-6 border-b py-3">
          <div>
            <p className="font-semibold text-blue-800">Customer</p>
            <p className="font-medium">{i.customer_legal_name}</p>
            <p className="whitespace-pre-line">{i.customer_billing_address}</p>
            <p>GSTIN: {i.customer_gstin ?? 'Unregistered'}</p>
          </div>
          <div>
            <p>Place of supply: <span className="font-medium">{label(i.place_of_supply_state_code)}</span></p>
            <p>Reason: <span className="font-medium">{NOTE_REASON_LABELS[n.reason_code] ?? n.reason_code}</span></p>
            <p className="whitespace-pre-line">{n.reason}</p>
            {n.supporting_reference && <p>Reference: {n.supporting_reference}</p>}
          </div>
        </section>
        <table className="relative mt-3 w-full border-collapse">
          <thead><tr className="border-y border-blue-700 bg-blue-50 text-left text-blue-900">
            <th className="p-1">#</th><th className="p-1">Description</th><th className="p-1">HSN/SAC</th><th className="p-1 text-right">Qty</th><th className="p-1 text-right">Taxable</th>
            {intra ? <><th className="p-1 text-right">CGST</th><th className="p-1 text-right">SGST</th></> : <th className="p-1 text-right">IGST</th>}
            <th className="p-1 text-right">Total</th>
          </tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.id} className="border-b align-top">
              <td className="p-1">{l.line_no}</td><td className="p-1">{l.description}</td><td className="p-1">{l.hsn_sac}</td>
              <td className="p-1 text-right">{l.quantity === null ? '—' : formatQty(l.quantity)}</td>
              <td className="p-1 text-right">{money(l.taxable_amount, false)}</td>
              {intra ? <><td className="p-1 text-right">{money(l.cgst_amount, false)}</td><td className="p-1 text-right">{money(l.sgst_amount, false)}</td></>
                : <td className="p-1 text-right">{money(l.igst_amount, false)}</td>}
              <td className="p-1 text-right">{money(l.line_total, false)}</td>
            </tr>
          ))}</tbody>
        </table>
        <section className="relative mt-3 grid grid-cols-2 gap-6">
          <p>Amount in words: <span className="font-medium">{amountInWords(Number(n.total_amount).toFixed(2))}</span></p>
          <dl className="space-y-0.5">
            {([['Taxable value', n.taxable_amount], ...(intra ? [['CGST', n.cgst_amount], ['SGST', n.sgst_amount]] : [['IGST', n.igst_amount]])] as [string, number][]).map(([k, v]) => (
              <div key={k} className="flex justify-between"><dt>{k}</dt><dd>{money(v)}</dd></div>
            ))}
            <div className="flex justify-between border-t-2 border-blue-700 pt-1 text-sm font-bold text-blue-900"><dt>{n.note_type === 'CREDIT' ? 'Total credit' : 'Total debit'}</dt><dd>{money(n.total_amount)}</dd></div>
          </dl>
        </section>
        <footer className="relative mt-6 flex justify-end border-t pt-3 text-right">
          <div><p>For <span className="font-semibold">{i.seller_legal_name}</span></p>
            <div className="mt-12 border-t border-gray-400 pt-1">{s?.authorized_signatory ? `${s.authorized_signatory} — ` : ''}Authorised signatory</div></div>
        </footer>
      </article>
    </>
  )
}
