import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { useAuth } from '@/auth/use-auth'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PRODUCT_TYPE_LABELS, PRODUCT_TYPES, UNITS, defaultSourceFor, unitOptionLabel, type ProductType } from '@/features/products/product-model'
import { EMPTY_PRODUCT_FORM, validateProduct } from '@/features/products/product-validation'
import { describeDataError } from '@/lib/errors'
import { createProduct } from '@/services/products'

export interface QuickAddedProduct { product_id: string; sku: string; product_name: string; base_unit: string; selling_price: number | null; gst_rate: number | null }

/**
 * Adds a product with the essentials only (name, type, unit, price, GST).
 * Everything else can be completed later in the Product Master; a blank SKU
 * gets the next code for the type.
 */
export function QuickAddProductDialog({ initialSku = '', initialName = '', onClose, onCreated }: {
  initialSku?: string
  initialName?: string
  onClose: () => void
  onCreated: (p: QuickAddedProduct) => void
}) {
  const { access } = useAuth()
  const [name, setName] = useState(initialName)
  const [sku, setSku] = useState(initialSku)
  const [type, setType] = useState<ProductType>('FINISHED_GOOD')
  const [unit, setUnit] = useState('PCS')
  const [price, setPrice] = useState('')
  const [gst, setGst] = useState('18')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    const v = validateProduct({ ...EMPTY_PRODUCT_FORM, product_name: name, sku, product_type: type, default_source_type: defaultSourceFor(type), base_unit: unit,
      selling_price: price, gst_rate: gst })
    const errs = Object.values(v.errors).filter(Boolean)
    if (!v.input || errs.length) return setError(errs.join(' ') || 'Check the product details.')
    const companyId = access?.company?.id
    if (!companyId) return setError('Your company could not be determined.')
    setBusy(true)
    try {
      const r = await createProduct(companyId, v.input)
      onCreated({ product_id: r.id, sku: r.sku, product_name: v.input.product_name, base_unit: v.input.base_unit, selling_price: v.input.selling_price, gst_rate: v.input.gst_rate })
    } catch (e) {
      setError(describeDataError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Add a product</DialogTitle>
          <DialogDescription>Only the essentials. Complete the rest later in the Product Master. Leave the SKU blank to number it automatically.</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="qp-name">Product name</Label><Input id="qp-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="space-y-1"><Label htmlFor="qp-sku">SKU</Label><Input id="qp-sku" maxLength={50} value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="Automatic" /></div>
          <div className="space-y-1"><Label htmlFor="qp-type">Type</Label>
            <Select value={type} onValueChange={(v) => { if (v) setType(v as ProductType) }}>
              <SelectTrigger id="qp-type"><SelectValue /></SelectTrigger>
              <SelectContent>{PRODUCT_TYPES.map((t) => <SelectItem key={t} value={t}>{PRODUCT_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="qp-unit">Unit</Label>
            <Select value={unit} onValueChange={(v) => { if (v) setUnit(v) }}>
              <SelectTrigger id="qp-unit"><SelectValue /></SelectTrigger>
              <SelectContent>{UNITS.map((u) => <SelectItem key={u.code} value={u.code}>{unitOptionLabel(u.code)}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="qp-price">Selling price (₹)</Label><Input id="qp-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="qp-gst">GST %</Label><Input id="qp-gst" inputMode="decimal" value={gst} onChange={(e) => setGst(e.target.value)} /></div>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Add product</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
