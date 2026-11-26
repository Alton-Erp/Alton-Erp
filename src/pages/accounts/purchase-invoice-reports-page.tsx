import { BarChart3 } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatAmount } from '@/features/accounting/accounting-model'
import { AccountingExport, AccountingNotice } from '@/features/accounting/accounting-ui'
import { PI_REPORTS, type PiReportKey, type PiReportRow } from '@/features/accounting/purchase-invoice-model'
import { SupplierSelect } from '@/features/accounting/purchase-invoice-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchPiLookups, fetchPiReport } from '@/services/accounting'

type Kind = 'text' | 'amount' | 'date' | 'number' | 'flag' | 'invoice'
type Col = [key: string, header: string, kind?: Kind]
const COLUMNS: Record<PiReportKey, Col[]> = {
  PURCHASE_REGISTER: [['invoice_number', 'Invoice'], ['supplier_invoice_number', 'Supplier no.'], ['recorded_date', 'Recorded', 'date'], ['supplier', 'Supplier'],
    ['supplier_gstin', 'GSTIN'], ['invoice_type', 'Type'], ['status', 'Status'], ['reverse_charge', 'RCM', 'flag'], ['taxable_value', 'Taxable', 'amount'], ['cgst', 'CGST', 'amount'],
    ['sgst', 'SGST', 'amount'], ['igst', 'IGST', 'amount'], ['cess', 'Cess', 'amount'], ['grand_total', 'Total', 'amount'], ['gst_status', 'GST'], ['voucher_number', 'Voucher']],
  SUPPLIER_INVOICE_REGISTER: [['invoice_number', 'Invoice'], ['supplier_invoice_number', 'Supplier no.'], ['supplier_invoice_date', 'Invoice date', 'date'], ['supplier', 'Supplier'],
    ['invoice_type', 'Type'], ['status', 'Status'], ['taxable_value', 'Taxable', 'amount'], ['grand_total', 'Total', 'amount'], ['gst_status', 'GST'], ['voucher_number', 'Voucher']],
  OUTSTANDING: [['invoice_number', 'Invoice', 'invoice'], ['supplier_invoice_number', 'Supplier no.'], ['supplier_invoice_date', 'Invoice date', 'date'], ['due_date', 'Due', 'date'],
    ['supplier', 'Supplier'], ['grand_total', 'Total', 'amount'], ['paid', 'Paid', 'amount'], ['outstanding', 'Outstanding', 'amount'], ['overdue_days', 'Days overdue', 'number'],
    ['payment_status', 'Payment']],
  AGEING: [['supplier', 'Supplier'], ['not_due', 'Not due', 'amount'], ['d1_30', '1–30 days', 'amount'], ['d31_60', '31–60', 'amount'], ['d61_90', '61–90', 'amount'],
    ['d90_plus', 'Over 90', 'amount'], ['total', 'Total outstanding', 'amount'], ['ledger_creditors', 'Creditors ledger balance', 'amount']],
  GRN_RECONCILIATION: [['receipt_number', 'Receipt'], ['receipt_date', 'Date', 'date'], ['supplier', 'Supplier'], ['description', 'Item'], ['accepted_quantity', 'Accepted', 'number'],
    ['invoiced_quantity', 'Invoiced', 'number'], ['uninvoiced_quantity', 'Uninvoiced', 'number'], ['receipt_payable', 'Receipt payable', 'amount'],
    ['receipt_share_invoiced', 'Share invoiced', 'amount'], ['invoiced_amount', 'Invoiced amount', 'amount'], ['difference_posted', 'Difference posted', 'amount'],
    ['uninvoiced_payable', 'Uninvoiced payable', 'amount'], ['state', 'State'], ['invoices', 'Invoices']],
  GST_PENDING: [['invoice_number', 'Invoice', 'invoice'], ['supplier_invoice_number', 'Supplier no.'], ['supplier_invoice_date', 'Invoice date', 'date'], ['supplier', 'Supplier'],
    ['supplier_gstin', 'GSTIN'], ['cgst', 'CGST', 'amount'], ['sgst', 'SGST', 'amount'], ['igst', 'IGST', 'amount'], ['cess', 'Cess', 'amount'], ['reverse_charge', 'RCM', 'flag'],
    ['days_pending', 'Days pending', 'number']],
  ITC_SUMMARY: [['rule_key', 'Purpose'], ['account_code', 'Account'], ['account_name', 'Ledger'], ['period_debit', 'Debit (period)', 'amount'], ['period_credit', 'Credit (period)', 'amount'],
    ['closing_balance', 'Closing balance (Dr +)', 'amount']],
  PRICE_VARIANCE: [['invoice_number', 'Invoice'], ['supplier_invoice_number', 'Supplier no.'], ['supplier', 'Supplier'], ['receipt_number', 'Receipt'], ['description', 'Item'],
    ['quantity', 'Qty', 'number'], ['receipt_unit_cost', 'Receipt cost', 'amount'], ['invoice_unit_price', 'Invoice price', 'amount'], ['receipt_value', 'Receipt value', 'amount'],
    ['invoice_value', 'Invoice value', 'amount'], ['variance', 'Variance', 'amount'], ['variance_percent', 'Variance %', 'number'], ['variance_status', 'Approval']],
  COST_CENTRE_EXPENSE: [['cost_centre_code', 'Cost centre'], ['cost_centre_name', 'Name'], ['account_code', 'Account'], ['account_name', 'Ledger'], ['amount', 'Amount', 'amount']],
}
const USES_PERIOD: PiReportKey[] = ['PURCHASE_REGISTER', 'SUPPLIER_INVOICE_REGISTER', 'GRN_RECONCILIATION', 'ITC_SUMMARY', 'PRICE_VARIANCE', 'COST_CENTRE_EXPENSE']
const USES_AS_OF: PiReportKey[] = ['OUTSTANDING', 'AGEING']
const USES_SUPPLIER: PiReportKey[] = ['PURCHASE_REGISTER', 'SUPPLIER_INVOICE_REGISTER', 'OUTSTANDING', 'AGEING', 'GRN_RECONCILIATION', 'PRICE_VARIANCE']

