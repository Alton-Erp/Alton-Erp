import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { NOTE_REASON_LABELS, isAmount, money } from '@/features/billing/billing-model'
import { paymentModeLabel } from '@/features/billing/invoicing-v2-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import type { BillingSettings } from '@/services/billing'
import { applyAdvance, fetchAdvances, issueNoteV2, recordInvoicePayment } from '@/services/invoicing-v2'
import type { NoteReason, PaymentMethod, SalesInvoiceLineRow, SalesInvoiceListRow } from '@/types/database-billing'

const ErrorBox = ({ error }: { error: string | null }) => (error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p> : null)

/** Records a payment against one invoice. More than the balance stays on the customer's account as an advance. */
export function InvoicePaymentDialog({ inv, settings, onClose, onDone }: { inv: SalesInvoiceListRow; settings: BillingSettings | null; onClose: () => void; onDone: (m: string, warnings: string[]) => void }) {
  const [today] = useState(() => toIsoDate(new Date()))
  const methods = settings?.payment_methods?.length ? settings.payment_methods : (['BANK_TRANSFER', 'UPI', 'CASH', 'CHEQUE', 'OTHER'] as PaymentMethod[])
  const accounts = settings?.bank_accounts ?? []
  const [f, setF] = useState({
    receipt_date: today, amount: String(Number(inv.balance_due ?? 0)), payment_method: (methods.includes(settings?.default_payment_method as PaymentMethod) ? settings!.default_payment_method : methods[0]) as PaymentMethod,
    transaction_reference: '', bank: accounts.length ? '0' : '', notes: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicate, setDuplicate] = useState(false)
  const { key, renew } = useRequestKey()
  const amount = Number(f.amount)
  const balance = Number(inv.balance_due ?? 0)

  const submit = async () => {
    setError(null)
    if (!isAmount(f.amount) || amount <= 0) return setError('Enter the amount received (greater than zero, at most 2 decimals).')
    if (f.receipt_date > today) return setError('The payment date cannot be in the future.')
    setBusy(true)
    try {
      const acc = f.bank ? accounts[Number(f.bank)] : null
      const r = await recordInvoicePayment(inv.id, {
        receipt_date: f.receipt_date, amount: f.amount.trim(), payment_method: f.payment_method, transaction_reference: f.transaction_reference.trim() || null,
        bank_reference: acc ? `${acc.label || acc.bank_name || 'Bank'} ${acc.account_number}`.slice(0, 200) : null, notes: f.notes.trim() || null, confirm_duplicate: duplicate,
      }, key)
      renew()
      onDone(`Receipt ${r.receipt_number}: ${money(r.allocated)} applied to ${inv.invoice_number}. Balance due ${money(r.balance_due)}.`, r.warnings ?? [])
    } catch (e) {
      const msg = describeDataError(e)
      if (/already records/i.test(msg)) setDuplicate(true)
      setError(msg)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment — {inv.invoice_number}</DialogTitle>
          <DialogDescription>Balance due {money(balance)}. Several partial payments are fine; anything above the balance is kept as an advance for this customer.</DialogDescription>
        </DialogHeader>
        <ErrorBox error={error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="pay-date">Payment date</Label><Input id="pay-date" type="date" max={today} value={f.receipt_date} onChange={(e) => setF({ ...f, receipt_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pay-amount">Amount (₹)</Label><Input id="pay-amount" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="pay-mode">Payment mode</Label>
            <Select value={f.payment_method} onValueChange={(v) => { if (v) setF({ ...f, payment_method: v as PaymentMethod }) }}>
              <SelectTrigger id="pay-mode"><SelectValue /></SelectTrigger>
              <SelectContent>{methods.map((m) => <SelectItem key={m} value={m}>{paymentModeLabel(m)}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="pay-ref">Reference (UTR / cheque no.)</Label><Input id="pay-ref" maxLength={100} value={f.transaction_reference} onChange={(e) => { setF({ ...f, transaction_reference: e.target.value }); setDuplicate(false) }} /></div>
          {accounts.length > 0 && (
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="pay-bank">Received in</Label>
              <Select value={f.bank || 'none'} onValueChange={(v) => { if (v) setF({ ...f, bank: v === 'none' ? '' : v }) }}>
                <SelectTrigger id="pay-bank"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Not specified</SelectItem>{accounts.map((a, i) => <SelectItem key={a.account_number} value={String(i)}>{a.label || a.bank_name || 'Bank'} · {a.account_number}</SelectItem>)}</SelectContent>
              </Select></div>
          )}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="pay-notes">Notes</Label><Textarea id="pay-notes" rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        {amount > balance && balance > 0 && <p className="text-sm text-amber-800">{money(amount - balance)} is more than the balance and will stay on the customer's account as an advance.</p>}
        {duplicate && <p className="text-sm text-amber-800">If this really is a second payment, press the button again to record it as a separate payment.</p>}
        <p className="text-xs text-muted-foreground">Attach the payment proof under Attachments on the invoice page. Receipts are as recorded by you; they are not bank-verified.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {duplicate ? 'Record as a separate payment' : 'Record payment'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Applies an earlier receipt's unallocated money (advance) to this invoice. */
export function ApplyAdvanceDialog({ inv, onClose, onDone }: { inv: SalesInvoiceListRow; onClose: () => void; onDone: (m: string) => void }) {
  const advances = useAsync(() => fetchAdvances(inv.customer_id), [inv.customer_id])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const apply = async (paymentId: string) => {
    setBusy(paymentId); setError(null)
    try {
      const r = await applyAdvance(inv.id, paymentId, null, crypto.randomUUID())
      onDone(`${money(r.applied)} from ${r.receipt_number} applied. Balance due ${money(r.balance_due)}.`)
    } catch (e) { setError(describeDataError(e)); setBusy(null) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Apply an advance — {inv.invoice_number}</DialogTitle>
          <DialogDescription>Money already received from {inv.customer_legal_name} that is not yet set against an invoice. Balance due {money(inv.balance_due)}.</DialogDescription></DialogHeader>
        <ErrorBox error={error} />
        {advances.loading ? <p className="text-sm text-muted-foreground"><Loader2 className="inline size-4 animate-spin" /> Loading…</p>
          : (advances.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">This customer has no advance or unallocated receipt.</p>
            : <ul className="divide-y text-sm">{(advances.data ?? []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 py-2"><span className="font-medium">{a.receipt_number}</span><span>{formatDate(a.receipt_date)}</span>
                <span className="text-muted-foreground">{money(a.unallocated_amount)} available</span>
                <Button size="sm" className="ml-auto" disabled={busy !== null} onClick={() => void apply(a.id)}>{busy === a.id && <Loader2 className="animate-spin" />} Apply {money(Math.min(Number(a.unallocated_amount), Number(inv.balance_due ?? 0)))}</Button></li>
            ))}</ul>}
        <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy !== null}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const CREDIT_REASONS: NoteReason[] = ['SALES_RETURN', 'QUALITY_ISSUE', 'PRICE_CORRECTION', 'SHORT_SUPPLY', 'COMMERCIAL_ADJUSTMENT', 'OTHER']
const DEBIT_REASONS: NoteReason[] = ['PRICE_CORRECTION', 'ADDITIONAL_CHARGE', 'COMMERCIAL_ADJUSTMENT', 'OTHER']

/** Credit or debit note in one step. The original invoice is never changed; the note adjusts its balance. */
export function NoteDialog({ inv, lines, type, onClose, onDone }: { inv: SalesInvoiceListRow; lines: SalesInvoiceLineRow[]; type: 'CREDIT' | 'DEBIT'; onClose: () => void; onDone: (m: string, noteId: string) => void }) {
  const [today] = useState(() => toIsoDate(new Date()))
  const [reason, setReason] = useState<NoteReason>(type === 'CREDIT' ? 'SALES_RETURN' : 'PRICE_CORRECTION')
  const [text, setText] = useState('')
  const [ref, setRef] = useState('')
  const [date, setDate] = useState(today)
  const [vals, setVals] = useState<Record<string, { quantity: string; amount: string }>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const byQty = type === 'CREDIT' && ['SALES_RETURN', 'QUALITY_ISSUE', 'SHORT_SUPPLY'].includes(reason)

  const submit = async () => {
    setError(null)
    if (text.trim().length < 3) return setError('Describe the reason (at least 3 characters).')
    const out: { invoice_line_id: string; quantity?: string; taxable_amount?: string }[] = []
    for (const l of lines) {
      const v = vals[l.id]
      if (!v) continue
      if (byQty && v.quantity.trim()) {
        if (!/^\d+(\.\d{1,3})?$/.test(v.quantity.trim()) || Number(v.quantity) <= 0 || Number(v.quantity) > Number(l.quantity)) return setError(`Line ${l.line_no}: the quantity must be between 0 and ${Number(l.quantity)}.`)
        out.push({ invoice_line_id: l.id, quantity: v.quantity.trim() })
      } else if (!byQty && v.amount.trim()) {
        if (!isAmount(v.amount) || Number(v.amount) <= 0) return setError(`Line ${l.line_no}: enter a taxable amount greater than zero (2 decimals).`)
        out.push({ invoice_line_id: l.id, taxable_amount: v.amount.trim() })
      }
    }
    if (!out.length) return setError(byQty ? 'Enter the quantity for at least one line.' : 'Enter the taxable amount for at least one line.')
    setBusy(true)
    try {
      const r = await issueNoteV2(inv.id, type, { note_date: date, reason_code: reason, reason: text.trim(), supporting_reference: ref.trim() || null }, out, key)
      renew()
      onDone(`${type === 'CREDIT' ? 'Credit' : 'Debit'} note ${r.note_number} issued (${money(r.total)}). ${inv.invoice_number} balance due: ${money(r.balance_due)}.`, r.note_id)
    } catch (e) { setError(describeDataError(e)); setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{type === 'CREDIT' ? 'Credit note' : 'Debit note'} against {inv.invoice_number}</DialogTitle>
          <DialogDescription>{type === 'CREDIT' ? 'Reduces what the customer owes (returns, price reductions).' : 'Adds to what the customer owes (extra charges, price increases).'} The invoice itself is not changed; GST follows the invoice. Issued in one step and numbered automatically.</DialogDescription></DialogHeader>
        <ErrorBox error={error} />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1"><Label htmlFor="note-reason">Reason</Label>
            <Select value={reason} onValueChange={(v) => { if (v) setReason(v as NoteReason) }}>
              <SelectTrigger id="note-reason"><SelectValue /></SelectTrigger>
              <SelectContent>{(type === 'CREDIT' ? CREDIT_REASONS : DEBIT_REASONS).map((r) => <SelectItem key={r} value={r}>{NOTE_REASON_LABELS[r] ?? r}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="note-date">Note date</Label><Input id="note-date" type="date" max={today} min={inv.invoice_date} value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="note-ref">Supporting reference</Label><Input id="note-ref" maxLength={100} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Return no., e-mail…" /></div>
          <div className="space-y-1 sm:col-span-3"><Label htmlFor="note-text">Description *</Label><Input id="note-text" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></div>
        </div>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm"><thead className="text-xs text-muted-foreground"><tr><th className="pb-1 text-left">Line</th><th className="pb-1 text-right">Invoiced</th>
            <th className="pb-1 text-right">Taxable</th><th className="pb-1 text-right">{byQty ? 'Quantity' : 'Taxable amount (₹)'}</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id} className="border-t"><td className="py-1.5">{l.line_no}. {l.sku ?? ''} <span className="text-muted-foreground">{l.description}</span></td>
                <td className="py-1.5 text-right">{formatQty(l.quantity, l.unit ?? undefined)}</td><td className="py-1.5 text-right">{money(l.taxable_value, false)}</td>
                <td className="py-1.5 text-right">{byQty && l.line_type !== 'PRODUCT' ? '—' : (
                  <Input aria-label={`${byQty ? 'Quantity' : 'Amount'} line ${l.line_no}`} className="ml-auto h-8 w-28 text-right" inputMode="decimal"
                    value={(byQty ? vals[l.id]?.quantity : vals[l.id]?.amount) ?? ''}
                    onChange={(e) => setVals((x) => ({ ...x, [l.id]: { quantity: byQty ? e.target.value : x[l.id]?.quantity ?? '', amount: byQty ? x[l.id]?.amount ?? '' : e.target.value } }))} />)}</td></tr>
            ))}</tbody></table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Issue {type === 'CREDIT' ? 'credit' : 'debit'} note</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
