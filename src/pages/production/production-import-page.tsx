import { AlertTriangle, CheckCircle2, ClipboardList, Download, FileSpreadsheet, Info, Loader2, Upload, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FileUploadPanel } from '@/components/common/file-upload-panel'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import {
  MAX_PRODUCTION_IMPORT_ROWS, PRODUCTION_IMPORT_COLUMNS, buildProductionImportReport, parseProductionSheet, productionTemplateRows, type ProductionImportRow,
} from '@/features/production/production-v2-model'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { previewProductionImport, runProductionImport, type ImportPreview, type ImportResult } from '@/services/production-v2'

type Filter = 'all' | 'ready' | 'warning' | 'error'
type PreviewRow = ImportPreview['rows'][number]

/** /production/import — production entries from Excel: preview with requirements and shortages, then import the valid rows. */
export default function ProductionImportPage() {
  const storage = useStorage()
  const [warehouse, setWarehouse] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<ProductionImportRow[]>([])
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [busy, setBusy] = useState<null | 'reading' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [importKey, setImportKey] = useState(() => crypto.randomUUID())
  const whId = warehouse || storage.warehouses.find((w) => w.is_default && w.status === 'ACTIVE')?.id || ''

  const reset = () => { setFile(null); setRows([]); setPreview(null); setResult(null); setError(null); setImportKey(crypto.randomUUID()) }

  const onFile = async (f: File | null) => {
    reset()
    if (!f) return
    if (f.size > 5 * 1024 * 1024) return setError('Files must be 5 MB or smaller.')
    setFile(f)
    setBusy('reading')
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await f.arrayBuffer())
      const parsed = parseProductionSheet(wb.sheetNames.length ? wb.rows(wb.sheetNames[0]) : [])
      if (parsed.missing.length) throw new Error(`The first sheet needs the columns ${parsed.missing.join(', ')} (download the template).`)
      if (parsed.rows.length === 0) throw new Error('The sheet has no data rows below the header.')
      if (parsed.rows.length > MAX_PRODUCTION_IMPORT_ROWS) throw new Error(`Import at most ${formatNumber(MAX_PRODUCTION_IMPORT_ROWS)} rows per file.`)
      setRows(parsed.rows)
      setPreview(await previewProductionImport(parsed.rows, whId || null))
    } catch (e) {
      setError(e instanceof Error && !('code' in e) ? e.message : describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const runImport = async () => {
    setConfirm(false)
    setBusy('importing')
    setError(null)
    try {
      setResult(await runProductionImport(rows, whId || null, { file_name: file?.name ?? 'production.xlsx', total_rows: rows.length }, importKey))
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const downloadTemplate = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([
      { name: 'Production', rows: productionTemplateRows(toIsoDate(new Date())) },
      { name: 'How to fill', rows: [
        ['Column', 'What to enter'],
        ['Production Date', 'YYYY-MM-DD (DD-MM-YYYY is also accepted). Completed production cannot be dated in the future.'],
        ['Finished Product SKU', 'SKU from the Product Master. The product needs an active BOM; its materials are calculated automatically.'],
        ['Planned Quantity', 'Quantity to produce, in the product\'s unit (whole numbers for PCS, NOS, SET, PAIR). Blank = the Actual Quantity.'],
        ['Actual Quantity', 'Optional. Blank = an open order (available materials are reserved). Filled = completed production: materials are consumed at the BOM standard and the accepted quantity is added to stock.'],
        ['Rejected Quantity', 'Optional, part of the Actual Quantity. Rejected goods are recorded, not added to stock.'],
        ['Remarks', 'Optional, up to 2000 characters.'],
        ['Errors', 'Rows with errors are never imported and never skipped silently: download the error report, correct them and upload them again.'],
      ] },
    ], 'production-import-template', 'xlsx')
  }

  const downloadReport = async () => {
    if (!preview) return
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Production import report', rows: buildProductionImportReport(preview.rows, result ?? undefined) }], `production-import-report-${toIsoDate(new Date())}`, 'xlsx')
  }

  const failed = new Map((result?.failed ?? []).map((f) => [f.row_number, f.messages]))
  const created = new Map((result?.created ?? []).map((c) => [c.row_number, c]))
  const shown = (preview?.rows ?? []).filter((r) => filter === 'all' || (filter === 'ready' && r.status === 'VALID') || (filter === 'warning' && r.status === 'WARNING') || (filter === 'error' && r.status === 'ERROR'))
  const importable = preview ? preview.valid + preview.warnings : 0

  const columns: DataTableColumn<PreviewRow>[] = [
    { id: 'row', header: 'Row', cell: (r) => <span className="tabular-nums">{r.row_number}</span>, sortValue: (r) => r.row_number },
    { id: 'date', header: 'Date', cell: (r) => (r.production_date ? formatDate(r.production_date) : '—') },
    { id: 'sku', header: 'Product', cell: (r) => <span><span className="font-medium">{r.sku ?? '—'}</span>{r.product_name && <span className="block text-xs text-muted-foreground">{r.product_name}{r.bom_code ? ` · ${r.bom_code} v${r.bom_version}` : ''}</span>}</span>, searchValue: (r) => `${r.sku ?? ''} ${r.product_name ?? ''}` },
    { id: 'qty', header: 'Planned / actual / rejected', align: 'right', cell: (r) => <span className="tabular-nums">{formatQty(r.planned_quantity)} / {r.actual_quantity === null ? '—' : formatQty(r.actual_quantity)} / {formatQty(r.rejected_quantity ?? 0)}</span> },
    { id: 'type', header: 'Will be', cell: (r) => (r.status === 'ERROR' ? '—' : r.complete ? 'Completed production' : 'Open order') },
    { id: 'status', header: 'Status', cell: (r) => {
      const c = created.get(r.row_number)
      if (c) return <StatusBadge label={c.status === 'COMPLETED' ? `Recorded ${c.production_order_number}` : `Created ${c.production_order_number}`} tone="success" />
      if (failed.has(r.row_number)) return <StatusBadge label="Not imported" tone="danger" />
      return r.status === 'ERROR' ? <StatusBadge label="Error" tone="danger" /> : r.status === 'WARNING' ? <StatusBadge label="Ready (warnings)" tone="warning" /> : <StatusBadge label="Ready" tone="success" />
    } },
    { id: 'msg', header: 'Messages', cell: (r) => (
      <ul className="max-w-xl space-y-0.5 whitespace-normal text-xs">
        {(failed.get(r.row_number) ?? r.errors).map((m) => <li key={m} className="text-red-700">{m}</li>)}
        {r.warnings.map((m) => <li key={m} className="text-amber-800">{m}</li>)}
        {r.status !== 'ERROR' && r.materials.length > 0 && <li className="text-muted-foreground">{r.materials.map((m) => `${m.sku} ${formatQty(m.required, m.unit)}`).join(', ')}</li>}
      </ul>
    ), searchValue: (r) => [...r.errors, ...r.warnings].join(' ') },
  ]

  return (
    <>
      <PageHeader
        title="Import production from Excel"
        description="Upload daily production. Each row is matched by SKU, its active BOM is used to calculate materials, and availability is checked before anything is saved."
        breadcrumbs={[{ label: 'Production & Outsourcing' }, { label: 'Production Orders', to: '/production/orders' }, { label: 'Import' }]}
        actions={<Button variant="outline" onClick={() => void downloadTemplate()}><Download /> Download template</Button>}
      />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Columns: {PRODUCTION_IMPORT_COLUMNS.join(', ')}. Rows without an Actual Quantity become open orders (materials reserved); rows with one are recorded as completed production. Nothing is saved until you confirm.
      </p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      {!preview && (
        <Card>
          <CardHeader><div><CardTitle>Select a spreadsheet</CardTitle><CardDescription>.xlsx, .xls or .csv, up to 5 MB and {formatNumber(MAX_PRODUCTION_IMPORT_ROWS)} rows. The first sheet is read.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-sm space-y-1"><Label htmlFor="pi-wh">Production location</Label>
              <Select value={whId || undefined} onValueChange={(v) => { if (v) setWarehouse(v) }}>
                <SelectTrigger id="pi-wh"><SelectValue placeholder="Choose a warehouse" /></SelectTrigger>
                <SelectContent>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
              </Select></div>
            {busy === 'reading'
              ? <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading and checking the file…</p>
              : <FileUploadPanel accept={['.xlsx', '.xls', '.csv']} maxSizeMb={5} file={file} onFileChange={(f) => void onFile(f)} />}
          </CardContent>
        </Card>
      )}

      {preview && (
        <div className="space-y-6">
          <section aria-label="Import summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Rows" value={formatNumber(preview.total)} hint={file?.name} icon={FileSpreadsheet} />
            <KpiCard label="Ready" value={formatNumber(importable)} hint={`${preview.to_complete} as completed production`} icon={CheckCircle2} accent="available" />
            <KpiCard label="With warnings" value={formatNumber(preview.warnings)} hint="Shortages or possible duplicates" icon={AlertTriangle} accent={preview.warnings ? 'pending' : 'neutral'} />
            <KpiCard label="Errors" value={formatNumber(preview.errors)} hint="Not imported; see the report" icon={XCircle} accent={preview.errors ? 'shortage' : 'neutral'} />
          </section>
          {result && (
            <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
              {result.created_count} production order(s) created, {result.failed_count} row(s) not imported. The run is recorded in <Link className="underline" to={`/admin/bulk-operations?job=${result.job_id}`}>Bulk Operations</Link>.
            </p>
          )}
          <DataTable
            title="Preview"
            columns={columns}
            data={shown}
            getRowId={(r) => String(r.row_number)}
            pageSize={50}
            searchPlaceholder="Search SKU or message…"
            toolbar={<FilterTabs<Filter> label="Rows" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: 'All' }, { value: 'ready', label: 'Ready' }, { value: 'warning', label: 'Warnings' }, { value: 'error', label: 'Errors' }]} />}
            emptyState={{ icon: ClipboardList, title: 'No rows', description: 'No rows match this filter.' }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={reset}>{result ? 'Import another file' : 'Choose another file'}</Button>
            <Button variant="outline" onClick={() => void downloadReport()}><Download /> Download {result ? 'report' : 'error report'}</Button>
            {!result && <Button disabled={busy !== null || importable === 0} onClick={() => setConfirm(true)}>{busy === 'importing' ? <Loader2 className="animate-spin" /> : <Upload />} Import {importable} row(s)</Button>}
            {result && <Button asChild><Link to="/production/orders">Go to production orders</Link></Button>}
          </div>
        </div>
      )}

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Import ${importable} production row(s)?`}
        description={`${preview?.to_complete ?? 0} row(s) will be recorded as completed production (materials consumed, finished goods added to stock); the others become open orders with available materials reserved. ${preview?.errors ?? 0} row(s) with errors are not imported.`}
        confirmLabel="Import" onConfirm={() => void runImport()} />
    </>
  )
}