function show(v: PiReportRow[string], kind: Kind = 'text') {
  if (v === null || v === undefined || v === '') return '—'
  if (kind === 'amount') return <span className="tabular-nums">{formatAmount(v as number)}</span>
  if (kind === 'date') return formatDate(String(v))
  if (kind === 'flag') return v ? 'Yes' : ''
  if (kind === 'number') return <span className="tabular-nums">{Number(v)}</span>
  return String(v).replace(/_/g, ' ')
}

export default function PurchaseInvoiceReportsPage() {
  const [params, setParams] = useSearchParams()
  const report = (params.get('report') ?? 'GRN_RECONCILIATION') as PiReportKey
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const asOf = params.get('as_of') ?? ''
  const supplier = params.get('supplier') ?? ''
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n }, { replace: true })
  const lookups = useAsync(() => fetchPiLookups(), [])
  const data = useAsync(() => fetchPiReport(report, {
    from: USES_PERIOD.includes(report) ? from || null : null, to: USES_PERIOD.includes(report) ? to || null : null, as_of: USES_AS_OF.includes(report) ? asOf || null : null,
    supplier_id: USES_SUPPLIER.includes(report) ? supplier || null : null,
  }), [report, from, to, asOf, supplier])
  const meta = PI_REPORTS.find((r) => r.key === report) ?? PI_REPORTS[0]
  const rows: PiReportRow[] = (data.data?.rows ?? []).map((r, i) => ({ ...r, _row: i }))
  const cols = COLUMNS[meta.key]
  const columns: DataTableColumn<PiReportRow>[] = cols.map(([key, header, kind]) => ({
    id: key, header, align: kind === 'amount' || kind === 'number' ? 'right' : 'left',
    sortValue: (r) => (kind === 'amount' || kind === 'number' ? Number(r[key] ?? 0) : String(r[key] ?? '')),
    searchValue: kind === 'text' || kind === 'invoice' || !kind ? (r) => String(r[key] ?? '') : undefined,
    cell: (r) => (kind === 'invoice' && r.invoice_id ? <Link className="text-primary hover:underline" to={`/purchases/invoices/${r.invoice_id}`}>{String(r[key])}</Link> : show(r[key], kind)),
  }))

  return (
    <>
      <PageHeader title="Supplier Invoice Reports" description="Registers, GRN reconciliation, outstanding and ageing, GST and price variances."
        breadcrumbs={[{ label: 'Purchase & GRN' }, { label: 'Supplier Invoices', to: '/purchases/invoices' }, { label: 'Reports' }]} actions={
          <AccountingExport title={meta.label} fileStem={`supplier-invoices-${meta.key.toLowerCase()}`} rows={rows}
            columns={cols.map(([key, header, kind]) => ({ header, value: (r: PiReportRow) => (kind === 'amount' || kind === 'number' ? (r[key] === null ? null : Number(r[key])) : (r[key] as string | null)) }))} />} />
      {meta.accounting ? <AccountingNotice /> : (
        <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-sm text-slate-700" data-testid="pi-operational-notice">
          Operational report from the supplier invoices{meta.key === 'AGEING' ? ' (the Creditors ledger balance beside it is the accounting figure)' : ''}
          {meta.key === 'GST_PENDING' ? ' with the accounting balance of GST input pending verification' : ''}.</p>)}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="pir-report">Report</Label>
            <Select value={meta.key} onValueChange={(v) => set('report', v)}><SelectTrigger id="pir-report" className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>{PI_REPORTS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}</SelectContent></Select></div>
          {USES_PERIOD.includes(meta.key) && <>
            <div className="space-y-1"><Label htmlFor="pir-from">From</Label><Input id="pir-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="pir-to">To</Label><Input id="pir-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div></>}
          {USES_AS_OF.includes(meta.key) && <div className="space-y-1"><Label htmlFor="pir-asof">As of</Label><Input id="pir-asof" type="date" value={asOf} onChange={(e) => set('as_of', e.target.value)} /></div>}
          {USES_SUPPLIER.includes(meta.key) && <div className="w-72 space-y-1"><Label htmlFor="pir-supplier">Supplier</Label>
            <SupplierSelect id="pir-supplier" value={supplier} suppliers={lookups.data?.suppliers ?? []} loading={lookups.loading} allowClear placeholder="All suppliers"
              onChange={(v) => set('supplier', v)} /></div>}
        </CardContent>
      </Card>
      <p className="mb-2 text-sm text-muted-foreground">{meta.description}</p>
      {data.data?.ledger_pending_balance !== undefined && <p className="mb-2 text-sm" data-testid="pi-ledger-pending">GST input pending verification — ledger balance:{' '}
        <strong className="tabular-nums">{formatAmount(data.data.ledger_pending_balance)}</strong></p>}
      {data.data?.unallocated !== undefined && <p className="mb-2 text-sm">Supplier-invoice expense without a cost-centre split: <strong className="tabular-nums">{formatAmount(data.data.unallocated)}</strong></p>}
      <DataTable columns={columns} data={rows} getRowId={(r) => String(r._row)} loading={data.loading} pageSize={100}
        error={data.error ? new Error(describeDataError(data.error)) : null} onRetry={data.reload} title={data.data ? `${rows.length} row(s)` : undefined}
        emptyState={{ icon: BarChart3, title: 'Nothing to show', description: 'No rows for the selected report and filters.' }} />
    </>
  )
}
