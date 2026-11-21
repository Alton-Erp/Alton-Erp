import { Archive, Loader2, Package, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { productDetail, quantityError, type PickedProduct } from '@/features/support/ticket-fields/product-model'
import { useAsync } from '@/hooks/use-async'
import { searchTicketProducts, type ProductHit } from '@/services/ticket-fields'

/**
 * Product Master selector: server-side search (name, SKU, product code, barcode, EAN) with a short debounce,
 * several products with a quantity each. The real product id is saved; archived products are offered only to
 * users who may edit the Product Master, and only when they tick "Include archived".
 */
export function ProductMasterPicker({ value, onChange, canIncludeArchived = false, includeArchived = false, onIncludeArchived, id = 'tk-products', invalid }: {
  value: PickedProduct[]; onChange: (v: PickedProduct[]) => void; canIncludeArchived?: boolean; includeArchived?: boolean
  onIncludeArchived?: (v: boolean) => void; id?: string; invalid?: boolean
}) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { const t = setTimeout(() => setDebounced(term.trim()), 250); return () => clearTimeout(t) }, [term])
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const results = useAsync(() => (debounced ? searchTicketProducts(debounced, includeArchived) : Promise.resolve(null)), [debounced, includeArchived])
  const add = (p: ProductHit) => {
    if (value.some((x) => x.product_id === p.id)) onChange(value.map((x) => (x.product_id === p.id ? { ...x, quantity: String(Number(x.quantity || 0) + 1) } : x)))
    else onChange([...value, { product_id: p.id, sku: p.sku, product_name: p.product_name, quantity: '1', archived: p.archived, detail: productDetail(p) }])
    setTerm(''); setDebounced(''); setOpen(false)
  }
  return (
    <div className="space-y-2" data-testid="product-picker">
      <div className="relative" ref={box}>
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input id={id} value={term} aria-invalid={invalid || undefined} onChange={(e) => { setTerm(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} className="pl-8"
          placeholder="Search Product Master: name, SKU, product code, barcode or EAN" autoComplete="off" role="combobox" aria-expanded={open && Boolean(debounced)} aria-controls={`${id}-results`} />
        {results.loading && debounced && <Loader2 className="absolute top-2.5 right-2.5 size-4 animate-spin text-muted-foreground" />}
        {open && debounced && (results.data || results.error) && (
          <ul id={`${id}-results`} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover text-sm shadow-lg" data-testid="product-results">
            {results.error && <li className="px-3 py-2 text-red-700">Product search is not available to your role.</li>}
            {results.data?.length === 0 && <li className="px-3 py-2 text-muted-foreground">No product matches “{debounced}”.</li>}
            {results.data?.map((p) => (
              <li key={p.id} role="option" aria-selected={value.some((x) => x.product_id === p.id)}>
                <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted" onClick={() => add(p)} data-testid={`product-hit-${p.sku}`}>
                  <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.product_name}{p.archived && <span className="ml-1.5 text-xs font-normal text-amber-700">(archived)</span>}</span>
                    <span className="block truncate text-xs text-muted-foreground"><span className="font-mono">{p.sku}</span>{productDetail(p) ? ` · ${productDetail(p)}` : ''}</span>
                  </span>
                  {value.some((x) => x.product_id === p.id) && <span className="text-xs text-muted-foreground">added</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {canIncludeArchived && onIncludeArchived && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={includeArchived} onCheckedChange={(v) => onIncludeArchived(v === true)} />Include archived products</label>
      )}
      {value.length > 0 && (
        <ul className="divide-y rounded-md border" data-testid="picked-products">
          {value.map((p) => {
            const err = quantityError(p.quantity)
            return (
              <li key={p.product_id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid={`picked-${p.sku}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.product_name}{p.archived && <span className="ml-1.5 inline-flex items-center gap-0.5 text-xs font-normal text-amber-700"><Archive className="size-3" />archived</span>}</span>
                  <span className="block truncate text-xs text-muted-foreground"><span className="font-mono">{p.sku}</span>{p.detail ? ` · ${p.detail}` : ''}</span>
                </span>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">Qty
                  <Input aria-label={`Quantity of ${p.sku}`} aria-invalid={Boolean(err) || undefined} value={p.quantity} inputMode="decimal" className="h-8 w-20 text-right tabular-nums"
                    onChange={(e) => onChange(value.map((x) => (x.product_id === p.product_id ? { ...x, quantity: e.target.value } : x)))} />
                </label>
                <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Remove ${p.sku}`} onClick={() => onChange(value.filter((x) => x.product_id !== p.product_id))}><X className="size-4" /></Button>
                {err && <p className="w-full text-xs text-red-700" role="alert">{err}</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
