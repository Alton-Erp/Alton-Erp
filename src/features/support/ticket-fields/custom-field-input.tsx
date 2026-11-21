import { Calculator, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { displayValue, type FieldDefinition, type InputValue, type LookupTarget } from '@/features/support/ticket-fields/field-model'
import { useAsync } from '@/hooks/use-async'
import { fetchUserOptions, searchLookup } from '@/services/ticket-fields'

type Def = Pick<FieldDefinition, 'field_key' | 'field_label' | 'field_type' | 'field_config' | 'placeholder'>

/** The input for one custom field. Formula fields show their calculated result (read-only). */
export function CustomFieldInput({ def, value, onChange, id, invalid, formulaInputs }: {
  def: Def; value: InputValue; onChange: (v: InputValue) => void; id: string; invalid?: boolean; formulaInputs: Record<string, unknown>
}) {
  const c = def.field_config ?? {}
  const text = typeof value === 'string' ? value : ''
  const common = { id, 'aria-invalid': invalid || undefined, placeholder: def.placeholder ?? undefined, 'data-field': def.field_key }
  switch (def.field_type) {
    case 'PICKLIST': {
      const picked = value && typeof value === 'object' ? value.id : typeof value === 'string' ? value : ''
      return (
        <Select value={picked || '__none'} onValueChange={(v) => onChange(v === '__none' ? null : { id: v, label: c.options?.find((o) => o.id === v)?.label ?? v })}>
          <SelectTrigger id={id} aria-invalid={invalid || undefined} data-field={def.field_key} className="w-full"><SelectValue placeholder={def.placeholder ?? 'Choose…'} /></SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value="__none">{def.placeholder ?? 'Not chosen'}</SelectItem>
            {(c.options ?? []).map((o) => <SelectItem key={o.id} value={o.id!}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )
    }
    case 'TEXT':
      return <Input {...common} value={text} onChange={(e) => onChange(e.target.value)} maxLength={c.max_length ?? 255} />
    case 'NUMBER':
      return <Input {...common} value={text} onChange={(e) => onChange(e.target.value)} inputMode={c.number_kind === 'INTEGER' ? 'numeric' : 'decimal'} />
    case 'CURRENCY':
      return (
        <div className="flex items-center rounded-md border focus-within:ring-2 focus-within:ring-ring/50" data-invalid={invalid || undefined}>
          <span className="border-r bg-muted/50 px-2.5 py-2 text-xs font-medium text-muted-foreground">{c.currency ?? 'INR'}</span>
          <input {...common} className="h-9 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none" value={text} onChange={(e) => onChange(e.target.value)} inputMode="decimal" />
        </div>
      )
    case 'DATE':
      return <Input {...common} type="date" value={text} onChange={(e) => onChange(e.target.value)} />
    case 'EMAIL':
      return <Input {...common} type="email" value={text} onChange={(e) => onChange(e.target.value)} inputMode="email" autoComplete="off" />
    case 'PHONE':
      return <Input {...common} type="tel" value={text} onChange={(e) => onChange(e.target.value)} inputMode="tel" autoComplete="off" />
    case 'URL':
      return <Input {...common} type="url" value={text} onChange={(e) => onChange(e.target.value)} inputMode="url" placeholder={def.placeholder ?? 'https://'} />
    case 'CHECKBOX':
      return (
        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox id={id} data-field={def.field_key} checked={value === true} onCheckedChange={(v) => onChange(v === true)} />{def.placeholder ?? 'Yes'}
        </label>
      )
    case 'USER':
      return <UserInput id={id} scope={c.scope ?? 'EMPLOYEES'} value={value && typeof value === 'object' ? value : null} onChange={onChange} invalid={invalid} field={def.field_key} />
    case 'LOOKUP':
      return <LookupInput id={id} target={c.target ?? 'SUPPORT_TICKET'} value={value && typeof value === 'object' ? value : null} onChange={onChange} invalid={invalid} field={def.field_key} />
    case 'FORMULA':
      return (
        <div className="flex h-9 items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm tabular-nums" id={id} data-field={def.field_key} aria-live="polite">
          <Calculator className="size-3.5 text-muted-foreground" />{displayValue(def, null, formulaInputs)}
        </div>
      )
  }
}

function UserInput({ id, scope, value, onChange, invalid, field }: {
  id: string; scope: 'EMPLOYEES' | 'AGENTS'; value: { id: string; label: string } | null; onChange: (v: InputValue) => void; invalid?: boolean; field: string
}) {
  const users = useAsync(() => fetchUserOptions(scope).catch(() => []), [scope])
  const list = users.data ?? []
  return (
    <Select value={value?.id ?? '__none'} onValueChange={(v) => onChange(v === '__none' ? null : { id: v, label: list.find((u) => u.id === v)?.name ?? '' })}>
      <SelectTrigger id={id} aria-invalid={invalid || undefined} data-field={field} className="w-full"><SelectValue placeholder="Choose…" /></SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value="__none">Nobody</SelectItem>
        {value && !list.some((u) => u.id === value.id) && <SelectItem value={value.id}>{value.label}</SelectItem>}
        {list.map((u) => <SelectItem key={u.id} value={u.id}>{u.name}{u.is_agent ? ' · agent' : ''}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

/** Searches the linked ERP records on the server as the user types. */
function LookupInput({ id, target, value, onChange, invalid, field }: {
  id: string; target: LookupTarget; value: { id: string; label: string } | null; onChange: (v: InputValue) => void; invalid?: boolean; field: string
}) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => { const t = setTimeout(() => setDebounced(term.trim()), 250); return () => clearTimeout(t) }, [term])
  const results = useAsync(() => (debounced.length >= 1 ? searchLookup(target, debounced) : Promise.resolve(null)), [target, debounced])
  if (value) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm" data-field={field} id={id}>
        <span className="truncate">{value.label}</span>
        <Button type="button" size="icon" variant="ghost" className="size-6" aria-label="Clear" onClick={() => onChange(null)}><X className="size-3.5" /></Button>
      </div>
    )
  }
  return (
    <div className="relative">
      <Input id={id} data-field={field} aria-invalid={invalid || undefined} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search…" autoComplete="off" />
      {debounced && (results.data || results.error) && (
        <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover text-sm shadow-md">
          {results.error && <li className="px-3 py-2 text-red-700">You cannot search these records.</li>}
          {results.data?.length === 0 && <li className="px-3 py-2 text-muted-foreground">Nothing found.</li>}
          {results.data?.map((r) => (
            <li key={r.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-muted" onClick={() => { onChange({ id: r.id, label: r.label }); setTerm('') }}>{r.label}</button></li>
          ))}
        </ul>
      )}
    </div>
  )
}
