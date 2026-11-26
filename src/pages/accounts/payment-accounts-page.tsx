import { CreditCard } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatAmount } from '@/features/accounting/accounting-model'
import { PAYMENT_STATE_META, type BankLookups, type PaymentAccountState, type PaymentCandidate } from '@/features/accounting/bank-cash-model'
import { MoneyAccountSelect } from '@/features/accounting/bank-cash-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { assignPaymentAccount, fetchBankLookups, fetchPaymentCandidates } from '@/services/accounting'

/** Controlled mapping of receipts and supplier payments to the bank / cash account they actually went through (before they are posted). */
export default function PaymentAccountsPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const state = params.get('state') ?? 'OPEN'
  const [refresh, setRefresh] = useState(0)
  const [assign, setAssign] = useState<PaymentCandidate | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const lookups = useAsync(() => fetchBankLookups(), [])
  const list = useAsync(() => fetchPaymentCandidates({ state: state === 'ALL' || state === 'OPEN' ? null : state }), [state, refresh])
  const rows = (list.data ?? []).filter((c) => state !== 'OPEN' || ['NEEDS_SELECTION', 'UNMAPPED', 'ASSIGNED'].includes(c.state))
  const canAssign = has('bank_accounts.manage') || has('accounting_posting.manage')
  const columns: DataTableColumn<PaymentCandidate>[] = [
    { id: 'no', header: 'Receipt / payment', searchValue: (c) => `${c.number} ${c.party ?? ''} ${c.reference ?? ''}`, cell: (c) => <span className="text-sm font-medium">{c.number}
      <span className="block text-xs font-normal text-muted-foreground">{c.source_type === 'CUSTOMER_RECEIPT' ? 'Customer receipt' : 'Supplier payment'}</span></span> },
    { id: 'date', header: 'Date', sortValue: (c) => c.date, cell: (c) => formatDate(c.date) },
    { id: 'party', header: 'Party', cell: (c) => <span className="text-sm">{c.party ?? '—'}</span> },
    { id: 'method', header: 'Method / ref', cell: (c) => <span className="text-sm">{c.payment_method.replace(/_/g, ' ').toLowerCase()}{c.reference ? ` · ${c.reference}` : ''}</span> },
    { id: 'amount', header: 'Amount', align: 'right', cell: (c) => <span className="tabular-nums">{formatAmount(c.amount)}</span> },
    { id: 'account', header: 'Bank / cash account', cell: (c) => <span className="text-sm">{c.posted_account_code ?? c.assigned_account_code ?? (c.posted_ledger_code ? `ledger ${c.posted_ledger_code}` : '—')}
      {c.voucher_number && <span className="block text-xs text-muted-foreground">{c.voucher_number}</span>}</span> },
    { id: 'state', header: 'State', cell: (c) => <StatusBadge label={PAYMENT_STATE_META[c.state].label} tone={PAYMENT_STATE_META[c.state].tone} /> },
    { id: 'act', header: '', align: 'right', cell: (c) => (canAssign && ['NEEDS_SELECTION', 'UNMAPPED', 'ASSIGNED', 'BY_METHOD'].includes(c.state)
      ? <Button variant="ghost" size="sm" onClick={() => setAssign(c)}>{c.assigned_account_code ? 'Change account' : 'Assign account'}</Button> : null) },
  ]
  return (
    <>
      <PageHeader title="Payment Accounts" breadcrumbs={[{ label: 'Accounts' }, { label: 'Payment Accounts' }]}
        description="Which bank or cash account each receipt and supplier payment went through. Assign the verified account before posting; posted payments are never rewritten." />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="pa-state">Show</Label>
          <Select value={state} onValueChange={(v) => setParams({ state: v }, { replace: true })}><SelectTrigger id="pa-state" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="OPEN">Waiting for an account</SelectItem><SelectItem value="ALL">All (latest 1,000)</SelectItem>
              {(Object.keys(PAYMENT_STATE_META) as PaymentAccountState[]).map((s) => <SelectItem key={s} value={s}>{PAYMENT_STATE_META[s].label}</SelectItem>)}</SelectContent></Select></div>
      </CardContent></Card>
      <DataTable columns={columns} data={rows} getRowId={(c) => c.source_id} loading={list.loading} error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: CreditCard, title: 'Nothing waiting', description: 'Receipts and payments that need a bank / cash account appear here.' }} />
      {assign && <AssignDialog c={assign} lookups={lookups.data} onClose={() => setAssign(null)} onDone={(m) => { setAssign(null); setMessage(m); setRefresh((n) => n + 1) }} />}
    </>
  )
}

function AssignDialog({ c, lookups, onClose, onDone }: { c: PaymentCandidate; lookups: BankLookups | undefined; onClose: () => void; onDone: (m: string) => void }) {
  const [account, setAccount] = useState(c.assigned_account_id ?? '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = c.payment_method === 'CASH' ? 'CASH' : c.payment_method === 'OTHER' ? null : 'BANK'
  const save = async () => {
    setBusy(true); setError(null)
    try { await assignPaymentAccount(c.source_type, c.source_id, account, reason.trim()); onDone(`${c.number} assigned. It posts on the next posting run (Posting Monitor).`) }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Bank / cash account of {c.number}</DialogTitle>
          <DialogDescription>{formatAmount(c.amount)} by {c.payment_method.replace(/_/g, ' ').toLowerCase()}{c.reference ? `, ref ${c.reference}` : ''}. Record how you verified the account.</DialogDescription></DialogHeader>
        <div className="space-y-1"><Label htmlFor="pa-account">Account</Label><MoneyAccountSelect id="pa-account" value={account} lookups={lookups} kind={kind} onChange={setAccount} /></div>
        <div className="space-y-1"><Label htmlFor="pa-reason">Verified by (5+ characters)</Label><Textarea id="pa-reason" rows={2} value={reason} placeholder="e.g. HDFC statement 12-Nov, UTR 1234"
          onChange={(e) => setReason(e.target.value)} /></div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !account || reason.trim().length < 5} onClick={() => void save()}>Assign</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
