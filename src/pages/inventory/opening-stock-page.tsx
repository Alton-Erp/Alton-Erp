import { Check, ChevronDown, ChevronRight, FileSpreadsheet, Loader2, PackagePlus, Plus, Trash2, X } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
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
import { DocumentStatusBadge, StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty } from '@/features/inventory/inventory-model'
import { parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { LocationSelect, ProductPicker } from '@/features/inventory/pickers'
import { useStorage } from '@/features/inventory/use-storage'
import { useAsync } from '@/hooks/use-async'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { formatCurrency, formatDateTime } from '@/lib/format'
import {
  cancelOpeningStock,
  fetchInventoryPolicy,
  fetchOpeningBatches,
  fetchOpeningLines,
  reviewOpeningStock,
  postOpeningStock,
  submitOpeningStock,
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
                <TableHead>Source</TableHead>
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
        <thead><tr className="text-left text-muted-foreground"><th className="p-1.5">Row</th><th className="p-1.5">SKU</th><th className="p-1.5">Location</th><th className="p-1.5">Source</th><th className="p-1.5">Batch</th><th className="p-1.5 text-right">Quantity</th><th className="p-1.5 text-right">Unit cost</th><th className="p-1.5">Effective</th><th className="p-1.5">Status</th></tr></thead>
        <tbody>
          {(data ?? []).map((l) => (
            <tr key={l.id} className="border-t">
              <td className="p-1.5">{l.line_no}</td>
              <td className="p-1.5 font-medium">{l.sku} <span className="font-normal text-muted-foreground">{l.product_name}</span></td>
              <td className="p-1.5">{l.warehouse_code} / {l.location_code}</td>
              <td className="p-1.5"><StockSourceBadge source={l.source_type} /></td>
              <td className="p-1.5">{l.batch_number ?? '—'}{l.expiry_date && <span className="text-muted-foreground"> · exp {l.expiry_date}</span>}</td>
              <td className="p-1.5 text-right tabular-nums">{formatQty(l.quantity, l.base_unit)}</td>
              <td className="p-1.5 text-right">{l.unit_cost === null ? 'Unknown' : formatCurrency(Number(l.unit_cost))}</td>
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
  source: string
  quantity: number
  batch: string
  mfg: string
  expiry: string
  cost: string
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
  const [source, setSource] = useState('')
  const [qty, setQty] = useState('')
  const [batch, setBatch] = useState('')
  const [mfg, setMfg] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cost, setCost] = useState('')
  const [effective, setEffective] = useState(today ?? '')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverErrors, setServerErrors] = useState<{ line_no: number; message: string }[]>([])

  const addLine = () => {
    setError(null)
    const q = parseUnitQty(qty, product?.base_unit)
    if (!product) return setError('Select a product.')
    if (!locationId) return setError('Select a location.')
    if (!source) return setError('Select the actual source (or Unknown for unverified legacy stock).')
    if (!q) return setError(`Enter a quantity greater than zero (${quantityRule(product.base_unit)}).`)
    if (product.track_batches && !batch.trim()) return setError('This product is batch-tracked: enter the batch number.')
    if (product.track_expiry && !expiry) return setError('This product tracks expiry: enter the expiry date.')
    if (!effective) return setError('Enter the effective date.')
    if (today && effective > today) return setError('The effective date cannot be in the future.')
    if (lines.some((l) => l.product.product_id === product.product_id && l.locationId === locationId && l.source === source && l.batch.toLowerCase() === batch.trim().toLowerCase())) {
      return setError('That product, location, batch and source is already in the list.')
    }
    setLines([...lines, { product, locationId, source, quantity: q, batch: batch.trim(), mfg, expiry, cost, effective, reference: reference.trim() }])
    setProduct(null)
    setQty('')
    setBatch('')
    setMfg('')
    setExpiry('')
    setCost('')
  }

  const payload: OpeningLinePayload[] = lines.map((l, i) => ({
    line_no: i + 1,
    product_id: l.product.product_id,
    location_id: l.locationId,
    source_type: l.source,
    quantity: l.quantity,
    unit: l.product.base_unit,
    batch_number: l.batch || null,
    manufacturing_date: l.mfg || null,
    expiry_date: l.expiry || null,
    unit_cost: l.cost === '' ? null : Number(l.cost),
    effective_date: l.effective,
    reference: l.reference || null,
    notes: null,
  }))

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{step === 'review' ? 'Review opening stock' : 'Enter opening stock'}</DialogTitle>
          <DialogDescription>{step === 'review'
            ? (canPost ? 'Check the lines. Confirming posts them to stock in one transaction: if any line cannot be posted, nothing is posted.' : 'These lines will be submitted for approval. Stock changes only after approval.')
            : 'Add one line per product, location, batch and source as physically counted.'}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {serverErrors.length > 0 && (
          <ul role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {serverErrors.map((e) => <li key={`${e.line_no}-${e.message}`}>Line {e.line_no}: {e.message}</li>)}
          </ul>
        )}
        {step === 'edit' && (
          <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <div className="space-y-1 sm:col-span-3"><Label htmlFor="os-product">Product</Label><ProductPicker id="os-product" value={product} onChange={setProduct} autoFocus /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="os-loc">Warehouse / location</Label><LocationSelect id="os-loc" value={locationId} onChange={setLocationId} options={storage.activeLocations} /></div>
            <div className="space-y-1"><Label htmlFor="os-src">Actual source</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger id="os-src"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="IN_HOUSE">In-House</SelectItem>
                  <SelectItem value="OUTSOURCED">Outsourced</SelectItem>
                  <SelectItem value="UNKNOWN">Unknown (flag for review)</SelectItem>
                </SelectContent>
              </Select></div>
            <div className="space-y-1"><Label htmlFor="os-qty">Quantity{product ? ` (${product.base_unit})` : ''}</Label><Input id="os-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="os-cost">Unit cost (₹, optional)</Label><Input id="os-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="os-eff">Effective date</Label><Input id="os-eff" type="date" max={today} value={effective} onChange={(e) => setEffective(e.target.value)} /></div>
            {product?.track_batches && (
              <>
                <div className="space-y-1"><Label htmlFor="os-batch">Batch / lot</Label><Input id="os-batch" value={batch} onChange={(e) => setBatch(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="os-mfg">Mfg date</Label><Input id="os-mfg" type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} /></div>
                <div className="space-y-1"><Label htmlFor="os-exp">Expiry</Label><Input id="os-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></div>
              </>
            )}
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="os-ref">Reference (e.g. count sheet no.)</Label><Input id="os-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></div>
            <div className="flex items-end"><Button variant="outline" className="w-full" onClick={addLine}><Plus /> Add line</Button></div>
          </div>
        )}
        {lines.length > 0 && (
          <div className="max-h-64 overflow-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-xs text-muted-foreground"><tr><th className="p-2 text-left">#</th><th className="p-2 text-left">Product</th><th className="p-2 text-left">Location</th><th className="p-2 text-left">Source</th><th className="p-2 text-left">Batch</th><th className="p-2 text-right">Qty</th><th className="p-2 text-right">Cost</th><th className="p-2">Date</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-2">{i + 1}</td>
                    <td className="p-2">{l.product.sku}</td>
                    <td className="p-2">{storage.locationLabel(l.locationId)}</td>
                    <td className="p-2"><StockSourceBadge source={l.source} /></td>
                    <td className="p-2">{l.batch || '—'}</td>
                    <td className="p-2 text-right">{formatQty(l.quantity, l.product.base_unit)}</td>
                    <td className="p-2 text-right">{l.cost === '' ? 'Unknown' : formatCurrency(Number(l.cost))}</td>
                    <td className="p-2">{l.effective}</td>
                    <td className="p-2">{step === 'edit' && <Button variant="ghost" size="icon-sm" aria-label="Remove line" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 /></Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {step === 'review' && <div className="space-y-1.5"><Label htmlFor="os-notes">{canPost ? 'Notes (optional)' : 'Notes for the approver'}</Label><Textarea id="os-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></div>}
        <DialogFooter>
          {step === 'edit' ? (
            <>
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button disabled={lines.length === 0} onClick={() => { setError(null); setStep('review') }}>Review {lines.length} line(s)</Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setStep('edit')}>Back</Button>
              <Button disabled={busy} onClick={async () => {
                setBusy(true)
                setError(null)
                setServerErrors([])
                try {
                  const r = canPost
                    ? await postOpeningStock(payload, 'MANUAL', null, notes.trim() || null, key)
                    : await submitOpeningStock(payload, 'MANUAL', null, notes.trim() || null, key)
                  if (!r.ok) {
                    setServerErrors(r.errors)
                    renew()
                    setStep('edit')
                  } else if (canPost) {
                    onDone(`${r.document_number} posted with ${r.line_count} line(s). Stock is updated.`)
                  } else {
                    onDone(`${r.document_number} submitted with ${r.line_count} line(s). It now awaits approval; stock has not changed yet.`)
                  }
                } catch (e) {
                  setError(describeDataError(e))
                } finally {
                  setBusy(false)
                }
              }}>
                {busy && <Loader2 className="animate-spin" />} {canPost ? 'Post opening stock' : 'Submit for approval'}
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
