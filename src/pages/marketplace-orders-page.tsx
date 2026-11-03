import { PlugZap, Store } from 'lucide-react'
import { useState } from 'react'

import { DataTable } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { NotBuiltNotice } from '@/components/common/not-built-notice'
import { PageHeader } from '@/components/common/page-header'
import { PlaceholderCard } from '@/components/common/placeholder-card'
import { layoutColumns } from '@/components/common/table-layout'

type MarketplaceFilter = 'all' | 'new' | 'ready' | 'shipped' | 'returned'

export default function MarketplaceOrdersPage() {
  const [filter, setFilter] = useState<MarketplaceFilter>('all')

  return (
    <>
      <PageHeader />

      <NotBuiltNotice module="Marketplace order intake" />

      <div className="grid gap-6 xl:grid-cols-3">
        <DataTable
          className="xl:col-span-2"
          title="Marketplace Orders"
          description="Orders received through online marketplaces"
          columns={layoutColumns([
            'Marketplace Order ID',
            'Marketplace',
            'SKU',
            { header: 'Qty', align: 'right' },
            'Order Date',
            'Ship By',
            'Status',
          ])}
          data={[]}
          getRowId={() => ''}
          searchPlaceholder="Search order ID, SKU…"
          toolbar={
            <FilterTabs<MarketplaceFilter>
              label="Marketplace order status"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'new', label: 'New' },
                { value: 'ready', label: 'Ready to Ship' },
                { value: 'shipped', label: 'Shipped' },
                { value: 'returned', label: 'Returned' },
              ]}
            />
          }
          emptyState={{
            icon: Store,
            title: 'No marketplace orders yet',
            description:
              'Orders from online marketplaces will be consolidated here alongside their ship-by dates, so stock can be reserved for them like any other sales order.',
          }}
        />

        <PlaceholderCard
          title="Marketplace Connections"
          description="Accounts that feed orders into the ERP"
          icon={PlugZap}
          emptyTitle="No marketplaces connected"
          emptyDescription="Marketplace accounts can be linked through order imports or integrations in a later phase."
        />
      </div>
    </>
  )
}
