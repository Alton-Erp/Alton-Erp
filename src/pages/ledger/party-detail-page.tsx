import { ArrowLeft, HandCoins, Link2, Loader2, Pencil, Power, PowerOff, Undo2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PARTY_TYPE_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, SUPPLIER_CATEGORY_LABELS, balanceLabel, type PartyRow, type PaymentMethod } from '@/features/ledger/ledger-model'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDate, toIsoDate } from '@/lib/format'
import {
  fetchParty, fetchPartyTransactions, findDuplicateParties, linkParties, recordSupplierPayment, reverseSupplierPayment, setPartyStatus,
  type DuplicateParty, type PartyEntry,
} from '@/services/ledger'

const KIND_LABELS: Record<string, string> = {
  OPENING: 'Opening balance', CUSTOMER_PO: 'Customer PO', SALES_ORDER: 'Sales order', INVOICE: 'Invoice', INVOICE_CANCELLED: 'Invoice cancelled',
  CREDIT_NOTE: 'Credit note', DEBIT_NOTE: 'Debit note', NOTE_CANCELLED: 'Note cancelled', RECEIPT: 'Receipt', RECEIPT_REVERSED: 'Receipt reversed',
  PURCHASE_ORDER: 'Purchase order', GOODS_RECEIPT: 'Goods received', GOODS_RECEIPT_REVERSED: 'Goods receipt reversed',
  SUPPLIER_PAYMENT: 'Payment made', SUPPLIER_PAYMENT_REVERSED: 'Payment reversed',
}

/** Where a history entry's document opens. */
function documentLink(e: PartyEntry): string | null {
  switch (e.kind) {
    case 'INVOICE': case 'INVOICE_CANCELLED': return `/billing/invoices/${e.ref_id}`
    case 'CREDIT_NOTE': case 'DEBIT_NOTE': case 'NOTE_CANCELLED': return `/billing/notes/${e.ref_id}`
    case 'PURCHASE_ORDER': return `/purchase-orders/${e.ref_id}`
    // Customer POs from the previous ERP are listed for history but have no page in V2.
    default: return null
  }
}

const signed = (v: number) => (Math.abs(v) < 0.005 ? '' : `${v > 0 ? '+' : '−'}${formatCurrency(Math.abs(v))}`)

async function load(id: string) {
  const [party, history] = await Promise.all([fetchParty(id), fetchPartyTransactions(id)])
  return { party, history }
}

