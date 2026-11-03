import { Megaphone } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { AmazonToolbar, DataCoverage, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import type { CampaignAnalysis } from '@/features/amazon/analysis'
import { campaignHealth, money, num, pctText } from '@/features/amazon/format'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { SelectFilter } from '@/features/analytics/analytics-ui'
import { describeDataError } from '@/lib/errors'


export default function AmazonCampaignsPage() {
  const navigate = useNavigate()
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { campaigns: true, refresh })
  const [state, setState] = useState('all')
  const d = data.data
  const rows = (d?.campaigns ?? []).filter((c) => state === 'all' || c.row.state === state)
  const columns: DataTableColumn<CampaignAnalysis>[] = [
    { id: 'name', header: 'Campaign', cell: (c) => <div><p className="font-medium">{c.row.name}</p><p className="text-xs text-muted-foreground">{c.row.targeting_type ?? ''} · {c.row.state} · {c.row.data_source}</p></div>,
      searchValue: (c) => c.row.name, sortValue: (c) => c.row.name },
    { id: 'budget', header: 'Daily budget', align: 'right', cell: (c) => <Val v={money(c.row.daily_budget)} />, sortValue: (c) => c.row.daily_budget },
    { id: 'util', header: 'Utilisation / capped days', align: 'right', cell: (c) => <span><Val v={pctText(c.budgetUtilisation)} /> <span className="text-xs text-muted-foreground">{c.row.budget_constrained_days}/{c.row.days_with_data} d</span></span>,
      sortValue: (c) => c.budgetUtilisation },
    { id: 'imp', header: 'Impressions', align: 'right', cell: (c) => num(c.row.impressions), sortValue: (c) => c.row.impressions },
    { id: 'clicks', header: 'Clicks / CTR', align: 'right', cell: (c) => <span>{num(c.row.clicks)} <span className="text-xs text-muted-foreground">{pctText(c.ctr, 2) ?? ''}</span></span>, sortValue: (c) => c.row.clicks },
    { id: 'cpc', header: 'CPC', align: 'right', cell: (c) => <Val v={money(c.cpc, true)} />, sortValue: (c) => c.cpc },
    { id: 'spend', header: 'Spend', align: 'right', cell: (c) => money(c.row.spend), sortValue: (c) => c.row.spend },
    { id: 'sales', header: 'Attributed sales / orders', align: 'right', cell: (c) => <span>{money(c.row.sales)} <span className="text-xs text-muted-foreground">{num(c.row.orders)} orders</span></span>, sortValue: (c) => c.row.sales },
    { id: 'acos', header: 'ACoS / ROAS', align: 'right', cell: (c) => <span><Val v={pctText(c.acos)} title="No attributed sales" /> / <Val v={num(c.roas, 2)} /></span>, sortValue: (c) => c.acos },
    { id: 'be', header: 'Target / break-even', align: 'right', cell: (c) => <span><Val v={pctText(c.targetAcos)} /> / <Val v={pctText(c.breakEvenAcos)} /></span> },
    { id: 'conv', header: 'Conversion', align: 'right', cell: (c) => <Val v={pctText(c.conversion)} /> },
    { id: 'waste', header: 'Spend on targets without orders', align: 'right', cell: (c) => money(c.row.zero_order_target_spend), sortValue: (c) => c.row.zero_order_target_spend },
    { id: 'health', header: 'Assessment', cell: (c) => { const [l, t] = campaignHealth(c); return <div className="flex flex-col gap-1"><StatusBadge label={l} tone={t} />
      {c.lowStockProducts.length > 0 && <StatusBadge label={`Low stock: ${c.lowStockProducts.join(', ')}`} tone="danger" />}</div> } },
  ]
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {data.loading && !d ? <LoadingState variant="table" rows={8} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : d && (
          <>
            <DataCoverage dataset={d} />
            <DataTable title="Campaigns" description="Break-even and target ACoS are spend-weighted from the advertised products' costs. Placement data is not synchronised in this version."
              columns={columns} data={rows} getRowId={(c) => `${c.row.profile_id}:${c.row.campaign_id}`} pageSize={25} onRowClick={(c) => navigate(`/amazon/campaigns/${encodeURIComponent(c.row.campaign_id)}`)}
              searchPlaceholder="Search campaign" toolbar={<SelectFilter id="cp-state" label="State" value={state} onChange={(v) => setState(v ?? 'all')}
                options={[{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }, { value: 'ARCHIVED', label: 'Archived' }]} />}
              emptyState={{ icon: Megaphone, title: 'No campaigns', description: 'Synchronise the Ads API or import a Sponsored Products campaign report.' }} />
          </>
        )}
    </>
  )
}
