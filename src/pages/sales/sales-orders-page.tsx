import { AlertTriangle, Plus, Search, ShoppingCart, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { OrderFulfilmentBadge, SalesOrderStatusBadge } from '@/features/sales/sales-badges'
import { PRIORITY_LABELS } from '@/features/sales/sales-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchCustomers } from '@/services/customer-po'
import { fetchOrdersPage, type OrderStatusFilter } from '@/services/sales'
import type { SalesOrderListRow } from '@/types/database-sales'

type Tab = 'ALL' | 'OPEN' | 'NEEDS_ACTION' | 'FULFILLED' | 'CANCELLED'

export default function SalesOrdersPage() {
  const { has } = usePermissions()
  const [tab, setTab] = useState<Tab>('OPEN')
  const [customer, setCustomer] = useState('all')
  const [source, setSource] = useState('all')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const customers = useAsync(() => (has('customers.read') || has('customer_po.read') ? fetchCustomers(true) : Promise.resolve([])), [])
  const status: OrderStatusFilter = tab === 'ALL' ? null : tab
  const list = useAsync(() => fetchOrdersPage({
    search, status, customerId: customer === 'all' ? null : customer, source: source === 'all' ? null : (source as 'CUSTOMER_PO' | 'MANUAL'), from: null, to: null,
  }, page, pageSize), [search, tab, customer, source, page, pageSize])
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0) }

  const columns: DataTableColumn<SalesOrderListRow>[] = [
    { id: 'number', header: 'Sales order', cell: (o) => (
      <span><Link className="font-medium text-primary hover:underline" to={`/sales/orders/${o.id}`}>{o.sales_order_number}</Link>
        <span className="block text-xs text-muted-foreground">{formatDate(o.order_date)}</span></span>
    ) },
    { id: 'customer', header: 'Customer', cell: (o) => <span>{o.customer_name_snapshot}{o.customer_code && <span className="block text-xs text-muted-foreground">{o.customer_code}</span>}</span> },
    { id: 'source', header: 'Source', cell: (o) => (o.source === 'CUSTOMER_PO'
      ? <span className="text-xs">PO {o.customer_po_number}<span className="block text-muted-foreground">{o.source_po_reference}</span></span>
      : <span className="text-xs">Manual{o.customer_po_number ? ` · PO ${o.customer_po_number}` : ''}</span>) },
    { id: 'status', header: 'Order status', cell: (o) => (
      <span className="inline-flex flex-col gap-1"><SalesOrderStatusBadge status={o.order_status} />{o.has_exception && <span className="inline-flex items-center gap-1 text-xs text-amber-800"><AlertTriangle className="size-3" /> exception</span>}</span>
    ) },
    { id: 'fulfilment', header: 'Dispatch / delivery', cell: (o) => <OrderFulfilmentBadge status={o.fulfilment_status} /> },
    { id: 'qty', header: 'Ordered · dispatched · remaining', cell: (o) => (
      <span className="text-xs tabular-nums">{(o.unit_totals ?? []).map((u) => (
        <span key={u.unit} className="block">{formatQty(Number(u.ordered) - Number(u.cancelled))} · {formatQty(u.dispatched)} · <span className={Number(u.remaining) > 0 ? 'font-medium' : ''}>{formatQty(u.remaining)}</span> {u.unit}</span>
      ))}</span>
    ) },
    { id: 'due', header: 'Requested', cell: (o) => (o.requested_delivery_date ? formatDate(o.requested_delivery_date) : '—') },
    { id: 'priority', header: 'Priority', cell: (o) => <span className={o.priority === 'URGENT' || o.priority === 'HIGH' ? 'font-medium text-amber-800' : ''}>{PRIORITY_LABELS[o.priority]}</span> },
  ]

  return (
    <>
      <PageHeader actions={
        <>
          {has('sales_orders.create') && <Button variant="outline" asChild><Link to="/sales/orders/import"><Upload /> Import from Excel</Link></Button>}
          {has('sales_orders.create') && <Button asChild><Link to="/sales/orders/new"><Plus /> New sales order</Link></Button>}
        </>
      } />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <FilterTabs<Tab> label="Order status" value={tab} onChange={reset(setTab)} options={[
            { value: 'OPEN', label: 'Open' }, { value: 'NEEDS_ACTION', label: 'Awaiting confirmation / on hold' }, { value: 'FULFILLED', label: 'Fulfilled' },
            { value: 'CANCELLED', label: 'Cancelled' }, { value: 'ALL', label: 'All' },
          ]} />
          <div className="relative w-64">
            <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search orders" className="pl-9" placeholder="SO no., customer or PO no." value={term} onChange={(e) => { setTerm(e.target.value); setPage(0) }} />
          </div>
          <Select value={customer} onValueChange={reset(setCustomer)}>
            <SelectTrigger aria-label="Customer" className="w-52"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All customers</SelectItem>{(customers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.customer_code} — {c.customer_name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={source} onValueChange={reset(setSource)}>
            <SelectTrigger aria-label="Source" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All sources</SelectItem><SelectItem value="CUSTOMER_PO">From customer PO</SelectItem><SelectItem value="MANUAL">Manual</SelectItem></SelectContent>
          </Select>
        </CardContent>
      </Card>
      <div>
        <DataTable className="rounded-b-none" columns={columns} data={list.data?.rows ?? []} getRowId={(o) => o.id} loading={list.loading} searchable={false} pageSize={pageSize}
          error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
          emptyState={{ icon: ShoppingCart, title: list.data?.total === 0 && !search && tab === 'ALL' ? 'No sales orders yet' : 'No orders match these filters',
            description: 'Create a sales order or import orders from Excel. Orders are never created automatically.' }} />
        <Card className="rounded-t-none border-t-0">
          <PaginationBar page={page} pageSize={pageSize} total={list.data?.total ?? 0} onPageChange={setPage} onPageSizeChange={(s) => { setPageSize(s); setPage(0) }} disabled={list.loading} />
        </Card>
      </div>
    </>
  )
}
