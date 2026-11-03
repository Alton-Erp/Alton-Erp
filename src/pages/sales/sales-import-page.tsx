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
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { money } from '@/features/billing/billing-model'
import { formatQty } from '@/features/inventory/inventory-model'
import { useStorage } from '@/features/inventory/use-storage'
import { QuickAddPartyDialog } from '@/features/ledger/party-form'
import { QuickAddProductDialog } from '@/features/products/quick-add-product'
import {
  MAX_SALES_IMPORT_ROWS, SALES_IMPORT_COLUMNS, buildSalesImportReport, parseSalesSheet, salesTemplateRows, type SalesImportRow,
} from '@/features/sales/sales-v2-model'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { previewSalesImport, runSalesImport, type SalesImportPreview, type SalesImportResult } from '@/services/sales-v2'

type Filter = 'all' | 'ready' | 'warning' | 'error'

/** /sales/orders/import — several sales orders from one spreadsheet. */
export default function SalesImportPage() {
  const { has } = usePermissions()
  const storage = useStorage()
  const [warehouse, setWarehouse] = useState('any')
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<SalesImportRow[]>([])
  const [preview, setPreview] = useState<SalesImportPreview | null>(null)
  const [result, setResult] = useState<SalesImportResult | null>(null)
  const [busy, setBusy] = useState<null | 'reading' | 'checking' | 'importing'>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [quickCustomer, setQuickCustomer] = useState<string | null>(null)
  const [quickProduct, setQuickProduct] = useState<{ sku: string; name: string } | null>(null)
  const [importKey, setImportKey] = useState(() => crypto.randomUUID())
  const wh = warehouse === 'any' ? null : warehouse

  const reset = () => { setFile(null); setRows([]); setPreview(null); setResult(null); setError(null); setImportKey(crypto.randomUUID()) }
  const check = async (r: SalesImportRow[] = rows) => {
    setBusy('checking'); setError(null)
    try { setPreview(await previewSalesImport(r, wh)) } catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
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
      const parsed = parseSalesSheet(wb.sheetNames.length ? wb.rows(wb.sheetNames[0]) : [])
      if (parsed.missing.length) throw new Error(`The first sheet needs the columns ${parsed.missing.join(', ')} (download the template).`)
      if (parsed.rows.length === 0) throw new Error('The sheet has no data rows below the header.')
      if (parsed.rows.length > MAX_SALES_IMPORT_ROWS) throw new Error(`Import at most ${formatNumber(MAX_SALES_IMPORT_ROWS)} rows per file.`)
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
    try { setResult(await runSalesImport(rows, wh, { file_name: file?.name ?? 'sales-orders.xlsx' }, importKey)) }
    catch (e) { setError(describeDataError(e)) } finally { setBusy(null) }
  }
  const downloadTemplate = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([
      { name: 'Sales Orders', rows: salesTemplateRows(toIsoDate(new Date())) },
      { name: 'How to fill', rows: [
        ['Column', 'What to enter'],
        ['Order Date', 'YYYY-MM-DD (DD-MM-YYYY also accepted). Not in the future.'],
        ['Customer Name / Customer GSTIN', 'The customer is matched by GSTIN first, then by name. Unknown customers can be added on the import screen.'],
        ['Customer Reference', 'The customer\'s order number. Rows with the same customer and reference become ONE sales order. Required: it also stops the same order being imported twice.'],
        ['Product SKU', 'SKU from the Product Master. Unknown products can be added on the import screen. Product Name is only checked.'],
        ['Quantity / Unit', 'Quantity in the product\'s unit (whole numbers for PCS, NOS, SET, PAIR). Unit is optional but must match.'],
        ['Selling Price', 'Optional; blank = the Product Master selling price.'],
        ['Discount', 'Optional percentage (10 or 10%).'],
        ['GST Rate', 'Optional; blank = the product\'s GST rate.'],
        ['Expected Delivery Date / Remarks', 'Optional.'],
        ['On import', 'Each order is saved as an open order: available finished goods are reserved and materials for the rest are checked. An order with any bad row is held back whole and listed in the error report.'],
      ] },
    ], 'sales-order-import-template', 'xlsx')
  }
  const downloadReport = async () => {
    if (!preview) return
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Sales order import report', rows: buildSalesImportReport(preview.orders, result ?? undefined) }], `sales-order-import-report-${toIsoDate(new Date())}`, 'xlsx')
  }

  const created = new Map((result?.created ?? []).map((c) => [c.first_row, c]))
  const failed = new Map((result?.failed ?? []).map((f) => [f.first_row, f.messages]))
  const shown = (preview?.orders ?? []).filter((g) => filter === 'all' || (filter === 'ready' && g.status === 'VALID') || (filter === 'warning' && g.status === 'WARNING') || (filter === 'error' && g.status === 'ERROR'))
  const importable = preview ? preview.valid + preview.warnings : 0

  return (
    <>
      <PageHeader title="Import sales orders from Excel" description="Several orders in one file. Customers and products are matched, totals and reservations calculated, and you see every problem before anything is saved."
        breadcrumbs={[{ label: 'Sales & Fulfilment' }, { label: 'Sales Orders', to: '/sales/orders' }, { label: 'Import' }]}
        actions={<Button variant="outline" onClick={() => void downloadTemplate()}><Download /> Download template</Button>} />
      <p className="mb-4 flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-900">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> Columns: {SALES_IMPORT_COLUMNS.join(', ')}. Rows with the same customer and Customer Reference form one order. Uploading the same file again does not create duplicates.
      </p>
      {error && <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}

      {!preview && (
        <Card>
          <CardHeader><div><CardTitle>Select a spreadsheet</CardTitle><CardDescription>.xlsx, .xls or .csv, up to 5 MB and {formatNumber(MAX_SALES_IMPORT_ROWS)} rows. The first sheet is read.</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <div className="max-w-sm space-y-1"><Label htmlFor="si-wh">Dispatch warehouse</Label>
              <Select value={warehouse} onValueChange={(v) => { if (v) setWarehouse(v) }}>
                <SelectTrigger id="si-wh"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="any">Any warehouse</SelectItem>
                  {storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
              </Select></div>
            {busy ? <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Reading and checking the file…</p>
              : <FileUploadPanel accept={['.xlsx', '.xls', '.csv']} maxSizeMb={5} file={file} onFileChange={(f) => void onFile(f)} />}
          </CardContent>
        </Card>
      )}

      {preview && (
        <div className="space-y-6">
          <section aria-label="Import summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Rows / orders" value={`${formatNumber(preview.rows)} / ${formatNumber(preview.orders.length)}`} hint={file?.name} icon={FileSpreadsheet} />
            <KpiCard label="Orders ready" value={formatNumber(importable)} icon={CheckCircle2} accent="available" />
            <KpiCard label="With warnings" value={formatNumber(preview.warnings)} hint="Production needed, defaults used" icon={AlertTriangle} accent={preview.warnings ? 'pending' : 'neutral'} />
            <KpiCard label="With errors" value={formatNumber(preview.errors)} hint="Held back; see the report" icon={XCircle} accent={preview.errors ? 'shortage' : 'neutral'} />
          </section>

          {!result && (preview.missing_customers.length > 0 || preview.missing_products.length > 0) && (
            <Card>
              <CardHeader><div><CardTitle>Missing customers and products</CardTitle><CardDescription>Add them here, then check the file again.</CardDescription></div>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void check()}>{busy === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again</Button></CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {preview.missing_customers.map((c) => has('customers.manage') && (
                  <Button key={`c-${c.name}`} size="sm" variant="outline" onClick={() => setQuickCustomer(c.name)}><UserPlus /> Add customer {c.name}</Button>
                ))}
                {preview.missing_products.map((p) => has('products.create') && (
                  <Button key={`p-${p.sku}`} size="sm" variant="outline" onClick={() => setQuickProduct({ sku: p.sku, name: p.name ?? '' })}><PackagePlus /> Add product {p.sku}</Button>
                ))}
              </CardContent>
            </Card>
          )}

          {result && (
            <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
              {result.created_count} sales order(s) created, {result.failed_count} order(s) not imported. Recorded in <Link className="underline" to={`/admin/bulk-operations?job=${result.job_id}`}>Bulk Operations</Link>.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FilterTabs<Filter> label="Orders" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: 'All' }, { value: 'ready', label: 'Ready' }, { value: 'warning', label: 'Warnings' }, { value: 'error', label: 'Errors' }]} />
          </div>
          <div className="space-y-3">{shown.map((g) => {
            const c = created.get(g.first_row)
            const f = failed.get(g.first_row)
            return (
              <Card key={g.first_row}>
                <CardContent className="space-y-2 p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p><span className="font-semibold">{g.customer_name ?? '—'}</span> · ref {g.customer_reference ?? '—'} · {g.order_date ? formatDate(g.order_date) : 'no date'} · rows {g.rows.map((r) => r.row_number).join(', ')} · {money(g.estimated_total)}</p>
                    {c ? <StatusBadge label={`Imported ${c.sales_order_number}`} tone="success" />
                      : f ? <StatusBadge label="Not imported" tone="danger" />
                      : g.status === 'ERROR' ? <StatusBadge label="Error" tone="danger" /> : g.status === 'WARNING' ? <StatusBadge label="Ready (warnings)" tone="warning" /> : <StatusBadge label="Ready" tone="success" />}
                  </div>
                  <ul className="space-y-0.5 text-xs">
                    {g.rows.map((r) => (
                      <li key={r.row_number}>Row {r.row_number}: {r.sku ?? '—'} {r.quantity !== null ? formatQty(r.quantity, r.unit ?? undefined) : ''}{r.unit_price !== null ? ` @ ${money(r.unit_price)}` : ''}
                        {r.errors.map((m) => <span key={m} className="block text-red-700">{m}</span>)}
                        {r.warnings.map((m) => <span key={m} className="block text-amber-800">{m}</span>)}</li>
                    ))}
                    {(f ?? g.errors).map((m) => <li key={m} className="text-red-700">{m}</li>)}
                    {g.warnings.map((m) => <li key={m} className="text-amber-800">{m}</li>)}
                  </ul>
                </CardContent>
              </Card>
            )
          })}{shown.length === 0 && <p className="flex items-center gap-2 text-sm text-muted-foreground"><ClipboardList className="size-4" /> No orders match this filter.</p>}</div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={reset}>{result ? 'Import another file' : 'Choose another file'}</Button>
            <Button variant="outline" onClick={() => void downloadReport()}><Download /> Download {result ? 'report' : 'error report'}</Button>
            {!result && <Button disabled={busy !== null || importable === 0} onClick={() => setConfirm(true)}>{busy === 'importing' ? <Loader2 className="animate-spin" /> : <Upload />} Import {importable} order(s)</Button>}
            {result && <Button asChild><Link to="/sales/orders">Go to sales orders</Link></Button>}
          </div>
        </div>
      )}

      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Import ${importable} sales order(s)?`}
        description={`Each order is saved as an open order and available stock is reserved for it. ${preview?.errors ?? 0} order(s) with errors are not imported.`}
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
