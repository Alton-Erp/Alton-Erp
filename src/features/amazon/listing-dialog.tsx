import { Loader2 } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { describeDataError } from '@/lib/errors'
import { saveListing, type ErpProduct, type Listing } from '@/services/amazon'

const NUM_FIELDS = [
  ['unit_cost_override', 'Unit cost override (ex-GST)', 'Leave empty to use the ERP product cost.'],
  ['gst_rate', 'GST rate % override', 'Leave empty to use the ERP product GST rate.'],
  ['referral_fee_pct', 'Referral fee % (estimate)', 'Used only for days without settlement fee data.'],
  ['closing_fee_per_unit', 'Closing fee per unit (estimate)', ''],
  ['fulfilment_fee_per_unit', 'Fulfilment / FBA fee per unit (estimate)', ''],
  ['shipping_cost_per_unit', 'Own shipping cost per unit', 'Easy Ship / self-ship costs paid by you.'],
  ['other_variable_cost_per_unit', 'Other variable cost per unit', 'Packaging, inserts, payment charges...'],
  ['desired_contribution_per_unit', 'Desired contribution per unit', 'Sets the target ACoS; else the company target % is used.'],
  ['target_acos_pct', 'Manual target ACoS %', 'Overrides the calculated target.'],
  ['min_stock', 'Minimum stock (units)', ''],
  ['lead_time_days', 'Replenishment lead time (days)', 'Needed for replenishment quantities.'],
] as const

type NumKey = (typeof NUM_FIELDS)[number][0]

/** Edit a listing's ERP mapping and unit economics, or add a manual listing. All changes are audited server-side. */
export function ListingDialog({ listing, products, onClose, onSaved }: { listing: Listing | null; products: ErpProduct[]; onClose: () => void; onSaved: (m: string) => void }) {
  const isNew = !listing
  const manual = isNew || listing.data_source === 'MANUAL'
  const [productId, setProductId] = useState(listing?.product_id ?? 'none')
  const [sku, setSku] = useState(listing?.seller_sku ?? '')
  const [asin, setAsin] = useState(listing?.asin ?? '')
  const [title, setTitle] = useState(listing?.title ?? '')
  const [price, setPrice] = useState(listing?.item_price === null || listing?.item_price === undefined ? '' : String(listing.item_price))
  const [note, setNote] = useState(listing?.cost_note ?? '')
  const [nums, setNums] = useState<Record<NumKey, string>>(() =>
    Object.fromEntries(NUM_FIELDS.map(([k]) => [k, listing?.[k] === null || listing?.[k] === undefined ? '' : String(listing[k])])) as Record<NumKey, string>)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const erp = products.find((p) => p.id === productId)

  const submit = async () => {
    setError(null)
    const body: Record<string, unknown> = { cost_note: note }
    for (const [k, label] of NUM_FIELDS) {
      const v = nums[k].trim()
      if (v === '') body[k] = null
      else if (!Number.isFinite(Number(v)) || Number(v) < 0) return setError(`${label}: enter a non-negative number or leave it empty.`)
      else body[k] = Number(v)
    }
    if (listing) body.id = listing.id
    if (!listing?.is_demo) body.product_id = productId === 'none' ? null : productId
    if (manual) {
      if (isNew && !sku.trim()) return setError('Seller SKU is required.')
      if (asin.trim() && !/^[A-Z0-9]{10}$/i.test(asin.trim())) return setError('An ASIN has 10 letters / digits.')
      Object.assign(body, { seller_sku: sku.trim(), asin: asin.trim(), title: title.trim(), item_price: price.trim() === '' ? null : Number(price) })
    }
    setBusy(true)
    try {
      await saveListing(body as Partial<Listing>)
      onSaved(isNew ? `Listing ${sku.trim()} added.` : `Listing ${listing.seller_sku} saved.`)
    } catch (e) {
      setError(describeDataError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{isNew ? 'Add a manual listing' : `Listing ${listing.seller_sku}`}</DialogTitle>
          <DialogDescription>{isNew ? 'For listings not yet synchronised from Amazon. Synchronised listings are created automatically.'
            : `${listing.asin ?? 'No ASIN'} · ${listing.data_source}${listing.is_demo ? ' · DEMO' : ''}. Changes are audited.`}</DialogDescription></DialogHeader>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          {manual && <>
            <div className="space-y-1"><Label htmlFor="ls-sku">Seller SKU</Label><Input id="ls-sku" value={sku} disabled={!isNew} maxLength={100} onChange={(e) => setSku(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="ls-asin">ASIN</Label><Input id="ls-asin" value={asin} maxLength={10} onChange={(e) => setAsin(e.target.value.toUpperCase())} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="ls-title">Title</Label><Input id="ls-title" value={title} maxLength={500} onChange={(e) => setTitle(e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="ls-price">Selling price (incl. GST)</Label><Input id="ls-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          </>}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="ls-product">ERP product</Label>
            {listing?.is_demo ? <p className="text-muted-foreground">Demo listings cannot be mapped to real ERP products.</p> : <>
              <Select value={productId} onValueChange={setProductId}><SelectTrigger id="ls-product"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72"><SelectItem value="none">Not mapped</SelectItem>
                  {products.map((p) => <SelectItem key={p.id} value={p.id}>{p.sku} — {p.product_name}</SelectItem>)}</SelectContent></Select>
              {erp && <p className="text-xs text-muted-foreground">ERP cost {erp.standard_cost ?? 'not set'} · GST {erp.gst_rate ?? 'not set'}% · HSN {erp.hsn_code ?? '-'}</p>}
            </>}
          </div>
          {NUM_FIELDS.map(([k, label, help]) => (
            <div key={k} className="space-y-1"><Label htmlFor={`ls-${k}`}>{label}</Label>
              <Input id={`ls-${k}`} inputMode="decimal" value={nums[k]} onChange={(e) => setNums((s) => ({ ...s, [k]: e.target.value }))} />
              {help && <p className="text-xs text-muted-foreground">{help}</p>}</div>
          ))}
          <div className="space-y-1 sm:col-span-2"><Label htmlFor="ls-note">Cost note</Label><Input id="ls-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Source of the cost figures" /></div>
        </div>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => void submit()}>{busy && <Loader2 className="animate-spin" />} Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
