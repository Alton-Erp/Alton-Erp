import { Check, ChevronsUpDown, Loader2, Plus, Search } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { describeProductError } from '@/lib/errors'
import { cn } from '@/lib/utils'
import { quickCreateCategory } from '@/services/products'
import type { ProductCategoryRow } from '@/types/database'

type Option = { kind: 'none' } | { kind: 'category'; category: ProductCategoryRow } | { kind: 'add' }

/**
 * Searchable category selector with "+ Add New Category". Keyboard: type to
 * filter, ↑/↓ to move, Enter to choose, Esc to close.
 */
export function CategoryPicker({
  id,
  value,
  categories,
  onChange,
  canAdd,
  onAddRequest,
}: {
  id?: string
  value: string
  /** Categories that may be chosen (inactive ones only when already assigned). */
  categories: ProductCategoryRow[]
  onChange: (categoryId: string) => void
  canAdd: boolean
  onAddRequest: (typedName: string) => void
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const selected = categories.find((c) => c.id === value) ?? null

  const options = useMemo<Option[]>(() => {
    const t = term.trim().toLowerCase()
    const matches = categories
      .filter((c) => !t || c.name.toLowerCase().includes(t) || c.code.toLowerCase().includes(t))
      .map((c) => ({ kind: 'category' as const, category: c }))
    return [...(t ? [] : [{ kind: 'none' as const }]), ...matches, ...(canAdd ? [{ kind: 'add' as const }] : [])]
  }, [categories, term, canAdd])

  const choose = (o: Option) => {
    if (o.kind === 'add') {
      setOpen(false)
      onAddRequest(term.trim())
    } else {
      onChange(o.kind === 'none' ? '' : o.category.id)
      setOpen(false)
    }
    setTerm('')
  }

  const move = (delta: number) => {
    const next = Math.max(0, Math.min(options.length - 1, active + delta))
    setActive(next)
    listRef.current?.querySelectorAll('[role="option"]')[next]?.scrollIntoView({ block: 'nearest' })
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setTerm(''); setActive(0) }}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-left text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? `${selected.name}${selected.is_active ? '' : ' (inactive)'}` : 'No category'}
          </span>
          <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64 p-1">
        <div className="relative mb-1">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            aria-label="Search categories"
            aria-controls={listId}
            aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
            placeholder="Search categories…"
            className="h-8 pl-8"
            value={term}
            onChange={(e) => { setTerm(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
              else if (e.key === 'Enter') { e.preventDefault(); const o = options[active]; if (o) choose(o) }
            }}
          />
        </div>
        <ul id={listId} ref={listRef} role="listbox" aria-label="Categories" className="max-h-64 overflow-y-auto">
          {options.map((o, i) => {
            const isSelected = o.kind === 'category' ? o.category.id === value : o.kind === 'none' ? !value : false
            return (
              <li
                key={o.kind === 'category' ? o.category.id : o.kind}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(o) }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm',
                  i === active && 'bg-muted',
                  o.kind === 'add' && 'mt-1 border-t pt-2 font-medium text-primary',
                )}
              >
                {o.kind === 'add' ? (
                  <><Plus aria-hidden className="size-3.5" /> Add New Category{term.trim() ? ` “${term.trim()}”` : ''}</>
                ) : o.kind === 'none' ? (
                  <><Check aria-hidden className={cn('size-3.5', !isSelected && 'invisible')} /> <span className="text-muted-foreground">No category</span></>
                ) : (
                  <><Check aria-hidden className={cn('size-3.5', !isSelected && 'invisible')} />
                    <span className="truncate">{o.category.name}{!o.category.is_active && ' (inactive)'}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{o.category.code}</span></>
                )}
              </li>
            )
          })}
          {options.every((o) => o.kind === 'add') && <li className="px-2.5 py-1.5 text-sm text-muted-foreground">No matching category.</li>}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** Small dialog that saves a category to the product category master. */
export function AddCategoryDialog({
  companyId,
  initialName,
  categories,
  onClose,
  onCreated,
}: {
  companyId: string
  initialName: string
  /** Every category of the company (active and inactive), for the duplicate check. */
  categories: ProductCategoryRow[]
  onClose: () => void
  onCreated: (category: ProductCategoryRow) => void
}) {
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const trimmed = name.trim().replace(/\s+/g, ' ')
    if (!trimmed) return setError('Enter the category name.')
    if (trimmed.length > 100) return setError('Keep the category name under 100 characters.')
    if (description.trim().length > 500) return setError('Keep the description under 500 characters.')
    const existing = categories.find((c) => c.name.trim().toLowerCase() === trimmed.toLowerCase())
    if (existing) {
      return setError(`A category named “${existing.name}” already exists${existing.is_active ? '' : ' (inactive — activate it under Product Categories)'}.`)
    }
    setBusy(true)
    setError(null)
    try {
      const created = await quickCreateCategory(companyId, categories.map((c) => c.code), { name: trimmed, description: description.trim() || null })
      onCreated(created)
    } catch (e) {
      setError(describeProductError(e))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add New Category</DialogTitle>
          <DialogDescription>Saved to the product category master and selected on this product. Names are unique within your company.</DialogDescription>
        </DialogHeader>
        <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save() }}>
          {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
          <div className="space-y-1.5">
            <Label htmlFor="new-cat-name">Category Name</Label>
            <Input id="new-cat-name" autoFocus maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(error) && !name.trim()} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-cat-desc">Description (optional)</Label>
            <Textarea id="new-cat-desc" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Save category</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
