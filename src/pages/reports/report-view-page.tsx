import { ArrowLeft, Download, Printer, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { money } from '@/features/billing/billing-model'
import { CustomerSelect } from '@/features/billing/billing-pickers'
import { ProductPicker } from '@/features/inventory/pickers'
import { cellValue, findReport, reportSheet, reportTotals, type ReportColumn } from '@/features/management/report-defs'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, toIsoDate } from '@/lib/format'
import type { ProductOption } from '@/services/inventory'
import { runReport } from '@/services/management'
import { fetchSupplierOptions } from '@/services/suppliers'

function display(c: ReportColumn, v: unknown) {
  if (v === null || v === undefined || v === '') return '—'
  if (c.type === 'money') return money(Number(v), false)
  if (c.type === 'date') return formatDate(String(v))
  if (c.type === 'percent') return `${Number(v)}%`
  if (c.type === 'bool') return v === true ? 'Yes' : 'No'
  if (c.type === 'number') return String(Number(v))
  return String(v).replace(/_/g, ' ')
}

/** /reports/view/:key */
export default function ReportViewPage() {
  const { reportKey } = useParams()
  const def = findReport(reportKey)
  const [today] = useState(() => toIsoDate(new Date()))
  const monthStart = `${today.slice(0, 8)}01`
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const [product, setProduct] = useState<ProductOption | null>(null)
  const [customer, setCustomer] = useState('all')
  const [supplier, setSupplier] = useState('all')
  const [term, setTerm] = useState('')
  const search = useDebouncedValue(term, 300)
  const [refresh, setRefresh] = useState(0)
  const suppliers = useAsync(() => (def?.filters.includes('supplier') ? fetchSupplierOptions(true) : Promise.resolve([])), [def?.key])
  const filters = {
    from: def?.filters.includes('date') ? from || null : null, to: def?.filters.includes('date') ? to || null : null,
    product_id: product?.product_id ?? null, customer_id: customer === 'all' ? null : customer, supplier_id: supplier === 'all' ? null : supplier, search: search.trim() || null,
  }
  const data = useAsync(() => (def ? runReport(def.key, filters) : Promise.resolve(null)), [def?.key, JSON.stringify(filters), refresh])
  const rows = useMemo(() => data.data?.rows ?? [], [data.data])
  const totals = useMemo(() => (def ? reportTotals(def, rows) : {}), [def, rows])

  if (!def) return (<><PageHeader title="Report not found" /><Card><CardContent className="py-6 text-sm">This report does not exist. <Link className="text-primary hover:underline" to="/reports">All reports</Link></CardContent></Card></>)

  const filterText = [def.filters.includes('date') ? `${formatDate(from)} – ${formatDate(to)}` : 'Current position', product ? `Product ${product.sku}` : null,
    search.trim() ? `Search "${search.trim()}"` : null].filter(Boolean).join(' · ')
  const exportExcel = async () => {
    const { downloadSheets } = await import('@/features/products/spreadsheet')
    await downloadSheets([{ name: def.title.slice(0, 31), rows: [[def.title], [filterText], [`Generated ${formatDateTime(new Date())}`], [], ...reportSheet(def, rows)] }],
      `${def.key.toLowerCase().replace(/_/g, '-')}-${today}`, 'xlsx')
  }

  return (
    <>
      <div className="print-hidden">
        <PageHeader title={def.title} description={def.description} breadcrumbs={[{ label: 'Reports', to: '/reports' }, { label: def.title }]}
          actions={<>
            <Button variant="outline" asChild><Link to="/reports"><ArrowLeft /> All reports</Link></Button>
            <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={data.loading ? 'animate-spin' : undefined} /></Button>
            <Button variant="outline" disabled={!rows.length} onClick={() => void exportExcel()}><Download /> Excel</Button>
            <Button variant="outline" disabled={!rows.length} onClick={() => window.print()}><Printer /> Print / PDF</Button>
          </>} />
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            {def.filters.includes('date') && <>
              <div className="space-y-1"><Label htmlFor="rp-from">From</Label><Input id="rp-from" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></div>
              <div className="space-y-1"><Label htmlFor="rp-to">To</Label><Input id="rp-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
            </>}
            {def.filters.includes('product') && <div className="w-64 space-y-1"><Label htmlFor="rp-product">Product</Label><ProductPicker id="rp-product" value={product} onChange={setProduct} includeInactive /></div>}
            {def.filters.includes('customer') && <div className="space-y-1"><Label htmlFor="rp-customer">Customer</Label><CustomerSelect id="rp-customer" value={customer} onChange={setCustomer} allowAll /></div>}
            {def.filters.includes('supplier') && <div className="space-y-1"><Label htmlFor="rp-supplier">Supplier</Label>
              <Select value={supplier} onValueChange={(v) => { if (v) setSupplier(v) }}><SelectTrigger id="rp-supplier" className="w-60"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72"><SelectItem value="all">All suppliers</SelectItem>{(suppliers.data ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.supplier_code} — {s.display_name ?? s.legal_name}</SelectItem>)}</SelectContent>
              </Select></div>}
            <div className="relative w-64"><Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search report" className="pl-9" placeholder="Search…" value={term} onChange={(e) => setTerm(e.target.value)} /></div>
          </CardContent>
        </Card>
      </div>
      {data.loading && !data.data ? <LoadingState variant="table" rows={6} /> : data.error ? <Card><ErrorState message={describeDataError(data.error)} onRetry={data.reload} /></Card> : (
        <article className="print-area rounded-xl border bg-card">
          <header className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
            <div><p className="font-semibold">{def.title}</p><p className="text-xs text-muted-foreground">{filterText}</p></div>
            <p className="text-xs text-muted-foreground" data-testid="report-count">{rows.length} row(s){data.data ? ` · generated ${formatDateTime(data.data.generated_at)}` : ''}</p>
          </header>
          {rows.length === 0 ? <p className="px-4 py-8 text-center text-sm text-muted-foreground">No records for these filters.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label={def.title}>
                <thead className="bg-muted/40 text-xs text-muted-foreground"><tr>{def.columns.map((c) => (
                  <th key={c.key} className={`px-3 py-2 whitespace-nowrap ${c.type && c.type !== 'text' && c.type !== 'date' && c.type !== 'bool' ? 'text-right' : 'text-left'}`}>{c.label}</th>
                ))}</tr></thead>
                <tbody>{rows.map((r, i) => {
                  const link = def.link?.(r)
                  return (
                    <tr key={i} className={`border-t ${r.status === 'REVERSED' || r.status === 'CANCELLED' ? 'text-muted-foreground line-through decoration-muted-foreground/40' : ''}`}>
                      {def.columns.map((c, j) => {
                        const text = display(c, r[c.key])
                        const numeric = c.type && c.type !== 'text' && c.type !== 'date' && c.type !== 'bool'
                        return <td key={c.key} className={`px-3 py-1.5 whitespace-nowrap ${numeric ? 'text-right tabular-nums' : ''}`}>{j === 0 && link ? <Link className="text-primary hover:underline" to={link}>{text}</Link> : text}</td>
                      })}
                    </tr>
                  )
                })}</tbody>
                {Object.keys(totals).length > 0 && <tfoot><tr className="border-t-2 font-semibold">{def.columns.map((c, j) => (
                  <td key={c.key} className="px-3 py-2 text-right tabular-nums">{j === 0 ? <span className="float-left">Total</span> : c.key in totals ? (c.type === 'money' ? money(totals[c.key], false) : String(cellValue(c, totals[c.key]))) : ''}</td>
                ))}</tr></tfoot>}
              </table>
            </div>
          )}
        </article>
      )}
    </>
  )
}
