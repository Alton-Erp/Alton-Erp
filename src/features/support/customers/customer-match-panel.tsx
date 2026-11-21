import { ExternalLink, Loader2, UserPlus, Users } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { lookupKeys } from '@/features/support/customers/customer-model'
import { useAsync } from '@/hooks/use-async'
import { lookupCustomers } from '@/services/customer-crm'

/**
 * Customers matching the phone / email typed on New Ticket (normalised on the server; current company only).
 * Nothing is chosen automatically: one match is offered, several are all listed for the agent to choose, none offers
 * "Create new customer" (or the ticket continues with just the phone / email, as before).
 */
export function CustomerMatchPanel({ phone, email, onPick, onCreate }: {
  phone: string; email: string; onPick: (c: { id: string; label: string }) => void; onCreate: () => void
}) {
  const [keys, setKeys] = useState<ReturnType<typeof lookupKeys>>(null)
  useEffect(() => { const t = setTimeout(() => setKeys(lookupKeys(phone, email)), 350); return () => clearTimeout(t) }, [phone, email])
  const q = useAsync(() => (keys ? lookupCustomers(keys.phone, keys.email).catch(() => null) : Promise.resolve(null)), [keys?.phone, keys?.email])
  if (!keys) return null
  if (q.loading && !q.data) return <p className="flex items-center gap-1.5 text-xs text-muted-foreground sm:col-span-2"><Loader2 className="size-3 animate-spin" />Looking for matching customers…</p>
  if (!q.data) return null
  const list = q.data
  return (
    <div className="rounded-md border bg-surface-muted/40 p-3 text-sm sm:col-span-2" data-testid="customer-matches" role="region" aria-label="Matching customers">
      {list.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">No customer has this phone number or email.</span>
          <Button type="button" size="sm" variant="outline" onClick={onCreate} data-testid="create-customer-from-ticket"><UserPlus /> Create new customer</Button>
          <span className="text-xs text-muted-foreground">or continue without a customer (the ticket keeps the phone / email).</span>
        </div>
      ) : (
        <>
          <p className="mb-2 flex items-center gap-1.5 font-medium"><Users className="size-4" />
            {list.length === 1 ? 'A customer has this phone number or email:' : `${list.length} customers match — choose the right one (records are never merged or chosen automatically):`}</p>
          <ul className="space-y-1.5">
            {list.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2" data-testid={`match-${c.customer_code}`}>
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{c.display_name}</span> <span className="text-xs text-muted-foreground">{c.customer_code}{c.company_name ? ` · ${c.company_name}` : ''}</span>
                  <span className="block truncate text-xs text-muted-foreground">{[c.mobile, c.alternate_phone, c.landline, c.email].filter(Boolean).join(' · ')}
                    {c.open_tickets > 0 && ` · ${c.open_tickets} open ticket${c.open_tickets === 1 ? '' : 's'}`}</span>
                  <span className="mt-0.5 flex flex-wrap gap-1">{c.matched_on.map((m) => <span key={m} className="rounded bg-primary/10 px-1.5 text-[11px] text-primary">matched: {m}</span>)}</span>
                </span>
                <a className="inline-flex items-center gap-0.5 text-xs text-primary hover:underline" href={`/support/customers/${c.id}`} target="_blank" rel="noreferrer">Open profile<ExternalLink className="size-3" /></a>
                <Button type="button" size="sm" onClick={() => onPick({ id: c.id, label: `${c.display_name} (${c.customer_code})` })} data-testid={`use-${c.customer_code}`}>Use this customer</Button>
              </li>
            ))}
          </ul>
          <Button type="button" size="sm" variant="ghost" className="mt-1" onClick={onCreate}><UserPlus /> None of these — create a new customer</Button>
        </>
      )}
    </div>
  )
}
