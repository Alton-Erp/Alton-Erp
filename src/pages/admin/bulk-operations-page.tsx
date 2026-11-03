import { Download, FileSpreadsheet, Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import type { PermissionCode } from '@/auth/permissions'
import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CellValue } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, toIsoDate } from '@/lib/format'
import { fetchImportJobRows, fetchImportJobs, type ImportJob, type ImportJobRow } from '@/services/admin'

const TYPE_LABELS: Record<ImportJob['import_type'], string> = { PRODUCTS: 'Products', OPENING_STOCK: 'Opening stock', CUSTOMER_PO: 'Customer purchase order', SUPPLIER_PO: 'Supplier purchase order', BOMS: 'Bill of materials', PRODUCTION: 'Production', SALES_ORDER: 'Sales orders', INVOICE: 'Invoices' }
const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { COMPLETED: 'success', COMPLETED_WITH_ERRORS: 'warning', FAILED: 'danger', REJECTED: 'danger' }
const STATUS_LABEL: Record<string, string> = { COMPLETED: 'Completed', COMPLETED_WITH_ERRORS: 'Completed with errors', FAILED: 'Failed', REJECTED: 'Rejected (nothing imported)' }
/** Where rejected rows are corrected and imported again (the existing import pages; no new import path). */
// Customer PO uploads belong to the previous ERP; their history stays readable but has no import page in V2.
const RETRY_PATH: Partial<Record<ImportJob['import_type'], { path: string; permission: PermissionCode }>> = {
  PRODUCTS: { path: '/products/import', permission: 'products.import' },
  OPENING_STOCK: { path: '/inventory/opening-stock/import', permission: 'inventory_opening.create' },
  SUPPLIER_PO: { path: '/purchase-orders/new', permission: 'purchase_order.create' },
  BOMS: { path: '/production/boms/import', permission: 'production_bom.create' },
  PRODUCTION: { path: '/production/import', permission: 'production_order.create' },
  SALES_ORDER: { path: '/sales/orders/import', permission: 'sales_orders.create' },
  INVOICE: { path: '/billing/invoices/import', permission: 'invoices.create' },
}
const OUTCOME_LABEL: Record<string, string> = { FAILED: 'Rejected', DUPLICATE: 'Duplicate', SKIPPED: 'Skipped' }

async function downloadRows(job: ImportJob, rows: ImportJobRow[], kind: 'report' | 'retry', format: 'xlsx' | 'csv') {
  const { downloadSheets } = await import('@/features/products/spreadsheet')
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.row_data ?? {})))]
  const cell = (v: unknown): CellValue => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'boolean' ? (v as CellValue) : String(v))
  const data: CellValue[][] = kind === 'report'
    ? [['Row', 'Outcome', 'Reference', 'Problems', ...columns], ...rows.map((r) => [r.row_number, OUTCOME_LABEL[r.outcome] ?? r.outcome, r.reference, r.messages.join('; '), ...columns.map((c) => cell(r.row_data?.[c]))])]
    // retry file: only rejected rows, original columns, so it can be corrected and imported again
    : [columns, ...rows.filter((r) => r.outcome === 'FAILED').map((r) => columns.map((c) => cell(r.row_data?.[c])))]
  const stem = `${job.import_type.toLowerCase().replace('_', '-')}-${kind === 'report' ? 'errors' : 'rejected-rows'}-${toIsoDate(new Date(job.started_at))}`
  await downloadSheets([{ name: kind === 'report' ? 'Errors' : 'Rejected rows', rows: data }], stem, format)
}

