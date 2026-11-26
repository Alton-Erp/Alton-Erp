import { Download, Printer } from 'lucide-react'
import { useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatAmount, type Amount } from '@/features/accounting/accounting-model'
import { downloadGstCsv, downloadGstWorkbook } from '@/features/accounting/gst-export'
import {
  REPORTS, controlState, headerLines, isNegative, lifecycleSteps, reportTables, type Column, type Control, type ControlReport, type Lifecycle, type ReportKey, type ReportTable, type WorkingDoc,
} from '@/features/accounting/gst-reports-model'
import type { GstPeriod } from '@/features/accounting/gst-returns-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { fetchGstControlReport, fetchGstReadiness, transitionGstPeriod } from '@/services/accounting'

/** Print layout: A4 landscape with page numbers; screen-only controls carry print:hidden. Mounted only while a GST view is shown. */
export function GstPrintStyles() {
  return <style>{`@media print { @page { size: A4 landscape; margin: 12mm 10mm 16mm;
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 9px; }
    @bottom-left { content: "Alton ERP working document — not proof of filing with the GST Portal"; font-size: 9px; } }
    [data-print-table] { break-inside: auto; font-size: 9px; } [data-print-table] tr { break-inside: avoid; }
    .print-area .overflow-x-auto { overflow: visible !important; } }`}</style>
}

export function PrintHeader({ doc }: { doc: WorkingDoc }) {
  const lines = headerLines(doc)
  return (
    <div data-testid="gst-print-header" className="mb-3 hidden border-b pb-2 text-xs print:block">
      <p className="text-base font-semibold">{lines[0]}</p>
      {lines.slice(1, -1).map((l, i) => <p key={i}>{l}</p>)}
      <p className="mt-1 font-semibold">{lines.at(-1)}</p>
    </div>
  )
}

const cell = (v: unknown, c: Column) => {
  if (v === null || v === undefined || v === '') return '—'
  if (c.kind === 'amount') return <span className={`tabular-nums ${isNegative(v) ? 'text-red-700' : ''}`}>{formatAmount(v as Amount)}</span>
  if (c.kind === 'date') return /T/.test(String(v)) ? formatDateTime(String(v)) : formatDate(String(v))
  if (c.kind === 'bool') return v === true ? 'Yes' : v === false ? 'No' : String(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v).replace(/_/g, ' ')
}

export function ReportTableView({ table }: { table: ReportTable }) {
  return (
    <Card className="mb-4"><CardHeader><div><CardTitle className="text-base">{table.title}</CardTitle></div></CardHeader>
      <CardContent className="overflow-x-auto p-0"><Table data-print-table data-table-title={table.title}>
        <TableHeader><TableRow>{table.columns.map((c) => <TableHead key={c.key} className={c.kind === 'amount' || c.kind === 'number' ? 'text-right' : ''}>{c.label}</TableHead>)}</TableRow></TableHeader>
        <TableBody>{table.rows.length === 0 ? <TableRow><TableCell colSpan={table.columns.length} className="text-muted-foreground">None.</TableCell></TableRow>
          : table.rows.map((r, i) => <TableRow key={i}>{table.columns.map((c) => <TableCell key={c.key} className={c.kind === 'amount' || c.kind === 'number' ? 'text-right' : ''}>{cell(r[c.key], c)}</TableCell>)}</TableRow>)}</TableBody>
      </Table></CardContent></Card>
  )
}

