import { CornerDownLeft, FileText, Loader2, Search } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'

import { getNavGroupLabel } from '@/config/navigation'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useVisibleNavItems } from '@/hooks/use-visible-nav'
import { cn } from '@/lib/utils'
import { globalSearch, type SearchResult } from '@/services/management'

interface Entry { key: string; title: string; subtitle: string; path: string; icon: ComponentType<{ className?: string }>; kind: 'record' | 'module' }

/**
 * Global search: records (products and SKUs, HSN codes, customers, suppliers and
 * PO / GRN / production order / sales order / invoice numbers; partial and
 * case-insensitive) and modules. Choosing a result opens it.
 */
export function GlobalSearch({ className }: { className?: string }) {
  const navigate = useNavigate()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const navItems = useVisibleNavItems()
  const term = useDebouncedValue(query.trim(), 250)
  const found = useAsync(() => (term.length >= 2 ? globalSearch(term).catch(() => [] as SearchResult[]) : Promise.resolve([] as SearchResult[])), [term])
  const records = useMemo(() => found.data ?? [], [found.data])
  const searching = found.loading || term !== query.trim()

  const modules = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return navItems.slice(0, 6)
    return navItems.filter((item) => [item.title, item.description, ...(item.keywords ?? [])].some((text) => text.toLowerCase().includes(q))).slice(0, 6)
  }, [query, navItems])

  const entries: Entry[] = useMemo(() => [
    ...(query.trim().length >= 2 ? records : []).map((r) => ({ key: `r-${r.module}-${r.id}`, title: `${r.reference} — ${r.title}`, subtitle: [r.module, r.subtitle].filter(Boolean).join(' · '), path: r.link, icon: FileText, kind: 'record' as const })),
    ...modules.map((m) => ({ key: `m-${m.key}`, title: m.title, subtitle: getNavGroupLabel(m.group), path: m.path, icon: m.icon, kind: 'module' as const })),
  ], [records, modules, query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const go = (index: number) => {
    const item = entries[index]
    if (!item) return
    navigate(item.path)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }
  const firstModule = entries.findIndex((e) => e.kind === 'module')

  return (
    <div className={cn('relative w-full max-w-md', className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && entries[activeIndex] ? `${listId}-${entries[activeIndex].key}` : undefined}
        aria-label="Search records and modules"
        placeholder="Search SKU, customer, PO, invoice…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, entries.length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); go(activeIndex) }
          else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
        }}
        className="h-9 w-full rounded-lg border bg-surface-muted/60 pr-14 pl-9 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-[3px] focus:ring-ring/20"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:block">Ctrl K</kbd>

      {open && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-lg border bg-popover shadow-lg">
          <ul id={listId} role="listbox" aria-label="Search results" className="max-h-96 overflow-y-auto p-1">
            {query.trim().length >= 2 && (
              <li role="presentation" className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                Records {searching && <Loader2 className="size-3 animate-spin" />}
              </li>
            )}
            {query.trim().length >= 2 && !searching && records.length === 0 && (
              <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">No records match “{query.trim()}”.</li>
            )}
            {entries.map((item, index) => {
              const Icon = item.icon
              const active = index === activeIndex
              return [
                index === firstModule && (
                  <li key="modules-heading" role="presentation" className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {query.trim() ? 'Modules' : 'Quick links'}
                  </li>
                ),
                <li
                  key={item.key}
                  id={`${listId}-${item.key}`}
                  role="option"
                  aria-selected={active}
                  // mousedown fires before the input's blur closes the list
                  onMouseDown={(e) => { e.preventDefault(); go(index) }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn('flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2', active ? 'bg-muted' : 'hover:bg-muted')}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"><Icon className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>
                  </span>
                  {active && <CornerDownLeft aria-hidden className="size-3.5 text-muted-foreground" />}
                </li>,
              ]
            })}
            {entries.length === 0 && query.trim().length < 2 && <li role="presentation" className="px-3 py-6 text-center text-sm text-muted-foreground">No modules match “{query.trim()}”.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}
