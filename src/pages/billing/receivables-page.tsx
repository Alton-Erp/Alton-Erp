import { HandCoins } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BillingExport } from '@/features/billing/billing-export'
import { BUCKETS, BUCKET_LABELS, money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, toIsoDate } from '@/lib/format'
import { fetchReceivables, type AgeingBucket, type ReceivableRow } from '@/services/billing'

export default function ReceivablesPage() {
  const [asOf, setAsOf] = useState(() => toIsoDate(new Date()))
  const [customer, setCustomer] = useState('all')
  const [bucket, setBucket] = useState('all')
  const list = useAsync(() => (asOf ? fetchReceivables(asOf, customer === 'all' ? null : customer, bucket === 'all' ? null : (bucket as AgeingBucket)) : Promise.resolve([])), [asOf, customer, bucket])
  const rows = list.data ?? []
  const sum = (f: (r: ReceivableRow) => number) => rows.reduce((s, r) => s + Math.round(Number(f(r)) * 100), 0) / 100
  const overdue = rows.filter((r) => r.days_overdue > 0)

  const columns: DataTableColumn<ReceivableRow>[] = [
    { id: 'inv', header: 'Invoice', searchValue: (r) => r.invoice_number, sortValue: (r) => r.invoice_date, cell: (r) => (
      <span><Link className="font-medium text-primary hover:underline" to={`/billing/invoices/${r.invoice_id}`}>{r.invoice_number}</Link><span className="block text-xs text-muted-foreground">{formatDate(r.invoice_date)}</span></span>
    ) },
    { id: 'customer', header: 'Customer', searchValue: (r) => `${r.customer_name} ${r.customer_code}`, sortValue: (r) => r.customer_name, cell: (r) => (
      <span>{r.customer_name}<Link className="block text-xs text-primary hover:underline" to={`/billing/statements?customer=${r.customer_id}`}>Statement</Link></span>
    ) },
    { id: 'due', header: 'Due date', sortValue: (r) => r.due_date, cell: (r) => formatDate(r.due_date) },
    { id: 'days', header: 'Days overdue', align: 'right', sortValue: (r) => r.days_overdue, cell: (r) => (r.days_overdue > 0 ? <span className="text-shortage">{r.days_overdue}</span> : '—') },
    { id: 'bucket', header: 'Bucket', cell: (r) => BUCKET_LABELS[r.bucket] },
    { id: 'total', header: 'Invoice total', align: 'right', cell: (r) => money(r.grand_total, false) },
    { id: 'adj', header: 'Credits / debits', align: 'right', cell: (r) => <span className="text-xs">−{money(r.credited, false)} / +{money(r.debited, false)}</span> },
    { id: 'paid', header: 'Received', align: 'right', cell: (r) => money(r.paid, false) },
    { id: 'balance', header: 'Balance', align: 'right', sortValue: (r) => Number(r.balance), cell: (r) => <span className="font-medium">{money(r.balance)}</span> },
  ]

  return (
    <>
      <PageHeader actions={<BillingExport title="Outstanding receivables" fileStem={`receivables-${asOf}`} rows={rows} columns={[
        { header: 'Invoice no.', value: (r) => r.invoice_number }, { header: 'Invoice date', value: (r) => r.invoice_date }, { header: 'Customer', value: (r) => r.customer_name },
        { header: 'Due date', value: (r) => r.due_date }, { header: 'Days overdue', value: (r) => r.days_overdue }, { header: 'Bucket', value: (r) => BUCKET_LABELS[r.bucket] },
        { header: 'Invoice total', value: (r) => Number(r.grand_total) }, { header: 'Credited', value: (r) => Number(r.credited) }, { header: 'Debited', value: (r) => Number(r.debited) },
        { header: 'Received', value: (r) => Number(r.paid) }, { header: 'Balance', value: (r) => Number(r.balance) },
      ]} />} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="rc-asof">As of</Label><Input id="rc-asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="rc-cust">Customer</Label><CustomerSelect id="rc-cust" value={customer} onChange={setCustomer} allowAll /></div>
          <div className="space-y-1"><Label htmlFor="rc-bucket">Ageing bucket</Label>
            <Select value={bucket} onValueChange={setBucket}><SelectTrigger id="rc-bucket" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{BUCKETS.map((b) => <SelectItem key={b} value={b}>{BUCKET_LABELS[b]}</SelectItem>)}</SelectContent></Select></div>
          <dl className="ml-auto flex gap-6 text-sm">
            <div><dt className="text-xs text-muted-foreground">Outstanding</dt><dd className="font-semibold">{list.loading ? '…' : money(sum((r) => r.balance))}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Overdue</dt><dd className="font-semibold text-shortage">{list.loading ? '…' : money(overdue.reduce((s, r) => s + Math.round(Number(r.balance) * 100), 0) / 100)}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Invoices</dt><dd className="font-semibold">{rows.length}</dd></div>
          </dl>
          <p className="basis-full text-xs text-muted-foreground">Balances are reconstructed as of the selected date from invoices issued, notes issued and allocations made on or before it (later cancellations and reversals are applied from their dates). Unallocated receipts are not deducted.</p>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} getRowId={(r) => r.invoice_id} loading={list.loading} searchPlaceholder="Search invoice or customer…" pageSize={25}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        emptyState={{ icon: HandCoins, title: 'Nothing outstanding', description: 'No issued invoice had an open balance on this date.' }} />
    </>
  )
}
