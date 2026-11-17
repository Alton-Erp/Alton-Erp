import { Download, Loader2, Pencil, Replace, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { PermissionGate } from '@/auth/permission-gate'
import { PaginationBar } from '@/components/common/pagination-bar'
import { SortableHead } from '@/components/common/sortable-head'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LIFECYCLE_LABELS, WHERE_USED_FILTERS, qtyText, whereUsedExportRows } from '@/features/production/bom-bulk-model'
import { PRODUCT_TYPE_LABELS } from '@/features/products/product-model'
import { useAsync } from '@/hooks/use-async'
import { useDebouncedValue } from '@/hooks/use-debounced-value'
import { useUrlEnum, useUrlString } from '@/hooks/use-url-state'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatNumber, toIsoDate } from '@/lib/format'
import { fetchWhereUsed, type ComponentHit, type WhereUsedSort, type WhereUsedStatus } from '@/services/bom-bulk'

import { ComponentSearch } from './component-search'

const STATUS_VALUES = WHERE_USED_FILTERS.map((f) => f.value)
const lifecycleTone = (l: string) => (l === 'ACTIVE' ? 'success' : l === 'SCHEDULED' ? 'info' : l === 'DRAFT' || l === 'PENDING_APPROVAL' ? 'warning' : 'neutral') as 'success' | 'info' | 'warning' | 'neutral'

