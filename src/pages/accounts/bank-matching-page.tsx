import { FileUp, Link2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatAmount, toPaise, type Amount } from '@/features/accounting/accounting-model'
import { AccountingNotice, SearchSelect } from '@/features/accounting/accounting-ui'
import { RECON_CATEGORY_LABELS, selectionTotals, type Brs, type StatementItem } from '@/features/accounting/bank-cash-model'
import { MatchBadge, MoneyAccountSelect } from '@/features/accounting/bank-cash-ui'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  fetchAdjustmentProposal, fetchBankLookups, fetchBrs, fetchReconHistory, fetchReconSuggestions, fetchReconWorkspace, postStatementAdjustment, reconAutoMatch, reconMatch, reconUnmatch,
  saveReconciliation,
} from '@/services/accounting'

const signed = (v: Amount) => <span className={`tabular-nums ${toPaise(v) < 0 ? 'text-red-700' : ''}`}>{formatAmount(v)}</span>

export default function BankReconciliationPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const lookups = useAsync(() => fetchBankLookups(), [])
  const today = lookups.data?.today ?? ''
  const first = (lookups.data?.accounts ?? []).find((a) => a.account_kind === 'BANK' && a.is_active)?.id ?? ''
  const account = params.get('account') ?? first
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const showMatched = params.get('matched') === '1'
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const [tolerance, setTolerance] = useState('3')
  const [refresh, setRefresh] = useState(0)
  const [selS, setSelS] = useState<string[]>([])
  const [selL, setSelL] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [adjust, setAdjust] = useState<StatementItem | null>(null)
  const ws = useAsync(() => (account ? fetchReconWorkspace(account, from || null, to || null, showMatched) : Promise.resolve(null)), [account, from, to, showMatched, refresh])
  const sugg = useAsync(() => (account ? fetchReconSuggestions(account, Number(tolerance) || 0) : Promise.resolve([])), [account, tolerance, refresh])
  const canManage = has('bank_reconciliation.manage')
  const done = (m: string) => { setAction(null); setAdjust(null); setSelS([]); setSelL([]); setMessage(m); setRefresh((n) => n + 1) }
  const w = ws.data
  const statement = w?.statement ?? []
  const ledger = w?.ledger ?? []
  const totals = selectionTotals(statement.filter((s) => selS.includes(s.line_id)), ledger.filter((l) => selL.includes(l.line_id)))
  const confident = (sugg.data ?? []).filter((s) => s.confident).length
  // Functional updates: quick successive clicks must not overwrite each other.
  const toggle = (setList: (f: (v: string[]) => string[]) => void, id: string, on: boolean) => setList((list) => (on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id)))
  const auto = async () => {
    setError(null)
    try { const r = await reconAutoMatch(account, Number(tolerance) || 0); done(`${r.matched} match(es) confirmed.`) } catch (e) { setError(describeDataError(e)) }
  }

  return (
    <>
      <PageHeader title="Bank Reconciliation" breadcrumbs={[{ label: 'Accounts' }, { label: 'Bank Reconciliation' }]}
        description="Match posted bank entries with imported statement lines. Matching never creates vouchers; charges and interest are posted only when you confirm them."
        actions={<>
          <Button variant="outline" asChild><Link to={`/accounts/bank-reconciliation/import${account ? `?account=${account}` : ''}`}><FileUp /> Import statement</Link></Button>
          <Button variant="outline" asChild><Link to="/accounts/bank-reconciliation/reports">Reports</Link></Button>
        </>} />
      <AccountingNotice>Ledger side: posted vouchers on the bank's ledger. Statement side: imported bank statements (evidence only).</AccountingNotice>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-80 space-y-1"><Label htmlFor="br-account">Bank account</Label>
          <MoneyAccountSelect id="br-account" value={account} lookups={lookups.data} kind="BANK" includeInactive onChange={(v) => { setSelS([]); setSelL([]); set('account', v) }} /></div>
        <div className="space-y-1"><Label htmlFor="br-from">From</Label><Input id="br-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="br-to">To</Label><Input id="br-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="br-tol">Date tolerance (days)</Label><Input id="br-tol" className="w-24" inputMode="numeric" value={tolerance} onChange={(e) => setTolerance(e.target.value.replace(/\D/g, ''))} /></div>
        <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={showMatched} onCheckedChange={(v) => set('matched', v ? '1' : '')} /> Show matched</label>
        {canManage && <Button variant="outline" disabled={!confident} onClick={() => void auto()}><Wand2 /> Auto-match {confident} sure pair(s)</Button>}
      </CardContent></Card>
      {ws.loading ? <LoadingState variant="table" /> : ws.error ? <ErrorState message={describeDataError(ws.error)} onRetry={ws.reload} /> : !account ? (
        <p className="text-sm text-muted-foreground">Add a bank account first (Accounts › Bank Accounts).</p>) : (<>
        <div className="mb-4 grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader><div><CardTitle>Books (posted ledger entries)</CardTitle><CardDescription>Deposits positive, payments negative.</CardDescription></div></CardHeader>
            <CardContent className="max-h-[32rem] overflow-y-auto p-0"><Table data-testid="br-ledger">
              <TableHeader><TableRow><TableHead /><TableHead>Date</TableHead><TableHead>Voucher / party</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Open</TableHead><TableHead>State</TableHead></TableRow></TableHeader>
              <TableBody>{ledger.map((l) => (
                <TableRow key={l.line_id}>
                  <TableCell>{canManage && l.state !== 'MATCHED' && <Checkbox aria-label={`Select ledger ${l.voucher_number}`} checked={selL.includes(l.line_id)} onCheckedChange={(v) => toggle(setSelL, l.line_id, v === true)} />}</TableCell>
                  <TableCell className="text-sm">{formatDate(l.date)}</TableCell>
                  <TableCell className="text-sm"><Link className="text-primary hover:underline" to={`/accounts/vouchers/${l.voucher_id}`}>{l.voucher_number}</Link>{l.is_reversal ? ' (reversal)' : ''}
                    <span className="block text-xs text-muted-foreground">{l.counterparty ?? l.narration}{l.reference ? ` · ${l.reference}` : ''}</span></TableCell>
                  <TableCell className="text-right">{signed(l.amount)}</TableCell><TableCell className="text-right">{signed(l.remaining)}</TableCell><TableCell><MatchBadge state={l.state} /></TableCell>
                </TableRow>))}
                {!ledger.length && <TableRow><TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">Nothing open.</TableCell></TableRow>}</TableBody>
            </Table></CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Bank statement</CardTitle><CardDescription>Credits (deposits) positive, debits negative.</CardDescription></div></CardHeader>
            <CardContent className="max-h-[32rem] overflow-y-auto p-0"><Table data-testid="br-statement">
              <TableHeader><TableRow><TableHead /><TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Open</TableHead><TableHead>State</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{statement.map((s) => (
                <TableRow key={s.line_id}>
                  <TableCell>{canManage && s.state !== 'MATCHED' && <Checkbox aria-label={`Select statement ${s.description ?? s.date}`} checked={selS.includes(s.line_id)} onCheckedChange={(v) => toggle(setSelS, s.line_id, v === true)} />}</TableCell>
                  <TableCell className="text-sm">{formatDate(s.date)}</TableCell>
                  <TableCell className="text-sm">{s.description}<span className="block text-xs text-muted-foreground">{[s.reference, s.bank_txn_id, s.category !== 'OTHER' ? s.category.toLowerCase() : null].filter(Boolean).join(' · ')}</span></TableCell>
                  <TableCell className="text-right">{signed(s.amount)}</TableCell><TableCell className="text-right">{signed(s.remaining)}</TableCell><TableCell><MatchBadge state={s.state} /></TableCell>
                  <TableCell>{has('bank_reconciliation.approve') && s.state === 'UNMATCHED' && !s.adjustment_voucher_id && <Button variant="ghost" size="sm" onClick={() => setAdjust(s)}>Post adjustment</Button>}</TableCell>
                </TableRow>))}
                {!statement.length && <TableRow><TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">Nothing open. Import a statement to reconcile.</TableCell></TableRow>}</TableBody>
            </Table></CardContent>
          </Card>
        </div>
        {canManage && (selS.length > 0 || selL.length > 0) && (
          <div className="sticky bottom-2 z-10 mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 shadow" data-testid="br-selection">
            <span className="text-sm">Statement {formatAmount(totals.statement / 100)} · Books {formatAmount(totals.ledger / 100)} · Difference <strong>{formatAmount(totals.difference / 100)}</strong></span>
            <Button disabled={!totals.valid} onClick={() => setAction({ title: 'Match the selected lines', confirmLabel: 'Match', note: 'required', minLength: 5,
              description: 'A manual match needs a reason (it is kept in the reconciliation history). Both sides must be equal; post an adjustment for any difference first.',
              run: async (n) => { await reconMatch(account, [...selS.map((id) => ({ statement_line_id: id })), ...selL.map((id) => ({ voucher_line_id: id }))], n!); return 'Matched.' } })}>
              <Link2 /> Match selected</Button>
            <Button variant="ghost" onClick={() => { setSelS([]); setSelL([]) }}>Clear</Button>
          </div>)}
        {(w?.matches ?? []).length > 0 && (
          <Card className="mb-4">
            <CardHeader><div><CardTitle>Matches</CardTitle></div></CardHeader>
            <CardContent className="p-0"><Table>
              <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Method</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Lines</TableHead><TableHead>Reason</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>{w!.matches.map((m) => (
                <TableRow key={m.id}><TableCell className="text-sm">{formatDateTime(m.created_at)}<span className="block text-xs text-muted-foreground">{m.created_by_name}</span></TableCell>
                  <TableCell className="text-sm">{m.method.toLowerCase()}</TableCell><TableCell className="text-right">{signed(m.total)}</TableCell>
                  <TableCell className="text-sm">{m.items.filter((i) => i.statement_line_id).length} statement · {m.items.filter((i) => i.voucher_line_id).length} books</TableCell>
                  <TableCell className="text-sm">{m.reason ?? ''}</TableCell>
                  <TableCell className="text-right">{canManage && <Button variant="ghost" size="sm" onClick={() => setAction({ title: 'Unmatch', confirmLabel: 'Unmatch', note: 'required', minLength: 5,
                    description: 'The match is kept in the history as reversed and the lines become open again. No voucher changes.', run: async (n) => { await reconUnmatch(m.id, n!); return 'Unmatched.' } })}>Unmatch</Button>}</TableCell></TableRow>))}</TableBody>
            </Table></CardContent>
          </Card>)}
        {today && <BrsCard accountId={account} today={today} refreshKey={refresh} onSaved={(m) => done(m)} />}
      </>)}
      {adjust && <AdjustDialog line={adjust} onClose={() => setAdjust(null)} onDone={done} />}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}

function AdjustDialog({ line, onClose, onDone }: { line: StatementItem; onClose: () => void; onDone: (m: string) => void }) {
  const prop = useAsync(() => fetchAdjustmentProposal(line.line_id), [line.line_id])
  const [ledger, setLedger] = useState('')
  const [narration, setNarration] = useState(line.description ?? '')
  const [dupReason, setDupReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dups = prop.data?.possible_duplicates ?? []
  const ok = ledger && (!dups.length || dupReason.trim().length >= 10)
  const post = async () => {
    setBusy(true); setError(null)
    try { const r = await postStatementAdjustment(line.line_id, ledger, narration.trim(), dups.length ? dupReason.trim() : null); onDone(`Adjustment ${r.voucher_number} posted and matched.`) }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Post a bank adjustment</DialogTitle>
          <DialogDescription>{formatDate(line.date)} · {line.description} · {formatAmount(line.amount)}. {prop.data?.proposal ?? ''} — one bank-adjustment voucher, matched to this line.</DialogDescription></DialogHeader>
        {prop.loading ? <LoadingState /> : prop.error ? <ErrorState message={describeDataError(prop.error)} /> : (<>
          {dups.length > 0 && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Possibly already in the books: {dups.map((d) => `${d.voucher_number} (${formatDate(d.date)})`).join(', ')}. Match it instead, or explain why this is not a duplicate.</div>}
          <div className="space-y-1"><Label htmlFor="adj-ledger">{line.amount && toPaise(line.amount) < 0 ? 'Expense ledger' : 'Income ledger'}</Label>
            <SearchSelect id="adj-ledger" value={ledger} placeholder="Select the ledger" options={(prop.data?.accounts ?? []).map((a) => ({ value: a.id, label: `${a.account_code} — ${a.account_name}`,
              hint: a.cost_centre_policy === 'REQUIRED' ? 'needs a cost centre' : undefined }))} onChange={setLedger} /></div>
          <div className="space-y-1"><Label htmlFor="adj-narr">Narration</Label><Input id="adj-narr" value={narration} onChange={(e) => setNarration(e.target.value)} /></div>
          {dups.length > 0 && <div className="space-y-1"><Label htmlFor="adj-dup">Why this is not a duplicate (10+ characters)</Label><Textarea id="adj-dup" rows={2} value={dupReason} onChange={(e) => setDupReason(e.target.value)} /></div>}
        </>)}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy || !ok} onClick={() => void post()}>Post adjustment</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BrsCard({ accountId, today, refreshKey, onSaved }: { accountId: string; today: string; refreshKey: number; onSaved: (m: string) => void }) {
  const { has } = usePermissions()
  const [asOf, setAsOf] = useState(today)
  const [stmt, setStmt] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const brs = useAsync(() => fetchBrs(accountId, asOf, stmt.trim() || null), [accountId, asOf, stmt, refreshKey])
  const history = useAsync(() => fetchReconHistory(accountId), [accountId, refreshKey])
  const b: Brs | null | undefined = brs.data
  const diff = b?.difference === null || b?.difference === undefined ? null : toPaise(b.difference)
  const save = async () => {
    setError(null)
    try { const r = await saveReconciliation(accountId, asOf, stmt.trim() || null, diff ? reason.trim() : null); onSaved(r.status === 'COMPLETED' ? 'Reconciliation saved: complete.' : 'Reconciliation saved with an accepted difference.') }
    catch (e) { setError(describeDataError(e)) }
  }
  const row = (k: string, v: Amount | null, strong = false) => <><dt className={strong ? 'font-semibold' : ''}>{k}</dt><dd className={`text-right tabular-nums ${strong ? 'font-semibold' : ''}`}>{v === null ? '—' : formatAmount(v)}</dd></>
  return (
    <Card data-testid="brs">
      <CardHeader><div><CardTitle>Bank reconciliation statement</CardTitle>
        <CardDescription>A reconciliation is complete only when the difference is zero (or an approver accepts a documented difference).</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="brs-asof">As of</Label><Input id="brs-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="brs-stmt">Statement closing balance (blank = from the statement)</Label><Input id="brs-stmt" className="w-56 text-right" inputMode="decimal" value={stmt} onChange={(e) => setStmt(e.target.value)} /></div>
        </div>
        {brs.loading ? <LoadingState /> : brs.error ? <ErrorState message={describeDataError(brs.error)} onRetry={brs.reload} /> : b && (<>
          <div className="grid gap-6 md:grid-cols-2">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm" data-testid="brs-bank">
              {row(`Statement balance${b.statement_balance_source === 'STATEMENT' ? ' (from the statement)' : ''}`, b.statement_balance)}
              {row('+ Deposits in transit', b.outstanding_deposits)}{row('− Outstanding payments / cheques', b.outstanding_payments)}{row('Adjusted bank balance', b.adjusted_bank_balance, true)}
            </dl>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm" data-testid="brs-book">
              {row('Ledger (book) balance', b.ledger_balance)}{row('+ Bank credits not in the books', b.unrecorded_credits)}{row('− Bank debits not in the books', b.unrecorded_debits)}
              {row('Adjusted book balance', b.adjusted_book_balance, true)}
            </dl>
          </div>
          <p className={`text-sm font-semibold ${diff === 0 ? 'text-green-700' : 'text-red-700'}`} data-testid="brs-difference">
            {diff === null ? 'Statement balance unknown — enter it or import a statement with running balances.' : diff === 0 ? 'Difference 0.00 — reconciled.' : `Difference ${formatAmount(diff / 100)} — not reconciled.`}</p>
          {(b.ledger_items.length > 0 || b.statement_items.length > 0) && <Table>
            <TableHeader><TableRow><TableHead>Open item</TableHead><TableHead>Date</TableHead><TableHead>Detail</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Days</TableHead></TableRow></TableHeader>
            <TableBody>
              {b.ledger_items.map((i) => <TableRow key={i.line_id}><TableCell className="text-sm">{RECON_CATEGORY_LABELS[i.category] ?? i.category}</TableCell><TableCell className="text-sm">{formatDate(i.voucher_date)}</TableCell>
                <TableCell className="text-sm">{i.voucher_number} · {i.counterparty ?? i.narration}{i.reference ? ` · ${i.reference}` : ''}</TableCell><TableCell className="text-right">{signed(i.remaining)}</TableCell><TableCell className="text-right">{i.days}</TableCell></TableRow>)}
              {b.statement_items.map((i) => <TableRow key={i.line_id}><TableCell className="text-sm">{RECON_CATEGORY_LABELS[i.category] ?? i.category}</TableCell><TableCell className="text-sm">{formatDate(i.txn_date)}</TableCell>
                <TableCell className="text-sm">{i.description}</TableCell><TableCell className="text-right">{signed(i.remaining)}</TableCell><TableCell className="text-right">{i.days}</TableCell></TableRow>)}
            </TableBody>
          </Table>}
          {has('bank_reconciliation.manage') && diff !== null && (
            <div className="flex flex-wrap items-end gap-3">
              {diff !== 0 && <div className="w-96 space-y-1"><Label htmlFor="brs-reason">Accept the difference — reason (approver, 10+ characters)</Label>
                <Input id="brs-reason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
              <Button disabled={diff !== 0 && (!has('bank_reconciliation.approve') || reason.trim().length < 10)} onClick={() => void save()}>
                {diff === 0 ? 'Save reconciliation' : 'Save with accepted difference'}</Button>
            </div>)}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </>)}
        {(history.data ?? []).length > 0 && <div><p className="mb-1 text-sm font-medium">Saved reconciliations</p>
          <ul className="space-y-1 text-sm" data-testid="brs-history">{history.data!.map((h) => <li key={h.id}>{formatDate(h.as_of_date)} · {h.status === 'COMPLETED' ? 'complete' : `difference ${formatAmount(h.difference)} accepted: ${h.difference_reason}`} · {h.created_by_name}</li>)}</ul></div>}
      </CardContent>
    </Card>
  )
}
