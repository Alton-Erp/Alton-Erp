import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PAYMENT_METHOD_LABELS, isAmount, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { useAsync } from '@/hooks/use-async'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { allocatePayment, fetchBillingSettings, fetchOpenInvoices, recordPayment } from '@/services/billing'
import type { CustomerPaymentListRow, PaymentMethod } from '@/types/database-billing'

/** Paise (integer) for display-only sums; the server validates every amount again. */
const paise = (v: string | number) => Math.round(Number(v) * 100)

function AllocationRows({ customerId, amounts, setAmounts, preselect }: {
  customerId: string
  amounts: Record<string, string>
  setAmounts: (f: (a: Record<string, string>) => Record<string, string>) => void
  preselect?: string | null
}) {
  const open = useAsync(() => (customerId ? fetchOpenInvoices(customerId) : Promise.resolve([])), [customerId])
  if (!customerId) return null
  if (open.loading) return <p className="text-sm text-muted-foreground">Loading open invoices…</p>
  if (open.error) return <p role="alert" className="text-sm text-red-800">{describeDataError(open.error)}</p>
  if (!open.data?.length) return <p className="text-sm text-muted-foreground">This customer has no open issued invoices. The receipt can be recorded as unallocated (on account).</p>
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted text-xs text-muted-foreground"><tr><th className="px-2 py-1.5 text-left">Invoice</th><th className="px-2 py-1.5 text-left">Due</th><th className="px-2 py-1.5 text-right">Balance</th><th className="px-2 py-1.5 text-right">Allocate</th></tr></thead>
        <tbody>{open.data.map((i) => (
          <tr key={i.id} className={`border-t ${preselect === i.id ? 'bg-primary/5' : ''}`}>
            <td className="px-2 py-1.5">{i.invoice_number}<span className="block text-xs text-muted-foreground">{formatDate(i.invoice_date)}</span></td>
            <td className="px-2 py-1.5">{i.due_date ? formatDate(i.due_date) : '—'}{i.days_overdue ? <span className="block text-xs text-shortage">{i.days_overdue} d overdue</span> : null}</td>
            <td className="px-2 py-1.5 text-right">{money(i.balance_due)}</td>
            <td className="px-2 py-1.5 text-right">
              <div className="flex items-center justify-end gap-1">
                <Button type="button" variant="ghost" size="sm" onClick={() => setAmounts((a) => ({ ...a, [i.id]: Number(i.balance_due).toFixed(2) }))}>Full</Button>
                <Input aria-label={`Allocate to ${i.invoice_number}`} className="h-8 w-28 text-right" inputMode="decimal" placeholder="0.00" value={amounts[i.id] ?? ''}
                  onChange={(e) => setAmounts((a) => ({ ...a, [i.id]: e.target.value }))} />
              </div>
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function collect(amounts: Record<string, string>): { list: { invoice_id: string; amount: string }[]; error: string | null; total: number } {
  const list: { invoice_id: string; amount: string }[] = []
  let total = 0
  for (const [invoice_id, raw] of Object.entries(amounts)) {
    const v = raw.trim()
    if (!v || paise(v) === 0) continue
    if (!isAmount(v)) return { list, total, error: 'Allocation amounts must be positive numbers with at most 2 decimals.' }
    list.push({ invoice_id, amount: v })
    total += paise(v)
  }
  return { list, total, error: null }
}

/** Records a customer receipt (as entered by the user — not bank-verified) with optional allocations. */
export function RecordPaymentDialog({ initialCustomer, initialInvoice, onClose, onDone }: {
  initialCustomer?: string | null
  initialInvoice?: string | null
  onClose: () => void
  onDone: (message: string) => void
}) {
  const settings = useAsync(fetchBillingSettings, [])
  const methods = settings.data?.payment_methods ?? (Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[])
  const [customer, setCustomer] = useState(initialCustomer ?? '')
  const [f, setF] = useState(() => ({ receipt_date: toIsoDate(new Date()), amount: '', payment_method: '' as PaymentMethod | '', transaction_reference: '', bank_reference: '', notes: '' }))
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const { has } = usePermissions()
  // Auto-saved working copy: restored when the dialog is opened again for the same customer / invoice.
  const draft = usePersistentFormDraft({
    formKey: 'billing.payment', scope: initialInvoice ? `invoice:${initialInvoice}` : initialCustomer ? `customer:${initialCustomer}` : '',
    enabled: has('payments.manage'),
    value: { customer, f, amounts },
    onRestore: (d) => { setCustomer(d.customer); setF((x) => ({ ...x, ...d.f })); setAmounts(d.amounts ?? {}) },
  })
  const alloc = collect(amounts)
  const remaining = isAmount(f.amount) ? paise(f.amount) - alloc.total : null

  const submit = async () => {
    setError(null)
    if (!customer) return setError('Select the customer.')
    if (!isAmount(f.amount) || paise(f.amount) <= 0) return setError('Enter the amount received (greater than zero, at most 2 decimals).')
    if (!f.payment_method) return setError('Select the payment method.')
    if (!f.receipt_date) return setError('Enter the receipt date.')
    if (alloc.error) return setError(alloc.error)
    if (remaining !== null && remaining < 0) return setError('Allocations exceed the amount received.')
    setBusy(true)
    try {
      const r = await recordPayment({
        customer_id: customer, receipt_date: f.receipt_date, amount: f.amount.trim(), payment_method: f.payment_method,
        transaction_reference: f.transaction_reference.trim() || null, bank_reference: f.bank_reference.trim() || null, notes: f.notes.trim() || null,
      }, alloc.list, key)
      renew()
      void draft.markSubmitted()
      onDone(`Receipt ${r.receipt_number} recorded${r.allocations ? ` and allocated to ${r.allocations} invoice(s)` : ''}${Number(r.unallocated) > 0 ? `; ${money(r.unallocated)} unallocated` : ''}.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Record customer payment</DialogTitle>
          <DialogDescription>Records money the customer paid, as entered here. It is not a bank or gateway confirmation; the receipt stays "unverified". Stock is not affected.</DialogDescription>
        </DialogHeader>
        <FormDraftBar draft={draft} className="mb-0" />
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="rp-cust">Customer</Label><CustomerSelect id="rp-cust" className="w-full" value={customer} onChange={(v) => { setCustomer(v); setAmounts({}) }} /></div>
          <div className="space-y-1"><Label htmlFor="rp-date">Receipt date</Label><Input id="rp-date" type="date" value={f.receipt_date} onChange={(e) => setF({ ...f, receipt_date: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="rp-amount">Amount received (₹)</Label><Input id="rp-amount" inputMode="decimal" placeholder="0.00" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="rp-method">Payment method</Label>
            <Select value={f.payment_method} onValueChange={(v) => setF({ ...f, payment_method: v as PaymentMethod })}>
              <SelectTrigger id="rp-method"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>{methods.map((m) => <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="rp-ref">Transaction / UTR / cheque no.</Label><Input id="rp-ref" maxLength={100} value={f.transaction_reference} onChange={(e) => setF({ ...f, transaction_reference: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="rp-bank">Bank reference (optional)</Label><Input id="rp-bank" maxLength={100} value={f.bank_reference} onChange={(e) => setF({ ...f, bank_reference: e.target.value })} /></div>
          <div className="space-y-1"><Label htmlFor="rp-notes">Notes (optional)</Label><Textarea id="rp-notes" rows={1} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">Allocate to open invoices (optional)</p>
          <AllocationRows customerId={customer} amounts={amounts} setAmounts={setAmounts} preselect={initialInvoice} />
          {customer && <p className="text-sm text-muted-foreground">Allocated {money(alloc.total / 100)}{remaining !== null ? ` · ${remaining >= 0 ? `unallocated ${money(remaining / 100)}` : `over by ${money(-remaining / 100)}`}` : ''}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Record receipt</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Allocates the unallocated part of an existing receipt to open invoices of the same customer. */
export function AllocatePaymentDialog({ payment, onClose, onDone }: { payment: CustomerPaymentListRow; onClose: () => void; onDone: (message: string) => void }) {
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { key, renew } = useRequestKey()
  const alloc = collect(amounts)
  const remaining = paise(payment.unallocated_amount) - alloc.total

  const submit = async () => {
    setError(null)
    if (alloc.error) return setError(alloc.error)
    if (!alloc.list.length) return setError('Enter at least one allocation amount.')
    if (remaining < 0) return setError('Allocations exceed the unallocated amount of this receipt.')
    setBusy(true)
    try {
      const r = await allocatePayment(payment.id, alloc.list, key)
      renew()
      onDone(`${r.allocations} allocation(s) saved for ${payment.receipt_number}; ${money(r.unallocated)} remains unallocated.`)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Allocate {payment.receipt_number}</DialogTitle>
          <DialogDescription>{payment.customer_name} · received {money(payment.amount_received)} on {formatDate(payment.receipt_date)} · unallocated {money(payment.unallocated_amount)}. An allocation can never exceed an invoice's balance or the receipt's unallocated amount (checked by the server).</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <AllocationRows customerId={payment.customer_id} amounts={amounts} setAmounts={setAmounts} />
        <p className="text-sm text-muted-foreground">Allocating {money(alloc.total / 100)} · {remaining >= 0 ? `remaining ${money(remaining / 100)}` : `over by ${money(-remaining / 100)}`}</p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Save allocations</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