/** Where-Used Analysis: every BOM that uses a component (kept in the address: ?component=…). */
export function WhereUsedTab() {
  const navigate = useNavigate()
  const [componentId, setComponentId] = useUrlString('component')
  const [status, setStatus] = useUrlEnum<WhereUsedStatus>('wu', STATUS_VALUES, 'CURRENT')
  const [picked, setPicked] = useState<ComponentHit | null>(null)
  const [searchText, setSearchText] = useState('')
  const search = useDebouncedValue(searchText, 300)
  const [type, setType] = useState('all')
  const [sort, setSort] = useState<{ column: WhereUsedSort; ascending: boolean }>({ column: 'sku', ascending: true })
  const [pageState, setPageState] = useState({ key: '', page: 0 })
  const [pageSize, setPageSize] = useState(25)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const pageKey = JSON.stringify([componentId, status, search, type, sort, pageSize])
  const page = pageState.key === pageKey ? pageState.page : 0
  const setPage = (p: number) => setPageState({ key: pageKey, page: p })

  const filters = { status, search: search.trim() || undefined, product_type: type === 'all' ? undefined : type }
  const data = useAsync(async () => (componentId ? fetchWhereUsed(componentId, filters, sort.column, sort.ascending, pageSize, page * pageSize) : null),
    [componentId, status, search, type, sort.column, sort.ascending, page, pageSize])
  const result = data.data
  const component: ComponentHit | null = picked && picked.product_id === componentId ? picked
    : result?.component ? { ...result.component, model_number: null, supplier_model_number: null, bom_lines: result.total } : null

  const exportAll = async () => {
    if (!componentId) return
    setExporting(true)
    setExportError(null)
    try {
      const [all, { downloadSheets }] = await Promise.all([fetchWhereUsed(componentId, filters, sort.column, sort.ascending, 5000, 0), import('@/features/products/spreadsheet')])
      await downloadSheets([{ name: 'Where used', rows: whereUsedExportRows(all.rows, formatDate) }], `where-used-${all.component.sku}-${toIsoDate(new Date())}`, 'xlsx')
    } catch (e) {
      setExportError(describeDataError(e))
    } finally {
      setExporting(false)
    }
  }
  const startBulk = (op: 'REPLACE' | 'DELETE' | 'EDIT') => navigate(`/production/boms?tab=editor&op=${op}&component=${componentId}`)

  return (
    <div className="space-y-4" data-testid="where-used">
      <Card>
        <CardHeader>
          <CardTitle>Find where a component is used</CardTitle>
          <CardDescription>Search by component name, SKU, product or model code, barcode or EAN. Inactive components are included.</CardDescription>
        </CardHeader>
        <CardContent>
          <ComponentSearch label="Component" testId="where-used-component" value={component}
            onChange={(h) => { setPicked(h); setComponentId(h?.product_id ?? '') }} />
        </CardContent>
      </Card>

      {componentId && (
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>{component ? `${component.sku} — ${component.product_name}` : 'Component'}</CardTitle>
                {result && (
                  <CardDescription data-testid="where-used-stats">
                    {formatNumber(result.total)} BOM line{result.total === 1 ? '' : 's'} in this view · {formatNumber(result.stats.current_boms)} current revision{result.stats.current_boms === 1 ? '' : 's'}
                    {' '}· {formatNumber(result.stats.products)} finished product{result.stats.products === 1 ? '' : 's'}
                    {result.stats.unit_mismatches > 0 && <span className="text-red-700"> · {result.stats.unit_mismatches} line(s) with a unit different from the inventory unit</span>}
                  </CardDescription>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={exporting || !result?.total} onClick={() => void exportAll()}>
                  {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export to Excel
                </Button>
                <PermissionGate anyOf={['production_bom.create', 'production_bom.update']}>
                  <Button variant="outline" disabled={!result?.stats.current_boms} onClick={() => startBulk('REPLACE')}><Replace /> Replace</Button>
                  <Button variant="outline" disabled={!result?.stats.current_boms} onClick={() => startBulk('EDIT')}><Pencil /> Edit</Button>
                  <Button variant="outline" disabled={!result?.stats.current_boms} onClick={() => startBulk('DELETE')}><Trash2 /> Delete</Button>
                </PermissionGate>
              </div>
            </div>
            {exportError && <p role="alert" className="text-sm text-red-700">Export failed: {exportError}</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Select value={status} onValueChange={(v) => setStatus(v as WhereUsedStatus)}>
                <SelectTrigger className="w-48" aria-label="BOM status filter"><SelectValue /></SelectTrigger>
                <SelectContent>{WHERE_USED_FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="w-48" aria-label="Finished product type filter"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All product types</SelectItem>
                  {Object.entries(PRODUCT_TYPE_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input className="w-full sm:w-72" aria-label="Filter finished products" placeholder="Filter by product, SKU or BOM number…" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {data.error ? (
              <p role="alert" className="px-5 py-4 text-sm text-red-700">{describeDataError(data.error)}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table data-testid="where-used-table">
                  <TableHeader>
                    <TableRow>
                      <SortableHead column="sku" label="Finished product" sort={sort} onSort={setSort} />
                      <SortableHead column="bom_code" label="BOM / revision" sort={sort} onSort={setSort} />
                      <TableHead>Component</TableHead>
                      <SortableHead column="quantity" label="Quantity" sort={sort} onSort={setSort} align="right" />
                      <SortableHead column="unit" label="UOM" sort={sort} onSort={setSort} />
                      <SortableHead column="wastage" label="Wastage %" sort={sort} onSort={setSort} align="right" />
                      <SortableHead column="status" label="Status" sort={sort} onSort={setSort} />
                      <SortableHead column="effective_from" label="Effective" sort={sort} onSort={setSort} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.loading && !result && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Loading…</TableCell></TableRow>}
                    {result && result.rows.length === 0 && <TableRow><TableCell colSpan={8} className="py-8 text-center text-muted-foreground">No BOM in this view uses this component.</TableCell></TableRow>}
                    {result?.rows.map((r) => (
                      <TableRow key={`${r.bom_id}-${r.line_no}`}>
                        <TableCell><span className="font-medium">{r.sku}</span><div className="text-xs text-muted-foreground">{r.product_name}</div></TableCell>
                        <TableCell><Link className="text-primary hover:underline" to={`/production/boms/${r.bom_id}`}>{r.bom_code}</Link> <span className="text-muted-foreground">v{r.version}</span>
                          {r.is_current && <span className="ml-1 text-xs font-medium text-green-700">current</span>}</TableCell>
                        <TableCell className="text-xs">{r.component_sku}<div className="text-muted-foreground">{r.component_name}</div></TableCell>
                        <TableCell className="text-right tabular-nums">{qtyText(r.quantity, null)}<div className="text-xs text-muted-foreground">per {qtyText(r.output_quantity, r.output_unit)}</div></TableCell>
                        <TableCell>{r.unit}{!r.unit_matches && <div className="text-xs text-red-700">inventory unit {r.inventory_unit}</div>}</TableCell>
                        <TableCell className="text-right tabular-nums">{Number(r.wastage_percentage)}%</TableCell>
                        <TableCell><StatusBadge label={LIFECYCLE_LABELS[r.lifecycle] ?? r.lifecycle} tone={lifecycleTone(r.lifecycle)} /></TableCell>
                        <TableCell className="text-xs">{formatDate(r.effective_from)} → {r.effective_to ? formatDate(r.effective_to) : 'open'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            {result && result.total > 0 && (
              <PaginationBar page={page} pageSize={pageSize} total={result.total} onPageChange={setPage} onPageSizeChange={setPageSize} disabled={data.loading} />
            )}
          </CardContent>
        </Card>
      )}
      {!componentId && <p className="text-sm text-muted-foreground">Choose a component to see every BOM that uses it.</p>}
    </div>
  )
}
