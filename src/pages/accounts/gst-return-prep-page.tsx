import { Download, FileText, Printer } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAmount, toPaise } from '@/features/accounting/accounting-model'
import { AccountingNotice, Field } from '@/features/accounting/accounting-ui'
import {
  ARN_PATTERN, GSTR1_SECTIONS, GSTR3B_SECTIONS, HEADS, VALUE_STATUS_META, exceptionRows, exceptionSummary, gstr1Sheets, gstr3bSheets, normaliseArn,
  type Amount, type GstPeriod, type Gstr1, type Gstr3b, type ReturnException, type ReturnSection,
} from '@/features/accounting/gst-returns-model'
import { ControlReportsPanel, GstPrintStyles, PeriodClosePanel, PrintHeader } from '@/features/accounting/gst-close-ui'
import type { ReturnMeta } from '@/features/accounting/gst-returns-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import {
  createGstPeriod, fetchGstDashboard, fetchGstExceptions, fetchGstPayments, fetchGstPeriods, fetchGstReconciliation, fetchGstRegister, fetchGstr1, fetchGstr3b,
  recordGstFiling, transitionGstPeriod, voidGstFiling,
} from '@/services/accounting'

type Tab = 'overview' | 'close' | 'gstr1' | 'gstr3b' | 'registers' | 'payments' | 'reconciliation' | 'exceptions' | 'reports'
const TABS: { key: Tab; label: string }[] = [{ key: 'overview', label: 'Dashboard' }, { key: 'close', label: 'Period close' }, { key: 'gstr1', label: 'GSTR-1' }, { key: 'gstr3b', label: 'GSTR-3B' },
  { key: 'registers', label: 'Registers' }, { key: 'payments', label: 'Payments & challans' }, { key: 'reconciliation', label: 'Ledger reconciliation' }, { key: 'exceptions', label: 'Exceptions' },
  { key: 'reports', label: 'Control reports' }]
type Sheet = { name: string; rows: (string | number | null)[][] }
/** Generation time shown on exports and print views. */
const nowStamp = () => new Date().toLocaleString('en-IN')
const amt = (x: unknown) => (x === null || x === undefined || x === '' ? '—' : formatAmount(x as Amount))

async function exportSheets(sheets: Sheet[], fileStem: string, format: 'xlsx' | 'csv') {
  const { downloadSheets } = await import('@/features/products/spreadsheet')
  await downloadSheets(sheets, fileStem, format)
}
function ExportMenu({ sheets, fileStem }: { sheets: Sheet[] | (() => Sheet[]); fileStem: string }) {
  const [busy, setBusy] = useState(false)
  const run = async (format: 'xlsx' | 'csv') => { setBusy(true); try { await exportSheets(typeof sheets === 'function' ? sheets() : sheets, fileStem, format) } finally { setBusy(false) } }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline" className="print:hidden" disabled={busy || (Array.isArray(sheets) && sheets.length === 0)}><Download /> Working file</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void run('xlsx')}>Excel (.xlsx, all sheets)</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run('csv')}>CSV (summary sheet)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
const PrintButton = () => <Button variant="outline" className="print:hidden" onClick={() => window.print()}><Printer /> Print</Button>

export default function GstReturnsPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') ?? 'overview') as Tab
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const periods = useAsync(() => fetchGstPeriods(), [])
  const list = [...(periods.data ?? [])].sort((a, b) => b.period_start.localeCompare(a.period_start))
  const periodId = params.get('period') ?? list[0]?.id ?? ''
  const period = list.find((p) => p.id === periodId) ?? null
  const [message, setMessage] = useState<string | null>(null)
  const dash = useAsync(() => fetchGstDashboard(), [])
  const reg = (dash.data?.registration ?? null) as { gstin: string; legal_name: string } | null
  const meta = (): ReturnMeta => ({ company: reg?.legal_name ?? '', gstin: reg?.gstin ?? '', financial_year: period?.financial_year ?? '', generated_at: nowStamp() })
  return (
    <>
      <GstPrintStyles />
      <PageHeader title="GST Returns" breadcrumbs={[{ label: 'Accounts' }, { label: 'GST' }, { label: 'GST Returns' }]}
        description="GSTR-1 and GSTR-3B working data, registers, payments and reconciliation." />
      <div className="print:hidden"><AccountingNotice>Working data for preparing returns on the GST portal. This system does not file returns and has no GSTN or portal connection.
        Figures come from issued and posted documents, approved ITC decisions, posted set-offs and the ledgers; drafts and cancelled documents are never included.</AccountingNotice></div>
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        <div className="w-64 space-y-1"><Label htmlFor="gstr-period">Return period</Label>
          <Select value={periodId} onValueChange={(v) => set('period', v)}><SelectTrigger id="gstr-period"><SelectValue placeholder={periods.loading ? 'Loading…' : 'No periods yet'} /></SelectTrigger>
            <SelectContent>{list.map((p) => <SelectItem key={p.id} value={p.id}>{p.period_code} · {p.status.replace(/_/g, ' ').toLowerCase()}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex flex-wrap gap-2" role="tablist">{TABS.map((t) => (
          <Button key={t.key} role="tab" aria-selected={tab === t.key} variant={tab === t.key ? 'default' : 'outline'} onClick={() => set('tab', t.key)}>{t.label}</Button>))}</div>
      </div>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800 print:hidden">{message}</p>}
      <div className="print-area">{periods.error ? <ErrorState message={describeDataError(periods.error)} onRetry={periods.reload} /> : tab === 'overview'
        ? <Overview period={period} onChanged={(m) => { setMessage(m); periods.reload() }} onSelect={(id) => set('period', id)} />
        : !period ? <Card><CardContent className="p-4 text-sm text-muted-foreground">Create a GST return period on the dashboard first.</CardContent></Card>
        : tab === 'close' ? <PeriodClosePanel period={period} onChanged={(m) => { setMessage(m); periods.reload() }} />
        : tab === 'reports' ? <ControlReportsPanel period={period} />
        : tab === 'gstr1' ? <Gstr1View period={period} onMessage={setMessage} meta={meta} />
        : tab === 'gstr3b' ? <Gstr3bView period={period} onMessage={setMessage} meta={meta} />
        : tab === 'registers' ? <Registers period={period} />
        : tab === 'payments' ? <Payments period={period} />
        : tab === 'reconciliation' ? <Reconciliation period={period} />
        : <Exceptions period={period} />}</div>
    </>
  )
}

