import { AlertTriangle, CheckCircle2, Download, Loader2, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  CONFIRM_PHRASE,
  blockerText,
  confirmMessage,
  failedRecordReport,
  type BulkDeletePreview,
  type BulkDeleteResult,
} from '@/features/products/product-bulk-delete'
import { formatCost, formatMrp, gstText, hsnText } from '@/features/products/product-list-format'
import { describeDataError } from '@/lib/errors'
import { formatNumber, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { bulkDeleteProducts, previewBulkDelete } from '@/services/products'

export type SelectedProduct = { id: string; sku: string; product_name: string }

/**
 * Confirmation and results of a bulk delete. The database decides what may be deleted (never-used
 * products only) both for the preview and again when deleting; this dialog only shows it.
 */
export function BulkDeleteDialog({ open, onOpenChange, selected, onFinished }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  selected: Map<string, SelectedProduct>
  onFinished: (result: BulkDeleteResult) => void
}) {
  const [preview, setPreview] = useState<BulkDeletePreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reason, setReason] = useState('Duplicate product')
  const [phrase, setPhrase] = useState('')
  const [archiveBlocked, setArchiveBlocked] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [result, setResult] = useState<BulkDeleteResult | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())

  // A fresh preview (and request id) each time the dialog opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setPreview(null)
    setLoadError(null)
    setResult(null)
    setRunError(null)
    setPhrase('')
    setArchiveBlocked(false)
    setRequestId(crypto.randomUUID())
    previewBulkDelete([...selected.keys()])
      .then((p) => !cancelled && setPreview(p))
      .catch((e) => !cancelled && setLoadError(describeDataError(e)))
    return () => {
      cancelled = true
    }
    // Only when opened: the selection cannot change while the dialog is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const count = selected.size
  const archivable = preview?.products.filter((p) => !p.deletable && p.can_archive).length ?? 0
  const willDo = (preview?.deletable ?? 0) > 0 || (archiveBlocked && archivable > 0)
  const canRun = Boolean(preview) && phrase === CONFIRM_PHRASE && reason.trim().length >= 3 && willDo && !running

  const run = async () => {
    setRunning(true)
    setRunError(null)
    try {
      const r = await bulkDeleteProducts([...selected.keys()], phrase, reason.trim(), archiveBlocked, requestId)
      if (r.status === 'DENIED') {
        setRunError(r.error ?? 'The deletion was refused.')
      } else {
        setResult(r)
        onFinished(r)
      }
    } catch (e) {
      setRunError(describeDataError(e))
    } finally {
      setRunning(false)
    }
  }

  const downloadReport = async () => {
    if (!result) return
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: 'Not deleted', rows: failedRecordReport(result, selected) }], `product-delete-report-${toIsoDate(new Date())}`, 'xlsx')
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="sm:max-w-5xl" data-testid="bulk-delete-dialog">
        <DialogHeader>
          <DialogTitle>{result ? 'Bulk delete finished' : `Delete ${formatNumber(count)} selected ${count === 1 ? 'product' : 'products'}?`}</DialogTitle>
          <DialogDescription>{result ? 'What happened to each selected product.' : confirmMessage(count)}</DialogDescription>
        </DialogHeader>

        {!result && !preview && !loadError && (
          <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking every selected product for transactions…</p>
        )}
        {loadError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{loadError}</p>}

        {!result && preview && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-sm" data-testid="bulk-delete-counts">
              <span className="rounded-full bg-red-50 px-3 py-1 font-medium text-red-800">{formatNumber(preview.deletable)} will be permanently deleted</span>
              <span className="rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-900">{formatNumber(preview.blocked)} protected (linked to transactions)</span>
              {preview.not_found.length > 0 && <span className="rounded-full bg-muted px-3 py-1">{formatNumber(preview.not_found.length)} not found</span>}
            </div>
            <div className="max-h-[45vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Product name</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">MRP</TableHead>
                    <TableHead>HSN</TableHead>
                    <TableHead className="text-right">GST</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.products.map((p) => (
                    <TableRow key={p.id} data-sku={p.sku} data-deletable={p.deletable ? 'true' : 'false'}>
                      <TableCell className="min-w-40 whitespace-normal font-medium">{p.product_name}</TableCell>
                      <TableCell>{p.sku}</TableCell>
                      <TableCell className="text-muted-foreground">{p.category ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCost(p.standard_manufacturing_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMrp(p.mrp)}</TableCell>
                      <TableCell className="tabular-nums">{hsnText(p.hsn_code) ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{gstText(p.gst_rate) ?? '—'}</TableCell>
                      <TableCell className="min-w-56 whitespace-normal text-xs">
                        {p.deletable ? (
                          <span className="inline-flex items-center gap-1 font-medium text-red-700"><Trash2 className="size-3.5" /> Will be deleted (never used)</span>
                        ) : (
                          <span className="text-amber-900">
                            <span className="inline-flex items-center gap-1 font-medium"><ShieldAlert className="size-3.5" /> Protected</span>
                            <span className="block">{blockerText(p.blockers)}</span>
                            {archiveBlocked && (p.can_archive ? <span className="block">Will be archived instead.</span>
                              : p.archived ? <span className="block">Already archived.</span> : <span className="block">Cannot be archived: it still has stock.</span>)}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {preview.blocked > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={archiveBlocked} onCheckedChange={(v) => setArchiveBlocked(v === true)} className="mt-0.5" aria-label="Archive protected products instead" />
                <span>
                  Archive the protected products instead ({formatNumber(archivable)} can be archived). Archived products are hidden from lists, keep all
                  their history and can be restored later.
                </span>
              </label>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bd-reason">Reason (recorded in the audit history)</Label>
                <Input id="bd-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bd-phrase">Type <span className="font-mono font-semibold">{CONFIRM_PHRASE}</span> to confirm</Label>
                <Input id="bd-phrase" value={phrase} autoComplete="off" onChange={(e) => setPhrase(e.target.value)}
                  aria-invalid={phrase !== '' && phrase !== CONFIRM_PHRASE} />
                {phrase !== '' && phrase !== CONFIRM_PHRASE && <p className="text-xs text-red-700">The phrase does not match.</p>}
              </div>
            </div>
            {!willDo && <p className="text-sm text-muted-foreground">Nothing can be deleted: every selected product is linked to transactions or history.</p>}
            {runError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{runError}</p>}
          </div>
        )}

        {result && <ResultSummary result={result} />}

        <DialogFooter>
          {result ? (
            <>
              {failedRecordReport(result, selected).length > 1 && (
                <Button variant="outline" onClick={() => void downloadReport()}>
                  <Download />
                  Download failed-record report
                </Button>
              )}
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
              <Button variant="destructive" onClick={() => void run()} disabled={!canRun}>
                {running ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {(preview?.deletable ?? 0) > 0 ? `Delete ${formatNumber(preview?.deletable ?? 0)} ${preview?.deletable === 1 ? 'product' : 'products'}` : 'Archive protected products'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ResultSummary({ result }: { result: BulkDeleteResult }) {
  const archived = result.blocked.filter((b) => b.archived_now)
  const kept = result.blocked.filter((b) => !b.archived_now)
  const failedCount = result.failed.length + result.not_found.length
  return (
    <div className="space-y-4" data-testid="bulk-delete-result">
      {result.status === 'FAILED' && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> The deletion failed and was rolled back: no product was deleted or archived. {result.error}
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-4">
        <Count label="Successfully deleted" value={result.deleted.length} tone="success" />
        <Count label="Blocked (transactions)" value={kept.length} tone="warning" />
        <Count label="Archived instead" value={archived.length} tone="neutral" />
        <Count label="Failed" value={failedCount} tone="danger" />
      </div>
      <div className="max-h-[40vh] space-y-3 overflow-auto text-sm">
        {result.deleted.length > 0 && (
          <Section title="Deleted">
            {result.deleted.map((d) => <li key={d.id}><CheckCircle2 className="mr-1 inline size-3.5 text-available" />{d.sku} — {d.product_name}</li>)}
          </Section>
        )}
        {kept.length > 0 && (
          <Section title="Blocked: linked to transactions (kept)">
            {kept.map((b) => (
              <li key={b.id}><span className="font-medium">{b.sku} — {b.product_name}:</span> {blockerText(b.blockers)}{b.archive_error && ` Not archived: ${b.archive_error}`}</li>
            ))}
          </Section>
        )}
        {archived.length > 0 && (
          <Section title="Archived instead">
            {archived.map((b) => <li key={b.id}>{b.sku} — {b.product_name}</li>)}
          </Section>
        )}
        {failedCount > 0 && (
          <Section title="Failed">
            {result.failed.map((f) => <li key={f.id} className="text-red-800">{f.sku} — {f.product_name}: {f.reason}</li>)}
            {result.not_found.map((id) => <li key={id} className="text-red-800">{id}: not found in your company (already deleted or not yours).</li>)}
          </Section>
        )}
      </div>
    </div>
  )
}

function Count({ label, value, tone }: { label: string; value: number; tone: 'success' | 'warning' | 'neutral' | 'danger' }) {
  const color = { success: 'border-emerald-200 bg-emerald-50 text-emerald-900', warning: 'border-amber-200 bg-amber-50 text-amber-900',
    neutral: 'border-slate-200 bg-slate-50 text-slate-800', danger: 'border-red-200 bg-red-50 text-red-900' }[tone]
  return (
    <div className={cn('rounded-lg border px-3 py-2', color)}>
      <p className="text-xs">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{formatNumber(value)}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-medium">{title}</p>
      <ul className="space-y-0.5 pl-1">{children}</ul>
    </div>
  )
}
