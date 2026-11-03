import { Boxes } from 'lucide-react'
import { useMemo, useState } from 'react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { AmazonToolbar, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import type { ProductAnalysis } from '@/features/amazon/analysis'
import { money, num, STOCK_LABEL } from '@/features/amazon/format'
import { DEFINITIONS, forecastDemand, replenishment, type DemandForecast } from '@/features/amazon/metrics'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { SelectFilter } from '@/features/analytics/analytics-ui'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'

type Row = ProductAnalysis & { forecast: DemandForecast; repl: { quantity: number | null; reason: string } }

export default function AmazonInventoryPage() {
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { refresh })
  const [horizon, setHorizon] = useState('30')
  const [status, setStatus] = useState('all')
  const d = data.data
  const rows = useMemo<Row[]>(() => (d?.products ?? []).map((p) => ({
    ...p,
    forecast: forecastDemand(p.row.velocity?.daily_28 ?? [], Number(horizon)),
    repl: replenishment({ available: p.stockForCover, incoming: p.row.stock.incoming_production, avgDaily: p.avgDailyUnits, leadTimeDays: p.row.lead_time_days,
      safetyDays: d!.settings.low_stock_cover_days, minStock: p.row.min_stock }),
  })), [d, horizon])
  const shown = rows.filter((r) => status === 'all' || r.stockStatus === status)
  const columns: DataTableColumn<Row>[] = [
    { id: 'sku', header: 'SKU', cell: (r) => <div><p className="font-medium">{r.sku}</p><p className="line-clamp-1 max-w-48 text-xs text-muted-foreground">{r.label}</p></div>,
      searchValue: (r) => `${r.sku} ${r.label}`, sortValue: (r) => r.sku },
    { id: 'amz', header: 'Amazon fulfillable / inbound', align: 'right', cell: (r) => <div><Val v={r.row.stock.amazon_fulfillable === null ? null : `${num(r.row.stock.amazon_fulfillable)} / ${num(r.row.stock.amazon_inbound ?? 0)}`} title="Not synchronised" />
      <p className="text-xs text-muted-foreground">{r.row.stock.amazon_as_of ? `${r.row.stock.amazon_source ?? ''} ${formatDateTime(r.row.stock.amazon_as_of)}` : ''}</p></div> },
    { id: 'erp', header: 'ERP available', align: 'right', cell: (r) => <div><Val v={num(r.row.stock.erp_available)} title={r.row.product_id ? 'No stock record' : 'Listing not mapped'} />
      <p className="text-xs text-muted-foreground">{r.row.stock.erp_as_of ? formatDateTime(r.row.stock.erp_as_of) : ''}</p></div> },
    { id: 'inc', header: 'Incoming production', align: 'right', cell: (r) => <Val v={num(r.row.stock.incoming_production)} title="None / not mapped" /> },
    { id: 'vel', header: 'Units 7 / 28 / 56 d', align: 'right', cell: (r) => r.row.velocity ? `${num(r.row.velocity.units_7)} / ${num(r.row.velocity.units_28)} / ${num(r.row.velocity.units_56)}` : <Val v={null} title="No sales data" /> },
    { id: 'avg', header: 'Avg / day', align: 'right', cell: (r) => <Val v={num(r.avgDailyUnits, 2)} title="No sales history" />, sortValue: (r) => r.avgDailyUnits },
    { id: 'cover', header: 'Cover (days)', align: 'right', cell: (r) => <span title={`Based on ${r.stockSource === 'AMAZON' ? 'Amazon fulfillable' : r.stockSource === 'ERP' ? 'ERP available' : 'no'} stock`}><Val v={num(r.stockCover)} title="No stock or no sales" /></span>,
      sortValue: (r) => r.stockCover },
    { id: 'fc', header: `Demand next ${horizon} d (80% range)`, align: 'right', cell: (r) => <div><Val v={r.forecast.expected === null ? null : `${num(r.forecast.expected)} (${num(r.forecast.low)}–${num(r.forecast.high)})`} title={r.forecast.basis} />
      {r.forecast.expected !== null && !r.forecast.reliable && <p className="text-xs text-amber-700">Fewer than 14 days of data</p>}</div> },
    { id: 'lead', header: 'Lead time', align: 'right', cell: (r) => <Val v={r.row.lead_time_days === null ? null : `${r.row.lead_time_days} d`} title="Set in Profitability > Product mapping & costs" /> },
    { id: 'repl', header: 'Replenish', align: 'right', cell: (r) => <div title={r.repl.reason}><Val v={num(r.repl.quantity)} title={r.repl.reason} />
      {r.repl.quantity !== null && <p className="max-w-40 text-xs text-muted-foreground">{r.repl.reason}</p>}</div>, sortValue: (r) => r.repl.quantity },
    { id: 'ads', header: 'Ad spend (period)', align: 'right', cell: (r) => money(r.ads.spend), sortValue: (r) => r.ads.spend },
    { id: 'status', header: 'Status', cell: (r) => <div className="flex flex-col gap-1"><StatusBadge label={STOCK_LABEL[r.stockStatus][0]} tone={STOCK_LABEL[r.stockStatus][1]} />
      {(r.stockStatus === 'STOCKOUT_RISK' || r.stockStatus === 'LOW') && r.ads.spend > 0 && <span className="text-xs text-shortage">Advertised while low on stock</span>}
      {r.stockStatus === 'OVERSTOCK' && r.ads.spend === 0 && <span className="text-xs text-muted-foreground">Overstocked, not advertised</span>}</div> },
  ]
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {data.loading && !d ? <LoadingState variant="table" rows={8} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              Velocity uses the last 28 days of Amazon sales (independent of the selected period). {DEFINITIONS.stockCover} Low stock: below {d?.settings.low_stock_cover_days} days or the lead time;
              overstock: above {d?.settings.overstock_cover_days} days. Replenishment quantities are shown only when a lead time is set. Forecasts are averages with a range, not promises.
            </p>
            <DataTable title="Inventory and demand" columns={columns} data={shown} getRowId={(r) => r.sku} pageSize={25} searchPlaceholder="Search SKU or name"
              toolbar={<div className="flex flex-wrap gap-2">
                <SelectFilter id="inv-h" label="Forecast horizon" value={horizon === '30' ? null : horizon} onChange={(v) => setHorizon(v ?? '30')} allLabel="30 days"
                  options={[{ value: '14', label: '14 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }]} />
                <SelectFilter id="inv-s" label="Stock status" value={status} onChange={(v) => setStatus(v ?? 'all')} options={Object.entries(STOCK_LABEL).map(([v, [l]]) => ({ value: v, label: l }))} />
              </div>}
              emptyState={{ icon: Boxes, title: 'No listings match', description: 'Change the filter.' }} />
          </>
        )}
    </>
  )
}