function Overview({ period, onChanged, onSelect }: { period: GstPeriod | null; onChanged: (m: string) => void; onSelect: (id: string) => void }) {
  const { has } = usePermissions()
  const dash = useAsync(() => fetchGstDashboard(), [])
  const [start, setStart] = useState('')
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = (m: string) => { setAction(null); onChanged(m); dash.reload() }
  const move = (a: 'START_REVIEW' | 'READY' | 'RETURN' | 'APPROVE' | 'CLOSE', label: string, description: ReactNode, note: 'none' | 'required' = 'none') =>
    setAction({ title: `${label} ${period?.period_code}`, confirmLabel: label, note, minLength: 5, description,
      run: async (n) => { const r = await transitionGstPeriod(period!.id, a, n); return `${r.period_code} is now ${r.status.replace(/_/g, ' ').toLowerCase()}.` } })
  if (dash.loading && !dash.data) return <LoadingState />
  if (dash.error) return <ErrorState message={describeDataError(dash.error)} onRetry={dash.reload} />
  const d = dash.data!
  const reg = d.registration as { gstin: string; legal_name: string } | null
  return (
    <>
      <Card className="mb-4"><CardContent className="p-4"><dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Field label="GSTIN">{reg ? `${reg.gstin} · ${reg.legal_name}` : 'Not set up'}</Field>
        <Field label="Configuration in force">{d.config_version_no ? `Version ${String(d.config_version_no)}` : 'None approved'}</Field>
        <Field label="ITC pending verification">{String(d.itc_pending ?? 0)}</Field>
        <Field label="GSTR-2B missing in books">{String(d.gstr2b_missing_in_books ?? 0)}</Field>
        <Field label="Unpaid challans">{String(d.challans_unpaid ?? 0)}</Field>
        <Field label="Electronic cash">{Object.entries((d.cash ?? {}) as Record<string, Amount>).filter(([, v]) => Number(v) !== 0).map(([k, v]) => `${k} ${formatAmount(v)}`).join(' · ') || '—'}</Field>
      </dl></CardContent></Card>
      <Card className="mb-4"><CardHeader><div><CardTitle>Return periods</CardTitle><CardDescription>Open liability per head after posted set-offs; credit available for set-off.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Period</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Open IGST</TableHead>
          <TableHead className="text-right">Open CGST</TableHead><TableHead className="text-right">Open SGST</TableHead><TableHead className="text-right">Credit IGST / CGST / SGST</TableHead>
          <TableHead>Set-off</TableHead><TableHead>Filed (recorded)</TableHead></TableRow></TableHeader>
          <TableBody>{d.periods.map((q) => {
            const open = (q.liability ?? {}) as Record<string, Amount>
            const credit = (q.credit ?? {}) as Record<string, Amount>
            const o = (h: string) => toPaise(open[`OUTPUT:${h}`] ?? 0) + toPaise(open[`RCM:${h}`] ?? 0)
            return (
              <TableRow key={String(q.id)} className="cursor-pointer" onClick={() => onSelect(String(q.id))}>
                <TableCell>{String(q.period_code)}{q.id === period?.id ? ' (selected)' : ''}</TableCell>
                <TableCell>{String(q.status).replace(/_/g, ' ').toLowerCase()}{q.snapshot_version ? ` · snapshot v${String(q.snapshot_version)}` : ''}</TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(o('IGST') / 100)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(o('CGST') / 100)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatAmount(o('SGST') / 100)}</TableCell>
                <TableCell className="text-right tabular-nums">{amt(credit.IGST)} / {amt(credit.CGST)} / {amt(credit.SGST)}</TableCell>
                <TableCell>{q.set_off ? String(q.set_off).toLowerCase() : '—'}</TableCell>
                <TableCell>{Object.keys((q.filed ?? {}) as object).join(', ') || '—'}</TableCell>
              </TableRow>)
          })}</TableBody></Table></CardContent></Card>
      {has('gst_returns.prepare') && <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="space-y-1"><Label htmlFor="gstr-new">New period starting</Label><Input id="gstr-new" type="month" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <Button variant="outline" disabled={!start} onClick={async () => {
          setError(null)
          try { const p = await createGstPeriod(`${start}-01`); setStart(''); done(`Period ${p.period_code} created.`); onSelect(p.id) } catch (e) { setError(describeDataError(e)) }
        }}>Create period</Button>
        {period && <>
          {period.status === 'OPEN' && <Button onClick={() => move('START_REVIEW', 'Start review', 'The period moves to review; return adjustments can still be entered.')}>Start review</Button>}
          {period.status === 'UNDER_REVIEW' && <Button onClick={() => move('READY', 'Mark ready', 'Blocking checklist items (unresolved amendments, draft adjustments, missing configuration) must be cleared.')}>Mark ready for approval</Button>}
          {period.status === 'READY_FOR_APPROVAL' && has('gst_returns.approve') && <Button onClick={() => move('APPROVE', 'Approve',
            'Maker-checker: not by the preparer. Approval stores an immutable snapshot with the GSTR-1 and GSTR-3B working. Nothing is filed or posted.')}>Approve</Button>}
          {period.status === 'READY_FOR_APPROVAL' && <Button variant="outline" onClick={() => move('RETURN', 'Return for changes', 'Back to review.', 'required')}>Return</Button>}
          {period.status === 'APPROVED' && has('gst_periods.close') && <Button variant="outline" onClick={() => move('CLOSE', 'Close', 'Closing keeps the approved snapshot.')}>Close period</Button>}
        </>}
        {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
      </CardContent></Card>}
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </>
  )
}

