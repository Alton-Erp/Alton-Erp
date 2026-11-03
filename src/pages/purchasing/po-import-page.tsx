import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Info, Loader2, Upload, XCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { FileUploadPanel } from '@/components/common/file-upload-panel'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { money } from '@/features/billing/billing-model'
import { fileFingerprint } from '@/features/customer-po/po-import'
import { formatQty } from '@/features/inventory/inventory-model'
import {
  groupPayload, invalidReferences, parsePoImport, PO_IMPORT_FILE_TYPES, PO_IMPORT_MAX_FILE_MB, PO_IMPORT_MAX_ORDERS, PO_IMPORT_MAX_ROWS,
  rejectedRowsPayload, templateSheets, type ParsedPoImport,
} from '@/features/purchasing/po-import'
import { TAX_TREATMENT_LABELS } from '@/features/purchasing/po-model'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { importPurchaseOrders, previewPoImport, type PoImportPreview, type PoImportResult } from '@/services/purchasing'
import type { PoTaxTreatment } from '@/types/database-purchasing'

type Stage = 'idle' | 'reading' | 'validating' | 'review' | 'importing' | 'done'
const STEPS: { id: Stage[]; label: string }[] = [
  { id: ['idle', 'reading'], label: 'Upload file' },
  { id: ['validating', 'review'], label: 'Review' },
  { id: ['importing'], label: 'Import' },
  { id: ['done'], label: 'Summary' },
]

interface Issue { row: number | null; reference: string | null; message: string; severity: 'error' | 'warning' }

/**
 * Import supplier purchase orders from Excel / CSV as DRAFTS. The browser
 * parses the file (formulas are never evaluated); the server resolves codes in
 * the user's company, validates and calculates with the real PO functions
 * (preview is rolled back), and creates each order all-or-nothing on confirm.
 * Nothing is approved, sent, received or posted to stock.
 */
