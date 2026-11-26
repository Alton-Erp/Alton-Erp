import { Download, FileSpreadsheet, RefreshCw, Upload, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { formatAmount } from '@/features/accounting/accounting-model'
import { AccountingNotice, Field } from '@/features/accounting/accounting-ui'
import {
  IMPORT_STATUS_LABELS, MATCH_STATUS_LABELS, OUTCOME_LABELS, REPORT_LABELS, defaultReturnPeriod, needsApprovalNote, outcomeTone, shortSha, validateGstr2bFile,
  type Gstr2bDocument, type Gstr2bImport, type Gstr2bLine, type Gstr2bMatch, type Gstr2bOutcome, type Gstr2bReportKey, type Gstr2bReportRow,
} from '@/features/accounting/gstr2b-model'
import { ActionDialog, type ActionRequest } from '@/features/production/action-dialog'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import {
  autoMatchGstr2b, commitGstr2bImport, decideGstr2bMatch, discardGstr2bImport, fetchGstr2bDocument, fetchGstr2bImport, fetchGstr2bImports, fetchGstr2bReport,
  matchGstr2bManually, reverseGstr2bMatch,
} from '@/services/accounting'
import { gstr2bFileUrl, uploadGstr2bFile, verifyGstr2bImport } from '@/services/gstr2b-files'

type Tab = 'imports' | 'matching' | 'reports'
const TABS: { key: Tab; label: string }[] = [{ key: 'imports', label: 'Imports' }, { key: 'matching', label: 'Matching' }, { key: 'reports', label: 'Exceptions & reports' }]
const importTone = (s: Gstr2bImport['status']) => (s === 'COMMITTED' ? 'success' : s === 'VERIFIED' ? 'info' : s === 'REJECTED' ? 'danger' : s === 'UPLOADED' ? 'warning' : 'neutral')
const tax = (r: { igst?: unknown; cgst?: unknown; sgst?: unknown; cess?: unknown }) =>
  formatAmount((Math.round(Number(r.igst ?? 0) * 100) + Math.round(Number(r.cgst ?? 0) * 100) + Math.round(Number(r.sgst ?? 0) * 100) + Math.round(Number(r.cess ?? 0) * 100)) / 100)
const OutcomeBadge = ({ outcome }: { outcome: Gstr2bOutcome | null | undefined }) =>
  outcome ? <StatusBadge label={OUTCOME_LABELS[outcome]} tone={outcomeTone(outcome)} /> : <span className="text-muted-foreground">—</span>

export default function Gstr2bPage() {
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') ?? 'imports') as Tab
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const [message, setMessage] = useState<string | null>(null)
  return (
    <>
      <PageHeader title="GSTR-2B Matching" breadcrumbs={[{ label: 'Accounts' }, { label: 'GST' }, { label: 'GSTR-2B Matching' }]}
        description="Reconcile the GSTR-2B statement downloaded from the GST portal with the supplier invoices in the books." />
      <AccountingNotice>Upload the GSTR-2B Excel or CSV file you downloaded from the GST portal (there is no direct portal connection). The original file is kept unchanged and
        its checksum is verified on the server. Importing and matching never post vouchers and never approve ITC: each ITC decision is still proposed and approved by two people.</AccountingNotice>
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">{TABS.map((t) => (
        <Button key={t.key} role="tab" aria-selected={tab === t.key} variant={tab === t.key ? 'default' : 'outline'} onClick={() => set('tab', t.key)}>{t.label}</Button>))}</div>
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      {tab === 'imports' && <ImportsTab selected={params.get('import')} onSelect={(id) => set('import', id)} onMessage={setMessage} />}
      {tab === 'matching' && <MatchingTab selected={params.get('document')} onSelect={(id) => set('document', id)} onMessage={setMessage} />}
      {tab === 'reports' && <ReportsTab report={(params.get('report') ?? 'SUMMARY') as Gstr2bReportKey} onReport={(r) => set('report', r)} />}
    </>
  )
}

