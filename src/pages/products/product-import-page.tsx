import { CheckCircle2, ChevronRight, Download, FileSpreadsheet, Info, Loader2, ScanSearch, Upload } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { FileUploadPanel } from '@/components/common/file-upload-panel'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
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
  buildFailedRowsReport,
  detectHeaderRow,
  legacyQuantityColumns,
  missingRequiredFields,
  nameKey,
  productRowToFormValues,
  rowKind,
  splitAtHeader,
  summarizeImport,
  validateImportRows,
  type ColumnMapping,
  type DuplicateMode,
  type ExistingProduct,
  type ImportFieldKey,
  type ImportRowResult,
  type RowKind,
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
  findExistingNames,
  insertProducts,
  listCategories,
  logProductImport,
  updateProductsFromImport,
  type ProductUpdate,
} from '@/services/products'
import { fetchSupplierOptions } from '@/services/suppliers'

type Step = 'upload' | 'map' | 'review' | 'done'
type RowResult = ImportRowResult & { saveError?: string }

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
  // Smart import (new → added, changed → updated, unchanged → skipped) for users who may update products.
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>(() => (canUpdate ? 'update' : 'skip'))
  const [results, setResults] = useState<RowResult[]>([])
  const [busy, setBusy] = useState<null | 'reading' | 'validating' | 'importing'>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
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
        for (const p of await fetchProductsByIds([...existing.skuIds.values()], companyId)) {
          existingProducts.set(skuKey(p.sku), { id: p.id, sku: p.sku, values: productRowToFormValues(p), updatedAt: p.updated_at })
        }
      }
      const suppliers = mapping.preferred_supplier === null ? [] : await fetchSupplierOptions(true).catch(() => [])
      const eanOwners = await findExistingEans([...new Set(col('ean').map(normalizeEan))])
      // Rows without a SKU are new products: their names are checked against the product master.
      const unnamedSku = mapping.product_name === null ? [] : split.data
        .filter((r) => (mapping.sku === null || !(r[mapping.sku] ?? '').trim()) && (r[mapping.product_name!] ?? '').trim())
        .map((r) => r[mapping.product_name!])
      const existingNames = await findExistingNames(unnamedSku)
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
            existingNames,
            suppliers,
            duplicateMode,
          },
          split.firstDataRowNumber,
        ),
      )
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
      // A product without a SKU added meanwhile (e.g. the same file imported in another tab) is not created twice.
      const addedMeanwhile = await findExistingNames(creates.filter((r) => !r.input!.sku).map((r) => r.input!.product_name))
      const blocked = new Map<number, string>()
      creates.forEach((r, i) => {
        const sku = !r.input!.sku ? addedMeanwhile.get(nameKey(r.input!.product_name)) : undefined
        if (sku) blocked.set(i, `Not created: a product with this name was added meanwhile (SKU ${sku}).`)
      })
      const toInsert = creates.filter((_, i) => !blocked.has(i))
      const insertFailures = await insertProducts(companyId, toInsert.map((r) => r.input!), setProgress)
      const createFailures = new Map(blocked)
      for (const [i, message] of insertFailures) createFailures.set(creates.indexOf(toInsert[i]), message)
      const updateFailures = await updateProductsFromImport(
        changes.map((r) => ({ id: r.productId!, changes: r.input as ProductUpdate, expectedUpdatedAt: r.productUpdatedAt })),
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

  const downloadFailedRows = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Failed rows', rows: buildFailedRowsReport(results, split.headers, split.data, split.firstDataRowNumber) }],
      `product-import-failed-rows-${toIsoDate(new Date())}`, 'xlsx')
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
            ['Updating existing products', 'Rows are matched to existing products by SKU (spaces and capitals ignored). New SKUs are added, rows that match the stored product are skipped, and only the fields whose values differ are updated. Blank cells keep the stored value and the SKU is never changed. Every change is listed for review before saving.'],
            ['Export compatibility', `An export from the product list uses the columns: ${EXPORT_COLUMNS.join(', ')}. Correct it and import it again: only the changed values are saved.`],
          ],
        },
      ],
      'product-import-template',
      'xlsx',
    )
  }

  const summary = summarizeImport(results)
  // After saving, a row that could not be saved is listed with the failed rows.
  const groupOf = (r: RowResult): RowKind => (r.saveError ? 'invalid' : rowKind(r))
  const groups = { new: [] as RowResult[], modified: [] as RowResult[], skipped: [] as RowResult[], invalid: [] as RowResult[] }
  for (const r of results) groups[groupOf(r)].push(r)
  const done = step === 'done'

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
        Imports change product master records only; they never create, change or reserve stock. Rows are matched to existing products by
        SKU: new products are added, unchanged rows are skipped, and only changed fields are updated, after you have reviewed every change.
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
                <legend className="text-sm font-medium">Existing products</legend>
                {(['update', 'skip'] as const).map((mode) => (
                  <label key={mode} className="flex items-start gap-2 text-sm">
                    <input type="radio" name="dup-mode" value={mode} checked={duplicateMode === mode} onChange={() => setDuplicateMode(mode)} className="mt-1 accent-primary"
                      disabled={mode === 'update' && !canUpdate} />
                    {mode === 'update' ? 'Add new products and update changed ones (skip unchanged rows)' : 'Add new products only (leave existing products unchanged)'}
                  </label>
                ))}
                {duplicateMode === 'update' ? (
                  <p className="text-xs text-muted-foreground">Only fields whose values differ are updated; blank cells keep the stored value. You will see every change before saving.</p>
                ) : !canUpdate ? (
                  <p className="text-xs text-muted-foreground">You can add new products; updating existing products needs permission to edit the Product Master.</p>
                ) : null}
              </fieldset>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Column mapping</CardTitle>
                <CardDescription>Match each product field to a spreadsheet column. New products need a Product Name and a Product Type; existing products are matched by SKU.</CardDescription>
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
                  <Label htmlFor={`map-${field.key}`}>{field.label}</Label>
                  <Select
                    value={mapping[field.key] === null ? 'none' : String(mapping[field.key])}
                    onValueChange={(v) => setMapping({ ...mapping, [field.key]: v === 'none' ? null : Number(v) })}
                  >
                    <SelectTrigger id={`map-${field.key}`}>
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
                Map these columns to continue: {missing.join(', ')}.
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
          {done && final && (
            <Card>
              <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-available" />
                  <div>
                    <p className="font-semibold">
                      Import finished: {formatNumber(final.imported)} new {final.imported === 1 ? 'product' : 'products'} added and {formatNumber(final.updated)} existing{' '}
                      {final.updated === 1 ? 'product' : 'products'} updated, of {formatNumber(summary.total)} rows
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {formatNumber(final.skipped)} unchanged rows skipped · {formatNumber(final.failed)} failed.
                      {final.logError && ' (The import summary could not be written to the audit log or import history; each product was still audited.)'}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {final.failed > 0 && (
                    <Button variant="outline" onClick={() => void downloadFailedRows()}>
                      <Download />
                      Download failed rows
                    </Button>
                  )}
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

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="import-summary">
            <KpiCard label="Total Excel rows" value={formatNumber(summary.total)} icon={FileSpreadsheet} />
            <KpiCard label={done ? 'New products added' : 'New products'} value={formatNumber(done && final ? final.imported : summary.creates)} icon={CheckCircle2} accent="available" />
            <KpiCard label={done ? 'Products updated' : 'Modified products'} value={formatNumber(done && final ? final.updated : summary.updates)} icon={CheckCircle2} accent="manufacturing" />
            <KpiCard label="Unchanged — skipped" value={formatNumber(summary.skipped)} hint={duplicateMode === 'update' ? 'Same as the Product Master' : 'Existing SKUs left unchanged'} icon={Info} />
            <KpiCard label={done ? 'Failed rows' : 'Invalid rows'} value={formatNumber(done && final ? final.failed : summary.errors)} icon={Info} accent="shortage" />
          </div>

          <div className="space-y-3">
            <RowGroup kind="new" title={done ? 'Added' : 'New products'} rows={groups.new} defaultOpen={!done && groups.modified.length === 0}>
              {(rows) => (
                <SimpleRows rows={rows} lastHeader="Notes" last={(r) => r.warnings.length ? <Messages items={r.warnings} tone="warning" /> : <span className="text-muted-foreground">—</span>} />
              )}
            </RowGroup>
            <RowGroup kind="modified" title={done ? 'Updated' : 'Modified products'} rows={groups.modified} defaultOpen={!done}>
              {(rows) => <div className="space-y-4">{rows.map((r) => <ComparisonCard key={r.rowNumber} row={r} />)}</div>}
            </RowGroup>
            <RowGroup kind="skipped" title="Unchanged products — skipped" rows={groups.skipped}>
              {(rows) => (
                <SimpleRows rows={rows} lastHeader="Reason"
                  last={(r) => (r.skipReason === 'exists' ? 'SKU already exists — not changed (add new products only)' : 'No changes: the file matches the Product Master')} />
              )}
            </RowGroup>
            <RowGroup kind="invalid" title={done ? 'Failed rows' : 'Invalid rows'} rows={groups.invalid} defaultOpen
              action={groups.invalid.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => void downloadFailedRows()}>
                  <Download />
                  Download failed rows
                </Button>
              ) : undefined}>
              {(rows) => (
                <SimpleRows rows={rows} lastHeader="Error reasons" last={(r) => <Messages items={[...r.errors, ...(r.saveError ? [r.saveError] : [])]} tone="error" />} />
              )}
            </RowGroup>
          </div>

          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => void downloadReport()}>
              <Download />
              Download full report
            </Button>
          </div>

          {step === 'review' && (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="outline" onClick={() => setStep('map')} disabled={busy !== null}>
                Back to mapping
              </Button>
              <div className="flex flex-col items-end gap-1">
                {summary.valid === 0 && (
                  <p className="text-sm text-muted-foreground" role="status">Nothing to import: every row is unchanged or invalid.</p>
                )}
                <Button onClick={() => setConfirmOpen(true)} disabled={summary.valid === 0 || busy !== null}>
                  {busy === 'importing' ? <Loader2 className="animate-spin" /> : <Upload />}
                  {busy === 'importing'
                    ? `Importing… ${formatNumber(progress)} / ${formatNumber(summary.valid)}`
                    : summary.updates > 0
                      ? `Add ${formatNumber(summary.creates)} new and update ${formatNumber(summary.updates)}`
                      : `Import ${formatNumber(summary.valid)} new ${summary.valid === 1 ? 'product' : 'products'}`}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={summary.updates > 0 ? `Add ${formatNumber(summary.creates)} new and update ${formatNumber(summary.updates)} products?` : `Import ${formatNumber(summary.valid)} new products?`}
        description={`${formatNumber(summary.creates)} new products will be added${summary.updates > 0
          ? ` and ${formatNumber(summary.updates)} existing products will get only the changed fields listed above (each change is recorded in the audit log)`
          : ''}. ${formatNumber(summary.skipped)} unchanged rows are skipped and ${formatNumber(summary.errors)} invalid rows are not imported. Stock is not affected.`}
        confirmLabel={summary.updates > 0 ? 'Save changes' : 'Import products'}
        onConfirm={() => void runImport()}
      />
    </>
  )
}