function StatusLine({ r }: { r: Gstr1 | Gstr3b }) {
  const meta = VALUE_STATUS_META[r.value_status]
  return (
    <Card className="mb-4"><CardContent className="space-y-2 p-4">
      <div className="flex flex-wrap items-center gap-2"><StatusBadge label={meta.label} tone={meta.tone} /><span className="text-sm">{meta.description}</span></div>
      <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Field label="Period">{r.period} ({formatDate(r.from)} – {formatDate(r.to)})</Field>
        <Field label="Source">{r.source === 'SNAPSHOT' && r.snapshot ? `Approved snapshot v${r.snapshot.version_no}` : 'Live from documents'}</Field>
        <Field label="Configuration">{r.config_version_no ? `Version ${r.config_version_no}` : 'None approved'}</Field>
        <Field label="Filing">{r.filing ? `ARN ${r.filing.arn} · ${formatDate(r.filing.filed_on)} (recorded by ${r.filing.recorded_by_name ?? '—'})` : 'Not recorded'}</Field>
        <Field label="Exceptions">{exceptionSummary(r.exceptions).map((e) => `${e.code.replace(/_/g, ' ').toLowerCase()} ${e.count}`).join(' · ') || 'None'}</Field>
      </dl>
      {r.live_differs && <p className="text-sm text-amber-800">The documents changed after approval. The approved values above are kept; the changes appear as amendment exceptions in a later period.</p>}
      <p className="text-xs text-muted-foreground">{r.disclaimer}</p>
    </CardContent></Card>
  )
}

