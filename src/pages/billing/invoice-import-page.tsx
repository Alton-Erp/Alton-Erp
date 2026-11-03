import { AlertTriangle, CheckCircle2, ClipboardList, Download, FileSpreadsheet, Info, Loader2, PackagePlus, RefreshCw, Upload, UserPlus, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { FileUploadPanel } from '@/components/common/file-upload-panel'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { money } from '@/features/billing/billing-model'
import {
  INVOICE_IMPORT_COLUMNS, MAX_INVOICE_IMPORT_ROWS, buildInvoiceImportReport, invoiceTemplateRows, parseInvoiceSheet, type InvoiceImportRow,
} from '@/features/billing/invoicing-v2-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { QuickAddPartyDialog } from '@/features/ledger/party-form'
import { QuickAddProductDialog } from '@/features/products/quick-add-product'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { previewInvoiceImport, runInvoiceImport, type InvoiceImportPreview, type InvoiceImportResult } from '@/services/invoicing-v2'

type Filter = 'all' | 'ready' | 'warning' | 'error'

/** /billing/invoices/import — existing (e.g. earlier-issued) invoices from one spreadsheet, with their own numbers. */
export default function InvoiceImportPage() {
  const { has } = usePermissions()
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<InvoiceImportRow[]>([])
  const [preview, setPreview] = useState<InvoiceImportPreview | null>(null)
  const [result, setResult] = useState<InvoiceImportResult | null>(null)
  const [busy, setBusy] = useState<null | 'reading' | 'checking' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [quickCustomer, setQuickCustomer] = useState<string | null>(null)
  const [quickProduct, setQuickProduct] = useState<{ sku: string; name: string } | null>(null)
  const [importKey, setImportKey] = useState(() => crypto.randomUUID())

  const reset = () => { setFile(null); setRows([]); setPreview(null); setResult(null); setError(null); setImportKey(crypto.randomUUID()) }
  const check = async (r: InvoiceImportRow[] = rows) => {
    setBusy('checking'); setError(null)
    try { setPreview(await previewInvoiceImport(r)) } catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  const onFile = async (f: File | null) => {
    reset()
    if (!f) return
    if (f.size > 5 * 1024 * 1024) return setError('Files must be 5 MB or smaller.')
    setFile(f)
    setBusy('reading')
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await f.arrayBuffer())
      const parsed = parseInvoiceSheet(wb.sheetNames.length ? wb.rows(wb.sheetNames[0]) : [])
      if (parsed.missing.length) throw new Error(`The first sheet needs the columns ${parsed.missing.join(', ')} (download the template).`)
      if (parsed.rows.length === 0) throw new Error('The sheet has no data rows below the header.')
      if (parsed.rows.length > MAX_INVOICE_IMPORT_ROWS) throw new Error(`Import at most ${formatNumber(MAX_INVOICE_IMPORT_ROWS)} rows per file.`)
      setRows(parsed.rows)
      setBusy(null)
      await check(parsed.rows)
    } catch (e) {
      setError(e instanceof Error && !('code' in e) ? e.message : describeDataError(e))
      setBusy(null)
    }
  }
  const runImport = async () => {
    setConfirm(false); setBusy('importing'); setError(null)
    try { setResult(await runInvoiceImport(rows, { file_name: file?.name ?? 'invoices.xlsx' }, importKey)) }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  const downloadTemplate = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([
      { name: 'Invoices', rows: invoiceTemplateRows(toIsoDate(new Date())) },
      { name: 'How to fill', rows: [
        ['Column', 'What to enter'],
        ['Invoice Number', 'Required. Rows with the same number form ONE invoice. Letters, digits, / and - (max 16). A number that already exists is reported and never imported twice.'],
        ['Invoice Date / Due Date', 'YYYY-MM-DD (DD-MM-YYYY also accepted). Not in the future. Due Date is optional (blank = payment terms).'],
        ['Customer Name / Customer GSTIN', 'Matched by GSTIN first, then by name. Unknown customers can be added on the import screen.'],
        ['Sales Order Number', 'Optional. The quantity is checked against what is still to be invoiced on that order.'],
        ['Product SKU', 'SKU from the Product Master. Unknown products can be added on the import screen.'],
        ['HSN Code', 'Optional; blank = the Product Master HSN. 4, 6 or 8 digits.'],
        ['Quantity / Unit', 'Quantity in the product\'s unit (whole numbers for PCS, NOS, SET, PAIR). Unit is optional but must match.'],
        ['Rate', 'Price per unit before GST; blank = the Product Master selling price (shown as a warning).'],
        ['Discount', 'Optional percentage (10 or 10%).'],
        ['GST Rate', 'Optional; blank = the product\'s GST rate.'],
        ['Place of Supply', 'Optional state code (27) or name (Maharashtra); blank = from the customer.'],
        ['Payment Terms / Remarks', 'Optional (e.g. 30 days).'],
        ['On import', 'Each invoice is issued with its own number and becomes part of the customer ledger. Invoices never move stock. An invoice with any bad row is held back whole and listed in the error report.'],
      ] },
    ], 'invoice-import-template', 'xlsx')
  }
  const downloadReport = async () => {
    if (!preview) return
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Invoice import report', rows: buildInvoiceImportReport(preview.invoices, result ?? undefined) }], `invoice-import-report-${toIsoDate(new Date())}`, 'xlsx')
  }

  const created = new Map((result?.created ?? []).map((c) => [c.first_row, c]))
  const failed = new Map((result?.failed ?? []).map((f) => [f.first_row, f.messages]))
  const shown = (preview?.invoices ?? []).filter((g) => filter === 'all' || (filter === 'ready' && g.status === 'VALID') || (filter === 'warning' && g.status === 'WARNING') || (filter === 'error' && g.status === 'ERROR'))
  const importable = preview ? preview.valid + preview.warnings : 0

  return (
    <>
      <PageHeader title="Import invoices from Excel" description="Bring in invoices issued elsewhere (for example before this ERP) with their own numbers. Every row is checked and you see every problem before anything is saved."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Invoice Register', to: '/billing/register' }, { label: 'Import' }]}
        actions={<Button variant="outline" onClick={() => void downloadTemplate()}><Download /> Download template</Button>} />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> Columns: {INVOICE_IMPORT_COLUMNS.join(', ')}. Rows with the same Invoice Number form one invoice. Uploading the same file again never creates duplicates.
      </p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      {!preview && (
        <Card>
          <CardHeader><div><CardTitle>Select a spreadsheet</CardTitle><CardDescription>.xlsx, .xls or .csv, up to 5 MB and {formatNumber(MAX_INVOICE_IMPORT_ROWS)} rows. The first sheet is read.</CardDescription></div></CardHeader>
          <CardContent>
            {busy ? <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading and checking the file…</p>
              : <FileUploadPanel accept={['.xlsx', '.xls', '.csv']} maxSizeMb={5} file={file} onFileChange={(f) => void onFile(f)} />}
          </CardContent>
        </Card>
      )}

      {preview && (
        <div className="space-y-6">
          <section aria-label="Import summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Rows / invoices" value={`${formatNumber(preview.rows)} / ${formatNumber(preview.invoices.length)}`} hint={file?.name} icon={FileSpreadsheet} />
            <KpiCard label="Invoices ready" value={formatNumber(importable)} icon={CheckCircle2} accent="available" />
            <KpiCard label="With warnings" value={formatNumber(preview.warnings)} hint="Defaults used, unusual GST rate" icon={AlertTriangle} accent={preview.warnings ? 'pending' : 'neutral'} />
            <KpiCard label="With errors" value={formatNumber(preview.errors)} hint="Held back; see the report" icon={XCircle} accent={preview.errors ? 'shortage' : 'neutral'} />
          </section>

          {!result && (preview.missing_customers.length > 0 || preview.missing_products.length > 0) && (
            <Card>
              <CardHeader><div><CardTitle>Missing customers and products</CardTitle><CardDescription>Add them here, then check the file again.</CardDescription></div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void check()}>{busy === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again</Button></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {preview.missing_customers.map((c) => has('customers.manage') && (
                  <Button key={`c-${c.name ?? c.gstin}`} size="sm" variant="outline" onClick={() => setQuickCustomer(c.name ?? '')}><UserPlus /> Add customer {c.name ?? c.gstin}</Button>
                ))}
                {preview.missing_products.map((p) => has('products.create') && (
                  <Button key={`p-${p.sku}`} size="sm" variant="outline" onClick={() => setQuickProduct({ sku: p.sku, name: p.name ?? '' })}><PackagePlus /> Add product {p.sku}</Button>
                ))}
              </CardContent>
            </Card>
          )}

          {result && (
            <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
              {result.created_count} invoice(s) imported and issued, {result.failed_count} invoice(s) not imported. Recorded in <Link className="underline" to={`/admin/bulk-operations?job=${result.job_id}`}>Bulk Operations</Link>.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FilterTabs<Filter> label="Invoices" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: 'All' }, { value: 'ready', label: 'Ready' }, { value: 'warning', label: 'Warnings' }, { value: 'error', label: 'Errors' }]} />
          </div>
          <div className="space-y-3">{shown.map((g) => {
            const c = created.get(g.first_row)
            const f = failed.get(g.first_row)
            return (
              <Card key={g.first_row}>
                <CardContent className="space-y-2 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p><span className="font-semibold">{g.invoice_number ?? '(no number)'}</span> · {g.customer_name ?? '—'} · {g.invoice_date ? formatDate(g.invoice_date) : 'no date'}
                      {g.sales_order_number ? ` · ${g.sales_order_number}` : ''} · rows {g.rows.map((r) => r.row_number).join(', ')} · {money(g.estimated_total)}</p>
                    {c ? <StatusBadge label={`Imported ${c.invoice_number}`} tone="success" />
                      : f ? <StatusBadge label="Not imported" tone="danger" />
                      : g.status === 'ERROR' ? <StatusBadge label="Error" tone="danger" /> : g.status === 'WARNING' ? <StatusBadge label="Ready (warnings)" tone="warning" /> : <StatusBadge label="Ready" tone="success" />}
                  </div>
                  <ul className="space-y-0.5 text-xs">
                    {g.rows.map((r) => (
                      <li key={r.row_number}>Row {r.row_number}: {r.sku ?? '—'} {r.quantity !== null ? formatQty(r.quantity, r.unit ?? undefined) : ''}{r.rate !== null ? ` @ ${money(r.rate)}` : ''}{r.gst_rate !== null ? ` + ${Number(r.gst_rate)}% GST` : ''}
                        {r.errors.map((m) => <span key={m} className="block text-red-700">{m}</span>)}
                        {r.warnings.map((m) => <span key={m} className="block text-amber-800">{m}</span>)}</li>
                    ))}
                    {(f ?? g.errors).map((m) => <li key={m} className="text-red-700">{m}</li>)}
                    {g.warnings.map((m) => <li key={m} className="text-amber-800">{m}</li>)}
                  </ul>
                </CardContent>
              </Card>
            )
          })}{shown.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><ClipboardList className="size-4" /> No invoices match this filter.</p>}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={reset}>{result ? 'Import another file' : 'Choose another file'}</Button>
            <Button variant="outline" onClick={() => void downloadReport()}><Download /> Download {result ? 'report' : 'error report'}</Button>
            {!result && <Button disabled={busy !== null || importable === 0} onClick={() => setConfirm(true)}>{busy === 'importing' ? <Loader2 className="animate-spin" /> : <Upload />} Import {importable} invoice(s)</Button>}
            {result && <Button asChild><Link to="/billing/register">Go to the invoice register</Link></Button>}
          </div>
        </div>
      )}

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Import ${importable} invoice(s)?`}
        description={`Each invoice is issued with the number in the file and added to the customer's balance. Stock is not changed. ${preview?.errors ?? 0} invoice(s) with errors are not imported.`}
        confirmLabel="Import" onConfirm={() => void runImport()} />
      {quickCustomer !== null && (
        <QuickAddPartyDialog role="CUSTOMER" initialName={quickCustomer} onClose={() => setQuickCustomer(null)} onCreated={() => { setQuickCustomer(null); void check() }} />
      )}
      {quickProduct && (
        <QuickAddProductDialog initialSku={quickProduct.sku.toUpperCase()} initialName={quickProduct.name} onClose={() => setQuickProduct(null)} onCreated={() => { setQuickProduct(null); void check() }} />
      )}
    </>
  )
}
