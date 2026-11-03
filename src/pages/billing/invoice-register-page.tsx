import { FilePlus, FileSpreadsheet, Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'

import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BillingExport } from '@/features/billing/billing-export'
import { INVOICE_STATUS_LABELS, recentFinancialYears } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { InvoiceTable } from '@/features/billing/invoice-table'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { fetchBillingSettings, fetchInvoicesPage, type InvoiceFilters } from '@/services/billing'
import type { InvoiceDisplayStatus, PaymentStatus, SalesInvoiceListRow } from '@/types/database-billing'

export default function InvoiceRegisterPage() {
  const { has } = usePermissions()
  const [type, setType] = useState('all')
  const settings = useAsync(fetchBillingSettings, [])
  const years = recentFinancialYears(6, settings.data?.fy_start_month ?? 4)
  const [fy, setFy] = useState('current')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [customer, setCustomer] = useState('all')
  const [status, setStatus] = useState('all')
  const [payment, setPayment] = useState('all')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(25)
  const year = fy === 'all' ? null : fy === 'current' ? years[0] : years.find((y) => y.label === fy) ?? null
  const filters: InvoiceFilters = {
    search, issuedOnly: true, statuses: status === 'all' ? null : [status as InvoiceDisplayStatus], paymentStatus: payment === 'all' ? null : (payment as PaymentStatus),
    customerId: customer === 'all' ? null : customer, invoiceType: type === 'all' ? null : (type as 'TAX_INVOICE' | 'BILL_OF_SUPPLY'), from: from || year?.from || null, to: to || year?.to || null,
  }
  const list = useAsync(() => fetchInvoicesPage(filters, page, pageSize), [JSON.stringify(filters), page, pageSize])
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0) }

  const loadAll = async () => {
    const out: SalesInvoiceListRow[] = []
    for (let p = 0; p < 50; p++) {
      const r = await fetchInvoicesPage(filters, p, 500)
      out.push(...r.rows)
      if (out.length >= r.total) break
    }
    return out
  }

  return (
    <>
      <PageHeader actions={<>
        {has('invoices.create') && <Button variant="outline" asChild><Link to="/billing/invoices/import"><FileSpreadsheet /> Import</Link></Button>}
        {has('invoices.create') && <Button asChild><Link to="/billing/invoices/new"><FilePlus /> New invoice</Link></Button>}
        <BillingExport title="Invoice register" fileStem={`invoice-register-${filters.from ?? 'all'}-${filters.to ?? 'all'}`} load={loadAll} columns={[
        { header: 'Invoice no.', value: (i) => i.invoice_number }, { header: 'Invoice date', value: (i) => i.invoice_date }, { header: 'Financial year', value: (i) => i.financial_year },
        { header: 'Customer', value: (i) => i.customer_legal_name }, { header: 'Customer GSTIN', value: (i) => i.customer_gstin }, { header: 'Place of supply', value: (i) => i.place_of_supply_state_code },
        { header: 'Taxable value', value: (i) => Number(i.taxable_subtotal) }, { header: 'CGST', value: (i) => Number(i.cgst_total) }, { header: 'SGST', value: (i) => Number(i.sgst_total) },
        { header: 'IGST', value: (i) => Number(i.igst_total) }, { header: 'Round-off', value: (i) => Number(i.round_off) }, { header: 'Grand total', value: (i) => Number(i.grand_total) },
        { header: 'Credited', value: (i) => Number(i.credited) }, { header: 'Debited', value: (i) => Number(i.debited) }, { header: 'Received', value: (i) => Number(i.paid) },
        { header: 'Balance due', value: (i) => (i.balance_due === null ? null : Number(i.balance_due)) }, { header: 'Status', value: (i) => INVOICE_STATUS_LABELS[i.display_status] },
        { header: 'Due date', value: (i) => i.due_date }, { header: 'Orders', value: (i) => i.order_references }, { header: 'Dispatches', value: (i) => i.dispatch_references },
        { header: 'Type', value: (i) => (i.invoice_type === 'TAX_INVOICE' ? 'Tax invoice' : 'Bill of supply') }, { header: 'Created from', value: (i) => i.source },
        { header: 'Vehicle', value: (i) => i.vehicle_number }, { header: 'E-way bill', value: (i) => i.eway_bill_number },
      ]} /></>} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="rg-fy">Financial year</Label>
            <Select value={fy} onValueChange={reset(setFy)}><SelectTrigger id="rg-fy" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="current">Current ({years[0].label})</SelectItem>{years.slice(1).map((y) => <SelectItem key={y.label} value={y.label}>{y.label}</SelectItem>)}<SelectItem value="all">All years</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="rg-from">From</Label><Input id="rg-from" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="rg-to">To</Label><Input id="rg-to" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="rg-cust">Customer</Label><CustomerSelect id="rg-cust" value={customer} onChange={reset(setCustomer)} allowAll /></div>
          <div className="space-y-1"><Label htmlFor="rg-type">Type</Label>
            <Select value={type} onValueChange={reset(setType)}><SelectTrigger id="rg-type" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="TAX_INVOICE">Tax invoice</SelectItem><SelectItem value="BILL_OF_SUPPLY">Bill of supply</SelectItem></SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="rg-status">Invoice status</Label>
            <Select value={status} onValueChange={reset(setStatus)}><SelectTrigger id="rg-status" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{['ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED'].map((s) => <SelectItem key={s} value={s}>{INVOICE_STATUS_LABELS[s]}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="rg-pay">Payment status</Label>
            <Select value={payment} onValueChange={reset(setPayment)}><SelectTrigger id="rg-pay" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem><SelectItem value="UNPAID">Unpaid</SelectItem><SelectItem value="PARTIALLY_PAID">Partially paid</SelectItem><SelectItem value="PAID">Paid</SelectItem></SelectContent></Select></div>
          <div className="relative w-60"><Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search register" className="pl-9" placeholder="Invoice no., customer…" value={term} onChange={(e) => { setTerm(e.target.value); setPage(0) }} /></div>
        </CardContent>
      </Card>
      <InvoiceTable rows={list.data?.rows ?? []} total={list.data?.total ?? 0} loading={list.loading} error={list.error} onRetry={list.reload} page={page} pageSize={pageSize}
        onPage={setPage} onPageSize={setPageSize} emptyTitle="No issued invoices" emptyDescription="Issued and cancelled invoices for the selected filters appear here." />
    </>
  )
}