function SectionTable({ sections, codes }: { sections: Record<string, ReturnSection>; codes: { code: string; label: string }[] }) {
  return (
    <Card className="mb-4"><CardContent className="overflow-x-auto p-0"><Table>
      <TableHeader><TableRow><TableHead>Section</TableHead><TableHead>Values</TableHead>{HEADS.map((h) => <TableHead key={h} className="text-right">{h === 'taxable' ? 'Taxable' : h.toUpperCase()}</TableHead>)}
        <TableHead>Adjustments</TableHead></TableRow></TableHeader>
      <TableBody>{codes.filter((c) => sections[c.code]).flatMap((c) => {
        const s = sections[c.code]
        const row = (kind: 'calculated' | 'adjusted') => (
          <TableRow key={`${c.code}-${kind}`} data-section={c.code} data-kind={kind}>
            <TableCell>{kind === 'calculated' ? <><strong>{c.code}</strong> <span className="text-xs text-muted-foreground">{s.label ?? c.label}</span></> : ''}</TableCell>
            <TableCell>{kind === 'calculated' ? 'Calculated' : 'Manually adjusted'}</TableCell>
            {HEADS.map((h) => <TableCell key={h} className="text-right tabular-nums">{amt(s[kind][h])}</TableCell>)}
            <TableCell className="text-xs">{kind === 'calculated' ? s.adjustments.map((a) => `${a.status === 'APPROVED' ? 'Approved' : 'Pending'} ${a.field} ${formatAmount(a.amount)}: ${a.reason}`).join('; ') || '—' : ''}</TableCell>
          </TableRow>)
        return s.value_status === 'ADJUSTED' ? [row('calculated'), row('adjusted')] : [row('calculated')]
      })}</TableBody></Table></CardContent></Card>
  )
}

function FilingActions({ r, period, type, onMessage, reload }: { r: Gstr1 | Gstr3b; period: GstPeriod; type: 'GSTR1' | 'GSTR3B'; onMessage: (m: string) => void; reload: () => void }) {
  const { has } = usePermissions()
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [arn, setArn] = useState('')
  const [filedOn, setFiledOn] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!has('gst_returns.approve') || !['APPROVED', 'CLOSED'].includes(period.status)) return null
  const done = (m: string) => { setAction(null); onMessage(m); reload() }
  return (
    <Card className="mb-4 print:hidden"><CardHeader><div><CardTitle>Filing record</CardTitle>
      <CardDescription>After you file this return on the GST portal, record the ARN here. This system does not file returns.</CardDescription></div></CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        {r.filing ? <Button variant="outline" className="text-shortage" onClick={() => setAction({ title: 'Void the filing record', confirmLabel: 'Void record', note: 'required', minLength: 10, destructive: true,
          description: 'Only for a record entered by mistake. The return on the portal is not affected.', run: async (n) => { await voidGstFiling(r.filing!.id, n!); return 'Filing record voided.' } })}>Void filing record</Button>
          : <>
            <div className="space-y-1"><Label htmlFor={`arn-${type}`}>ARN</Label><Input id={`arn-${type}`} value={arn} onChange={(e) => setArn(e.target.value)} placeholder="15 letters / digits" /></div>
            <div className="space-y-1"><Label htmlFor={`filed-${type}`}>Filed on</Label><Input id={`filed-${type}`} type="date" value={filedOn} onChange={(e) => setFiledOn(e.target.value)} /></div>
            <Button disabled={!ARN_PATTERN.test(normaliseArn(arn)) || !filedOn} onClick={async () => {
              setError(null)
              try { await recordGstFiling(period.id, type, normaliseArn(arn), filedOn, null); setArn(''); setFiledOn(''); done(`${type} filing recorded (ARN ${normaliseArn(arn)}).`) }
              catch (e) { setError(describeDataError(e)) }
            }}>Record filing</Button></>}
        {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
      </CardContent>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </Card>
  )
}

