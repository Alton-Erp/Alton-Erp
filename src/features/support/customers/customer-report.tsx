import { Link } from 'react-router-dom'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { hoursText } from '@/features/support/pipeline/pipeline-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchCustomerReport } from '@/services/customer-crm'

/**
 * Customer-level support metrics on Support Reports: the 20 customers with most tickets in the period (open, closed,
 * overdue, average resolution, reopened, product complaints), their month-by-month ticket counts and product
 * complaints by customer. From the tickets themselves; hidden before the database update.
 */
export function CustomerReportSection({ from, to }: { from: string; to: string }) {
  const q = useAsync(() => fetchCustomerReport(from, to).catch(() => null), [from, to])
  if (!q.data) return q.error ? <p className="text-sm text-red-700">{describeDataError(q.error)}</p> : null
  const r = q.data
  const months = [...new Set(r.trend.map((x) => x.month))].sort()
  const trendOf = (id: string, mo: string) => r.trend.find((x) => x.customer_id === id && x.month === mo)?.tickets ?? 0
  const top10 = r.customers.slice(0, 10)
  return (
    <Card data-testid="customer-report">
      <CardHeader><div><CardTitle>Customers</CardTitle><CardDescription>Tickets linked to support customers, created in the period. Open the customer for the full history.</CardDescription></div></CardHeader>
      <CardContent className="space-y-4">
        {r.customers.length === 0 ? <p className="text-sm text-muted-foreground">No tickets linked to customers in this period.</p> : (
          <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow className="hover:bg-transparent"><TableHead>Customer</TableHead><TableHead className="text-right">Tickets</TableHead><TableHead className="text-right">Open</TableHead>
              <TableHead className="text-right">Closed</TableHead><TableHead className="text-right">Overdue</TableHead><TableHead className="text-right">Avg resolution</TableHead>
              <TableHead className="text-right">Reopened</TableHead>{r.products_by_customer && <TableHead className="text-right">Product complaints</TableHead>}</TableRow></TableHeader>
            <TableBody>{r.customers.map((c) => (
              <TableRow key={c.customer_id}><TableCell><Link className="text-primary hover:underline" to={`/support/customers/${c.customer_id}`}>{c.display_name}</Link>
                <span className="ml-1 text-xs text-muted-foreground">{c.customer_code}</span></TableCell>
                <TableCell className="text-right tabular-nums">{c.tickets}</TableCell><TableCell className="text-right tabular-nums">{c.open}</TableCell><TableCell className="text-right tabular-nums">{c.closed}</TableCell>
                <TableCell className="text-right tabular-nums">{c.overdue}</TableCell><TableCell className="text-right tabular-nums">{hoursText(c.avg_resolution_hours)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.reopened}</TableCell>{r.products_by_customer && <TableCell className="text-right tabular-nums">{c.product_complaints ?? '—'}</TableCell>}</TableRow>
            ))}</TableBody></Table></div>
        )}
        {top10.length > 0 && months.length > 0 && (
          <div className="overflow-x-auto">
            <p className="mb-1 text-sm font-medium">Tickets per month (top 10 customers)</p>
            <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Customer</TableHead>{months.map((mo) => <TableHead key={mo} className="text-right">{mo}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{top10.map((c) => <TableRow key={c.customer_id}><TableCell>{c.display_name}</TableCell>{months.map((mo) => <TableCell key={mo} className="text-right tabular-nums">{trendOf(c.customer_id, mo)}</TableCell>)}</TableRow>)}</TableBody></Table>
          </div>
        )}
        {r.products_by_customer && r.products_by_customer.length > 0 && (
          <div className="overflow-x-auto">
            <p className="mb-1 text-sm font-medium">Product complaints by customer</p>
            <Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>Customer</TableHead><TableHead>SKU</TableHead><TableHead>Product</TableHead><TableHead className="text-right">Tickets</TableHead></TableRow></TableHeader>
              <TableBody>{r.products_by_customer.map((x) => <TableRow key={`${x.customer_id}-${x.sku}`}><TableCell>{x.display_name}</TableCell><TableCell className="font-mono text-xs">{x.sku}</TableCell>
                <TableCell>{x.product_name}</TableCell><TableCell className="text-right tabular-nums">{x.tickets}</TableCell></TableRow>)}</TableBody></Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
