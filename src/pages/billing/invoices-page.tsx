import { FilePlus, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { FilterTabs } from '@/components/common/filter-tabs'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { InvoiceTable } from '@/features/billing/invoice-table'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { fetchInvoicesPage } from '@/services/billing'
import type { InvoiceDisplayStatus } from '@/types/database-billing'
import { useUrlEnum, useUrlPage } from '@/hooks/use-url-state'

type Tab = 'WORK' | 'OPEN' | 'OVERDUE' | 'PAID' | 'CANCELLED' | 'ALL'
const TAB_STATUSES: Record<Tab, InvoiceDisplayStatus[] | null> = {
  WORK: ['DRAFT', 'PENDING_APPROVAL'],
  OPEN: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'],
  OVERDUE: ['OVERDUE'],
  PAID: ['PAID'],
  CANCELLED: ['CANCELLED'],
  ALL: null,
}

const PAGE_KEY = ['page']

export default function InvoicesPage() {
  const { has } = usePermissions()
  // Kept in the address, so Back from a record returns to the same tab.
  const [tab, setTab] = useUrlEnum<Tab>('tab', ['WORK', 'OPEN', 'OVERDUE', 'PAID', 'CANCELLED', 'ALL'], 'WORK', PAGE_KEY)
  const [customer, setCustomer] = useState('all')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [page, setPage] = useUrlPage()
  const [pageSize, setPageSize] = useState(25)
  const list = useAsync(() => fetchInvoicesPage({ search, statuses: TAB_STATUSES[tab], paymentStatus: null, customerId: customer === 'all' ? null : customer, from: null, to: null },
    page, pageSize), [search, tab, customer, page, pageSize])
  return (
    <>
      <PageHeader actions={has('invoices.create') ? <Button asChild><Link to="/billing/invoices/new"><FilePlus /> Create invoice</Link></Button> : undefined} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <FilterTabs<Tab> label="Invoice status" value={tab} onChange={setTab} options={[
            { value: 'WORK', label: 'Drafts & approval' }, { value: 'OPEN', label: 'Open' }, { value: 'OVERDUE', label: 'Overdue' }, { value: 'PAID', label: 'Paid' },
            { value: 'CANCELLED', label: 'Cancelled' }, { value: 'ALL', label: 'All' }]} />
          <div className="relative w-64"><Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search invoices" className="pl-9" placeholder="Invoice no., customer, order or dispatch" value={term} onChange={(e) => { setTerm(e.target.value); setPage(0) }} /></div>
          <CustomerSelect value={customer} onChange={(v) => { setCustomer(v); setPage(0) }} allowAll />
        </CardContent>
      </Card>
      <InvoiceTable rows={list.data?.rows ?? []} total={list.data?.total ?? 0} loading={list.loading} error={list.error} onRetry={list.reload} page={page} pageSize={pageSize}
        onPage={setPage} onPageSize={setPageSize} emptyTitle={tab === 'WORK' ? 'No drafts' : 'No invoices'} emptyDescription="Create a draft invoice from dispatched quantities. Nothing is invoiced automatically." />
    </>
  )
}