export function ExportButtons({ doc, fileStem }: { doc: WorkingDoc; fileStem: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-wrap gap-2 print:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="outline" disabled={busy || doc.tables.length === 0}><Download /> Export</Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => { setBusy(true); void downloadGstWorkbook(doc, fileStem).finally(() => setBusy(false)) }}>Excel (.xlsx, one sheet per table)</DropdownMenuItem>
          {doc.tables.map((tb, i) => <DropdownMenuItem key={tb.title} onSelect={() => downloadGstCsv(doc, `${fileStem}-${tb.title}`, i)}>CSV — {tb.title}</DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" onClick={() => window.print()}><Printer /> Print</Button>
    </div>
  )
}

const STEP_TONE = { done: 'success', current: 'info', todo: 'neutral' } as const

function ControlTable({ title, rows }: { title: string; rows: Control[] }) {
  return (
    <Card className="mb-4"><CardHeader><div><CardTitle className="text-base">{title}</CardTitle></div></CardHeader>
      <CardContent className="overflow-x-auto p-0"><Table data-print-table><TableHeader><TableRow><TableHead>Control</TableHead><TableHead>Result</TableHead><TableHead className="text-right">Count</TableHead>
        <TableHead>Details</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((c) => (
          <TableRow key={c.code} data-control={c.code} data-state={controlState(c)}>
            <TableCell>{c.code.replace(/_/g, ' ').toLowerCase()}</TableCell>
            <TableCell><StatusBadge label={controlState(c)} tone={c.passed ? 'success' : c.severity === 'BLOCKER' ? 'danger' : 'warning'} /></TableCell>
            <TableCell className="text-right tabular-nums">{c.count}</TableCell><TableCell className="text-sm">{c.message}</TableCell>
          </TableRow>))}</TableBody></Table></CardContent></Card>
  )
}

export function PeriodClosePanel({ period, onChanged }: { period: GstPeriod; onChanged: (m: string) => void }) {
  const { has } = usePermissions()
  const rd = useAsync(() => fetchGstReadiness(period.id), [period.id, period.status, period.row_version])
  const [action, setAction] = useState<ActionRequest | null>(null)
  if (rd.loading && !rd.data) return <LoadingState />
  if (rd.error) return <ErrorState message={describeDataError(rd.error)} onRetry={rd.reload} />
  const r = rd.data!
  const lc = r.lifecycle as Lifecycle
  const blockers = r.controls.filter((c) => c.severity === 'BLOCKER')
  const warnings = r.controls.filter((c) => c.severity === 'WARNING')
  const done = (m: string) => { setAction(null); onChanged(m); rd.reload() }
  return (
    <div data-testid="gst-period-close">
      <Card className="mb-4"><CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2" data-testid="gst-lifecycle">{lifecycleSteps(lc).map((s) => (
          <span key={s.key} data-step={s.key} data-state={s.state}><StatusBadge label={s.label} tone={STEP_TONE[s.state]} /></span>))}
          {lc.reopened_count > 0 && <StatusBadge label={`Reopened ${lc.reopened_count}×`} tone="warning" />}</div>
        <p className="text-sm">{r.note}</p>
        <p className="text-sm"><strong>{r.blockers_failed}</strong> blocker(s) failing · <strong>{r.warnings_open}</strong> open warning(s){lc.filed.length > 0
          ? ` · filed (recorded): ${lc.filed.map((f) => `${f.return_type} ARN ${f.arn}`).join(', ')}` : ''}</p>
        <div className="flex flex-wrap gap-2 print:hidden">
          {period.status === 'APPROVED' && has('gst_periods.close') && <Button disabled={!r.can_close} onClick={() => setAction({ title: `Close ${period.period_code}`, confirmLabel: 'Close period',
            note: r.warnings_open > 0 ? 'required' : 'optional', minLength: 10, noteLabel: r.warnings_open > 0 ? 'Acknowledge the open warnings (why closing is acceptable)' : 'Note',
            description: <>All blockers have passed. {r.warnings_open > 0 ? `${r.warnings_open} warning(s) remain open and will be recorded with your acknowledgement.` : 'No open warnings.'} Not by the preparer.
              The approved snapshot is kept unchanged.</>,
            run: async (n) => { const p = await transitionGstPeriod(period.id, 'CLOSE', n); return `${p.period_code} closed.` } })}>Close period</Button>}
          {['APPROVED', 'CLOSED'].includes(period.status) && has('gst_periods.reopen') && lc.filed.length === 0 && <Button variant="outline" className="text-shortage" onClick={() => setAction({
            title: `Reopen ${period.period_code}`, confirmLabel: 'Reopen', note: 'required', minLength: 10, destructive: true,
            description: 'Super Admin only. The approved snapshot stays as it is; approving again adds a new version. A filed return is never reopened here.',
            run: async (n) => { const p = await transitionGstPeriod(period.id, 'REOPEN', n); return `${p.period_code} reopened.` } })}>Reopen period</Button>}
        </div>
      </CardContent></Card>
      <ControlTable title="Mandatory close controls (blockers)" rows={blockers} />
      <ControlTable title="Warnings (never treated as passed)" rows={warnings} />
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </div>
  )
}

