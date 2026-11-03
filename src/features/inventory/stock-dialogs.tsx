import { Loader2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { LocationSelect, LotSelect, LotSummary, ProductPicker } from '@/features/inventory/pickers'
import type { LocationOption } from '@/features/inventory/use-storage'
import { formatQty } from '@/features/inventory/inventory-model'
import { parseUnitQty, qtyInputMode, quantityRule } from '@/features/inventory/whole-units'
import { useRequestKey } from '@/hooks/use-request-key'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { postIssue, postReceipt, postTransfer, type ProductOption } from '@/services/inventory'
import type { StockDetailRow } from '@/types/database-inventory'

/** Two-step dialog: edit -> review -> confirm. Never reports success unless the RPC returned. */
export function StockFormDialog({
  open,
  onOpenChange,
  title,
  description,
  validate,
  review,
  submit,
  children,
  confirmLabel = 'Post',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  validate: () => string | null
  review: () => { label: string; value: ReactNode }[]
  submit: (key: string) => Promise<string>
  children: ReactNode
  confirmLabel?: string
}) {
  const { key, renew } = useRequestKey()
  const [step, setStep] = useState<'edit' | 'review'>('edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    if (busy) return
    setStep('edit')
    setError(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{step === 'review' ? `Review: ${title}` : title}</DialogTitle>
          <DialogDescription>{step === 'review' ? 'Check the details. Posting changes stock immediately and cannot be edited afterwards (only reversed).' : description}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className={cn(step === 'review' && 'hidden')}>{children}</div>
        {step === 'review' && (
          <dl className="grid gap-x-6 gap-y-3 rounded-lg border bg-surface-muted/40 p-4 sm:grid-cols-2">
            {review().map((r) => (
              <div key={r.label}>
                <dt className="text-xs text-muted-foreground">{r.label}</dt>
                <dd className="text-sm font-medium">{r.value || '—'}</dd>
              </div>
            ))}
          </dl>
        )}
        <DialogFooter>
          {step === 'edit' ? (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const problem = validate()
                  setError(problem)
                  if (!problem) setStep('review')
                }}
              >
                Review
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => setStep('edit')}>
                Back
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  setError(null)
                  try {
                    await submit(key)
                    renew()
                    setStep('edit')
                    onOpenChange(false)
                  } catch (err) {
                    setError(describeDataError(err))
                    setStep('edit')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy && <Loader2 className="animate-spin" />}
                {confirmLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Field({ label, htmlFor, children, hint, full }: { label: string; htmlFor: string; children: ReactNode; hint?: string; full?: boolean }) {
  return (
    <div className={cn('space-y-1.5', full && 'sm:col-span-2')}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Receipt / customer return
// ---------------------------------------------------------------------------
export function ReceiptDialog({
  open,
  onOpenChange,
  locations,
  defaultLocationId,
  onPosted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: LocationOption[]
  defaultLocationId: string | null
  onPosted: (message: string) => void
}) {
  const [type, setType] = useState<'RECEIPT' | 'CUSTOMER_RETURN'>('RECEIPT')
  const [product, setProduct] = useState<ProductOption | null>(null)
  // The default location may load after the dialog mounts, so fall back to it
  // until the user picks a location explicitly.
  const [chosenLocationId, setLocationId] = useState('')
  const locationId = chosenLocationId || defaultLocationId || ''
  const [source, setSource] = useState<'IN_HOUSE' | 'OUTSOURCED' | ''>('')
  const [qty, setQty] = useState('')
  const [batch, setBatch] = useState('')
  const [mfg, setMfg] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cost, setCost] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')

  const location = locations.find((l) => l.id === locationId)

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Receive stock"
      description="Record stock received into a location. The actual source of this stock (in-house or outsourced) is recorded on the receipt."
      validate={() => {
        if (!product) return 'Select a product.'
        if (!locationId) return 'Select the receiving location.'
        if (!source) return 'Select the actual source of this stock.'
        if (!parseUnitQty(qty, product?.base_unit)) return `Enter a quantity greater than zero (${quantityRule(product?.base_unit)}).`
        if (product.track_batches && !batch.trim()) return 'This product is batch-tracked: enter the batch number.'
        if (product.track_expiry && !expiry) return 'This product tracks expiry: enter the expiry date.'
        if (cost && (Number.isNaN(Number(cost)) || Number(cost) < 0)) return 'Unit cost must be zero or more.'
        return null
      }}
      review={() => [
        { label: 'Type', value: type === 'RECEIPT' ? 'Receipt' : 'Customer return' },
        { label: 'Product', value: product ? `${product.sku} — ${product.product_name}` : '' },
        { label: 'Location', value: location?.label },
        { label: 'Quantity', value: formatQty(parseUnitQty(qty, product?.base_unit), product?.base_unit) },
        { label: 'Source', value: source === 'IN_HOUSE' ? 'In-House' : 'Outsourced' },
        { label: 'Batch', value: batch || (product?.track_batches ? '' : 'Not batch-tracked') },
        { label: 'Unit cost', value: cost ? `₹${cost}` : 'Unknown (not recorded)' },
        { label: 'Reference', value: reference },
      ]}
      submit={async (key) => {
        const result = await postReceipt(
          {
            productId: product!.product_id,
            locationId,
            quantity: parseUnitQty(qty, product?.base_unit)!,
            sourceType: source as 'IN_HOUSE' | 'OUTSOURCED',
            batchNumber: batch.trim() || null,
            manufacturingDate: mfg || null,
            expiryDate: expiry || null,
            unitCost: cost === '' ? null : Number(cost),
            transactionType: type,
            referenceType: type === 'RECEIPT' ? 'GRN' : 'CUSTOMER_RETURN',
            referenceNumber: reference.trim() || null,
            reason: null,
            notes: notes.trim() || null,
          },
          key,
        )
        onPosted(`Posted ${result.transaction_number}.`)
        setProduct(null)
        setQty('')
        setBatch('')
        setMfg('')
        setExpiry('')
        setCost('')
        setReference('')
        setNotes('')
        return result.transaction_number
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="rc-type">
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger id="rc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="RECEIPT">Receipt</SelectItem>
              <SelectItem value="CUSTOMER_RETURN">Customer return</SelectItem>
            </SelectContent>
          </Select>
          {type === 'CUSTOMER_RETURN' && <p className="text-xs text-muted-foreground">Returns go to a quarantine (or rejected) location, never straight into storage. For returns of sales orders use Sales &amp; Fulfilment → Customer Returns.</p>}
        </Field>
        <Field label="Actual source of this stock" htmlFor="rc-source">
          <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
            <SelectTrigger id="rc-source">
              <SelectValue placeholder="Select source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="IN_HOUSE">In-House (manufactured)</SelectItem>
              <SelectItem value="OUTSOURCED">Outsourced (purchased)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Product" htmlFor="rc-product" full>
          <ProductPicker id="rc-product" value={product} onChange={setProduct} autoFocus />
        </Field>
        <Field label="Location" htmlFor="rc-location">
          <LocationSelect id="rc-location" value={locationId} onChange={setLocationId} options={locations} />
        </Field>
        <Field label={`Quantity${product ? ` (${product.base_unit})` : ''}`} htmlFor="rc-qty">
          <Input id="rc-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        {product?.track_batches && (
          <>
            <Field label="Batch / lot number" htmlFor="rc-batch">
              <Input id="rc-batch" value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={50} />
            </Field>
            <Field label="Manufacturing date" htmlFor="rc-mfg">
              <Input id="rc-mfg" type="date" value={mfg} onChange={(e) => setMfg(e.target.value)} />
            </Field>
            <Field label={`Expiry date${product.track_expiry ? '' : ' (optional)'}`} htmlFor="rc-exp">
              <Input id="rc-exp" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Unit cost (₹, optional)" htmlFor="rc-cost" hint="Leave blank if not known. Unknown cost is never treated as zero.">
          <Input id="rc-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Field>
        <Field label="Reference (GRN / document no.)" htmlFor="rc-ref">
          <Input id="rc-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Notes" htmlFor="rc-notes" full>
          <Textarea id="rc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </StockFormDialog>
  )
}

// ---------------------------------------------------------------------------
// Issue / supplier return
// ---------------------------------------------------------------------------
export function IssueDialog({
  open,
  onOpenChange,
  locations,
  onPosted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: LocationOption[]
  onPosted: (message: string) => void
}) {
  const [type, setType] = useState<'ISSUE' | 'SUPPLIER_RETURN'>('ISSUE')
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [locationId, setLocationId] = useState('')
  const [lot, setLot] = useState<StockDetailRow | null>(null)
  const [qty, setQty] = useState('')
  const [reason, setReason] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Issue stock"
      description="Record stock leaving a location. Only available (unreserved) stock can be issued; fulfil reservations from the Reservations page."
      validate={() => {
        if (!product) return 'Select a product.'
        if (!locationId) return 'Select the location.'
        if (!lot) return 'Select the lot / source to issue from.'
        const q = parseUnitQty(qty, product?.base_unit)
        if (!q) return `Enter a quantity greater than zero (${quantityRule(product?.base_unit)}).`
        if (q > Number(lot.available)) return `Only ${formatQty(lot.available, lot.base_unit)} is available.`
        if (!reason.trim()) return 'Enter the reason for the issue.'
        return null
      }}
      review={() => [
        { label: 'Type', value: type === 'ISSUE' ? 'Issue' : 'Supplier return' },
        { label: 'Product', value: product ? `${product.sku} — ${product.product_name}` : '' },
        { label: 'From', value: locations.find((l) => l.id === locationId)?.label },
        { label: 'Lot', value: lot ? `${lot.batch_number ?? 'No batch'} · ${lot.source_type}` : '' },
        { label: 'Quantity', value: formatQty(parseUnitQty(qty, product?.base_unit), product?.base_unit) },
        { label: 'Reason', value: reason },
      ]}
      submit={async (key) => {
        const result = await postIssue(
          {
            productId: product!.product_id,
            locationId,
            quantity: parseUnitQty(qty, product?.base_unit)!,
            batchId: lot!.batch_id,
            sourceType: null,
            transactionType: type,
            referenceType: type === 'ISSUE' ? 'ISSUE_NOTE' : 'SUPPLIER_RETURN',
            referenceNumber: reference.trim() || null,
            reason: reason.trim(),
            notes: notes.trim() || null,
          },
          key,
        )
        onPosted(`Posted ${result.transaction_number}.`)
        setProduct(null)
        setLot(null)
        setQty('')
        setReason('')
        setReference('')
        setNotes('')
        return result.transaction_number
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type" htmlFor="is-type">
          <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
            <SelectTrigger id="is-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ISSUE">Issue</SelectItem>
              <SelectItem value="SUPPLIER_RETURN">Supplier return</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Location" htmlFor="is-location">
          <LocationSelect id="is-location" value={locationId} onChange={(v) => { setLocationId(v); setLot(null) }} options={locations} />
        </Field>
        <Field label="Product" htmlFor="is-product" full>
          <ProductPicker id="is-product" value={product} onChange={(p) => { setProduct(p); setLot(null) }} includeInactive autoFocus />
        </Field>
        <Field label="Lot / source" htmlFor="is-lot" full>
          <LotSelect id="is-lot" productId={product?.product_id ?? null} locationId={locationId || null} value={lot} onChange={setLot} />
          {lot && <LotSummary lot={lot} />}
        </Field>
        <Field label={`Quantity${product ? ` (${product.base_unit})` : ''}`} htmlFor="is-qty">
          <Input id="is-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Reason" htmlFor="is-reason">
          <Input id="is-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Sample to customer" />
        </Field>
        <Field label="Reference" htmlFor="is-ref">
          <Input id="is-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Notes" htmlFor="is-notes" full>
          <Textarea id="is-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </StockFormDialog>
  )
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------
export function TransferDialog({
  open,
  onOpenChange,
  locations,
  onPosted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  locations: LocationOption[]
  onPosted: (message: string) => void
}) {
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [lot, setLot] = useState<StockDetailRow | null>(null)
  const [qty, setQty] = useState('')
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')

  return (
    <StockFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Transfer stock"
      description="Move stock between locations. Product, unit, batch and source are preserved; company total is unchanged."
      confirmLabel="Post transfer"
      validate={() => {
        if (!product) return 'Select a product.'
        if (!fromId || !toId) return 'Select both source and destination locations.'
        if (fromId === toId) return 'Choose a different destination.'
        if (!lot) return 'Select the lot / source to transfer.'
        const q = parseUnitQty(qty, product?.base_unit)
        if (!q) return `Enter a quantity greater than zero (${quantityRule(product?.base_unit)}).`
        if (q > Number(lot.available)) return `Only ${formatQty(lot.available, lot.base_unit)} is available to transfer.`
        return null
      }}
      review={() => [
        { label: 'Product', value: product ? `${product.sku} — ${product.product_name}` : '' },
        { label: 'Lot', value: lot ? `${lot.batch_number ?? 'No batch'} · ${lot.source_type}` : '' },
        { label: 'From', value: locations.find((l) => l.id === fromId)?.label },
        { label: 'To', value: locations.find((l) => l.id === toId)?.label },
        { label: 'Quantity', value: formatQty(parseUnitQty(qty, product?.base_unit), product?.base_unit) },
        { label: 'Reference', value: reference },
      ]}
      submit={async (key) => {
        const result = await postTransfer(
          {
            productId: product!.product_id,
            fromLocationId: fromId,
            toLocationId: toId,
            quantity: parseUnitQty(qty, product?.base_unit)!,
            batchId: lot!.batch_id,
            referenceNumber: reference.trim() || null,
            reason: reason.trim() || null,
            notes: null,
          },
          key,
        )
        onPosted(`Transfer posted: ${result.out_transaction_number} / ${result.in_transaction_number}.`)
        setProduct(null)
        setLot(null)
        setQty('')
        setReference('')
        setReason('')
        return result.out_transaction_number
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Product" htmlFor="tr-product" full>
          <ProductPicker id="tr-product" value={product} onChange={(p) => { setProduct(p); setLot(null) }} includeInactive autoFocus />
        </Field>
        <Field label="From location" htmlFor="tr-from">
          <LocationSelect id="tr-from" value={fromId} onChange={(v) => { setFromId(v); setLot(null) }} options={locations} />
        </Field>
        <Field label="To location" htmlFor="tr-to">
          <LocationSelect id="tr-to" value={toId} onChange={setToId} options={locations} exclude={fromId} />
        </Field>
        <Field label="Lot / source" htmlFor="tr-lot" full>
          <LotSelect id="tr-lot" productId={product?.product_id ?? null} locationId={fromId || null} value={lot} onChange={setLot} />
          {lot && <LotSummary lot={lot} />}
        </Field>
        <Field label={`Quantity${product ? ` (${product.base_unit})` : ''}`} htmlFor="tr-qty">
          <Input id="tr-qty" inputMode={qtyInputMode(product?.base_unit)} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Reference" htmlFor="tr-ref">
          <Input id="tr-ref" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Reason (optional)" htmlFor="tr-reason" full>
          <Input id="tr-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Stock transfer" />
        </Field>
      </div>
    </StockFormDialog>
  )
}
