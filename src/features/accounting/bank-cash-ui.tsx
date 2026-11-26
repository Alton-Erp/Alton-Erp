import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SearchSelect } from '@/features/accounting/accounting-ui'
import { MATCH_STATE_META, type BankLookups, type MatchState, type MoneyKind } from '@/features/accounting/bank-cash-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchPaymentPolicies, savePaymentPolicy } from '@/services/accounting'

export const MatchBadge = ({ state }: { state: MatchState }) => <StatusBadge label={MATCH_STATE_META[state].label} tone={MATCH_STATE_META[state].tone} />

/** Bank / cash account picker from bank_lookups (active accounts only unless includeInactive). */
export function MoneyAccountSelect({ id, value, onChange, lookups, kind = null, includeInactive = false, allowClear = false, placeholder = 'Select an account', className }: {
  id?: string; value: string; onChange: (id: string) => void; lookups: BankLookups | undefined; kind?: MoneyKind | null; includeInactive?: boolean; allowClear?: boolean
  placeholder?: string; className?: string
}) {
  const list = (lookups?.accounts ?? []).filter((a) => (!kind || a.account_kind === kind) && (includeInactive || a.is_active))
  return (
    <SearchSelect id={id} value={value} allowClear={allowClear} placeholder={placeholder} className={className} loading={!lookups} onChange={onChange}
      options={list.map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}`, hint: a.account_kind === 'BANK' ? `${a.bank_name ?? ''} ${a.account_number_masked ?? ''}`.trim()
        : `cash${a.is_active ? '' : ' · inactive'}` }))} />
  )
}

const METHODS = ['BANK_TRANSFER', 'UPI', 'CHEQUE', 'CASH', 'CARD', 'DEMAND_DRAFT', 'OTHER']
const label = (m: string) => m.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())

/**
 * Accounting Settings: per payment method, whether each receipt / payment must be assigned its bank or cash account one by one (when several
 * accounts take that method). Ticked methods never fall back to the method's default ledger.
 */
export function PaymentAccountPolicies() {
  const { has } = usePermissions()
  const [refresh, setRefresh] = useState(0)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = useAsync(() => fetchPaymentPolicies(), [refresh])
  const can = has('accounting_settings.manage')
  const find = (d: 'RECEIPT' | 'PAYMENT', m: string) => (list.data ?? []).find((p) => p.direction === d && p.payment_method === m)
  const toggle = async (d: 'RECEIPT' | 'PAYMENT', m: string, v: boolean) => {
    setSaving(`${d}:${m}`); setError(null)
    try { await savePaymentPolicy(d, m, v); setRefresh((n) => n + 1) } catch (e) { setError(describeDataError(e)) } finally { setSaving(null) }
  }
  if (list.loading) return <LoadingState variant="table" />
  if (list.error) return <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
  const cell = (d: 'RECEIPT' | 'PAYMENT', m: string) => {
    const p = find(d, m)
    return (
      <span className="flex items-center gap-2 text-sm">
        <Checkbox aria-label={`${d === 'RECEIPT' ? 'Receipts' : 'Payments'} by ${label(m)}: choose the account per payment`} disabled={!can || saving !== null}
          checked={!!p?.require_selection} onCheckedChange={(v) => void toggle(d, m, v === true)} />
        {p?.require_selection ? <span>Choose per payment</span> : <span className="text-muted-foreground">{p?.mapped_account_code ? `Default: ${p.mapped_account_code}`
          : p?.rule_account_code ? `Default ledger ${p.rule_account_code}` : 'Not mapped'}</span>}
        {saving === `${d}:${m}` && <Loader2 className="size-4 animate-spin" />}
      </span>
    )
  }
  return (
    <Card data-testid="payment-account-policies">
      <CardHeader><div><CardTitle>Bank / cash account per payment</CardTitle>
        <CardDescription>Tick a method when more than one bank or cash account receives or pays by it: each receipt / payment then waits until its account is
          chosen in Accounts › Payment accounts (verified, with a reason). The first bank account is never assumed. Posted payments are never rewritten.</CardDescription></div></CardHeader>
      <CardContent className="p-0">
        {error && <p role="alert" className="mx-4 mb-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
        <Table>
          <TableHeader><TableRow><TableHead>Payment method</TableHead><TableHead>Customer receipts</TableHead><TableHead>Supplier payments</TableHead></TableRow></TableHeader>
          <TableBody>{METHODS.map((m) => (
            <TableRow key={m}><TableCell className="font-medium">{label(m)}</TableCell><TableCell>{cell('RECEIPT', m)}</TableCell><TableCell>{cell('PAYMENT', m)}</TableCell></TableRow>))}</TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
