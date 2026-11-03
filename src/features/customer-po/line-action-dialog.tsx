import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { parseQuantity } from '@/features/inventory/inventory-model'
import { ProductPicker } from '@/features/inventory/pickers'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import type { ProductOption } from '@/services/inventory'
import { fetchProductsByIds, poLineAction, type LineAction } from '@/services/customer-po'
import type { CustomerPoLineListRow } from '@/types/database-customer-po'

const TITLES: Record<LineAction, string> = {
  MATCH: 'Select the product',
  CONFIRM_DUPLICATE: 'Confirm as a separate demand',
  EXCLUDE: 'Exclude line from fulfilment',
  RESTORE: 'Restore excluded line',
  FLAG_NEW_PRODUCT: 'Flag for Product Master creation',
  UNFLAG: 'Remove Product Master flag',
  CORRECT: 'Correct quantity / unit',
}

/** Review actions on one PO line. The server validates everything and logs the change. */
export function LineActionDialog({
  line,
  action,
  hasCustomerRecord,
  onClose,
  onDone,
}: {
  line: CustomerPoLineListRow
  action: LineAction
  hasCustomerRecord: boolean
  onClose: () => void
  onDone: (message: string) => void
}) {
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [remember, setRemember] = useState(false)
  const [note, setNote] = useState('')
  const [qty, setQty] = useState(String(line.quantity_ordered))
  const [unit, setUnit] = useState(line.unit ?? line.uploaded_unit ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidates = useAsync(() => fetchProductsByIds(line.candidate_product_ids ?? []), [line.id])
  const code = line.uploaded_customer_sku ?? line.uploaded_sku
  const needsNote = action === 'EXCLUDE' || action === 'CORRECT'

  const submit = async () => {
    setError(null)
    if (action === 'MATCH' && !product) return setError('Select the product.')
    if (needsNote && note.trim().length < (action === 'CORRECT' ? 5 : 3)) return setError('Enter the reason.')
    const q = action === 'CORRECT' ? parseQuantity(qty) : null
    if (action === 'CORRECT' && !q) return setError('Quantity must be greater than zero (up to 3 decimals).')
    setBusy(true)
    try {
      const r = await poLineAction({ lineId: line.id, action, productId: product?.product_id ?? null, remember, note: note.trim() || null, quantity: q, unit: action === 'CORRECT' ? unit.trim().toUpperCase() || null : null })
      onDone(`Line ${line.line_no}: ${r.line_status.replace(/_/g, ' ').toLowerCase()}. PO is ${r.po_status.replace(/_/g, ' ').toLowerCase()}.`)
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{TITLES[action]} — line {line.line_no}</DialogTitle>
          <DialogDescription>
            Uploaded: {[line.uploaded_sku, line.uploaded_customer_sku, line.uploaded_barcode].filter(Boolean).join(' / ') || 'no code'}
            {line.uploaded_description ? ` · ${line.uploaded_description}` : ''} · {line.uploaded_quantity} {line.uploaded_unit ?? ''}
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="space-y-4">
          {action === 'MATCH' && (
            <>
              {(candidates.data ?? []).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Candidates for this code</p>
                  <div className="flex flex-wrap gap-2">
                    {(candidates.data ?? []).map((c) => (
                      <button key={c.id} type="button" onClick={() => setProduct({ product_id: c.id, sku: c.sku, product_name: c.product_name, base_unit: c.base_unit, track_batches: false, track_expiry: false })}
                        className={cn('rounded-md border px-2.5 py-1 text-sm hover:bg-muted', product?.product_id === c.id && 'border-primary bg-accent')}>
                        {c.sku} — {c.product_name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="la-product">Product from the Product Master</Label>
                <ProductPicker id="la-product" value={product} onChange={setProduct} />
                <p className="text-xs text-muted-foreground">Pick the exact product; nothing is matched by description automatically. Unknown products are not created here.</p>
              </div>
              {product && line.uploaded_unit && product.base_unit !== line.uploaded_unit && (
                <p className="text-sm text-amber-800">The uploaded unit {line.uploaded_unit} differs from {product.base_unit}: the line will need a unit correction (no conversion is applied).</p>
              )}
              <div className="flex items-start gap-2">
                <Checkbox id="la-remember" checked={remember} disabled={!hasCustomerRecord || !code} onCheckedChange={(v) => setRemember(v === true)} />
                <Label htmlFor="la-remember" className="font-normal">
                  Remember "{code ?? '—'}" as this customer's code for the product (verified mapping used for future POs)
                  {!hasCustomerRecord && <span className="block text-xs text-muted-foreground">Needs a customer record on the PO.</span>}
                </Label>
              </div>
            </>
          )}
          {action === 'CORRECT' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="la-qty">Quantity</Label><Input id="la-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></div>
              <div className="space-y-1.5"><Label htmlFor="la-unit">Unit{line.base_unit ? ` (product unit ${line.base_unit})` : ''}</Label><Input id="la-unit" maxLength={10} value={unit} onChange={(e) => setUnit(e.target.value.toUpperCase())} /></div>
              <p className="text-xs text-muted-foreground sm:col-span-2">The uploaded values stay on record; the correction and its reason are logged.</p>
            </div>
          )}
          {action !== 'RESTORE' && action !== 'UNFLAG' && action !== 'FLAG_NEW_PRODUCT' && (
            <div className="space-y-1.5">
              <Label htmlFor="la-note">{needsNote ? 'Reason (required)' : 'Note (optional)'}</Label>
              <Textarea id="la-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          {action === 'FLAG_NEW_PRODUCT' && <p className="text-sm">The line is listed in the Unmatched products report so the product can be created through the Product Master process. Re-run matching once it exists.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy} variant={action === 'EXCLUDE' ? 'destructive' : 'default'}>{busy && <Loader2 className="animate-spin" />} Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
