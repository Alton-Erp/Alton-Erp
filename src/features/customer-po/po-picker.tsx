import { ClipboardList } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PoStatusBadge } from '@/features/customer-po/po-badges'
import type { usePoSelection } from '@/features/customer-po/use-po-selection'
import { formatDate } from '@/lib/format'
import type { CustomerPoListRow } from '@/types/database-customer-po'

export function PoSelector({ options, value, onChange, loading }: { options: CustomerPoListRow[]; value: string; onChange: (id: string) => void; loading?: boolean }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label="Customer PO" className="w-[26rem] max-w-full"><SelectValue placeholder={loading ? 'Loading POs…' : 'Select a customer PO'} /></SelectTrigger>
      <SelectContent className="max-h-80">
        {options.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No customer POs yet. Upload one first.</div>}
        {options.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.customer_po_number}{p.revision > 1 ? ` (rev ${p.revision})` : ''} · {p.customer_name_snapshot} · {p.po_reference}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Header strip: PO selector + summary of the chosen PO. */
export function PoContextBar({ selection, children }: { selection: ReturnType<typeof usePoSelection>; children?: ReactNode }) {
  const po = selection.selected
  return (
    <Card className="mb-6">
      <CardContent className="flex flex-wrap items-center gap-3 p-4">
        <PoSelector options={selection.options} value={selection.poId} onChange={selection.select} loading={selection.loading} />
        {po && (
          <>
            <PoStatusBadge status={po.status} />
            <span className="text-sm text-muted-foreground">
              PO date {formatDate(po.po_date)}{po.required_delivery_date ? ` · deliver by ${formatDate(po.required_delivery_date)}` : ''}
              {po.fulfilment_warehouse_code ? ` · from ${po.fulfilment_warehouse_code}` : ' · all warehouses'}
            </span>
            <Link className="text-sm text-primary underline-offset-2 hover:underline" to={`/customer-pos/${po.id}`}>Open PO</Link>
          </>
        )}
        <div className="ml-auto flex flex-wrap gap-2">{children}</div>
      </CardContent>
    </Card>
  )
}

export function NoPoSelected() {
  return (
    <Card>
      <EmptyState icon={ClipboardList} title="Select a customer PO" description="Choose a PO above, or upload a new customer PO first." />
    </Card>
  )
}
