import { FileText, GitCompareArrows, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatAmount, toPaise } from '@/features/accounting/accounting-model'
import { AccountingExport } from '@/features/accounting/accounting-ui'
import { GST_STATUS_META, PI_STATUS_META, PI_TYPE_LABELS, type PiListRow, type PiStatus } from '@/features/accounting/purchase-invoice-model'
import { GstStatusBadge, PiStatusBadge, SupplierSelect, VarianceBadge } from '@/features/accounting/purchase-invoice-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate } from '@/lib/format'
import { fetchPiLookups, fetchPurchaseInvoices } from '@/services/accounting'

export default function PurchaseInvoicesPage() {
  const { has } = usePermissions()
  const [params, setParams] = useSearchParams()
  const get = (k: string, d = '') => params.get(k) ?? d
  const set = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v && v !== 'all') n.set(k, v); else n.delete(k); return n }, { replace: true })
  const from = get('from')
  const to = get('to')
  const status = get('status', 'all')
  const supplier = get('supplier')
  const search = get('q')
  const outstanding = get('outstanding') === '1'
  const [searchInput, setSearchInput] = useState(search)
  const lookups = useAsync(() => fetchPiLookups(), [])
  const list = useAsync(() => fetchPurchaseInvoices({ from: from || null, to: to || null, status: status === 'all' ? null : status, supplier_id: supplier || null,
    search: search || null, outstanding_only: outstanding }), [from, to, status, supplier, search, outstanding])
  const rows = list.data ?? []

  const columns: DataTableColumn<PiListRow>[] = [
    { id: 'number', header: 'Invoice', sortValue: (r) => r.invoice_number, cell: (r) => (
      <Link className="font-medium text-primary hover:underline" to={`/purchases/invoices/${r.id}`}>{r.invoice_number}
        <span className="block text-xs font-normal text-muted-foreground">Supplier no. {r.supplier_invoice_number}</span></Link>) },
    { id: 'date', header: 'Invoice date', sortValue: (r) => r.supplier_invoice_date, cell: (r) => formatDate(r.supplier_invoice_date) },
    { id: 'supplier', header: 'Supplier', sortValue: (r) => r.supplier_name, cell: (r) => <span className="text-sm">{r.supplier_name}<span className="block text-xs text-muted-foreground">{r.supplier_code}</span></span> },
    { id: 'type', header: 'Type', cell: (r) => <span className="text-xs">{PI_TYPE_LABELS[r.invoice_type]}{r.has_grn ? ' · matched to GRN' : ''}{r.reverse_charge ? ' · RCM' : ''}</span> },
    { id: 'taxable', header: 'Taxable', align: 'right', cell: (r) => <span className="tabular-nums">{formatAmount(r.taxable_value)}</span> },
    { id: 'tax', header: 'GST', align: 'right', cell: (r) => <span className="tabular-nums">{formatAmount(r.tax_total, true)}</span> },
    { id: 'total', header: 'Total', align: 'right', sortValue: (r) => toPaise(r.grand_total), cell: (r) => <span className="tabular-nums font-medium">{formatAmount(r.grand_total)}</span> },
    { id: 'outstanding', header: 'Outstanding', align: 'right', sortValue: (r) => toPaise(r.outstanding ?? 0), cell: (r) => <span className="tabular-nums">{r.outstanding === null ? '—' : formatAmount(r.outstanding)}</span> },
    { id: 'due', header: 'Due', sortValue: (r) => r.due_date ?? '', cell: (r) => (r.due_date ? formatDate(r.due_date) : '—') },
    { id: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <span className="flex flex-col items-start gap-1"><PiStatusBadge status={r.status} />
      <VarianceBadge status={r.variance_status} />{r.status === 'POSTED' && <GstStatusBadge status={r.gst_status} />}</span> },
  ]

  return (
    <>
      <PageHeader title="Supplier Invoices" description="Purchase invoices from suppliers: matched to goods receipts or entered directly, approved, posted and paid."
        breadcrumbs={[{ label: 'Purchase & GRN' }, { label: 'Supplier Invoices' }]} actions={<>
          <AccountingExport title="Supplier invoices" fileStem="supplier-invoices" rows={rows} columns={[
            { header: 'Invoice', value: (r) => r.invoice_number }, { header: 'Supplier invoice no.', value: (r) => r.supplier_invoice_number },
            { header: 'Invoice date', value: (r) => r.supplier_invoice_date }, { header: 'Supplier', value: (r) => r.supplier_name }, { header: 'Type', value: (r) => PI_TYPE_LABELS[r.invoice_type] },
            { header: 'Taxable', value: (r) => Number(r.taxable_value) }, { header: 'GST', value: (r) => Number(r.tax_total) }, { header: 'Total', value: (r) => Number(r.grand_total) },
            { header: 'Outstanding', value: (r) => (r.outstanding === null ? null : Number(r.outstanding)) }, { header: 'Due', value: (r) => r.due_date },
            { header: 'Status', value: (r) => PI_STATUS_META[r.status].label }, { header: 'GST', value: (r) => GST_STATUS_META[r.gst_status].label },
            { header: 'Voucher', value: (r) => r.voucher_number },
          ]} />
          <Button variant="outline" asChild><Link to="/purchases/invoices/matching"><GitCompareArrows /> GRN matching</Link></Button>
          {has('purchase_invoices.create') && <Button asChild><Link to="/purchases/invoices/new"><Plus /> New supplier invoice</Link></Button>}
        </>} />
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1"><Label htmlFor="pi-from">Invoice date from</Label><Input id="pi-from" type="date" value={from} onChange={(e) => set('from', e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="pi-to">To</Label><Input id="pi-to" type="date" value={to} onChange={(e) => set('to', e.target.value)} /></div>
          <div className="w-72 space-y-1"><Label htmlFor="pi-supplier">Supplier</Label>
            <SupplierSelect id="pi-supplier" value={supplier} suppliers={lookups.data?.suppliers ?? []} loading={lookups.loading} allowClear placeholder="Any supplier"
              onChange={(v) => set('supplier', v)} /></div>
          <div className="space-y-1"><Label htmlFor="pi-status">Status</Label>
            <Select value={status} onValueChange={(v) => set('status', v)}><SelectTrigger id="pi-status" className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All</SelectItem>{(Object.keys(PI_STATUS_META) as PiStatus[]).map((s) => <SelectItem key={s} value={s}>{PI_STATUS_META[s].label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1"><Label htmlFor="pi-q">Search</Label>
            <Input id="pi-q" className="w-56" value={searchInput} placeholder="Invoice no., supplier no. or name" onChange={(e) => setSearchInput(e.target.value)}
              onBlur={() => set('q', searchInput.trim())} onKeyDown={(e) => { if (e.key === 'Enter') set('q', searchInput.trim()) }} /></div>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={outstanding} onCheckedChange={(c) => set('outstanding', c ? '1' : '')} /> Outstanding only</label>
        </CardContent>
      </Card>
      <DataTable columns={columns} data={rows} getRowId={(r) => r.id} loading={list.loading} pageSize={50} searchable={false}
        error={list.error ? new Error(describeDataError(list.error)) : null} onRetry={list.reload}
        title={list.data ? `${rows.length} supplier invoice(s)${rows.length >= 1000 ? ' — first 1,000; narrow the filters' : ''}` : undefined}
        emptyState={{ icon: FileText, title: 'No supplier invoices', description: 'Supplier invoices matching the filters appear here.',
          action: has('purchase_invoices.create') ? <Button asChild><Link to="/purchases/invoices/new"><Plus /> New supplier invoice</Link></Button> : undefined }} />
    </>
  )
}
