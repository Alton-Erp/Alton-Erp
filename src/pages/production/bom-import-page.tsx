import { CheckCircle2, Download, FileSpreadsheet, Info, Loader2, Network, ScanSearch, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FileUploadPanel } from '@/components/common/file-upload-panel'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  BOM_IMPORT_FIELDS,
  MAX_BOM_IMPORT_ROWS,
  autoMapBomColumns,
  bomTemplateRows,
  buildBomImportReport,
  detectBomHeaderRow,
  missingBomFields,
  summarizeBomImport,
  validateBomRows,
  type BomColumnMapping,
  type BomImportGroup,
} from '@/features/production/bom-import'
import { BOM_SOURCE_LABELS, PRODUCT_TYPE_LABELS, UNITS, skuKey } from '@/features/products/product-model'
import type { ParsedWorkbook } from '@/features/products/spreadsheet'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import { recordImportJob, type ImportJobRowInput } from '@/services/admin'
import { activateBom, fetchBomImportLookups, saveBom } from '@/services/production'
import { updateProduct } from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'

type Step = 'upload' | 'map' | 'review' | 'done'
type Group = BomImportGroup & { saveError?: string; result?: string; bomId?: string }
type RowView = { rowNumber: number; finishedSku: string; componentSku: string; quantity: string; group: Group; errors: string[]; warnings: string[] }
type Filter = 'all' | 'error' | 'valid'

