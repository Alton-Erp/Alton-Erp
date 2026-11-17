import { AlertTriangle, ArrowLeft, CheckCircle2, Download, Loader2, RefreshCw, Rocket, RotateCcw, Send, Trash2, Undo2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import {
  BATCH_STATUS_LABELS, BATCH_STATUS_TONE, EVENT_LABELS, OPERATION_LABELS, batchExportSheets, changeText, lineIdsOfFailingBoms, qtyText, unusedAfterChange,
} from '@/features/production/bom-bulk-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import {
  batchAction, createReversal, fetchBatch, publishBatch, removeBatchLines, validateBatch, type BatchAction, type BatchDetail,
} from '@/services/bom-bulk'

type Pending = { kind: BatchAction | 'PUBLISH' | 'REVERSE' | 'REMOVE_ERRORS'; title: string; description: string; needsNote: boolean; noteLabel?: string; confirm: string }

const PENDING: Record<Pending['kind'], Omit<Pending, 'kind'>> = {
  SUBMIT: { title: 'Submit for approval?', description: 'An authorised approver (production_bom.approve) reviews the preview and impact before anything changes.', needsNote: false, noteLabel: 'Note (optional)', confirm: 'Submit' },
  WITHDRAW: { title: 'Withdraw the batch?', description: 'It goes back to draft. Approval, if given, is cleared.', needsNote: false, noteLabel: 'Note (optional)', confirm: 'Withdraw' },
  APPROVE: { title: 'Approve this change?', description: 'The batch is checked again against the BOMs as they are now. Publishing is a separate step.', needsNote: false, noteLabel: 'Approval note (optional)', confirm: 'Approve' },
  REJECT: { title: 'Reject this change?', description: 'The creator is notified and can correct and resubmit it.', needsNote: true, noteLabel: 'Reason for rejecting', confirm: 'Reject' },
  CANCEL: { title: 'Cancel this batch?', description: 'A cancelled batch cannot be published. Its history is kept.', needsNote: false, noteLabel: 'Note (optional)', confirm: 'Cancel batch' },
  PUBLISH: { title: 'Publish now?', description: 'All BOMs are updated together in one transaction: each gets a new revision effective from the batch date and the previous revision is kept. If any BOM fails, none is changed.', needsNote: false, confirm: 'Publish' },
  REVERSE: { title: 'Create a reversal?', description: 'A new draft batch restores, as a further revision, the components each BOM had before this batch. It needs approval like any change.', needsNote: true, noteLabel: 'Reason for the reversal', confirm: 'Create reversal draft' },
  REMOVE_ERRORS: { title: 'Remove BOMs with errors?', description: 'Every line of a BOM that has an error is removed from this draft. The other BOMs stay.', needsNote: false, confirm: 'Remove' },
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'danger' | 'warning' }) {
  return (
    <div className="rounded-lg border bg-background px-4 py-3">
      <div className="text-xs text-muted-foreground uppercase">{label}</div>
      <div className={`text-xl font-semibold tabular-nums ${tone === 'danger' ? 'text-red-700' : tone === 'warning' ? 'text-amber-700' : ''}`}>{value}</div>
    </div>
  )
}

