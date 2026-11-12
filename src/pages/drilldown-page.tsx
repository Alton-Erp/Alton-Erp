import { ArrowDown, ArrowUp, Boxes, Columns3, Download, ExternalLink, Filter, IndianRupee, Lock, PackageCheck, Printer, RefreshCw, Search, ShieldX, Warehouse, X, CircleDashed } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import type { PermissionCode } from '@/auth/permissions'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { EmptyState } from '@/components/common/empty-state'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { money } from '@/features/billing/billing-model'
import { COLUMNS, columnValue, MODULE_LIST, RECORD_LINK, type DrillColumn } from '@/features/drilldown/drill-columns'
import { describeConditions } from '@/features/drilldown/drill-conditions'
import { contextFromParams, DASHBOARDS, METRICS, SOURCES, type DashboardKey, type DrillContext } from '@/features/drilldown/drill-registry'
import { dashboardHref, useCompanyClock } from '@/features/drilldown/use-drill'
import { downloadSheets } from '@/features/products/spreadsheet'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDate, formatDateTime, formatNumber, parseIsoDate, toIsoDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EXPORT_LIMIT, fetchAllDrillRows, fetchDrillPage, fetchStockValueSummary } from '@/services/drilldown'
import { KpiCard } from '@/components/common/kpi-card'

const PAGE_SIZES = [25, 50, 100]
const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')

function cellText(col: DrillColumn, row: Record<string, unknown>): string {
  const v = columnValue(col, row)
  if (v === null || v === undefined || v === '') return col.empty?.(row) ?? '—'
  switch (col.kind) {
    case 'money': return money(Number(v))
    case 'number': return formatNumber(Number(v))
    case 'date': return formatDate(String(v))
    case 'datetime': return formatDateTime(String(v))
    case 'status': return humanize(String(v))
    case 'bool': return v ? 'Yes' : 'No'
    default: return String(v)
  }
}
/** Excel cell: numbers stay numbers. */
function cellExport(col: DrillColumn, row: Record<string, unknown>): string | number | null {
  const v = columnValue(col, row)
  if (v === null || v === undefined || v === '') return col.empty?.(row) ?? null
  if (col.kind === 'money' || col.kind === 'number') return Number(v)
  return cellText(col, row)
}

/**
 * /drilldown/:metric — the records behind a dashboard figure.
 * The figure's definition (drill-registry) filters, counts and pages them on the server, under the
 * user's RLS and permissions; the count shown here is the dashboard's number.
 */
export default function DrilldownPage() {
  const { metric: key = '' } = useParams()
  const metric = METRICS[key]
  const { hasAny } = usePermissions()
  if (!metric) {
    return (
      <>
        <PageHeader title="Figure not found" breadcrumbs={[{ label: 'Dashboards' }]} />
        <Card><EmptyState title="This dashboard figure does not exist" description="The link may be out of date." action={<Button asChild variant="outline"><Link to="/">Management Dashboard</Link></Button>} /></Card>
      </>
    )
  }
  if (!hasAny(metric.permissions as PermissionCode[])) {
    return (
      <>
        <PageHeader title="Access denied" description="Your role does not include access to these records." breadcrumbs={[{ label: 'Dashboards' }]} />
        <Card><EmptyState icon={ShieldX} title="You don't have permission to view these records" description="If you need access, ask an administrator to update your role." /></Card>
      </>
    )
  }
  return <Drilldown key={key} metricKey={key} />
}