function ImportsTab({ selected, onSelect, onMessage }: { selected: string | null; onSelect: (id: string | null) => void; onMessage: (m: string) => void }) {
  const { has } = usePermissions()
  const canManage = has('gst_reconciliation.manage')
  const list = useAsync(() => fetchGstr2bImports(), [])
  const [period, setPeriod] = useState(() => defaultReturnPeriod(new Date().toISOString().slice(0, 10)))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const upload = async () => {
    if (!file) return
    const problem = validateGstr2bFile(file, period)
    if (problem) { setError(problem); return }
    setBusy(true); setError(null)
    try {
      const r = await uploadGstr2bFile(file, period)
      onMessage(r.status === 'VERIFIED' ? `${r.file_name}: checksum verified on the server, ${r.total_rows} row(s) read. Review the preview, then import.`
        : `${r.file_name} was rejected: ${r.rejection_reason ?? 'see the import'}`)
      setFile(null); list.reload(); onSelect(r.id)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const columns: DataTableColumn<Gstr2bImport>[] = [
    { id: 'created', header: 'Uploaded', cell: (r) => <>{formatDateTime(r.created_at)}<span className="block text-xs text-muted-foreground">{r.uploaded_by_name ?? '—'}</span></>, sortValue: (r) => r.created_at },
    { id: 'period', header: 'Period', cell: (r) => r.return_period, sortValue: (r) => r.return_period, searchValue: (r) => r.return_period },
    { id: 'file', header: 'File', cell: (r) => r.file_name, searchValue: (r) => r.file_name },
    { id: 'status', header: 'Status', cell: (r) => <StatusBadge label={IMPORT_STATUS_LABELS[r.status]} tone={importTone(r.status)} /> },
    { id: 'rows', header: 'Rows (valid / errors / duplicates)', align: 'right', cell: (r) => `${r.total_rows} (${r.valid_rows} / ${r.error_rows} / ${r.duplicate_rows})` },
    { id: 'sha', header: 'SHA-256', cell: (r) => <span className="font-mono text-xs" title={r.declared_sha256}>{shortSha(r.declared_sha256)}</span> },
  ]
  return (
    <>
      {canManage && <Card className="mb-4"><CardHeader><div><CardTitle>Upload a GSTR-2B file</CardTitle>
        <CardDescription>CSV or Excel (.xlsx), up to 10 MB. Sheets B2B, B2BA, B2B-CDNR and B2B-CDNRA are read; other sheets are listed as skipped.</CardDescription></div></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="g2b-period">Return period</Label><Input id="g2b-period" type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="g2b-file">File</Label>
            <Input id="g2b-file" type="file" accept=".csv,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null) }} /></div>
          <Button disabled={busy || !file} onClick={upload}><Upload /> {busy ? 'Uploading and verifying…' : 'Upload and verify'}</Button>
          {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
        </CardContent></Card>}
      <DataTable columns={columns} data={list.data ?? []} getRowId={(r) => r.id} loading={list.loading} onRowClick={(r) => onSelect(r.id)}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload} title="Imports"
        emptyState={{ icon: FileSpreadsheet, title: 'No GSTR-2B files yet', description: 'Upload the file downloaded from the GST portal.' }} />
      {selected && <ImportPreview id={selected} canManage={canManage} onChanged={(m) => { onMessage(m); list.reload() }} />}
    </>
  )
}

function ImportPreview({ id, canManage, onChanged }: { id: string; canManage: boolean; onChanged: (m: string) => void }) {
  const [rowStatus, setRowStatus] = useState('ALL')
  const imp = useAsync(() => fetchGstr2bImport(id, { row_status: rowStatus === 'ALL' ? null : rowStatus, limit: 500 }), [id, rowStatus])
  const [acceptErrors, setAcceptErrors] = useState(false)
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (imp.loading && !imp.data) return <LoadingState />
  if (imp.error) return <ErrorState message={describeDataError(imp.error)} onRetry={imp.reload} />
  const x = imp.data!
  const done = (m: string) => { setAction(null); onChanged(m); imp.reload() }
  const download = async () => {
    setError(null)
    try { const { url } = await gstr2bFileUrl(x.id); window.open(url, '_blank', 'noopener') } catch (e) { setError(describeDataError(e)) }
  }
  const lineCols: DataTableColumn<Gstr2bLine>[] = [
    { id: 'row', header: 'Row', align: 'right', cell: (l) => <>{l.source_row ?? l.line_no}<span className="block text-xs text-muted-foreground">{l.sheet_name}</span></> },
    { id: 'status', header: 'Status', cell: (l) => <StatusBadge label={l.row_status === 'VALID' ? (l.commit_outcome ?? 'Valid').replace(/_/g, ' ') : l.row_status === 'ERROR' ? 'Error' : 'Duplicate in file'}
      tone={l.row_status === 'VALID' ? 'success' : l.row_status === 'ERROR' ? 'danger' : 'warning'} /> },
    { id: 'doc', header: 'Document', searchValue: (l) => `${l.supplier_gstin ?? ''} ${l.doc_number ?? ''}`, cell: (l) => <>{l.doc_number ?? '—'} · {l.doc_type.replace('_', ' ').toLowerCase()}
      {l.is_amendment && <span className="text-xs"> (amends {l.original_doc_number})</span>}<span className="block text-xs text-muted-foreground">{l.supplier_gstin} {l.supplier_name ?? ''}</span></> },
    { id: 'date', header: 'Date', cell: (l) => (l.doc_date ? formatDate(l.doc_date) : '—') },
    { id: 'taxable', header: 'Taxable', align: 'right', cell: (l) => (l.taxable_value === null ? '—' : formatAmount(l.taxable_value)) },
    { id: 'tax', header: 'Tax', align: 'right', cell: (l) => tax(l) },
    { id: 'issues', header: 'Errors / original row', cell: (l) => <>{l.errors.length > 0 && <ul className="text-xs text-red-700">{l.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Original cells</summary>
        <dl className="grid grid-cols-2 gap-x-2">{Object.entries(l.original_row).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd>{v || '—'}</dd></div>)}</dl>
      </details></> },
  ]
  return (
    <Card className="mt-4">
      <CardHeader><div><CardTitle>{x.file_name} · {x.return_period}</CardTitle>
        <CardDescription><StatusBadge label={IMPORT_STATUS_LABELS[x.status]} tone={importTone(x.status)} /> {x.rejection_reason ?? x.status_reason ?? ''}</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Field label="Declared SHA-256"><span className="font-mono text-xs break-all">{x.declared_sha256}</span></Field>
          <Field label="Server SHA-256"><span className="font-mono text-xs break-all">{x.computed_sha256 ?? 'not verified yet'}</span></Field>
          <Field label="Size">{x.file_size.toLocaleString('en-IN')} bytes</Field>
          <Field label="Rows">{x.total_rows} · {x.valid_rows} valid · {x.error_rows} errors · {x.duplicate_rows} duplicates</Field>
          {x.status === 'VERIFIED' && <Field label="Import would add">{x.preview.new_documents} new · {x.preview.amendments} amendments · {x.preview.changed} changed · {x.preview.already_imported} already imported
            · {x.preview.credit_debit_notes} credit / debit notes</Field>}
          {x.status === 'COMMITTED' && <Field label="Imported">{Object.entries(x.commit_summary).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k.replace(/_/g, ' ').toLowerCase()} ${v}`).join(' · ')}</Field>}
          {(x.parser.skipped ?? []).length > 0 && <Field label="Skipped sheets">{(x.parser.skipped ?? []).join(', ')}</Field>}
        </dl>
        <div className="flex flex-wrap items-end gap-2">
          {canManage && x.status === 'UPLOADED' && <Button variant="outline" onClick={async () => {
            setError(null)
            try { const r = await verifyGstr2bImport(x.id); done(r.status === 'VERIFIED' ? 'Checksum verified on the server.' : `Rejected: ${r.rejection_reason}`) } catch (e) { setError(describeDataError(e)) }
          }}><RefreshCw /> Verify on the server</Button>}
          {canManage && x.status === 'VERIFIED' && <>
            {x.error_rows > 0 && <label className="flex items-center gap-2 text-sm"><Checkbox checked={acceptErrors} onCheckedChange={(c) => setAcceptErrors(c === true)} />
              Import only the valid rows ({x.error_rows} row(s) with errors are skipped)</label>}
            <Button data-testid="g2b-commit" disabled={x.error_rows > 0 && !acceptErrors} onClick={() => setAction({ title: `Import ${x.file_name}`, confirmLabel: 'Import valid rows', note: 'none',
              description: 'Valid rows become GSTR-2B supplier documents (new, amendment or changed version). No voucher is posted and no ITC is decided.',
              run: async () => { const r = await commitGstr2bImport(x.id, acceptErrors, x.row_version); return `Imported: ${r.commit_summary.NEW ?? 0} new, ${r.commit_summary.AMENDMENT ?? 0} amendments, ${r.commit_summary.CHANGED ?? 0} changed.` } })}>Import</Button>
          </>}
          {canManage && ['PENDING_UPLOAD', 'UPLOADED', 'VERIFIED', 'REJECTED'].includes(x.status) && <Button variant="outline" className="text-shortage" onClick={() => setAction({
            title: 'Discard this import', confirmLabel: 'Discard', note: 'required', minLength: 5, destructive: true,
            description: 'The import is marked discarded; the original file stays stored as evidence and its rows are kept.', run: async (n) => { await discardGstr2bImport(x.id, n!); return 'Import discarded.' } })}>Discard</Button>}
          {!['PENDING_UPLOAD', 'EXPIRED'].includes(x.status) && <Button variant="outline" onClick={download}><Download /> Original file</Button>}
          {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
        </div>
        {x.total_rows > 0 && <>
          <div className="w-56 space-y-1"><Label htmlFor="g2b-rowstatus">Rows</Label>
            <Select value={rowStatus} onValueChange={setRowStatus}><SelectTrigger id="g2b-rowstatus"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="ALL">All rows</SelectItem><SelectItem value="VALID">Valid</SelectItem><SelectItem value="ERROR">With errors</SelectItem>
                <SelectItem value="DUPLICATE_IN_FILE">Duplicates in the file</SelectItem></SelectContent></Select></div>
          <DataTable columns={lineCols} data={x.lines} getRowId={(l) => l.id} pageSize={50} title={`${x.line_count} row(s)`}
            emptyState={{ icon: FileSpreadsheet, title: 'No rows', description: 'No rows for this filter.' }} />
        </>}
      </CardContent>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </Card>
  )
}

function MatchingTab({ selected, onSelect, onMessage }: { selected: string | null; onSelect: (id: string | null) => void; onMessage: (m: string) => void }) {
  const { has } = usePermissions()
  const [status, setStatus] = useState('ALL')
  const docs = useAsync(() => fetchGstr2bReport('DOCUMENTS', { match_status: status === 'ALL' ? null : status }), [status])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rows = (docs.data?.rows ?? []) as Gstr2bReportRow[]
  const columns: DataTableColumn<Gstr2bReportRow>[] = [
    { id: 'doc', header: 'Document', searchValue: (r) => `${r.doc_number} ${r.supplier_gstin} ${r.invoice_number ?? ''}`,
      cell: (r) => <>{String(r.doc_number)} · {String(r.doc_type).replace('_', ' ').toLowerCase()}<span className="block text-xs text-muted-foreground">{String(r.supplier_gstin)}</span></> },
    { id: 'date', header: 'Date', cell: (r) => formatDate(String(r.doc_date)), sortValue: (r) => String(r.doc_date) },
    { id: 'period', header: 'GSTR-2B', cell: (r) => `${String(r.return_period)} · v${String(r.version_no)}` },
    { id: 'taxable', header: 'Taxable', align: 'right', cell: (r) => formatAmount(r.taxable_value as number) },
    { id: 'tax', header: 'Tax', align: 'right', cell: (r) => tax(r) },
    { id: 'match', header: 'Match', cell: (r) => r.match_status ? <><StatusBadge label={MATCH_STATUS_LABELS[r.match_status as Gstr2bMatch['status']]} tone={r.match_status === 'APPROVED' ? 'success' : 'warning'} />
      <span className="block text-xs">{String(r.invoice_number ?? '')}</span></> : <StatusBadge label={r.doc_type === 'INVOICE' ? 'Missing in books' : 'Credit / debit note'} tone="danger" /> },
    { id: 'outcome', header: 'Outcome', cell: (r) => <><OutcomeBadge outcome={r.outcome as Gstr2bOutcome | null} />{r.needs_review === true && <span className="block text-xs text-amber-800">Document changed — review</span>}</> },
  ]
  return (
    <>
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-64 space-y-1"><Label htmlFor="g2b-mstatus">Show</Label>
          <Select value={status} onValueChange={setStatus}><SelectTrigger id="g2b-mstatus"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">All documents</SelectItem><SelectItem value="UNMATCHED">Not matched</SelectItem><SelectItem value="PROPOSED">Awaiting approval</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem></SelectContent></Select></div>
        {has('gst_reconciliation.manage') && <Button disabled={busy} onClick={async () => {
          setBusy(true); setError(null)
          try { const r = await autoMatchGstr2b(); onMessage(`Auto-match proposed ${r.proposed} match(es); ${r.no_candidate} without a book entry, ${r.ambiguous} ambiguous. Each proposal needs approval by another user.`); docs.reload() }
          catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
        }}><Wand2 /> Propose matches</Button>}
        {error && <p role="alert" className="w-full text-sm text-red-700">{error}</p>}
      </CardContent></Card>
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r.document_id)} loading={docs.loading} onRowClick={(r) => onSelect(String(r.document_id))} pageSize={50}
        error={docs.error ? new Error(describeDataError(docs.error)) : null} onRetry={docs.reload} title={`${rows.length} document(s)`}
        emptyState={{ icon: FileSpreadsheet, title: 'No GSTR-2B documents', description: 'Import a GSTR-2B file first.' }} />
      {selected && <DocumentPanel id={selected} onChanged={(m) => { onMessage(m); docs.reload() }} />}
    </>
  )
}

function DocumentPanel({ id, onChanged }: { id: string; onChanged: (m: string) => void }) {
  const { has } = usePermissions()
  const doc = useAsync(() => fetchGstr2bDocument(id), [id])
  const [action, setAction] = useState<ActionRequest | null>(null)
  const [invoice, setInvoice] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (doc.loading && !doc.data) return <LoadingState />
  if (doc.error) return <ErrorState message={describeDataError(doc.error)} onRetry={doc.reload} />
  const d: Gstr2bDocument = doc.data!
  const done = (m: string) => { setAction(null); onChanged(m); doc.reload() }
  const active = d.matches.find((m) => m.status === 'PROPOSED' || m.status === 'APPROVED')
  return (
    <Card className="mt-4">
      <CardHeader><div><CardTitle>{d.doc_number} · {d.supplier_gstin}</CardTitle>
        <CardDescription>{d.doc_type.replace('_', ' ').toLowerCase()} · FY {d.doc_fy} · {d.version_count} version(s){d.needs_review ? ` · ${d.review_reason}` : ''}</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        <div><h3 className="mb-1 text-sm font-medium">Versions</h3><ul className="space-y-1 text-sm">{d.versions.map((v) => (
          <li key={v.id}>v{v.version_no} · {v.version_kind.toLowerCase()} · GSTR-2B {v.return_period} ({v.file_name}, row {v.source_row ?? '—'}) · {formatDate(v.doc_date)} ·
            taxable {formatAmount(v.taxable_value)} · tax {tax(v)}</li>))}</ul></div>
        <div><h3 className="mb-1 text-sm font-medium">Matches</h3>{d.matches.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : (
          <ul className="space-y-3">{d.matches.map((m) => (
            <li key={m.id} className="rounded-md border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2"><strong>{m.invoice_number}</strong> ({m.supplier_invoice_number}) · {m.method.toLowerCase()} · v{m.version_no}
                <StatusBadge label={MATCH_STATUS_LABELS[m.status]} tone={m.status === 'APPROVED' ? 'success' : m.status === 'PROPOSED' ? 'warning' : 'neutral'} /><OutcomeBadge outcome={m.outcome} /></div>
              <p className="text-xs text-muted-foreground" data-testid="g2b-tolerance">Tolerance applied: {formatAmount(m.tolerance)} per amount{m.config_version_no ? ` (configuration v${m.config_version_no})` : ' (default)'}
                {m.outcome !== 'EXACT' ? ' · not exact: approval needs a note' : ''}</p>
              {Object.keys(m.differences).length > 0 && <p className="text-xs text-muted-foreground">Differences: {Object.entries(m.differences).map(([k, v]) =>
                `${k.replace(/_/g, ' ')} GSTR-2B ${String(v.gstr2b)} / books ${String(v.books)}`).join(' · ')}</p>}
              {m.reason && <p className="text-xs">Reason: {m.reason}</p>}
              <ul className="mt-1 text-xs text-muted-foreground">{m.history.map((h, i) => <li key={i}>{formatDateTime(h.created_at)} · {h.action.replace(/_/g, ' ').toLowerCase()} · {h.by ?? '—'}{h.reason ? ` — ${h.reason}` : ''}</li>)}</ul>
              <div className="mt-2 flex flex-wrap gap-2">
                {m.status === 'PROPOSED' && has('gst_reconciliation.approve') && <>
                  <Button size="sm" onClick={() => setAction({ title: `Approve the match with ${m.invoice_number}`, confirmLabel: 'Approve match',
                    note: needsApprovalNote(m.outcome) ? 'required' : 'optional', minLength: 10, noteLabel: needsApprovalNote(m.outcome) ? 'Why the differences are acceptable' : 'Note',
                    description: 'Maker-checker: you cannot approve a match you proposed. Approval is evidence for the ITC review only; it does not approve ITC.',
                    run: async (n) => { await decideGstr2bMatch(m.id, 'APPROVE', n); return 'Match approved.' } })}>Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => setAction({ title: 'Reject the match', confirmLabel: 'Reject', note: 'required', minLength: 5, description: 'The document becomes unmatched again.',
                    run: async (n) => { await decideGstr2bMatch(m.id, 'REJECT', n); return 'Match rejected.' } })}>Reject</Button></>}
                {m.status === 'APPROVED' && has('gst_reconciliation.approve') && <Button size="sm" variant="outline" className="text-shortage" onClick={() => setAction({
                  title: 'Reverse the approved match', confirmLabel: 'Reverse match', note: 'required', minLength: 10, destructive: true,
                  description: 'The match is kept in the history as reversed; the document can then be matched again.', run: async (n) => { await reverseGstr2bMatch(m.id, n!); return 'Match reversed.' } })}>Reverse</Button>}
              </div>
            </li>))}</ul>)}</div>
        {!active && d.doc_type === 'INVOICE' && has('gst_reconciliation.manage') && (
          <div className="space-y-2 rounded-md border p-3"><h3 className="text-sm font-medium">Match manually</h3>
            {d.candidates.length === 0 ? <p className="text-sm text-muted-foreground">No unmatched posted invoice of this supplier GSTIN.</p> : (
              <div className="space-y-1"><Label htmlFor="g2b-cand">Supplier invoice</Label>
                <Select value={invoice} onValueChange={setInvoice}><SelectTrigger id="g2b-cand"><SelectValue placeholder="Select an invoice" /></SelectTrigger>
                  <SelectContent>{d.candidates.map((c) => <SelectItem key={c.id} value={c.id}>{c.invoice_number} · {c.supplier_invoice_number} · {formatDate(c.supplier_invoice_date)} · tax {tax(c)}</SelectItem>)}</SelectContent></Select></div>)}
            <div className="space-y-1"><Label htmlFor="g2b-reason">Reason (at least 10 characters)</Label><Textarea id="g2b-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <Button disabled={busy || !invoice || reason.trim().length < 10} onClick={async () => {
              setBusy(true); setError(null)
              try { const m = await matchGstr2bManually(d.id, invoice, reason.trim()); setInvoice(''); setReason(''); done(`Match proposed (${OUTCOME_LABELS[m.outcome]}); another user must approve it.`) }
              catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
            }}>Propose match</Button>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          </div>)}
        {d.doc_type !== 'INVOICE' && <p className="text-sm text-amber-800">Supplier credit / debit notes are not matched to invoices; review them and record an ITC reversal where needed.</p>}
      </CardContent>
      <ActionDialog request={action} onClose={() => setAction(null)} onDone={done} />
    </Card>
  )
}

const REPORT_COLUMNS: Partial<Record<Gstr2bReportKey, [string, string][]>> = {
  MISSING_IN_BOOKS: [['supplier_gstin', 'Supplier GSTIN'], ['doc_number', 'Document'], ['doc_date', 'Date'], ['return_period', 'GSTR-2B'], ['taxable_value', 'Taxable']],
  MISSING_IN_2B: [['invoice_number', 'Invoice'], ['supplier_invoice_number', 'Supplier invoice'], ['supplier_invoice_date', 'Date'], ['supplier_gstin', 'Supplier GSTIN'], ['taxable_value', 'Taxable'], ['gst_status', 'GST']],
  CREDIT_NOTES: [['supplier_gstin', 'Supplier GSTIN'], ['doc_type', 'Type'], ['doc_number', 'Note'], ['doc_date', 'Date'], ['return_period', 'GSTR-2B'], ['taxable_value', 'Taxable']],
  DUPLICATES: [['kind', 'Kind'], ['file_name', 'File'], ['return_period', 'GSTR-2B'], ['source_row', 'Row'], ['supplier_gstin', 'Supplier GSTIN'], ['doc_number', 'Document']],
  AMENDMENTS: [['supplier_gstin', 'Supplier GSTIN'], ['doc_number', 'Document'], ['version_count', 'Versions'], ['review_reason', 'Review'], ['match_status', 'Match']],
  MATCH_EXCEPTIONS: [['doc_number', 'Document'], ['invoice_number', 'Invoice'], ['exception', 'Exception'], ['status', 'Match status']],
  HISTORY: [['created_at', 'When'], ['action', 'Action'], ['by', 'By'], ['reason', 'Reason']],
  DOCUMENTS: [['supplier_gstin', 'Supplier GSTIN'], ['doc_number', 'Document'], ['doc_date', 'Date'], ['match_status', 'Match'], ['outcome', 'Outcome']],
}

function ReportsTab({ report, onReport }: { report: Gstr2bReportKey; onReport: (r: Gstr2bReportKey) => void }) {
  const data = useAsync(() => fetchGstr2bReport(report), [report])
  const cols = REPORT_COLUMNS[report] ?? []
  const rows = ((data.data?.rows ?? []) as Gstr2bReportRow[]).map((r, i) => ({ ...r, _row: i }))
  const columns: DataTableColumn<Gstr2bReportRow>[] = cols.map(([k, h]) => ({ id: k, header: h, searchValue: (r) => String(r[k] ?? ''), sortValue: (r) => String(r[k] ?? ''),
    align: k === 'taxable_value' ? 'right' : 'left',
    cell: (r) => (r[k] === null || r[k] === undefined || r[k] === '' ? '—' : k === 'taxable_value' ? formatAmount(r[k] as number) : String(r[k]).replace(/_/g, ' ')) }))
  return (
    <>
      <Card className="mb-4"><CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="w-80 space-y-1"><Label htmlFor="g2b-report">Report</Label>
          <Select value={report} onValueChange={(v) => onReport(v as Gstr2bReportKey)}><SelectTrigger id="g2b-report"><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(REPORT_LABELS) as Gstr2bReportKey[]).map((k) => <SelectItem key={k} value={k}>{REPORT_LABELS[k]}</SelectItem>)}</SelectContent></Select></div>
      </CardContent></Card>
      {report === 'SUMMARY' ? (data.loading ? <LoadingState /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} /> : (
        <Card><CardContent className="p-4"><dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {(['documents', 'invoices', 'approved', 'proposed', 'missing_in_books', 'credit_debit_notes', 'needs_review', 'imports'] as const).map((k) => (
            <Field key={k} label={k.replace(/_/g, ' ')}>{String(data.data?.[k] ?? 0)}</Field>))}
          <Field label="By outcome">{Object.entries((data.data?.by_outcome ?? {}) as Record<string, number>).map(([k, v]) => `${OUTCOME_LABELS[k as Gstr2bOutcome] ?? k} ${v}`).join(' · ') || '—'}</Field>
        </dl><p className="mt-3 text-sm text-muted-foreground">{String(data.data?.note ?? '')}</p></CardContent></Card>))
        : <DataTable columns={columns} data={rows} getRowId={(r) => String(r._row)} loading={data.loading} pageSize={100} error={data.error ? new Error(describeDataError(data.error)) : null}
          onRetry={data.reload} title={`${rows.length} row(s)`} emptyState={{ icon: FileSpreadsheet, title: 'Nothing to show', description: 'No rows for this report.' }} />}
    </>
  )
}