function Gstr1View({ period, onMessage, meta }: { period: GstPeriod; onMessage: (m: string) => void; meta: () => ReturnMeta }) {
  const r = useAsync(() => fetchGstr1(period.id), [period.id])
  const [printedAt] = useState(nowStamp)
  if (r.loading && !r.data) return <LoadingState />
  if (r.error) return <ErrorState message={describeDataError(r.error)} onRetry={r.reload} />
  const x = r.data!
  return (
    <div data-testid="gstr1-working">
      <div className="mb-2 flex flex-wrap justify-end gap-2"><ExportMenu sheets={() => gstr1Sheets(x, meta())} fileStem={`GSTR1-${x.period}`} /><PrintButton /></div>
      <PrintHeader doc={{ title: 'GSTR-1 working', header: null, tables: [], meta: { ...meta(), generated_at: printedAt, period: x.period, config_version_no: x.config_version_no,
        snapshot: x.snapshot ? `Snapshot v${x.snapshot.version_no} · ${x.snapshot.snapshot_hash}` : null, value_status: x.value_status } }} />
      <StatusLine r={x} />
      <SectionTable sections={x.sections} codes={GSTR1_SECTIONS} />
      <Card className="mb-4"><CardHeader><div><CardTitle>HSN summary</CardTitle><CardDescription>B2B and B2C separately; credit notes net off. UQC from the approved configuration.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>HSN / SAC</TableHead><TableHead>UQC</TableHead><TableHead className="text-right">Rate %</TableHead><TableHead>B2B / B2C</TableHead>
          <TableHead className="text-right">Quantity</TableHead><TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">IGST</TableHead><TableHead className="text-right">CGST</TableHead>
          <TableHead className="text-right">SGST</TableHead></TableRow></TableHeader>
          <TableBody>{x.hsn.map((h, i) => <TableRow key={i}><TableCell>{h.hsn_sac}</TableCell><TableCell>{h.uqc}</TableCell><TableCell className="text-right">{String(h.rate)}</TableCell>
            <TableCell>{h.b2b ? 'B2B' : 'B2C'}</TableCell><TableCell className="text-right tabular-nums">{String(h.quantity)}</TableCell><TableCell className="text-right tabular-nums">{amt(h.taxable)}</TableCell>
            <TableCell className="text-right tabular-nums">{amt(h.igst)}</TableCell><TableCell className="text-right tabular-nums">{amt(h.cgst)}</TableCell><TableCell className="text-right tabular-nums">{amt(h.sgst)}</TableCell></TableRow>)}</TableBody>
        </Table></CardContent></Card>
      <Card className="mb-4"><CardHeader><div><CardTitle>Documents issued</CardTitle><CardDescription>{`Excluded from the return: ${x.excluded.draft_or_pending} draft / pending, ${x.excluded.cancelled} cancelled, ${x.excluded.proforma} pro-forma.`}</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Nature</TableHead><TableHead>Series</TableHead><TableHead>From</TableHead><TableHead>To</TableHead>
          <TableHead className="text-right">Total</TableHead><TableHead className="text-right">Cancelled</TableHead><TableHead className="text-right">Net issued</TableHead></TableRow></TableHeader>
          <TableBody>{x.documents_issued.map((d, i) => <TableRow key={i}><TableCell>{d.nature}</TableCell><TableCell>{d.series || '—'}</TableCell><TableCell>{d.from}</TableCell><TableCell>{d.to}</TableCell>
            <TableCell className="text-right">{d.total}</TableCell><TableCell className="text-right">{d.cancelled}</TableCell><TableCell className="text-right">{d.net_issued}</TableCell></TableRow>)}</TableBody>
        </Table></CardContent></Card>
      <FilingActions r={x} period={period} type="GSTR1" onMessage={onMessage} reload={r.reload} />
    </div>
  )
}

function Gstr3bView({ period, onMessage, meta }: { period: GstPeriod; onMessage: (m: string) => void; meta: () => ReturnMeta }) {
  const r = useAsync(() => fetchGstr3b(period.id), [period.id])
  const [printedAt] = useState(nowStamp)
  if (r.loading && !r.data) return <LoadingState />
  if (r.error) return <ErrorState message={describeDataError(r.error)} onRetry={r.reload} />
  const x = r.data!
  return (
    <div data-testid="gstr3b-working">
      <div className="mb-2 flex flex-wrap justify-end gap-2"><ExportMenu sheets={() => gstr3bSheets(x, meta())} fileStem={`GSTR3B-${x.period}`} /><PrintButton /></div>
      <PrintHeader doc={{ title: 'GSTR-3B working', header: null, tables: [], meta: { ...meta(), generated_at: printedAt, period: x.period, config_version_no: x.config_version_no,
        snapshot: x.snapshot ? `Snapshot v${x.snapshot.version_no} · ${x.snapshot.snapshot_hash}` : null, value_status: x.value_status } }} />
      <StatusLine r={x} />
      <SectionTable sections={x.sections} codes={GSTR3B_SECTIONS.map((code) => ({ code, label: code }))} />
      <Card className="mb-4"><CardContent className="p-4 text-sm">Net ITC (4C): IGST {amt(x.net_itc.igst)} · CGST {amt(x.net_itc.cgst)} · SGST {amt(x.net_itc.sgst)} · cess {amt(x.net_itc.cess)}
        <p className="mt-1 text-xs text-muted-foreground">{x.itc_evidence.note} {Object.entries(x.itc_evidence.by_gstr2b_status).map(([k, v]) => `${k.replace(/_/g, ' ').toLowerCase()}: ${v.decisions} decision(s), ITC ${formatAmount(v.itc)}`).join(' · ')}</p></CardContent></Card>
      <Card className="mb-4"><CardHeader><div><CardTitle>6.1 Payment of tax</CardTitle><CardDescription>From posted set-offs of the period; the ledger liability is shown for comparison.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Head</TableHead><TableHead className="text-right">Payable per return</TableHead><TableHead className="text-right">Liability per ledger</TableHead>
          <TableHead>Paid through ITC</TableHead><TableHead className="text-right">Paid in cash</TableHead><TableHead className="text-right">Interest</TableHead><TableHead className="text-right">Late fee</TableHead>
          <TableHead className="text-right">Open</TableHead></TableRow></TableHeader>
          <TableBody>{x['6.1'].map((p) => <TableRow key={p.head}><TableCell>{p.head}</TableCell><TableCell className="text-right tabular-nums">{amt(p.payable_per_return)}</TableCell>
            <TableCell className="text-right tabular-nums">{amt(p.liability_per_ledger)}</TableCell><TableCell>{Object.entries(p.paid_through_itc).map(([k, v]) => `${k} ${formatAmount(v)}`).join(' · ') || '—'}</TableCell>
            <TableCell className="text-right tabular-nums">{amt(p.paid_in_cash)}</TableCell><TableCell className="text-right tabular-nums">{amt(p.interest)}</TableCell>
            <TableCell className="text-right tabular-nums">{amt(p.late_fee)}</TableCell><TableCell className="text-right tabular-nums">{amt(p.open_after_set_off)}</TableCell></TableRow>)}</TableBody>
        </Table></CardContent></Card>
      {x.credit && <Card className="mb-4"><CardHeader><div><CardTitle>Credit position</CardTitle><CardDescription>Historical (as of the period end) and current (ledger today) are kept apart.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Head</TableHead><TableHead className="text-right">Accrued by period end</TableHead>
          <TableHead className="text-right">Used through period</TableHead><TableHead className="text-right">Available at period end</TableHead><TableHead className="text-right">Current (ledger)</TableHead>
          <TableHead className="text-right">Available for set-off</TableHead></TableRow></TableHeader>
          <TableBody>{Object.entries(x.credit).map(([h, c]) => <TableRow key={h}><TableCell>{h}</TableCell><TableCell className="text-right tabular-nums">{amt(c.accrued_to_period_end)}</TableCell>
            <TableCell className="text-right tabular-nums">{amt(c.used_to_period)}</TableCell><TableCell className="text-right tabular-nums">{amt(c.available_at_period_end)}</TableCell>
            <TableCell className="text-right tabular-nums">{amt(c.current_available)}</TableCell><TableCell className="text-right tabular-nums">{amt(c.available)}</TableCell></TableRow>)}</TableBody>
        </Table></CardContent></Card>}
      <FilingActions r={x} period={period} type="GSTR3B" onMessage={onMessage} reload={r.reload} />
    </div>
  )
}