const columnLetter = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** /production/boms/import — one row per component, grouped into one new BOM version per finished product. */
export default function BomImportPage() {
  const { has } = usePermissions()
  const canActivate = has('production_bom.approve')
  const [searchParams] = useSearchParams()
  const retryOf = searchParams.get('retry')

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [sheet, setSheet] = useState('')
  const [allRows, setAllRows] = useState<string[][]>([])
  const [headerIndex, setHeaderIndex] = useState(0)
  const [mapping, setMapping] = useState<BomColumnMapping | null>(null)
  const [effectiveFrom, setEffectiveFrom] = useState(() => toIsoDate(new Date()))
  const [activate, setActivate] = useState(canActivate)
  const [groups, setGroups] = useState<Group[]>([])
  const [busy, setBusy] = useState<null | 'reading' | 'validating' | 'importing'>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [importKey, setImportKey] = useState(() => crypto.randomUUID())
  const [logError, setLogError] = useState(false)

  const headers = allRows[headerIndex] ?? []
  const data = useMemo(() => allRows.slice(headerIndex + 1), [allRows, headerIndex])
  const firstDataRow = headerIndex + 2
  const dataRowCount = data.filter((r) => r.some((c) => c !== '')).length
  const missing = mapping ? missingBomFields(mapping) : []
  const summary = summarizeBomImport(groups)

  const reset = () => {
    setImportKey(crypto.randomUUID())
    setStep('upload')
    setFile(null)
    setWorkbook(null)
    setAllRows([])
    setMapping(null)
    setGroups([])
    setError(null)
    setLogError(false)
  }

  const selectSheet = (wb: ParsedWorkbook, name: string) => {
    const rows = wb.rows(name)
    const h = Math.max(0, detectBomHeaderRow(rows))
    setSheet(name)
    setAllRows(rows)
    setHeaderIndex(h)
    setMapping(autoMapBomColumns(rows[h] ?? []))
  }

  const onFile = async (f: File | null) => {
    setError(null)
    if (!f) return reset()
    if (f.size > 5 * 1024 * 1024) return setError('Files must be 5 MB or smaller.')
    setFile(f)
    setBusy('reading')
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await f.arrayBuffer())
      if (wb.sheetNames.length === 0) throw new Error('empty')
      setWorkbook(wb)
      selectSheet(wb, wb.sheetNames[0])
      setStep('map')
    } catch {
      setFile(null)
      setError('This file could not be read. Use a valid .xlsx, .xls or .csv file.')
    } finally {
      setBusy(null)
    }
  }

  const validate = async () => {
    if (!mapping) return
    setError(null)
    if (dataRowCount === 0) return setError('The selected sheet has no data rows below the header.')
    if (dataRowCount > MAX_BOM_IMPORT_ROWS) return setError(`Import at most ${formatNumber(MAX_BOM_IMPORT_ROWS)} rows per file.`)
    setBusy('validating')
    try {
      const col = (i: number | null) => (i === null ? [] : data.map((r) => String(r[i] ?? '').trim()).filter(Boolean))
      const skus = [...new Set([...col(mapping.finished_sku), ...col(mapping.component_sku)].map(skuKey))]
      const [lookups, suppliers] = await Promise.all([fetchBomImportLookups(skus), fetchSupplierOptions(true).catch(() => [])])
      setGroups(validateBomRows(data, mapping, {
        products: lookups.products, suppliers, activeVersions: lookups.activeVersions, latestBoms: lookups.latestBoms, canUpdateProducts: has('products.update'),
      }, firstDataRow))
      setFilter('all')
      setStep('review')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const runImport = async () => {
    setBusy('importing')
    setProgress(0)
    setError(null)
    const fileNote = `Imported from ${file?.name ?? 'a spreadsheet'}.`
    const out: Group[] = []
    let done = 0
    for (const g of groups) {
      if (g.status !== 'valid' || !g.product) {
        out.push(g)
        continue
      }
      try {
        // Planning fields go to the Product Master (only the fields that differ).
        let planningNote = ''
        if (g.planningChanges.length > 0) {
          await updateProduct(g.product.id, g.planningPatch)
          planningNote = `; planning updated (${g.planningChanges.map((c) => c.label).join(', ')})`
        }
        if (g.saveMode === 'unchanged' && g.existingBom) {
          out.push({ ...g, result: `No change to ${g.existingBom.bom_code} v${g.existingBom.version} (same components)${planningNote}`, bomId: g.existingBom.id })
          setProgress(++done)
          continue
        }
        const saved = await saveBom({
          bomId: g.saveMode === 'update-draft' ? g.existingBom?.id ?? null : null,
          finishedProductId: g.product.id,
          effectiveFrom,
          effectiveTo: null,
          outputQuantity: g.outputQuantity,
          notes: fileNote,
          items: g.lines.map((l) => ({
            component_product_id: l.component.id,
            quantity_required: l.quantity,
            unit: l.unit,
            wastage_percentage: l.wastage,
            notes: l.remarks,
            source_type: l.source,
            preferred_supplier_id: l.supplierId,
          })),
        }, crypto.randomUUID())
        const verb = g.saveMode === 'update-draft' ? 'Updated' : 'Saved'
        let result = `${verb} ${saved.bom_code} v${saved.version} as a draft`
        if (activate) {
          try {
            const a = await activateBom(saved.bom_id, fileNote)
            result = `${saved.bom_code} v${saved.version} active${a.superseded_versions?.length ? ` (replaced ${a.superseded_versions.join(', ')})` : ''}${a.closed_versions.length ? ` (closed ${a.closed_versions.join(', ')})` : ''}`
          } catch (e) {
            result = `${verb} ${saved.bom_code} v${saved.version} as a draft; not activated: ${describeDataError(e)}`
          }
        }
        out.push({ ...g, result: result + planningNote, bomId: saved.bom_id })
      } catch (e) {
        out.push({ ...g, saveError: describeDataError(e) })
      }
      setProgress(++done)
    }

    // Import history (Bulk Operations): every row of a BOM that was not saved, with its original cells.
    const rowData = (n: number) => Object.fromEntries(headers.map((h, i) => [h || columnLetter(i), data[n - firstDataRow]?.[i] ?? '']))
    const failedGroups = out.filter((g) => g.status === 'error' || g.saveError)
    const problems: ImportJobRowInput[] = failedGroups.flatMap((g) => g.rows.map((r) => ({
      row_number: r.rowNumber, outcome: 'FAILED' as const, reference: `${r.finishedSku} / ${r.componentSku}`.slice(0, 200),
      messages: [...r.errors, ...(g.saveError ? [g.saveError] : []), ...g.errors].slice(0, 20), row_data: rowData(r.rowNumber),
    })))
    const okRows = out.filter((g) => g.status === 'valid' && !g.saveError).reduce((s, g) => s + g.rows.length, 0)
    const failedRows = failedGroups.reduce((s, g) => s + g.rows.length, 0)
    try {
      await recordImportJob({ import_type: 'BOMS', client_job_key: importKey, file_name: file?.name ?? null, total_rows: okRows + failedRows,
        success_rows: okRows, failed_rows: failedRows, duplicate_rows: 0, skipped_rows: 0, retry_of_job_id: retryOf }, problems)
    } catch {
      setLogError(true)
    }
    setGroups(out)
    setStep('done')
    setBusy(null)
  }

  const downloadReport = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'BOM import report', rows: buildBomImportReport(groups) }], `bom-import-report-${toIsoDate(new Date())}`, 'xlsx')
  }

  const downloadTemplate = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([
      { name: 'BOM', rows: bomTemplateRows() },
      {
        name: 'How to fill',
        rows: [
          ['Column', 'What to enter'],
          ['Finished Product SKU', 'SKU of the product being made (finished good, subassembly, component or outsourced component). Repeat it on every component row.'],
          ['Product Name', 'Optional. Checked against the Product Master for the SKU (a BOM file never renames a product).'],
          ['Product Type', 'Optional. Must match the Product Master (change the type there).'],
          ['Tax Rate (%)', 'Optional, 0 to 100 (up to 2 decimals). Saved as the product\'s GST rate.'],
          ['Lead Time (Days)', 'Optional, 0 to 3650 days. Saved on the product.'],
          ['Group Head', 'Optional, up to 100 characters (see ERP Settings → Products for the list). Saved on the product.'],
          ['Minimum Stock Days', 'Optional, 0 to 3650 days. Saved on the product; informational.'],
          ['Component SKU', 'SKU of a raw material, component, subassembly, outsourced part, packing material or consumable. The product must already exist in the Product Master.'],
          ['Quantity per Output', 'Quantity of the component for the Output Quantity of the finished product, in the component\'s unit. Whole numbers for PCS, NOS, SET and PAIR.'],
          ['Unit', `Optional. Must match the component's unit (${UNITS.map((u) => u.code).join(', ')}); no conversion is done.`],
          ['Source', `Optional: ${Object.values(BOM_SOURCE_LABELS).join(', ')}. Blank = the component's default.`],
          ['Wastage %', 'Optional, 0 to 99.99. Added on top when planning production.'],
          ['Preferred Supplier', 'Optional supplier code or name. Blank or unknown = the component\'s preferred supplier.'],
          ['Remarks', 'Optional, up to 500 characters.'],
          ['Output Quantity', 'Optional, default 1. One value per finished product (e.g. 2 when 1 washer serves 2 units).'],
          ['Product types', Object.values(PRODUCT_TYPE_LABELS).join(', ')],
          ['Planning fields', 'Product Name to Minimum Stock Days have one value per finished product: fill them on one row (or repeat the same value).'],
          ['Versions', 'If the components match the latest BOM version, no new version is created (only the planning fields are updated). If the latest version is a draft, it is updated. Otherwise a new version is added; older versions are kept for history.'],
          ['Errors', 'A BOM is imported only when all its rows are correct. Download the report, correct the rows and import that BOM again.'],
        ],
      },
    ], 'bom-import-template', 'xlsx')
  }

  const rowViews: RowView[] = groups.flatMap((g) => g.rows.map((r) => ({
    rowNumber: r.rowNumber, finishedSku: r.finishedSku, componentSku: r.componentSku,
    quantity: String(g.lines.find((l) => l.rowNumber === r.rowNumber)?.quantity ?? ''),
    group: g, errors: [...r.errors, ...(g.saveError ? [g.saveError] : []), ...g.errors.filter((e) => !e.includes('row(s) have errors'))], warnings: [...r.warnings, ...g.warnings],
  }))).sort((a, b) => a.rowNumber - b.rowNumber)
  const shown = rowViews.filter((r) => filter === 'all' ? true : filter === 'error' ? r.group.status === 'error' || Boolean(r.group.saveError) : r.group.status === 'valid' && !r.group.saveError)

  const columns: DataTableColumn<RowView>[] = [
    { id: 'row', header: 'Row', cell: (r) => <span className="tabular-nums">{r.rowNumber}</span>, searchValue: (r) => String(r.rowNumber) },
    { id: 'fg', header: 'Finished product', cell: (r) => <span><span className="font-medium">{r.finishedSku || '—'}</span>{r.group.product && <span className="block text-xs text-muted-foreground">{r.group.product.product_name}</span>}</span>, searchValue: (r) => `${r.finishedSku} ${r.group.product?.product_name ?? ''}` },
    { id: 'comp', header: 'Component', cell: (r) => {
      const line = r.group.lines.find((l) => l.rowNumber === r.rowNumber)
      return <span><span className="font-medium">{r.componentSku || '—'}</span>{line && <span className="block text-xs text-muted-foreground">{line.component.product_name}</span>}</span>
    }, searchValue: (r) => r.componentSku },
    { id: 'qty', header: 'Qty', align: 'right', cell: (r) => {
      const line = r.group.lines.find((l) => l.rowNumber === r.rowNumber)
      return line ? `${formatNumber(line.quantity)} ${line.unit}${line.wastage ? ` +${line.wastage}%` : ''}` : '—'
    } },
    { id: 'src', header: 'Source', cell: (r) => {
      const line = r.group.lines.find((l) => l.rowNumber === r.rowNumber)
      return line ? (line.source ? BOM_SOURCE_LABELS[line.source] : <span className="text-muted-foreground">From product</span>) : '—'
    } },
    { id: 'planning', header: 'Planning (product)', cell: (r) => {
      // Shown once per BOM, on its first row.
      if (r.group.rows[0]?.rowNumber !== r.rowNumber) return null
      if (r.group.planningChanges.length === 0) return <span className="text-xs text-muted-foreground">{Object.keys(r.group.planning).length ? 'No change' : '—'}</span>
      return <ul className="space-y-0.5 text-xs">{r.group.planningChanges.map((c) => <li key={c.label}>{c.label}: {c.from} → <span className="font-medium">{c.to}</span></li>)}</ul>
    } },
    { id: 'result', header: 'BOM result', cell: (r) => r.group.saveError ? <StatusBadge label="Failed" tone="danger" />
      : r.group.status === 'error' ? <StatusBadge label={r.errors.length ? 'Error' : 'Held back'} tone="danger" />
      : step === 'done' ? <StatusBadge label={r.group.result?.startsWith('No change') ? 'Unchanged' : r.group.result?.includes('active') && !r.group.result.includes('not activated') ? 'Active' : 'Draft saved'} tone="success" />
      : <StatusBadge label="Ready" tone="success" /> },
    { id: 'msg', header: 'Messages', cell: (r) => (
      <ul className="max-w-xl space-y-0.5 whitespace-normal text-xs">
        {step === 'done' && r.group.result && <li className="text-green-800">{r.group.result}</li>}
        {r.errors.map((m) => <li key={m} className="text-red-700">{m}</li>)}
        {r.warnings.map((m) => <li key={m} className="text-amber-800">{m}</li>)}
      </ul>
    ), searchValue: (r) => [...r.errors, ...r.warnings].join(' ') },
  ]

  return (
    <>
      <PageHeader
        title="Import Bills of Materials"
        description="One row per component, with the product planning fields. Nothing is saved until you confirm."
        breadcrumbs={[{ label: 'Production & Outsourcing' }, { label: 'Bill of Materials (BOM)', to: '/production/boms' }, { label: 'Import' }]}
        actions={<Button variant="outline" onClick={() => void downloadTemplate()}><Download /> Download template</Button>}
      />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Importing BOMs never moves stock. Products must already exist (import products first if needed). Active BOM versions are never changed: a file that matches the latest version creates nothing new, a draft is updated in place, and other changes add a new version.
      </p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      {step === 'upload' && (
        <Card>
          <CardHeader><div><CardTitle>Select a spreadsheet</CardTitle><CardDescription>.xlsx, .xls or .csv, up to 5 MB and {formatNumber(MAX_BOM_IMPORT_ROWS)} rows. The file is read in your browser.</CardDescription></div></CardHeader>
          <CardContent>
            {busy === 'reading'
              ? <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading workbook…</p>
              : <FileUploadPanel accept={['.xlsx', '.xls', '.csv']} maxSizeMb={5} file={file} onFileChange={(f) => void onFile(f)} />}
          </CardContent>
        </Card>
      )}

      {step === 'map' && workbook && mapping && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div><CardTitle className="flex items-center gap-2"><FileSpreadsheet className="size-4 text-available" /> {file?.name}</CardTitle><CardDescription>{formatNumber(dataRowCount)} data rows below the header</CardDescription></div>
              <Button variant="ghost" size="sm" onClick={reset}>Choose another file</Button>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5"><Label htmlFor="bi-sheet">Worksheet</Label>
                <Select value={sheet} onValueChange={(v) => selectSheet(workbook, v)}>
                  <SelectTrigger id="bi-sheet"><SelectValue /></SelectTrigger>
                  <SelectContent>{workbook.sheetNames.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
                </Select></div>
              <div className="space-y-1.5"><Label htmlFor="bi-header">Header row</Label>
                <Input id="bi-header" type="number" min={1} value={headerIndex + 1} onChange={(e) => { const h = Math.max(1, Number(e.target.value) || 1) - 1; setHeaderIndex(h); setMapping(autoMapBomColumns(allRows[h] ?? [])) }} /></div>
              <div className="space-y-1.5"><Label htmlFor="bi-from">Effective from</Label>
                <Input id="bi-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></div>
              <div className="flex items-start gap-2 self-end pb-2">
                <Checkbox id="bi-activate" checked={activate} disabled={!canActivate} onCheckedChange={(v) => setActivate(v === true)} className="mt-0.5" />
                <Label htmlFor="bi-activate" className="flex-col items-start gap-0.5 font-normal">
                  <span className="font-medium">Activate imported BOMs</span>
                  <span className="text-xs text-muted-foreground">{canActivate ? 'Untick to save them as drafts for review.' : 'You can save drafts; activating needs the BOM approve permission.'}</span>
                </Label>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Column mapping</CardTitle><CardDescription>Fields marked * are required.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {BOM_IMPORT_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`bm-${f.key}`}>{f.label}{f.required && <span className="text-shortage">*</span>}</Label>
                  <Select value={mapping[f.key] === null ? 'none' : String(mapping[f.key])} onValueChange={(v) => setMapping({ ...mapping, [f.key]: v === 'none' ? null : Number(v) })}>
                    <SelectTrigger id={`bm-${f.key}`} aria-invalid={f.required && mapping[f.key] === null}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Not mapped —</SelectItem>
                      {headers.map((h, i) => <SelectItem key={i} value={String(i)}>{columnLetter(i)}: {h || '(blank header)'}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </CardContent>
            {missing.length > 0 && <p className="mx-5 mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Map the required fields: {missing.join(', ')}.</p>}
          </Card>
          <div className="flex justify-end">
            <Button onClick={() => void validate()} disabled={missing.length > 0 || busy !== null || !effectiveFrom}>
              {busy === 'validating' ? <Loader2 className="animate-spin" /> : <ScanSearch />} Validate {formatNumber(dataRowCount)} rows
            </Button>
          </div>
        </div>
      )}

      {(step === 'review' || step === 'done') && (
        <div className="space-y-6">
          {step === 'done' && (
            <Card>
              <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-available" />
                  <div>
                    <p className="font-semibold">Import finished: {formatNumber(groups.filter((g) => g.status === 'valid' && !g.saveError).length)} of {formatNumber(groups.length)} BOMs saved</p>
                    <p className="text-sm text-muted-foreground">
                      {formatNumber(groups.filter((g) => g.status === 'error' || g.saveError).length)} not imported. Download the report to correct them.
                      {logError && ' (The run could not be added to the import history; the BOMs themselves were saved and audited.)'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={reset}><Upload /> Import another file</Button>
                  <Button asChild><Link to="/production/boms">View BOMs</Link></Button>
                </div>
              </CardContent>
            </Card>
          )}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="BOMs in file" value={formatNumber(summary.boms)} hint={`${formatNumber(summary.rows)} rows`} icon={Network} />
            <KpiCard label="Ready" value={formatNumber(summary.valid)} hint={`${formatNumber(summary.components)} components`} icon={CheckCircle2} accent="available" />
            <KpiCard label="With errors" value={formatNumber(summary.errors)} hint="Held back as a whole" icon={Info} accent="shortage" />
            <KpiCard label="New BOM versions" value={formatNumber(summary.newVersions)} hint={`${formatNumber(summary.draftUpdates)} drafts updated · ${formatNumber(summary.unchanged)} unchanged · ${formatNumber(summary.planningUpdates)} planning updates`} icon={Info} accent="pending" />
          </div>
          <DataTable
            title="Rows"
            columns={columns}
            data={shown}
            getRowId={(r) => String(r.rowNumber)}
            searchPlaceholder="Search row, SKU or message…"
            pageSize={25}
            toolbar={
              <>
                <FilterTabs<Filter> label="Rows" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'error', label: 'Not importable' }, { value: 'valid', label: 'Ready / saved' }]} />
                <Button variant="outline" size="sm" onClick={() => void downloadReport()}><Download /> Download report</Button>
              </>
            }
            emptyState={{ icon: Info, title: 'No rows in this view', description: 'Choose another filter.' }}
          />
          {step === 'review' && (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="outline" onClick={() => setStep('map')} disabled={busy !== null}>Back to mapping</Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={summary.valid === 0 || busy !== null}>
                {busy === 'importing' ? <Loader2 className="animate-spin" /> : <Upload />}
                {busy === 'importing' ? `Importing… ${formatNumber(progress)} / ${formatNumber(summary.valid)}` : `Import ${formatNumber(summary.valid)} BOM${summary.valid === 1 ? '' : 's'}`}
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Import ${formatNumber(summary.valid)} BOM${summary.valid === 1 ? '' : 's'}?`}
        description={`${formatNumber(summary.newVersions)} new version(s) and ${formatNumber(summary.draftUpdates)} updated draft(s), effective from ${effectiveFrom}${activate ? ', activated straight away (a current active version is closed or replaced, and kept in history)' : ', saved as drafts'}. ${formatNumber(summary.unchanged)} BOM(s) match the latest version and are not duplicated; planning fields are updated on ${formatNumber(summary.planningUpdates)} product(s). ${formatNumber(summary.errors)} BOM(s) with errors are not imported. Stock is not affected.`}
        confirmLabel="Import BOMs"
        onConfirm={() => void runImport()}
      />
    </>
  )
}
