import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { AmazonToolbar, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import type { SearchTermRow } from '@/features/amazon/analysis'
import { CONFIDENCE_TONE, money, num, pctText } from '@/features/amazon/format'
import { acos, adConversion, cpc, ctr, roas } from '@/features/amazon/metrics'
import { classifySearchTerm, type TermAction } from '@/features/amazon/recommendations'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { SelectFilter } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { fetchSearchTerms } from '@/services/amazon'

const ACTION: Record<TermAction, [string, 'danger' | 'success' | 'warning' | 'neutral' | 'info']> = {
  NEGATIVE_FOR_REVIEW: ['Wasted spend - review as negative', 'danger'], HARVEST_EXACT: ['Add as exact keyword', 'success'], REDUCE_BID: ['Reduce bid', 'warning'],
  NEEDS_MORE_DATA: ['Needs more data', 'neutral'], PERFORMING: ['Performing', 'info'], MONITOR: ['Monitor', 'neutral'],
}

type Row = SearchTermRow & { action: TermAction; confidence: 'LOW' | 'MEDIUM' | 'HIGH'; evidence: string; key: string }

export default function AmazonKeywordsPage() {
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { campaigns: true, refresh })
  const terms = useAsync(() => fetchSearchTerms(view.from, view.to, demo, { limit: 5000 }), [view.from, view.to, demo, refresh])
  const [campaign, setCampaign] = useState('all')
  const [action, setAction] = useState('all')
  const rows = useMemo<Row[]>(() => {
    const d = data.data
    if (!d || !terms.data) return []
    return terms.data.rows.map((t) => {
      const target = t.seller_sku ? d.productMap.get(t.seller_sku)?.targets.targetAcos ?? null : null
      const c = classifySearchTerm(t, target, d.settings)
      return { ...t, ...c, key: `${t.campaign_id}|${t.ad_group_id}|${t.targeting}|${t.match_type}|${t.search_term}` }
    })
  }, [data.data, terms.data])
  const shown = rows.filter((r) => (campaign === 'all' || r.campaign_id === campaign) && (action === 'all' || r.action === action))
  const wasted = rows.filter((r) => r.action === 'NEGATIVE_FOR_REVIEW').reduce((s, r) => s + r.spend, 0)
  const columns: DataTableColumn<Row>[] = [
    { id: 'term', header: 'Search term', cell: (r) => <span className="font-medium">{r.search_term}</span>, searchValue: (r) => `${r.search_term} ${r.targeting}`, sortValue: (r) => r.search_term },
    { id: 'target', header: 'Keyword / target', cell: (r) => <div><p>{r.targeting}</p><p className="text-xs text-muted-foreground">{r.match_type ?? (r.targeting_type === 'AUTO' ? 'auto' : '')}{r.bid ? ` · bid ${money(r.bid, true)}` : ''}</p></div> },
    { id: 'camp', header: 'Campaign / ad group', cell: (r) => <div className="text-xs"><p>{r.campaign_name ?? r.campaign_id}</p><p className="text-muted-foreground">{r.ad_group_name ?? r.ad_group_id}</p></div> },
    { id: 'asin', header: 'Product', cell: (r) => <span className="text-xs">{r.seller_sku ?? ''}{r.asin ? ` / ${r.asin}` : ''}</span> },
    { id: 'imp', header: 'Impr.', align: 'right', cell: (r) => num(r.impressions), sortValue: (r) => r.impressions },
    { id: 'clicks', header: 'Clicks / CTR', align: 'right', cell: (r) => <span>{num(r.clicks)} <span className="text-xs text-muted-foreground">{pctText(ctr(r.clicks, r.impressions), 2) ?? ''}</span></span>, sortValue: (r) => r.clicks },
    { id: 'cpc', header: 'CPC', align: 'right', cell: (r) => <Val v={money(cpc(r.spend, r.clicks), true)} /> },
    { id: 'spend', header: 'Spend', align: 'right', cell: (r) => money(r.spend, true), sortValue: (r) => r.spend },
    { id: 'orders', header: 'Orders / sales', align: 'right', cell: (r) => <span>{num(r.orders)} <span className="text-xs text-muted-foreground">{money(r.sales)}</span></span>, sortValue: (r) => r.orders },
    { id: 'acos', header: 'ACoS / ROAS', align: 'right', cell: (r) => <span><Val v={pctText(acos(r.spend, r.sales))} title="No attributed sales" /> / <Val v={num(roas(r.sales, r.spend), 2)} /></span>, sortValue: (r) => acos(r.spend, r.sales) },
    { id: 'cvr', header: 'Conv.', align: 'right', cell: (r) => <Val v={pctText(adConversion(r.orders, r.clicks))} /> },
    { id: 'action', header: 'Suggested action', cell: (r) => <div className="space-y-1"><StatusBadge label={ACTION[r.action][0]} tone={ACTION[r.action][1]} />
      <p className="text-xs text-muted-foreground">{r.evidence} · <StatusBadge label={r.confidence} tone={CONFIDENCE_TONE[r.confidence]} /></p></div>, sortValue: (r) => r.action },
  ]
  const d = data.data
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={terms.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {(data.loading || terms.loading) && !terms.data ? <LoadingState variant="table" rows={8} /> : data.error || terms.error ? <ErrorState message={describeDataError(data.error ?? terms.error)} onRetry={() => setRefresh((n) => n + 1)} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              {terms.data?.total ?? 0} search terms. Spend flagged as wasted (no orders, at least {d?.settings.min_clicks_for_decision} clicks and {money(d?.settings.wasted_spend_threshold)} spent): <strong>{money(wasted)}</strong>.
              Search volume, organic rank and competitor data are not available from Amazon reports and are not estimated.
            </p>
            <DataTable title="Search terms" columns={columns} data={shown} getRowId={(r) => r.key} pageSize={25} searchPlaceholder="Search term or keyword"
              toolbar={<div className="flex flex-wrap gap-2">
                <SelectFilter id="kw-camp" label="Campaign" value={campaign} onChange={(v) => setCampaign(v ?? 'all')} width="w-56"
                  options={(d?.campaigns ?? []).map((c) => ({ value: c.row.campaign_id, label: c.row.name }))} />
                <SelectFilter id="kw-action" label="Suggested action" value={action} onChange={(v) => setAction(v ?? 'all')} width="w-56"
                  options={Object.entries(ACTION).map(([v, [l]]) => ({ value: v, label: l }))} />
              </div>}
              emptyState={{ icon: Search, title: 'No search terms', description: 'Synchronise Ads reports or import a Sponsored Products search term report.' }} />
          </>
        )}
    </>
  )
}
