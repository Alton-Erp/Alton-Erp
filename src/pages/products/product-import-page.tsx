import { CheckCircle2, Download, FileSpreadsheet, Info, Loader2, ScanSearch, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EXPORT_COLUMNS } from '@/features/products/product-export'
import {
  IMPORT_FIELDS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  autoMapColumns,
  buildErrorReport,
  detectHeaderRow,
  legacyQuantityColumns,
  missingRequiredFields,
  productRowToFormValues,
  splitAtHeader,
  summarizeImport,
  validateImportRows,
  type ColumnMapping,
  type DuplicateMode,
  type ExistingProduct,
  type ImportFieldKey,
  type ImportRowResult,
} from '@/features/products/product-import'
import { PRODUCT_TYPE_LABELS, SOURCE_TYPE_LABELS, STANDARD_GST_RATES, UNITS, normalizeEan, skuKey } from '@/features/products/product-model'
import type { ParsedWorkbook } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { recordImportJob, type ImportJobRowInput } from '@/services/admin'
import {
  fetchProductsByIds,
  findExistingEans,
  findExistingIdentifiers,
  insertProducts,
  listCategories,
  logProductImport,
  updateProductsFromImport,
  type ProductUpdate,
} from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'

type Step = 'upload' | 'map' | 'review' | 'done'
type RowResult = ImportRowResult & { saveError?: string }
type ResultFilter = 'all' | 'error' | 'warning' | 'skipped' | 'valid'

