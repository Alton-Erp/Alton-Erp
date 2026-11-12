import { Loader2, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { formatQty } from '@/features/inventory/inventory-model'
import { BOM_OUTPUT_TYPES, PRODUCT_TYPE_LABELS, type ProductType } from '@/features/products/product-model'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { searchBomComponents, type BomComponentOption } from '@/services/bom-components'

/** An existing Product Master product chosen for a Generate Multiple row. */
export interface PickedProduct {
  product_id: string
  sku: string
  product_name: string
  base_unit: string
  product_type: string
}

/**
 * Product Name for Generate Multiple: clicking it opens a list of Product Master products (the same search as the
 * BOM component selector: name, SKU, barcode, EAN, supplier model). Choosing one fills its SKU from the Product
 * Master. Typing a name without choosing keeps it as a NEW product name (created with its own SKU, or the automatic
 * one). Products in `exclude` (chosen on another row, the base BOM's product) and types that cannot have a BOM are
 * shown but cannot be chosen.
 */
export function BomProductNamePicker({ id, label, name, product, onName, onProduct, exclude }: {
  id: string
  label: string
  /** Typed name (a new product) when no existing product is chosen. */
  name: string
  product: PickedProduct | null
  onName: (name: string) => void
  onProduct: (product: PickedProduct | null) => void
  /** product_id → why it cannot be chosen. */
  exclude: Map<string, string>
}) {
  const listId = `${useId()}-list`
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<BomComponentOption[]>([])
  const [resultsFor, setResultsFor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const term = useDebouncedValue(name, 250)
  const inputRef = useRef<HTMLInputElement>(null)

  const reasonOf = (p: BomComponentOption) =>
    exclude.get(p.product_id) ?? (BOM_OUTPUT_TYPES.includes(p.product_type as ProductType) ? undefined
      : `${PRODUCT_TYPE_LABELS[p.product_type as ProductType] ?? p.product_type}: cannot have a BOM`)

  useEffect(() => {
    if (!open || product) return
    let cancelled = false
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null
        setLoading(true)
        setError(null)
        return searchBomComponents(term)
      })
      .then((r) => {
        if (cancelled || !r) return
        setResults(r)
        setResultsFor(term.trim())
        setActive(0)
      })
      .catch((e: unknown) => { if (!cancelled) { setResults([]); setError(describeDataError(e)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [term, open, product])

  const choose = (p: BomComponentOption) => {
    if (reasonOf(p)) return
    onProduct({ product_id: p.product_id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, product_type: p.product_type })
    setOpen(false)
  }

  if (product) {
    return (
      <div className="flex min-h-9 items-center justify-between gap-2 rounded-md border bg-surface-muted/50 px-3 py-1.5 text-sm" data-testid={`${id}-picked`}>
        <span className="min-w-0">
          <span className="block truncate font-medium">{product.product_name}</span>
          <span className="block truncate text-xs text-muted-foreground">Product Master · {product.sku} · {product.base_unit}</span>
        </span>
        <button type="button" aria-label={`Clear ${label}`} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onProduct(null); setTimeout(() => inputRef.current?.focus(), 0) }}>
          <X className="size-3.5" />
        </button>
      </div>
    )
  }

  const current = resultsFor === name.trim()
  const shown = current ? results : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={id}
            ref={inputRef}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            maxLength={200}
            className="pl-9"
            placeholder="Search Product Master or type a new name"
            value={name}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(e) => { onName(e.target.value); setOpen(true) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(0, shown.length - 1))) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
              else if (e.key === 'Escape') setOpen(false)
              else if (e.key === 'Enter') { e.preventDefault(); if (open && shown[active]) choose(shown[active]); else setOpen(false) }
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="w-[min(32rem,calc(100vw-2rem))] p-1" onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => { if (e.target instanceof Node && inputRef.current?.parentElement?.contains(e.target)) e.preventDefault() }}>
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="max-h-72 overflow-y-auto" data-testid={`${id}-list`}>
          {loading && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground" data-testid={`${id}-loading`}><Loader2 className="size-3.5 animate-spin" /> Searching Product Master…</li>
          )}
          {!loading && error && <li role="alert" className="px-3 py-2 text-sm text-shortage">Products could not be loaded: {error}</li>}
          {!loading && !error && current && results.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground" data-testid={`${id}-empty`}>
              No Product Master product matches “{name.trim()}”.{name.trim() ? ' It will be created as a new product.' : ''}
            </li>
          )}
          {shown.map((p, i) => {
            const reason = reasonOf(p)
            return (
              <li key={p.product_id} id={`${listId}-${i}`} role="option" aria-selected={i === active} aria-disabled={Boolean(reason)}
                onMouseEnter={() => !reason && setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(p) }}
                className={cn('rounded-md px-3 py-1.5 text-sm', reason ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', i === active && !reason && 'bg-muted')}>
                <span className="block font-medium">{p.product_name}</span>
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>SKU {p.sku}</span>
                  <span>· {p.base_unit}</span>
                  <span>· {PRODUCT_TYPE_LABELS[p.product_type as ProductType] ?? p.product_type}</span>
                  {p.barcode && <span>· Barcode {p.barcode}</span>}
                  {p.available !== null && <span>· Available {formatQty(p.available, p.base_unit)}</span>}
                  {reason && <span className="font-medium">· {reason}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
