import { Plus, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ReceiptStatusBadge } from '@/features/billing/billing-badges'
import { BillingExport } from '@/features/billing/billing-export'
import { PAYMENT_METHOD_LABELS, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { AllocatePaymentDialog, RecordPaymentDialog } from '@/features/billing/payment-dialogs'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchAllocations, fetchPayments, reverseAllocation, reversePayment } from '@/services/billing'
import type { CustomerPaymentListRow } from '@/types/database-billing'

function ReceiptDetail({ p, onAction, onAllocate }: { p: CustomerPaymentListRow; onAction: (a: ActionRequest) => void; onAllocate: () => void }) {
  const { has } = usePermissions()
  const allocations = useAsync(() => fetchAllocations({ paymentId: p.id }), [p.id, p.allocated_amount, p.status])
  const active = (allocations.data ?? []).filter((a) => a.status === 'ACTIVE')
  return (
    <Card>
      <CardHeader><div><CardTitle>{p.receipt_number}</CardTitle><CardDescription>{p.customer_name} ({p.customer_code}) · recorded {formatDateTime(p.created_at)} · not bank-verified</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 text-sm sm:grid-cols-3 xl:grid-cols-6">
          <div><dt className="text-xs text-muted-foreground">Receipt date</dt><dd>{formatDate(p.receipt_date)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Amount</dt><dd className="font-medium">{money(p.amount_received)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Method</dt><dd>{PAYMENT_METHOD_LABELS[p.payment_method]}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Reference</dt><dd>{p.transaction_reference ?? '—'}{p.bank_reference ? ` / ${p.bank_reference}` : ''}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Allocated / unallocated</dt><dd>{money(p.allocated_amount)} / {money(p.unallocated_amount)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Status</dt><dd><ReceiptStatusBadge status={p.status} /></dd></div>
        </dl>
        {p.notes && <p className="text-sm">{p.notes}</p>}
        {p.status === 'REVERSED' && <p className="text-sm text-muted-foreground">Reversed {p.reversed_at ? formatDateTime(p.reversed_at) : ''}: {p.reversal_reason}</p>}
        <div>
          <p className="mb-1 text-sm font-medium">Allocations</p>
          {allocations.loading ? <p className="text-sm text-muted-foreground">Loading…</p> : allocations.error ? <p className="text-sm text-red-800">{describeDataError(allocations.error)}</p>
            : !(allocations.data ?? []).length ? <p className="text-sm text-muted-foreground">Not allocated to any invoice.</p> : (
              <ul className="divide-y text-sm">{(allocations.data ?? []).map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 py-1.5">
                  <Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${a.invoice_id}`}>{a.invoice_number}</Link><span>{money(a.allocated_amount)}</span><span className="text-muted-foreground">{formatDate(a.allocation_date)}</span>
                  {a.status === 'REVERSED' ? <span className="text-xs text-muted-foreground">Reversed: {a.reversal_reason}</span>
                    : has('payments.reverse') && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onAction({ title: `Reverse allocation to ${a.invoice_number}`, description: `${money(a.allocated_amount)} returns to ${p.receipt_number} as unallocated and the invoice balance increases. The allocation stays in history.`, confirmLabel: 'Reverse allocation', note: 'required', minLength: 5, destructive: true, run: async (n) => { await reverseAllocation(a.id, n!); return 'Allocation reversed.' } })}>Reverse</Button>}
                </li>
              ))}</ul>)}
        </div>
        {p.status === 'RECORDED' && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {has('payments.manage') && Number(p.unallocated_amount) > 0 && <Button variant="outline" onClick={onAllocate}>Allocate to invoices</Button>}
            {has('payments.reverse') && <Button variant="outline" className="text-shortage" onClick={() => onAction({
              title: `Reverse receipt ${p.receipt_number}`,
              description: `Use this when the receipt was entered in error or the payment bounced. ${active.length ? `${active.length} active allocation(s) are reversed too and those invoice balances increase. ` : ''}The receipt and its number stay in history.`,
              confirmLabel: 'Reverse receipt', note: 'required', minLength: 5, destructive: true,
              run: async (n, key) => { const r = await reversePayment(p.id, n!, key); return `Receipt ${p.receipt_number} reversed (${r.allocations_reversed} allocation(s) reversed).` },
            })}>Reverse receipt</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default function PaymentsPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const [recording, setRecording] = useState(Boolean(params.get('customer') || params.get('record')) && has('payments.manage'))
  const [customer, setCustomer] = useState('all')
  const [status, setStatus] = useState('all')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [allocating, setAllocating] = useState<CustomerPaymentListRow | null>(null)
  const selectedId = params.get('receipt')
  const list = useAsync(() => fetchPayments({ customerId: customer === 'all' ? null : customer, status: status === 'all' ? null : (status as 'RECORDED' | 'REVERSED'), from: from || null, to: to || null }),
    [customer, status, from, to, refresh])
  const selected = (list.data ?? []).find((p) => p.id === selectedId) ?? null
  const done = (m: string) => { setAction(null); setAllocating(null); setRecording(false); setMessage(m); setRefresh((n) => n + 1) }
  const select = (id: string | null) => setParams((p) => { const n = new URLSearchParams(p); n.delete('customer'); n.delete('invoice'); if (id) n.set('receipt', id); else n.delete('receipt'); return n }, { replace: true })

  const columns: DataTableColumn<CustomerPaymentListRow>[] = [
    { id: 'receipt', header: 'Receipt', searchValue: (p) => `${p.receipt_number} ${p.transaction_reference ?? ''} ${p.bank_reference ?? ''}`, sortValue: (p) => p.receipt_date, cell: (p) => <button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => select(p.id)}>{p.receipt_number}<span className="block text-xs font-normal text-muted-foreground">{formatDate(p.receipt_date)}</span></button> },
    { id: 'customer', header: 'Customer', searchValue: (p) => `${p.customer_name} ${p.customer_code}`, cell: (p) => <span>{p.customer_name}<span className="block text-xs text-muted-foreground">{p.customer_code}</span></span> },
    { id: 'method', header: 'Method / reference', cell: (p) => <span className="text-xs">{PAYMENT_METHOD_LABELS[p.payment_method]}<span className="block text-muted-foreground">{p.transaction_reference ?? ''}</span></span> },
    { id: 'amount', header: 'Amount', align: 'right', cell: (p) => <span className="font-medium">{money(p.amount_received)}</span> },
    { id: 'allocated', header: 'Allocated', align: 'right', cell: (p) => money(p.allocated_amount, false) },
    { id: 'unallocated', header: 'Unallocated', align: 'right', cell: (p) => (Number(p.unallocated_amount) > 0 && p.status === 'RECORDED' ? <span className="text-amber-700">{money(p.unallocated_amount, false)}</span> : money(p.unallocated_amount, false)) },
    { id: 'status', header: 'Status', cell: (p) => <ReceiptStatusBadge status={p.status} /> },
  ]

  return (
    <>
      <PageHeader actions={<>
        <BillingExport title="Customer receipts" fileStem="customer-receipts" rows={list.data ?? []} columns={[
          { header: 'Receipt no.', value: (p) => p.receipt_number }, { header: 'Receipt date', value: (p) => p.receipt_date }, { header: 'Customer', value: (p) => p.customer_name },
          { header: 'Method', value: (p) => PAYMENT_METHOD_LABELS[p.payment_method] }, { header: 'Transaction ref', value: (p) => p.transaction_reference }, { header: 'Bank ref', value: (p) => p.bank_reference },
          { header: 'Amount', value: (p) => Number(p.amount_received) }, { header: 'Allocated', value: (p) => Number(p.allocated_amount) }, { header: 'Unallocated', value: (p) => Number(p.unallocated_amount) },
          { header: 'Status', value: (p) => p.status }, { header: 'Verification', value: (p) => p.verification_status },
        ]} />
        {has('payments.manage') && <Button onClick={() => setRecording(true)}><Plus /> Record payment</Button>}
      </>} />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <p className="mb-4 text-sm text-muted-foreground">Receipts are entered by users and are not bank-verified or reconciled. No payment gateway or bank feed is connected.</p>
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="pm-cust">Customer</Label><CustomerSelect id="pm-cust" value={customer} onChange={setCustomer} allowAll /></div>
          <div className="space-y-1"><Label htmlFor="pm-status">Status</Label>
            <Select value={status} onValueChange={setStatus}><SelectTrigger id="pm-status" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="RECORDED">Recorded</SelectItem><SelectItem value="REVERSED">Reversed</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="pm-from">From</Label><Input id="pm-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="pm-to">To</Label><Input id="pm-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        </CardContent>
      </Card>
      {selected && <div className="mb-4"><ReceiptDetail key={selected.id} p={selected} onAction={setAction} onAllocate={() => setAllocating(selected)} />
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => select(null)}>Close receipt</Button></div>}
      <DataTable columns={columns} data={list.data ?? []} getRowId={(p) => p.id} loading={list.loading} searchPlaceholder="Search receipts…" pageSize={25}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: Wallet, title: 'No receipts', description: 'Recorded customer payments appear here.' }} />
      {recording && <RecordPaymentDialog initialCustomer={params.get('customer')} initialInvoice={params.get('invoice')} onClose={() => { setRecording(false); select(selectedId) }} onDone={done} />}
      {allocating && <AllocatePaymentDialog payment={allocating} onClose={() => setAllocating(null)} onDone={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
