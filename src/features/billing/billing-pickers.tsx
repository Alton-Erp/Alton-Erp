import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAsync } from '@/hooks/use-async'
import { fetchCustomers } from '@/services/customer-po'

/** Customer selector for billing pages ("all" = no filter when allowAll). */
export function CustomerSelect({ id, value, onChange, allowAll = false, activeOnly = false, className = 'w-60', placeholder = 'Select a customer' }: {
  id?: string
  value: string
  onChange: (v: string) => void
  allowAll?: boolean
  activeOnly?: boolean
  className?: string
  placeholder?: string
}) {
  const customers = useAsync(() => fetchCustomers(!activeOnly), [activeOnly])
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label={id ? undefined : 'Customer'} className={className}><SelectValue placeholder={customers.loading ? 'Loading customers…' : placeholder} /></SelectTrigger>
      <SelectContent className="max-h-72">
        {allowAll && <SelectItem value="all">All customers</SelectItem>}
        {(customers.data ?? []).length === 0 && !customers.loading && <div className="px-3 py-2 text-sm text-muted-foreground">No customers.</div>}
        {(customers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.legal_name ?? c.customer_name}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}
