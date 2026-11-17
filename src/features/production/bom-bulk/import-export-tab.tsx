import { Download, FileSpreadsheet, Loader2, Save, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { FilterTabs } from '@/components/common/filter-tabs'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  IMPORT_COLUMNS, OPERATION_HINTS, OPERATION_LABELS, applyResolvedSkus, importSkus, importTemplate, linesFromImport, parseImportSheet, validateImportRows,
  type ImportOperation, type ImportRow,
} from '@/features/production/bom-bulk-model'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { resolveSkus, saveBatch } from '@/services/bom-bulk'

const OPS: ImportOperation[] = ['ADD', 'EDIT', 'REPLACE', 'DELETE']

/** Excel Import/Export: templates, row-level validation of a change file, a draft batch from the valid rows. */
export function ImportExportTab() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [op, setOp] = useState<ImportOperation>('ADD')
  const [fileName, setFileName] = useState<string | null>(null)
  const [rows, setRows] = useState<ImportRow[] | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [reason, setReason] = useState('')
  const [today] = useState(() => toIsoDate(new Date()))
  const [effective, setEffective] = useState(today)
  const [merge, setMerge] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const reset = () => { setRows(null); setFileName(null); setFileError(null); setSaveError(null); if (fileRef.current) fileRef.current.value = '' }
  const template = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: OPERATION_LABELS[op], rows: importTemplate(op) }], `bom-${op.toLowerCase()}-template`, 'xlsx')
  }
  const onFile = async (file: File) => {
    setFileName(file.name)
    setFileError(null)
    setRows(null)
    setChecking(true)
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await file.arrayBuffer())
      const parsed = parseImportSheet(op, wb.rows(wb.sheetNames[0]))
      if (parsed.error) { setFileError(parsed.error); return }
      const checked = validateImportRows(op, parsed.rows)
      setRows(applyResolvedSkus(op, checked, await resolveSkus(importSkus(checked))))
    } catch (e) {
      setFileError(describeDataError(e))
    } finally {
      setChecking(false)
    }
  }
  const valid = rows?.filter((r) => r.errors.length === 0) ?? []
  const invalid = rows?.filter((r) => r.errors.length > 0) ?? []
  const create = async () => {
    if (!rows) return
    setSaving(true)
    setSaveError(null)
    try {
      const { lines } = linesFromImport(op, rows)
      const d = await saveBatch(null, null, { operation: op, reason: reason.trim(), effective_from: effective, title: fileName ? `Excel: ${fileName}`.slice(0, 200) : undefined, merge_duplicates: merge }, lines)
      navigate(`/production/boms?tab=approvals&batch=${d.batch.id}`)
    } catch (e) {
      setSaveError(describeDataError(e))
    } finally {
      setSaving(false)
    }
  }
  const errorReport = async () => {
    if (!rows) return
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    const head = IMPORT_COLUMNS[op].map((c) => c.label)
    await downloadSheets([{ name: 'Rows with errors', rows: [['Row', ...head, 'Errors'], ...invalid.map((r) => [r.rowNumber, ...IMPORT_COLUMNS[op].map((c) => r[c.key]), r.errors.join(' | ')])] }],
      `bom-${op.toLowerCase()}-errors-${toIsoDate(new Date())}`, 'xlsx')
  }

  return (
    <div className="space-y-4" data-testid="bom-import-export">
      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <CardDescription>Download BOM data to review or to prepare a change file.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          <Button variant="outline" asChild><Link to="/production/boms">All BOMs with components (BOM Master → Export to Excel)</Link></Button>
          <Button variant="outline" asChild><Link to="/production/boms?tab=where-used">Where a component is used (Where-Used → Export)</Link></Button>
          <Button variant="outline" asChild><Link to="/production/boms?tab=revisions">Revision history (Revision History → Export)</Link></Button>
        </CardContent>
      </Card>

      <PermissionGate anyOf={['production_bom.create', 'production_bom.update']} fallback={<p className="text-sm text-muted-foreground">Importing changes needs permission to create or update BOMs.</p>}>
        <Card>
          <CardHeader className="gap-3">
            <div>
              <CardTitle>Import a change file</CardTitle>
              <CardDescription>Each row names a finished product (its current BOM revision is changed) and a component. Rows are checked one by one; only valid rows go into the draft batch, which then needs approval.</CardDescription>
            </div>
            <FilterTabs<ImportOperation> label="Import operation" value={op} onChange={(v) => { setOp(v); reset() }} options={OPS.map((o) => ({ value: o, label: OPERATION_LABELS[o] }))} />
            <p className="text-sm text-muted-foreground">{OPERATION_HINTS[op]} Columns: {IMPORT_COLUMNS[op].map((c) => `${c.label}${c.required ? '' : ' (optional)'}`).join(', ')}.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void template()}><Download /> Download template</Button>
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={checking}>{checking ? <Loader2 className="animate-spin" /> : <Upload />} Choose Excel file</Button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" aria-label="Change file" data-testid="bom-import-file"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f) }} />
              {fileName && <span className="flex items-center gap-1 text-sm text-muted-foreground"><FileSpreadsheet className="size-4" />{fileName}</span>}
            </div>
            {fileError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800" data-testid="bom-import-error">{fileError}</p>}
            {rows && (
              <>
                <p className="text-sm" data-testid="bom-import-summary"><span className="font-medium text-green-700">{valid.length} valid row(s)</span>{invalid.length > 0 && <>, <span className="font-medium text-red-700">{invalid.length} with errors</span> (not imported)</>}.</p>
                <div className="max-h-96 overflow-auto rounded-md border">
                  <Table data-testid="bom-import-rows">
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow><TableHead>Row</TableHead>{IMPORT_COLUMNS[op].map((c) => <TableHead key={c.key}>{c.label}</TableHead>)}<TableHead>Check</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((r) => (
                        <TableRow key={r.rowNumber} className={r.errors.length ? 'bg-red-50/50' : undefined}>
                          <TableCell className="text-xs text-muted-foreground">{r.rowNumber}</TableCell>
                          {IMPORT_COLUMNS[op].map((c) => <TableCell key={c.key} className="text-sm">{r[c.key]}</TableCell>)}
                          <TableCell className="text-xs">{r.errors.length ? r.errors.map((e) => <div key={e} className="text-red-700">{e}</div>) : <span className="text-green-700">OK</span>}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {invalid.length > 0 && <Button variant="outline" onClick={() => void errorReport()}><Download /> Download rows with errors</Button>}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5 md:col-span-2"><Label htmlFor="import-reason">Reason (kept with every new revision)</Label>
                    <Textarea id="import-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                  <div className="space-y-1.5"><Label htmlFor="import-effective">Effective from</Label>
                    <Input id="import-effective" type="date" min={today} value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
                  {(op === 'ADD' || op === 'REPLACE') && (
                    <label className="flex items-start gap-2 self-end text-sm"><Checkbox checked={merge} onCheckedChange={(v) => setMerge(v === true)} aria-label="Merge into the existing line" />
                      <span>Merge into the existing line when the component is already on the BOM</span></label>
                  )}
                </div>
                {saveError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{saveError}</p>}
                <div className="flex justify-end">
                  <Button disabled={saving || valid.length === 0 || reason.trim().length < 3} onClick={() => void create()} data-testid="bom-import-create">
                    {saving ? <Loader2 className="animate-spin" /> : <Save />} Create draft batch from {valid.length} row(s)
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </PermissionGate>
    </div>
  )
}