const GROUP_STYLE: Record<RowKind, string> = {
  new: 'border-l-emerald-500',
  modified: 'border-l-blue-500',
  skipped: 'border-l-slate-300',
  invalid: 'border-l-amber-500',
}
const PAGE = 50

/** An expandable list of one kind of row; its rows are drawn only while open, 50 at a time. */
function RowGroup({ kind, title, rows, defaultOpen = false, action, children }: {
  kind: RowKind
  title: string
  rows: RowResult[]
  defaultOpen?: boolean
  action?: ReactNode
  children: (rows: RowResult[]) => ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen && rows.length > 0)
  const [shown, setShown] = useState(PAGE)
  return (
    <section className={cn('rounded-lg border border-l-4 bg-card', GROUP_STYLE[kind])} data-testid={`import-group-${kind}`} data-count={rows.length}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <button type="button" className="flex items-center gap-2 text-left font-medium" aria-expanded={open} onClick={() => setOpen(!open)} disabled={rows.length === 0}>
          <ChevronRight aria-hidden className={cn('size-4 transition-transform', open && 'rotate-90', rows.length === 0 && 'opacity-30')} />
          {title}
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground">{formatNumber(rows.length)}</span>
        </button>
        {action}
      </div>
      {open && rows.length > 0 && (
        <div className="border-t px-4 py-3">
          {children(rows.slice(0, shown))}
          {rows.length > shown && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShown(shown + PAGE)}>
              Show {formatNumber(Math.min(PAGE, rows.length - shown))} more of {formatNumber(rows.length - shown)}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

function SimpleRows({ rows, lastHeader, last }: { rows: RowResult[]; lastHeader: string; last: (r: RowResult) => ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-16">Row</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Product Name</TableHead>
            <TableHead>{lastHeader}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.rowNumber} data-row={r.rowNumber}>
              <TableCell className="tabular-nums text-muted-foreground">{r.rowNumber}</TableCell>
              <TableCell className="font-medium">{r.sku || <span className="text-muted-foreground">Automatic</span>}</TableCell>
              <TableCell>{r.productName || '—'}</TableCell>
              <TableCell className="whitespace-normal text-sm">{last(r)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function Messages({ items, tone }: { items: string[]; tone: 'error' | 'warning' }) {
  return (
    <ul className={cn('max-w-xl space-y-0.5 text-xs', tone === 'error' ? 'text-red-700' : 'text-amber-800')}>
      {items.map((m) => <li key={m}>{m}</li>)}
    </ul>
  )
}

/** Existing ERP value next to the Excel value for every field in the file; changed fields are highlighted. */
function ComparisonCard({ row }: { row: RowResult }) {
  const compared = row.compared ?? row.changes?.map((c) => ({ ...c, changed: true })) ?? []
  const changed = compared.filter((c) => c.changed).length
  return (
    <div className="rounded-md border" data-testid="import-comparison" data-sku={row.sku}>
      <p className="flex flex-wrap items-baseline gap-x-2 border-b bg-muted/40 px-3 py-2 text-sm">
        <span className="font-medium">{row.sku}</span>
        <span>{row.productName}</span>
        <span className="text-xs text-muted-foreground">Row {row.rowNumber} · {changed} {changed === 1 ? 'field changes' : 'fields change'}</span>
        {row.saveError && <span className="text-xs text-red-700">{row.saveError}</span>}
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Field</TableHead>
              <TableHead>Existing ERP value</TableHead>
              <TableHead>Excel value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {compared.map((c) => (
              <TableRow key={c.field} data-field={c.field} data-changed={c.changed ? 'true' : 'false'}
                className={cn(c.changed && 'bg-amber-50 font-medium hover:bg-amber-50 dark:bg-amber-950/30')}>
                <TableCell>
                  {c.label}
                  {c.changed && <span className="ml-2 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] uppercase text-amber-900">Changed</span>}
                </TableCell>
                <TableCell className={cn('tabular-nums', c.changed && 'text-muted-foreground line-through')}>{c.from}</TableCell>
                <TableCell className="tabular-nums">{c.to}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {row.warnings.length > 0 && <div className="border-t px-3 py-2"><Messages items={row.warnings} tone="warning" /></div>}
    </div>
  )
}