function JobDialog({ job, onClose }: { job: ImportJob; onClose: () => void }) {
  const { has } = usePermissions()
  const rows = useAsync(() => fetchImportJobRows(job.id), [job.id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retry = RETRY_PATH[job.import_type]
  const failed = rows.data?.filter((r) => r.outcome === 'FAILED').length ?? 0
  const run = (fn: () => Promise<void>) => { setBusy(true); setError(null); fn().catch((e) => setError(describeDataError(e))).finally(() => setBusy(false)) }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>{TYPE_LABELS[job.import_type]} import · {formatDateTime(job.started_at)}</DialogTitle>
          <DialogDescription>{job.file_name ?? 'No file name'}{job.source_reference ? ` · ${job.source_reference}` : ''} · {job.total_rows} rows: {job.success_rows} imported, {job.failed_rows} rejected, {job.duplicate_rows} duplicates, {job.skipped_rows} skipped.
            {job.retry_of_job_id ? ' This was a retry of an earlier import.' : ''}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {rows.loading ? <LoadingState variant="table" rows={4} /> : rows.error ? <ErrorState message={describeDataError(rows.error)} onRetry={rows.reload} />
          : !rows.data?.length ? <p className="text-sm text-muted-foreground">Every row was imported; no problems were recorded.</p> : (
            <div className="max-h-[50vh] overflow-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">Outcome</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Problems</th></tr></thead>
                <tbody className="divide-y">{rows.data.map((r) => (
                  <tr key={r.id}><td className="px-3 py-2">{r.row_number}</td><td className="px-3 py-2"><StatusBadge label={OUTCOME_LABEL[r.outcome] ?? r.outcome} tone={r.outcome === 'FAILED' ? 'danger' : 'neutral'} /></td>
                    <td className="px-3 py-2">{r.reference ?? '—'}</td><td className="px-3 py-2 text-xs">{r.messages.join('; ')}</td></tr>))}</tbody>
              </table>
            </div>
          )}
        {failed > 0 && retry && <p className="text-sm text-muted-foreground">To retry: download the rejected rows, correct them, and import that file on the {TYPE_LABELS[job.import_type].toLowerCase()} import page. Rows that were already imported are not in the file, and the import page still rejects duplicates.</p>}
        <DialogFooter className="flex-wrap gap-2">
          {!!rows.data?.length && <>
            <Button variant="outline" disabled={busy} onClick={() => run(() => downloadRows(job, rows.data!, 'report', 'xlsx'))}>{busy ? <Loader2 className="animate-spin" /> : <Download />} Error report (Excel)</Button>
            <Button variant="outline" disabled={busy} onClick={() => run(() => downloadRows(job, rows.data!, 'report', 'csv'))}><Download /> CSV</Button>
          </>}
          {failed > 0 && <Button variant="outline" disabled={busy} onClick={() => run(() => downloadRows(job, rows.data!, 'retry', 'xlsx'))}><Download /> Rejected rows to correct</Button>}
          {failed > 0 && retry && has(retry.permission) &&<Button asChild><Link to={`${retry.path}?retry=${job.id}`}><RotateCcw /> Retry on import page</Link></Button>}
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function BulkOperationsPage() {
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('all')
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(20)
  const jobs = useAsync(() => fetchImportJobs(type === 'all' ? null : type, status === 'all' ? null : status, page, size), [type, status, page, size])
  const [open, setOpen] = useState<ImportJob | null>(null)
  return (
    <>
      <PageHeader />
      <Card><CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="bo-type">Import type</Label>
            <Select value={type} onValueChange={(v) => { setType(v); setPage(0) }}><SelectTrigger id="bo-type" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All imports</SelectItem>{Object.entries(TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="bo-status">Result</Label>
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0) }}><SelectTrigger id="bo-status" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">Any result</SelectItem>{Object.entries(STATUS_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}</SelectContent></Select></div>
          <p className="pb-2 text-xs text-muted-foreground">Imports are recorded from the product, opening-stock and customer-PO import pages. Uploaded files themselves are not stored.</p>
        </div>
        {jobs.loading && !jobs.data ? <LoadingState variant="table" rows={6} /> : jobs.error ? <ErrorState message={describeDataError(jobs.error)} onRetry={jobs.reload} />
          : !jobs.data?.rows.length ? <EmptyState icon={FileSpreadsheet} title="No imports recorded" description="Imports appear here after they run on the import pages." /> : (
            <>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-muted/50 text-left text-xs text-muted-foreground"><tr><th className="px-3 py-2">Started</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">File / reference</th><th className="px-3 py-2">Result</th><th className="px-3 py-2 text-right">Rows</th><th className="px-3 py-2 text-right">Imported</th><th className="px-3 py-2 text-right">Rejected</th><th className="px-3 py-2 text-right">Duplicates</th><th /></tr></thead>
                  <tbody className="divide-y">{jobs.data.rows.map((j) => (
                    <tr key={j.id}>
                      <td className="px-3 py-2 text-xs">{formatDateTime(j.started_at)}</td><td className="px-3 py-2">{TYPE_LABELS[j.import_type]}{j.retry_of_job_id ? ' (retry)' : ''}</td>
                      <td className="max-w-64 truncate px-3 py-2">{j.file_name ?? '—'}{j.source_reference ? ` · ${j.source_reference}` : ''}</td>
                      <td className="px-3 py-2"><StatusBadge label={STATUS_LABEL[j.status] ?? j.status} tone={STATUS_TONE[j.status] ?? 'neutral'} /></td>
                      <td className="px-3 py-2 text-right">{j.total_rows}</td><td className="px-3 py-2 text-right">{j.success_rows}</td><td className="px-3 py-2 text-right">{j.failed_rows}</td><td className="px-3 py-2 text-right">{j.duplicate_rows}</td>
                      <td className="px-3 py-2"><Button size="sm" variant="outline" onClick={() => setOpen(j)}>Details</Button></td>
                    </tr>))}</tbody>
                </table>
              </div>
              <PaginationBar page={page} pageSize={size} total={jobs.data.total} onPageChange={setPage} onPageSizeChange={(n) => { setSize(n); setPage(0) }} disabled={jobs.loading} />
            </>
          )}
      </CardContent></Card>
      {open && <JobDialog job={open} onClose={() => setOpen(null)} />}
    </>
  )
}
