import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ProductionOrderListRow } from '@/types/database-production'

/** Picker for orders in production (the only ones that accept issues and output). */
export function RunningOrderSelect({ orders, value, onChange, loading }: {
  orders: ProductionOrderListRow[]
  value: string
  onChange: (id: string) => void
  loading?: boolean
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Production order" className="w-80"><SelectValue placeholder={loading ? 'Loading orders…' : 'Select an order in production'} /></SelectTrigger>
      <SelectContent className="max-h-72">
        {orders.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No orders are in production. Start an approved order first.</div>}
        {orders.map((o) => (
          <SelectItem key={o.id} value={o.id}>{o.production_order_number} — {o.sku} ({o.status === 'IN_PROGRESS' ? 'in progress' : 'partially completed'})</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
