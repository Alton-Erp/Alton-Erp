import { CheckCircle2, Download, FileSpreadsheet, Info, Loader2, ScanSearch, Upload } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatCost } from '@/features/products/product-list-format'
import { UNITS } from '@/features/products/product-model'
import {
  DEFAULT_IMPORT_FIELDS,
  OPENING_FIELDS,
  autoMapOpening,
  detectOpeningHeader,
  excelCostColumn,
  missingOpeningFields,
  existingOpeningIndex,
  ignoredCostColumns,
  openingMatchIndex,
  validateOpeningRows,
  type OpeningImportFieldSelection,
  type OpeningMapping,
  type OpeningProduct,
  type OpeningRowResult,
} from '@/features/inventory/opening-import'
import { MatchComparison, OpeningImportFieldsCard } from '@/features/inventory/opening-import-fields'
import { useStorage } from '@/features/inventory/use-storage'
import type { ParsedWorkbook } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import { requireSupabase } from '@/lib/supabase'
import { recordImportJob } from '@/services/admin'
import { fetchInventoryPolicy, fetchOpeningContext, fetchOpeningCosts, fetchOpeningImportMatches, importOpeningStock, postOpeningStockAtCost, submitOpeningStockAtCost } from '@/services/inventory'

type Step = 'upload' | 'map' | 'review' | 'done'
type Row = OpeningRowResult & { serverError?: string }

async function loadProducts(skus: string[]) {
  const map = new Map<string, OpeningProduct>()
  const db = requireSupabase()
  for (let i = 0; i < skus.length; i += 500) {
    const { data: ids, error } = await db.rpc('check_product_identifiers', { p_skus: skus.slice(i, i + 500), p_barcodes: [] })
    if (error) throw error
    const productIds = (ids ?? []).filter((r) => r.kind === 'sku').map((r) => r.product_id)
    if (productIds.length === 0) continue
    const { data, error: e2 } = await db.from('products').select('id, sku, product_name, base_unit, track_batches, track_expiry, status, default_source_type, product_type').in('id', productIds)
    if (e2) throw e2
    for (const p of data ?? []) map.set(p.sku.toLowerCase(), p)
  }
  return map
}