export default function PoImportPage() {
  const request = useRequestKey()
  const [today] = useState(() => toIsoDate(new Date()))
  const [stage, setStage] = useState<Stage>('idle')
  const [file, setFile] = useState<File | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedPoImport | null>(null)
  const [preview, setPreview] = useState<PoImportPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<PoImportResult | null>(null)

  const reset = () => { setStage('idle'); setFile(null); setHash(null); setParsed(null); setPreview(null); setError(null); setSkipInvalid(false); setResult(null) }

  const onFile = async (f: File | null) => {
    reset()
    if (!f) return
    setFile(f)
    if (f.size === 0) { setError('The file is empty.'); return }
    setStage('reading')
    try {
      const buffer = await f.arrayBuffer()
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(buffer)
      const sheet = wb.sheetNames.find((n) => n.toLowerCase() === 'purchase orders') ?? wb.sheetNames[0]
      const p = parsePoImport(sheet ? wb.rows(sheet) : [], today)
      const fp = await fileFingerprint(buffer)
      setParsed(p)
      setHash(fp)
      if (p.fileErrors.length) { setStage('review'); return }
      const bad = invalidReferences(p)
      const valid = p.groups.filter((g) => !bad.has(g.reference.toLowerCase()))
      if (valid.length === 0) { setStage('review'); return }
      setStage('validating')
      setPreview(await previewPoImport(valid.map(groupPayload), fp))
      setStage('review')
    } catch (e) {
      setError(e instanceof Error && /zip|file|corrupt|unsupported/i.test(e.message) ? 'The file could not be read. Save it as .xlsx or .csv and try again.' : describeDataError(e))
      setStage('review')
    }
  }

  // Combined view of browser and server results
  const clientBad = parsed ? invalidReferences(parsed) : new Set<string>()
  const groups = parsed?.groups ?? []
  const okGroups = (preview?.groups ?? []).filter((g) => g.ok)
  const badCount = groups.length - okGroups.length
  const issues: Issue[] = [
    ...(parsed?.rowErrors ?? []).map((e) => ({ ...e, severity: 'error' as const })),
    ...(preview?.groups ?? []).flatMap((g) => [
      ...g.errors.map((e) => ({ row: e.row, reference: g.reference, message: e.message, severity: 'error' as const })),
      ...g.warnings.map((e) => ({ row: e.row, reference: g.reference, message: e.message, severity: 'warning' as const })),
    ]),
  ].sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
  const errorCount = issues.filter((i) => i.severity === 'error').length
  const canImport = stage === 'review' && okGroups.length > 0 && (badCount === 0 || skipInvalid) && !parsed?.fileErrors.length
  const okLines = okGroups.reduce((s, g) => s + g.rows.length, 0)

  const runImport = async () => {
    if (!parsed || !file) return
    setConfirm(false)
    setError(null)
    setStage('importing')
    const okRefs = new Set(okGroups.map((g) => g.reference.toLowerCase()))
    const payload = parsed.groups.filter((g) => okRefs.has(g.reference.toLowerCase())).map(groupPayload)
    try {
      const res = await importPurchaseOrders(payload, { file_name: file.name, file_hash: hash, total_rows: parsed.dataRows },
        // Browser-rejected orders plus orders the server preview rejected (each row once).
        rejectedRowsPayload(parsed, clientBad).concat((preview?.groups ?? []).filter((g) => !g.ok).flatMap((g) => g.rows.map((r) => ({
          row_number: r, reference: g.reference, messages: g.errors.filter((e) => e.row === r).map((e) => e.message).concat(g.errors.some((e) => e.row === r) ? [] : [`Not imported: PO Reference ${g.reference} has errors.`]),
        })))), request.key)
      request.renew()
      setResult(res)
      setStage('done')
    } catch (e) {
      // The same request id is reused on retry, so a request that did succeed is never imported twice.
      setError(`The import did not complete: ${describeDataError(e)} You can retry safely.`)
      setStage('review')
    }
  }

  const downloadTemplate = async (format: 'xlsx' | 'csv') => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets(format === 'csv' ? templateSheets().slice(0, 1) : templateSheets(), 'supplier-po-import-template', format)
  }
  const downloadErrors = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Errors', rows: [['Row', 'PO Reference', 'Severity', 'Message'], ...issues.map((i) => [i.row, i.reference, i.severity, i.message])] }],
      `po-import-errors-${today}`, 'xlsx')
  }

  const busy = stage === 'reading' || stage === 'validating' || stage === 'importing'
  return (
    <>
      <PageHeader title="Import purchase orders from Excel"
        description="Create draft supplier purchase orders from a spreadsheet. Each draft is reviewed and submitted for approval in the ERP as usual."
        breadcrumbs={[{ label: 'Orders' }, { label: 'Supplier Purchase Orders', to: '/purchase-orders' }, { label: 'Import' }]} />

      <ol className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Import steps">
        {STEPS.map((s, i) => {
          const current = s.id.includes(stage)
          const done = STEPS.findIndex((x) => x.id.includes(stage)) > i
          return (
            <li key={s.label} aria-current={current ? 'step' : undefined}
              className={cn('flex items-center gap-2 rounded-lg border px-3 py-2 text-sm', current ? 'border-primary bg-background font-medium' : done ? 'bg-background text-muted-foreground' : 'bg-surface-muted/50 text-muted-foreground')}>
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs', current ? 'bg-primary text-primary-foreground' : 'bg-gray-200')}>{done ? '✓' : i + 1}</span>
              {s.label}
            </li>
          )
        })}
      </ol>

      {stage !== 'done' && (
        <div className="mb-6 grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader><div><CardTitle>Upload file</CardTitle><CardDescription>.xlsx or .csv, up to {PO_IMPORT_MAX_FILE_MB} MB, {PO_IMPORT_MAX_ROWS} rows and {PO_IMPORT_MAX_ORDERS} orders. The first sheet (or the "Purchase Orders" sheet) is read.</CardDescription></div></CardHeader>
            <CardContent className="space-y-3">
              <FileUploadPanel accept={PO_IMPORT_FILE_TYPES} maxSizeMb={PO_IMPORT_MAX_FILE_MB} file={file} onFileChange={(f) => void onFile(f)} />
              {busy && (
                <div role="status" className="space-y-1.5">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />
                    {stage === 'reading' ? 'Reading the file…' : stage === 'validating' ? `Checking ${groups.length - clientBad.size} order(s) against your suppliers, products and warehouses…` : `Creating ${okGroups.length} draft purchase order(s)…`}
                  </p>
                  <div className="h-1.5 overflow-hidden rounded-full bg-gray-200"><div className="h-full w-1/3 animate-pulse rounded-full bg-primary" style={{ width: stage === 'reading' ? '25%' : stage === 'validating' ? '60%' : '90%' }} /></div>
                </div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><div><CardTitle>Template</CardTitle><CardDescription>One row per product line. Rows with the same <strong>PO Reference</strong> become one draft order.</CardDescription></div></CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" className="w-full" onClick={() => void downloadTemplate('xlsx')}><Download /> Download Excel Template</Button>
              <Button variant="ghost" className="w-full" onClick={() => void downloadTemplate('csv')}><Download /> CSV template</Button>
              <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                <li>Suppliers, products and warehouses must already exist (matched by code). Nothing is created automatically.</li>
                <li>Totals and CGST/SGST or IGST are calculated by the ERP; spreadsheet totals are not used.</li>
                <li>Formulas are not evaluated; cells starting with =, +, - or @ are rejected.</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      )}

      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
      {parsed?.fileErrors.map((m) => <p key={m} role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{m} Correct the file and upload it again.</p>)}

      {stage === 'review' && parsed && !parsed.fileErrors.length && (
        <>
          {preview && preview.previous_imports.length > 0 && (
            <Notice tone="warning">This file was imported before ({preview.previous_imports.map((p) => `${formatDateTime(p.started_at)}: ${p.success_rows} row(s) imported`).join('; ')}). Orders already imported are refused again, so no duplicates are created.</Notice>
          )}
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Product rows" value={parsed.dataRows} />
            <Stat label="Purchase orders" value={groups.length} />
            <Stat label="Ready to import" value={okGroups.length} tone="success" />
            <Stat label="Orders with errors" value={badCount} tone={badCount ? 'danger' : undefined} />
            <Stat label="Blank rows skipped" value={parsed.blankRows} />
          </div>

          <Card className="mb-4 overflow-hidden">
            <CardHeader><div><CardTitle>Preview</CardTitle><CardDescription>Amounts are calculated by the ERP (same engine as the PO form). Nothing has been saved yet.</CardDescription></div></CardHeader>
            <Table>
              <TableHeader><TableRow className="hover:bg-transparent">
                <TableHead>PO Reference</TableHead><TableHead>Rows</TableHead><TableHead>Supplier</TableHead><TableHead>Warehouse</TableHead><TableHead>Tax</TableHead>
                <TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">GST</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Status</TableHead>
              </TableRow></TableHeader>
              <TableBody>{groups.map((g) => {
                const s = preview?.groups.find((x) => x.reference.toLowerCase() === g.reference.toLowerCase())
                const ok = Boolean(s?.ok)
                return (
                  <TableRow key={g.reference} className="align-top">
                    <TableCell className="font-medium">{g.reference}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{g.rows.map((r) => r.row_number).join(', ')}</TableCell>
                    <TableCell className="min-w-40 whitespace-normal">{s?.supplier_name ? <>{s.supplier_code} — {s.supplier_name}</> : g.header.supplier_code}</TableCell>
                    <TableCell>{s?.warehouse_code ?? g.header.warehouse}</TableCell>
                    <TableCell className="text-xs">{s?.tax_treatment ? TAX_TREATMENT_LABELS[s.tax_treatment as PoTaxTreatment] : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{s?.totals ? money(s.totals.taxable) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{s?.totals ? money(Number(s.totals.cgst) + Number(s.totals.sgst) + Number(s.totals.igst)) : '—'}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{s?.totals ? money(s.totals.grand) : '—'}</TableCell>
                    <TableCell>{ok ? <span className="inline-flex items-center gap-1 text-sm text-green-700"><CheckCircle2 className="size-4" /> Ready ({g.rows.length} line{g.rows.length === 1 ? '' : 's'})</span>
                      : <span className="inline-flex items-center gap-1 text-sm text-red-700"><XCircle className="size-4" /> Fix errors</span>}</TableCell>
                  </TableRow>
                )
              })}</TableBody>
            </Table>
            {okGroups.some((g) => g.lines?.length) && (
              <details className="border-t px-5 py-3 text-sm">
                <summary className="cursor-pointer font-medium">Line amounts of the valid orders</summary>
                <Table>
                  <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Row</TableHead><TableHead>PO Reference</TableHead><TableHead>SKU</TableHead><TableHead className="text-right">GST rate</TableHead>
                    <TableHead className="text-right">Taxable</TableHead><TableHead className="text-right">CGST</TableHead><TableHead className="text-right">SGST</TableHead><TableHead className="text-right">IGST</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
                  <TableBody>{okGroups.flatMap((g) => (g.lines ?? []).map((l) => (
                    <TableRow key={`${g.reference}-${l.row}`}><TableCell>{l.row}</TableCell><TableCell>{g.reference}</TableCell><TableCell>{l.sku}</TableCell>
                      <TableCell className="text-right">{l.gst_rate === null ? 'not set' : `${Number(l.gst_rate)}%`}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.taxable)}</TableCell><TableCell className="text-right tabular-nums">{money(l.cgst)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.sgst)}</TableCell><TableCell className="text-right tabular-nums">{money(l.igst)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(l.total)}</TableCell></TableRow>
                  )))}</TableBody>
                </Table>
              </details>
            )}
          </Card>

          {issues.length > 0 && (
            <Card className="mb-4 overflow-hidden">
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
                <div><CardTitle>Problems found</CardTitle><CardDescription>{errorCount} error(s) to correct in the file; warnings do not stop the import. Row numbers are Excel row numbers.</CardDescription></div>
                <Button variant="outline" size="sm" onClick={() => void downloadErrors()}><Download /> Download error report</Button>
              </CardHeader>
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="w-20">Row</TableHead><TableHead className="w-36">PO Reference</TableHead><TableHead>What to correct</TableHead></TableRow></TableHeader>
                <TableBody>{issues.slice(0, 500).map((i, n) => (
                  <TableRow key={n}>
                    <TableCell className="tabular-nums">{i.row ?? '—'}</TableCell>
                    <TableCell>{i.reference ?? '—'}</TableCell>
                    <TableCell className={cn('whitespace-normal', i.severity === 'error' ? 'text-red-800' : 'text-amber-800')}>
                      <span className="inline-flex gap-1.5">{i.severity === 'error' ? <XCircle aria-hidden className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />}<span><span className="sr-only">{i.severity}: </span>{i.message}</span></span>
                    </TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
              {issues.length > 500 && <p className="border-t px-5 py-2 text-xs text-muted-foreground">Showing the first 500 problems; download the error report for all of them.</p>}
            </Card>
          )}

          <Card className="mb-6">
            <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2 text-sm">
                {okGroups.length === 0 ? <p className="text-red-800">Nothing can be imported yet. Correct the file and upload it again.</p>
                  : <p>{okGroups.length} draft purchase order(s) with {okLines} line(s) will be created. They are not approved, sent or received.</p>}
                {badCount > 0 && okGroups.length > 0 && (
                  <div className="flex items-start gap-2">
                    <Checkbox id="skip-invalid" checked={skipInvalid} onCheckedChange={(c) => setSkipInvalid(c === true)} />
                    <Label htmlFor="skip-invalid" className="font-normal">Import the {okGroups.length} valid order(s) now and skip the {badCount} order(s) with errors (they can be imported later from a corrected file).</Label>
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}><Upload /> Upload another file</Button>
                <Button disabled={!canImport} onClick={() => setConfirm(true)}><FileSpreadsheet /> Import {okGroups.length} draft order(s)</Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {stage === 'done' && result && (
        <>
          <Notice tone={result.failed_count ? 'warning' : 'success'}>
            {result.created_count} draft purchase order(s) created with {result.imported_rows} line(s). {result.failed_count ? `${result.failed_count} order(s) were not imported.` : ''}
            {result.duplicate ? ' (This import had already been completed; nothing new was created.)' : ''} Open each draft, review it and submit it for approval.
          </Notice>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Stat label="Draft orders created" value={result.created_count} tone="success" />
            <Stat label="Lines imported" value={result.imported_rows} />
            <Stat label="Rows not imported" value={result.failed_rows} tone={result.failed_rows ? 'danger' : undefined} />
            <Stat label="Blank rows skipped" value={parsed?.blankRows ?? 0} />
          </div>
          {result.created.length > 0 && (
            <Card className="mb-4 overflow-hidden">
              <CardHeader><div><CardTitle>Created drafts</CardTitle></div></CardHeader>
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>PO No.</TableHead><TableHead>PO Reference</TableHead><TableHead>Supplier</TableHead><TableHead className="text-right">Lines</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
                <TableBody>{result.created.map((c) => (
                  <TableRow key={c.po_id}>
                    <TableCell><Link className="font-medium hover:underline" to={`/purchase-orders/${c.po_id}`}>{c.po_number}</Link></TableCell>
                    <TableCell>{c.reference}</TableCell><TableCell>{c.supplier_code}</TableCell>
                    <TableCell className="text-right">{formatQty(c.lines)}</TableCell><TableCell className="text-right tabular-nums">{money(c.grand_total)}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </Card>
          )}
          {result.failed.length > 0 && (
            <Card className="mb-4 overflow-hidden">
              <CardHeader><div><CardTitle>Not imported</CardTitle><CardDescription>Nothing was created for these orders.</CardDescription></div></CardHeader>
              <Table>
                <TableHeader><TableRow className="hover:bg-transparent"><TableHead>PO Reference</TableHead><TableHead>Rows</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
                <TableBody>{result.failed.map((f) => (
                  <TableRow key={f.reference} className="align-top"><TableCell className="font-medium">{f.reference}</TableCell><TableCell>{f.rows.join(', ')}</TableCell>
                    <TableCell className="whitespace-normal text-red-800">{f.errors.map((e) => `${e.row ? `Row ${e.row}: ` : ''}${e.message}`).join(' ')}</TableCell></TableRow>
                ))}</TableBody>
              </Table>
            </Card>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild><Link to="/purchase-orders">Back to purchase orders</Link></Button>
            <Button variant="outline" onClick={reset}><Upload /> Import another file</Button>
            <Button variant="ghost" asChild><Link to={`/admin/bulk-operations?job=${result.job_id}`}>View in import history</Link></Button>
          </div>
        </>
      )}

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Create ${okGroups.length} draft purchase order(s)?`}
        description={`${okLines} line(s) from ${file?.name ?? 'the file'} will be created as drafts in your company. ${badCount ? `${badCount} order(s) with errors are skipped. ` : ''}Each draft is checked again by the server and created completely or not at all.`}
        confirmLabel="Create drafts" onConfirm={() => void runImport()} />
    </>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'success' | 'danger' }) {
  return (
    <Card className="gap-1 p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('text-xl font-semibold tabular-nums', tone === 'success' && 'text-green-700', tone === 'danger' && 'text-red-700')}>{value}</p>
    </Card>
  )
}

function Notice({ tone, children }: { tone: 'warning' | 'success'; children: ReactNode }) {
  return (
    <div role="status" className={cn('mb-4 flex gap-2 rounded-lg border px-4 py-2.5 text-sm', tone === 'success' ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-900')}>
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" /><div>{children}</div>
    </div>
  )
}
