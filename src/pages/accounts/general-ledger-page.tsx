import { BookOpen } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SOURCE_TYPE_LABELS, financialYear, formatAmount, formatBalance, lineTotals, type LedgerEntry, type SourceType } from '@/features/accounting/accounting-model'
import { AccountSelect, AccountingExport, AccountingNotice, PartySelect, SetupGate, VoucherStatusBadge } from '@/features/accounting/accounting-ui'
import { CostCentreSelect } from '@/features/accounting/cost-centre-ui'
import { useAccountingStatus } from '@/features/accounting/use-accounting-status'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchGeneralLedger } from '@/services/accounting'

export default function GeneralLedgerPage() {
  const status = useAccountingStatus()
  return <SetupGate status={status}>{(s) => <Ledger fyStartMonth={s.settings!.fy_start_month} today={s.today} />}</SetupGate>
}

function Ledger({ fyStartMonth, today }: { fyStartMonth: number; today: string }) {
  const [params, setParams] = useSearchParams()
  const fy = financialYear(today, fyStartMonth)
  const account = params.get('account') ?? ''
  const party = params.get('party') ?? ''
  const cc = params.get('cc') ?? ''
  const from = params.get('from') ?? fy.from
  const to = params.get('to') ?? today
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); if (k === 'account') n.delete('party'); return n }, { replace: true })
  const gl = useAsync(() => (account ? fetchGeneralLedger(account, from, to, party || null, cc || null) : Promise.resolve(null)), [account, from, to, party, cc])
  const g = gl.data
  const totals = useMemo(() => lineTotals(g?.entries ?? []), [g])

  return (
    <>
      <PageHeader actions={<AccountingExport title="General ledger" fileStem={`general-ledger-${g?.account.account_code ?? ''}-${from}-${to}`} rows={g?.entries ?? []} columns={[
        { header: 'Date', value: (e: LedgerEntry) => e.voucher_date }, { header: 'Voucher no.', value: (e) => e.voucher_number }, { header: 'Type', value: (e) => e.voucher_type },
        { header: 'Narration', value: (e) => e.narration }, { header: 'Party', value: (e) => e.party_name }, { header: 'Source document', value: (e) => e.source_number },
        { header: 'Debit', value: (e) => Number(e.debit) }, { header: 'Credit', value: (e) => Number(e.credit) }, { header: 'Balance (Dr + / Cr −)', value: (e) => Number(e.balance) },
      ]} extraRows={g ? [['', '', '', 'Opening balance', '', '', '', '', Number(g.opening_balance)], ['', '', '', 'Closing balance', '', '', totals.debit, totals.credit, Number(g.closing_balance)]] : []} />} />
      <AccountingNotice />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="w-80 space-y-1"><Label htmlFor="gl-account">Ledger account</Label>
            <AccountSelect id="gl-account" value={account} postableOnly={false} onChange={(v) => set('account', v)} /></div>
          {g?.account.requires_party && <div className="w-72 space-y-1"><Label htmlFor="gl-party">Customer / supplier</Label>
            <PartySelect id="gl-party" value={party} onChange={(v) => set('party', v)} /></div>}
          <div className="w-64 space-y-1"><Label htmlFor="gl-cc">Cost centre</Label>
            <CostCentreSelect id="gl-cc" value={cc} activeOnly={false} allowClear placeholder="All (company-wide)" onChange={(v) => set('cc', v)} /></div>
          <div className="space-y-1"><Label htmlFor="gl-from">From</Label><Input id="gl-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="gl-to">To</Label><Input id="gl-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
        </CardContent>
      </Card>
      {!account ? <EmptyState icon={BookOpen} title="Choose a ledger account" description="The ledger lists every posted voucher line of the account with a running balance." />
        : gl.loading ? <LoadingState variant="table" /> : gl.error ? <ErrorState message={describeDataError(gl.error)} onRetry={gl.reload} /> : g && (
          <Card>
            <CardHeader><div><CardTitle>{g.account.account_code} {g.account.account_name}</CardTitle>
              <CardDescription>{formatDate(from)} – {formatDate(to)} · normal balance {g.account.normal_balance.toLowerCase()}{party ? ' · one party' : ''}{cc ? ' · allocated share of one cost centre' : ''}</CardDescription></div></CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Voucher</TableHead><TableHead>Narration</TableHead><TableHead>Party</TableHead>
                  <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead className="text-right">Balance</TableHead></TableRow></TableHeader>
                <TableBody>
                  <TableRow className="bg-muted/40"><TableCell colSpan={6} className="font-medium">Opening balance</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatBalance(g.opening_balance)}</TableCell></TableRow>
                  {g.entries.map((e, i) => (
                    <TableRow key={`${e.voucher_id}-${i}`}>
                      <TableCell className="whitespace-nowrap">{formatDate(e.voucher_date)}</TableCell>
                      <TableCell><Link className="text-primary hover:underline" to={`/accounts/vouchers/${e.voucher_id}`}>{e.voucher_number}</Link>
                        {e.status === 'REVERSED' && <span className="ml-1"><VoucherStatusBadge status="REVERSED" /></span>}</TableCell>
                      <TableCell className="max-w-md text-sm">{e.narration ?? ''}{e.source_type && <span className="block text-xs text-muted-foreground">{SOURCE_TYPE_LABELS[e.source_type as SourceType] ?? ''} {e.source_number ?? ''}</span>}</TableCell>
                      <TableCell className="text-sm">{e.party_name ?? ''}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(e.debit, true)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(e.credit, true)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatBalance(e.balance)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 font-semibold"><TableCell colSpan={4}>Closing balance</TableCell>
                    <TableCell className="text-right tabular-nums">{formatAmount(totals.debit)}</TableCell><TableCell className="text-right tabular-nums">{formatAmount(totals.credit)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBalance(g.closing_balance)}</TableCell></TableRow>
                </TableBody>
              </Table>
              {!g.entries.length && <p className="p-4 text-sm text-muted-foreground">No posted entries in this period.</p>}
            </CardContent>
          </Card>
        )}
    </>
  )
}
