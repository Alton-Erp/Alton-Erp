import { BarChart3 } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatAmount } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice } from '@/features/accounting/accounting-ui'
import { BANK_REPORTS, RECON_CATEGORY_LABELS, type BankReportKey, type BankReportRow } from '@/features/accounting/bank-cash-model'
import { MoneyAccountSelect } from '@/features/accounting/bank-cash-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchBankLookups, fetchBankReport } from '@/services/accounting'

type Kind = 'text' | 'amount' | 'date' | 'number' | 'category'
const COLS: Record<BankReportKey, [string, string, Kind?][]> = {
  ACCOUNT_SUMMARY: [['account_code', 'Account'], ['account_name', 'Name'], ['account_kind', 'Kind'], ['account_number_masked', 'Number'], ['ledger_code', 'Ledger'],
    ['ledger_balance', 'Book balance', 'amount'], ['statement_balance', 'Last statement balance', 'amount'], ['unmatched_ledger', 'Open book entries', 'number'],
    ['unmatched_statement', 'Open statement lines', 'number'], ['last_reconciled', 'Last reconciled', 'date']],
  OUTSTANDING_CHEQUES: [['account_code', 'Account'], ['voucher_date', 'Date', 'date'], ['voucher_number', 'Voucher'], ['counterparty', 'Payee'], ['reference', 'Cheque / ref'],
    ['remaining', 'Amount', 'amount'], ['days', 'Days', 'number']],
  DEPOSITS_IN_TRANSIT: [['account_code', 'Account'], ['voucher_date', 'Date', 'date'], ['voucher_number', 'Voucher'], ['counterparty', 'From'], ['reference', 'Reference'],
    ['remaining', 'Amount', 'amount'], ['days', 'Days', 'number']],
  OUTSTANDING_ITEMS: [['account_code', 'Account'], ['category', 'Type', 'category'], ['voucher_date', 'Date', 'date'], ['voucher_number', 'Voucher'], ['payment_method', 'Method'],
    ['counterparty', 'Party'], ['reference', 'Reference'], ['remaining', 'Open amount', 'amount'], ['days', 'Days', 'number']],
  UNMATCHED_STATEMENT: [['account_code', 'Account'], ['category', 'Type', 'category'], ['txn_date', 'Date', 'date'], ['description', 'Description'], ['reference', 'Reference'],
    ['remaining', 'Open amount', 'amount'], ['days', 'Days', 'number']],
  BANK_CHARGES: [['account_code', 'Account'], ['date', 'Date', 'date'], ['description', 'Description'], ['category', 'Kind'], ['amount', 'Amount', 'amount'], ['state', 'State'],
    ['voucher_number', 'Voucher'], ['ledger', 'Ledger']],
  TRANSFER_REGISTER: [['transfer_number', 'Transfer'], ['transfer_date', 'Date', 'date'], ['from_account_code', 'From'], ['to_account_code', 'To'], ['amount', 'Amount', 'amount'],
    ['charges', 'Charges', 'amount'], ['reference', 'Reference'], ['status', 'Status'], ['voucher_number', 'Voucher']],
  CASH_POSITION: [['account_code', 'Cash account'], ['account_name', 'Name'], ['custodian', 'Custodian'], ['receipts_today', 'Receipts (day)', 'amount'], ['payments_today', 'Payments (day)', 'amount'],
    ['balance', 'Balance', 'amount']],
}
const show = (v: BankReportRow[string], k: Kind = 'text') => {
  if (v === null || v === undefined || v === '') return '—'
  if (k === 'amount') return <span className="tabular-nums">{formatAmount(v as number)}</span>
  if (k === 'date') return formatDate(String(v))
  if (k === 'category') return RECON_CATEGORY_LABELS[String(v)] ?? String(v)
  return String(v).replace(/_/g, ' ')
}

export default function BankReportsPage() {
  const [params, setParams] = useSearchParams()
  const report = (params.get('report') ?? 'ACCOUNT_SUMMARY') as BankReportKey
  const meta = BANK_REPORTS.find((r) => r.key === report) ?? BANK_REPORTS[0]
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const asOf = params.get('as_of') ?? ''
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const account = params.get('account') ?? ''
  const lookups = useAsync(() => fetchBankLookups(), [])
  const data = useAsync(() => fetchBankReport(meta.key, { as_of: asOf || null, from: from || null, to: to || null, account_id: account || null }), [meta.key, asOf, from, to, account])
  const rows: BankReportRow[] = (data.data?.rows ?? []).map((r, i) => ({ ...r, _row: i }))
  const cols = COLS[meta.key]
  const columns: DataTableColumn<BankReportRow>[] = cols.map(([key, header, kind]) => ({ id: key, header, align: kind === 'amount' || kind === 'number' ? 'right' : 'left',
    sortValue: (r) => (kind === 'amount' || kind === 'number' ? Number(r[key] ?? 0) : String(r[key] ?? '')), searchValue: !kind || kind === 'text' ? (r) => String(r[key] ?? '') : undefined,
    cell: (r) => show(r[key], kind) }))
  return (
    <>
      <PageHeader title="Bank & Cash Reports" breadcrumbs={[{ label: 'Accounts' }, { label: 'Bank Reconciliation', to: '/accounts/bank-reconciliation' }, { label: 'Reports' }]}
        actions={<AccountingExport title={meta.label} fileStem={`bank-${meta.key.toLowerCase()}`} rows={rows}
          columns={cols.map(([key, header, kind]) => ({ header, value: (r: BankReportRow) => (kind === 'amount' || kind === 'number' ? (r[key] === null ? null : Number(r[key])) : (r[key] as string | null)) }))} />} />
      <AccountingNotice>Balances come from posted vouchers; open items from the reconciliation matches.</AccountingNotice>
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="bkr-report">Report</Label>
          <Select value={meta.key} onValueChange={(v) => set('report', v)}><SelectTrigger id="bkr-report" className="w-72"><SelectValue /></SelectTrigger>
            <SelectContent>{BANK_REPORTS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}</SelectContent></Select></div>
        {meta.usesAsOf && <div className="space-y-1"><Label htmlFor="bkr-asof">As of</Label><Input id="bkr-asof" type="date" value={asOf} onChange={(e) => set('as_of', e.target.value)} /></div>}
        {meta.usesPeriod && <><div className="space-y-1"><Label htmlFor="bkr-from">From</Label><Input id="bkr-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="bkr-to">To</Label><Input id="bkr-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div></>}
        <div className="w-72 space-y-1"><Label htmlFor="bkr-account">Account</Label>
          <MoneyAccountSelect id="bkr-account" value={account} lookups={lookups.data} kind={meta.key === 'CASH_POSITION' ? 'CASH' : meta.key === 'ACCOUNT_SUMMARY' || meta.key === 'TRANSFER_REGISTER' ? null : 'BANK'}
            includeInactive allowClear placeholder="All accounts" onChange={(v) => set('account', v)} /></div>
      </CardContent></Card>
      <p className="mb-2 text-sm text-muted-foreground">{meta.description}</p>
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r._row)} loading={data.loading} pageSize={100} error={data.error ? new Error(describeDataError(data.error)) : null}
        onRetry={data.reload} title={data.data ? `${rows.length} row(s)` : undefined} emptyState={{ icon: BarChart3, title: 'Nothing to show', description: 'No rows for the selected report.' }} />
    </>
  )
}