const columnLetter = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export default function ProductImportPage() {
  const { access } = useAuth()
  const { has } = usePermissions()
  const canUpdate = has('products.update')
  const companyId = access?.company?.id ?? ''
  const categories = useAsync(listCategories, [])
  const [searchParams] = useSearchParams()
  const retryOf = searchParams.get('retry')

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [sheet, setSheet] = useState('')
  const [allRows, setAllRows] = useState<string[][]>([])
  const [headerIndex, setHeaderIndex] = useState(0)
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>('skip')
  const [results, setResults] = useState<RowResult[]>([])
  const [busy, setBusy] = useState<null | 'reading' | 'validating' | 'importing'>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resultFilter, setResultFilter] = useState<ResultFilter>('all')
  const [final, setFinal] = useState<{ imported: number; updated: number; skipped: number; failed: number; logError: boolean } | null>(null)
  const [importKey, setImportKey] = useState(() => crypto.randomUUID())

  const split = useMemo(() => splitAtHeader(allRows, headerIndex), [allRows, headerIndex])
  const dataRowCount = split.data.filter((r) => r.some((c) => c !== '')).length
  const missing = mapping ? missingRequiredFields(mapping, duplicateMode) : []

  const reset = () => {
    setImportKey(crypto.randomUUID())
    setStep('upload')
    setFile(null)
    setWorkbook(null)
    setAllRows([])
    setMapping(null)
    setResults([])
    setFinal(null)
    setError(null)
  }

  const selectSheet = (wb: ParsedWorkbook, name: string) => {
    const rows = wb.rows(name)
    const h = Math.max(0, detectHeaderRow(rows))
    setSheet(name)
    setAllRows(rows)
    setHeaderIndex(h)
    setMapping(autoMapColumns(rows[h] ?? []))
  }

  const onFile = async (f: File | null) => {
    setError(null)
    if (!f) return reset()
    if (f.size > MAX_IMPORT_FILE_BYTES) return setError('Files must be 5 MB or smaller.')
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
      setError('This file could not be read. Make sure it is a valid .xlsx or .xls workbook.')
    } finally {
      setBusy(null)
    }
  }

  const validate = async () => {
    if (!mapping) return
    setError(null)
    if (dataRowCount === 0) return setError('The selected sheet has no data rows below the header.')
    if (dataRowCount > MAX_IMPORT_ROWS) return setError(`Import at most ${formatNumber(MAX_IMPORT_ROWS)} rows per file.`)
    setBusy('validating')
    try {
      const col = (key: ImportFieldKey) => (mapping[key] === null ? [] : split.data.map((r) => (r[mapping[key]!] ?? '').trim()).filter(Boolean))
      // Read-only lookups: which SKUs/barcodes already exist, the stored products to compare in update mode, and suppliers.
      const existing = await findExistingIdentifiers([...new Set(col('sku').map(skuKey))], [...new Set(col('barcode'))])
      const existingProducts = new Map<string, ExistingProduct>()
      if (duplicateMode === 'update' && existing.skuIds.size > 0) {
        for (const p of await fetchProductsByIds([...existing.skuIds.values()])) {
          existingProducts.set(skuKey(p.sku), { id: p.id, sku: p.sku, values: productRowToFormValues(p) })
        }
      }
      const suppliers = mapping.preferred_supplier === null ? [] : await fetchSupplierOptions(true).catch(() => [])
      const eanOwners = await findExistingEans([...new Set(col('ean').map(normalizeEan))])
      setResults(
        validateImportRows(
          split.data,
          mapping,
          {
            categories: categories.data ?? [],
            existingSkus: existing.existingSkus,
            existingBarcodes: existing.existingBarcodes,
            barcodeOwners: existing.barcodeOwners,
            eanOwners,
            existingProducts,
            suppliers,
            duplicateMode,
          },
          split.firstDataRowNumber,
        ),
      )
      setResultFilter('all')
      setStep('review')
    } catch (err) {
      setError(describeDataError(err))
    } finally {
      setBusy(null)
    }
  }

  const runImport = async () => {
    const creates = results.filter((r) => r.status === 'valid' && r.input && r.action !== 'update')
    const changes = results.filter((r) => r.status === 'valid' && r.input && r.action === 'update' && r.productId)
    setBusy('importing')
    setProgress(0)
    setError(null)
    try {
      const createFailures = await insertProducts(companyId, creates.map((r) => r.input!), setProgress)
      const updateFailures = await updateProductsFromImport(
        changes.map((r) => ({ id: r.productId!, changes: r.input as ProductUpdate })),
        (n) => setProgress(creates.length + n),
      )
      const updated = results.map((r) => {
        const c = creates.indexOf(r)
        if (c >= 0 && createFailures.has(c)) return { ...r, saveError: createFailures.get(c) }
        const u = changes.indexOf(r)
        if (u >= 0 && updateFailures.has(u)) return { ...r, saveError: updateFailures.get(u) }
        return r
      })
      const totals = {
        total: results.length,
        imported: creates.length - createFailures.size,
        updated: changes.length - updateFailures.size,
        skipped: results.filter((r) => r.status === 'skipped').length,
        failed: createFailures.size + updateFailures.size + results.filter((r) => r.status === 'error').length,
      }
      let logError = false
      try {
        await logProductImport(file?.name ?? 'import', { total: totals.total, imported: totals.imported + totals.updated, skipped: totals.skipped, failed: totals.failed })
      } catch {
        logError = true
      }
      // Import history (Bulk Operations): rejected and skipped rows with their original cells.
      const rowData = (n: number) => Object.fromEntries(split.headers.map((h, i) => [h || columnLetter(i), split.data[n - split.firstDataRowNumber]?.[i] ?? '']))
      const problems: ImportJobRowInput[] = updated.filter((r) => r.status !== 'valid' || r.saveError).map((r) => ({
        row_number: r.rowNumber, outcome: r.status === 'skipped' ? 'DUPLICATE' : 'FAILED', reference: r.sku || null,
        messages: r.saveError ? [r.saveError] : r.status === 'skipped' ? (r.warnings.length ? r.warnings : ['SKU already exists']) : r.errors, row_data: rowData(r.rowNumber),
      }))
      try {
        await recordImportJob({ import_type: 'PRODUCTS', client_job_key: importKey, file_name: file?.name ?? null, total_rows: totals.total, success_rows: totals.imported + totals.updated,
          failed_rows: totals.failed, duplicate_rows: totals.skipped, skipped_rows: 0, retry_of_job_id: retryOf }, problems)
      } catch {
        logError = true
      }
      setResults(updated)
      setFinal({ imported: totals.imported, updated: totals.updated, skipped: totals.skipped, failed: totals.failed, logError })
      setStep('done')
    } catch (err) {
      setError(`${describeDataError(err)} Some rows may have been imported before the error; check the product list before retrying.`)
    } finally {
      setBusy(null)
    }
  }

  const downloadReport = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Import report', rows: buildErrorReport(results) }], `product-import-report-${toIsoDate(new Date())}`, 'xlsx')
  }

  const downloadTemplate = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    const header = IMPORT_FIELDS.map((f) => f.label)
    await downloadSheets(
      [
        { name: 'Products', rows: [header] },
        {
          name: 'Allowed values',
          rows: [
            ['Field', 'Allowed values / format'],
            ['Required columns', `${IMPORT_FIELDS.filter((f) => f.required).map((f) => f.label).join(', ')}. Everything else is optional and can be added later.`],
            ['SKU', 'Optional for new products: leave blank to get the next code for the type (FG-000001, RM-000001 …). Needed to update existing products.'],
            ['Product Type', Object.values(PRODUCT_TYPE_LABELS).join(', ')],
            ['Source Type', `${Object.values(SOURCE_TYPE_LABELS).join(', ')}. Optional: finished goods, subassemblies and components default to In-House, others to Outsourced.`],
            ['Unit', `${UNITS.map((u) => u.code).join(', ')}. Optional: PCS when blank.`],
            ['Category', `Name or code of an active category: ${(categories.data ?? []).filter((c) => c.is_active).map((c) => c.name).join(', ')}`],
            ['HSN Code', '4, 6 or 8 digits (optional)'],
            ['GST Rate', `Percentage 0–100 (optional). Common rates: ${STANDARD_GST_RATES.join(', ')}`],
            ['Prices and costs', 'Non-negative, up to 2 decimals (optional)'],
            ['MRP', 'Maximum retail price in ₹ incl. taxes, non-negative, up to 2 decimals (optional). Kept separate from the selling price.'],
            ['Lead Time (Days) / Reorder Level (Days)', 'Number of days from 0 to 3650, up to 2 decimals (optional). Reorder when the days of stock cover fall to the reorder level. Quantity columns of earlier templates (Reorder Level, Minimum Stock Level) are not imported.'],
            ['Length / Width / Height (cm)', 'Positive size in centimetres, up to 2 decimals (optional)'],
            ['Supplier Model No. / Supplier Product Name', 'The supplier\'s own model number and name (optional). The SKU and product name are not changed by them.'],
            ['Manufacturable', 'Yes or No (optional)'],
            ['Preferred Supplier', 'Supplier code or name of an active supplier (optional). Unknown suppliers are reported and left blank.'],
            ['Updating existing products', 'Choose "Update existing products". Only cells with a value are changed; blank cells keep the stored value. Every change is listed for review before saving.'],
            ['Export compatibility', `An export from the product list uses the columns: ${EXPORT_COLUMNS.join(', ')}. Correct it and import it again in update mode.`],
          ],
        },
      ],
      'product-import-template',
      'xlsx',
    )
  }

  const summary = summarizeImport(results)
  const filteredResults = results.filter((r) =>
    resultFilter === 'all'
      ? true
      : resultFilter === 'warning'
        ? r.status === 'valid' && r.warnings.length > 0
        : resultFilter === 'error'
          ? r.status === 'error' || Boolean(r.saveError)
          : r.status === resultFilter,
  )

  const resultColumns: DataTableColumn<RowResult>[] = [
    { id: 'row', header: 'Row', cell: (r) => <span className="tabular-nums">{r.rowNumber}</span>, searchValue: (r) => String(r.rowNumber) },
    { id: 'sku', header: 'SKU', cell: (r) => <span className="font-medium">{r.sku || '—'}</span>, searchValue: (r) => r.sku },
    { id: 'name', header: 'Product Name', cell: (r) => r.productName || '—', searchValue: (r) => r.productName },
    {
      id: 'status',
      header: 'Result',
      cell: (r) =>
        r.saveError ? (
          <StatusBadge label="Failed" tone="danger" />
        ) : r.status === 'error' ? (
          <StatusBadge label="Error" tone="danger" />
        ) : r.status === 'skipped' ? (
          <StatusBadge label="Skipped" tone="neutral" />
        ) : step === 'done' ? (
          <StatusBadge label={r.action === 'update' ? 'Updated' : 'Created'} tone="success" />
        ) : r.action === 'update' ? (
          <StatusBadge label={`Update · ${r.changes?.length ?? 0} change(s)`} tone="info" />
        ) : r.warnings.length > 0 ? (
          <StatusBadge label="Valid · warning" tone="warning" />
        ) : (
          <StatusBadge label="Valid" tone="success" />
        ),
    },
    {
      id: 'messages',
      header: 'Messages',
      cell: (r) => (
        <ul className="max-w-xl space-y-0.5 whitespace-normal text-xs">
          {[...r.errors, ...(r.saveError ? [r.saveError] : [])].map((m) => (
            <li key={m} className="text-red-700">{m}</li>
          ))}
          {(r.changes ?? []).map((c) => (
            <li key={c.field} className="text-blue-800">
              <span className="font-medium">{c.label}:</span> <span className="line-through opacity-70">{c.from}</span> → {c.to}
            </li>
          ))}
          {r.warnings.map((m) => (
            <li key={m} className="text-amber-800">{m}</li>
          ))}
        </ul>
      ),
      searchValue: (r) => [...r.errors, ...r.warnings, ...(r.changes ?? []).map((c) => c.label)].join(' '),
    },
  ]

  return (
    <>
      <PageHeader
        title="Import Products from Excel"
        description="Create new products or update existing ones from a spreadsheet. Nothing is saved until you confirm the import."
        breadcrumbs={[{ label: 'Master Data' }, { label: 'Product Master', to: '/products' }, { label: 'Import' }]}
        actions={
          <Button variant="outline" onClick={() => void downloadTemplate()}>
            <Download />
            Download template
          </Button>
        }
      />

      <ol className="mb-6 flex flex-wrap gap-2 text-sm" aria-label="Import steps">
        {(['upload', 'map', 'review', 'done'] as Step[]).map((s, i) => (
          <li
            key={s}
            aria-current={step === s ? 'step' : undefined}
            className={cn('rounded-full border px-3 py-1', step === s ? 'border-primary bg-accent font-medium text-accent-foreground' : 'bg-background text-muted-foreground')}
          >
            {i + 1}. {{ upload: 'Upload', map: 'Map columns', review: 'Validate & review', done: 'Summary' }[s]}
          </li>
        ))}
      </ol>

      <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Imports change product master records only; they never create, change or reserve stock. Existing products are changed only in
        "Update existing products" mode, and only after you have reviewed every change.
      </p>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          {error}
        </p>
      )}

      {step === 'upload' && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Select a spreadsheet</CardTitle>
              <CardDescription>.xlsx or .xls, up to 5 MB and {formatNumber(MAX_IMPORT_ROWS)} rows. The file is read in your browser.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {busy === 'reading' ? (
              <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Reading workbook…
              </p>
            ) : (
              <FileUploadPanel accept={['.xlsx', '.xls']} maxSizeMb={5} file={file} onFileChange={(f) => void onFile(f)} />
            )}
          </CardContent>
        </Card>
      )}

      {step === 'map' && workbook && mapping && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileSpreadsheet className="size-4 text-available" /> {file?.name}
                </CardTitle>
                <CardDescription>{formatNumber(dataRowCount)} data rows below the header</CardDescription>
              </div>
              <Button variant="ghost" size="sm" onClick={reset}>
                Choose another file
              </Button>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="imp-sheet">Worksheet</Label>
                <Select value={sheet} onValueChange={(v) => selectSheet(workbook, v)}>
                  <SelectTrigger id="imp-sheet">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {workbook.sheetNames.map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="imp-header">Header row</Label>
                <Input
                  id="imp-header"
                  type="number"
                  min={1}
                  max={Math.max(1, allRows.length)}
                  value={headerIndex + 1}
                  onChange={(e) => {
                    const h = Math.min(Math.max(1, Number(e.target.value) || 1), Math.max(1, allRows.length)) - 1
                    setHeaderIndex(h)
                    setMapping(autoMapColumns(allRows[h] ?? []))
                  }}
                />
                <p className="text-xs text-muted-foreground">Detected automatically; change it if the headers are elsewhere.</p>
              </div>
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Existing SKUs</legend>
                {(['skip', 'update', 'error'] as const).map((mode) => (
                  <label key={mode} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="dup-mode" checked={duplicateMode === mode} onChange={() => setDuplicateMode(mode)} className="accent-primary"
                      disabled={mode === 'update' && !canUpdate} />
                    {mode === 'skip' ? 'Skip rows whose SKU already exists' : mode === 'update' ? 'Update existing products (matched by SKU)' : 'Treat existing SKUs as errors'}
                  </label>
                ))}
                {duplicateMode === 'update' && <p className="text-xs text-muted-foreground">Only cells with a value are changed. You will see every change before saving.</p>}
              </fieldset>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Column mapping</CardTitle>
                <CardDescription>Match each product field to a spreadsheet column. Fields marked * are required.</CardDescription>
              </div>
            </CardHeader>
            {legacyQuantityColumns(allRows[headerIndex] ?? []).length > 0 && (
              <p role="status" className="mx-6 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Not imported: {legacyQuantityColumns(allRows[headerIndex] ?? []).join(', ')}. These earlier columns hold quantities; inventory planning now uses
                Lead Time (Days) and Reorder Level (Days), and a quantity is never read as a number of days.
              </p>
            )}
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {IMPORT_FIELDS.map((field) => (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={`map-${field.key}`}>
                    {field.label}
                    {field.required && <span className="text-shortage">*</span>}
                  </Label>
                  <Select
                    value={mapping[field.key] === null ? 'none' : String(mapping[field.key])}
                    onValueChange={(v) => setMapping({ ...mapping, [field.key]: v === 'none' ? null : Number(v) })}
                  >
                    <SelectTrigger id={`map-${field.key}`} aria-invalid={field.required && mapping[field.key] === null}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Not mapped —</SelectItem>
                      {split.headers.map((h, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {columnLetter(i)}: {h || '(blank header)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </CardContent>
            {missing.length > 0 && (
              <p className="mx-5 mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                Map the required fields: {missing.join(', ')}.
              </p>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Preview</CardTitle>
                <CardDescription>First 5 data rows as they will be read (nothing is saved yet)</CardDescription>
              </div>
            </CardHeader>
            <div className="mt-4">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Row</TableHead>
                    {IMPORT_FIELDS.filter((f) => mapping[f.key] !== null).map((f) => (
                      <TableHead key={f.key}>{f.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {split.data
                    .map((row, i) => ({ row, rowNumber: i + split.firstDataRowNumber }))
                    .filter(({ row }) => row.some((c) => c !== ''))
                    .slice(0, 5)
                    .map(({ row, rowNumber }) => (
                      <TableRow key={rowNumber}>
                        <TableCell className="tabular-nums text-muted-foreground">{rowNumber}</TableCell>
                        {IMPORT_FIELDS.filter((f) => mapping[f.key] !== null).map((f) => (
                          <TableCell key={f.key} className="max-w-48 truncate">
                            {row[mapping[f.key]!] ?? ''}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          <div className="flex justify-end">
            <Button onClick={() => void validate()} disabled={missing.length > 0 || busy !== null || categories.loading}>
              {busy === 'validating' ? <Loader2 className="animate-spin" /> : <ScanSearch />}
              Validate {formatNumber(dataRowCount)} rows
            </Button>
          </div>
        </div>
      )}

      {(step === 'review' || step === 'done') && (
        <div className="space-y-6">
          {step === 'done' && final && (
            <Card>
              <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-available" />
                  <div>
                    <p className="font-semibold">
                      Import finished: {formatNumber(final.imported)} created and {formatNumber(final.updated)} updated, of {formatNumber(summary.total)} rows
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatNumber(final.skipped)} skipped · {formatNumber(final.failed)} not imported because of errors.
                      {final.logError && ' (The import summary could not be written to the audit log or import history; each product was still audited.)'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={reset}>
                    <Upload />
                    Import another file
                  </Button>
                  <Button asChild>
                    <Link to="/products">View products</Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label="Total rows" value={formatNumber(summary.total)} icon={FileSpreadsheet} />
            <KpiCard label="Valid rows" value={formatNumber(summary.valid)} hint={`${formatNumber(summary.creates)} new · ${formatNumber(summary.updates)} updates · ${formatNumber(summary.withWarnings)} with warnings`} icon={CheckCircle2} accent="available" />
            {step === 'done' && final ? (
              <KpiCard label="Created / updated" value={`${formatNumber(final.imported)} / ${formatNumber(final.updated)}`} icon={CheckCircle2} accent="manufacturing" />
            ) : (
              <KpiCard label="Warnings" value={formatNumber(summary.withWarnings)} icon={Info} accent="pending" />
            )}
            <KpiCard label="Skipped" value={formatNumber(summary.skipped)} hint={duplicateMode === 'update' ? 'Existing SKUs with no changes' : 'Existing SKUs'} icon={Info} />
            <KpiCard label={step === 'done' ? 'Failed' : 'Errors'} value={formatNumber(step === 'done' && final ? final.failed : summary.errors)} icon={Info} accent="shortage" />
          </div>

          <DataTable
            title="Row results"
            columns={resultColumns}
            data={filteredResults}
            getRowId={(r) => String(r.rowNumber)}
            searchPlaceholder="Search row, SKU or message…"
            pageSize={25}
            toolbar={
              <>
                <FilterTabs<ResultFilter>
                  label="Result filter"
                  value={resultFilter}
                  onChange={setResultFilter}
                  options={[
                    { value: 'all', label: 'All' },
                    { value: 'error', label: 'Errors' },
                    { value: 'warning', label: 'Warnings' },
                    { value: 'skipped', label: 'Skipped' },
                    { value: 'valid', label: 'Valid' },
                  ]}
                />
                <Button variant="outline" size="sm" onClick={() => void downloadReport()}>
                  <Download />
                  Download report
                </Button>
              </>
            }
            emptyState={{ icon: Info, title: 'No rows in this view', description: 'Choose another filter.' }}
          />

          {step === 'review' && (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="outline" onClick={() => setStep('map')} disabled={busy !== null}>
                Back to mapping
              </Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={summary.valid === 0 || busy !== null}>
                {busy === 'importing' ? <Loader2 className="animate-spin" /> : <Upload />}
                {busy === 'importing'
                  ? `Importing… ${formatNumber(progress)} / ${formatNumber(summary.valid)}`
                  : summary.updates > 0
                    ? `Create ${formatNumber(summary.creates)} and update ${formatNumber(summary.updates)}`
                    : `Import ${formatNumber(summary.valid)} valid ${summary.valid === 1 ? 'product' : 'products'}`}
              </Button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={summary.updates > 0 ? `Create ${formatNumber(summary.creates)} and update ${formatNumber(summary.updates)} products?` : `Import ${formatNumber(summary.valid)} products?`}
        description={`${formatNumber(summary.creates)} new products will be created${summary.updates > 0
          ? ` and ${formatNumber(summary.updates)} existing products will be changed exactly as listed in the table (each change is recorded in the audit log)`
          : ''}. ${formatNumber(summary.errors)} rows with errors and ${formatNumber(summary.skipped)} skipped rows will not be imported. Stock is not affected.`}
        confirmLabel={summary.updates > 0 ? 'Save changes' : 'Import products'}
        onConfirm={() => void runImport()}
      />
    </>
  )
}
