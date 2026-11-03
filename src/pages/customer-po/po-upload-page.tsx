import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileWarning, Info, Loader2, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FileUploadPanel } from '@/components/common/file-upload-panel'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { AvailabilityBadge, LineStatusBadge } from '@/features/customer-po/po-badges'
import { exportRows } from '@/features/customer-po/export-utils'
import {
  MATCH_METHOD_LABELS,
  MAX_PO_FILE_MB,
  MAX_PO_ROWS,
  PO_FIELDS,
  PO_FILE_TYPES,
  STATUS_REASON_LABELS,
  autoMapPo,
  checkPoFile,
  detectPoHeader,
  fileFingerprint,
  missingPoFields,
  validatePoRows,
  type PoMapping,
  type PoRowResult,
} from '@/features/customer-po/po-import'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import type { ParsedWorkbook } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatFileSize, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchCustomers, importPo, previewPo, type ImportResult, type PoHeaderInput, type PoPreview, type PreviewLine } from '@/services/customer-po'

const STEPS = ['Upload', 'Select Sheet', 'Map Columns', 'Match Products', 'Analyze Stock', 'Review Allocation', 'Confirm'] as const
type StepIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

function Stepper({ step }: { step: StepIndex }) {
  return (
    <ol aria-label="Import progress" className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === step ? 'step' : undefined}
          className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium',
            i === step ? 'border-primary bg-accent text-accent-foreground' : i < step ? 'bg-background text-green-700' : 'bg-background text-muted-foreground')}>
          <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full text-[11px]',
            i < step ? 'bg-green-100 text-green-700' : i === step ? 'bg-primary text-primary-foreground' : 'bg-gray-100')}>{i < step ? '✓' : i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  )
}

const EXTERNAL = '__external__'

