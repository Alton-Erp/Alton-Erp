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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EXPORT_COLUMNS } from '@/features/products/product-export'
import { ImportImagePreview } from '@/features/products/import-image-preview'
import {
  IMPORT_FIELDS,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  autoMapColumns,
  buildErrorReport,
  buildFailedRowsReport,
  detectHeaderRow,
  identityMaps,
  isMatchKey,
  matchColumn,
  matchIds,
  matchKeyLabel,
  matchValue,
  costColumnNote,
  legacyQuantityColumns,
  missingRequiredFields,
  modifiableFields,
  newProductConflict,
  productRowToFormValues,
  rowKind,
  splitAtHeader,
  summarizeImages,
  summarizeImport,
  validateImportRows,
  type ColumnMapping,
  type DuplicateMode,
  type ExistingProduct,
  type ImportFieldKey,
  type ImportRowResult,
  type MatchKey,
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
  fetchImportMatchKey,
  fetchProductIdentities,
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
  // Fields to modify in existing products: every mapped column unless unticked (kept as the unticked set,
  // so a column mapped later starts ticked).
  const [unticked, setUnticked] = useState<Set<ImportFieldKey>>(() => new Set(['sku']))
  // Field that finds existing products (ERP Settings → Products); SKU until the setting exists.
  const matchKeyQ = useAsync(fetchImportMatchKey, [])
  const matchKey: MatchKey = isMatchKey(matchKeyQ.data) ? matchKeyQ.data : 'SKU'
  const keyLabel = matchKeyLabel(matchKey)
  const keyCol = matchColumn(matchKey)
  const byOther = matchKey !== 'SKU' && matchKey !== 'NONE'
  // A new SKU whose name is already in the ERP is added as a separate product only when the user says so.
  const [allowSameName, setAllowSameName] = useState(false)
  const [results, setResults] = useState<RowResult[]>([])
  const [busy, setBusy] = useState<null | 'reading' | 'validating' | 'importing'>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [final, setFinal] = useState<{ imported: number; updated: number; skipped: number; failed: number; logError: boolean } | null>(null)
  const [importKey, setImportKey] = useState(() => crypto.randomUUID())

  const split = useMemo(() => splitAtHeader(allRows, headerIndex), [allRows, headerIndex])
  const dataRowCount = split.data.filter((r) => r.some((c) => c !== '')).length
  // No match key: the import only adds new products.
  const mode: DuplicateMode = matchKey === 'NONE' ? 'skip' : duplicateMode
  const missing = mapping ? missingRequiredFields(mapping, mode, matchKey) : []
  const modifiable = mapping ? modifiableFields(mapping, matchKey) : []
  const modifyFields = new Set(modifiable.filter((f) => !unticked.has(f.key)).map((f) => f.key))
  const notModified = modifiable.filter((f) => unticked.has(f.key)).map((f) => f.label)
  const modifyLabels = modifiable.filter((f) => modifyFields.has(f.key)).map((f) => f.label)

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
    setUnticked(new Set(['sku']))
    setAllowSameName(false)
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

  const validate = async (sameName = allowSameName) => {
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
      if (mode === 'update' && matchKey === 'SKU' && existing.skuIds.size > 0) {
        for (const p of await fetchProductsByIds([...existing.skuIds.values()], companyId)) {
          existingProducts.set(skuKey(p.sku), { id: p.id, sku: p.sku, values: productRowToFormValues(p), updatedAt: p.updated_at, imagePath: p.product_image_path })
        }
      }
      const suppliers = mapping.preferred_supplier === null ? [] : await fetchSupplierOptions(true).catch(() => [])
      const eanOwners = await findExistingEans([...new Set(col('ean').map(normalizeEan))])
      // Every SKU and name of the company: new rows must not repeat a name or a near-identical SKU.
      const identityRows = await fetchProductIdentities(companyId)
      const identities = identityMaps(identityRows)
      // Another match key: the stored products whose value appears in the file (several = ambiguous, reported).
      const matchIndex = new Map<string, ExistingProduct[]>()
      if (byOther && keyCol && mapping[keyCol] !== null) {
        const ids = matchIds(identityRows, matchKey)
        const wanted = new Set(split.data.map((r) => matchValue(matchKey, r[mapping[keyCol]!])).filter(Boolean))
        const needed = [...new Set([...wanted].flatMap((v) => ids.get(v) ?? []))]
        const rowsById = new Map((needed.length ? await fetchProductsByIds(needed, companyId) : []).map((p) => [p.id, p]))
        for (const v of wanted) {
          const list = (ids.get(v) ?? []).map((id) => rowsById.get(id)).filter((p): p is NonNullable<typeof p> => Boolean(p))
          if (list.length) matchIndex.set(v, list.map((p) => ({ id: p.id, sku: p.sku, values: productRowToFormValues(p), updatedAt: p.updated_at, imagePath: p.product_image_path })))
        }
      }
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
            existingNames: identities.existingNames,
            looseSkus: identities.looseSkus,
            modifyFields,
            allowSameName: sameName,
            suppliers,
            duplicateMode: mode,
            matchKey,
            matchIndex,
            skuOwners: identities.skuIds,
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
      // Second duplicate check, just before saving: a SKU or name added meanwhile (another user, another tab,
      // the same file imported twice) is never created again. The database's unique SKU index is the last guard.
      const now = identityMaps(await fetchProductIdentities(companyId))
      const blocked = new Map<number, string>()
      creates.forEach((r, i) => {
        const conflict = newProductConflict(r.input!, now, allowSameName)
        if (conflict) blocked.set(i, conflict)
      })
      const toInsert = creates.filter((_, i) => !blocked.has(i))
      const insertFailures = await insertProducts(companyId, toInsert.map((r) => r.input!), setProgress)
      const createFailures = new Map(blocked)
      for (const [i, message] of insertFailures) createFailures.set(creates.indexOf(toInsert[i]), message)
      const updateFailures = await updateProductsFromImport(
        changes.map((r) => ({ id: r.productId!, changes: r.input as ProductUpdate, expectedUpdatedAt: r.productUpdatedAt, allowSkuChange: byOther })),
        (n) => setProgress(creates.length + n),
        companyId,
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
    // Earlier cost columns are still read, but the template has only Cost.
    const header = IMPORT_FIELDS.filter((f) => !('legacy' in f)).map((f) => f.label)
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
            ['Unit', `${UNITS.map((u) => u.code).join(', ')} (names such as Litres or Rolls also work). Optional: PCS when blank. An existing product keeps its unit code when the file names the same unit.`],
            ['Category', `Name or code of an active category: ${(categories.data ?? []).filter((c) => c.is_active).map((c) => c.name).join(', ')}`],
            ['HSN Code', '4, 6 or 8 digits (optional)'],
            ['GST Rate', `Percentage 0–100 (optional). Common rates: ${STANDARD_GST_RATES.join(', ')}`],
            ['Prices and costs', 'Non-negative, up to 2 decimals (optional)'],
            ['Cost', 'The standard (fallback) cost per unit, optional and non-negative. The Product Master shows it as Cost until the product has two valid purchase receipts, then the second-most-recent receipt cost. In an exported file the Standard Manufacturing Cost column is read instead of the calculated Cost. Last Purchase Cost and Last Purchase Date are never imported: they come from posted GRNs.'],
            ['MRP', 'Maximum retail price in ₹ incl. taxes, non-negative, up to 2 decimals (optional). Kept separate from the selling price.'],
            ['Lead Time (Days) / Reorder Level (Days)', 'Number of days from 0 to 3650, up to 2 decimals (optional). Reorder when the days of stock cover fall to the reorder level. Quantity columns of earlier templates (Reorder Level, Minimum Stock Level) are not imported.'],
            ['Length / Width / Height (cm)', 'Positive size in centimetres, up to 2 decimals (optional)'],
            ['Supplier Model No. / Supplier Product Name', 'The supplier\'s own model number and name (optional). The SKU and product name are not changed by them.'],
            ['Manufacturable', 'Yes or No (optional)'],
            ['Preferred Supplier', 'Supplier code or name of an active supplier (optional). Unknown suppliers are reported and left blank.'],
            ['Image Link', 'Optional http:// or https:// link to a product image (also recognised as Image URL, Product Image, Image, Photo URL, Picture URL). For existing products it is changed only when Image Link is ticked under Fields to Modify; a blank cell never removes an image and an invalid link is reported and not saved. Never used to find products.'],
            ['Updating existing products', 'Rows are matched to existing products by SKU (spaces and capitals ignored). New SKUs are added, rows that match the stored product are skipped, and only the fields ticked under "Fields to Modify in Existing Products" whose values differ are updated. Blank cells keep the stored value and the SKU is never changed. A SKU that differs from a stored one only by spaces or separators, or a new product whose name is already used, is reported as a duplicate and not saved. Every change is listed for review before saving.'],
            ['Export compatibility', `An export from the product list uses the columns: ${EXPORT_COLUMNS.join(', ')}. Correct it and import it again: only the changed values are saved.`],
          ],
        },
      ],
      'product-import-template',
      'xlsx',
    )
  }

  const summary = summarizeImport(results)
  const imageSummary = summarizeImages(results)
  // After saving, a row that could not be saved is listed with the failed rows.
  const groupOf = (r: RowResult): RowKind => (r.saveError ? (r.saveError.startsWith('Not created:') ? 'ambiguous' : 'invalid') : rowKind(r))
  const groups = { new: [] as RowResult[], modified: [] as RowResult[], skipped: [] as RowResult[], ambiguous: [] as RowResult[], invalid: [] as RowResult[] }
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
        Imports change product master records only; they never create, change or reserve stock. {matchKey === 'NONE'
          ? ' Matching is switched off in ERP Settings → Products, so new products are added and existing products are never changed.'
          : <> Rows are matched to existing products by <b data-testid="match-key">{keyLabel}</b> (ERP Settings → Products): new products are added, unchanged rows are
            skipped, and only the selected, changed fields are updated, after you have reviewed every change.</>}
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
                {(['update', 'skip'] as const).map((m) => (
                  <label key={m} className="flex items-start gap-2 text-sm">
                    <input type="radio" name="dup-mode" value={m} checked={mode === m} onChange={() => setDuplicateMode(m)} className="mt-1 accent-primary"
                      disabled={m === 'update' && (!canUpdate || matchKey === 'NONE')} />
                    {m === 'update' ? 'Add new products and update changed ones (skip unchanged rows)' : 'Add new products only (leave existing products unchanged)'}
                  </label>
                ))}
                {matchKey === 'NONE' ? (
                  <p className="text-xs text-muted-foreground">The match key is None (ERP Settings → Products): existing products cannot be updated by an import.</p>
                ) : mode === 'update' ? (
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
                <CardDescription>Match each product field to a spreadsheet column. New products need a Product Name and a Product Type{matchKey === 'NONE' ? '.' : `; existing products are matched by ${keyLabel}.`}</CardDescription>
              </div>
            </CardHeader>
            {costColumnNote(mapping) && (
              <p role="status" className="mx-6 mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900" data-testid="import-cost-note">
                {costColumnNote(mapping)}
              </p>
            )}
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
            {mode === 'update' && keyCol && mapping[keyCol] === null && (
              <p role="alert" className="mx-5 mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="sku-unmapped">
                The {keyLabel} column (the match key) is not mapped, so no row can be matched to an existing product: every row is treated as a new
                product, and rows whose SKU or name is already in the Product Master are reported as duplicates. Map the {keyLabel} column to update
                existing products.
              </p>
            )}
          </Card>

          {mode === 'update' && (
            <Card data-testid="modify-fields">
              <CardHeader>
                <div>
                  <CardTitle>Fields to Modify in Existing Products</CardTitle>
                  <CardDescription>
                    Existing products (matched by {keyLabel}, set in ERP Settings → Products) get only the ticked fields, and only where the Excel value
                    differs. Unticked fields keep their stored value, blank cells never erase data, and the {keyLabel} is never changed. New products use
                    every mapped column.{byOther && ' The SKU can be changed only while the product has no transactions.'}
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {modifiable.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Map product columns above to choose which fields may change.</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium tabular-nums" data-testid="modify-count">
                        {formatNumber(modifyFields.size)} of {formatNumber(modifiable.length)} fields selected
                      </span>
                      {keyCol && mapping[keyCol] !== null && <span className="text-xs text-muted-foreground">+ {keyLabel} (used to match, never changed)</span>}
                      <Button type="button" size="sm" variant="outline" onClick={() => setUnticked(new Set())} disabled={modifyFields.size === modifiable.length}>
                        Select All
                      </Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setUnticked(new Set(modifiable.map((f) => f.key)))} disabled={modifyFields.size === 0}>
                        Deselect All
                      </Button>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                      {/* The match key finds the existing product, so it is always used and never changed by the import. */}
                      {keyCol && (
                        <label className="flex items-center gap-2 text-sm text-muted-foreground"
                          title={mapping[keyCol] === null ? `Map the ${keyLabel} column to match existing products` : 'Used to find the existing product; never changed by the import. Change the match key in ERP Settings → Products.'}>
                          <Checkbox checked={mapping[keyCol] !== null} disabled data-testid="modify-sku" data-field={keyCol} aria-label={`${keyLabel} (match key, never changed)`} />
                          <span>
                            <span className="font-medium text-foreground">{keyLabel}</span>{' '}
                            {mapping[keyCol] === null ? '— not mapped' : '— match key (locked)'}
                          </span>
                        </label>
                      )}
                      {modifiable.map((f) => (
                        <label key={f.key} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={modifyFields.has(f.key)}
                            data-testid="modify-field"
                            data-field={f.key}
                            onCheckedChange={(v) => setUnticked((prev) => {
                              const next = new Set(prev)
                              if (v === true) next.delete(f.key)
                              else next.add(f.key)
                              return next
                            })}
                          />
                          {f.label}
                        </label>
                      ))}
                    </div>
                    {modifyFields.size === 0 && (
                      <p role="status" className="text-sm text-amber-800">No field is selected: existing products will not be changed; only new products are added.</p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

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
                      {formatNumber(final.skipped)} unchanged rows skipped · {formatNumber(groups.ambiguous.length)} duplicate or ambiguous ·{' '}
                      {formatNumber(groups.invalid.length)} failed.
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

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6" data-testid="import-summary">
            <KpiCard label="Total Excel rows" value={formatNumber(summary.total)} icon={FileSpreadsheet} />
            <KpiCard label={done ? 'New products added' : 'New products'} value={formatNumber(done && final ? final.imported : summary.creates)} icon={CheckCircle2} accent="available" />
            <KpiCard label={done ? 'Products updated' : 'Modified products'} value={formatNumber(done && final ? final.updated : summary.updates)} icon={CheckCircle2} accent="manufacturing" />
            <KpiCard label="Unchanged — skipped" value={formatNumber(summary.skipped)} hint={mode === 'update' ? 'Same as the Product Master' : 'Existing products left unchanged'} icon={Info} />
            <KpiCard label="Duplicate / ambiguous" value={formatNumber(summary.ambiguous)} hint="Not saved: needs your decision" icon={Info} accent="shortage" />
            <KpiCard label={done ? 'Failed rows' : 'Invalid rows'} value={formatNumber(groups.invalid.length)} icon={Info} accent="shortage" />
          </div>

          <ImportImagePreview results={results} keyLabel={matchKey === 'NONE' || !keyCol ? 'SKU' : keyLabel}
            identifier={(r) => (byOther && keyCol && mapping && mapping[keyCol] !== null ? String(split.data[r.rowNumber - split.firstDataRowNumber]?.[mapping[keyCol]!] ?? '').trim() : r.sku)} />

          <div className="space-y-3">
            <RowGroup kind="new" title={done ? 'Added' : 'New products'} rows={groups.new} defaultOpen={!done && groups.modified.length === 0}>
              {(rows) => (
                <SimpleRows rows={rows} lastHeader="Notes" last={(r) => r.warnings.length ? <Messages items={r.warnings} tone="warning" /> : <span className="text-muted-foreground">—</span>} />
              )}
            </RowGroup>
            <RowGroup kind="modified" title={done ? 'Updated' : 'Existing products to modify'} rows={groups.modified} defaultOpen={!done}>
              {(rows) => <div className="space-y-4">{rows.map((r) => <ComparisonCard key={r.rowNumber} row={r} notModified={notModified} />)}</div>}
            </RowGroup>
            <RowGroup kind="skipped" title="Unchanged products — skipped" rows={groups.skipped}>
              {(rows) => (
                <SimpleRows rows={rows} lastHeader="Reason"
                  last={(r) => (r.skipReason === 'exists' ? `Already in the Product Master — not changed (${matchKey === 'NONE' ? 'match key: None' : 'add new products only'})`
                    : r.skipReason === 'no-fields' ? 'No fields selected to modify — existing product not changed'
                    : 'No changes in the selected fields: the file matches the Product Master')} />
              )}
            </RowGroup>
            <RowGroup kind="ambiguous" title="Duplicate / ambiguous products" rows={groups.ambiguous} defaultOpen
              action={step === 'review' && (allowSameName || groups.ambiguous.some((r) => r.errors.some((e) => e.includes('allow separate products')))) ? (
                <label className="flex items-center gap-2 text-sm" title="Only for rows with a new SKU whose name is already used by another product">
                  <Checkbox data-testid="allow-same-name" checked={allowSameName} disabled={busy !== null}
                    onCheckedChange={(v) => { setAllowSameName(v === true); void validate(v === true) }} />
                  New SKUs with an existing name are different products — add them
                </label>
              ) : undefined}>
              {(rows) => (
                <SimpleRows rows={rows} lastHeader="Why it is not saved" last={(r) => <Messages items={[...r.errors, ...(r.saveError ? [r.saveError] : [])]} tone="error" />} />
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
        description={
          <span className="block space-y-2" data-testid="import-confirm">
            <span className="block">Please confirm what will be saved:</span>
            <span className="block tabular-nums">
              New products to add: <b>{formatNumber(summary.creates)}</b><br />
              Existing products to modify: <b>{formatNumber(summary.updates)}</b><br />
              Unchanged products to skip: <b>{formatNumber(summary.skipped)}</b><br />
              Duplicate or ambiguous rows (not saved): <b>{formatNumber(summary.ambiguous)}</b><br />
              Invalid rows (not saved): <b>{formatNumber(summary.errors)}</b>
            </span>
            {imageSummary.mapped && (
              <span className="block tabular-nums" data-testid="import-confirm-images">
                Images to add: <b>{formatNumber(imageSummary.add)}</b> · to update: <b>{formatNumber(imageSummary.update)}</b> · unchanged: <b>{formatNumber(imageSummary.unchanged)}</b>
                {' '}· invalid links (not saved): <b>{formatNumber(imageSummary.invalid)}</b> · blank (images kept): <b>{formatNumber(imageSummary.blank)}</b>
              </span>
            )}
            {summary.updates > 0 && (
              <span className="block">
                Fields that may change in existing products: {modifyLabels.join(', ') || 'none'}. Only the changes listed above are saved and each is
                recorded in the audit log. {notModified.length > 0 && `Not modified: ${notModified.join(', ')}.`} Products are matched by {keyLabel}, which is never changed.
              </span>
            )}
            <span className="block">Matching is checked again just before saving. Stock is not affected.</span>
          </span>
        }
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
  ambiguous: 'border-l-orange-500',
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

const ACTION_LABEL = { update: 'Update', unchanged: 'Unchanged', blank: 'Kept (blank cell)' } as const

/** Existing ERP value, Excel value and action for every selected field; changed fields are highlighted. */
function ComparisonCard({ row, notModified }: { row: RowResult; notModified: string[] }) {
  const compared = row.compared ?? row.changes?.map((c) => ({ ...c, changed: true, action: 'update' as const })) ?? []
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
              <TableHead>Action</TableHead>
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
                <TableCell className={cn('tabular-nums', c.action === 'blank' && 'text-muted-foreground italic')}>{c.to}</TableCell>
                <TableCell data-testid="field-action">{ACTION_LABEL[c.action]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {notModified.length > 0 && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground" data-testid="not-modified">
          Not selected — kept unchanged: {notModified.join(', ')}.
        </p>
      )}
      {row.warnings.length > 0 && <div className="border-t px-3 py-2"><Messages items={row.warnings} tone="warning" /></div>}
    </div>
  )
}
