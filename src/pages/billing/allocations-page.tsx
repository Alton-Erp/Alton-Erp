import { ArrowLeftRight } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { PAYMENT_METHOD_LABELS, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { AllocatePaymentDialog } from '@/features/billing/payment-dialogs'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchPayments } from '@/services/billing'
import type { CustomerPaymentListRow } from '@/types/database-billing'

export default function AllocationsPage() {
  const { has } = usePermissions()
  const [customer, setCustomer] = useState('all')
  const [refresh, setRefresh] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [allocating, setAllocating] = useState<CustomerPaymentListRow | null>(null)
  const list = useAsync(() => fetchPayments({ customerId: customer === 'all' ? null : customer, unallocatedOnly: true }), [customer, refresh])
  const total = (list.data ?? []).reduce((s, p) => s + Math.round(Number(p.unallocated_amount) * 100), 0) / 100

  const columns: DataTableColumn<CustomerPaymentListRow>[] = [
    { id: 'receipt', header: 'Receipt', searchValue: (p) => `${p.receipt_number} ${p.transaction_reference ?? ''}`, cell: (p) => (
      <span><Link className="font-medium text-primary hover:underline" to={`/billing/payments?receipt=${p.id}`}>{p.receipt_number}</Link><span className="block text-xs text-muted-foreground">{formatDate(p.receipt_date)}</span></span>
    ) },
    { id: 'customer', header: 'Customer', searchValue: (p) => `${p.customer_name} ${p.customer_code}`, cell: (p) => <span>{p.customer_name}<span className="block text-xs text-muted-foreground">{p.customer_code}</span></span> },
    { id: 'method', header: 'Method', cell: (p) => <span className="text-xs">{PAYMENT_METHOD_LABELS[p.payment_method]}<span className="block text-muted-foreground">{p.transaction_reference ?? ''}</span></span> },
    { id: 'amount', header: 'Received', align: 'right', cell: (p) => money(p.amount_received, false) },
    { id: 'allocated', header: 'Allocated', align: 'right', cell: (p) => money(p.allocated_amount, false) },
    { id: 'unallocated', header: 'Unallocated', align: 'right', sortValue: (p) => Number(p.unallocated_amount), cell: (p) => <span className="font-medium text-amber-700">{money(p.unallocated_amount)}</span> },
    { id: 'act', header: '', align: 'right', cell: (p) => (has('payments.manage') ? <Button size="sm" variant="outline" onClick={() => setAllocating(p)}>Allocate</Button> : null) },
  ]

  return (
    <>
      <PageHeader />
      {message && <p role="status" className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-4 p-4">
          <div className="space-y-1"><Label htmlFor="al-cust">Customer</Label><CustomerSelect id="al-cust" value={customer} onChange={setCustomer} allowAll /></div>
          <p className="text-sm">Unallocated (on account): <span className="font-semibold">{list.loading ? '…' : money(total)}</span> across {(list.data ?? []).length} receipt(s)</p>
          <p className="basis-full text-xs text-muted-foreground">Allocations can be reversed from the receipt or invoice (with a reason). Unallocated receipts are not netted against outstanding invoices until they are allocated.</p>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={list.data ?? []} getRowId={(p) => p.id} loading={list.loading} searchPlaceholder="Search receipts…" pageSize={25}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: ArrowLeftRight, title: 'No unallocated receipts', description: 'Every recorded receipt is fully allocated to invoices.' }} />
      {allocating && <AllocatePaymentDialog payment={allocating} onClose={() => setAllocating(null)} onDone={(m) => { setAllocating(null); setMessage(m); setRefresh((n) => n + 1) }} />}
    </>
  )
}
