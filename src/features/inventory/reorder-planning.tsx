import { AlertTriangle, CalendarClock, Download, Loader2, PackageSearch, ShoppingCart, Timer } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { usePermissions } from '@/auth/use-permissions'
import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { FilterTabs } from '@/components/common/filter-tabs'
import { KpiCard } from '@/components/common/kpi-card'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatQty } from '@/features/inventory/inventory-model'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime, formatNumber, toIsoDate } from '@/lib/format'
import { REORDER_STATUS_LABELS, reorderPlanSheet, type ReorderStatus } from '@/features/inventory/reorder-model'
import { fetchReorderPlan, type ReorderPlanRow } from '@/services/inventory'

const TONE: Record<ReorderStatus, 'danger' | 'success' | 'neutral' | 'warning'> = { REORDER: 'danger', OK: 'success', NO_CONSUMPTION: 'neutral', NOT_CONFIGURED: 'warning' }
type Filter = 'ALL' | ReorderStatus
const days = (v: number | null) => (v === null ? '—' : `${formatNumber(Number(v))} d`)

/**
 * Day-based reorder planning: average daily consumption (stock issued, less
 * reversals) over a history window, days of cover = available ÷ average, and
 * a recommendation when the cover reaches the product's reorder level in days.
 */
export function ReorderPlanningPanel({ initialQuery }: { initialQuery?: string }) {
  const { has } = usePermissions()
  const [history, setHistory] = useState('90')
  const [filter, setFilter] = useState<Filter>('ALL')
  const [exporting, setExporting] = useState(false)
  const plan = useAsync(() => fetchReorderPlan(Number(history)), [history])
  const rows = (plan.data?.rows ?? []).filter((r) => filter === 'ALL' || r.status === filter)
  const s = plan.data?.summary

  const columns: DataTableColumn<ReorderPlanRow>[] = [
    { id: 'product', header: 'Product', className: 'min-w-48 whitespace-normal', searchValue: (r) => `${r.sku} ${r.product_name}`, sortValue: (r) => r.sku,
      cell: (r) => <span><Link className="font-medium text-primary hover:underline" to={`/inventory/stock/${r.product_id}`}>{r.sku}</Link> {r.product_name}</span> },
    { id: 'status', header: 'Recommendation', sortValue: (r) => ['REORDER', 'OK', 'NO_CONSUMPTION', 'NOT_CONFIGURED'].indexOf(r.status), searchValue: (r) => REORDER_STATUS_LABELS[r.status],
      cell: (r) => (
        <span className="text-xs">
          <StatusBadge label={REORDER_STATUS_LABELS[r.status]} tone={TONE[r.status]} />
          {r.runs_out_within_lead_time && <span className="mt-1 flex items-center gap-1 text-shortage"><AlertTriangle className="size-3" /> may run out before a new order arrives</span>}
          {r.limited_history && r.status !== 'NO_CONSUMPTION' && <span className="mt-1 block text-muted-foreground">only {r.observed_days} day(s) of history</span>}
        </span>
      ) },
    { id: 'av', header: 'Available', align: 'right', sortValue: (r) => Number(r.available), cell: (r) => <span className="font-medium">{formatQty(r.available, r.unit)}</span> },
    { id: 'res', header: 'Reserved', align: 'right', cell: (r) => formatQty(r.reserved) },
    { id: 'inc', header: 'Incoming', align: 'right', sortValue: (r) => Number(r.incoming),
      cell: (r) => (Number(r.incoming) > 0 ? <span title={`${r.open_orders} open purchase order(s)`}>{formatQty(r.incoming)}</span> : '—') },
    { id: 'avg', header: 'Avg / day', align: 'right', sortValue: (r) => r.avg_daily, cell: (r) => (r.avg_daily === null ? '—' : formatQty(r.avg_daily)) },
    { id: 'cover', header: 'Days of cover', align: 'right', sortValue: (r) => r.coverage_days,
      cell: (r) => (r.coverage_days === null ? '—' : (
        <span className={r.status === 'REORDER' ? 'font-medium text-shortage' : undefined}>{days(r.coverage_days)}
          {Number(r.incoming) > 0 && r.coverage_with_incoming_days !== null && <span className="block text-xs text-muted-foreground">{days(r.coverage_with_incoming_days)} with incoming</span>}</span>
      )) },
    { id: 'reorder', header: 'Reorder at', align: 'right', sortValue: (r) => r.reorder_level_days, cell: (r) => days(r.reorder_level_days) },
    { id: 'lead', header: 'Lead time', align: 'right', sortValue: (r) => r.lead_time_days, cell: (r) => days(r.lead_time_days) },
    { id: 'suggest', header: 'Suggested order', align: 'right', sortValue: (r) => r.suggested_quantity,
      cell: (r) => (r.suggested_quantity === null ? '—' : Number(r.suggested_quantity) === 0
        ? <span className="text-xs text-muted-foreground">covered by open orders</span>
        : <span className="font-medium">{formatQty(r.suggested_quantity, r.unit)}</span>) },
  ]

  const exportExcel = async () => {
    setExporting(true)
    try {
      const { downloadSheets } = await import('@/features/products/spreadsheet')
      await downloadSheets([{ name: 'Reorder planning', rows: reorderPlanSheet(rows) }], `reorder-planning-${toIsoDate(new Date())}`, 'xlsx')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Days of cover = available stock (on hand less reserved) ÷ average daily consumption over the last {history} days. Consumption is stock issued
        (sales dispatches, production and subcontract issues) less reversals; products without consumption have no cover figure. A product is
        flagged when its cover reaches its <span className="font-medium">Reorder Level (Days)</span>. The suggested quantity brings the cover, after what is
        already on order, up to lead time + reorder level.
      </p>
      <section aria-label="Reorder planning summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Reorder now" value={s ? formatNumber(s.reorder) : null} hint="Cover at or below the reorder level" icon={ShoppingCart} accent={s && s.reorder > 0 ? 'shortage' : 'neutral'} />
        <KpiCard label="Enough cover" value={s ? formatNumber(s.ok) : null} icon={CalendarClock} accent="available" />
        <KpiCard label="No consumption" value={s ? formatNumber(s.no_consumption) : null} hint={`Nothing issued in ${history} days`} icon={PackageSearch} />
        <KpiCard label="Not configured" value={s ? formatNumber(s.not_configured) : null} hint="No reorder level in days" icon={Timer} accent={s && s.not_configured > 0 ? 'pending' : 'neutral'} />
      </section>
      <DataTable
        title="Reorder planning"
        description={plan.data ? `Calculated ${formatDateTime(plan.data.as_of)} from posted stock movements and open purchase orders.` : undefined}
        columns={columns}
        data={rows}
        getRowId={(r) => r.product_id}
        loading={plan.loading}
        error={plan.error ? new Error(describeDataError(plan.error)) : null}
        onRetry={plan.reload}
        pageSize={25}
        initialQuery={initialQuery}
        searchPlaceholder="Search SKU or product…"
        toolbar={
          <>
            <FilterTabs<Filter> label="Recommendation" value={filter} onChange={setFilter}
              options={[{ value: 'ALL', label: 'All' }, { value: 'REORDER', label: 'Reorder now' }, { value: 'OK', label: 'Enough cover' },
                { value: 'NO_CONSUMPTION', label: 'No consumption' }, { value: 'NOT_CONFIGURED', label: 'Not configured' }]} />
            <Select value={history} onValueChange={setHistory}>
              <SelectTrigger className="h-8 w-40" aria-label="Consumption history"><SelectValue /></SelectTrigger>
              <SelectContent>{['30', '60', '90', '180', '365'].map((d) => <SelectItem key={d} value={d}>Last {d} days</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void exportExcel()} disabled={exporting || rows.length === 0}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />} Export
            </Button>
          </>
        }
        emptyState={{ icon: CalendarClock, title: 'No active products', description: has('products.update') ? 'Set Lead Time and Reorder Level (Days) on products to plan by days of cover.' : 'Products appear here once added.' }}
      />
    </div>
  )
}
