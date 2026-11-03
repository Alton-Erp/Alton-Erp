import { HeartPulse } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { AmazonToolbar, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import type { ProductAnalysis } from '@/features/amazon/analysis'
import { money, num, pctText } from '@/features/amazon/format'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { SelectFilter } from '@/features/analytics/analytics-ui'
import { describeDataError } from '@/lib/errors'

type Severity = 'critical' | 'warning' | 'info'
interface Check { code: string; label: string; severity: Severity }
type Row = ProductAnalysis & { checks: Check[] }

const SEV_TONE = { critical: 'danger', warning: 'warning', info: 'info' } as const

/** Rule-based checks on data the ERP actually has; no listing-quality score is invented. */
function checksFor(p: ProductAnalysis, medianConv: number | null): Check[] {
  const out: Check[] = []
  const status = (p.row.listing_status ?? '').toUpperCase()
  if (status && !['ACTIVE', 'BUYABLE', 'DISCOVERABLE'].some((s) => status.includes(s))) out.push({ code: 'INACTIVE', label: `Listing status: ${p.row.listing_status}`, severity: 'critical' })
  if (p.row.stock.amazon_fulfillable !== null && p.row.stock.amazon_fulfillable <= 0 && p.row.fulfillment_channel?.toUpperCase().includes('AMAZON')) out.push({ code: 'FBA_OOS', label: 'No fulfillable FBA stock', severity: 'critical' })
  if (p.stockStatus === 'STOCKOUT_RISK') out.push({ code: 'STOCKOUT', label: 'Stockout risk', severity: 'critical' })
  if (!p.row.asin) out.push({ code: 'NO_ASIN', label: 'ASIN unknown', severity: 'warning' })
  if (p.row.item_price === null) out.push({ code: 'NO_PRICE', label: 'Price unknown', severity: 'warning' })
  if (!p.row.product_id && p.row.data_source !== 'DEMO') out.push({ code: 'UNMAPPED', label: 'Not mapped to an ERP product', severity: 'warning' })
  if (p.row.cost_source === 'MISSING') out.push({ code: 'NO_COST', label: 'Product cost missing', severity: 'warning' })
  if (p.row.gst_source === 'MISSING') out.push({ code: 'NO_GST', label: 'GST rate missing', severity: 'warning' })
  if (p.costsOutdated) out.push({ code: 'OLD_COST', label: 'Cost override older than 180 days', severity: 'info' })
  if ((p.sessions ?? 0) >= 100 && p.sessionConversion !== null && medianConv !== null && p.sessionConversion < medianConv * 0.5)
    out.push({ code: 'LOW_CONV', label: `Conversion ${pctText(p.sessionConversion)} vs median ${pctText(medianConv)}: review images, price, reviews and content`, severity: 'warning' })
  if (p.sessions !== null && p.sessions === 0 && status.includes('ACTIVE')) out.push({ code: 'NO_TRAFFIC', label: 'No sessions in the period', severity: 'info' })
  if (p.row.lead_time_days === null) out.push({ code: 'NO_LEAD', label: 'Lead time not set (no replenishment advice)', severity: 'info' })
  return out
}

export default function AmazonListingHealthPage() {
  const navigate = useNavigate()
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { refresh })
  const [sev, setSev] = useState('all')
  const d = data.data
  const rows = useMemo<Row[]>(() => {
    const convs = (d?.products ?? []).filter((p) => (p.sessions ?? 0) >= 100 && p.sessionConversion !== null).map((p) => p.sessionConversion!).sort((a, b) => a - b)
    const median = convs.length ? convs[Math.floor(convs.length / 2)] : null
    return (d?.products ?? []).map((p) => ({ ...p, checks: checksFor(p, median) }))
  }, [d])
  const shown = rows.filter((r) => sev === 'all' ? true : sev === 'ok' ? r.checks.length === 0 : r.checks.some((c) => c.severity === sev))
  const count = (s: Severity) => rows.filter((r) => r.checks.some((c) => c.severity === s)).length
  const columns: DataTableColumn<Row>[] = [
    { id: 'sku', header: 'SKU / ASIN', cell: (r) => <div><p className="font-medium">{r.sku}</p><p className="text-xs text-muted-foreground">{r.row.asin ?? 'no ASIN'} · {r.row.fulfillment_channel ?? ''}</p></div>,
      searchValue: (r) => `${r.sku} ${r.row.asin ?? ''} ${r.label}`, sortValue: (r) => r.sku },
    { id: 'title', header: 'Title', cell: (r) => <span className="line-clamp-2 max-w-60 text-xs">{r.label}</span> },
    { id: 'status', header: 'Listing status', cell: (r) => <Val v={r.row.listing_status} title="Not synchronised" /> },
    { id: 'price', header: 'Price', align: 'right', cell: (r) => <Val v={money(r.row.item_price)} /> },
    { id: 'sessions', header: 'Sessions', align: 'right', cell: (r) => <Val v={num(r.sessions)} title="No traffic data" />, sortValue: (r) => r.sessions },
    { id: 'conv', header: 'Unit session %', align: 'right', cell: (r) => <Val v={pctText(r.sessionConversion)} />, sortValue: (r) => r.sessionConversion },
    { id: 'checks', header: 'Findings', cell: (r) => r.checks.length === 0 ? <StatusBadge label="No issues found" tone="success" />
      : <div className="flex max-w-96 flex-wrap gap-1">{r.checks.map((c) => <StatusBadge key={c.code} label={c.label} tone={SEV_TONE[c.severity]} />)}</div>,
      sortValue: (r) => r.checks.filter((c) => c.severity === 'critical').length * 10 + r.checks.length },
  ]
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {data.loading && !d ? <LoadingState variant="table" rows={8} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : (
          <>
            <div className="mb-3 flex flex-wrap gap-2 text-sm">
              <StatusBadge label={`${count('critical')} critical`} tone="danger" /><StatusBadge label={`${count('warning')} warnings`} tone="warning" />
              <StatusBadge label={`${rows.filter((r) => !r.checks.length).length} without findings`} tone="success" />
            </div>
            <p className="mb-3 text-sm text-muted-foreground">Checks use synchronised listing, traffic, stock and cost data. Amazon's own listing-quality, suppression reasons, Buy Box and review data are not synchronised
              in this version and are not estimated.</p>
            <DataTable title="Listing health" columns={columns} data={shown} getRowId={(r) => r.sku} pageSize={25} searchPlaceholder="Search SKU, ASIN or title"
              onRowClick={(r) => navigate(`/amazon/products/${encodeURIComponent(r.sku)}`)}
              toolbar={<SelectFilter id="lh-sev" label="Findings" value={sev} onChange={(v) => setSev(v ?? 'all')}
                options={[{ value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warnings' }, { value: 'info', label: 'Information' }, { value: 'ok', label: 'No issues' }]} />}
              emptyState={{ icon: HeartPulse, title: 'No listings match', description: 'Change the filter.' }} />
          </>
        )}
    </>
  )
}
