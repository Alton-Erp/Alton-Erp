import { ListOrdered } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SOURCE_LABELS, SOURCE_TYPE_LABELS, VOUCHER_STATUS_META, financialYear, formatAmount, toPaise, type SourceType, type VoucherListRow, type VoucherSource, type VoucherStatus,
} from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingExport, AccountingNotice, SetupGate, VoucherStatusBadge } from '@/features/accounting/accounting-ui'
import { CostCentreSelect } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchVouchers } from '@/services/accounting'

const TYPES = [['JV', 'Journal'], ['SAL', 'Sales'], ['RCT', 'Receipt'], ['PMT', 'Payment'], ['CRN', 'Credit note'], ['DBN', 'Debit note'], ['PUR', 'Purchase (GRN)'],
  ['OPN', 'Opening'], ['REV', 'Reversal']] as const

export default function VoucherRegisterPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <Register fyStartMonth={s.settings!.fy_start_month} today={s.today} />}</SetupGate>
}

function Register({ fyStartMonth, today }: { fyStartMonth: number; today: string }) {
  const [params, setParams] = useSearchParams()
  const fy = financialYear(today, fyStartMonth)
  const get = (k: string, d = '') => params.get(k) ?? d
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== 'all') n.set(k, v); else n.delete(k); return n }, { replace: true })
  const from = get('from', fy.from)
  const to = get('to', today)
  const statusF = get('status', 'all')
  const typeF = get('type', 'all')
  const sourceF = get('source', 'all')
  const account = get('account')
  const cc = get('cc')
  const [search, setSearch] = useState(get('q'))
  const list = useAsync(() => fetchVouchers({ from, to, status: statusF === 'all' ? null : statusF, voucher_type: typeF === 'all' ? null : typeF,
    source: sourceF === 'all' ? null : sourceF, account_id: account || null, cost_centre_id: cc || null, search: get('q') || null, limit: 1000 }), [from, to, statusF, typeF, sourceF, account, cc, params.get('q')])
  const rows = list.data?.rows ?? []

  const columns: DataTableColumn<VoucherListRow>[] = [
    { id: 'number', header: 'Voucher', sortValue: (v) => v.voucher_number ?? '', searchValue: (v) => `${v.voucher_number ?? ''} ${v.reference_number ?? ''}`, cell: (v) => (
      <Link className="font-medium text-primary hover:underline" to={`/accounts/vouchers/${v.id}`}>{v.voucher_number ?? 'Draft'}
        <span className="block text-xs font-normal text-muted-foreground">{v.voucher_type_name}</span></Link>) },
    { id: 'date', header: 'Date', sortValue: (v) => v.voucher_date, cell: (v) => formatDate(v.voucher_date) },
    { id: 'narration', header: 'Narration', searchValue: (v) => `${v.narration ?? ''} ${v.source_number ?? ''}`, cell: (v) => (
      <span className="line-clamp-2 max-w-md text-sm">{v.narration ?? '—'}
        {v.source_type && <span className="block text-xs text-muted-foreground">{SOURCE_TYPE_LABELS[v.source_type as SourceType] ?? v.source_type} {v.source_number ?? ''}</span>}</span>) },
    { id: 'source', header: 'Source', cell: (v) => <span className="text-xs">{SOURCE_LABELS[v.source]}</span> },
    { id: 'debit', header: 'Debit', align: 'right', sortValue: (v) => toPaise(v.total_debit), cell: (v) => <span className="tabular-nums">{formatAmount(v.total_debit)}</span> },
    { id: 'credit', header: 'Credit', align: 'right', cell: (v) => <span className="tabular-nums">{formatAmount(v.total_credit)}</span> },
    { id: 'status', header: 'Status', cell: (v) => <VoucherStatusBadge status={v.status} /> },
    { id: 'by', header: 'Created by', searchValue: (v) => v.created_by_name ?? '', cell: (v) => <span className="text-xs">{v.created_by_name ?? 'System'}</span> },
  ]

  return (
    <>
      <PageHeader actions={<AccountingExport title="Voucher register" fileStem={`voucher-register-${from}-${to}`} rows={rows} columns={[
        { header: 'Voucher no.', value: (v) => v.voucher_number }, { header: 'Type', value: (v) => v.voucher_type_name }, { header: 'Date', value: (v) => v.voucher_date },
        { header: 'Reference', value: (v) => v.reference_number }, { header: 'Narration', value: (v) => v.narration }, { header: 'Source', value: (v) => SOURCE_LABELS[v.source] },
        { header: 'Source document', value: (v) => v.source_number }, { header: 'Debit', value: (v) => Number(v.total_debit) }, { header: 'Credit', value: (v) => Number(v.total_credit) },
        { header: 'Status', value: (v) => VOUCHER_STATUS_META[v.status].label }, { header: 'Created by', value: (v) => v.created_by_name },
      ]} />} />
      <AccountingNotice>Drafts and discarded vouchers are listed here for control but never reach the reports.</AccountingNotice>
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="vr-from">From</Label><Input id="vr-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="vr-to">To</Label><Input id="vr-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="vr-status">Status</Label>
            <Select value={statusF} onValueChange={(v) => set('status', v)}><SelectTrigger id="vr-status" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{(Object.keys(VOUCHER_STATUS_META) as VoucherStatus[]).map((s) => <SelectItem key={s} value={s}>{VOUCHER_STATUS_META[s].label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="vr-type">Type</Label>
            <Select value={typeF} onValueChange={(v) => set('type', v)}><SelectTrigger id="vr-type" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All types</SelectItem>{TYPES.map(([c, l]) => <SelectItem key={c} value={c}>{l}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="vr-source">Source</Label>
            <Select value={sourceF} onValueChange={(v) => set('source', v)}><SelectTrigger id="vr-source" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{(Object.keys(SOURCE_LABELS) as VoucherSource[]).map((s) => <SelectItem key={s} value={s}>{SOURCE_LABELS[s]}</SelectItem>)}</SelectContent></Select></div>
          <div className="w-72 space-y-1"><Label htmlFor="vr-account">Account</Label>
            <AccountSelect id="vr-account" value={account} postableOnly={false} allowClear placeholder="Any account" onChange={(v) => set('account', v)} /></div>
          <div className="w-64 space-y-1"><Label htmlFor="vr-cc">Cost centre</Label>
            <CostCentreSelect id="vr-cc" value={cc} activeOnly={false} allowClear placeholder="Any cost centre" onChange={(v) => set('cc', v)} /></div>
          <div className="space-y-1"><Label htmlFor="vr-q">Voucher / reference / narration</Label>
            <Input id="vr-q" value={search} onChange={(e) => setSearch(e.target.value)} onBlur={() => set('q', search.trim())}
              onKeyDown={(e) => { if (e.key === 'Enter') set('q', search.trim()) }} placeholder="Search…" /></div>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} getRowId={(v) => v.id} loading={list.loading} pageSize={50} searchable={false}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        title={list.data ? `${list.data.total} voucher(s)${list.data.total > rows.length ? `, first ${rows.length} shown` : ''}` : undefined}
        emptyState={{ icon: ListOrdered, title: 'No vouchers', description: 'Posted, draft and reversed vouchers in the selected period appear here.' }} />
    </>
  )
}
