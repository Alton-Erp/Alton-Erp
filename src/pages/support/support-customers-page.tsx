import { Contact, Search, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useUrlParam } from '@/features/drilldown/use-drill'
import { useSupportPermissions } from '@/features/support/use-support-permissions'
import { CustomerFormDialog } from '@/features/support/support-dialogs'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber } from '@/lib/format'
import { fetchCustomers } from '@/services/support'

const PAGE_SIZE = 25

/** /support/customers — support customers, searched on the server by name, code, phone (any format) or email. */
export default function SupportCustomersPage() {
  const [q, setQ] = useUrlParam('q', '')
  const [search, setSearch] = useState(q)
  const [page, setPage] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const perms = useSupportPermissions()
  const navigate = useNavigate()
  useEffect(() => { const t = setTimeout(() => { if (search.trim() !== q) { setQ(search.trim()); setPage(0) } }, 300); return () => clearTimeout(t) }, [search]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useAsync(() => fetchCustomers(q, PAGE_SIZE, page * PAGE_SIZE), [q, page])
  return (
    <>
      <PageHeader actions={perms.reply && <Button onClick={() => setCreateOpen(true)}><UserPlus /> New customer</Button>} />
      <Card className="gap-0 overflow-hidden p-0">
        <div className="border-b p-3">
          <div className="relative max-w-xl">
            <Search aria-hidden className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Search customers" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, company, customer code, phone or email" />
          </div>
        </div>
        {list.loading && !list.data ? <LoadingState rows={8} />
          : list.error ? <ErrorState message={describeDataError(list.error)} onRetry={list.reload} />
          : !list.data || list.data.rows.length === 0 ? (
            <EmptyState icon={Contact} title={q ? 'No customer matches' : 'No support customers yet'}
              description={q ? 'Try another name, number or email.' : 'Customers are added here or from a conversation in the inbox.'} />
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="customers-table">
                <TableHeader><TableRow className="hover:bg-transparent">
                  <TableHead>Customer</TableHead><TableHead>Phone</TableHead><TableHead>Email</TableHead><TableHead>ERP customer</TableHead>
                  <TableHead className="text-right">Open tickets</TableHead><TableHead className="text-right">Conversations</TableHead><TableHead>Last activity</TableHead>
                </TableRow></TableHeader>
                <TableBody>{list.data.rows.map((c) => (
                  <TableRow key={c.id} className="cursor-pointer" onClick={() => navigate(`/support/customers/${c.id}`)}>
                    <TableCell><Link className="font-medium hover:underline" to={`/support/customers/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.display_name}</Link>
                      <span className="block text-xs text-muted-foreground">{c.customer_code}{c.company_name ? ` · ${c.company_name}` : ''}</span></TableCell>
                    <TableCell className="text-sm">{c.phones.join(', ') || '—'}</TableCell>
                    <TableCell className="text-sm">{c.emails.join(', ') || '—'}</TableCell>
                    <TableCell className="text-sm">{c.erp_customer_code ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(c.open_tickets)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(c.conversations)}</TableCell>
                    <TableCell className="text-xs">{c.last_activity_at ? formatDateTime(c.last_activity_at) : '—'}</TableCell>
                  </TableRow>
                ))}</TableBody>
              </Table>
            </div>
          )}
        {list.data && list.data.total > 0 && <PaginationBar page={page} pageSize={PAGE_SIZE} total={list.data.total} onPageChange={setPage} disabled={list.loading} />}
      </Card>
      <CustomerFormDialog open={createOpen} onOpenChange={setCreateOpen} onSaved={(id) => navigate(`/support/customers/${id}`)} />
    </>
  )
}
