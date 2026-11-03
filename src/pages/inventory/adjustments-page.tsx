import { Check, Loader2, Plus, Send, SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { DocumentStatusBadge, StockSourceBadge } from '@/features/inventory/inventory-badges'
import { ADJUSTMENT_REASONS, STOCK_SOURCE_LABELS, formatQty, type StockSourceCode } from '@/features/inventory/inventory-model'
import { parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { LocationSelect, LotSelect, LotSummary, ProductPicker } from '@/features/inventory/pickers'
import { Field, StockFormDialog } from '@/features/inventory/stock-dialogs'
import { useStorage } from '@/features/inventory/use-storage'
import { useErpPreferences } from '@/features/management/erp-preferences'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import {
  createAdjustment,
  fetchAdjustments,
  fetchInventoryPolicy,
  postAdjustment,
  reviewAdjustment,
  updateAdjustmentStatus,
  type ProductOption,
} from '@/services/inventory'
import { fetchDisplayNames } from '@/services/products'
import type { AdjustmentRow, StockDetailRow } from '@/types/database-inventory'

type Tab = 'PENDING_APPROVAL' | 'MINE' | 'POSTED' | 'ALL'
type Row = Awaited<ReturnType<typeof fetchAdjustments>>[number]

export default function AdjustmentsPage() {
  const { user } = useAuth()
  const { has } = usePermissions()
  const storage = useStorage()
  const policy = useAsync(fetchInventoryPolicy, [])
  const [tab, setTab] = useState<Tab>('ALL')
  const [refresh, setRefresh] = useState(0)
  const list = useAsync(() => fetchAdjustments(tab === 'PENDING_APPROVAL' || tab === 'POSTED' ? tab : null), [tab, refresh])
  const names = useAsync(() => fetchDisplayNames((list.data ?? []).flatMap((a) => [a.requested_by, a.reviewed_by])), [list.data])
  // ?new=1 opens the adjustment form directly (quick actions).
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get('new') === '1')
  const [reviewing, setReviewing] = useState<Row | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const sod = policy.data?.segregation_of_duties ?? false
  // V2 single-operator: a user who may approve posts adjustments in one step.
  const canPost = has('inventory.approve_adjustment') && !sod
  const rows = (list.data ?? []).filter((a) => tab !== 'MINE' || a.requested_by === user?.id)
  const done = (text: string) => {
    setNotice({ tone: 'success', text })
    setRefresh((n) => n + 1)
  }
  const statusAction = async (a: Row, action: 'SUBMIT' | 'CANCEL') => {
    try {
      await updateAdjustmentStatus(a.id, action)
      done(`${a.adjustment_number} ${action === 'SUBMIT' ? 'submitted for approval' : 'cancelled'}.`)
    } catch (e) {
      setNotice({ tone: 'error', text: describeDataError(e) })
    }
  }

  const columns: DataTableColumn<Row>[] = [
    { id: 'no', header: 'Adjustment', cell: (a) => <span className="font-medium">{a.adjustment_number}</span>, searchValue: (a) => a.adjustment_number },
    { id: 'product', header: 'Product', cell: (a) => <span><span className="font-medium">{a.sku}</span> {a.product_name}</span>, searchValue: (a) => `${a.sku} ${a.product_name}` },
    { id: 'loc', header: 'Location / lot', cell: (a) => <span>{a.warehouse_code} / {a.location_code}{a.batch_number ? ` · ${a.batch_number}` : ''}</span> },
    { id: 'src', header: 'Source', cell: (a) => <span className="flex items-center gap-1"><StockSourceBadge source={a.source_type} />{a.target_source_type && <>→ <StockSourceBadge source={a.target_source_type} /></>}</span> },
    { id: 'sys', header: 'System qty', align: 'right', cell: (a) => formatQty(a.system_quantity, a.base_unit) },
    { id: 'new', header: 'Counted / moved', align: 'right', cell: (a) => (a.adjustment_type === 'QUANTITY' ? formatQty(a.counted_quantity) : formatQty(a.correction_quantity)) },
    {
      id: 'diff',
      header: 'Difference',
      align: 'right',
      cell: (a) => a.adjustment_type === 'QUANTITY'
        ? <span className={Number(a.difference) < 0 ? 'text-shortage' : 'text-green-700'}>{Number(a.difference) > 0 ? '+' : ''}{formatQty(a.difference)}</span>
        : <span className="text-muted-foreground">source change</span>,
    },
    { id: 'reason', header: 'Reason', cell: (a) => <span title={a.notes ?? ''}>{ADJUSTMENT_REASONS.find((r) => r.code === a.reason_code)?.label ?? a.reason_code.replace(/_/g, ' ').toLowerCase()}</span>, searchValue: (a) => `${a.reason_code} ${a.notes ?? ''} ${a.reference ?? ''}` },
    { id: 'by', header: 'Requested', cell: (a) => <span className="text-xs">{names.data?.get(a.requested_by ?? '') ?? '…'}<span className="block text-muted-foreground">{formatDateTime(a.requested_at)}</span></span> },
    { id: 'rev', header: 'Reviewed', cell: (a) => (a.reviewed_by ? <span className="text-xs">{names.data?.get(a.reviewed_by) ?? '…'}<span className="block text-muted-foreground">{a.reviewed_at ? formatDateTime(a.reviewed_at) : ''}</span></span> : '—') },
    { id: 'status', header: 'Status', cell: (a) => <DocumentStatusBadge status={a.status} /> },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      cell: (a) => {
        const own = a.requested_by === user?.id
        return (
          <span className="flex justify-end gap-1.5">
            {a.status === 'PENDING_APPROVAL' && has('inventory.approve_adjustment') && (
              <span title={own && sod ? 'Segregation of duties: another user must approve your request' : undefined}>
                <Button size="sm" variant="outline" disabled={own && sod} onClick={() => setReviewing(a)}><Check /> Review</Button>
              </span>
            )}
            {own && a.status === 'DRAFT' && <Button size="sm" variant="outline" onClick={() => void statusAction(a, 'SUBMIT')}><Send /> Submit</Button>}
            {own && (a.status === 'DRAFT' || a.status === 'PENDING_APPROVAL') && <Button size="sm" variant="ghost" onClick={() => void statusAction(a, 'CANCEL')}>Cancel</Button>}
          </span>
        )
      },
    },
  ]

  return (
    <>
      <PageHeader actions={has('inventory.adjust') ? <Button onClick={() => setCreating(true)}><Plus /> {canPost ? 'New adjustment' : 'Request adjustment'}</Button> : undefined} />
      <p className="mb-4 text-sm text-muted-foreground">
        {canPost
          ? 'Adjustments are posted to the stock ledger as soon as you confirm them. Posted adjustments are never edited or deleted; correct a mistake with a new adjustment.'
          : sod
            ? 'Adjustments change stock only after approval. Segregation of duties is on: requests must be approved by a different authorised user.'
            : 'Adjustments change stock only after approval by a user with the approve permission.'}
      </p>
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}
      <DataTable
        title="Adjustment requests"
        columns={columns}
        data={rows}
        getRowId={(a) => a.id}
        loading={list.loading}
        error={list.error ? new Error(describeDataError(list.error)) : null}
        onRetry={list.reload}
        searchPlaceholder="Search number, product, reason…"
        pageSize={25}
        toolbar={<FilterTabs<Tab> label="Adjustments" value={tab} onChange={setTab}
          options={[{ value: 'PENDING_APPROVAL', label: 'Pending approval' }, { value: 'MINE', label: 'My requests' }, { value: 'POSTED', label: 'Posted' }, { value: 'ALL', label: 'All' }]} />}
        emptyState={{ icon: SlidersHorizontal, title: 'No adjustments here', description: 'Request an adjustment for damage, loss, found stock, count differences or source corrections.' }}
      />
      {creating && <CreateAdjustmentDialog onClose={() => setCreating(false)} locations={storage.activeLocations} today={policy.data?.today} canPost={canPost} onDone={done} />}
      {reviewing && <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} onDone={done} />}
    </>
  )
}

