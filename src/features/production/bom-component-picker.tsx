import { Loader2, ScanLine, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { formatQty } from '@/features/inventory/inventory-model'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { findBomComponentByCode, searchBomComponents, type BomComponentOption } from '@/services/bom-components'
import type { ProductOption } from '@/services/inventory'

/**
 * Searchable BOM component selector. Typing searches product name, SKU,
 * barcode and supplier model number; each suggestion shows the SKU, barcode,
 * inventory unit and available stock. ↑/↓ move, Enter chooses, Esc closes.
 * A barcode scanner (types the code + Enter) does an exact barcode / SKU /
 * supplier-model lookup. Products in `exclude` (the BOM's own output product,
 * components already on another line) are shown but cannot be chosen.
 */
export function BomComponentPicker({
  id,
  label,
  value,
  onChange,
  exclude,
}: {
  id?: string
  /** Accessible name, e.g. "Component line 2". */
  label: string
  value: ProductOption | null
  onChange: (product: BomComponentOption | null) => void
  /** product_id → why it cannot be chosen */
  exclude: Map<string, string>
}) {
  const generated = useId()
  const inputId = id ?? generated
  const listId = `${inputId}-list`
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<BomComponentOption[]>([])
  const [resultsFor, setResultsFor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const term = useDebouncedValue(text, 200)
  const listRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open || value) return
    let cancelled = false
    void Promise.resolve()
      .then(() => {
        if (!cancelled) setLoading(true)
        return searchBomComponents(term)
      })
      .then((r) => {
        if (cancelled) return
        setResults(r)
        setResultsFor(term.trim())
        setActive(Math.max(0, r.findIndex((p) => !exclude.has(p.product_id))))
      })
      .catch((e: unknown) => { if (!cancelled) { setResults([]); setMessage(describeDataError(e)) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `exclude` changes identity on every render of the editor; the list only needs re-filtering, not a new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, open, value])

  const choose = (p: BomComponentOption) => {
    const reason = exclude.get(p.product_id)
    if (reason) { setMessage(`${p.sku}: ${reason}`); return }
    onChange(p)
    setText('')
    setMessage(null)
    setOpen(false)
  }

  const lookupExact = async () => {
    const code = text.trim()
    if (!code) return
    setMessage(null)
    try {
      const matches = await findBomComponentByCode(code)
      if (matches.length === 0) setMessage(`No active product has barcode, SKU or supplier model “${code}”. Search by name instead.`)
      else if (matches.length > 1) setMessage(`“${code}” matches more than one product. Choose it from the list.`)
      else choose(matches[0])
    } catch (e) {
      setMessage(describeDataError(e))
    }
  }

  const move = (delta: number) => {
    if (results.length === 0) return
    let next = active
    for (let i = 0; i < results.length; i++) {
      next = (next + delta + results.length) % results.length
      if (!exclude.has(results[next].product_id)) break
    }
    setActive(next)
    listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' })
  }

  if (value) {
    return (
      <div className="flex min-h-9 items-center justify-between gap-2 rounded-md border bg-surface-muted/50 px-3 py-1.5 text-sm">
        <span className="min-w-0">
          <span className="block truncate font-medium">{value.product_name}</span>
          <span className="block truncate text-xs text-muted-foreground">{value.sku} · {value.base_unit}</span>
        </span>
        <button type="button" onClick={() => { onChange(null); setTimeout(() => inputRef.current?.focus(), 0) }} aria-label={`Change ${label}`}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
    )
  }

  const current = resultsFor === text.trim()

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <div className="relative">
            <ScanLine aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id={inputId}
              ref={inputRef}
              role="combobox"
              aria-label={label}
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && current && results[active] ? `${listId}-${active}` : undefined}
              value={text}
              placeholder="Search name, SKU, barcode or supplier model"
              autoComplete="off"
              className="pl-9"
              onFocus={() => setOpen(true)}
              onClick={() => setOpen(true)}
              onChange={(e) => { setText(e.target.value); setMessage(null); setOpen(true) }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else move(1) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
                else if (e.key === 'Escape') { setOpen(false) }
                else if (e.key === 'Enter') {
                  e.preventDefault()
                  // Only pick from the list when it belongs to what is typed now; a scanner's code + Enter arrives before the search.
                  const p = open && current ? results[active] : undefined
                  if (p && !exclude.has(p.product_id)) choose(p)
                  else void lookupExact()
                }
              }}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-[min(30rem,calc(100vw-2rem))] p-1"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => { if (e.target instanceof Node && inputRef.current?.parentElement?.contains(e.target)) e.preventDefault() }}
        >
          <ul id={listId} ref={listRef} role="listbox" aria-label={`${label} suggestions`} className="max-h-72 overflow-y-auto">
            {loading && results.length === 0 && (
              <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Searching…</li>
            )}
            {!loading && results.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground">No matching active products. Press Enter for an exact barcode / SKU lookup.</li>
            )}
            {results.map((p, i) => {
              const reason = exclude.get(p.product_id)
              return (
                <li
                  key={p.product_id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={Boolean(reason)}
                  onMouseEnter={() => !reason && setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); choose(p) }}
                  className={cn('rounded-md px-3 py-1.5 text-sm', reason ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', i === active && !reason && 'bg-muted')}
                >
                  <span className="block font-medium">{p.product_name}</span>
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    <span>SKU {p.sku}</span>
                    {p.barcode && <span>· Barcode {p.barcode}</span>}
                    {p.supplier_model_number && <span>· Supplier model {p.supplier_model_number}</span>}
                    <span>· {p.base_unit}</span>
                    <span className={cn(p.available !== null && p.available <= 0 && 'text-shortage')}>
                      · {p.available === null ? 'stock not shown' : `Available ${formatQty(p.available, p.base_unit)}`}
                    </span>
                    {reason && <span className="font-medium">· {reason}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        </PopoverContent>
      </Popover>
      {message && <p className="mt-1 text-xs text-shortage">{message}</p>}
    </div>
  )
}
