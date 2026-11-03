import { Loader2, ScanLine, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { StockSourceBadge } from '@/features/inventory/inventory-badges'
import { formatQty, STOCK_SOURCE_LABELS, type StockSourceCode } from '@/features/inventory/inventory-model'
import type { LocationOption } from '@/features/inventory/use-storage'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { fetchLotsAt, findProductByCode, searchProducts, type ProductOption } from '@/services/inventory'
import type { StockDetailRow } from '@/types/database-inventory'

/**
 * Product selector with barcode support. A keyboard-wedge scanner "types" the
 * code and presses Enter: Enter performs an exact barcode/SKU lookup. Typing
 * also shows a short search list. No camera scanning is implemented.
 */
export function ProductPicker({
  id,
  value,
  onChange,
  includeInactive = false,
  autoFocus,
}: {
  id?: string
  value: ProductOption | null
  onChange: (product: ProductOption | null) => void
  includeInactive?: boolean
  autoFocus?: boolean
}) {
  const generated = useId()
  const inputId = id ?? generated
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<ProductOption[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const term = useDebouncedValue(text, 250)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || value) return
    let cancelled = false
    void Promise.resolve()
      .then(() => {
        if (!cancelled) setLoading(true)
        return searchProducts(term, includeInactive)
      })
      .then((r) => !cancelled && setResults(r))
      .catch(() => !cancelled && setResults([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [term, open, value, includeInactive])

  const lookupExact = async () => {
    const code = text.trim()
    if (!code) return
    setMessage(null)
    try {
      const matches = await findProductByCode(code)
      if (matches.length === 0) setMessage(`No product has barcode or SKU "${code}".`)
      else if (matches.length > 1) setMessage(`"${code}" matches more than one product. Search by name instead.`)
      else {
        onChange(matches[0])
        setText('')
        setOpen(false)
      }
    } catch (error) {
      setMessage(describeDataError(error))
    }
  }

  if (value) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-surface-muted/50 px-3 text-sm">
        <span className="truncate">
          <span className="font-medium">{value.sku}</span> — {value.product_name}
          <span className="ml-1 text-xs text-muted-foreground">({value.base_unit}{value.track_batches ? ', batch-tracked' : ''})</span>
        </span>
        <button type="button" onClick={() => onChange(null)} aria-label="Change product" className="rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <ScanLine aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={inputId}
        ref={inputRef}
        autoFocus={autoFocus}
        value={text}
        placeholder="Scan barcode or search SKU / name"
        autoComplete="off"
        className="pl-9"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setText(e.target.value)
          setMessage(null)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void lookupExact()
          }
        }}
      />
      {open && (
        <ul className="absolute top-full right-0 left-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg" role="listbox">
          {loading && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Searching…
            </li>
          )}
          {!loading && results.length === 0 && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
              <Search className="size-3.5" /> No matching products. Press Enter for an exact barcode/SKU lookup.
            </li>
          )}
          {results.map((p) => (
            <li
              key={p.product_id}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(p)
                setText('')
                setOpen(false)
              }}
              className="cursor-pointer rounded-md px-3 py-1.5 text-sm hover:bg-muted"
            >
              <span className="font-medium">{p.sku}</span> — {p.product_name}
              <span className="ml-1 text-xs text-muted-foreground">{p.base_unit}</span>
              {p.product_status === 'INACTIVE' && <span className="ml-1 text-xs text-amber-700">(inactive)</span>}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="mt-1 text-xs text-shortage">{message}</p>}
    </div>
  )
}

export function LocationSelect({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select location',
  exclude,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  options: LocationOption[]
  placeholder?: string
  exclude?: string
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.filter((o) => o.id !== exclude).length === 0 && (
          <div className="px-3 py-2 text-sm text-muted-foreground">No active locations. Create a warehouse first.</div>
        )}
        {options
          .filter((o) => o.id !== exclude)
          .map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.label}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

/** Lots (batch / source) of a product held at a location, with availability. */
export function LotSelect({
  id,
  productId,
  locationId,
  value,
  onChange,
  showReserved = true,
}: {
  id?: string
  productId: string | null
  locationId: string | null
  value: StockDetailRow | null
  onChange: (lot: StockDetailRow | null) => void
  showReserved?: boolean
}) {
  const [lots, setLots] = useState<StockDetailRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!productId || !locationId) return
    let cancelled = false
    void Promise.resolve()
      .then(() => {
        if (cancelled) return null
        setLoading(true)
        setError(null)
        return fetchLotsAt(productId, locationId)
      })
      .then((r) => {
        if (cancelled || !r) return
        setLots(r)
        if (r.length === 1) onChange(r[0])
      })
      .catch((e: unknown) => !cancelled && setError(describeDataError(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // onChange intentionally excluded: selecting the single lot only on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, locationId])

  if (!productId || !locationId) return <p className="text-xs text-muted-foreground">Select a product and location first.</p>
  if (loading) return <p className="text-xs text-muted-foreground">Loading stock…</p>
  if (error) return <p className="text-xs text-shortage">{error}</p>
  if (lots.length === 0) return <p className="text-xs text-shortage">No stock of this product at this location.</p>

  return (
    <Select value={value?.batch_id ?? ''} onValueChange={(v) => onChange(lots.find((l) => l.batch_id === v) ?? null)}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select lot / source" />
      </SelectTrigger>
      <SelectContent>
        {lots.map((l) => (
          <SelectItem key={l.batch_id} value={l.batch_id}>
            {l.batch_number ? `Batch ${l.batch_number} · ` : ''}
            {STOCK_SOURCE_LABELS[l.source_type as StockSourceCode]} · available {formatQty(l.available, l.base_unit)}
            {showReserved && Number(l.reserved) > 0 ? ` (reserved ${formatQty(l.reserved)})` : ''}
            {l.expiry_date ? ` · exp ${l.expiry_date}` : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function LotSummary({ lot }: { lot: StockDetailRow }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 rounded-md border bg-surface-muted/50 px-3 py-2 text-xs')}>
      <StockSourceBadge source={lot.source_type} />
      {lot.batch_number && <span>Batch {lot.batch_number}</span>}
      <span>On hand {formatQty(lot.on_hand, lot.base_unit)}</span>
      <span className="text-amber-800">Reserved {formatQty(lot.reserved)}</span>
      <span className="font-medium text-green-700">Available {formatQty(lot.available)}</span>
    </div>
  )
}