function Drilldown({ metricKey }: { metricKey: string }) {
  const metric = METRICS[metricKey]
  const source = SOURCES[metric.source]
  const columns = COLUMNS[metric.source]
  const navigate = useNavigate()
  const clock = useCompanyClock()
  const [params, setParams] = useSearchParams()
  const ctx: DrillContext = useMemo(() => contextFromParams(params, clock), [params, clock])
  const via = params.get('via') as DashboardKey | null
  const dash = via && via in DASHBOARDS ? via : metric.dashboard
  const search = params.get('q') ?? ''
  const page = Math.max(0, Number(params.get('page') ?? 0) || 0)
  const size = PAGE_SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : 25
  const sortParam = params.get('sort')
  const sort = sortParam ? { column: sortParam.replace(/^-/, ''), ascending: !sortParam.startsWith('-') } : null
  const [draft, setDraft] = useState(search)
  const [refresh, setRefresh] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [visible, setVisible] = useState(() => new Set(columns.filter((c) => c.visible !== false).map((c) => c.key)))

  const update = (changes: Record<string, string | null>, resetPage = true) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === '') next.delete(k)
        else next.set(k, v)
      }
      if (resetPage) next.delete('page')
      return next
    }, { replace: true })
  }

  // Search runs on the server, a moment after typing stops.
  useEffect(() => {
    if (draft === search) return
    const t = window.setTimeout(() => update({ q: draft.trim() || null }), 350)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const query = useMemo(() => ({ search, sort, page, pageSize: size }), [search, sort?.column, sort?.ascending, page, size]) // eslint-disable-line react-hooks/exhaustive-deps
  const data = useAsync(() => fetchDrillPage(metric, ctx, query), [metricKey, ctx, query, refresh])
  const shown = columns.filter((c) => visible.has(c.key))
  const link = RECORD_LINK[metric.source]
  const uses = new Set(metric.uses ?? [])
  const total = data.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / size))
  const backTo = dashboardHref(dash, ctx)

  const chips: { label: string; param: string[] }[] = []
  if (uses.has('unit') && ctx.unit) chips.push({ label: `Unit: ${ctx.unit}`, param: ['unit'] })
  if (uses.has('customer') && ctx.customer) chips.push({ label: 'Customer chosen on the dashboard', param: ['customer'] })
  if (uses.has('status') && ctx.status) chips.push({ label: `Status: ${humanize(ctx.status)}`, param: ['status'] })
  if (uses.has('payment') && ctx.payment) chips.push({ label: `Payment: ${humanize(ctx.payment)}`, param: ['payment'] })
  const fixed: string[] = []
  if (uses.has('segment') && ctx.segment) fixed.push(ctx.segment)
  if (uses.has('segmentRange') && (ctx.segFrom || ctx.segTo)) fixed.push(`${formatDate(ctx.segFrom ?? ctx.from)} – ${formatDate(ctx.segTo ?? ctx.to)}`)
  if (uses.has('today')) fixed.push(`As of ${formatDate(ctx.today)}`)
  const filtered = Boolean(search) || chips.length > 0

  const clearFilters = () => {
    setDraft('')
    update({ q: null, unit: null, customer: null, status: null, payment: null })
  }

  const exportExcel = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const rows = await fetchAllDrillRows(metric, ctx, { search, sort })
      const cols = columns.filter((c) => visible.has(c.key))
      await downloadSheets([{ name: metric.label, rows: [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => cellExport(c, r)))] }],
        `${metric.label.replace(/[^\w-]+/g, '-')}-${ctx.today}`, 'xlsx')
    } catch (e) {
      setExportError(describeDataError(e))
    } finally {
      setExporting(false)
    }
  }

  const sortBy = (col: DrillColumn) => {
    if (col.sortable === false || col.get) return
    const current = sort ?? source.sort
    const asc = current.column === col.key ? !current.ascending : true
    update({ sort: `${asc ? '' : '-'}${col.key}` })
  }
  const activeSort = sort ?? source.sort

  const measureText = () => {
    const d = data.data
    if (!d || metric.measure.kind !== 'sum') return null
    if (d.unitTotals && metric.measure.format === 'quantity') return d.unitTotals.map((u) => `${formatNumber(u.quantity)} ${u.unit}`).join(' · ') || '0'
    if (d.measureTotal === null) return 'Too many records to total here — export to Excel for the full total.'
    return metric.measure.format === 'money' ? money(d.measureTotal) : formatNumber(d.measureTotal)
  }

  return (
    <>
      <PageHeader
        title={metric.label}
        description={metric.definition}
        breadcrumbs={[{ label: DASHBOARDS[dash].department }, { label: DASHBOARDS[dash].label, to: backTo }, { label: metric.label }]}
        actions={<>
          <Button variant="outline" size="icon" aria-label="Refresh" onClick={() => setRefresh((n) => n + 1)}><RefreshCw className={data.loading ? 'animate-spin' : undefined} /></Button>
          <Button variant="outline" onClick={() => void exportExcel()} disabled={exporting || !total}><Download /> {exporting ? 'Exporting…' : 'Export to Excel'}</Button>
          <Button variant="outline" onClick={() => window.print()} disabled={!total}><Printer /> Print / PDF</Button>
          <Button variant="ghost" asChild><Link to={MODULE_LIST[metric.source].path}><ExternalLink /> {MODULE_LIST[metric.source].label}</Link></Button>
        </>}
      />

      <Card className="mb-4" data-testid="drill-summary">
        <CardContent className="flex flex-wrap items-start justify-between gap-4 py-4">
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">From the {DASHBOARDS[dash].label}</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid="drill-count">{data.data ? formatNumber(total) : '…'} <span className="text-base font-normal text-muted-foreground">record{total === 1 ? '' : 's'}</span></p>
            {metric.measure.kind === 'sum' && data.data && <p className="text-sm" data-testid="drill-total">Total: <span className="font-medium tabular-nums">{measureText()}</span></p>}
            <p className="text-xs text-muted-foreground">Rule: {describeConditions(metric.conditions(ctx)).join(' · ') || 'all records'}{filtered ? ' · plus the filters below' : ''}</p>
          </div>
          {uses.has('period') && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Period</p>
              <DateRangeFilter value={{ preset: 'custom', from: parseIsoDate(ctx.from), to: parseIsoDate(ctx.to) }}
                onChange={(r) => update({ from: toIsoDate(r.from), to: toIsoDate(r.to) })} />
            </div>
          )}
        </CardContent>
      </Card>

      {metric.summary === 'stock_value' && <StockValueSummary unit={uses.has('unit') ? ctx.unit ?? null : null} search={search} refresh={refresh} />}

      <div className="mb-3 flex flex-wrap items-center gap-2 print:hidden">
        <div className="relative w-full sm:w-72">
          <Search aria-hidden className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search…" aria-label="Search records" value={draft} onChange={(e) => setDraft(e.target.value)} />
        </div>
        {fixed.map((f) => <span key={f} className="rounded-full border bg-surface-muted px-2.5 py-1 text-xs">{f}</span>)}
        {chips.map((c) => (
          <span key={c.label} className="inline-flex items-center gap-1 rounded-full border bg-blue-50 px-2.5 py-1 text-xs text-blue-900" data-testid="drill-chip">
            <Filter aria-hidden className="size-3" /> {c.label}
            <button type="button" aria-label={`Remove ${c.label}`} className="rounded hover:bg-blue-100" onClick={() => update(Object.fromEntries(c.param.map((p) => [p, null])))}><X className="size-3" /></button>
          </span>
        ))}
        {filtered && <Button variant="ghost" size="sm" onClick={clearFilters}><X /> Clear filters</Button>}
        <div className="ml-auto">
          <Popover>
            <PopoverTrigger asChild><Button variant="outline" size="sm"><Columns3 /> Columns</Button></PopoverTrigger>
            <PopoverContent align="end" className="w-56 space-y-1.5">
              {columns.map((c) => (
                <label key={c.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={visible.has(c.key)} disabled={visible.has(c.key) && visible.size === 1}
                    onCheckedChange={(v) => setVisible((s) => { const n = new Set(s); if (v) n.add(c.key); else n.delete(c.key); return n })} />
                  {c.label}
                </label>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {exportError && <p role="alert" className="mb-2 text-sm text-red-700">{exportError}</p>}
      {total >= EXPORT_LIMIT && <p className="mb-2 text-xs text-muted-foreground">Excel export is limited to the first {formatNumber(EXPORT_LIMIT)} records.</p>}

      <Card className="overflow-hidden p-0">
        {data.loading && !data.data ? <LoadingState variant="table" rows={8} />
          : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
          : !total ? <EmptyState title="No records" description={filtered ? 'Nothing matches the search and filters.' : 'There are no records behind this figure.'}
              action={filtered ? <Button variant="outline" onClick={clearFilters}>Clear filters</Button> : <Button asChild variant="outline"><Link to={backTo}>Back to the dashboard</Link></Button>} />
          : (
            <div className={cn('overflow-x-auto', data.loading && 'opacity-60')}>
              <table className="w-full text-sm" aria-label={`${metric.label} records`} data-testid="drill-table">
                <thead className="bg-surface-muted text-xs text-muted-foreground">
                  <tr>{shown.map((c) => {
                    const sortable = c.sortable !== false && !c.get
                    const active = activeSort.column === c.key
                    const numeric = c.kind === 'money' || c.kind === 'number'
                    return (
                      <th key={c.key} scope="col" aria-sort={active ? (activeSort.ascending ? 'ascending' : 'descending') : undefined}
                        className={cn('px-3 py-2 font-medium whitespace-nowrap', numeric ? 'text-right' : 'text-left')}>
                        {sortable ? (
                          <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(c)}>
                            {c.label}{active && (activeSort.ascending ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                          </button>
                        ) : c.label}
                      </th>
                    )
                  })}</tr>
                </thead>
                <tbody>{data.data!.rows.map((r, i) => {
                  const to = link(r)
                  return (
                    <tr key={String(r[source.id] ?? i)} className={cn('border-t', to && 'cursor-pointer hover:bg-surface-muted/60')}
                      onClick={to ? (e) => { if (!(e.target as HTMLElement).closest('a')) navigate(to) } : undefined}>
                      {shown.map((c, ci) => (
                        <td key={c.key} className={cn('px-3 py-2', c.kind === 'money' || c.kind === 'number' ? 'text-right tabular-nums whitespace-nowrap' : 'max-w-72 truncate')}>
                          {ci === 0 && to ? <Link to={to} className="font-medium text-primary hover:underline">{cellText(c, r)}</Link> : cellText(c, r)}
                          {c.note?.(r) && <span className="ml-1 text-xs text-muted-foreground">({c.note(r)})</span>}
                        </td>
                      ))}
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
          )}
      </Card>

      {total > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm print:hidden">
          <span className="text-muted-foreground">
            {formatNumber(page * size + 1)}–{formatNumber(Math.min((page + 1) * size, total))} of {formatNumber(total)}
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-muted-foreground">Rows
              <select className="rounded-md border bg-background px-1.5 py-1 text-sm" value={size} onChange={(e) => update({ size: e.target.value })} aria-label="Rows per page">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => update({ page: String(page - 1) }, false)}>Previous</Button>
            <span className="tabular-nums">Page {page + 1} of {pages}</span>
            <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => update({ page: String(page + 1) }, false)}>Next</Button>
          </div>
        </div>
      )}
    </>
  )
}

const unitsText = (list: { unit: string; quantity: number }[]) => list.filter((u) => u.quantity !== 0).map((u) => `${formatNumber(u.quantity)} ${u.unit}`).join(' · ') || '0'

/**
 * Summary cards of the Total Stock drill-down, added up on the server (inventory_stock_value_summary)
 * over exactly the records listed: the same unit filter and search.
 */
function StockValueSummary({ unit, search, refresh }: { unit: string | null; search: string; refresh: number }) {
  const s = useAsync(() => fetchStockValueSummary(unit, search), [unit, search, refresh])
  if (s.error) return <p role="alert" className="mb-4 text-sm text-red-700" data-testid="stock-value-error">Stock value totals could not be loaded: {describeDataError(s.error)}</p>
  const d = s.data
  const units = (k: 'on_hand' | 'reserved' | 'available') => (d ? unitsText(d.units.map((u) => ({ unit: u.unit, quantity: Number(u[k]) }))) : '…')
  const notValued = d ? d.not_valued_products + d.partly_valued_products : 0
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6" data-testid="stock-value-summary">
      <KpiCard testId="sv-products" icon={Boxes} label="Total Products" value={d ? formatNumber(d.products) : '…'} />
      <KpiCard testId="sv-on-hand" icon={Warehouse} label="Total On Hand Quantity" value={units('on_hand')} />
      <KpiCard testId="sv-reserved" icon={Lock} accent="pending" label="Total Reserved Quantity" value={units('reserved')} />
      <KpiCard testId="sv-available" icon={PackageCheck} accent="available" label="Total Available Quantity" value={units('available')} />
      <KpiCard testId="sv-value" icon={IndianRupee} label="Total Inventory Value (₹)" value={d ? money(Number(d.total_value)) : '…'}
        hint={d ? (notValued ? `Average inventory cost · ${formatNumber(notValued)} product(s) not fully valued (no cost recorded)` : 'Average inventory cost, as in the stock reports') : undefined} />
      {/* Stock without a cost: counted in the quantities, never in the value (no cost is assumed). */}
      <KpiCard testId="sv-unvalued" icon={CircleDashed} accent={d?.unvalued_units?.some((u) => Number(u.quantity) !== 0) ? 'pending' : 'neutral'} label="Quantity Not Valued (Pending Cost)"
        value={d ? (d.unvalued_units ? unitsText(d.unvalued_units.map((u) => ({ unit: u.unit, quantity: Number(u.quantity) }))) : '—') : '…'}
        hint="Recorded without a cost; excluded from the value until a cost is set" />
    </div>
  )
}