/** Preview, impact, approval workflow and publishing of one change batch. */
export function BatchDetailView({ batchId, onBack, onOpen }: { batchId: string; onBack: () => void; onOpen: (id: string) => void }) {
  const q = useAsync(() => fetchBatch(batchId), [batchId])
  const [override, setOverride] = useState<BatchDetail | null>(null)
  const d = override && override.batch.id === batchId ? override : q.data
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState('')
  const [today] = useState(() => toIsoDate(new Date()))
  const [reverseDate, setReverseDate] = useState(today)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [onlyErrors, setOnlyErrors] = useState(false)

  if (q.loading && !d) return <p className="text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading batch…</p>
  if (q.error && !d) return <p role="alert" className="text-sm text-red-700">{describeDataError(q.error)}</p>
  if (!d) return null
  const b = d.batch
  const s = b.summary
  const errors = s.lines_with_errors ?? 0
  const unused = unusedAfterChange(d)
  const lines = onlyErrors ? d.lines.filter((l) => l.validation_errors.length > 0 || l.warnings.length > 0) : d.lines

  const open = (kind: Pending['kind']) => { setNote(''); setMessage(null); setPending({ kind, ...PENDING[kind] }) }
  const run = async () => {
    if (!pending) return
    setBusy(true)
    try {
      if (pending.kind === 'PUBLISH') {
        const r = await publishBatch(b.id, b.row_version, crypto.randomUUID())
        setOverride(r.batch)
        setMessage(r.ok ? { tone: 'success', text: `Published: ${r.revisions?.length ?? 0} new BOM revision(s).` } : { tone: 'error', text: r.message ?? 'Publishing failed; nothing was changed.' })
      } else if (pending.kind === 'REVERSE') {
        const r = await createReversal(b.id, note.trim(), reverseDate)
        onOpen(r.batch.id)
      } else if (pending.kind === 'REMOVE_ERRORS') {
        setOverride(await removeBatchLines(b.id, b.row_version, lineIdsOfFailingBoms(d.lines)))
        setMessage({ tone: 'success', text: 'BOMs with errors removed from the draft.' })
      } else {
        setOverride(await batchAction(b.id, pending.kind, note.trim() || null, b.row_version))
        setMessage({ tone: 'success', text: `${EVENT_LABELS[pending.kind === 'SUBMIT' ? 'SUBMITTED' : pending.kind === 'APPROVE' ? 'APPROVED' : pending.kind === 'REJECT' ? 'REJECTED' : pending.kind === 'WITHDRAW' ? 'WITHDRAWN' : 'CANCELLED']}.` })
      }
      setPending(null)
    } catch (e) {
      setMessage({ tone: 'error', text: describeDataError(e) })
      setPending(null)
    } finally {
      setBusy(false)
    }
  }
  const revalidate = async () => {
    setBusy(true)
    setMessage(null)
    try { setOverride(await validateBatch(b.id)) } catch (e) { setMessage({ tone: 'error', text: describeDataError(e) }) } finally { setBusy(false) }
  }
  const exportBatch = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets(batchExportSheets(d), `${b.batch_number}-${toIsoDate(new Date())}`, 'xlsx')
  }

  return (
    <div className="space-y-4" data-testid="batch-detail" data-status={b.status}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft /> All batches</Button>
          <h2 className="text-lg font-semibold">{b.batch_number}</h2>
          <StatusBadge label={BATCH_STATUS_LABELS[b.status]} tone={BATCH_STATUS_TONE[b.status]} />
          <span className="text-sm text-muted-foreground">{OPERATION_LABELS[b.operation]}{b.restores_batch_number ? ` of ${b.restores_batch_number}` : ''}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void exportBatch()}><Download /> Export preview</Button>
          {['DRAFT', 'REJECTED', 'PENDING_APPROVAL', 'APPROVED'].includes(b.status) && <Button variant="outline" disabled={busy} onClick={() => void revalidate()}><RefreshCw /> Re-check</Button>}
          {d.permissions.can_edit && errors > 0 && <Button variant="outline" disabled={busy} onClick={() => open('REMOVE_ERRORS')}><Trash2 /> Remove BOMs with errors</Button>}
          {d.permissions.can_edit && <Button disabled={busy || errors > 0} onClick={() => open('SUBMIT')} data-testid="batch-submit"><Send /> Submit for approval</Button>}
          {['PENDING_APPROVAL', 'APPROVED'].includes(b.status) && <Button variant="outline" disabled={busy} onClick={() => open('WITHDRAW')}><Undo2 /> Withdraw</Button>}
          {d.permissions.can_approve && <Button variant="outline" disabled={busy} onClick={() => open('REJECT')} data-testid="batch-reject"><XCircle /> Reject</Button>}
          {d.permissions.can_approve && <Button disabled={busy || d.permissions.self_approval_blocked} onClick={() => open('APPROVE')} data-testid="batch-approve"><CheckCircle2 /> Approve</Button>}
          {d.permissions.can_publish && <Button disabled={busy} onClick={() => open('PUBLISH')} data-testid="batch-publish"><Rocket /> Publish</Button>}
          {b.status === 'PUBLISHED' && b.operation !== 'RESTORE' && <Button variant="outline" disabled={busy} onClick={() => open('REVERSE')}><RotateCcw /> Create reversal</Button>}
          {!['PUBLISHED', 'CANCELLED'].includes(b.status) && <Button variant="ghost" disabled={busy} onClick={() => open('CANCEL')}>Cancel batch</Button>}
        </div>
      </div>

      {message && <p role={message.tone === 'error' ? 'alert' : 'status'} data-testid="batch-message"
        className={message.tone === 'error' ? 'rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>{message.text}</p>}
      {b.stale && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">The BOMs changed after this batch was submitted. It must be withdrawn, re-checked and submitted again before it can be approved.</p>}
      {b.last_error && b.status !== 'PUBLISHED' && <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">Last publishing attempt: {b.last_error}</p>}
      {d.permissions.can_approve && d.permissions.self_approval_blocked && <p className="text-sm text-amber-800">Segregation of duties is on: you prepared or submitted this batch, so another approver must approve it.</p>}

      <Card>
        <CardHeader>
          <CardTitle>{b.title ?? OPERATION_LABELS[b.operation]}</CardTitle>
          <CardDescription>
            Reason: {b.reason} · Effective from {formatDate(b.effective_from)}{b.merge_duplicates ? ' · merges into existing lines' : ''}
            <br />Prepared by {b.created_by_name ?? '—'} on {formatDateTime(b.created_at)}
            {b.submitted_at && <> · submitted {formatDateTime(b.submitted_at)}{b.submitted_by_name ? ` by ${b.submitted_by_name}` : ''}</>}
            {b.approved_at && <> · approved {formatDateTime(b.approved_at)} by {b.approved_by_name ?? '—'}{b.approval_note ? ` (“${b.approval_note}”)` : ''}</>}
            {b.rejected_at && <> · rejected {formatDateTime(b.rejected_at)} by {b.rejected_by_name ?? '—'}: {b.rejection_reason}</>}
            {b.published_at && <> · published {formatDateTime(b.published_at)} by {b.published_by_name ?? '—'}</>}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="batch-summary">
            <Stat label="BOMs affected" value={formatNumber(s.boms ?? 0)} />
            <Stat label="Component lines" value={formatNumber(s.lines ?? 0)} />
            <Stat label="Lines with errors" value={formatNumber(errors)} tone={errors ? 'danger' : undefined} />
            <Stat label="Products with errors" value={formatNumber(s.products_with_errors?.length ?? 0)} tone={s.products_with_errors?.length ? 'danger' : undefined} />
            <Stat label="Production orders" value={d.impact?.production_orders ? formatNumber(d.impact.production_orders.length) : '—'} tone={d.impact?.production_orders?.length ? 'warning' : undefined} />
          </div>
          {!!s.products_with_errors?.length && (
            <ul className="mt-3 space-y-1 text-sm text-red-800" data-testid="batch-product-errors">
              {s.products_with_errors.slice(0, 20).map((p) => <li key={`${p.finished_product_id}`}><AlertTriangle className="mr-1 inline size-4" /><span className="font-medium">{p.sku ?? 'BOM'}</span>: {p.errors.join(' ')}</li>)}
              {s.products_with_errors.length > 20 && <li>… and {s.products_with_errors.length - 20} more (see the lines below or export the preview).</li>}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Changes ({d.lines.length})</CardTitle>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> Only lines with errors or warnings</label>
        </CardHeader>
        <CardContent className="p-0">
          <div className="max-h-[32rem] overflow-auto">
            <Table data-testid="batch-lines">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow>
                  <TableHead>#</TableHead><TableHead>Finished product</TableHead><TableHead>BOM</TableHead><TableHead>Component</TableHead>
                  <TableHead>Old → new</TableHead><TableHead>Check</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <TableRow key={l.id} className={l.validation_errors.length ? 'bg-red-50/50' : undefined}>
                    <TableCell className="text-xs text-muted-foreground">{l.line_no}</TableCell>
                    <TableCell><span className="font-medium">{l.finished_sku}</span><div className="text-xs text-muted-foreground">{l.finished_name}</div></TableCell>
                    <TableCell className="whitespace-nowrap">{l.bom_code} <span className="text-muted-foreground">v{l.source_version}</span>
                      {l.result_version && <> → <Link className="text-primary hover:underline" to={`/production/boms/${l.result_bom_id}`}>v{l.result_version}</Link></>}</TableCell>
                    <TableCell className="text-sm">
                      {l.action === 'RESTORE' ? <span className="text-muted-foreground">All components</span> : <>{l.component_sku}{l.new_component_sku && <> → <span className="font-medium">{l.new_component_sku}</span></>}</>}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{changeText(l)}</TableCell>
                    <TableCell className="text-xs">
                      {l.validation_errors.map((e) => <div key={e} className="text-red-700">{e}</div>)}
                      {l.warnings.map((w) => <div key={w} className="text-amber-700">{w}</div>)}
                      {!l.validation_errors.length && !l.warnings.length && <span className="text-green-700">OK</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {d.impact && (
        <div className="grid gap-4 xl:grid-cols-2">
          <Card data-testid="batch-orders">
            <CardHeader>
              <CardTitle>Production orders potentially affected</CardTitle>
              <CardDescription>Existing orders keep the BOM revision and material plan they were created with. New orders use the revision effective on the day they are created.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {!d.impact.production_orders_visible ? <p className="px-5 pb-4 text-sm text-muted-foreground">Not visible: requires manufacturing.read.</p>
                : d.impact.production_orders?.length === 0 ? <p className="px-5 pb-4 text-sm text-muted-foreground">No open production order uses these BOM revisions.</p>
                : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Order</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Planned</TableHead><TableHead>Effect</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {d.impact.production_orders?.map((o) => (
                        <TableRow key={o.production_order_id}>
                          <TableCell><Link className="text-primary hover:underline" to={`/production/orders/${o.production_order_id}`}>{o.production_order_number}</Link><div className="text-xs text-muted-foreground">{o.status.replace(/_/g, ' ').toLowerCase()} · {formatDate(o.planned_start_date)}</div></TableCell>
                          <TableCell>{o.sku}<div className="text-xs text-muted-foreground">{o.bom_code} v{o.bom_version}</div></TableCell>
                          <TableCell className="text-right tabular-nums">{qtyText(o.planned_quantity, o.unit)}</TableCell>
                          <TableCell className="text-xs">{o.effect}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
            </CardContent>
          </Card>
          <Card data-testid="batch-inventory">
            <CardHeader>
              <CardTitle>Inventory and procurement impact</CardTitle>
              <CardDescription>{d.impact.note}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-0">
              {unused.length > 0 && <ul className="mx-5 space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{unused.map((u) => <li key={u}>{u}</li>)}</ul>}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Component</TableHead><TableHead>Role</TableHead><TableHead className="text-right">Current BOMs (after)</TableHead>
                    <TableHead className="text-right">Available</TableHead><TableHead className="text-right">Open POs</TableHead><TableHead className="text-right">Used (90 d)</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {d.impact.components.map((c) => (
                      <TableRow key={c.product_id}>
                        <TableCell>{c.sku}<div className="text-xs text-muted-foreground">{c.product_name}</div></TableCell>
                        <TableCell className="text-xs">{c.roles.split(',').map((r) => r.toLowerCase()).join(', ')}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.current_boms} ({c.current_boms_after})</TableCell>
                        <TableCell className="text-right tabular-nums">{d.impact!.stock_visible ? qtyText(c.available, c.unit) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.impact!.purchases_visible ? qtyText(c.open_po_quantity, c.unit) : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.consumed_90_days === null ? '—' : qtyText(c.consumed_90_days, c.unit)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {(!d.impact.stock_visible || !d.impact.purchases_visible) && <p className="px-5 pb-3 text-xs text-muted-foreground">Some columns need inventory.read or purchase permissions.</p>}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>Approval and audit history</CardTitle></CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm" data-testid="batch-events">
            {d.events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-2"><span className="font-medium">{EVENT_LABELS[e.action] ?? e.action}</span>
                <span className="text-muted-foreground">{formatDateTime(e.acted_at)} · {e.actor_name ?? '—'}</span>{e.note && <span>— {e.note}</span>}</li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o && !busy) setPending(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription>{pending?.description}</DialogDescription>
          </DialogHeader>
          {pending?.kind === 'PUBLISH' && <p className="text-sm">{formatNumber(s.boms ?? 0)} BOM(s) get a new revision effective {formatDate(b.effective_from)}.</p>}
          {pending?.kind === 'REVERSE' && (
            <div className="space-y-1.5"><Label htmlFor="reverse-date">Effective from</Label><Input id="reverse-date" type="date" min={today} value={reverseDate} onChange={(e) => setReverseDate(e.target.value)} /></div>
          )}
          {pending?.noteLabel && (
            <div className="space-y-1.5"><Label htmlFor="batch-note">{pending.noteLabel}</Label><Textarea id="batch-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPending(null)}>Back</Button>
            <Button disabled={busy || (pending?.needsNote === true && note.trim().length < 3)} onClick={() => void run()} data-testid="batch-confirm">
              {busy && <Loader2 className="animate-spin" />} {pending?.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