/** /ledger/:partyId */
export default function PartyDetailPage() {
  const { partyId = '' } = useParams()
  const location = useLocation()
  const { has, hasAny } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const data = useAsync(() => load(partyId), [partyId, refresh])
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(
    (location.state as { message?: string } | null)?.message ? { tone: 'success', text: (location.state as { message: string }).message } : null)
  const [confirmStatus, setConfirmStatus] = useState(false)
  const [paying, setPaying] = useState(false)
  const [reversing, setReversing] = useState<PartyEntry | null>(null)
  const [linking, setLinking] = useState<DuplicateParty | null>(null)
  const p = data.data?.party
  const dups = useAsync(() => (p ? findDuplicateParties({ name: p.party_name, gstin: p.gstin, pan: p.pan, phone: p.phone, email: p.email, excludePartyId: p.party_id }) : Promise.resolve([])), [p])
  const crumbs = [{ label: 'Master Data' }, { label: 'Ledger (Parties)', to: '/ledger' }, { label: p?.party_code ?? 'Party' }]

  if (data.loading && !data.data) return <LoadingState label="Loading party…" />
  if (data.error || !data.data || !p) return (<><PageHeader title="Party" breadcrumbs={crumbs} /><Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card></>)
  const { history } = data.data
  const done = (text: string) => { setNotice({ tone: 'success', text }); setRefresh((n) => n + 1) }
  const fail = (e: unknown) => setNotice({ tone: 'error', text: describeDataError(e) })
  const canEdit = (p.party_type !== 'SUPPLIER' ? has('customers.manage') : true) && (p.party_type !== 'CUSTOMER' ? has('suppliers.manage') : true)
  const isSupplier = p.party_type !== 'CUSTOMER'
  const linkable = (dups.data ?? []).filter((d) => (p.party_type === 'CUSTOMER' && d.party_type === 'SUPPLIER') || (p.party_type === 'SUPPLIER' && d.party_type === 'CUSTOMER'))
  const net = Number(p.net_balance)

  const columns: DataTableColumn<PartyEntry>[] = [
    { id: 'date', header: 'Date', cell: (e) => (e.date ? formatDate(e.date) : '—'), sortValue: (e) => e.date ?? '' },
    { id: 'kind', header: 'Type', cell: (e) => KIND_LABELS[e.kind] ?? e.kind, searchValue: (e) => KIND_LABELS[e.kind] ?? e.kind },
    { id: 'doc', header: 'Document', cell: (e) => { const to = documentLink(e); return to ? <Link className="font-medium text-primary hover:underline" to={to}>{e.document}</Link> : <span className="font-medium">{e.document}</span> }, searchValue: (e) => e.document },
    { id: 'desc', header: 'Details', cell: (e) => <span className="text-xs">{e.description}{e.status && !['ISSUED', 'RECORDED', 'POSTED'].includes(e.status) && <span className="text-muted-foreground"> · {e.status.replace(/_/g, ' ').toLowerCase()}</span>}</span>, searchValue: (e) => e.description },
    { id: 'amount', header: 'Amount', align: 'right', cell: (e) => (e.amount === null ? '' : formatCurrency(Number(e.amount))) },
    ...(history.customer_visible ? [
      { id: 'rcv', header: 'Receivable', align: 'right', cell: (e: PartyEntry) => <span className="tabular-nums">{signed(Number(e.receivable))}</span> },
      { id: 'rbal', header: 'Receivable balance', align: 'right', cell: (e: PartyEntry) => formatCurrency(Number(e.receivable_balance)) },
    ] as DataTableColumn<PartyEntry>[] : []),
    ...(history.supplier_visible ? [
      { id: 'pay', header: 'Payable', align: 'right', cell: (e: PartyEntry) => <span className="tabular-nums">{signed(Number(e.payable))}</span> },
      { id: 'pbal', header: 'Payable balance', align: 'right', cell: (e: PartyEntry) => formatCurrency(Number(e.payable_balance)) },
    ] as DataTableColumn<PartyEntry>[] : []),
    { id: 'act', header: '', cell: (e) => e.kind === 'SUPPLIER_PAYMENT' && e.status === 'RECORDED' && has('supplier_payment.manage')
      ? <Button size="sm" variant="ghost" onClick={() => setReversing(e)}><Undo2 /> Reverse</Button> : null },
  ]

  return (
    <>
      <PageHeader
        title={p.party_name}
        description={[p.party_code, p.customer_code && `Customer ${p.customer_code}`, p.supplier_code && `Supplier ${p.supplier_code}`, p.gstin && `GSTIN ${p.gstin}`].filter(Boolean).join(' · ')}
        breadcrumbs={crumbs}
        actions={
          <>
            <Button variant="outline" asChild><Link to="/ledger"><ArrowLeft /> All parties</Link></Button>
            {isSupplier && p.supplier_id && has('supplier_payment.manage') && <Button variant="outline" onClick={() => setPaying(true)}><HandCoins /> Record payment</Button>}
            {canEdit && <Button variant="outline" onClick={() => setConfirmStatus(true)}>{p.status === 'ACTIVE' ? <><PowerOff /> Deactivate</> : <><Power /> Activate</>}</Button>}
            {canEdit && <Button asChild><Link to={`/ledger/${p.party_id}/edit`}><Pencil /> Edit</Link></Button>}
          </>
        }
      />
      {notice && (
        <p role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>{notice.text}</p>
      )}
      {linkable.length > 0 && hasAny(['customers.manage']) && has('suppliers.manage') && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <p className="font-medium">This may be the same business as:</p>
          <ul className="mt-1 space-y-1">
            {linkable.map((d) => (
              <li key={d.party_id} className="flex flex-wrap items-center gap-2">
                <Link className="underline-offset-2 hover:underline" to={`/ledger/${d.party_id}`}>{d.party_code} — {d.party_name}</Link>
                <span className="text-xs">({PARTY_TYPE_LABELS[d.party_type as keyof typeof PARTY_TYPE_LABELS]}, same {d.matched_on.join(', ')})</span>
                <Button size="sm" variant="outline" onClick={() => setLinking(d)}><Link2 /> Link as one party</Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Type"><StatusBadge label={PARTY_TYPE_LABELS[p.party_type]} tone={p.party_type === 'BOTH' ? 'info' : 'neutral'} /> <StatusBadge label={p.status === 'ACTIVE' ? 'Active' : 'Inactive'} tone={p.status === 'ACTIVE' ? 'success' : 'neutral'} /></Stat>
        {p.party_type !== 'SUPPLIER' && <Stat label="Receivable (they owe us)"><span className="text-lg font-semibold">{formatCurrency(Number(p.receivable))}</span>{Number(p.overdue) > 0 && <span className="block text-xs text-shortage">{formatCurrency(Number(p.overdue))} overdue</span>}</Stat>}
        {p.party_type !== 'CUSTOMER' && <Stat label="Payable (we owe them)"><span className="text-lg font-semibold">{formatCurrency(Number(p.payable))}</span><span className="block text-xs text-muted-foreground">Goods received less payments</span></Stat>}
        {p.party_type === 'BOTH' && <Stat label="Net balance"><span className="text-lg font-semibold">{formatCurrency(Math.abs(net))}</span><span className="block text-xs text-muted-foreground">{balanceLabel(net)}</span></Stat>}
      </div>

      <div className="mb-6 grid gap-6 xl:grid-cols-3">
        <Info title="Contact">
          <Item label="Contact person">{p.contact_person}</Item>
          <Item label="Mobile">{p.phone}</Item>
          <Item label="E-mail">{p.email}</Item>
          <Item label="City / State">{[p.city, p.state_name && `${p.state_name} (${p.state_code})`, p.pin_code].filter(Boolean).join(', ')}</Item>
          <Item label="Country">{p.country}</Item>
        </Info>
        <Info title="Addresses and tax">
          <Item label="Billing address">{p.billing_address && <span className="whitespace-pre-line">{p.billing_address}</span>}</Item>
          <Item label="Shipping address">{p.shipping_address ? <span className="whitespace-pre-line">{p.shipping_address}</span> : p.billing_address ? 'Same as billing' : null}</Item>
          <Item label="GSTIN / PAN">{[p.gstin, p.pan].filter(Boolean).join(' / ')}</Item>
          {p.gst_registration_type && <Item label="GST registration">{p.gst_registration_type.toLowerCase()}</Item>}
          {p.legal_name && p.legal_name !== p.party_name && <Item label="Legal name">{p.legal_name}</Item>}
        </Info>
        <Info title="Terms and bank">
          <Item label="Credit period">{p.credit_period_days === null ? null : `${p.credit_period_days} days`}</Item>
          <Item label="Payment terms">{p.payment_terms_note}</Item>
          {p.supplier_category && <Item label="Supplier category">{SUPPLIER_CATEGORY_LABELS[p.supplier_category as keyof typeof SUPPLIER_CATEGORY_LABELS] ?? p.supplier_category}</Item>}
          <Item label="Opening balance">{Number(p.opening_balance) > 0 ? `${formatCurrency(Number(p.opening_balance))} ${p.opening_balance_type === 'RECEIVABLE' ? 'receivable' : 'payable'}${p.opening_balance_date ? ` on ${formatDate(p.opening_balance_date)}` : ''}` : null}</Item>
          <Item label="Bank">{[p.bank_name, p.bank_account_name, p.bank_account_number, p.bank_ifsc].filter(Boolean).join(' · ')}</Item>
          <Item label="Remarks">{p.remarks && <span className="whitespace-pre-line">{p.remarks}</span>}</Item>
        </Info>
      </div>

      <DataTable
        title="Transaction history"
        description="Orders, invoices, receipts, goods receipts and payments, newest first. Running balances include the opening balance."
        columns={columns}
        data={history.entries}
        getRowId={(e) => `${e.kind}-${e.ref_id}`}
        searchPlaceholder="Search document or details…"
        pageSize={25}
        emptyState={{ icon: HandCoins, title: 'No transactions yet', description: 'Orders, invoices, receipts and payments of this party will appear here.' }}
      />

      <ConfirmDialog
        open={confirmStatus}
        onOpenChange={setConfirmStatus}
        title={p.status === 'ACTIVE' ? `Deactivate ${p.party_name}?` : `Activate ${p.party_name}?`}
        description={p.status === 'ACTIVE' ? 'The party can no longer be chosen on new orders. Its history and balances are kept, and it can be activated again.' : 'The party can be chosen on new orders again.'}
        confirmLabel={p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        destructive={p.status === 'ACTIVE'}
        onConfirm={async () => {
          try { await setPartyStatus(p.party_id, p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'); done(`${p.party_code} ${p.status === 'ACTIVE' ? 'deactivated' : 'activated'}.`) } catch (e) { fail(e) }
        }}
      />
      <ConfirmDialog
        open={linking !== null}
        onOpenChange={(o) => !o && setLinking(null)}
        title="Link as one party?"
        description={linking ? `${p.party_name} (${PARTY_TYPE_LABELS[p.party_type]}) and ${linking.party_name} (${PARTY_TYPE_LABELS[linking.party_type as keyof typeof PARTY_TYPE_LABELS]}) become one party that is both customer and supplier. Their customer and supplier records, orders, invoices and payments are not changed.` : ''}
        confirmLabel="Link"
        onConfirm={async () => {
          if (!linking) return
          try { const r = await linkParties(p.party_id, linking.party_id); setLinking(null); done(`Linked. ${r.removed_party_code} is now part of ${r.party_code}.`) } catch (e) { setLinking(null); fail(e) }
        }}
      />
      {paying && p.supplier_id && <PaymentDialog party={p} onClose={() => setPaying(false)} onDone={(m) => { setPaying(false); done(m) }} />}
      {reversing && <ReverseDialog entry={reversing} onClose={() => setReversing(null)} onDone={(m) => { setReversing(null); done(m) }} />}
    </>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return <Card><CardContent className="space-y-1 p-4"><p className="text-xs text-muted-foreground">{label}</p><div>{children}</div></CardContent></Card>
}

function Info({ title, children }: { title: string; children: ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><dl className="space-y-2.5">{children}</dl></CardContent></Card>
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  const empty = children === null || children === undefined || children === '' || children === false
  return <div><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-sm">{empty ? <span className="text-muted-foreground">—</span> : children}</dd></div>
}

function PaymentDialog({ party, onClose, onDone }: { party: PartyRow; onClose: () => void; onDone: (m: string) => void }) {
  const { key, renew } = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const [date, setDate] = useState(today)
  const [amount, setAmount] = useState(Number(party.payable) > 0 ? String(Number(party.payable)) : '')
  const [method, setMethod] = useState<PaymentMethod>('BANK_TRANSFER')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const a = amount.trim().replace(/,/g, '')
    if (!/^\d+(\.\d{1,2})?$/.test(a) || Number(a) <= 0) return setError('Enter an amount greater than zero, with up to 2 decimals.')
    setBusy(true)
    setError(null)
    try {
      const r = await recordSupplierPayment({ supplierId: party.supplier_id!, date, amount: Number(a), method, reference: reference.trim() || null, notes: notes.trim() || null }, key)
      renew()
      onDone(`${r.payment_number} recorded. Payable now ${formatCurrency(Number(r.payable_after))}${r.overpaid ? ' (paid in advance)' : ''}.`)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment to {party.party_name}</DialogTitle>
          <DialogDescription>Currently payable: {formatCurrency(Number(party.payable))}. A payment can be reversed later if it was recorded by mistake.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="sp-date">Payment date</Label><Input id="sp-date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="sp-amount">Amount (₹)</Label><Input id="sp-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="sp-method">Method</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as PaymentMethod)}>
              <SelectTrigger id="sp-method"><SelectValue /></SelectTrigger>
              <SelectContent>{PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1.5"><Label htmlFor="sp-ref">Reference (UTR / cheque no.)</Label><Input id="sp-ref" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="sp-notes">Notes</Label><Textarea id="sp-notes" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Record payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReverseDialog({ entry, onClose, onDone }: { entry: PartyEntry; onClose: () => void; onDone: (m: string) => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse {entry.document}?</DialogTitle>
          <DialogDescription>The payment of {formatCurrency(Number(entry.amount))} is kept in the history and marked reversed; the payable goes back up.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-1.5"><Label htmlFor="rv-reason">Reason</Label><Textarea id="rv-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" disabled={busy || reason.trim().length < 5} onClick={async () => {
            setBusy(true)
            try { await reverseSupplierPayment(entry.ref_id, reason.trim()); onDone(`${entry.document} reversed.`) } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Reverse payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
