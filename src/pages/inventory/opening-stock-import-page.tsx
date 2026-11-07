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
import { UNITS } from '@/features/products/product-model'
import {
  OPENING_FIELDS,
  autoMapOpening,
  detectOpeningHeader,
  missingOpeningFields,
  existingOpeningIndex,
  validateOpeningRows,
  type OpeningMapping,
  type OpeningProduct,
  type OpeningRowResult,
} from '@/features/inventory/opening-import'
import { useStorage } from '@/features/inventory/use-storage'
import type { ParsedWorkbook } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import { requireSupabase } from '@/lib/supabase'
import { recordImportJob } from '@/services/admin'
import { fetchInventoryPolicy, fetchOpeningContext, postOpeningStock, submitOpeningStock } from '@/services/inventory'

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
    const { data, error: e2 } = await db.from('products').select('id, sku, base_unit, track_batches, track_expiry, status, default_source_type, product_type').in('id', productIds)
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
  const [submitted, setSubmitted] = useState<{ document: string; lines: number } | null>(null)

  const [browserToday] = useState(() => toIsoDate(new Date()))
  const today = policy.data?.today ?? browserToday
  const headers = allRows[headerIndex] ?? []
  const data = allRows.slice(headerIndex + 1)
  const missing = mapping ? missingOpeningFields(mapping) : []
  // Older templates had a Source column; it is no longer used and is never mapped.
  const ignoredSource = headers.filter((h) => /^(stock |actual )?source( type)?$/i.test(String(h ?? '').trim()))
  const valid = results.filter((r) => r.status === 'valid')
  const invalid = results.filter((r) => r.status === 'error')

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
      const { existing } = await fetchOpeningContext([...products.values()].map((p) => p.id))
      const locations = storage.locations.map((l) => ({
        id: l.id,
        warehouseCode: storage.warehouseById.get(l.warehouse_id)?.warehouse_code ?? '',
        locationCode: l.location_code,
        active: l.status === 'ACTIVE' && storage.warehouseById.get(l.warehouse_id)?.status === 'ACTIVE',
        isDefault: l.is_default,
      }))
      setResults(validateOpeningRows(data, mapping, { products, locations, defaultEffectiveDate: defaultDate || today, today, existing: existingOpeningIndex(existing) }, headerIndex + 2))
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
      const lines = valid.map((v) => v.payload!)
      const r = canPost
        ? await postOpeningStock(lines, 'IMPORT', file?.name ?? null, null, key)
        : await submitOpeningStock(lines, 'IMPORT', file?.name ?? null, null, key)
      // Import history (Bulk Operations). Recording is best-effort; the opening stock itself is already handled.
      const byLineErr = new Map(r.ok ? [] : r.errors.map((e) => [e.line_no, e.message]))
      const rejected = results.filter((x) => x.status === 'error' || byLineErr.has(x.rowNumber))
      void recordImportJob({
        import_type: 'OPENING_STOCK', client_job_key: key, file_name: file?.name ?? null, source_id: r.ok ? r.opening_batch_id : null, source_reference: r.ok ? r.document_number : null,
        total_rows: results.length, success_rows: r.ok ? r.line_count : 0, failed_rows: r.ok ? invalid.length : rejected.length, duplicate_rows: 0,
        skipped_rows: r.ok ? 0 : results.length - rejected.length, retry_of_job_id: retryOf, ...(r.ok ? {} : { status: 'REJECTED' }),
      }, rejected.map((x) => ({
        row_number: x.rowNumber, outcome: 'FAILED' as const, reference: x.sku || null, messages: [...x.errors, ...(byLineErr.has(x.rowNumber) ? [byLineErr.get(x.rowNumber)!] : [])],
        row_data: Object.fromEntries(headers.map((h, i) => [h || `Column ${i + 1}`, allRows[x.rowNumber - 1]?.[i] ?? ''])),
      }))).catch(() => undefined)
      if (!r.ok) {
        // The server re-validates every row; nothing was staged.
        const byLine = new Map(r.errors.map((e) => [e.line_no, e.message]))
        setResults(results.map((row) => (byLine.has(row.rowNumber) ? { ...row, serverError: byLine.get(row.rowNumber) } : row)))
        setError(`The server rejected ${r.errors.length} row(s) (e.g. opening stock already recorded). Nothing was staged. Fix or remove those rows and validate again.`)
        renew()
      } else {
        setSubmitted({ document: r.document_number, lines: r.line_count })
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
      [{ name: 'Rejected rows', rows: [['Row', 'SKU', 'Errors', 'Warnings'], ...results.filter((r) => r.status === 'error' || r.serverError).map((r) => [r.rowNumber, r.sku, [...r.errors, ...(r.serverError ? [r.serverError] : [])].join(' | '), r.warnings.join(' | ')])] }],
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
            ['Unit Cost', 'Optional; leave blank if unknown (never assumed to be zero)'],
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
    { id: 'sku', header: 'SKU', cell: (r) => <span className="font-medium">{r.sku || '—'}</span>, searchValue: (r) => r.sku, sortValue: (r) => r.sku },
    { id: 'qty', header: 'Quantity', align: 'right', cell: (r) => (r.payload ? `${r.payload.quantity} ${r.payload.unit}` : '—') },
    { id: 'result', header: 'Result', cell: (r) => (r.serverError || r.status === 'error' ? <StatusBadge label="Rejected" tone="danger" /> : r.warnings.length ? <StatusBadge label="Accepted · warning" tone="warning" /> : <StatusBadge label="Accepted" tone="success" />) },
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
            {ignoredSource.length > 0 && <p data-testid="source-ignored" className="mx-5 mb-3 text-sm text-muted-foreground">Column "{ignoredSource[0]}" is not used for opening stock and will be ignored.</p>}
            {missing.length > 0 && <p className="mx-5 mb-5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Map the required fields: {missing.join(', ')}.</p>}
          </Card>
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
                    <p className="font-semibold">{canPost
                      ? `${submitted.document} posted with ${formatNumber(submitted.lines)} line(s). Stock is updated.`
                      : `${submitted.document} staged with ${formatNumber(submitted.lines)} line(s), awaiting approval`}</p>
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
          <div className="grid gap-4 sm:grid-cols-3">
            <KpiCard label="Rows read" value={formatNumber(results.length)} icon={FileSpreadsheet} />
            <KpiCard label="Accepted" value={formatNumber(valid.length)} icon={CheckCircle2} accent="available" />
            <KpiCard label="Rejected" value={formatNumber(invalid.length + results.filter((r) => r.serverError).length)} icon={Info} accent="shortage" />
          </div>
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
          ? `They will be added to stock as one opening-stock document. ${invalid.length} rejected row(s) are excluded. If any line cannot be posted, nothing is posted.`
          : `They will be submitted as one document awaiting approval. ${invalid.length} rejected row(s) are excluded. Stock does not change until an approver posts the document.`}
        confirmLabel={canPost ? 'Post opening stock' : 'Stage for approval'}
        onConfirm={() => void submit()}
      />
    </>
  )
}
