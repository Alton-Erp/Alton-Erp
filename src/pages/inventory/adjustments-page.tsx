import { ArrowDownRight, ArrowUpRight, Check, CheckCircle2, Eye, Hourglass, Loader2, Plus, Send, SlidersHorizontal, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { KpiCard } from '@/components/common/kpi-card'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { RecordDocuments } from '@/features/admin/record-documents'
import {
  adjustmentDifference, adjustmentTotals, EMPTY_ADJUSTMENT_FILTERS, reasonCategory, type AdjustmentFilters, type ReasonCode,
} from '@/features/inventory/adjustments-model'
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
import { formatDateTime, formatNumber } from '@/lib/format'
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
import type { StockDetailRow } from '@/types/database-inventory'

type Row = Awaited<ReturnType<typeof fetchAdjustments>>[number]
const categoryLabel = (code: string) => ADJUSTMENT_REASONS.find((r) => r.code === code)?.label ?? code.replace(/_/g, ' ').toLowerCase()
const reasonText = (a: Pick<Row, 'reason_label' | 'reason_code'>) => a.reason_label ?? categoryLabel(a.reason_code)
const STATUS_OPTIONS: [NonNullable<AdjustmentFilters['status']>, string][] = [
  ['DRAFT', 'Draft'], ['PENDING_APPROVAL', 'Pending approval'], ['POSTED', 'Posted'], ['REJECTED', 'Rejected'], ['CANCELLED', 'Cancelled'],
]

/**
 * Stock Adjustments: physical stock reconciliation. Adjustment quantity = physical count − system stock.
 * Drafts and submitted requests never change stock; approval posts ADJUSTMENT_IN / ADJUSTMENT_OUT through the
 * existing ledger posting (inventory_review_adjustment). Segregation of duties follows the company switch.
 */
export default function AdjustmentsPage() {
  const { user } = useAuth()
  const { has } = usePermissions()
  const storage = useStorage()
  const policy = useAsync(fetchInventoryPolicy, [])
  const reasons = useErpPreferences().prefs?.['inventory.adjustment_reasons'] ?? []
  const [params, setParams] = useSearchParams()
  const [filters, setFilters] = useState<AdjustmentFilters>(EMPTY_ADJUSTMENT_FILTERS)
  const [productFilter, setProductFilter] = useState<ProductOption | null>(null)
  const [refresh, setRefresh] = useState(0)
  const list = useAsync(() => fetchAdjustments(filters), [JSON.stringify(filters), refresh])
  const names = useAsync(() => fetchDisplayNames((list.data ?? []).flatMap((a) => [a.requested_by, a.reviewed_by])), [list.data])
  const [creating, setCreating] = useState(() => params.get('new') === '1')
  const openId = params.get('adj')
  const opened = useMemo(() => (list.data ?? []).find((a) => a.id === openId) ?? null, [list.data, openId])
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const sod = policy.data?.segregation_of_duties ?? false
  // V2 single-operator: with segregation of duties off, a user who may approve can post in one step.
  const canPost = has('inventory.approve_adjustment') && !sod
  const rows = list.data ?? []
  const totals = adjustmentTotals(rows)
  const setFilter = <K extends keyof AdjustmentFilters>(k: K, v: AdjustmentFilters[K]) => setFilters((f) => ({ ...f, [k]: v }))
  const open = (id: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set('adj', id); else n.delete('adj'); n.delete('new'); return n }, { replace: true })
  const done = (text: string, id?: string) => {
    setNotice({ tone: 'success', text })
    setRefresh((n) => n + 1)
    if (id) open(id)
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
    { id: 'no', header: 'Adjustment', cell: (a) => <button type="button" className="font-medium text-primary hover:underline" onClick={() => open(a.id)}>{a.adjustment_number}</button>, searchValue: (a) => a.adjustment_number },
    { id: 'date', header: 'Requested', cell: (a) => <span className="text-xs">{names.data?.get(a.requested_by ?? '') ?? '…'}<span className="block text-muted-foreground">{formatDateTime(a.requested_at)}</span></span>, sortValue: (a) => a.requested_at },
    { id: 'product', header: 'Product', cell: (a) => <span><span className="font-medium">{a.sku}</span> {a.product_name}</span>, searchValue: (a) => `${a.sku} ${a.product_name}` },
    { id: 'loc', header: 'Warehouse / location', cell: (a) => <span>{a.warehouse_code} / {a.location_code}{a.batch_number ? ` · ${a.batch_number}` : ''}</span> },
    { id: 'sys', header: 'System stock', align: 'right', cell: (a) => formatQty(a.system_quantity, a.base_unit) },
    { id: 'new', header: 'Physical count', align: 'right', cell: (a) => (a.adjustment_type === 'QUANTITY' ? formatQty(a.counted_quantity) : formatQty(a.correction_quantity)) },
    {
      id: 'diff', header: 'Adjustment', align: 'right',
      cell: (a) => a.adjustment_type === 'QUANTITY'
        ? <span className={Number(a.difference) < 0 ? 'text-shortage' : 'text-green-700'} data-testid="adj-diff">{Number(a.difference) > 0 ? '+' : ''}{formatQty(a.difference)}</span>
        : <span className="flex items-center justify-end gap-1 text-muted-foreground"><StockSourceBadge source={a.source_type} />→{a.target_source_type && <StockSourceBadge source={a.target_source_type} />}</span>,
      sortValue: (a) => Number(a.difference ?? 0),
    },
    { id: 'reason', header: 'Reason', cell: (a) => <span title={a.notes ?? ''}>{reasonText(a)}</span>, searchValue: (a) => `${reasonText(a)} ${a.reason_code} ${a.notes ?? ''} ${a.reference ?? ''}` },
    { id: 'status', header: 'Status', cell: (a) => <DocumentStatusBadge status={a.status} /> },
    {
      id: 'actions', header: 'Actions', align: 'right',
      cell: (a) => {
        const own = a.requested_by === user?.id
        return (
          <span className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => open(a.id)} aria-label={`Open ${a.adjustment_number}`}><Eye /></Button>
            {a.status === 'PENDING_APPROVAL' && has('inventory.approve_adjustment') && (
              <span title={own && sod ? 'Segregation of duties: another user must approve your request' : undefined}>
                <Button size="sm" variant="outline" disabled={own && sod} onClick={() => open(a.id)}><Check /> Review</Button>
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
        Adjustment = physical count − system stock. {canPost
          ? 'Posted adjustments go to the stock ledger when you confirm them; drafts and submitted requests never change stock.'
          : sod
            ? 'Stock changes only after approval. Segregation of duties is on: another authorised user must approve each request.'
            : 'Stock changes only after approval by a user with the approve permission.'} Posted adjustments are never edited or deleted.
      </p>
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="adj-notice"
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Positive adjustments (posted)" value={formatNumber(totals.positive)} icon={ArrowUpRight} accent="available" testId="adj-kpi-positive" />
        <KpiCard label="Negative adjustments (posted)" value={formatNumber(totals.negative)} icon={ArrowDownRight} accent="shortage" testId="adj-kpi-negative" />
        <KpiCard label="Pending approvals" value={formatNumber(totals.pending)} icon={Hourglass} testId="adj-kpi-pending" />
        <KpiCard label="Completed adjustments" value={formatNumber(totals.completed)} icon={CheckCircle2} testId="adj-kpi-completed" />
      </div>
      <Card className="mb-4">
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" data-testid="adj-filters">
          <Field label="From" htmlFor="af-from"><Input id="af-from" type="date" value={filters.from ?? ''} onChange={(e) => setFilter('from', e.target.value || null)} /></Field>
          <Field label="To" htmlFor="af-to"><Input id="af-to" type="date" value={filters.to ?? ''} onChange={(e) => setFilter('to', e.target.value || null)} /></Field>
          <Field label="Product" htmlFor="af-product"><ProductPicker id="af-product" value={productFilter} includeInactive
            onChange={(p) => { setProductFilter(p); setFilter('productId', p?.product_id ?? null) }} /></Field>
          <Field label="Warehouse" htmlFor="af-wh">
            <Select value={filters.warehouseId ?? 'all'} onValueChange={(v) => setFilter('warehouseId', v === 'all' ? null : v)}>
              <SelectTrigger id="af-wh"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All warehouses</SelectItem>{storage.warehouses.map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Reason" htmlFor="af-reason">
            <Select value={filters.reason ?? 'all'} onValueChange={(v) => setFilter('reason', v === 'all' ? null : v)}>
              <SelectTrigger id="af-reason"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                {reasons.map((r) => <SelectItem key={`l:${r}`} value={r}>{r}</SelectItem>)}
                {ADJUSTMENT_REASONS.map((r) => <SelectItem key={`c:${r.code}`} value={r.code}>Category: {r.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Type" htmlFor="af-type">
            <Select value={filters.type ?? 'all'} onValueChange={(v) => setFilter('type', v === 'all' ? null : (v as AdjustmentFilters['type']))}>
              <SelectTrigger id="af-type"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All types</SelectItem><SelectItem value="QUANTITY">Quantity</SelectItem><SelectItem value="SOURCE_CORRECTION">Source correction</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Status" htmlFor="af-status">
            <Select value={filters.status ?? 'all'} onValueChange={(v) => setFilter('status', v === 'all' ? null : (v as AdjustmentFilters['status']))}>
              <SelectTrigger id="af-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All statuses</SelectItem>{STATUS_OPTIONS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>
      <DataTable
        title="Stock adjustments"
        columns={columns}
        data={rows}
        getRowId={(a) => a.id}
        loading={list.loading}
        error={list.error ? new Error(describeDataError(list.error)) : null}
        onRetry={list.reload}
        searchPlaceholder="Search number, product, reason…"
        pageSize={25}
        toolbar={JSON.stringify(filters) !== JSON.stringify(EMPTY_ADJUSTMENT_FILTERS)
          ? <Button size="sm" variant="ghost" onClick={() => { setFilters(EMPTY_ADJUSTMENT_FILTERS); setProductFilter(null) }}>Clear filters</Button> : undefined}
        emptyState={{ icon: SlidersHorizontal, title: 'No adjustments here', description: 'Record a physical count difference: damage, loss, found stock or a count variance.' }}
      />
      {creating && <CreateAdjustmentDialog storage={storage} reasons={reasons} today={policy.data?.today} canPost={canPost}
        onClose={() => { setCreating(false); open(null) }} onDone={done} />}
      {opened && <AdjustmentDetailDialog row={opened} names={names.data} sod={sod} onClose={() => open(null)} onDone={done} />}
    </>
  )
}

function CreateAdjustmentDialog({ storage, reasons, today, canPost, onClose, onDone }: {
  storage: ReturnType<typeof useStorage>
  reasons: string[]
  today?: string
  canPost: boolean
  onClose: () => void
  onDone: (t: string, id?: string) => void
}) {
  const [type, setType] = useState<'QUANTITY' | 'SOURCE_CORRECTION'>('QUANTITY')
  const [warehouseId, setWarehouseId] = useState('')
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
  const [category, setCategory] = useState<ReasonCode | ''>('')
  const [cost, setCost] = useState('')
  const [notes, setNotes] = useState('')
  const [reference, setReference] = useState('')
  const [effective, setEffective] = useState(today ?? '')
  const [submit, setSubmit] = useState(true)

  const locations = storage.activeLocations.filter((l) => !warehouseId || l.warehouseId === warehouseId)
  const system = newLot ? 0 : Number(lot?.on_hand ?? 0)
  const countedNum = counted.trim() === '' ? null : parseUnitQty(counted, product?.base_unit, { allowZero: true })
  const diff = adjustmentDifference(product && (lot || newLot) ? system : null, countedNum)
  const chooseReason = (r: string) => { setReason(r); setCategory(reasonCategory(r)) }

  return (
    <StockFormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={canPost ? 'Stock adjustment' : 'Request stock adjustment'}
      description={canPost
        ? 'Records the system stock now and the physical count, then posts the difference to the stock ledger. Check the summary before confirming.'
        : 'Records the system stock now and the physical count. Stock changes only when an authorised approver approves it.'}
      confirmLabel={!submit ? 'Save draft' : canPost ? 'Post adjustment' : 'Submit for approval'}
      validate={() => {
        if (!warehouseId) return 'Select the warehouse.'
        if (!product || !locationId) return 'Select the product and location.'
        if (!newLot && !lot) return 'Select the lot, or choose "stock not yet recorded at this location".'
        if (newLot && (!newSource || (product.track_batches && !batch.trim()))) return 'Select the source (and batch) of the found stock.'
        if (type === 'QUANTITY') {
          if (countedNum === null || Number.isNaN(countedNum) || countedNum < 0) return `Enter the physical count (zero or more, ${quantityRule(product.base_unit)}).`
          if (countedNum === system) return 'The physical count equals the system stock: nothing to adjust.'
          if (!reason) return reasons.length ? 'Select the adjustment reason.' : 'Add stock adjustment reasons in ERP Settings → Inventory first.'
          if (!category) return 'Select the reason category.'
        } else {
          if (!target || target === lot?.source_type) return 'Choose a different target source.'
          const m = parseUnitQty(moveQty, product.base_unit) ?? 0
          if (!m || m <= 0 || m > Number(lot?.available ?? 0)) return `Quantity must be between 0 and ${formatQty(lot?.available ?? 0)} (unreserved).`
        }
        if (!notes.trim() && !reference.trim()) return 'Add remarks or a reference.'
        if (category === 'OTHER' && !notes.trim()) return 'Explain the reason in the remarks.'
        return null
      }}
      review={() => [
        { label: 'Type', value: type === 'QUANTITY' ? 'Quantity (physical count)' : 'Source attribution correction' },
        { label: 'Product', value: product ? `${product.sku} — ${product.product_name}` : '' },
        { label: 'Warehouse / location', value: storage.locationLabel(locationId) },
        { label: 'Lot', value: newLot ? `New ${STOCK_SOURCE_LABELS[newSource as StockSourceCode] ?? ''} ${batch}` : `${lot?.batch_number ?? 'No batch'} · ${lot?.source_type}` },
        { label: 'System stock', value: formatQty(system, product?.base_unit) },
        ...(type === 'QUANTITY'
          ? [{ label: 'Physical count', value: formatQty(countedNum) }, { label: 'Adjustment', value: `${(diff ?? 0) > 0 ? '+' : ''}${formatQty(diff)}` },
            { label: 'Reason', value: `${reason} (${categoryLabel(category)})` }]
          : [{ label: 'Move to source', value: `${formatQty(Number(moveQty))} → ${target}` }]),
        { label: 'Effective date', value: effective },
        { label: 'Remarks / reference', value: [notes, reference].filter(Boolean).join(' · ') },
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
          reasonCode: type === 'SOURCE_CORRECTION' ? 'SOURCE_CORRECTION' : category,
          reasonLabel: type === 'QUANTITY' ? reason : (reason || null),
          notes: notes.trim() || null,
          reference: reference.trim() || null,
          effectiveDate: effective || null,
        }
        if (canPost && submit) {
          const r = await postAdjustment(input, key)
          onDone(`${r.adjustment_number} posted. Stock is updated. Attach supporting files below if needed.`, r.adjustment_id)
          return r.adjustment_number
        }
        const r = await createAdjustment({ ...input, submit }, key)
        onDone(`${r.adjustment_number} ${r.status === 'DRAFT' ? 'saved as draft' : 'submitted for approval'}. Stock has not changed yet. Attach supporting files below if needed.`, r.adjustment_id)
        return r.adjustment_number
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Adjustment type" htmlFor="ad-type" full>
          <Select value={type} onValueChange={(v) => { setType(v as typeof type); setNewLot(false) }}>
            <SelectTrigger id="ad-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="QUANTITY">Quantity (physical count: damage, loss, found, count difference…)</SelectItem>
              <SelectItem value="SOURCE_CORRECTION">Source attribution correction (e.g. unverified → in-house)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Warehouse" htmlFor="ad-wh">
          <Select value={warehouseId} onValueChange={(v) => { setWarehouseId(v); setLocationId(''); setLot(null) }}>
            <SelectTrigger id="ad-wh"><SelectValue placeholder="Select warehouse" /></SelectTrigger>
            <SelectContent>{storage.warehouses.filter((w) => w.status === 'ACTIVE').map((w) => <SelectItem key={w.id} value={w.id}>{w.warehouse_code} — {w.warehouse_name}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Location" htmlFor="ad-loc"><LocationSelect id="ad-loc" value={locationId} onChange={(v) => { setLocationId(v); setLot(null) }} options={locations} /></Field>
        <Field label="Product" htmlFor="ad-product" full><ProductPicker id="ad-product" value={product} onChange={(p) => { setProduct(p); setLot(null) }} includeInactive autoFocus /></Field>
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
          <Field label="Lot / source (system stock from the ledger)" htmlFor="ad-lot" full>
            <LotSelect id="ad-lot" productId={product?.product_id ?? null} locationId={locationId || null} value={lot} onChange={setLot} />
            {lot && <LotSummary lot={lot} />}
          </Field>
        )}
        {type === 'QUANTITY' ? (
          <>
            <Field label="System stock" htmlFor="ad-system"><Input id="ad-system" readOnly className="bg-surface-muted tabular-nums" value={product && (lot || newLot) ? formatQty(system, product.base_unit) : ''} /></Field>
            <Field label={`Physical count${product ? ` (${product.base_unit})` : ''}`} htmlFor="ad-counted">
              <Input id="ad-counted" inputMode={qtyInputMode(product?.base_unit)} value={counted} onChange={(e) => setCounted(e.target.value)} />
            </Field>
            <Field label="Adjustment (physical − system)" htmlFor="ad-diff">
              <Input id="ad-diff" readOnly className={`bg-surface-muted tabular-nums ${diff !== null && diff < 0 ? 'text-shortage' : diff ? 'text-green-700' : ''}`}
                value={diff === null ? '' : `${diff > 0 ? '+' : ''}${formatQty(diff, product?.base_unit)}`} />
            </Field>
            <Field label="Reason" htmlFor="ad-reason" hint={reasons.length ? 'Configured in ERP Settings → Inventory.' : 'No reasons configured: add them in ERP Settings → Inventory.'}>
              <Select value={reason} onValueChange={chooseReason}>
                <SelectTrigger id="ad-reason"><SelectValue placeholder="Select reason" /></SelectTrigger>
                <SelectContent>{reasons.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Category" htmlFor="ad-category" hint="Recorded on the stock ledger entry.">
              <Select value={category} onValueChange={(v) => setCategory(v as ReasonCode)}>
                <SelectTrigger id="ad-category"><SelectValue placeholder="Select category" /></SelectTrigger>
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
        <Field label="Effective date" htmlFor="ad-date" hint="Backdated adjustments are posted at the start of that day when approved."><Input id="ad-date" type="date" value={effective} max={today} onChange={(e) => setEffective(e.target.value)} /></Field>
        <Field label="Reference (optional)" htmlFor="ad-ref"><Input id="ad-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
        <Field label="Remarks" htmlFor="ad-notes" full hint="Attach photos or count sheets after saving."><Textarea id="ad-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Checkbox id="ad-submit" checked={submit} onCheckedChange={(v) => setSubmit(v === true)} />
          <Label htmlFor="ad-submit" className="font-normal">{canPost ? 'Post now (untick to save as a draft)' : 'Submit for approval now (untick to save as a draft)'}</Label>
        </div>
      </div>
    </StockFormDialog>
  )
}

/** One adjustment: before / after quantities, reason, people and times, attachments, and the review (approve / reject). */
function AdjustmentDetailDialog({ row, names, sod, onClose, onDone }: { row: Row; names?: Map<string, string>; sod: boolean; onClose: () => void; onDone: (t: string) => void }) {
  const { user } = useAuth()
  const { has } = usePermissions()
  const { key, renew } = useRequestKey()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'APPROVE' | 'REJECT'>(null)
  const [error, setError] = useState<string | null>(null)
  const own = row.requested_by === user?.id
  const canReview = row.status === 'PENDING_APPROVAL' && has('inventory.approve_adjustment') && !(own && sod)
  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    if (decision === 'REJECT' && !note.trim()) return setError('Enter the reason for rejecting.')
    setBusy(decision)
    setError(null)
    try {
      const r = await reviewAdjustment(row.id, decision, note.trim() || null, key)
      renew()
      onDone(decision === 'APPROVE' ? `${row.adjustment_number} approved and posted (${r.transactions.join(', ')}).` : `${row.adjustment_number} rejected.`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }
  const person = (id: string | null) => (id ? names?.get(id) ?? '…' : '—')
  const after = row.adjustment_type === 'QUANTITY' ? row.counted_quantity : null
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="adj-detail">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{row.adjustment_number} <DocumentStatusBadge status={row.status} /></DialogTitle>
          <DialogDescription>{row.status === 'PENDING_APPROVAL' ? 'Approving posts the adjustment to the stock ledger immediately; it can only be undone by a new adjustment.' : 'Stock adjustment details.'}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Product</dt><dd>{row.sku} — {row.product_name}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Warehouse / location</dt><dd>{row.warehouse_code} / {row.location_code}{row.batch_number ? ` · ${row.batch_number}` : ''}</dd></div>
          <div><dt className="text-xs text-muted-foreground">System stock (before)</dt><dd data-testid="adj-before">{formatQty(row.system_quantity, row.base_unit)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{row.adjustment_type === 'QUANTITY' ? 'Physical count (after)' : 'Re-attribute'}</dt>
            <dd data-testid="adj-after">{row.adjustment_type === 'QUANTITY' ? `${formatQty(after)} (adjustment ${Number(row.difference) > 0 ? '+' : ''}${formatQty(row.difference)})`
              : `${formatQty(row.correction_quantity)} ${row.source_type} → ${row.target_source_type}`}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Reason</dt><dd>{reasonText(row)}{row.reason_label ? <span className="block text-xs text-muted-foreground">Category: {categoryLabel(row.reason_code)}</span> : null}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Effective date</dt><dd>{row.effective_date}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Requested by</dt><dd>{person(row.requested_by)}<span className="block text-xs text-muted-foreground">{formatDateTime(row.requested_at)}</span></dd></div>
          <div><dt className="text-xs text-muted-foreground">{row.status === 'REJECTED' ? 'Rejected by' : 'Approved by'}</dt>
            <dd>{person(row.reviewed_by)}{row.reviewed_at && <span className="block text-xs text-muted-foreground">{formatDateTime(row.reviewed_at)}</span>}</dd></div>
          {row.review_note && <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">{row.status === 'REJECTED' ? 'Rejection reason' : 'Review note'}</dt><dd data-testid="adj-review-note">{row.review_note}</dd></div>}
          <div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">Remarks / reference</dt><dd>{[row.notes, row.reference].filter(Boolean).join(' · ') || '—'}</dd></div>
        </dl>
        <RecordDocuments entityType="STOCK_ADJUSTMENT" entityId={row.id} defaultType="PHOTO" title="Supporting attachments" />
        {canReview && (
          <div className="space-y-1.5"><Label htmlFor="rv-note">Review note (required to reject)</Label><Textarea id="rv-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
        )}
        {row.status === 'PENDING_APPROVAL' && own && sod && <p className="text-xs text-muted-foreground" data-testid="adj-sod">Segregation of duties: another authorised user must approve your request.</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>Close</Button>
          {canReview && <>
            <Button variant="outline" disabled={busy !== null} onClick={() => void decide('REJECT')}>{busy === 'REJECT' ? <Loader2 className="animate-spin" /> : <X />} Reject</Button>
            <Button disabled={busy !== null} onClick={() => void decide('APPROVE')} data-testid="adj-approve">{busy === 'APPROVE' ? <Loader2 className="animate-spin" /> : <Check />} Approve &amp; post</Button>
          </>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
