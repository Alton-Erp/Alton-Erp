import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAsync } from '@/hooks/use-async'
import { fetchCustomers } from '@/services/support'

/** Customer search box backed by the server (name, code, phone, email). */
export function CustomerPicker({ value, onChange, id }: { value: { id: string; label: string } | null; onChange: (v: { id: string; label: string } | null) => void; id?: string }) {
  const [term, setTerm] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => { const t = setTimeout(() => setDebounced(term), 250); return () => clearTimeout(t) }, [term])
  const results = useAsync(() => (debounced.trim().length >= 2 ? fetchCustomers(debounced, 8, 0) : Promise.resolve(null)), [debounced])
  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm" data-testid="customer-picked">
        <span className="truncate">{value.label}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <Input id={id} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search name, code, phone or email" autoComplete="off" />
      {results.data && (
        <ul className="max-h-48 overflow-auto rounded-md border text-sm">
          {results.data.rows.length === 0 && <li className="px-3 py-2 text-muted-foreground">No customer found.</li>}
          {results.data.rows.map((c) => (
            <li key={c.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-muted"
              onClick={() => onChange({ id: c.id, label: `${c.display_name} (${c.customer_code})` })}>
              <span className="font-medium">{c.display_name}</span> <span className="text-xs text-muted-foreground">{c.customer_code} · {[...c.phones, ...c.emails].join(', ')}</span>
            </button></li>
          ))}
        </ul>
      )}
    </div>
  )
}
