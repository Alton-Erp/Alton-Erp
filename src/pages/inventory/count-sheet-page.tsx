import { Check, Download, FileUp, Loader2, Plus, Save, Send, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { COUNT_SHEET_HEADERS, parseCountSheet, type CountSheetResult } from '@/features/inventory/count-sheet'
import { DocumentStatusBadge, StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { LocationSelect, ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, toIsoDate } from '@/lib/format'
import {
  addCountLine,
  cancelCount,
  fetchCount,
  fetchCountLines,
  fetchInventoryPolicy,
  postCount,
  recordCount,
  reviewCount,
  submitCount,
  type ProductOption,
} from '@/services/inventory'
import { fetchDisplayNames } from '@/services/products'

type View = 'all' | 'uncounted' | 'variance'

async function load(id: string) {
  const [count, lines, policy] = await Promise.all([fetchCount(id), fetchCountLines(id), fetchInventoryPolicy()])
  return { count, lines, policy }
}

export default function CountSheetPage() {
  const { countId = '' } = useParams()
  const { user } = useAuth()
  const { has } = usePermissions()
  const storage = useStorage()
  const [refresh, setRefresh] = useState(0)
  const { data, loading, error, reload } = useAsync(() => load(countId), [countId, refresh])
  const names = useAsync(() => fetchDisplayNames(data ? [data.count.created_by, data.count.submitted_by, data.count.reviewed_by, ...data.lines.map((l) => l.counted_by)] : []), [data])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [view, setView] = useState<View>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState<CountSheetResult | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [confirmPost, setConfirmPost] = useState(false)

  const lines = useMemo(() => data?.lines ?? [], [data])
  const valueOf = (id: string, fallback: number | null) => (id in edits ? edits[id] : fallback === null ? '' : String(fallback))
  const dirty = Object.keys(edits).length > 0

  if (loading && !data) return <LoadingState label="Loading count…" />
  if (error || !data) {
    return (
      <>
        <PageHeader title="Stock count" breadcrumbs={[{ label: 'Inventory' }, { label: 'Physical Stock Count', to: '/inventory/counts' }, { label: 'Count' }]} />
        <Card><ErrorState message={describeDataError(error)} onRetry={reload} /></Card>
      </>
    )
  }

  const { count, policy } = data
  const open = count.status === 'OPEN'
  const counted = lines.filter((l) => l.counted_quantity !== null)
  const variances = counted.filter((l) => Number(l.variance) !== 0)
  const shown = lines.filter((l) => (view === 'all' ? true : view === 'uncounted' ? l.counted_quantity === null : l.counted_quantity !== null && Number(l.variance) !== 0))
  const iCountedOrCreated = [count.created_by, count.submitted_by, ...lines.map((l) => l.counted_by)].includes(user?.id ?? null)
  // V2 single-operator: a user who may approve submits and posts the count in one step.
  const canPost = has('inventory_count.approve') && !policy.segregation_of_duties

  const say = (tone: 'success' | 'error', text: string) => setNotice({ tone, text })
  const run = async (label: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(label)
    setNotice(null)
    try {
      await fn()
      say('success', success)
      setRefresh((n) => n + 1)
    } catch (e) {
      say('error', describeDataError(e))
    } finally {
      setBusy(null)
    }
  }

  const save = () => {
    const updates = Object.entries(edits).map(([line_id, v]) => {
      const t = v.trim().replace(/,/g, '')
      return { line_id, counted_quantity: t === '' ? null : Number(t) }
    })
    if (updates.some((u) => u.counted_quantity !== null && (Number.isNaN(u.counted_quantity) || u.counted_quantity < 0))) {
      return say('error', 'Counted quantities must be numbers ≥ 0.')
    }
    return run('save', async () => {
      await recordCount(count.id, updates)
      setEdits({})
    }, `Saved ${updates.length} counted line(s). Stock is unchanged until the count is approved.`)
  }

  const exportSheet = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets(
      [{ name: count.count_number, rows: [[...COUNT_SHEET_HEADERS], ...lines.map((l) => [l.id, l.sku, l.product_name, l.warehouse_code, l.location_code, l.batch_number, l.source_type, l.base_unit, Number(l.system_quantity), l.counted_quantity === null ? null : Number(l.counted_quantity), l.notes])] }],
      `${count.count_number}-sheet-${toIsoDate(new Date())}`,
      'xlsx',
    )
  }

  const importSheet = async (file: File) => {
    try {
      const { parseWorkbook } = await import('@/features/products/spreadsheet')
      const wb = await parseWorkbook(await file.arrayBuffer())
      const result = parseCountSheet(wb.rows(wb.sheetNames[0]), lines.map((l) => ({ id: l.id, sku: l.sku, system_quantity: Number(l.system_quantity), counted_quantity: l.counted_quantity === null ? null : Number(l.counted_quantity), notes: l.notes })))
      setImporting(result)
    } catch {
      say('error', 'The file could not be read. Use the .xlsx or .csv exported from this count.')
    }
  }

  return (
    <>
      <PageHeader
        title={`Stock count ${count.count_number}`}
        description={`${storage.warehouseById.get(count.warehouse_id)?.warehouse_code ?? ''}${count.location_id ? ` / ${storage.locationById.get(count.location_id)?.location_code ?? ''}` : ' (whole warehouse)'} · system quantities captured ${formatDateTime(count.snapshot_at)}`}
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Physical Stock Count', to: '/inventory/counts' }, { label: count.count_number }]}
        actions={
          <>
            <DocumentStatusBadge status={count.status} />
            <Button variant="outline" onClick={() => void exportSheet()}><Download /> Export sheet</Button>
            {open && has('inventory_count.create') && (
              <>
                <label className="inline-flex">
                  <input type="file" accept=".xlsx,.xls,.csv" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importSheet(f) }} />
                  <span className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium shadow-xs hover:bg-muted"><FileUp className="size-4" /> Import sheet</span>
                </label>
                <Button variant="outline" onClick={() => setAdding(true)}><Plus /> Add found item</Button>
                <Button variant="outline" disabled={!dirty || busy !== null} onClick={() => void save()}>{busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />} Save counts</Button>
                {canPost ? (
                  <Button disabled={dirty || busy !== null || counted.length === 0} title={dirty ? 'Save your changes first' : undefined} onClick={() => setConfirmPost(true)}>
                    {busy === 'post' ? <Loader2 className="animate-spin" /> : <Check />} Post count
                  </Button>
                ) : (
                  <Button disabled={dirty || busy !== null || counted.length === 0} title={dirty ? 'Save your changes first' : undefined}
                    onClick={() => void run('submit', () => submitCount(count.id), 'Count submitted for approval.')}>
                    {busy === 'submit' ? <Loader2 className="animate-spin" /> : <Send />} Submit for approval
                  </Button>
                )}
              </>
            )}
            {count.status === 'SUBMITTED' && has('inventory_count.approve') && (
              <span title={iCountedOrCreated && policy.segregation_of_duties ? 'Segregation of duties: another user must approve' : undefined}>
                <Button disabled={iCountedOrCreated && policy.segregation_of_duties} onClick={() => setReviewOpen(true)}><Check /> Review count</Button>
              </span>
            )}
            <ConfirmDialog
              open={confirmPost}
              onOpenChange={setConfirmPost}
              title={`Post ${count.count_number}?`}
              description={`${counted.length} counted line(s), ${variances.length} with a difference. Each difference is posted to the stock ledger as an adjustment. Uncounted lines are left unchanged.`}
              confirmLabel="Post count"
              onConfirm={() => void run('post', () => postCount(count.id, null), `${count.count_number} posted. ${variances.length} difference(s) applied to stock.`)}
            />
            {(open || count.status === 'SUBMITTED') && (count.created_by === user?.id || has('inventory_count.approve')) && (
              <Button variant="ghost" disabled={busy !== null} onClick={() => void run('cancel', () => cancelCount(count.id), 'Count cancelled.')}><X /> Cancel count</Button>
            )}
          </>
        }
      />
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <KpiCard label="Lines" value={String(lines.length)} icon={Check} />
        <KpiCard label="Counted" value={String(counted.length)} icon={Check} accent="available" />
        <KpiCard label="Uncounted" value={String(lines.length - counted.length)} hint="Ignored on approval (no adjustment)" icon={Check} accent="pending" />
        <KpiCard label="Lines with variance" value={String(variances.length)} icon={Check} accent="shortage" />
      </div>
      {count.review_note && <p className="mb-4 text-sm text-muted-foreground">Review note: {count.review_note}</p>}

      <Card className="overflow-hidden">
        <div className="border-b px-5 py-3">
          <FilterTabs<View> label="Lines" value={view} onChange={setView}
            options={[{ value: 'all', label: 'All lines', count: lines.length }, { value: 'uncounted', label: 'Uncounted', count: lines.length - counted.length }, { value: 'variance', label: 'Variances', count: variances.length }]} />
        </div>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>SKU</TableHead>
              <TableHead>Product</TableHead>
              <TableHead>Location</TableHead>
              <TableHead>Batch</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">System qty</TableHead>
              <TableHead className="text-right">Counted qty</TableHead>
              <TableHead className="text-right">Variance</TableHead>
              <TableHead>Counted by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow className="hover:bg-transparent"><TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">No lines in this view.</TableCell></TableRow>
            )}
            {shown.map((l) => {
              const v = valueOf(l.id, l.counted_quantity === null ? null : Number(l.counted_quantity))
              const variance = v.trim() === '' ? null : Number(v) - Number(l.system_quantity)
              return (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.sku}{l.is_added && <span className="ml-1 text-xs text-muted-foreground">(added)</span>}</TableCell>
                  <TableCell className="min-w-44 whitespace-normal">{l.product_name}</TableCell>
                  <TableCell>{l.warehouse_code} / {l.location_code}</TableCell>
                  <TableCell>{l.batch_number ?? '—'}</TableCell>
                  <TableCell><StockSourceBadge source={l.source_type} /></TableCell>
                  <TableCell className="text-right tabular-nums">{formatQty(l.system_quantity, l.base_unit)}</TableCell>
                  <TableCell className="text-right">
                    {open && has('inventory_count.create') ? (
                      <Input aria-label={`Counted quantity for ${l.sku} at ${l.location_code}`} inputMode="decimal" className="ml-auto h-8 w-28 text-right"
                        value={v} onChange={(e) => setEdits((s) => ({ ...s, [l.id]: e.target.value }))} />
                    ) : (
                      <span className="tabular-nums">{l.counted_quantity === null ? 'Not counted' : formatQty(l.counted_quantity)}</span>
                    )}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${variance === null || Number.isNaN(variance) ? '' : variance < 0 ? 'text-shortage' : variance > 0 ? 'text-green-700' : ''}`}>
                    {variance === null || Number.isNaN(variance) ? '—' : `${variance > 0 ? '+' : ''}${formatQty(variance)}`}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{l.counted_by ? `${names.data?.get(l.counted_by) ?? '…'} · ${l.counted_at ? formatDateTime(l.counted_at) : ''}` : '—'}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Card>

      {adding && (
        <AddLineDialog
          locations={storage.allLocations.filter((l) => l.warehouseId === count.warehouse_id && l.active)}
          onClose={() => setAdding(false)}
          onAdd={async (input) => {
            await addCountLine(count.id, input)
            setAdding(false)
            say('success', 'Item added to the count sheet.')
            setRefresh((n) => n + 1)
          }}
        />
      )}
      {importing && (
        <Dialog open onOpenChange={(o) => !o && setImporting(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Import count sheet</DialogTitle>
              <DialogDescription>Validated against this count. Saving records the counted quantities only; stock is not changed.</DialogDescription>
            </DialogHeader>
            <ul className="space-y-1 text-sm">
              <li>{importing.updates.length} line(s) will be updated</li>
              <li>{importing.unchanged} line(s) unchanged or left blank</li>
              <li className={importing.errors.length ? 'text-shortage' : ''}>{importing.errors.length} row(s) rejected</li>
            </ul>
            {importing.errors.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-lg border bg-red-50 p-2 text-xs text-red-800">
                {importing.errors.map((e) => <li key={`${e.row}-${e.message}`}>Row {e.row}: {e.message}</li>)}
              </ul>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setImporting(null)}>Cancel</Button>
              <Button disabled={importing.updates.length === 0 || busy !== null} onClick={() => {
                const updates = importing.updates
                setImporting(null)
                void run('import', () => recordCount(count.id, updates), `Imported ${updates.length} counted line(s). Stock is unchanged until approval.`)
              }}>Save {importing.updates.length} line(s)</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {reviewOpen && <ReviewCountDialog countId={count.id} countNumber={count.count_number} variances={variances.length} onClose={() => setReviewOpen(false)} onDone={(t) => { setReviewOpen(false); say('success', t); setRefresh((n) => n + 1) }} />}
    </>
  )
}

function AddLineDialog({ locations, onClose, onAdd }: {
  locations: ReturnType<typeof useStorage>['allLocations']
  onClose: () => void
  onAdd: (i: { productId: string; locationId: string; sourceType: string; batchNumber: string | null; expiryDate: string | null }) => Promise<void>
}) {
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [locationId, setLocationId] = useState('')
  const [source, setSource] = useState('')
  const [batch, setBatch] = useState('')
  const [expiry, setExpiry] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a found item</DialogTitle>
          <DialogDescription>For stock physically found that is not on the sheet. Its system quantity is taken from the current balance (zero if none).</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="al-product">Product</Label><ProductPicker id="al-product" value={product} onChange={setProduct} includeInactive autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="al-loc">Location</Label><LocationSelect id="al-loc" value={locationId} onChange={setLocationId} options={locations} /></div>
          <div className="space-y-1.5"><Label htmlFor="al-src">Actual source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger id="al-src"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent><SelectItem value="IN_HOUSE">In-House</SelectItem><SelectItem value="OUTSOURCED">Outsourced</SelectItem></SelectContent>
            </Select></div>
          {product?.track_batches && (
            <>
              <div className="space-y-1.5"><Label htmlFor="al-batch">Batch</Label><Input id="al-batch" value={batch} onChange={(e) => setBatch(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="al-exp">Expiry</Label><Input id="al-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button disabled={busy || !product || !locationId || !source} onClick={async () => {
            setBusy(true)
            setError(null)
            try { await onAdd({ productId: product!.product_id, locationId, sourceType: source, batchNumber: batch.trim() || null, expiryDate: expiry || null }) } catch (e) { setError(describeDataError(e)); setBusy(false) }
          }}>{busy && <Loader2 className="animate-spin" />} Add line</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReviewCountDialog({ countId, countNumber, variances, onClose, onDone }: { countId: string; countNumber: string; variances: number; onClose: () => void; onDone: (t: string) => void }) {
  const { key, renew } = useRequestKey()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'APPROVE' | 'REJECT'>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (d: 'APPROVE' | 'REJECT') => {
    if (d === 'REJECT' && !note.trim()) return setError('Enter the reason for rejecting.')
    setBusy(d)
    setError(null)
    try {
      const r = await reviewCount(countId, d, note.trim() || null, key)
      renew()
      onDone(d === 'APPROVE' ? `${countNumber} approved: ${r.adjustments_posted} adjustment(s) posted.` : `${countNumber} rejected.`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review {countNumber}</DialogTitle>
          <DialogDescription>Approving posts {variances} variance(s) as stock adjustments, dated at the count snapshot. Uncounted lines are ignored.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-1.5"><Label htmlFor="rc-note">Review note (required to reject)</Label><Textarea id="rc-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>Close</Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void decide('REJECT')}>{busy === 'REJECT' ? <Loader2 className="animate-spin" /> : <X />} Reject</Button>
          <Button disabled={busy !== null} onClick={() => void decide('APPROVE')}>{busy === 'APPROVE' ? <Loader2 className="animate-spin" /> : <Check />} Approve &amp; post</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
