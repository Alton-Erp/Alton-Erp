import { Receipt } from 'lucide-react'
import { Link } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PaginationBar } from '@/components/common/pagination-bar'
import { Card } from '@/components/ui/card'
import { InvoiceStatusBadge } from '@/features/billing/billing-badges'
import { money } from '@/features/billing/billing-model'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import type { SalesInvoiceListRow } from '@/types/database-billing'

/** Server-paged invoice table (rows and total come from the database query). */
export function InvoiceTable({ rows, total, loading, error, onRetry, page, pageSize, onPage, onPageSize, emptyTitle, emptyDescription }: {
  rows: SalesInvoiceListRow[]
  total: number
  loading: boolean
  error: unknown
  onRetry: () => void
  page: number
  pageSize: number
  onPage: (p: number) => void
  onPageSize: (s: number) => void
  emptyTitle: string
  emptyDescription: string
}) {
  const columns: DataTableColumn<SalesInvoiceListRow>[] = [
    { id: 'number', header: 'Invoice', cell: (i) => (
      <span><Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${i.id}`}>{i.invoice_number ?? 'Draft'}</Link>
        <span className="block text-xs text-muted-foreground">{formatDate(i.invoice_date)}{i.financial_year ? ` · FY ${i.financial_year}` : ''}</span></span>
    ) },
    { id: 'customer', header: 'Customer', cell: (i) => <span>{i.customer_legal_name}<span className="block text-xs text-muted-foreground">{i.customer_gstin ?? i.customer_code_snapshot}</span></span> },
    { id: 'refs', header: 'Orders / dispatches', cell: (i) => <span className="text-xs">{i.order_references ?? '—'}<span className="block text-muted-foreground">{i.dispatch_references ?? ''}</span></span> },
    { id: 'status', header: 'Status', cell: (i) => <span className="inline-flex flex-col gap-1"><InvoiceStatusBadge status={i.display_status} />{i.days_overdue ? <span className="text-xs text-shortage">{i.days_overdue} day(s) overdue</span> : null}</span> },
    { id: 'due', header: 'Due', cell: (i) => (i.due_date ? formatDate(i.due_date) : '—') },
    { id: 'taxable', header: 'Taxable', align: 'right', cell: (i) => money(i.taxable_subtotal, false) },
    { id: 'tax', header: 'GST', align: 'right', cell: (i) => money(Number(i.cgst_total) + Number(i.sgst_total) + Number(i.igst_total), false) },
    { id: 'total', header: 'Total', align: 'right', cell: (i) => <span className="font-medium">{money(i.grand_total)}</span> },
    { id: 'balance', header: 'Balance due', align: 'right', cell: (i) => (i.balance_due === null ? '—' : <span className={Number(i.balance_due) > 0 ? 'font-medium' : 'text-green-700'}>{money(i.balance_due)}</span>) },
  ]
  return (
    <div>
      <DataTable className="rounded-b-none" columns={columns} data={rows} getRowId={(i) => i.id} loading={loading} searchable={false} pageSize={pageSize}
        error={error ? new Error(describeDataError(error)) : null} onRetry={onRetry} emptyState={{ icon: Receipt, title: emptyTitle, description: emptyDescription }} />
      <Card className="rounded-t-none border-t-0">
        <PaginationBar page={page} pageSize={pageSize} total={total} onPageChange={onPage} onPageSizeChange={(s) => { onPageSize(s); onPage(0) }} disabled={loading} />
      </Card>
    </div>
  )
}
