import { NotebookPen, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VOUCHER_STATUS_META, financialYear, formatAmount, toPaise, type VoucherListRow, type VoucherStatus } from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingExport, AccountingNotice, SetupGate, VoucherStatusBadge } from '@/features/accounting/accounting-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchVouchers, reverseVoucher } from '@/services/accounting'

export default function JournalRegisterPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <Register fyStartMonth={s.settings!.fy_start_month} today={s.today} />}</SetupGate>
}

function Register({ fyStartMonth, today }: { fyStartMonth: number; today: string }) {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const fy = financialYear(today, fyStartMonth)
  const get = (k: string, d = '') => params.get(k) ?? d
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== 'all') n.set(k, v); else n.delete(k); return n }, { replace: true })
  const from = get('from', fy.from)
  const to = get('to', today)
  const status = get('status', 'all')
  const account = get('account')
  const creator = get('by', 'all')
  const number = get('number')
  const [numberInput, setNumberInput] = useState(number)
  const [refresh, setRefresh] = useState(0)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  // Created-by choices come from the same query (without the creator filter), so the list only offers people who made journals here.
  const list = useAsync(() => fetchVouchers({ voucher_type: 'JV', source: 'MANUAL', from, to, status: status === 'all' ? null : status, account_id: account || null,
    search: number || null, limit: 1000 }), [from, to, status, account, number, refresh])
  const all = useMemo(() => list.data?.rows ?? [], [list.data])
  const creators = useMemo(() => [...new Map(all.filter((r) => r.created_by).map((r) => [r.created_by!, r.created_by_name ?? 'Unknown user'])).entries()], [all])
  const rows = creator === 'all' ? all : all.filter((r) => r.created_by === creator)
  const done = (m: string) => { setAction(null); setMessage(m); setRefresh((n) => n + 1) }

  const columns: DataTableColumn<VoucherListRow>[] = [
    { id: 'number', header: 'Voucher no.', sortValue: (v) => v.voucher_number ?? '', cell: (v) => (
      <Link className="font-medium text-primary hover:underline" to={`/accounts/vouchers/${v.id}`}>{v.voucher_number ?? 'Draft'}
        {v.reference_number && <span className="block text-xs font-normal text-muted-foreground">Ref {v.reference_number}</span>}</Link>) },
    { id: 'date', header: 'Date', sortValue: (v) => v.voucher_date, cell: (v) => formatDate(v.voucher_date) },
    { id: 'narration', header: 'Narration', cell: (v) => <span className="line-clamp-2 max-w-md text-sm">{v.narration ?? '—'}</span> },
    { id: 'debit', header: 'Debit total', align: 'right', sortValue: (v) => toPaise(v.total_debit), cell: (v) => <span className="tabular-nums">{formatAmount(v.total_debit)}</span> },
    { id: 'credit', header: 'Credit total', align: 'right', cell: (v) => <span className="tabular-nums">{formatAmount(v.total_credit)}</span> },
    { id: 'status', header: 'Status', sortValue: (v) => v.status, cell: (v) => <VoucherStatusBadge status={v.status} /> },
    { id: 'by', header: 'Created by', cell: (v) => <span className="text-xs">{v.created_by_name ?? '—'}</span> },
    { id: 'actions', header: '', align: 'right', cell: (v) => (
      <span className="flex justify-end gap-1">
        <Button variant="ghost" size="sm" asChild><Link to={`/accounts/vouchers/${v.id}`}>View</Link></Button>
        {v.status === 'DRAFT' && has('vouchers.create') && <Button variant="ghost" size="sm" asChild><Link to={`/accounts/journals/${v.id}/edit`}>Edit</Link></Button>}
        {v.status === 'POSTED' && !v.reversal_of_voucher_id && has('vouchers.reverse') && <Button variant="ghost" size="sm" className="text-shortage" onClick={() => setAction({
          title: `Reverse ${v.voucher_number}`,
          description: <>A linked reversal voucher with the opposite entries is posted today. The journal stays in the books marked reversed. The reason is kept in the audit trail.</>,
          confirmLabel: 'Reverse journal', note: 'required', minLength: 5, destructive: true,
          run: async (n) => { const r = await reverseVoucher(v.id, n!, null); return `${v.voucher_number} reversed by ${r.reversal.voucher_number}.` },
        })}>Reverse</Button>}
      </span>) },
  ]

  return (
    <>
      <PageHeader actions={<>
        <AccountingExport title="Journal register" fileStem={`journal-register-${from}-${to}`} rows={rows} columns={[
          { header: 'Voucher no.', value: (v) => v.voucher_number }, { header: 'Date', value: (v) => v.voucher_date }, { header: 'Reference', value: (v) => v.reference_number },
          { header: 'Narration', value: (v) => v.narration }, { header: 'Debit total', value: (v) => Number(v.total_debit) }, { header: 'Credit total', value: (v) => Number(v.total_credit) },
          { header: 'Status', value: (v) => VOUCHER_STATUS_META[v.status].label }, { header: 'Created by', value: (v) => v.created_by_name },
        ]} />
        {has('vouchers.create') && <Button asChild><Link to="/accounts/journals/new"><Plus /> New journal</Link></Button>}
      </>} />
      <AccountingNotice>Manual journal vouchers only. Drafts and discarded journals are listed for control but never reach the reports.</AccountingNotice>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="jr-from">From</Label><Input id="jr-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="jr-to">To</Label><Input id="jr-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="jr-number">Voucher number</Label>
            <Input id="jr-number" className="w-44" value={numberInput} placeholder="e.g. JV/26-27/000012" onChange={(e) => setNumberInput(e.target.value)}
              onBlur={() => set('number', numberInput.trim())} onKeyDown={(e) => { if (e.key === 'Enter') set('number', numberInput.trim()) }} /></div>
          <div className="w-72 space-y-1"><Label htmlFor="jr-account">Account</Label>
            <AccountSelect id="jr-account" value={account} postableOnly={false} allowClear placeholder="Any account" onChange={(v) => set('account', v)} /></div>
          <div className="space-y-1"><Label htmlFor="jr-status">Status</Label>
            <Select value={status} onValueChange={(v) => set('status', v)}><SelectTrigger id="jr-status" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{(Object.keys(VOUCHER_STATUS_META) as VoucherStatus[]).map((s) => <SelectItem key={s} value={s}>{VOUCHER_STATUS_META[s].label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="jr-by">Created by</Label>
            <Select value={creator} onValueChange={(v) => set('by', v)}><SelectTrigger id="jr-by" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Anyone</SelectItem>{creators.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent></Select></div>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} getRowId={(v) => v.id} loading={list.loading} pageSize={50} searchable={false}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        title={list.data ? `${rows.length} journal(s)${list.data.total > all.length ? ` — first ${all.length} of ${list.data.total} loaded; narrow the dates` : ''}` : undefined}
        emptyState={{ icon: NotebookPen, title: 'No journal vouchers', description: 'Manual journals in the selected period appear here.',
          action: has('vouchers.create') ? <Button asChild><Link to="/accounts/journals/new"><Plus /> New journal</Link></Button> : undefined }} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}