export default function PoUploadPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const customers = useAsync(() => fetchCustomers(false), [])
  const { key, renew } = useRequestKey()

  const [step, setStep] = useState<StepIndex>(0)
  const [file, setFile] = useState<File | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [workbook, setWorkbook] = useState<ParsedWorkbook | null>(null)
  const [sheet, setSheet] = useState('')
  const [allRows, setAllRows] = useState<string[][]>([])
  const [headerIndex, setHeaderIndex] = useState(0)
  const [mapping, setMapping] = useState<PoMapping | null>(null)
  const [customerChoice, setCustomerChoice] = useState('')
  const [externalName, setExternalName] = useState('')
  const [poNumber, setPoNumber] = useState('')
  const [poDate, setPoDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [currency, setCurrency] = useState('')
  const [warehouseId, setWarehouseId] = useState('all')
  const [notes, setNotes] = useState('')
  const [results, setResults] = useState<PoRowResult[]>([])
  const [fileIssues, setFileIssues] = useState<string[]>([])
  const [preview, setPreview] = useState<PoPreview | null>(null)
  const [busy, setBusy] = useState<null | 'reading' | 'matching' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<null | 'new' | 'revision'>(null)
  const [outcome, setOutcome] = useState<ImportResult | null>(null)

  const headers = allRows[headerIndex] ?? []
  const data = allRows.slice(headerIndex + 1)
  const valid = results.filter((r) => r.status === 'valid')
  const invalid = results.filter((r) => r.status === 'error')

  const header: PoHeaderInput = {
    customer_id: customerChoice && customerChoice !== EXTERNAL ? customerChoice : null,
    customer_name: customerChoice === EXTERNAL ? externalName.trim() : null,
    customer_po_number: poNumber.trim(),
    po_date: poDate,
    required_delivery_date: dueDate || null,
    currency: currency.trim().toUpperCase() || null,
    notes: notes.trim() || null,
    fulfilment_warehouse_id: warehouseId === 'all' ? null : warehouseId,
  }

  const reset = () => {
    setStep(0)
    setFile(null)
    setHash(null)
    setWorkbook(null)
    setAllRows([])
    setMapping(null)
    setResults([])
    setPreview(null)
    setOutcome(null)
    setError(null)
  }

  const chooseSheet = (wb: ParsedWorkbook, name: string) => {
    const rows = wb.rows(name)
    const h = Math.max(0, detectPoHeader(rows))
    setSheet(name)
    setAllRows(rows)
    setHeaderIndex(h)
    setMapping(autoMapPo(rows[h] ?? []))
  }

  const onFile = async (f: File | null) => {
    setError(null)
    if (!f) return reset()
    const problem = checkPoFile(f.name, f.size)
    if (problem) return setError(problem)
    setBusy('reading')
    try {
      const buffer = await f.arrayBuffer()
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(buffer)
      if (wb.sheetNames.length === 0) throw new Error('empty')
      setHash(await fileFingerprint(buffer))
      setFile(f)
      setWorkbook(wb)
      chooseSheet(wb, wb.sheetNames[0])
      setStep(1)
    } catch {
      setError('This file could not be read. Use a valid .xlsx, .xls or .csv file (macros and embedded content are never run).')
    } finally {
      setBusy(null)
    }
  }

  // Step 3 → 4: client validation, then server matching + availability preview.
  const validateAndMatch = async () => {
    if (!mapping) return
    setError(null)
    const missing = missingPoFields(mapping)
    if (missing.length) return setError(`Map ${missing.join(' and ')}.`)
    const nonBlank = data.filter((r) => r.some((c) => c !== ''))
    if (nonBlank.length === 0) return setError('There are no data rows below the header row.')
    if (nonBlank.length > MAX_PO_ROWS) return setError(`A PO can have at most ${formatNumber(MAX_PO_ROWS)} lines.`)
    const { rows, header: fromFile } = validatePoRows(data, mapping, headerIndex + 2)
    setResults(rows)
    setFileIssues(fromFile.issues)
    // Prefill header fields from the file when they are still empty.
    const fileCustomer = fromFile.customerNames[0]
    if (!customerChoice && fileCustomer) {
      const match = (customers.data ?? []).find((c) => c.customer_name.toLowerCase() === fileCustomer.toLowerCase())
      if (match) setCustomerChoice(match.id)
      else { setCustomerChoice(EXTERNAL); setExternalName(fileCustomer) }
    }
    if (!poNumber && fromFile.poNumbers[0]) setPoNumber(fromFile.poNumbers[0])
    if (!poDate && fromFile.poDates[0]) setPoDate(fromFile.poDates[0])
    if (!dueDate && fromFile.deliveryDates[0]) setDueDate(fromFile.deliveryDates[0])
    if (!currency && fromFile.currencies[0]) setCurrency(fromFile.currencies[0])
    setStep(3)
  }

  const runPreview = async () => {
    setError(null)
    if (!header.customer_id && !header.customer_name) return setError('Select the customer, or enter the customer name as an external reference.')
    if (!header.customer_po_number) return setError('Enter the customer PO number.')
    if (!header.po_date) return setError('Enter the PO date.')
    if (header.required_delivery_date && header.required_delivery_date < header.po_date) return setError('The delivery date cannot be before the PO date.')
    if (header.currency && !/^[A-Z]{3}$/.test(header.currency)) return setError('Currency must be a 3-letter code (e.g. INR).')
    if (fileIssues.length) return setError(fileIssues.join(' '))
    if (valid.length === 0) return setError('No valid rows to import. Fix the file and upload it again.')
    setBusy('matching')
    try {
      setPreview(await previewPo(header, valid.map((r) => r.payload!), hash))
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (revisionOf: string | null) => {
    if (!file) return
    setBusy('importing')
    setError(null)
    try {
      const result = await importPo(header, valid.map((r) => r.payload!), {
        name: file.name, hash, size: file.size, sheet: sheet || null, rows_read: results.length,
        rejected_rows: invalid.map((r) => ({ row: r.rowNumber, message: r.errors.join(' ') })),
      }, revisionOf, key)
      if (result.ok) renew()
      setOutcome(result)
      setStep(6)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const downloadErrors = () =>
    exportRows('Import errors', `po-import-errors-${(file?.name ?? 'file').replace(/\.[^.]+$/, '')}`,
      [
        { header: 'Row', value: (r: { row: number | string; code: string; problem: string; kind: string }) => String(r.row) },
        { header: 'Product code', value: (r) => r.code },
        { header: 'Severity', value: (r) => r.kind },
        { header: 'Message', value: (r) => r.problem },
      ],
      [
        ...fileIssues.map((m) => ({ row: '—', code: '', problem: m, kind: 'File' })),
        ...results.flatMap((r) => [...r.errors.map((m) => ({ row: r.rowNumber, code: r.code, problem: m, kind: 'Error (row not imported)' })),
          ...r.warnings.map((m) => ({ row: r.rowNumber, code: r.code, problem: m, kind: 'Warning' }))]),
        ...(preview?.lines ?? []).filter((l) => l.status !== 'MATCHED').map((l) => ({ row: l.source_row_number, code: results.find((r) => r.rowNumber === l.source_row_number)?.code ?? '',
          problem: `${l.status}: ${l.note ?? ''}${l.reason ? ` (${STATUS_REASON_LABELS[l.reason] ?? l.reason})` : ''}`, kind: 'Matching review' })),
      ],
      'xlsx')

  const previewByRow = useMemo(() => new Map((preview?.lines ?? []).map((l) => [l.source_row_number, l])), [preview])
  const rowColumns: DataTableColumn<PoRowResult>[] = [
    { id: 'row', header: 'Row', cell: (r) => r.rowNumber, sortValue: (r) => r.rowNumber },
    { id: 'code', header: 'Uploaded code / description', cell: (r) => r.code, searchValue: (r) => r.code },
    { id: 'qty', header: 'Qty', align: 'right', cell: (r) => (r.payload ? formatQty(r.payload.quantity, r.payload.unit ?? undefined) : '—') },
    { id: 'check', header: 'File check', cell: (r) => <StatusBadge label={r.status === 'valid' ? (r.warnings.length ? 'Valid (warning)' : 'Valid') : 'Error'} tone={r.status === 'valid' ? (r.warnings.length ? 'warning' : 'success') : 'danger'} /> },
    { id: 'match', header: 'Match', cell: (r) => (previewByRow.get(r.rowNumber) ? <LineStatusBadge status={previewByRow.get(r.rowNumber)!.status} /> : '—') },
    { id: 'product', header: 'Matched product', cell: (r) => { const p = previewByRow.get(r.rowNumber); return p?.sku ? `${p.sku} — ${p.product_name}` : '—' } },
    { id: 'method', header: 'Method / note', cell: (r) => {
      const p = previewByRow.get(r.rowNumber)
      const lines = [...r.errors, ...r.warnings]
      if (p?.method) lines.unshift(MATCH_METHOD_LABELS[p.method] ?? p.method)
      if (p && p.status !== 'MATCHED') lines.unshift(`${p.note ?? ''}${p.reason ? ` ${STATUS_REASON_LABELS[p.reason] ?? p.reason}.` : ''}${p.duplicate_of_row ? ` Same product as row ${p.duplicate_of_row}.` : ''}`)
      if (p?.candidates.length) lines.push(`Candidates: ${p.candidates.map((c) => c.sku).join(', ')}`)
      return <ul className="max-w-md space-y-0.5 text-xs">{lines.map((l, i) => <li key={i} className={r.errors.includes(l) ? 'text-shortage' : undefined}>{l}</li>)}</ul>
    } },
  ]
  const stockColumns: DataTableColumn<PreviewLine>[] = [
    { id: 'row', header: 'Row', cell: (l) => l.source_row_number },
    { id: 'product', header: 'Product', cell: (l) => (l.sku ? `${l.sku} — ${l.product_name}` : <span className="text-muted-foreground">Not matched</span>) },
    { id: 'ordered', header: 'Ordered', align: 'right', cell: (l) => formatQty(valid.find((v) => v.rowNumber === l.source_row_number)?.payload?.quantity ?? null, l.base_unit ?? undefined) },
    { id: 'ih', header: 'In-house available', align: 'right', cell: (l) => (l.in_house_available === null ? '—' : <span className="text-blue-700">{formatQty(l.in_house_available)}</span>) },
    { id: 'os', header: 'Outsourced available', align: 'right', cell: (l) => (l.outsourced_available === null ? '—' : <span className="text-violet-700">{formatQty(l.outsourced_available)}</span>) },
    { id: 'for', header: 'Available for this line', align: 'right', cell: (l) => (l.available_for_line === null ? '—' : formatQty(l.available_for_line)) },
    { id: 'status', header: 'Availability', cell: (l) => <span className="inline-flex flex-col gap-1"><AvailabilityBadge status={l.availability_status} />{Number(l.unknown_on_hand) > 0 && <span className="text-xs text-amber-800">{formatQty(l.unknown_on_hand)} unverified-source excluded</span>}</span> },
  ]

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const l of preview?.lines ?? []) c[l.availability_status] = (c[l.availability_status] ?? 0) + 1
    return c
  }, [preview])
  const matchCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const l of preview?.lines ?? []) c[l.status] = (c[l.status] ?? 0) + 1
    return c
  }, [preview])

  return (
    <>
      <PageHeader actions={step > 0 && step < 6 ? <Button variant="outline" onClick={reset}>Start over</Button> : undefined} />
      <Stepper step={step} />
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      {step === 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Select the customer PO file</CardTitle>
              <CardDescription>
                {PO_FILE_TYPES.join(', ')} up to {MAX_PO_FILE_MB} MB and {formatNumber(MAX_PO_ROWS)} lines. The file is read in your browser: macros, scripts and formulas are never
                run, and the file itself is not stored — only the parsed rows, file name and a fingerprint (to detect re-uploads) are saved when you confirm.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <FileUploadPanel accept={PO_FILE_TYPES} maxSizeMb={MAX_PO_FILE_MB} file={file} onFileChange={(f) => void onFile(f)} />
            {busy === 'reading' && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading file…</p>}
          </CardContent>
        </Card>
      )}

      {step === 1 && workbook && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Worksheet and header row</CardTitle>
              <CardDescription>{file?.name} · {file ? formatFileSize(file.size) : ''} · {workbook.sheetNames.length} worksheet(s)</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="po-sheet">Worksheet</Label>
                <Select value={sheet} onValueChange={(v) => chooseSheet(workbook, v)}>
                  <SelectTrigger id="po-sheet" className="w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>{workbook.sheetNames.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-header-row">Header row</Label>
                <Select value={String(headerIndex)} onValueChange={(v) => { setHeaderIndex(Number(v)); setMapping(autoMapPo(allRows[Number(v)] ?? [])) }}>
                  <SelectTrigger id="po-header-row" className="w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>{allRows.slice(0, 25).map((_, i) => <SelectItem key={i} value={String(i)}>Row {i + 1}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="max-h-80 overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <tbody>
                  {allRows.slice(0, 15).map((r, i) => (
                    <tr key={i} className={cn('border-b', i === headerIndex && 'bg-accent font-semibold')}>
                      <td className="sticky left-0 bg-surface-muted px-2 py-1 text-muted-foreground">{i + 1}</td>
                      {r.slice(0, 15).map((c, j) => <td key={j} className="max-w-48 truncate px-2 py-1">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {allRows.length === 0 && <p className="text-sm text-shortage">This worksheet is empty. Choose another sheet.</p>}
            <div className="flex justify-between">
              <Button variant="outline" onClick={reset}><ArrowLeft /> Back</Button>
              <Button disabled={allRows.length === 0} onClick={() => setStep(2)}>Map columns <ArrowRight /></Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && mapping && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Map columns</CardTitle>
              <CardDescription>Columns are matched automatically by name; correct anything that is wrong. Optional columns can stay unmapped. Quantity and at least one product identifier are required.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {PO_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`map-${f.key}`}>{f.label}</Label>
                  <Select value={mapping[f.key] === null ? 'none' : String(mapping[f.key])}
                    onValueChange={(v) => setMapping({ ...mapping, [f.key]: v === 'none' ? null : Number(v) } as PoMapping)}>
                    <SelectTrigger id={`map-${f.key}`}><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-72">
                      <SelectItem value="none">— Not in file —</SelectItem>
                      {headers.map((h, i) => <SelectItem key={i} value={String(i)}>{h || `Column ${i + 1}`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
            {missingPoFields(mapping).length > 0 && <p className="text-sm text-amber-800">Still required: {missingPoFields(mapping).join(' and ')}.</p>}
            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}><ArrowLeft /> Back</Button>
              <Button onClick={() => void validateAndMatch()}>Validate rows <ArrowRight /></Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>PO details</CardTitle>
                <CardDescription>Taken from the file where present; confirm or complete them. A customer record is recommended (customer codes can then be remembered).</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="po-customer">Customer</Label>
                <Select value={customerChoice} onValueChange={setCustomerChoice}>
                  <SelectTrigger id="po-customer"><SelectValue placeholder={customers.loading ? 'Loading…' : 'Select customer'} /></SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={EXTERNAL}>External reference (name only — no customer record)</SelectItem>
                    {(customers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {has('customers.manage') && <p className="text-xs text-muted-foreground">Missing customer? <Link className="underline" to="/customers">Create it in Customers</Link>, then reload this list.</p>}
              </div>
              {customerChoice === EXTERNAL && (
                <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="po-customer-name">Customer name (external reference)</Label>
                  <Input id="po-customer-name" maxLength={200} value={externalName} onChange={(e) => setExternalName(e.target.value)} /></div>
              )}
              <div className="space-y-1.5"><Label htmlFor="po-number">Customer PO number</Label><Input id="po-number" maxLength={100} value={poNumber} onChange={(e) => setPoNumber(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="po-date">PO date</Label><Input id="po-date" type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="po-due">Required delivery date</Label><Input id="po-due" type="date" min={poDate} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="po-currency">Currency (optional)</Label><Input id="po-currency" maxLength={3} placeholder="INR" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div>
              <div className="space-y-1.5">
                <Label htmlFor="po-wh">Fulfil from</Label>
                <Select value={warehouseId} onValueChange={setWarehouseId}>
                  <SelectTrigger id="po-wh"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Any warehouse</SelectItem>
                    {storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 sm:col-span-2 xl:col-span-3"><Label htmlFor="po-notes">Notes</Label><Textarea id="po-notes" rows={1} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            </CardContent>
          </Card>
          {fileIssues.length > 0 && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-medium">The file needs attention before it can be imported:</p>
              <ul className="list-disc pl-5">{fileIssues.map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusBadge label={`${valid.length} valid row(s)`} tone="success" />
            {invalid.length > 0 && <StatusBadge label={`${invalid.length} row(s) with errors — not imported`} tone="danger" />}
            {preview && Object.entries(matchCounts).map(([s, n]) => <span key={s} className="inline-flex items-center gap-1"><LineStatusBadge status={s} /> {n}</span>)}
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => void downloadErrors()}><Download /> Error report</Button>
          </div>
          <DataTable title="Rows and product matching" description="Matching rules, in order: exact internal SKU, verified customer code, exact barcode, code ignoring spaces/punctuation (only when unambiguous). Descriptions are never matched automatically."
            columns={rowColumns} data={results} getRowId={(r) => String(r.rowNumber)} pageSize={25} searchPlaceholder="Search rows…"
            emptyState={{ icon: FileWarning, title: 'No rows', description: 'No data rows were found below the header.' }} />
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(2)}><ArrowLeft /> Back</Button>
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy === 'matching'} onClick={() => void runPreview()}>{busy === 'matching' && <Loader2 className="animate-spin" />} Match products</Button>
              <Button disabled={!preview} onClick={() => setStep(4)}>Analyze stock <ArrowRight /></Button>
            </div>
          </div>
        </div>
      )}

      {step === 4 && preview && (
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg border bg-background px-4 py-2.5 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            Live stock from the database: available = on hand − all active reservations, in storage locations only (rejected, expired, outside-processor and unverified-source stock excluded){header.fulfilment_warehouse_id ? ', in the selected warehouse' : ''}. Lines of the same product share stock in row order. Nothing is reserved yet.
          </p>
          <DataTable title="Stock availability (preview)" columns={stockColumns} data={preview.lines} getRowId={(l) => String(l.source_row_number)} pageSize={25} searchable={false}
            emptyState={{ icon: FileWarning, title: 'No lines', description: '' }} />
          <div className="flex justify-between">
            <Button variant="outline" onClick={() => setStep(3)}><ArrowLeft /> Back</Button>
            <Button onClick={() => setStep(5)}>Review <ArrowRight /></Button>
          </div>
        </div>
      )}

      {step === 5 && preview && (
        <Card>
          <CardHeader><div><CardTitle>Review before import</CardTitle><CardDescription>Nothing has been saved yet. Allocation (reserving stock) happens after import, in Fulfilment Planning.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div><dt className="text-muted-foreground">Customer / PO</dt><dd className="font-medium">{preview.customer_name} · {header.customer_po_number}</dd></div>
              <div><dt className="text-muted-foreground">Lines to import</dt><dd className="font-medium">{valid.length} (rejected rows: {invalid.length})</dd></div>
              <div><dt className="text-muted-foreground">Allocation outlook</dt><dd className="flex flex-wrap gap-1">{Object.entries(counts).map(([s, n]) => <span key={s} className="inline-flex items-center gap-1"><AvailabilityBadge status={s} />{n}</span>)}</dd></div>
            </dl>
            {(matchCounts.UNMATCHED || matchCounts.AMBIGUOUS || matchCounts.INVALID || matchCounts.DUPLICATE_REVIEW) && (
              <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Some lines need review after import (unmatched, ambiguous, invalid or duplicate). The PO cannot be allocated until they are resolved in PO Product Matching.
              </p>
            )}
            {preview.duplicate_file && (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                This exact file was already imported as <Link className="underline" to={`/customer-pos/${preview.duplicate_file.po_id}`}>{preview.duplicate_file.po_reference}</Link> (PO {preview.duplicate_file.customer_po_number}, revision {preview.duplicate_file.revision}). It cannot be imported again.
              </p>
            )}
            {preview.duplicate_po && !preview.duplicate_file && (
              <div role="alert" className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p>A PO with this customer and number already exists: <Link className="underline" to={`/customer-pos/${preview.duplicate_po.po_id}`}>{preview.duplicate_po.po_reference}</Link> (revision {preview.duplicate_po.revision}, {preview.duplicate_po.status.replace(/_/g, ' ').toLowerCase()}).</p>
                <p>If the customer sent a changed PO, import it as a new revision: the previous revision is kept, and its allocations must be reviewed and released before the revision can be allocated.</p>
              </div>
            )}
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" onClick={() => setStep(4)}><ArrowLeft /> Back</Button>
              <div className="flex flex-wrap gap-2">
                {preview.duplicate_po && !preview.duplicate_file && <Button variant="outline" asChild><Link to={`/customer-pos/${preview.duplicate_po.po_id}`}>Open existing PO</Link></Button>}
                {preview.duplicate_po && !preview.duplicate_file && has('customer_po.revise') && (
                  <Button onClick={() => setConfirm('revision')}><Upload /> Import as revision {preview.duplicate_po.revision + 1}</Button>
                )}
                {!preview.duplicate_po && !preview.duplicate_file && <Button onClick={() => setConfirm('new')}><Upload /> Import PO</Button>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 6 && outcome && (
        <Card>
          <CardContent className="space-y-3 p-6">
            {outcome.ok ? (
              <>
                <p className="flex items-center gap-2 text-base font-semibold text-green-700"><CheckCircle2 className="size-5" /> Imported {outcome.po_reference}{outcome.revision > 1 ? ` (revision ${outcome.revision})` : ''}</p>
                <p className="text-sm">{outcome.lines} lines: {outcome.matched} matched, {outcome.unmatched} unmatched, {outcome.ambiguous} ambiguous, {outcome.invalid} invalid, {outcome.duplicate_review} to review as duplicates. Status: {outcome.status.replace(/_/g, ' ').toLowerCase()}.</p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild><Link to={`/customer-pos/${outcome.po_id}`}>Open PO</Link></Button>
                  <Button variant="outline" asChild><Link to={`/customer-pos/matching?po=${outcome.po_id}`}>Review matching</Link></Button>
                  <Button variant="outline" asChild><Link to={`/customer-pos/fulfilment?po=${outcome.po_id}`}>Plan fulfilment</Link></Button>
                  <Button variant="outline" onClick={reset}>Upload another</Button>
                </div>
              </>
            ) : outcome.reason === 'INVALID' ? (
              <>
                <p className="font-semibold text-shortage">The database rejected the import; nothing was created.</p>
                <ul className="list-disc pl-5 text-sm">{outcome.errors.map((e, i) => <li key={i}>{e.row ? `Row ${e.row}: ` : ''}{e.message}</li>)}</ul>
                <Button variant="outline" onClick={() => setStep(3)}>Back to review</Button>
              </>
            ) : (
              <>
                <p className="font-semibold text-amber-800">Not imported: {outcome.reason === 'DUPLICATE_FILE' ? 'this file was already imported' : 'a PO with this customer and number already exists'}.</p>
                <Button asChild><Link to={`/customer-pos/${outcome.existing.po_id}`}>Open {outcome.existing.po_reference}</Link></Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'revision' ? 'Import as a new revision?' : 'Import this PO?'}
        description={`${valid.length} line(s) will be saved for ${header.customer_po_number}${invalid.length ? `; ${invalid.length} row(s) with errors are not imported and are listed in the error report` : ''}. No stock is reserved by importing.`}
        confirmLabel={busy === 'importing' ? 'Importing…' : confirm === 'revision' ? 'Import revision' : 'Import PO'}
        onConfirm={() => void doImport(confirm === 'revision' ? preview?.duplicate_po?.po_id ?? null : null)}
      />
      {busy === 'importing' && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Importing…</p>}
    </>
  )
}