function CreateAdjustmentDialog({ onClose, locations, today, canPost, onDone }: {
  onClose: () => void
  locations: ReturnType<typeof useStorage>['activeLocations']
  today?: string
  canPost: boolean
  onDone: (t: string) => void
}) {
  const [type, setType] = useState<'QUANTITY' | 'SOURCE_CORRECTION'>('QUANTITY')
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [locationId, setLocationId] = useState('')
  const [lot, setLot] = useState<StockDetailRow | null>(null)
  const [newLot, setNewLot] = useState(false)
  const [newSource, setNewSource] = useState<'IN_HOUSE' | 'OUTSOURCED' | ''>('')
  const [batch, setBatch] = useState('')
  const [counted, setCounted] = useState('')
  const [moveQty, setMoveQty] = useState('')
  const [target, setTarget] = useState<'IN_HOUSE' | 'OUTSOURCED' | ''>('')
  const [reason, setReason] = useState('')
  const [cost, setCost] = useState('')
  const [notes, setNotes] = useState('')
  const quickReasons = useErpPreferences().prefs?.['inventory.adjustment_reasons'] ?? []
  const [reference, setReference] = useState('')
  const [effective, setEffective] = useState(today ?? '')
  const [submit, setSubmit] = useState(true)

  const system = newLot ? 0 : Number(lot?.on_hand ?? 0)
  const countedNum = counted.trim() === '' ? null : parseUnitQty(counted, product?.base_unit, { allowZero: true })

  return (
    <StockFormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={canPost ? 'Stock adjustment' : 'Request stock adjustment'}
      description={canPost
        ? 'Records the system quantity now and the corrected quantity, then posts the difference to the stock ledger. Check the summary before confirming.'
        : 'Records the system quantity now and the corrected quantity. Stock changes only when an authorised approver approves it.'}
      confirmLabel={!submit ? 'Save draft' : canPost ? 'Post adjustment' : 'Submit for approval'}
      validate={() => {
        if (!product || !locationId) return 'Select product and location.'
        if (!newLot && !lot) return 'Select the lot, or choose "stock not yet recorded at this location".'
        if (newLot && (!newSource || (product.track_batches && !batch.trim()))) return 'Select the source (and batch) of the found stock.'
        if (type === 'QUANTITY') {
          if (countedNum === null || Number.isNaN(countedNum) || countedNum < 0) return `Enter the counted / corrected quantity (zero or more, ${quantityRule(product.base_unit)}).`
          if (countedNum === system) return 'The corrected quantity equals the system quantity.'
          if (!reason) return 'Select a reason.'
        } else {
          if (!target || target === lot?.source_type) return 'Choose a different target source.'
          const m = parseUnitQty(moveQty, product.base_unit) ?? 0
          if (!m || m <= 0 || m > Number(lot?.available ?? 0)) return `Quantity must be between 0 and ${formatQty(lot?.available ?? 0)} (unreserved).`
        }
        if (!notes.trim() && !reference.trim()) return 'Add supporting notes or a reference.'
        if (reason === 'OTHER' && !notes.trim()) return 'Explain the reason in the notes.'
        return null
      }}
      review={() => [
        { label: 'Type', value: type === 'QUANTITY' ? 'Quantity correction' : 'Source attribution correction' },
        { label: 'Product', value: product ? `${product.sku} — ${product.product_name}` : '' },
        { label: 'Lot', value: newLot ? `New ${STOCK_SOURCE_LABELS[newSource as StockSourceCode] ?? ''} ${batch}` : `${lot?.batch_number ?? 'No batch'} · ${lot?.source_type}` },
        { label: 'System quantity', value: formatQty(system, product?.base_unit) },
        ...(type === 'QUANTITY'
          ? [{ label: 'Corrected quantity', value: formatQty(countedNum) }, { label: 'Difference', value: formatQty((countedNum ?? 0) - system) }]
          : [{ label: 'Move to source', value: `${formatQty(Number(moveQty))} → ${target}` }]),
        { label: 'Effective date', value: effective },
        { label: 'Notes / reference', value: [notes, reference].filter(Boolean).join(' · ') },
      ]}
      submit={async (key) => {
        const input = {
          type,
          productId: product!.product_id,
          locationId,
          batchId: newLot ? null : (lot?.batch_id ?? null),
          batchNumber: newLot ? batch.trim() || null : null,
          sourceType: newLot ? newSource : (lot?.source_type ?? null),
          countedQuantity: type === 'QUANTITY' ? countedNum : null,
          correctionQuantity: type === 'SOURCE_CORRECTION' ? Number(moveQty) : null,
          targetSourceType: type === 'SOURCE_CORRECTION' ? target : null,
          unitCost: cost === '' ? null : Number(cost),
          reasonCode: type === 'SOURCE_CORRECTION' ? 'SOURCE_CORRECTION' : reason,
          notes: notes.trim() || null,
          reference: reference.trim() || null,
          effectiveDate: effective || null,
        }
        if (canPost && submit) {
          const r = await postAdjustment(input, key)
          onDone(`${r.adjustment_number} posted. Stock is updated.`)
          return r.adjustment_number
        }
        const r = await createAdjustment({ ...input, submit }, key)
        onDone(`${r.adjustment_number} ${r.status === 'DRAFT' ? 'saved as draft' : 'submitted for approval'}. Stock has not changed yet.`)
        return r.adjustment_number
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Adjustment type" htmlFor="ad-type" full>
          <Select value={type} onValueChange={(v) => { setType(v as typeof type); setNewLot(false) }}>
            <SelectTrigger id="ad-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="QUANTITY">Quantity correction (damage, loss, found, count…)</SelectItem>
              <SelectItem value="SOURCE_CORRECTION">Source attribution correction (e.g. unverified → in-house)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Product" htmlFor="ad-product" full><ProductPicker id="ad-product" value={product} onChange={(p) => { setProduct(p); setLot(null) }} includeInactive autoFocus /></Field>
        <Field label="Location" htmlFor="ad-loc"><LocationSelect id="ad-loc" value={locationId} onChange={(v) => { setLocationId(v); setLot(null) }} options={locations} /></Field>
        <Field label="Effective date" htmlFor="ad-date" hint="Backdated adjustments are posted at the start of that day when approved."><Input id="ad-date" type="date" value={effective} max={today} onChange={(e) => setEffective(e.target.value)} /></Field>
        {type === 'QUANTITY' && (
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id="ad-newlot" checked={newLot} onCheckedChange={(v) => { setNewLot(v === true); setLot(null) }} />
            <Label htmlFor="ad-newlot" className="font-normal">Found stock not yet recorded at this location</Label>
          </div>
        )}
        {newLot ? (
          <>
            <Field label="Actual source" htmlFor="ad-nsrc">
              <Select value={newSource} onValueChange={(v) => setNewSource(v as typeof newSource)}>
                <SelectTrigger id="ad-nsrc"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent><SelectItem value="IN_HOUSE">In-House</SelectItem><SelectItem value="OUTSOURCED">Outsourced</SelectItem></SelectContent>
              </Select>
            </Field>
            {product?.track_batches && <Field label="Batch number" htmlFor="ad-batch"><Input id="ad-batch" value={batch} onChange={(e) => setBatch(e.target.value)} /></Field>}
          </>
        ) : (
          <Field label="Lot / source" htmlFor="ad-lot" full>
            <LotSelect id="ad-lot" productId={product?.product_id ?? null} locationId={locationId || null} value={lot} onChange={setLot} />
            {lot && <LotSummary lot={lot} />}
          </Field>
        )}
        {type === 'QUANTITY' ? (
          <>
            <Field label={`Counted / corrected quantity${product ? ` (${product.base_unit})` : ''}`} htmlFor="ad-counted" hint={`System quantity now: ${formatQty(system)}`}>
              <Input id="ad-counted" inputMode={qtyInputMode(product?.base_unit)} value={counted} onChange={(e) => setCounted(e.target.value)} />
            </Field>
            <Field label="Reason" htmlFor="ad-reason">
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger id="ad-reason"><SelectValue placeholder="Select reason" /></SelectTrigger>
                <SelectContent>{ADJUSTMENT_REASONS.map((r) => <SelectItem key={r.code} value={r.code}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {countedNum !== null && countedNum > system && (
              <Field label="Unit cost of added stock (₹, optional)" htmlFor="ad-cost"><Input id="ad-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
            )}
          </>
        ) : (
          <>
            <Field label="Quantity to re-attribute" htmlFor="ad-move"><Input id="ad-move" inputMode="decimal" value={moveQty} onChange={(e) => setMoveQty(e.target.value)} /></Field>
            <Field label="Correct source" htmlFor="ad-target">
              <Select value={target} onValueChange={(v) => setTarget(v as typeof target)}>
                <SelectTrigger id="ad-target"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent><SelectItem value="IN_HOUSE">In-House</SelectItem><SelectItem value="OUTSOURCED">Outsourced</SelectItem></SelectContent>
              </Select>
            </Field>
          </>
        )}
        <Field label="Supporting notes" htmlFor="ad-notes" full><Textarea id="ad-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
              {/* Ready-made notes from ERP Settings → Inventory. */}
              {quickReasons.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{quickReasons.map((r) => (
                <button key={r} type="button" className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => setNotes((n) => (n.trim() ? `${n.trim()}; ${r}` : r))}>{r}</button>
              ))}</div>}</Field>
        <Field label="Reference (optional)" htmlFor="ad-ref"><Input id="ad-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
        <div className="flex items-center gap-2 self-end pb-2">
          <Checkbox id="ad-submit" checked={submit} onCheckedChange={(v) => setSubmit(v === true)} />
          <Label htmlFor="ad-submit" className="font-normal">{canPost ? 'Post now (untick to save as a draft)' : 'Submit for approval now'}</Label>
        </div>
      </div>
    </StockFormDialog>
  )
}

function ReviewDialog({ row, onClose, onDone }: { row: AdjustmentRow & { sku: string; product_name: string; base_unit: string; location_code: string; warehouse_code: string }; onClose: () => void; onDone: (t: string) => void }) {
  const { key, renew } = useRequestKey()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'APPROVE' | 'REJECT'>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    if (decision === 'REJECT' && !note.trim()) return setError('Enter the reason for rejecting.')
    setBusy(decision)
    setError(null)
    try {
      const r = await reviewAdjustment(row.id, decision, note.trim() || null, key)
      renew()
      onClose()
      onDone(decision === 'APPROVE' ? `${row.adjustment_number} approved and posted (${r.transactions.join(', ')}).` : `${row.adjustment_number} rejected.`)
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
          <DialogTitle>Review {row.adjustment_number}</DialogTitle>
          <DialogDescription>Approving posts the adjustment to the stock ledger immediately. It can only be undone by a reversal.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Product</dt><dd>{row.sku} — {row.product_name}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Location</dt><dd>{row.warehouse_code} / {row.location_code}</dd></div>
          <div><dt className="text-xs text-muted-foreground">System quantity at request</dt><dd>{formatQty(row.system_quantity, row.base_unit)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{row.adjustment_type === 'QUANTITY' ? 'Corrected quantity' : 'Re-attribute'}</dt>
            <dd>{row.adjustment_type === 'QUANTITY' ? `${formatQty(row.counted_quantity)} (difference ${formatQty(row.difference)})` : `${formatQty(row.correction_quantity)} ${row.source_type} → ${row.target_source_type}`}</dd></div>
          <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Notes / reference</dt><dd>{[row.notes, row.reference].filter(Boolean).join(' · ') || '—'}</dd></div>
        </dl>
        <div className="space-y-1.5"><Label htmlFor="rv-note">Review note (required to reject)</Label><Textarea id="rv-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>Close</Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void decide('REJECT')}>{busy === 'REJECT' ? <Loader2 className="animate-spin" /> : <X />} Reject</Button>
          <Button disabled={busy !== null} onClick={() => void decide('APPROVE')}>{busy === 'APPROVE' ? <Loader2 className="animate-spin" /> : <Check />} Approve &amp; post</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