export default function OpeningStockImportPage() {
  const storage = useStorage()
  const { has } = usePermissions()
  const policy = useAsync(fetchInventoryPolicy, [])
  // V2 single-operator: a user who may approve posts the import in one step.
  const canPost = has('inventory_opening.approve') && !(policy.data?.segregation_of_duties ?? false)
  const { key, renew } = useRequestKey()
  const [searchParams] = useSearchParams()
  const retryOf = searchParams.get('retry')
  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [sheet, setSheet] = useState('')
  const [allRows, setAllRows] = useState<string[][]>([])
  const [headerIndex, setHeaderIndex] = useState(0)
  const [mapping, setMapping] = useState<OpeningMapping | null>(null)
  const [defaultDate, setDefaultDate] = useState('')
  const [results, setResults] = useState<Row[]>([])
  const [filter, setFilter] = useState<'all' | 'valid' | 'error'>('all')
  const [busy, setBusy] = useState<null | 'reading' | 'validating' | 'submitting'>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [submitted, setSubmitted] = useState<{ document: string | null; lines: number; added: number; kept: number } | null>(null)
  // Fields changed on existing opening stock (Excel import). Quantity is always added, never replaced.
  const [fields, setFields] = useState<OpeningImportFieldSelection>(DEFAULT_IMPORT_FIELDS)
  // false: the database does not have the additive import yet (migration 20261206090000): existing records are rejected as before.
  const [additive, setAdditive] = useState(true)

  const [browserToday] = useState(() => toIsoDate(new Date()))
  const today = policy.data?.today ?? browserToday
  const headers = allRows[headerIndex] ?? []
  const data = allRows.slice(headerIndex + 1)
  const missing = mapping ? missingOpeningFields(mapping) : []
  // Older templates had a Source column; it is no longer used and is never mapped.
  const ignoredSource = headers.filter((h) => /^(stock |actual )?source( type)?$/i.test(String(h ?? '').trim()))
  // A cost column in the file is never read: every row gets the Product Master Cost from the database.
  const ignoredCost = ignoredCostColumns(headers)
  const costCol = excelCostColumn(headers)
  const valid = results.filter((r) => r.status === 'valid')
  const invalid = results.filter((r) => r.status === 'error')
  const matched = results.filter((r) => r.action === 'add' || r.action === 'keep')
  const adding = valid.filter((r) => r.action === 'add')
  const posting = valid.filter((r) => r.action !== 'keep')
  const pendingCost = posting.filter((r) => r.cost === null).length
  // Imported quantity per unit: units are never added together.
  const byUnit = [...posting.reduce((m, r) => m.set(r.payload!.unit, Math.round(((m.get(r.payload!.unit) ?? 0) + r.payload!.quantity) * 1000) / 1000), new Map<string, number>())]
    .sort(([a], [b]) => a.localeCompare(b))
  const locationName = (id: string) => {
    const l = storage.locations.find((x) => x.id === id)
    return l ? `${storage.warehouseById.get(l.warehouse_id)?.warehouse_code ?? ''}/${l.location_code}` : '—'
  }

  const reset = () => {
    setStep('upload')
    setFile(null)
    setWorkbook(null)
    setAllRows([])
    setMapping(null)
    setResults([])
    setSubmitted(null)
    setError(null)
  }

  const selectSheet = (wb: ParsedWorkbook, name: string) => {
    const rows = wb.rows(name)
    const h = Math.max(0, detectOpeningHeader(rows))
    setSheet(name)
    setAllRows(rows)
    setHeaderIndex(h)
    setMapping(autoMapOpening(rows[h] ?? []))
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
      setWorkbook(wb)
      selectSheet(wb, wb.sheetNames[0])
      setDefaultDate(today)
      setStep('map')
    } catch {
      setFile(null)
      setError('This file could not be read. Use a valid .xlsx or .csv file.')
    } finally {
      setBusy(null)
    }
  }

  const validate = async () => {
    if (!mapping) return
    setError(null)
    const nonBlank = data.filter((r) => r.some((c) => c !== ''))
    if (nonBlank.length === 0) return setError('No data rows below the header.')
    if (nonBlank.length > 5000) return setError('Import at most 5,000 rows per file.')
    setBusy('validating')
    try {
      const skuCol = mapping.sku!
      const skus = [...new Set(data.map((r) => String(r[skuCol] ?? '').trim().toLowerCase()).filter(Boolean))]
      const products = await loadProducts(skus)
      // Opening balances already pending or posted: a second one for the same product, location and batch is rejected here, not only by the server.
      const ids = [...products.values()].map((p) => p.id)
      const { existing } = await fetchOpeningContext(ids)
      // Existing opening stock records to add to (null: the database does not support it yet).
      const matches = await fetchOpeningImportMatches(ids)
      setAdditive(matches !== null)
      // Product Master Cost of every matched product, from the database (never from the file).
      const { costs, overrideAllowed } = await fetchOpeningCosts(ids)
      const locations = storage.locations.map((l) => ({
        id: l.id,
        warehouseCode: storage.warehouseById.get(l.warehouse_id)?.warehouse_code ?? '',
        locationCode: l.location_code,
        active: l.status === 'ACTIVE' && storage.warehouseById.get(l.warehouse_id)?.status === 'ACTIVE',
        isDefault: l.is_default,
      }))
      const rows = validateOpeningRows(data, mapping, { products, locations, defaultEffectiveDate: defaultDate || today, today, existing: existingOpeningIndex(existing),
        costs: new Map([...costs.values()].map((c) => [c.product_id, { cost: c.cost, valid: c.valid }])),
        additive: matches === null ? undefined : { matches: openingMatchIndex(matches), fields, costColumn: fields.unit_cost ? costCol : null, overrideAllowed } }, headerIndex + 2)
      // Additions post at once: without the posting permission they cannot be staged for approval.
      setResults(canPost ? rows : rows.map((r) => (r.action === 'add' && r.status === 'valid'
        ? { ...r, status: 'error' as const, payload: null, errors: ['Adding to existing opening stock posts at once; it cannot be staged for approval. Ask a user who may post opening stock to import it.'] }
        : r)))
      setStep('review')
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const submit = async () => {
    setBusy('submitting')
    setError(null)
    try {
      // New records: the server sets the cost from the Product Master again, no cost is sent. Rows added to an
      // existing record send the Excel cost only when Unit Cost is selected (the server checks it again).
      const lines = valid.map((v) => ({ ...v.payload!, unit_cost: v.action === 'add' ? v.excelCost ?? null : null }))
      const r = additive
        ? await importOpeningStock(lines, fields, canPost, file?.name ?? null, key)
        : canPost
          ? await postOpeningStockAtCost(lines, 'IMPORT', file?.name ?? null, null, key)
          : await submitOpeningStockAtCost(lines, 'IMPORT', file?.name ?? null, null, key)
      const done = r.ok ? {
        document: r.document_number ?? null,
        lines: r.line_count ?? 0,
        added: 'additions' in r ? r.additions.length : 0,
        kept: 'kept' in r ? r.kept.length : 0,
        batch: r.opening_batch_id ?? null,
      } : null
      // Import history (Bulk Operations). Recording is best-effort; the opening stock itself is already handled.
      const byLineErr = new Map(r.ok ? [] : r.errors.map((e) => [e.line_no, e.message]))
      const rejected = results.filter((x) => x.status === 'error' || byLineErr.has(x.rowNumber))
      void recordImportJob({
        import_type: 'OPENING_STOCK', client_job_key: key, file_name: file?.name ?? null, source_id: done?.batch ?? null, source_reference: done?.document ?? null,
        total_rows: results.length, success_rows: done ? done.lines + done.added : 0, failed_rows: r.ok ? invalid.length : rejected.length, duplicate_rows: 0,
        skipped_rows: done ? done.kept : results.length - rejected.length, retry_of_job_id: retryOf, ...(r.ok ? {} : { status: 'REJECTED' }),
      }, rejected.map((x) => ({
        row_number: x.rowNumber, outcome: 'FAILED' as const, reference: x.sku || null, messages: [...x.errors, ...(byLineErr.has(x.rowNumber) ? [byLineErr.get(x.rowNumber)!] : [])],
        row_data: Object.fromEntries(headers.map((h, i) => [h || `Column ${i + 1}`, allRows[x.rowNumber - 1]?.[i] ?? ''])),
      }))).catch(() => undefined)
      if (!r.ok) {
        // The server re-validates every row; nothing was staged.
        const byLine = new Map(r.errors.map((e) => [e.line_no, e.message]))
        setResults(results.map((row) => (byLine.has(row.rowNumber) ? { ...row, serverError: byLine.get(row.rowNumber) } : row)))
        setError(`The server rejected ${r.errors.length} row(s). Nothing was posted or staged. Fix or remove those rows and validate again.`)
        renew()
      } else if (done) {
        setSubmitted(done)
        setStep('done')
        renew()
      }
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const downloadErrors = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets(
      [{ name: 'Rejected rows', rows: [['Row', 'Product Code', 'Product Name', 'Unit Cost', 'Errors', 'Warnings'], ...results.filter((r) => r.status === 'error' || r.serverError)
        .map((r) => [r.rowNumber, r.sku, r.productName ?? '', r.cost ?? '', [...r.errors, ...(r.serverError ? [r.serverError] : [])].join(' | '), r.warnings.join(' | ')])] }],
      `opening-stock-errors-${toIsoDate(new Date())}`,
      'xlsx',
    )
  }

  const downloadTemplate = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets(
      [
        { name: 'Opening stock', rows: [OPENING_FIELDS.map((f) => f.label)] },
        {
          name: 'Instructions',
          rows: [
            ['Column', 'How to fill it'],
            ['SKU', 'Product SKU from the product master (required)'],
            ['Warehouse', `Warehouse code (required): ${storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => w.warehouse_code).join(', ')}`],
            ['Location', 'Location code in that warehouse; blank = the warehouse default location'],
            ['Quantity', 'Physical quantity counted, in the product unit (up to 3 decimals)'],
            ['Unit', `Optional check; must equal the product unit (${UNITS.map((u) => u.code).join(', ')})`],
            ['Batch', 'Required for batch-tracked products, blank otherwise'],
            ['Manufacturing Date / Expiry Date', 'YYYY-MM-DD or DD-MM-YYYY; expiry required when the product tracks expiry'],
            ['(no cost column)', 'Optional and not needed. The unit cost is the Product Master Cost of each product, fetched when you validate; a cost or value column in the file is ignored. A product without a cost is accepted with a pending cost and is not valued (never imported at zero).'],
            ['Existing opening stock', 'A row whose product, location and batch already have posted opening stock ADDS its quantity to it (100 + 25 = 125); it never replaces it. A Unit Cost column is read for those rows only when "Unit Cost" is selected under "Fields to Modify in Existing Opening Stock", and must equal the existing cost.'],
            ['Effective Date', 'Optional; defaults to the date chosen during import; cannot be in the future'],
            ['Reference / Notes', 'Optional, e.g. the count sheet number'],
            ['(no Source column)', 'Not needed. A Source column in an older file is ignored.'],
          ],
        },
      ],
      'opening-stock-template',
      'xlsx',
    )
  }

  const shown = useMemo(() => results.filter((r) => (filter === 'all' ? true : filter === 'valid' ? r.status === 'valid' && !r.serverError : r.status === 'error' || Boolean(r.serverError))), [results, filter])
  const columns: DataTableColumn<Row>[] = [
    { id: 'row', header: 'Row', cell: (r) => r.rowNumber, sortValue: (r) => r.rowNumber },
    { id: 'sku', header: 'Product Code', cell: (r) => <span className="font-medium">{r.sku || '—'}</span>, searchValue: (r) => r.sku, sortValue: (r) => r.sku },
    { id: 'name', header: 'Product Name', cell: (r) => r.productName ?? '—', searchValue: (r) => r.productName ?? '' },
    { id: 'qty', header: 'Opening Quantity', align: 'right', cell: (r) => (r.quantity === undefined ? '—' : `${formatNumber(r.quantity)}${r.payload ? ` ${r.payload.unit}` : ''}`) },
    { id: 'cost', header: additive ? 'Unit Cost' : 'Product Master Cost', align: 'right', cell: (r) => <span data-testid="oi-cost">{r.cost === null || r.cost === undefined ? <span className="text-amber-800">Pending cost</span> : formatCost(r.cost)}</span>,
      sortValue: (r) => r.cost ?? -1 },
    { id: 'value', header: 'Opening Stock Value', align: 'right', cell: (r) => <span data-testid="oi-value">{r.value === null || r.value === undefined ? '—' : formatCost(r.value)}</span>,
      sortValue: (r) => r.value ?? -1 },
    ...(additive ? [{ id: 'action', header: 'Import Action', cell: (r: Row) => (
      <span data-testid="oi-action">{r.action === 'add' && r.match ? `Add to ${r.match.document_number ?? 'the record of an earlier row'} → ${formatNumber(r.match.newQuantity)} ${r.match.unit}`
        : r.action === 'keep' ? `Matches ${r.match?.document_number ?? 'an earlier row'}: no change` : r.action === 'new' ? 'New record' : '—'}</span>
    ) }] : []),
    { id: 'result', header: 'Validation Status', cell: (r) => (r.serverError || r.status === 'error' ? <StatusBadge label="Rejected" tone="danger" /> : r.warnings.length ? <StatusBadge label="Accepted · warning" tone="warning" /> : <StatusBadge label="Accepted" tone="success" />) },
    {
      id: 'msg',
      header: 'Messages',
      cell: (r) => (
        <ul className="max-w-xl space-y-0.5 whitespace-normal text-xs">
          {[...r.errors, ...(r.serverError ? [r.serverError] : [])].map((m) => <li key={m} className="text-red-700">{m}</li>)}
          {r.warnings.map((m) => <li key={m} className="text-amber-800">{m}</li>)}
        </ul>
      ),
      searchValue: (r) => [...r.errors, ...r.warnings].join(' '),
    },
  ]

  return (
    <>
      <PageHeader
        title="Import Opening Stock"
        description={canPost
          ? 'Import opening balances from a spreadsheet. Accepted rows are posted together as one document when you confirm.'
          : 'Stage opening balances from a spreadsheet. Nothing is posted until the import is approved; a staged import is approved or rejected as a whole.'}
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Opening Stock', to: '/inventory/opening-stock' }, { label: 'Import' }]}
        actions={<Button variant="outline" onClick={() => void downloadTemplate()}><Download /> Download template</Button>}
      />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        Uploading and previewing do not change stock. {canPost
          ? 'Accepted rows are posted as one opening-stock document when you confirm; rejected rows are never sent and can be downloaded as an error report.'
          : 'Accepted rows are staged as one opening-stock document for approval; rejected rows are never sent.'}
      </p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      {step === 'upload' && (
        <Card>
          <CardHeader><div><CardTitle>Select a file</CardTitle><CardDescription>.xlsx, .xls or .csv, up to 5 MB and 5,000 rows.</CardDescription></div></CardHeader>
          <CardContent>
            {busy === 'reading' ? <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading…</p>
              : <FileUploadPanel accept={['.xlsx', '.xls', '.csv']} maxSizeMb={5} file={file} onFileChange={(f) => void onFile(f)} />}
          </CardContent>
        </Card>
      )}

      {step === 'map' && workbook && mapping && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div><CardTitle className="flex items-center gap-2"><FileSpreadsheet className="size-4 text-available" /> {file?.name}</CardTitle></div>
              <Button variant="ghost" size="sm" onClick={reset}>Choose another file</Button>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5"><Label htmlFor="oi-sheet">Worksheet</Label>
                <Select value={sheet} onValueChange={(v) => selectSheet(workbook, v)}>
                  <SelectTrigger id="oi-sheet"><SelectValue /></SelectTrigger>
                  <SelectContent>{workbook.sheetNames.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent>
                </Select></div>
              <div className="space-y-1.5"><Label htmlFor="oi-header">Header row</Label>
                <Input id="oi-header" type="number" min={1} value={headerIndex + 1} onChange={(e) => { const h = Math.max(1, Number(e.target.value) || 1) - 1; setHeaderIndex(h); setMapping(autoMapOpening(allRows[h] ?? [])) }} /></div>
              <div className="space-y-1.5"><Label htmlFor="oi-date">Default effective date</Label>
                <Input id="oi-date" type="date" max={today} value={defaultDate} onChange={(e) => setDefaultDate(e.target.value)} /></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Column mapping</CardTitle><CardDescription>Fields marked * are required.</CardDescription></div></CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {OPENING_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`om-${f.key}`}>{f.label}{f.required && <span className="text-shortage">*</span>}</Label>
                  <Select value={mapping[f.key] === null ? 'none' : String(mapping[f.key])} onValueChange={(v) => setMapping({ ...mapping, [f.key]: v === 'none' ? null : Number(v) })}>
                    <SelectTrigger id={`om-${f.key}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">— Not mapped —</SelectItem>
                      {headers.map((h, i) => <SelectItem key={i} value={String(i)}>{h || `(column ${i + 1})`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </CardContent>
            {ignoredCost.length > 0 && <p data-testid="cost-ignored" className="mx-5 mb-3 text-sm text-muted-foreground">Column "{ignoredCost.join('", "')}" is ignored for new records: their unit cost is the Product Master Cost, fetched from the database.{fields.unit_cost && costCol !== null ? ` Column "${headers[costCol]}" is read only for rows added to existing opening stock.` : ''}</p>}
            {ignoredSource.length > 0 && <p data-testid="source-ignored" className="mx-5 mb-3 text-sm text-muted-foreground">Column "{ignoredSource[0]}" is not used for opening stock and will be ignored.</p>}
            {missing.length > 0 && <p className="mx-5 mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Map the required fields: {missing.join(', ')}.</p>}
          </Card>
          <OpeningImportFieldsCard fields={fields} onChange={setFields} costColumn={costCol === null ? null : headers[costCol] || `column ${costCol + 1}`} disabled={busy !== null} />
          <div className="flex justify-end">
            <Button disabled={missing.length > 0 || busy !== null || storage.loading} onClick={() => void validate()}>
              {busy === 'validating' ? <Loader2 className="animate-spin" /> : <ScanSearch />} Validate rows
            </Button>
          </div>
        </div>
      )}

      {(step === 'review' || step === 'done') && (
        <div className="space-y-6">
          {submitted && (
            <Card>
              <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 text-available" />
                  <div>
                    <p data-testid="oi-done" className="font-semibold">{[
                      submitted.document && (canPost ? `${submitted.document} posted with ${formatNumber(submitted.lines)} new line(s).` : `${submitted.document} staged with ${formatNumber(submitted.lines)} line(s), awaiting approval.`),
                      submitted.added > 0 && `Quantity added to existing opening stock on ${formatNumber(submitted.added)} row(s).`,
                      submitted.kept > 0 && `${formatNumber(submitted.kept)} matched row(s) left unchanged.`,
                      canPost && 'Stock is updated.',
                    ].filter(Boolean).join(' ')}</p>
                    <p className="text-sm text-muted-foreground">{formatNumber(invalid.length)} rejected row(s) were not sent.{canPost ? ' Download the error report, correct them and import them again.' : ' Stock changes only when an approver posts the document.'}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={reset}><Upload /> Import another file</Button>
                  <Button asChild><Link to="/inventory/opening-stock">Go to opening stock</Link></Button>
                </div>
              </CardContent>
            </Card>
          )}
          {additive && (
            <div data-testid="oi-totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard label="New records" value={formatNumber(valid.filter((r) => r.action === 'new').length)} icon={CheckCircle2} testId="oi-kpi-new" />
              <KpiCard label="Existing records matched" value={formatNumber(matched.length)} icon={ScanSearch} testId="oi-kpi-matched" />
              <KpiCard label="Rows adding quantity" value={formatNumber(adding.length)} icon={Upload} testId="oi-kpi-adding" />
              <KpiCard label="Rows with pending cost" value={formatNumber(pendingCost)} icon={Info} testId="oi-kpi-pending" />
              <div data-testid="oi-kpi-qty" className="rounded-xl border bg-card px-4 py-3 sm:col-span-2 xl:col-span-4">
                <p className="text-xs font-medium text-muted-foreground">Total imported quantity (per unit, never combined)</p>
                <p className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-lg font-semibold">{byUnit.length ? byUnit.map(([u, q]) => <span key={u}>{formatNumber(q)} {u}</span>) : '—'}</p>
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Excel rows" value={formatNumber(results.length)} icon={FileSpreadsheet} />
            <KpiCard label="Opening stock value (accepted)" value={formatCost(valid.reduce((sum, r) => sum + (r.value ?? 0), 0))} icon={CheckCircle2}
              hint={valid.some((r) => r.cost === null) ? `${formatNumber(valid.filter((r) => r.cost === null).length)} row(s) with a pending cost are not valued` : undefined} />
            <KpiCard label="Accepted" value={formatNumber(valid.length)} icon={CheckCircle2} accent="available" />
            <KpiCard label="Validation errors" value={formatNumber(invalid.length + results.filter((r) => r.serverError).length)} icon={Info} accent="shortage" />
          </div>
          {matched.length > 0 && (
            <DataTable
              title="Existing opening stock matched"
              columns={[
                { id: 'row', header: 'Row', cell: (r: Row) => r.rowNumber, sortValue: (r: Row) => r.rowNumber },
                { id: 'rec', header: 'Record', cell: (r: Row) => <span className="font-medium">{r.match?.document_number ?? 'Earlier row of this file'}</span>, searchValue: (r: Row) => `${r.sku} ${r.match?.document_number ?? ''}` },
                { id: 'cmp', header: 'Existing vs Excel', cell: (r: Row) => (r.payload
                  ? <MatchComparison row={r} fields={fields} location={locationName(r.payload.location_id)} />
                  : <ul className="space-y-0.5 whitespace-normal text-xs text-red-700">{[...r.errors, ...(r.serverError ? [r.serverError] : [])].map((m) => <li key={m}>{m}</li>)}</ul>) },
              ]}
              data={matched}
              getRowId={(r) => `m${r.rowNumber}`}
              pageSize={10}
              searchPlaceholder="Search SKU, record…"
              emptyState={{ icon: Info, title: 'No matched rows', description: 'No row matches existing opening stock.' }}
            />
          )}
          <DataTable
            title="Row results"
            columns={columns}
            data={shown}
            getRowId={(r) => String(r.rowNumber)}
            pageSize={25}
            searchPlaceholder="Search row, SKU, message…"
            toolbar={
              <>
                <FilterTabs label="Rows" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'valid', label: 'Accepted' }, { value: 'error', label: 'Rejected' }]} />
                <Button variant="outline" size="sm" onClick={() => void downloadErrors()}><Download /> Error report</Button>
              </>
            }
            emptyState={{ icon: Info, title: 'No rows in this view', description: 'Choose another filter.' }}
          />
          {step === 'review' && (
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('map')}>Back to mapping</Button>
              <Button disabled={valid.length === 0 || busy !== null || results.some((r) => r.serverError)} onClick={() => setConfirm(true)}>
                {busy === 'submitting' ? <Loader2 className="animate-spin" /> : <Upload />} {canPost ? `Post ${formatNumber(valid.length)} accepted row(s)` : `Stage ${formatNumber(valid.length)} accepted row(s) for approval`}
              </Button>
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={canPost ? `Post ${valid.length} opening stock line(s)?` : `Stage ${valid.length} opening stock line(s)?`}
        description={canPost
          ? `New records are posted as one opening-stock document${adding.length ? `; ${adding.length} row(s) add their quantity to existing opening stock (never replacing it)` : ''}. ${invalid.length} rejected row(s) are excluded. If any line cannot be posted, nothing is posted.`
          : `They will be submitted as one document awaiting approval. ${invalid.length} rejected row(s) are excluded. Stock does not change until an approver posts the document.`}
        confirmLabel={canPost ? 'Post opening stock' : 'Stage for approval'}
        onConfirm={() => void submit()}
      />
    </>
  )
}
