import { BookOpen } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAmount, formatBalance, type Amount } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, PartySelect } from '@/features/accounting/accounting-ui'
import { MATCH_STATE_META, TXN_TYPE_LABELS, type BookRow, type MatchState, type MoneyKind } from '@/features/accounting/bank-cash-model'
import { MatchBadge, MoneyAccountSelect } from '@/features/accounting/bank-cash-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBankLookups, fetchMoneyBook } from '@/services/accounting'

/** Bank book (kind BANK) or cash book (kind CASH): posted entries of the account's ledger with a running balance. */
export function MoneyBookPage({ kind }: { kind: MoneyKind }) {
  const bank = kind === 'BANK'
  const [params, setParams] = useSearchParams()
  const lookups = useAsync(() => fetchBankLookups(), [])
  const today = lookups.data?.today ?? ''
  const get = (k: string, d = '') => params.get(k) ?? d
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== 'all') n.set(k, v); else n.delete(k); return n }, { replace: true })
  const first = (lookups.data?.accounts ?? []).find((a) => a.account_kind === kind && a.is_active)?.id ?? ''
  const account = get('account', first)
  const from = get('from', `${today.slice(0, 8)}01`)
  const to = get('to', today)
  const type = get('type', 'all')
  const recon = get('recon', 'all')
  const party = get('party')
  const search = get('q')
  const book = useAsync(() => (account && today ? fetchMoneyBook(account, from, to, { type: type === 'all' ? null : type, reconciliation: recon === 'all' ? null : recon,
    party_id: party || null, search: search || null }) : Promise.resolve(null)), [account, from, to, type, recon, party, search])
  const b = book.data
  const title = bank ? 'Bank Book' : 'Cash Book'
  const money = (v: Amount) => <span className="tabular-nums">{formatAmount(v, true)}</span>
  const columns: DataTableColumn<BookRow>[] = [
    { id: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => formatDate(r.date) },
    { id: 'voucher', header: 'Voucher', searchValue: (r) => r.voucher_number, cell: (r) => <Link className="text-primary hover:underline" to={`/accounts/vouchers/${r.voucher_id}`}>{r.voucher_number}</Link> },
    { id: 'type', header: 'Type', cell: (r) => <span className="text-xs">{TXN_TYPE_LABELS[r.txn_type] ?? r.txn_type}{r.is_reversal ? ' (reversal)' : ''}</span> },
    { id: 'party', header: 'Counterparty', cell: (r) => <span className="text-sm">{r.counterparty ?? '—'}</span> },
    { id: 'narration', header: 'Narration', cell: (r) => <span className="line-clamp-2 max-w-sm text-sm">{r.narration ?? ''}</span> },
    { id: 'ref', header: 'Reference', cell: (r) => <span className="text-xs">{r.reference ?? ''}</span> },
    { id: 'dr', header: bank ? 'Debit (in)' : 'Receipt', align: 'right', cell: (r) => money(r.debit) },
    { id: 'cr', header: bank ? 'Credit (out)' : 'Payment', align: 'right', cell: (r) => money(r.credit) },
    { id: 'bal', header: 'Balance', align: 'right', cell: (r) => <span className="tabular-nums">{formatBalance(r.balance)}</span> },
    ...(bank ? [{ id: 'recon', header: 'Reconciliation', cell: (r: BookRow) => <MatchBadge state={r.reconciliation} /> }] : []),
  ]
  return (
    <>
      <PageHeader title={title} breadcrumbs={[{ label: 'Accounts' }, { label: title }]} description={bank
        ? 'Posted receipts, payments, transfers, adjustments and reversals of one bank account, with the running balance and reconciliation status.'
        : 'Posted receipts and payments of one cash account with the running balance and a daily opening / closing summary.'}
        actions={b && <AccountingExport title={`${title} ${b.account.account_code}`} fileStem={`${bank ? 'bank' : 'cash'}-book-${b.account.account_code}-${from}-${to}`} rows={b.rows} columns={[
          { header: 'Date', value: (r) => r.date }, { header: 'Voucher', value: (r) => r.voucher_number }, { header: 'Type', value: (r) => TXN_TYPE_LABELS[r.txn_type] ?? r.txn_type },
          { header: 'Counterparty', value: (r) => r.counterparty }, { header: 'Narration', value: (r) => r.narration }, { header: 'Reference', value: (r) => r.reference },
          { header: 'Debit', value: (r) => Number(r.debit) }, { header: 'Credit', value: (r) => Number(r.credit) }, { header: 'Balance', value: (r) => Number(r.balance) },
          { header: 'Reconciliation', value: (r) => MATCH_STATE_META[r.reconciliation].label }]}
          extraRows={[['Opening balance', Number(b.opening_balance)], ['Closing balance', Number(b.closing_balance)]]} />} />
      <AccountingNotice />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="w-72 space-y-1"><Label htmlFor="bk-account">{bank ? 'Bank account' : 'Cash account'}</Label>
            <MoneyAccountSelect id="bk-account" value={account} lookups={lookups.data} kind={kind} includeInactive onChange={(v) => set('account', v)} /></div>
          <div className="space-y-1"><Label htmlFor="bk-from">From</Label><Input id="bk-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="bk-to">To</Label><Input id="bk-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="bk-type">Type</Label>
            <Select value={type} onValueChange={(v) => set('type', v)}><SelectTrigger id="bk-type" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{['RECEIPT', 'PAYMENT', 'TRANSFER', 'BANK_ADJUSTMENT', 'JV', 'OPN'].map((t) => <SelectItem key={t} value={t}>{TXN_TYPE_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          {bank && <div className="space-y-1"><Label htmlFor="bk-recon">Reconciliation</Label>
            <Select value={recon} onValueChange={(v) => set('recon', v)}><SelectTrigger id="bk-recon" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{(Object.keys(MATCH_STATE_META) as MatchState[]).map((s) => <SelectItem key={s} value={s}>{MATCH_STATE_META[s].label}</SelectItem>)}</SelectContent></Select></div>}
          <div className="w-64 space-y-1"><Label htmlFor="bk-party">Party</Label><PartySelect id="bk-party" value={party} onChange={(v) => set('party', v)} /></div>
          <div className="space-y-1"><Label htmlFor="bk-q">Voucher / reference</Label><Input id="bk-q" className="w-44" defaultValue={search} onBlur={(e) => set('q', e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === 'Enter') set('q', (e.target as HTMLInputElement).value.trim()) }} /></div>
        </CardContent>
      </Card>
      {b && <dl className="mb-4 grid gap-3 sm:grid-cols-4" data-testid="book-totals">
        {[['Opening balance', formatBalance(b.opening_balance)], [bank ? 'Total in' : 'Receipts', formatAmount(b.total_debit)], [bank ? 'Total out' : 'Payments', formatAmount(b.total_credit)],
          ['Closing balance', formatBalance(b.closing_balance)]].map(([k, v]) => (
          <div key={k} className="rounded-lg border bg-card p-3"><dt className="text-xs text-muted-foreground">{k}</dt><dd className="text-lg font-semibold tabular-nums">{v}</dd></div>))}
      </dl>}
      <DataTable columns={columns} data={b?.rows ?? []} getRowId={(r) => r.line_id} loading={book.loading || lookups.loading} pageSize={100}
        error={book.error ? new Error(describeDataError(book.error)) : null} onRetry={book.reload}
        emptyState={{ icon: BookOpen, title: account ? 'No entries' : `No ${bank ? 'bank' : 'cash'} account`, description: account ? 'Nothing posted in the period.'
          : `Add a ${bank ? 'bank' : 'cash'} account first.` }} />
      {!bank && b && b.daily.length > 0 && (
        <Card className="mt-4">
          <CardHeader><CardTitle>Daily cash summary</CardTitle></CardHeader>
          <CardContent className="p-0"><Table data-testid="cash-daily">
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead className="text-right">Opening</TableHead><TableHead className="text-right">Receipts</TableHead>
              <TableHead className="text-right">Payments</TableHead><TableHead className="text-right">Closing</TableHead></TableRow></TableHeader>
            <TableBody>{b.daily.map((d) => (
              <TableRow key={d.date}><TableCell>{formatDate(d.date)}</TableCell><TableCell className="text-right tabular-nums">{formatBalance(d.opening)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(d.receipts)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(d.payments)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatBalance(d.closing)}</TableCell></TableRow>))}</TableBody>
          </Table></CardContent>
        </Card>
      )}
    </>
  )
}