const REGISTER_COLUMNS: Record<'SALES' | 'PURCHASE' | 'RCM', [string, string, 'amount' | 'date' | 'text'][]> = {
  SALES: [['number', 'Document', 'text'], ['kind', 'Type', 'text'], ['doc_date', 'Date', 'date'], ['customer_name', 'Customer', 'text'], ['customer_gstin', 'GSTIN', 'text'],
    ['place_of_supply', 'POS', 'text'], ['section', 'Section', 'text'], ['taxable', 'Taxable', 'amount'], ['igst', 'IGST', 'amount'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount']],
  PURCHASE: [['invoice_number', 'Invoice', 'text'], ['supplier_name', 'Supplier', 'text'], ['supplier_gstin', 'GSTIN', 'text'], ['supplier_invoice_number', 'Supplier invoice', 'text'],
    ['supplier_invoice_date', 'Date', 'date'], ['taxable', 'Taxable', 'amount'], ['igst', 'IGST', 'amount'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount'], ['gst_status', 'ITC', 'text'],
    ['itc_eligible', 'ITC eligible', 'amount'], ['gstr2b', 'GSTR-2B', 'text']],
  RCM: [['invoice_number', 'Invoice', 'text'], ['supplier_name', 'Supplier', 'text'], ['recorded_date', 'Recorded', 'date'], ['taxable', 'Taxable', 'amount'], ['igst', 'IGST', 'amount'],
    ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount'], ['rcm_period', 'Liability period', 'text'], ['gst_status', 'ITC', 'text']],
}

function Registers({ period }: { period: GstPeriod }) {
  const [kind, setKind] = useState<'SALES' | 'PURCHASE' | 'RCM'>('SALES')
  const data = useAsync(() => fetchGstRegister(kind, { period_id: period.id }), [kind, period.id])
  const cols = REGISTER_COLUMNS[kind]
  const rows: Record<string, unknown>[] = (data.data?.rows ?? []).map((r, i) => ({ ...r, _row: i }))
  const sign = (r: Record<string, unknown>) => (r.sign === -1 ? -1 : 1)
  const columns: DataTableColumn<Record<string, unknown>>[] = cols.map(([k, h, t]) => ({ id: k, header: h, align: t === 'amount' ? 'right' : 'left', searchValue: t === 'text' ? (r) => String(r[k] ?? '') : undefined,
    cell: (r) => (t === 'amount' ? <span className="tabular-nums">{amt(r[k] === null || r[k] === undefined ? null : sign(r) * Number(r[k]))}</span> : t === 'date' ? (r[k] ? formatDate(String(r[k])) : '—')
      : String(r[k] ?? '—').replace(/_/g, ' ')) }))
  const sheets: Sheet[] = [{ name: `${kind} register`, rows: [cols.map(([, h]) => h), ...rows.map((r) => cols.map(([k, , t]) => (t === 'amount' ? (r[k] === null || r[k] === undefined ? null : sign(r) * Number(r[k])) : (r[k] as string | null) ?? null)))] }]
  return (
    <>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div className="w-56 space-y-1 print:hidden"><Label htmlFor="gstr-register">Register</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}><SelectTrigger id="gstr-register"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="SALES">Sales register</SelectItem><SelectItem value="PURCHASE">Purchase register</SelectItem><SelectItem value="RCM">Reverse-charge register</SelectItem></SelectContent></Select></div>
        <div className="flex gap-2"><ExportMenu sheets={sheets} fileStem={`${kind.toLowerCase()}-register-${period.period_code}`} /><PrintButton /></div>
      </div>
      <p className="mb-2 text-sm text-muted-foreground">{data.data?.note}</p>
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r._row)} loading={data.loading} pageSize={100} error={data.error ? new Error(describeDataError(data.error)) : null}
        onRetry={data.reload} title={data.data ? `${rows.length} document(s) · taxable ${amt(data.data.totals.taxable)}` : undefined}
        emptyState={{ icon: FileText, title: 'No documents', description: 'No issued / posted documents in this period.' }} />
    </>
  )
}

function Payments({ period }: { period: GstPeriod }) {
  const data = useAsync(() => fetchGstPayments(null), [])
  if (data.loading && !data.data) return <LoadingState />
  if (data.error) return <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
  const x = data.data!
  return (
    <>
      <div className="mb-2 flex justify-end"><PrintButton /></div>
      <Card className="mb-4"><CardHeader><div><CardTitle>Challans</CardTitle><CardDescription>Electronic cash ledger {formatAmount(x.cash_ledger)}.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>CPIN</TableHead><TableHead>Date</TableHead><TableHead>Status</TableHead><TableHead>Heads</TableHead><TableHead>Payments</TableHead></TableRow></TableHeader>
          <TableBody>{x.challans.map((c) => <TableRow key={String(c.id)}><TableCell>{String(c.cpin)}</TableCell><TableCell>{formatDate(String(c.challan_date))}</TableCell><TableCell>{String(c.status).toLowerCase()}</TableCell>
            <TableCell className="text-xs">{(c.heads as Record<string, unknown>[]).map((h) => `${String(h.major_head)} ${String(h.minor_head).toLowerCase()} ${formatAmount(h.amount as Amount)}`).join(' · ')}</TableCell>
            <TableCell className="text-xs">{(c.payments as Record<string, unknown>[]).map((p) => `#${String(p.attempt_no)} ${String(p.status).toLowerCase()}${p.cin ? ` CIN ${String(p.cin)}` : ''}${p.voucher_number ? ` · ${String(p.voucher_number)}` : ''}`).join(' · ')}</TableCell></TableRow>)}</TableBody>
        </Table></CardContent></Card>
      <Card><CardHeader><div><CardTitle>Set-offs</CardTitle><CardDescription>Selected period first: {period.period_code}.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Period</TableHead><TableHead>Status</TableHead><TableHead>Voucher</TableHead><TableHead>Lines</TableHead></TableRow></TableHeader>
          <TableBody>{[...x.set_offs].sort((a, b) => Number(b.period_id === period.id) - Number(a.period_id === period.id)).map((s) => <TableRow key={String(s.id)}>
            <TableCell>{String(s.period_code)}</TableCell><TableCell>{String(s.status).toLowerCase()}</TableCell><TableCell>{String(s.voucher_number ?? '—')}</TableCell>
            <TableCell className="text-xs">{(s.lines as Record<string, unknown>[]).map((l) => `${String(l.liability_kind).toLowerCase()} ${String(l.liability_head)} ← ${String(l.source).toLowerCase()} ${String(l.source_head)} ${formatAmount(l.amount as Amount)}`).join(' · ')}</TableCell></TableRow>)}</TableBody>
        </Table></CardContent></Card>
    </>
  )
}

function Reconciliation({ period }: { period: GstPeriod }) {
  const data = useAsync(() => fetchGstReconciliation(period.id), [period.id])
  if (data.loading && !data.data) return <LoadingState />
  if (data.error) return <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
  const x = data.data!
  const cols: [string, string][] = [['output_documents', 'Output per documents'], ['output_ledger', 'Output per ledger'], ['output_difference', 'Difference'], ['itc_documents', 'ITC per decisions'],
    ['itc_ledger', 'ITC per ledger'], ['itc_difference', 'Difference'], ['rcm_documents', 'RCM'], ['set_off_credit', 'Set-off by credit'], ['set_off_cash', 'Set-off in cash'], ['open_liability', 'Open liability']]
  const sheets: Sheet[] = [{ name: 'Tax heads', rows: [['Head', ...cols.map(([, h]) => h)], ...x.tax_heads.map((t) => [String(t.head), ...cols.map(([k]) => Number(t[k] ?? 0))])] },
    { name: 'Unexplained vouchers', rows: [['Voucher', 'Date', 'Source', 'Account', 'Debit', 'Credit', 'Narration'], ...x.unexplained_vouchers.map((v) => [String(v.voucher_number), String(v.date),
      String(v.source_type ?? v.source), String(v.account), Number(v.debit), Number(v.credit), (v.narration as string) ?? null])] }]
  return (
    <>
      <div className="mb-2 flex justify-end gap-2"><ExportMenu sheets={sheets} fileStem={`gst-reconciliation-${period.period_code}`} /><PrintButton /></div>
      <Card className="mb-4"><CardHeader><div><CardTitle>Tax-head summary and ledger reconciliation · {period.period_code}</CardTitle><CardDescription>{String(x.note)}</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Head</TableHead>{cols.map(([k, h]) => <TableHead key={k} className="text-right">{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>{x.tax_heads.map((t) => <TableRow key={String(t.head)} data-head={String(t.head)}><TableCell>{String(t.head)}</TableCell>{cols.map(([k]) => (
            <TableCell key={k} className={`text-right tabular-nums ${k.endsWith('difference') && Number(t[k]) !== 0 ? 'text-red-700' : ''}`}>{amt(t[k])}</TableCell>))}</TableRow>)}</TableBody>
        </Table></CardContent></Card>
      <Card><CardHeader><div><CardTitle>Vouchers on GST ledgers without a GST document</CardTitle><CardDescription>Manual journals and other postings that explain differences.</CardDescription></div></CardHeader>
        <CardContent className="overflow-x-auto p-0"><Table><TableHeader><TableRow><TableHead>Voucher</TableHead><TableHead>Date</TableHead><TableHead>Source</TableHead><TableHead>Account</TableHead>
          <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead></TableRow></TableHeader>
          <TableBody>{x.unexplained_vouchers.length === 0 ? <TableRow><TableCell colSpan={6} className="text-muted-foreground">None.</TableCell></TableRow> : x.unexplained_vouchers.map((v, i) => (
            <TableRow key={i}><TableCell>{String(v.voucher_number)}</TableCell><TableCell>{formatDate(String(v.date))}</TableCell><TableCell>{String(v.source_type ?? v.source).replace(/_/g, ' ').toLowerCase()}</TableCell>
              <TableCell>{String(v.account)}</TableCell><TableCell className="text-right tabular-nums">{amt(v.debit)}</TableCell><TableCell className="text-right tabular-nums">{amt(v.credit)}</TableCell></TableRow>))}</TableBody>
        </Table></CardContent></Card>
    </>
  )
}

function Exceptions({ period }: { period: GstPeriod }) {
  const data = useAsync(() => fetchGstExceptions(period.id), [period.id])
  const rows = (data.data?.rows ?? []).map((r, i) => ({ ...r, _row: i }))
  const columns: DataTableColumn<ReturnException & { _row: number }>[] = [
    { id: 'severity', header: 'Severity', cell: (r) => <StatusBadge label={r.severity === 'ERROR' ? 'Error' : 'Warning'} tone={r.severity === 'ERROR' ? 'danger' : 'warning'} />, sortValue: (r) => r.severity },
    { id: 'code', header: 'Exception', cell: (r) => r.code.replace(/_/g, ' ').toLowerCase(), searchValue: (r) => r.code, sortValue: (r) => r.code },
    { id: 'doc', header: 'Document', cell: (r) => `${r.document_no ?? '—'} · ${r.source_kind.replace(/_/g, ' ').toLowerCase()}`, searchValue: (r) => r.document_no ?? '' },
    { id: 'date', header: 'Date', cell: (r) => (r.document_date ? formatDate(r.document_date) : '—') },
    { id: 'message', header: 'Details', cell: (r) => r.message },
  ]
  return (
    <>
      <div className="mb-2 flex justify-end gap-2"><ExportMenu sheets={[{ name: 'Exceptions', rows: exceptionRows(data.data?.rows ?? []) }]} fileStem={`gst-exceptions-${period.period_code}`} /><PrintButton /></div>
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r._row)} loading={data.loading} pageSize={100} error={data.error ? new Error(describeDataError(data.error)) : null}
        onRetry={data.reload} title={`${rows.length} exception(s) · ${period.period_code}`} emptyState={{ icon: FileText, title: 'No exceptions', description: 'Nothing to review for this period.' }} />
    </>
  )
}
