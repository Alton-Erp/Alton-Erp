import { Download, FileUp } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  STATEMENT_FIELDS, guessMapping, mapStatementRows, mappingErrors, parseCsv, toBase64, type ColumnMapping, type DateOrder, type ImportResult, type StatementField,
} from '@/features/accounting/bank-cash-model'
import { MoneyAccountSelect } from '@/features/accounting/bank-cash-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime } from '@/lib/format'
import { downloadStatementFile, fetchBankLookups, fetchStatementImports, importBankStatement } from '@/services/accounting'

interface Loaded { name: string; mime: string; base64: string; rows: string[][]; headerRow: number }

/** Bank statement import: upload CSV / Excel, map the columns, preview (validation and duplicates by the database), import. Never creates vouchers. */
export default function BankStatementImportPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const lookups = useAsync(() => fetchBankLookups(), [])
  const account = params.get('account') ?? ''
  const [file, setFile] = useState<Loaded | null>(null)
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [order, setOrder] = useState<DateOrder>('DMY')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const history = useAsync(() => fetchStatementImports(account || null), [account, refresh])
  const mErr = mappingErrors(mapping)
  const header = file ? file.rows[file.headerRow] ?? [] : []

  const load = async (f: File) => {
    setError(null); setResult(null)
    if (f.size > 5 * 1024 * 1024) { setError('The statement file must be 5 MB or smaller.'); return }
    try {
      const buf = await f.arrayBuffer()
      // CSV: read as text (cells verbatim, so the chosen date format applies); Excel: the spreadsheet library (date cells are real dates).
      let rows: string[][]
      if (f.name.toLowerCase().endsWith('.csv')) rows = parseCsv(new TextDecoder().decode(buf))
      else { const { parseWorkbook } = await import('@/features/products/spreadsheet'); const wb = await parseWorkbook(buf); rows = wb.rows(wb.sheetNames[0]) }
      const g = guessMapping(rows)
      setFile({ name: f.name, mime: f.type || (f.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/octet-stream'), base64: toBase64(buf), rows, headerRow: g.headerRow })
      setMapping(g.mapping)
    } catch (e) { setError(`The file could not be read: ${describeDataError(e)}`) }
  }
  const run = async (commit: boolean) => {
    if (!file || !account || mErr.length) return
    setBusy(true); setError(null)
    try {
      const rows = mapStatementRows(file.rows, file.headerRow, mapping, order)
      if (!rows.length) { setError('No statement rows below the header.'); return }
      const named = Object.fromEntries(Object.entries(mapping).map(([k, i]) => [k, header[i as number] ?? `Column ${(i as number) + 1}`]))
      const r = await importBankStatement(account, { name: file.name, mime: file.mime, content_base64: file.base64 }, { columns: named, header_row: file.headerRow + 1, date_order: order }, rows, commit)
      setResult(r)
      if (commit) { setFile(null); setRefresh((n) => n + 1) }
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }
  const download = async (id: string) => {
    try {
      const f = await downloadStatementFile(id)
      const bytes = Uint8Array.from(atob(f.content_base64), (c) => c.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([bytes], { type: f.mime_type ?? 'application/octet-stream' }))
      const a = document.createElement('a'); a.href = url; a.download = f.file_name; a.click(); URL.revokeObjectURL(url)
    } catch (e) { setError(describeDataError(e)) }
  }
  const problems = (result?.report ?? []).filter((r) => r.status !== 'IMPORTED' || r.message)

  return (
    <>
      <PageHeader title="Import Bank Statement" breadcrumbs={[{ label: 'Accounts' }, { label: 'Bank Reconciliation', to: '/accounts/bank-reconciliation' }, { label: 'Import' }]}
        description="CSV or Excel statements are reconciliation evidence only: importing never creates vouchers. Transactions already imported are skipped." />
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      <Card className="mb-4">
        <CardHeader><div><CardTitle>1. Bank account and file</CardTitle><CardDescription>The original file is stored with the import (downloadable later).</CardDescription></div></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="w-80 space-y-1"><Label htmlFor="si-account">Bank account</Label>
            <MoneyAccountSelect id="si-account" value={account} lookups={lookups.data} kind="BANK" onChange={(v) => { setResult(null); setParams({ account: v }, { replace: true }) }} /></div>
          <div className="space-y-1"><Label htmlFor="si-file">Statement file (.csv, .xlsx, .xls)</Label>
            <Input id="si-file" type="file" accept=".csv,.xlsx,.xls" disabled={!has('bank_reconciliation.manage')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f) }} /></div>
        </CardContent>
      </Card>
      {file && (
        <Card className="mb-4">
          <CardHeader><div><CardTitle>2. Columns</CardTitle><CardDescription>{file.name}: header found on row {file.headerRow + 1}. Check each field; debit = withdrawal, credit = deposit.</CardDescription></div></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-3" data-testid="si-mapping">
              {STATEMENT_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1"><Label htmlFor={`si-map-${f.key}`}>{f.label}{f.required ? ' *' : ''}</Label>
                  <Select value={mapping[f.key] === undefined ? 'none' : String(mapping[f.key])} onValueChange={(v) => { setResult(null); setMapping((m) => {
                    const n = { ...m }; if (v === 'none') delete n[f.key as StatementField]; else n[f.key as StatementField] = Number(v); return n }) }}>
                    <SelectTrigger id={`si-map-${f.key}`}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="none">— not in the file —</SelectItem>{header.map((h, i) => <SelectItem key={i} value={String(i)}>{h || `Column ${i + 1}`}</SelectItem>)}</SelectContent></Select></div>))}
              <div className="space-y-1"><Label htmlFor="si-order">Date format</Label>
                <Select value={order} onValueChange={(v) => setOrder(v as DateOrder)}><SelectTrigger id="si-order"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="DMY">Day / month / year</SelectItem><SelectItem value="MDY">Month / day / year</SelectItem><SelectItem value="YMD">Year / month / day</SelectItem></SelectContent></Select></div>
            </div>
            {mErr.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-800">{mErr.map((e) => <li key={e}>{e}</li>)}</ul>}
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy || !account || mErr.length > 0} onClick={() => void run(false)}>Preview</Button>
              <Button disabled={busy || !result?.preview || !result.importable_count} onClick={() => void run(true)}><FileUp /> Import {result?.preview ? result.importable_count : ''} row(s)</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {result && (
        <Card className="mb-4" data-testid="si-result">
          <CardHeader><div><CardTitle>{result.preview ? '3. Preview' : 'Imported'}</CardTitle>
            <CardDescription>{result.row_count} row(s) read · {result.preview ? `${result.importable_count} to import` : `${result.imported_count} imported`} · {result.duplicate_count} already imported
              (skipped) · {result.failed_count} failed{result.previously_imported_at ? ` · this exact file was imported on ${formatDateTime(result.previously_imported_at)}` : ''}</CardDescription></div></CardHeader>
          {problems.length > 0 && <CardContent className="p-0"><Table>
            <TableHeader><TableRow><TableHead className="w-20">Row</TableHead><TableHead className="w-32">Result</TableHead><TableHead>Detail</TableHead></TableRow></TableHeader>
            <TableBody>{problems.slice(0, 500).map((r) => <TableRow key={r.row_no}><TableCell>{r.row_no}</TableCell><TableCell>{r.status === 'IMPORTED' ? 'Imported (note)' : r.status === 'DUPLICATE' ? 'Duplicate' : 'Failed'}</TableCell>
              <TableCell className="text-sm">{r.message}</TableCell></TableRow>)}</TableBody>
          </Table></CardContent>}
        </Card>
      )}
      <Card>
        <CardHeader><div><CardTitle>Import history</CardTitle></div></CardHeader>
        <CardContent className="p-0"><Table>
          <TableHeader><TableRow><TableHead>Imported</TableHead><TableHead>Account</TableHead><TableHead>File</TableHead><TableHead>Period</TableHead>
            <TableHead className="text-right">Imported</TableHead><TableHead className="text-right">Duplicates</TableHead><TableHead className="text-right">Failed</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>{(history.data ?? []).map((h) => (
            <TableRow key={h.id}><TableCell className="text-sm">{formatDateTime(h.imported_at)}<span className="block text-xs text-muted-foreground">{h.imported_by_name}</span></TableCell>
              <TableCell className="text-sm">{h.account_code}</TableCell><TableCell className="text-sm">{h.file_name}</TableCell>
              <TableCell className="text-sm">{h.statement_from ? `${formatDate(h.statement_from)} – ${formatDate(h.statement_to!)}` : '—'}</TableCell>
              <TableCell className="text-right">{h.imported_count}</TableCell><TableCell className="text-right">{h.duplicate_count}</TableCell><TableCell className="text-right">{h.failed_count}</TableCell>
              <TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => void download(h.id)}><Download /> Original</Button></TableCell></TableRow>))}
            {!history.loading && !(history.data ?? []).length && <TableRow><TableCell colSpan={8} className="py-6 text-center text-sm text-muted-foreground">No statements imported yet.</TableCell></TableRow>}
          </TableBody>
        </Table></CardContent>
      </Card>
    </>
  )
}
