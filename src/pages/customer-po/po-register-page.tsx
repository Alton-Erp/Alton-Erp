import { ClipboardList, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LINE_DETAIL_EXPORT, REGISTER_EXPORT } from '@/features/customer-po/export-columns'
import { PoStatusBadge } from '@/features/customer-po/po-badges'
import { ExportMenu } from '@/features/customer-po/po-export'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fetchCustomerOptions, fetchPoLines, fetchPos, type PoListFilters } from '@/services/customer-po'
import type { CustomerPoListRow } from '@/types/database-customer-po'

type Filter = 'OPEN' | 'REVIEW' | 'READY_FOR_ALLOCATION' | 'PARTIALLY_ALLOCATED' | 'FULLY_ALLOCATED' | 'FULFILLED' | 'CANCELLED' | 'ALL'

export default function PoRegisterPage() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('OPEN')
  const [customer, setCustomer] = useState('all')
  const [includeRevisions, setIncludeRevisions] = useState(false)
  const customers = useAsync(fetchCustomerOptions, [])
  const query: PoListFilters = { status: filter === 'ALL' ? null : filter, currentOnly: !includeRevisions, customerKey: customer === 'all' ? null : customer }
  const pos = useAsync(() => fetchPos(query), [filter, customer, includeRevisions])
  const ids = new Set((pos.data ?? []).map((p) => p.id))
  const lines = useAsync(() => fetchPoLines({}), [])
  const [today] = useState(() => new Date().toISOString().slice(0, 10))

  const columns: DataTableColumn<CustomerPoListRow>[] = [
    { id: 'po', header: 'Customer PO', cell: (p) => <span className="font-medium">{p.customer_po_number}{p.revision > 1 && <span className="ml-1 text-xs text-muted-foreground">rev {p.revision}</span>}{!p.is_current && <span className="block text-xs text-muted-foreground">superseded</span>}</span>, searchValue: (p) => `${p.customer_po_number} ${p.po_reference}`, sortValue: (p) => p.customer_po_number },
    { id: 'ref', header: 'Reference', cell: (p) => p.po_reference, sortValue: (p) => p.po_reference },
    { id: 'customer', header: 'Customer', cell: (p) => <span>{p.customer_name_snapshot}<span className="block text-xs text-muted-foreground">{p.customer_code ?? 'external reference'}</span></span>, searchValue: (p) => `${p.customer_name_snapshot} ${p.customer_code ?? ''}`, sortValue: (p) => p.customer_name_snapshot },
    { id: 'date', header: 'PO date', cell: (p) => formatDate(p.po_date), sortValue: (p) => p.po_date },
    { id: 'due', header: 'Delivery', cell: (p) => (p.required_delivery_date ? <span className={cn(p.required_delivery_date < today && !['FULFILLED', 'CANCELLED'].includes(p.status) && 'font-medium text-shortage')}>{formatDate(p.required_delivery_date)}</span> : '—'), sortValue: (p) => p.required_delivery_date ?? '9999' },
    { id: 'lines', header: 'Lines', align: 'right', cell: (p) => <span>{p.line_count}{p.unmatched_lines + p.review_lines > 0 && <span className="block text-xs text-amber-800">{p.unmatched_lines + p.review_lines} to review</span>}</span> },
    { id: 'qty', header: 'Ordered / allocated / dispatched', align: 'right', cell: (p) => (
      <span className="text-xs">{(p.unit_totals ?? []).map((u) => <span key={u.unit} className="block">{formatQty(u.ordered)} / {formatQty(u.allocated)} / {formatQty(u.dispatched)} {u.unit}</span>)}</span>
    ) },
    { id: 'wh', header: 'From', cell: (p) => p.fulfilment_warehouse_code ?? 'Any' },
    { id: 'status', header: 'Status', cell: (p) => <PoStatusBadge status={p.status} />, sortValue: (p) => p.status },
  ]

  return (
    <>
      <PageHeader actions={
        <>
          <ExportMenu title="PO register" fileStem="po-register" label="PO register" columns={REGISTER_EXPORT} rows={pos.data ?? []} />
          <ExportMenu title="PO line details" fileStem="po-line-details" label="Line details" columns={LINE_DETAIL_EXPORT} rows={(lines.data ?? []).filter((l) => ids.has(l.purchase_order_id))} />
          <PermissionGate permission="customer_po.import"><Button asChild><Link to="/customer-pos/upload"><Upload /> Upload PO</Link></Button></PermissionGate>
        </>
      } />
      <DataTable
        columns={columns}
        data={pos.data ?? []}
        getRowId={(p) => p.id}
        loading={pos.loading}
        error={pos.error ? new Error(describeDataError(pos.error)) : null}
        onRetry={pos.reload}
        onRowClick={(p) => navigate(`/customer-pos/${p.id}`)}
        pageSize={25}
        searchPlaceholder="Search PO number, reference or customer…"
        toolbar={
          <>
            <FilterTabs<Filter> label="PO status" value={filter} onChange={setFilter} options={[
              { value: 'OPEN', label: 'Open' }, { value: 'REVIEW', label: 'Pending review' }, { value: 'READY_FOR_ALLOCATION', label: 'Ready' },
              { value: 'PARTIALLY_ALLOCATED', label: 'Partially allocated' }, { value: 'FULLY_ALLOCATED', label: 'Fully allocated' },
              { value: 'FULFILLED', label: 'Fulfilled' }, { value: 'CANCELLED', label: 'Cancelled' }, { value: 'ALL', label: 'All' },
            ]} />
            <Select value={customer} onValueChange={setCustomer}>
              <SelectTrigger aria-label="Customer" className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All customers</SelectItem>{(customers.data ?? []).map((c) => <SelectItem key={c.customer_key} value={c.customer_key}>{c.customer_name}</SelectItem>)}</SelectContent>
            </Select>
            <span className="flex items-center gap-2"><Checkbox id="reg-rev" checked={includeRevisions} onCheckedChange={(v) => setIncludeRevisions(v === true)} /><Label htmlFor="reg-rev" className="font-normal">Show superseded revisions</Label></span>
          </>
        }
        emptyState={{ icon: ClipboardList, title: 'No customer POs', description: 'Upload a customer purchase order to start.' }}
      />
    </>
  )
}
