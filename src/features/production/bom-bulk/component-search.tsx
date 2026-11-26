import { Loader2, Search, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { Input } from '@/components/ui/input'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { normalizeSearch } from '@/lib/search'
import { describeDataError } from '@/lib/errors'
import { searchComponents, type ComponentHit } from '@/services/bom-bulk'

/**
 * Finds a component by name, SKU, product / model code, barcode or EAN (active and
 * inactive products, with how many BOM lines use each). ↑/↓ and Enter choose.
 */
export function ComponentSearch({ label, value, onChange, activeOnly = false, testId }: {
  label: string
  value: ComponentHit | null
  onChange: (hit: ComponentHit | null) => void
  /** Only active products can be chosen (a replacement or added component). */
  activeOnly?: boolean
  testId?: string
}) {
  const id = useId()
  const [text, setText] = useState('')
  const term = useDebouncedValue(normalizeSearch(text), 250)
  const [found, setFound] = useState<{ term: string; hits: ComponentHit[] }>({ term: '', hits: [] })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    const t = term.trim()
    if (value || t.length < 2) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      setLoading(true)
      setError(null)
      return searchComponents(t, 20).then(
        (r) => { if (!cancelled) { setFound({ term: t, hits: r }); setActive(0) } },
        (e: unknown) => { if (!cancelled) setError(describeDataError(e)) },
      )
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [term, value])

  const hits = !value && found.term === term.trim() && term.trim().length >= 2 ? found.hits : []
  const choose = (h: ComponentHit) => {
    if (activeOnly && h.status !== 'ACTIVE') return
    onChange(h)
    setText('')
    setFound({ term: '', hits: [] })
  }

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-surface-muted/40 px-3 py-2 text-sm" data-testid={testId}>
        <span className="min-w-0 flex-1 truncate"><span className="font-medium">{value.sku}</span> — {value.product_name}
          <span className="ml-2 text-xs text-muted-foreground">{value.base_unit}{value.status !== 'ACTIVE' ? ` · ${value.status.toLowerCase()}` : ''}</span></span>
        <button type="button" aria-label={`Clear ${label}`} className="rounded p-1 text-muted-foreground hover:bg-surface-muted hover:text-foreground" onClick={() => onChange(null)}>
          <X className="size-4" />
        </button>
      </div>
    )
  }
  return (
    <div className="relative" data-testid={testId}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        id={id}
        aria-label={label}
        role="combobox"
        aria-expanded={hits.length > 0}
        aria-controls={`${id}-list`}
        className="pl-9"
        placeholder="Name, SKU, product code, barcode or EAN…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
          else if (e.key === 'Enter' && hits[active]) { e.preventDefault(); choose(hits[active]) }
          else if (e.key === 'Escape') setFound({ term: '', hits: [] })
        }}
      />
      {loading && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
      {!loading && !error && found.term === term.trim() && term.trim().length >= 2 && hits.length === 0 && <p className="mt-1 text-xs text-muted-foreground">No product matches “{term.trim()}”.</p>}
      {hits.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-background py-1 shadow-lg">
          {hits.map((h, i) => {
            const disabled = activeOnly && h.status !== 'ACTIVE'
            return (
              <li key={h.product_id} role="option" aria-selected={i === active} aria-disabled={disabled}
                className={`cursor-pointer px-3 py-2 text-sm ${i === active ? 'bg-surface-muted' : ''} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); choose(h) }} onMouseEnter={() => setActive(i)}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate"><span className="font-medium">{h.sku}</span> — {h.product_name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{h.base_unit} · {h.bom_lines} BOM line{h.bom_lines === 1 ? '' : 's'}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  {[h.barcode && `Barcode ${h.barcode}`, h.ean && `EAN ${h.ean}`, h.model_number && `Model ${h.model_number}`, h.status !== 'ACTIVE' && h.status.toLowerCase()].filter(Boolean).join(' · ') || h.product_type.replace(/_/g, ' ').toLowerCase()}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