export function ControlReportsPanel({ period }: { period: GstPeriod }) {
  const { has } = usePermissions()
  const [key, setKey] = useState<ReportKey>('TAX_LIABILITY')
  const [mode, setMode] = useState<'period' | 'range'>('period')
  const [from, setFrom] = useState(period.period_start)
  const [to, setTo] = useState(period.period_end)
  const meta = REPORTS.find((x) => x.key === key)!
  const filters = mode === 'period' || meta.periodOnly ? { period_id: period.id } : { from, to }
  const data = useAsync(() => fetchGstControlReport(key, filters), [key, mode, period.id, from, to])
  const report = data.data as ControlReport | null
  const doc: WorkingDoc | null = report ? { title: `${meta.no}. ${meta.label}`, header: report, tables: reportTables(report) } : null
  return (
    <>
      <Card className="mb-4 print:hidden"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-96 space-y-1"><Label htmlFor="gstc-report">Report</Label>
          <Select value={key} onValueChange={(v) => setKey(v as ReportKey)}><SelectTrigger id="gstc-report"><SelectValue /></SelectTrigger>
            <SelectContent>{REPORTS.map((x) => <SelectItem key={x.key} value={x.key} disabled={x.paymentPermission && !has('gst_payments.create') && !has('gst_payments.post')}>
              {x.no}. {x.label}</SelectItem>)}</SelectContent></Select></div>
        {!meta.periodOnly && <div className="w-48 space-y-1"><Label htmlFor="gstc-mode">Filter</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as 'period' | 'range')}><SelectTrigger id="gstc-mode"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="period">Return period {period.period_code}</SelectItem><SelectItem value="range">Date range</SelectItem></SelectContent></Select></div>}
        {mode === 'range' && !meta.periodOnly && <>
          <div className="space-y-1"><Label htmlFor="gstc-from">From</Label><Input id="gstc-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="gstc-to">To</Label><Input id="gstc-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div></>}
        {doc && <div className="ml-auto"><ExportButtons doc={doc} fileStem={`GST-${meta.no}-${meta.key}-${report!.period_code}`} /></div>}
      </CardContent></Card>
      <p className="mb-2 text-sm text-muted-foreground print:hidden">Sources: {meta.sources}</p>
      {data.loading && !data.data ? <LoadingState /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} /> : doc && (
        <div data-testid="gst-control-report" data-report={key}>
          <PrintHeader doc={doc} />
          <Card className="mb-4 print:hidden"><CardContent className="p-4 text-sm">
            <p><strong>{doc.title}</strong> · {report!.company?.legal_name} · GSTIN {report!.gstin} · FY {report!.financial_year} · {report!.period_code}</p>
            <p>Values: <StatusBadge label={report!.value_status.toLowerCase()} tone={report!.value_status === 'FILED' ? 'success' : report!.value_status === 'APPROVED' ? 'info' : 'neutral'} />
              {report!.snapshot ? ` · snapshot v${report!.snapshot.version_no} (${report!.snapshot.snapshot_hash.slice(0, 16)}…)` : ' · live data'} · configuration v{report!.config_version_no ?? '—'}
              · generated {formatDateTime(report!.generated_at)}</p>
            <p className="mt-1 font-medium">{report!.disclaimer}</p>
            {typeof report!.note === 'string' && <p className="mt-1 text-muted-foreground">{report!.note}</p>}
          </CardContent></Card>
          {doc.tables.map((tb) => <ReportTableView key={tb.title} table={tb} />)}
        </div>)}
    </>
  )
}
