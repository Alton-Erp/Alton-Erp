import { CalendarDays } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAmount, type Voucher } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice, SetupGate, VoucherStatusBadge } from '@/features/accounting/accounting-ui'
import { CostCentreSelect } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchDayBook } from '@/services/accounting'

const TYPES = [['JV', 'Journal'], ['SAL', 'Sales'], ['RCT', 'Receipt'], ['PMT', 'Payment'], ['CRN', 'Credit note'], ['DBN', 'Debit note'], ['PUR', 'Purchase (GRN)'],
  ['OPN', 'Opening'], ['REV', 'Reversal']] as const

export default function DayBookPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <DayBookView today={s.today} />}</SetupGate>
}

function DayBookView({ today }: { today: string }) {
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? today
  const to = params.get('to') ?? today
  const type = params.get('type') ?? 'all'
  const cc = params.get('cc') ?? ''
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== 'all') n.set(k, v); else n.delete(k); return n }, { replace: true })
  const book = useAsync(() => fetchDayBook(from, to, type === 'all' ? null : type, cc || null), [from, to, type, cc])
  const vouchers = book.data?.vouchers ?? []
  const flat = vouchers.flatMap((v) => v.lines.map((l) => ({ v, l })))

  return (
    <>
      <PageHeader actions={<AccountingExport title="Day book" fileStem={`day-book-${from}-${to}`} rows={flat} columns={[
        { header: 'Date', value: ({ v }) => v.voucher_date }, { header: 'Voucher no.', value: ({ v }) => v.voucher_number }, { header: 'Type', value: ({ v }) => v.voucher_type_name },
        { header: 'Status', value: ({ v }) => v.status }, { header: 'Narration', value: ({ v }) => v.narration }, { header: 'Account code', value: ({ l }) => l.account_code },
        { header: 'Account', value: ({ l }) => l.account_name }, { header: 'Party', value: ({ l }) => l.party_name }, { header: 'Debit', value: ({ l }) => Number(l.debit) },
        { header: 'Credit', value: ({ l }) => Number(l.credit) },
      ]} />} />
      <AccountingNotice />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="db-from">From</Label><Input id="db-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="db-to">To</Label><Input id="db-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="db-type">Voucher type</Label>
            <Select value={type} onValueChange={(v) => set('type', v)}><SelectTrigger id="db-type" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All types</SelectItem>{TYPES.map(([c, l]) => <SelectItem key={c} value={c}>{l}</SelectItem>)}</SelectContent></Select></div>
          <div className="w-64 space-y-1"><Label htmlFor="db-cc">Cost centre</Label>
            <CostCentreSelect id="db-cc" value={cc} activeOnly={false} allowClear placeholder="All (company-wide)" onChange={(v) => set('cc', v)} /></div>
          {book.data && <p className="ml-auto pb-2 text-sm text-muted-foreground">{book.data.totals.vouchers} voucher(s) · Debit {formatAmount(book.data.totals.debit)} · Credit {formatAmount(book.data.totals.credit)}</p>}
        </CardContent>
      </Card>
      {book.loading ? <LoadingState variant="table" /> : book.error ? <ErrorState message={describeDataError(book.error)} onRetry={book.reload} />
        : !vouchers.length ? <EmptyState icon={CalendarDays} title="No posted vouchers" description={`Nothing was posted between ${formatDate(from)} and ${formatDate(to)}.`} /> : (
          <Card><CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Date / voucher</TableHead><TableHead>Account</TableHead><TableHead>Party</TableHead>
                <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead></TableRow></TableHeader>
              <TableBody>{vouchers.map((v: Voucher) => [
                <TableRow key={v.id} className="bg-muted/40">
                  <TableCell colSpan={5}><span className="mr-3 whitespace-nowrap">{formatDate(v.voucher_date)}</span>
                    <Link className="font-medium text-primary hover:underline" to={`/accounts/vouchers/${v.id}`}>{v.voucher_number}</Link>
                    <span className="mx-2 text-xs text-muted-foreground">{v.voucher_type_name}</span><VoucherStatusBadge status={v.status} />
                    {v.narration && <span className="ml-3 text-sm text-muted-foreground">{v.narration}</span>}</TableCell>
                </TableRow>,
                ...v.lines.map((l) => (
                  <TableRow key={l.id}><TableCell /><TableCell>{l.account_code} {l.account_name}</TableCell><TableCell className="text-sm">{l.party_name ?? ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(l.debit, true)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(l.credit, true)}</TableCell></TableRow>
                )),
              ])}</TableBody>
            </Table>
          </CardContent></Card>
        )}
    </>
  )
}
