import { Check, ChevronDown, ChevronRight, FileSpreadsheet, Loader2, PackagePlus, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { FormDraftBar } from '@/components/common/form-draft-bar'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { DocumentStatusBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { existingOpeningIndex, openingBalanceKey, openingStockSource, openingValue } from '@/features/inventory/opening-import'
import { formatCost } from '@/features/products/product-list-format'
import { parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { LocationSelect, ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { usePersistentFormDraft } from '@/hooks/use-persistent-form-draft'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDateTime } from '@/lib/format'
import {
  cancelOpeningStock,
  fetchInventoryPolicy,
  fetchOpeningBatches,
  fetchOpeningContext,
  fetchOpeningCosts,
  fetchOpeningLines,
  reviewOpeningStock,
  postOpeningStockAtCost,
  submitOpeningStockAtCost,
  type OpeningLinePayload,
  type ProductOption,
} from '@/services/inventory'
import { fetchDisplayNames } from '@/services/products'
import type { OpeningBatchRow } from '@/types/database-inventory'

export default function OpeningStockPage() {
  const { user } = useAuth()
  const { has } = usePermissions()
  const storage = useStorage()
  const policy = useAsync(fetchInventoryPolicy, [])
  const [refresh, setRefresh] = useState(0)
  const list = useAsync(fetchOpeningBatches, [refresh])
  const names = useAsync(() => fetchDisplayNames((list.data ?? []).flatMap((b) => [b.requested_by, b.reviewed_by])), [list.data])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [entry, setEntry] = useState(false)
  const [review, setReview] = useState<OpeningBatchRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const sod = policy.data?.segregation_of_duties ?? false
  // V2 single-operator: a user who may approve posts opening stock in one step.
  const canPost = has('inventory_opening.approve') && !sod

  const done = (text: string, tone: 'success' | 'error' = 'success') => {
    setNotice({ tone, text })
    setRefresh((n) => n + 1)
  }

  return (
    <>
      <PageHeader
        title="Opening Stock"
        description={canPost
          ? 'Enter the physical inventory held when the system goes live. Opening stock is recorded separately from receipts and posted as soon as you confirm it.'
          : 'Enter the physical inventory held when the system goes live. Opening stock is recorded separately from receipts and posted only after approval.'}
        breadcrumbs={[{ label: 'Inventory' }, { label: 'Inventory Overview', to: '/inventory' }, { label: 'Opening Stock' }]}
        actions={
          has('inventory_opening.create') ? (
            <>
              <Button variant="outline" asChild><Link to="/inventory/opening-stock/import"><FileSpreadsheet /> Import from Excel / CSV</Link></Button>
              <Button onClick={() => setEntry(true)}><PackagePlus /> Enter opening stock</Button>
            </>
          ) : undefined
        }
      />
      <p className="mb-4 text-sm text-muted-foreground">
        {sod ? 'Segregation of duties is on: a different authorised user must approve each submission.' : canPost ? 'Lines you confirm are posted to stock straight away.' : 'A user with the approve permission must review each submission.'} Nothing is
        created automatically from the product master, and each product/location/batch can only have one opening balance.
      </p>
      {notice && (
        <div role={notice.tone === 'error' ? 'alert' : 'status'}
          className={notice.tone === 'error' ? 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800' : 'mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800'}>
          {notice.text}
        </div>
      )}

      <Card className="overflow-hidden">
        {list.loading && !list.data ? (
          <LoadingState variant="table" rows={4} />
        ) : list.error ? (
          <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState icon={PackagePlus} title="No opening stock submitted yet" description="Enter quantities manually or import a spreadsheet. Submissions wait for approval before they affect stock." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead>Document</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Reviewed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(list.data ?? []).map((b) => {
                const own = b.requested_by === user?.id
                return (
                  <Fragment key={b.id}>
                    <TableRow>
                      <TableCell>
                        <Button variant="ghost" size="icon-sm" aria-label={expanded === b.id ? 'Hide lines' : 'Show lines'} aria-expanded={expanded === b.id} onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                          {expanded === b.id ? <ChevronDown /> : <ChevronRight />}
                        </Button>
                      </TableCell>
                      <TableCell className="font-medium">{b.document_number}{b.notes && <span className="block text-xs font-normal text-muted-foreground">{b.notes}</span>}</TableCell>
                      <TableCell>{b.source === 'IMPORT' ? `Import${b.file_name ? ` · ${b.file_name}` : ''}` : 'Manual entry'}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.line_count}</TableCell>
                      <TableCell className="text-xs">{names.data?.get(b.requested_by ?? '') ?? '…'}<span className="block text-muted-foreground">{formatDateTime(b.requested_at)}</span></TableCell>
                      <TableCell className="text-xs">{b.reviewed_by ? <>{names.data?.get(b.reviewed_by) ?? '…'}<span className="block text-muted-foreground">{b.reviewed_at ? formatDateTime(b.reviewed_at) : ''}</span>{b.review_note && <span className="block text-muted-foreground">{b.review_note}</span>}</> : '—'}</TableCell>
                      <TableCell><DocumentStatusBadge status={b.status} /></TableCell>
                      <TableCell className="text-right">
                        {b.status === 'PENDING_APPROVAL' && (
                          <span className="flex justify-end gap-1.5">
                            {has('inventory_opening.approve') && (
                              <span title={own && sod ? 'Segregation of duties: another user must approve' : undefined}>
                                <Button size="sm" variant="outline" disabled={own && sod} onClick={() => setReview(b)}><Check /> Review</Button>
                              </span>
                            )}
                            {(own || has('inventory_opening.approve')) && (
                              <Button size="sm" variant="ghost" onClick={async () => {
                                try { await cancelOpeningStock(b.id); done(`${b.document_number} cancelled.`) } catch (e) { done(describeDataError(e), 'error') }
                              }}>Cancel</Button>
                            )}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                    {expanded === b.id && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={8} className="bg-surface-muted/40 p-0"><OpeningLines batchId={b.id} /></TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                )
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {entry && <ManualEntryDialog storage={storage} today={policy.data?.today} canPost={canPost} onClose={() => setEntry(false)} onDone={(t) => { setEntry(false); done(t) }} />}
      {review && <ReviewDialog batch={review} onClose={() => setReview(null)} onDone={(t) => { setReview(null); done(t) }} />}
    </>
  )
}

function OpeningLines({ batchId }: { batchId: string }) {
  const { data, loading, error } = useAsync(() => fetchOpeningLines(batchId), [batchId])
  if (loading) return <p className="px-5 py-3 text-sm text-muted-foreground">Loading lines…</p>
  if (error) return <p className="px-5 py-3 text-sm text-shortage">{describeDataError(error)}</p>
  return (
    <div className="max-h-96 overflow-auto px-3 py-2">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground"><th className="p-1.5">Row</th><th className="p-1.5">SKU</th><th className="p-1.5">Location</th><th className="p-1.5">Batch</th><th className="p-1.5 text-right">Quantity</th><th className="p-1.5 text-right">Unit cost</th><th className="p-1.5">Effective</th><th className="p-1.5">Status</th></tr></thead>
        <tbody>
          {(data ?? []).map((l) => (
            <tr key={l.id} className="border-t">
              <td className="p-1.5">{l.line_no}</td>
              <td className="p-1.5 font-medium">{l.sku} <span className="font-normal text-muted-foreground">{l.product_name}</span></td>
              <td className="p-1.5">{l.warehouse_code} / {l.location_code}</td>
              <td className="p-1.5">{l.batch_number ?? '—'}{l.expiry_date && <span className="text-muted-foreground"> · exp {l.expiry_date}</span>}</td>
              <td className="p-1.5 text-right tabular-nums">{formatQty(l.quantity, l.base_unit)}</td>
              <td className="p-1.5 text-right">{l.unit_cost === null ? 'Pending cost' : formatCurrency(Number(l.unit_cost))}</td>
              <td className="p-1.5">{l.effective_date}</td>
              <td className="p-1.5"><DocumentStatusBadge status={l.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface DraftLine {
  product: ProductOption
  locationId: string
  quantity: number
  batch: string
  mfg: string
  expiry: string
  /** Unit cost: the Product Master Cost (or an override, when allowed). */
  cost: string
  /** True when a permitted user entered a different cost. */
  override?: boolean
  effective: string
  reference: string
}

function ManualEntryDialog({ storage, today, canPost, onClose, onDone }: { storage: ReturnType<typeof useStorage>; today?: string; canPost: boolean; onClose: () => void; onDone: (t: string) => void }) {
  const { key, renew } = useRequestKey()
  const [lines, setLines] = useState<DraftLine[]>([])
  const [product, setProduct] = useState<ProductOption | null>(null)
  // storage loads asynchronously; use its default until a location is picked.
  const [chosenLocationId, setLocationId] = useState('')
  const locationId = chosenLocationId || storage.defaultLocationId || ''
  const [qty, setQty] = useState('')
  const [batch, setBatch] = useState('')
  const [mfg, setMfg] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cost, setCost] = useState('')
  // Product Master Cost of the selected product (fetched from the database) and the optional override.
  const [master, setMaster] = useState<{ productId: string; cost: number | null; valid: boolean } | null>(null)
  const [overrideAllowed, setOverrideAllowed] = useState(false)
  const [override, setOverride] = useState(false)
  const [costError, setCostError] = useState<string | null>(null)
  const [effective, setEffective] = useState(today ?? '')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState<null | 'checking' | 'posting'>(null)
  // Set synchronously, so a double click cannot start a second check or posting before the button disables.
  const working = useRef(false)
  const [error, setError] = useState<string | null>(null)
  // Problems found for lines already in the list, by line index.
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({})
  const [serverErrors, setServerErrors] = useState<{ line_no: number; message: string }[]>([])
  const { has } = usePermissions()
  // Auto-saved working copy, including the lines entered so far and the step (edit / review).
  const draft = usePersistentFormDraft({
    formKey: 'inventory.opening', scope: 'manual', enabled: has('inventory_opening.create'),
    value: { lines, product, chosenLocationId, qty, batch, mfg, expiry, cost, effective, reference, notes, step },
    onRestore: (d) => {
      // Drafts saved before the source field was removed carry an extra "source" key; it is ignored.
      const restored = Array.isArray(d.lines) ? d.lines.filter((l) => l?.product?.product_id) : []
      setLines(restored)
      setProduct(d.product ?? null)
      setLocationId(d.chosenLocationId ?? '')
      setQty(d.qty ?? '')
      setBatch(d.batch ?? '')
      setMfg(d.mfg ?? '')
      setExpiry(d.expiry ?? '')
      setCost(d.cost ?? '')
      setEffective(d.effective || today || '')
      setReference(d.reference ?? '')
      setNotes(d.notes ?? '')
      setStep(d.step === 'review' && restored.length ? 'review' : 'edit')
    },
  })

  // Fetch the Product Master Cost whenever the product changes; it fills the (read-only) cost field.
  const productId = product?.product_id ?? null
  useEffect(() => {
    if (!productId) return
    let cancelled = false
    setCostError(null)
    fetchOpeningCosts([productId]).then(({ overrideAllowed: allowed, costs }) => {
      if (cancelled) return
      const c = costs.get(productId)
      setOverrideAllowed(allowed)
      setMaster({ productId, cost: c?.cost ?? null, valid: Boolean(c?.valid) })
      setOverride((o) => o && allowed)
      setCost((current) => (override && allowed ? current : c?.valid && c.cost !== null ? String(c.cost) : ''))
    }, (e: unknown) => { if (!cancelled) setCostError(`The Product Master Cost could not be loaded: ${describeDataError(e)}`) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId])
  const masterReady = Boolean(product && master && master.productId === product.product_id)
  // Only a valid (above zero) Product Master Cost is used; otherwise the line has no cost (pending, not valued).
  const shownCost = override ? cost : masterReady && master!.valid && master!.cost !== null ? String(master!.cost) : ''
  const lineValue = openingValue(parseUnitQty(qty, product?.base_unit) || null, shownCost === '' ? null : Number(shownCost.replace(/,/g, '')))

  // The line being typed counts as started once a product, quantity, cost or batch is entered
  // (effective date and reference carry over between lines, so they do not count).
  const pendingStarted = Boolean(product || qty.trim() || cost.trim() || batch.trim())

  /** Checks the line being typed. Pure: returns the problem or the finished line. */
  const checkPending = (): { error: string } | { line: DraftLine } => {
    const q = parseUnitQty(qty, product?.base_unit)
    const cleanCost = cost.trim().replace(/,/g, '')
    if (!product) return { error: 'Select a product.' }
    // The cost is optional: wait for it to load, but a failed load does not block (the server sets the cost).
    if (!masterReady && !costError) return { error: 'Loading the Product Master Cost of this product. Try again in a moment.' }
    if (!locationId) return { error: 'Select a warehouse / location.' }
    if (!qty.trim()) return { error: 'Enter the quantity.' }
    if (!q) return { error: `Enter a quantity greater than zero (${quantityRule(product.base_unit)}).` }
    // An override needs a cost above zero; left blank, the Product Master Cost applies (or none).
    const overriding = override && cleanCost !== ''
    if (overriding && !(/^\d+(\.\d{1,4})?$/.test(cleanCost) && Number(cleanCost) > 0)) return { error: 'Enter an override cost greater than zero (up to 4 decimals), or leave it blank.' }
    if (product.track_batches && !batch.trim()) return { error: 'This product is batch-tracked: enter the batch number.' }
    if (product.track_expiry && !expiry) return { error: 'This product tracks expiry: enter the expiry date.' }
    if (!effective) return { error: 'Enter the effective date.' }
    if (today && effective > today) return { error: 'The effective date cannot be in the future.' }
    const k = openingBalanceKey(product.product_id, locationId, batch)
    if (lines.some((l) => openingBalanceKey(l.product.product_id, l.locationId, l.batch) === k)) {
      return { error: 'That product, location and batch is already in the list. Edit that line instead.' }
    }
    const masterCost = masterReady && master!.valid && master!.cost !== null ? String(master!.cost) : ''
    return { line: { product, locationId, quantity: q, batch: batch.trim(), mfg, expiry, cost: overriding ? cleanCost : masterCost, override: overriding, effective, reference: reference.trim() } }
  }
  const pending = pendingStarted ? checkPending() : null
  const reviewCount = lines.length + (pending && 'line' in pending ? 1 : 0)

  const clearPending = () => {
    setProduct(null)
    setQty('')
    setBatch('')
    setMfg('')
    setExpiry('')
    setCost('')
    setOverride(false)
    setMaster(null)
  }

  const addLine = () => {
    setError(null)
    const r = checkPending()
    if ('error' in r) return setError(r.error)
    setLines([...lines, r.line])
    clearPending()
  }

  const editLine = (i: number) => {
    if (pendingStarted) return setError('Add or clear the line you are entering before editing another one.')
    const l = lines[i]
    setProduct(l.product)
    setLocationId(l.locationId)
    setQty(String(l.quantity))
    setBatch(l.batch)
    setMfg(l.mfg)
    setExpiry(l.expiry)
    setCost(l.cost)
    setOverride(Boolean(l.override))
    setEffective(l.effective)
    setReference(l.reference)
    setLines(lines.filter((_, j) => j !== i))
    setLineErrors({})
    setServerErrors([])
    setError(null)
    setStep('edit')
  }

  const removeLine = (i: number) => {
    const rest = lines.filter((_, j) => j !== i)
    setLines(rest)
    setLineErrors({})
    setServerErrors([])
    setError(null)
    if (rest.length === 0) setStep('edit')
  }

  /** Lines whose product/location/batch already has an opening balance, and products that can no longer be used. */
  const findProblems = async (all: DraftLine[]) => {
    const ids = all.map((l) => l.product.product_id)
    const [ctx, priced] = await Promise.all([fetchOpeningContext(ids), fetchOpeningCosts(ids)])
    const existing = existingOpeningIndex(ctx.existing)
    const problems: Record<number, string> = {}
    // Costs are read again: the Product Master Cost may have changed since the line was added.
    const refreshed = all.map((l) => {
      if (l.override && priced.overrideAllowed) return l
      const c = priced.costs.get(l.product.product_id)
      return { ...l, override: false, cost: c?.valid && c.cost !== null ? String(c.cost) : '' }
    })
    refreshed.forEach((l, i) => {
      const meta = ctx.products.get(l.product.product_id)
      const recorded = existing.get(openingBalanceKey(l.product.product_id, l.locationId, l.batch))
      if (!meta) problems[i] = 'This product was not found.'
      else if (meta.status !== 'ACTIVE') problems[i] = `Product ${meta.sku} is inactive.`
      else if (recorded) problems[i] = `Opening stock for this product, location and batch already exists (${recorded}).`
    })
    return { problems, products: ctx.products, lines: refreshed }
  }

  // Review also takes the line still being typed, so nothing entered is lost or silently ignored.
  const goToReview = async () => {
    if (working.current) return
    setError(null)
    setServerErrors([])
    let all = lines
    if (pendingStarted) {
      const r = checkPending()
      if ('error' in r) return setError(`${r.error} Finish or clear the line you are entering, then review.`)
      all = [...lines, r.line]
      setLines(all)
      clearPending()
    }
    if (all.length === 0) return setError('Add at least one line before reviewing.')
    working.current = true
    setBusy('checking')
    try {
      const { problems, lines: refreshed } = await findProblems(all)
      setLines(refreshed)
      setLineErrors(problems)
      const count = Object.keys(problems).length
      if (count) setError(`${count} line(s) cannot be recorded. Edit or remove the marked line(s), then review again.`)
      else setStep('review')
    } catch (e) {
      setError(`The lines could not be checked: ${describeDataError(e)}`)
    } finally {
      working.current = false
      setBusy(null)
    }
  }

  const confirm = async () => {
    if (working.current) return
    working.current = true
    setBusy('posting')
    setError(null)
    setServerErrors([])
    try {
      // Checked again here: a restored draft can open straight on the review step.
      const { problems, products, lines: refreshed } = await findProblems(lines)
      setLines(refreshed)
      const count = Object.keys(problems).length
      if (count) {
        setLineErrors(problems)
        setError(`${count} line(s) cannot be recorded. Edit or remove the marked line(s).`)
        setStep('edit')
        return
      }
      const payload: OpeningLinePayload[] = refreshed.map((l, i) => ({
        line_no: i + 1,
        product_id: l.product.product_id,
        location_id: l.locationId,
        // Not chosen by the user: derived from the product master (see openingStockSource).
        source_type: openingStockSource(products.get(l.product.product_id)!),
        quantity: l.quantity,
        unit: l.product.base_unit,
        batch_number: l.batch || null,
        manufacturing_date: l.mfg || null,
        expiry_date: l.expiry || null,
        // The server sets the Product Master Cost; only a permitted override sends its own cost.
        unit_cost: l.override ? Number(l.cost) : null,
        ...(l.override ? { cost_override: true } : {}),
        effective_date: l.effective,
        reference: l.reference || null,
        notes: null,
      }))
      const r = canPost
        ? await postOpeningStockAtCost(payload, 'MANUAL', null, notes.trim() || null, key)
        : await submitOpeningStockAtCost(payload, 'MANUAL', null, notes.trim() || null, key)
      if (!r.ok) {
        setServerErrors(r.errors)
        setLineErrors(Object.fromEntries(r.errors.map((e) => [e.line_no - 1, e.message])))
        renew()
        setStep('edit')
      } else {
        void draft.markSubmitted()
        onDone(canPost
          ? `${r.document_number} posted with ${r.line_count} line(s). Stock is updated.`
          : `${r.document_number} submitted with ${r.line_count} line(s). It now awaits approval; stock has not changed yet.`)
      }
    } catch (e) {
      // The request key is kept, so trying again cannot record the lines twice.
      setError(describeDataError(e))
    } finally {
      working.current = false
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="opening-entry">
        <DialogHeader>
          <DialogTitle>{step === 'review' ? 'Review opening stock' : 'Enter opening stock'}</DialogTitle>
          <DialogDescription>{step === 'review'
            ? (canPost ? 'Check the lines. Confirming posts them to stock in one transaction: if any line cannot be posted, nothing is posted. Use Edit or Remove to change a line.' : 'These lines will be submitted for approval. Stock changes only after approval.')
            : 'Add one line per product, location and batch as physically counted.'}</DialogDescription>
        </DialogHeader>
        <FormDraftBar draft={draft} className="mb-0" />
        {serverErrors.length > 0 && (
          <ul role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {serverErrors.map((e) => <li key={`${e.line_no}-${e.message}`}>Line {e.line_no}: {e.message}</li>)}
          </ul>
        )}
        {step === 'edit' && (
          <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-3"><Label htmlFor="os-product">Product</Label><ProductPicker id="os-product" value={product} onChange={setProduct} autoFocus /></div>
            <div className="space-y-1 sm:col-span-3"><Label htmlFor="os-loc">Warehouse / location</Label><LocationSelect id="os-loc" value={locationId} onChange={setLocationId} options={storage.activeLocations} /></div>
            <div className="space-y-1"><Label htmlFor="os-qty">Quantity{product ? ` (${product.base_unit})` : ''}</Label><Input id="os-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <div className="space-y-1">
              <Label htmlFor="os-cost">Unit cost (₹, Product Master Cost, optional)</Label>
              <Input id="os-cost" inputMode="decimal" readOnly={!override} aria-readonly={!override} className={override ? undefined : 'bg-surface-muted'}
                placeholder={product && !masterReady && !costError ? 'Loading…' : product && masterReady && !master!.valid ? 'Pending cost' : ''}
                value={shownCost} onChange={(e) => setCost(e.target.value)} />
              {product && masterReady && !master!.valid && !override && (
                <p className="text-xs text-amber-800" data-testid="os-cost-missing">No Product Master Cost: the quantity is recorded with a pending cost and is not valued until a cost is set. No cost is assumed.</p>
              )}
              {costError && <p className="text-xs text-red-700">{costError}</p>}
              {overrideAllowed && product && (
                <label className="flex items-center gap-1.5 text-xs" data-testid="os-cost-override">
                  <input type="checkbox" checked={override} onChange={(e) => { setOverride(e.target.checked); if (!e.target.checked) setCost('') }} /> Override cost (audited)
                </label>
              )}
            </div>
            <div className="space-y-1"><Label htmlFor="os-value">Opening stock value</Label>
              <Input id="os-value" readOnly aria-readonly className="bg-surface-muted tabular-nums" value={lineValue === null ? '' : formatCost(lineValue)} /></div>
            <div className="space-y-1"><Label htmlFor="os-eff">Effective date</Label><Input id="os-eff" type="date" max={today} value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
            {product?.track_batches && (
              <>
                <div className="space-y-1"><Label htmlFor="os-batch">Batch / lot</Label><Input id="os-batch" value={batch} onChange={(e) => setBatch(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="os-mfg">Mfg date</Label><Input id="os-mfg" type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="os-exp">Expiry</Label><Input id="os-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
              </>
            )}
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="os-ref">Reference (optional, e.g. count sheet no.)</Label><Input id="os-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></div>
            <div className="flex items-end"><Button variant="outline" className="w-full" disabled={busy !== null} onClick={addLine}><Plus /> Add line</Button></div>
          </div>
        )}
        {lines.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-lg border">
            <table className="w-full text-sm" data-testid="opening-lines">
              <thead className="bg-surface-muted text-xs text-muted-foreground"><tr><th className="p-2 text-left">#</th><th className="p-2 text-left">Product</th><th className="p-2 text-left">Location</th><th className="p-2 text-left">Batch</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">Cost</th><th className="p-2 text-right">Value</th><th className="p-2">Date</th><th className="p-2 text-left">Reference</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <Fragment key={`${l.product.product_id}|${l.locationId}|${l.batch}`}>
                    <tr className={lineErrors[i] ? 'border-t bg-red-50/60' : 'border-t'} data-testid="opening-line">
                      <td className="p-2">{i + 1}</td>
                      <td className="p-2"><span className="font-medium">{l.product.sku}</span><span className="block text-xs text-muted-foreground">{l.product.product_name}</span></td>
                      <td className="p-2">{storage.locationLabel(l.locationId)}</td>
                      <td className="p-2">{l.batch || '—'}</td>
                      <td className="p-2 text-right tabular-nums whitespace-nowrap">{formatQty(l.quantity, l.product.base_unit)}</td>
                      <td className="p-2 text-right" data-testid="opening-line-cost">{l.cost === '' ? <span className="text-amber-800">Pending cost</span> : formatCost(Number(l.cost))}{l.override && <span className="block text-[11px] text-amber-800">override</span>}</td>
                      <td className="p-2 text-right tabular-nums" data-testid="opening-line-value">{l.cost === '' ? 'Not valued' : formatCost(openingValue(l.quantity, Number(l.cost)))}</td>
                      <td className="p-2 whitespace-nowrap">{l.effective}</td>
                      <td className="p-2">{l.reference || '—'}</td>
                      <td className="p-2">
                        <span className="flex justify-end gap-0.5">
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit line ${i + 1}`} disabled={busy !== null} onClick={() => editLine(i)}><Pencil /></Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={busy !== null} onClick={() => removeLine(i)}><Trash2 /></Button>
                        </span>
                      </td>
                    </tr>
                    {lineErrors[i] && <tr><td colSpan={10} className="px-2 pb-2 text-xs text-red-700" data-testid="opening-line-error">Line {i + 1}: {lineErrors[i]}</td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {step === 'review' && <div className="space-y-1.5"><Label htmlFor="os-notes">{canPost ? 'Notes (optional)' : 'Notes for the approver'}</Label><Textarea id="os-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></div>}
        {/* Next to the buttons, so a problem is never scrolled out of sight in a long dialog. */}
        {error && <p role="alert" ref={(el) => el?.scrollIntoView({ block: 'nearest' })} data-testid="opening-entry-error" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <DialogFooter>
          {step === 'edit' ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy !== null}>Cancel</Button>
              <Button data-testid="opening-review" disabled={busy !== null || (lines.length === 0 && !pendingStarted)} onClick={() => void goToReview()}>
                {busy === 'checking' && <Loader2 className="animate-spin" />} Review {reviewCount} line(s)
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy !== null} onClick={() => { setError(null); setStep('edit') }}>Back</Button>
              <Button data-testid="opening-confirm" disabled={busy !== null || lines.length === 0} onClick={() => void confirm()}>
                {busy === 'posting' && <Loader2 className="animate-spin" />} {canPost ? 'Post opening stock' : 'Submit for approval'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReviewDialog({ batch, onClose, onDone }: { batch: OpeningBatchRow; onClose: () => void; onDone: (t: string) => void }) {
  const { key, renew } = useRequestKey()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<null | 'APPROVE' | 'REJECT'>(null)
  const [error, setError] = useState<string | null>(null)
  const decide = async (d: 'APPROVE' | 'REJECT') => {
    if (d === 'REJECT' && !note.trim()) return setError('Enter the reason for rejecting.')
    setBusy(d)
    setError(null)
    try {
      const r = await reviewOpeningStock(batch.id, d, note.trim() || null, key)
      renew()
      onDone(d === 'APPROVE' ? `${batch.document_number} approved: ${r.lines_posted} opening stock line(s) posted.` : `${batch.document_number} rejected.`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Review {batch.document_number}</DialogTitle>
          <DialogDescription>Approval posts all {batch.line_count} lines as OPENING_STOCK in one transaction. If any line cannot be posted, nothing is posted.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="rounded-lg border"><OpeningLines batchId={batch.id} /></div>
        <div className="space-y-1.5"><Label htmlFor="ro-note">Review note (required to reject)</Label><Textarea id="ro-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy !== null}>Close</Button>
          <Button variant="outline" disabled={busy !== null} onClick={() => void decide('REJECT')}>{busy === 'REJECT' ? <Loader2 className="animate-spin" /> : <X />} Reject</Button>
          <Button disabled={busy !== null} onClick={() => void decide('APPROVE')}>{busy === 'APPROVE' ? <Loader2 className="animate-spin" /> : <Check />} Approve &amp; post</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
