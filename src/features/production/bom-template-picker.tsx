import { CopyPlus, Loader2, Replace, Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatQty } from '@/features/inventory/inventory-model'
import { BomStatusBadge } from '@/features/production/production-badges'
import { applyTemplateLines, filledLines, linesFromItems, type EditorLine, type TemplateRef } from '@/features/production/bom-tools-model'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { normalizeSearch } from '@/lib/search'
import { cn } from '@/lib/utils'
import { fetchBom, searchBomTemplates } from '@/services/production'
import type { BomListRow } from '@/types/database-production'

/** A chosen template BOM with its component lines (read once; never edited). */
interface Loaded {
  bom: BomListRow
  lines: EditorLine[]
}

/**
 * "Add Components from Existing BOM" for one Generate Multiple product. Searches saved, non-archived BOMs of the company (BOM
 * number, finished product name or SKU — any part of any word), reads the chosen BOM's component lines and copies them into this
 * product's own editable list: Replace (the template's components only) or Add (missing components appended). The copies are
 * independent: editing them never changes the template, which is only read. Clearing the template reference keeps the components.
 */
export function BomTemplateSection({ idPrefix, label, lines, output, outputUnit, template, onApply, onClearReference }: {
  idPrefix: string
  /** e.g. "product 2" (for accessible names). */
  label: string
  lines: EditorLine[]
  output: string
  outputUnit: string
  template: TemplateRef | null
  onApply: (lines: EditorLine[], template: TemplateRef) => void
  onClearReference: () => void
}) {
  const listId = `${useId()}-list`
  const [text, setText] = useState('')
  const term = useDebouncedValue(normalizeSearch(text), 250)
  const [open, setOpen] = useState(false)
  const [found, setFound] = useState<{ term: string; rows: BomListRow[] }>({ term: '', rows: [] })
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [active, setActive] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!term) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      setSearching(true)
      setSearchError(null)
      return searchBomTemplates(term, 20).then(
        (rows) => { if (!cancelled) { setFound({ term, rows }); setActive(0) } },
        (e: unknown) => { if (!cancelled) setSearchError(describeDataError(e)) },
      ).finally(() => { if (!cancelled) setSearching(false) })
    })
    return () => { cancelled = true }
  }, [term, attempt])

  const choose = async (bom: BomListRow) => {
    setOpen(false)
    setText('')
    setNotice(null)
    setLoadError(null)
    setLoaded(null)
    setLoadingId(bom.id)
    try {
      // The template's component lines, read through the existing BOM views (row-level security applies). Read only.
      const { items } = await fetchBom(bom.id)
      setLoaded({ bom, lines: linesFromItems(items) })
    } catch (e) {
      setLoadError(describeDataError(e))
    } finally {
      setLoadingId(null)
    }
  }

  const apply = (mode: 'replace' | 'add') => {
    if (!loaded) return
    const r = applyTemplateLines(lines, loaded.lines, mode)
    const b = loaded.bom
    onApply(r.lines, { bom_id: b.id, bom_code: b.bom_code, version: b.version, sku: b.sku, product_name: b.product_name, components: loaded.lines.length })
    const scale = Number(b.output_quantity) !== Number(output)
      ? ` Quantities are copied as in ${b.bom_code} (per ${formatQty(b.output_quantity, b.output_unit)}); this product's output is ${output || '?'} ${outputUnit}.` : ''
    setNotice(mode === 'replace'
      ? `${loaded.lines.length} components copied from ${b.bom_code} v${b.version}.${scale}`
      : `${loaded.lines.length - r.skipped.length} components added from ${b.bom_code} v${b.version}${r.skipped.length ? `; already in the list: ${r.skipped.join(', ')}` : ''}.${scale}`)
    setLoaded(null)
  }

  const current = found.term === term && term !== ''
  const shown = current ? found.rows : []
  const filled = filledLines(lines).length
  return (
    <section className="mt-4 rounded-lg border border-dashed p-3" aria-labelledby={`${idPrefix}-tpl-title`} data-testid={`${idPrefix}-tpl`}>
      <h4 id={`${idPrefix}-tpl-title`} className="text-sm font-medium">Add Components from Existing BOM</h4>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Copy the components of a saved BOM into this product. The copies can be changed freely here; the chosen BOM is only read and never changed.
      </p>

      {template && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-muted/60 px-3 py-1.5 text-sm" data-testid={`${idPrefix}-tpl-ref`}>
          <span>Components copied from <span className="font-medium">{template.bom_code} v{template.version}</span> — {template.sku} {template.product_name}</span>
          <button type="button" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline" onClick={() => { onClearReference(); setNotice(null) }}
            aria-label={`Remove template reference for ${label} (keeps the components)`} data-testid={`${idPrefix}-tpl-clear`}>
            <X className="size-3.5" /> Remove reference (keeps components)
          </button>
        </div>
      )}

      <div className="mt-2 max-w-xl space-y-1">
        <Label htmlFor={`${idPrefix}-tpl-search`}>Search existing BOM</Label>
        <div className="relative">
          {searching ? <Loader2 aria-label="Searching" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            : <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />}
          <Input
            id={`${idPrefix}-tpl-search`}
            ref={inputRef}
            role="combobox"
            aria-expanded={open && text.trim() !== ''}
            aria-controls={listId}
            aria-autocomplete="list"
            autoComplete="off"
            maxLength={200}
            className="pl-9"
            placeholder="BOM number, finished product name or SKU"
            value={text}
            onChange={(e) => { setText(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(0, shown.length - 1))) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
              else if (e.key === 'Escape') { if (text) { e.preventDefault(); setText('') } setOpen(false) }
              else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) void choose(shown[active]) }
            }}
          />
        </div>
        {open && text.trim() !== '' && (
          <ul id={listId} role="listbox" aria-label={`Existing BOMs for ${label}`} className="max-h-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-sm" data-testid={`${idPrefix}-tpl-list`}>
            {(searching || !current) && !searchError && (
              <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Searching saved BOMs…</li>
            )}
            {searchError && (
              <li role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-shortage">
                BOMs could not be loaded: {searchError}
                <button type="button" className="font-medium text-primary hover:underline" onMouseDown={(e) => { e.preventDefault(); setAttempt((n) => n + 1) }}>Retry</button>
              </li>
            )}
            {!searching && !searchError && current && shown.length === 0 && (
              <li className="px-3 py-2 text-sm text-muted-foreground" data-testid={`${idPrefix}-tpl-empty`}>No saved BOM matches “{term}”. Every word must appear in the BOM number, product name or SKU.</li>
            )}
            {!searchError && shown.map((b, i) => (
              <li key={b.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); void choose(b) }}
                className={cn('cursor-pointer rounded-md px-3 py-1.5 text-sm', i === active && 'bg-muted')}>
                <span className="flex flex-wrap items-center gap-2"><span className="font-medium">{b.bom_code} v{b.version}</span><BomStatusBadge status={b.status} /></span>
                <span className="block text-xs text-muted-foreground">{b.product_name} · SKU {b.sku} · {b.item_count} components</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {loadingId && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid={`${idPrefix}-tpl-loading`}><Loader2 className="size-4 animate-spin" /> Reading the BOM’s components…</p>}
      {loadError && <p role="alert" className="mt-3 text-sm text-shortage">The BOM’s components could not be read: {loadError}</p>}

      {loaded && (
        <div className="mt-3 rounded-md border p-3" data-testid={`${idPrefix}-tpl-preview`}>
          <p className="text-sm"><span className="font-medium">{loaded.bom.bom_code} v{loaded.bom.version}</span> — {loaded.bom.sku} {loaded.bom.product_name}
            <span className="text-muted-foreground"> · {loaded.lines.length} components per {formatQty(loaded.bom.output_quantity, loaded.bom.output_unit)}</span></p>
          {loaded.lines.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">This BOM has no components to copy.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {loaded.lines.map((l) => <li key={l.key}>{l.product!.sku} {l.product!.product_name} × {l.quantity} {l.product!.base_unit}{Number(l.wastage) ? ` (+${l.wastage}% wastage)` : ''}{l.notes ? ` — ${l.notes}` : ''}</li>)}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={loaded.lines.length === 0} onClick={() => apply('replace')} data-testid={`${idPrefix}-tpl-replace`}>
              <Replace /> {filled ? `Replace the ${filled} components` : 'Use these components'}
            </Button>
            {filled > 0 && (
              <Button type="button" size="sm" variant="outline" disabled={loaded.lines.length === 0} onClick={() => apply('add')} data-testid={`${idPrefix}-tpl-add`}>
                <CopyPlus /> Add to the components
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={() => { setLoaded(null); inputRef.current?.focus() }}>Cancel</Button>
          </div>
        </div>
      )}
      {notice && <p role="status" className="mt-2 text-xs text-muted-foreground" data-testid={`${idPrefix}-tpl-notice`}>{notice}</p>}
    </section>
  )
}
