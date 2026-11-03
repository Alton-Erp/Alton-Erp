import { PackageSearch } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { DataTable, type DataTableColumn } from '@/components/common/data-table'
import { ErrorState } from '@/components/common/error-state'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { AmazonToolbar, DataCoverage, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import type { ProductAnalysis } from '@/features/amazon/analysis'
import { money, num, pctText, PROFIT_LABEL, STOCK_LABEL } from '@/features/amazon/format'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { SelectFilter } from '@/features/analytics/analytics-ui'
import { describeDataError } from '@/lib/errors'

export default function AmazonProductsPage() {
  const navigate = useNavigate()
  const { view, setPreset, setRange, setMode, demo } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { refresh })
  const [category, setCategory] = useState('all')
  const [profit, setProfit] = useState('all')
  const [stock, setStock] = useState('all')
  const [ads, setAds] = useState('all')
  const d = data.data
  const categories = useMemo(() => [...new Set((d?.products ?? []).map((p) => p.row.category).filter((c): c is string => Boolean(c)))].sort(), [d])
  const rows = (d?.products ?? []).filter((p) => (category === 'all' || p.row.category === category) && (profit === 'all' || p.profitStatus === profit)
    && (stock === 'all' || p.stockStatus === stock) && (ads === 'all' || (ads === 'advertised' ? p.ads.spend > 0 : p.ads.spend === 0)))

  const columns: DataTableColumn<ProductAnalysis>[] = [
    { id: 'sku', header: 'SKU / ASIN', cell: (p) => <div><p className="font-medium">{p.sku}</p><p className="text-xs text-muted-foreground">{p.row.asin ?? 'no ASIN'}</p></div>,
      searchValue: (p) => `${p.sku} ${p.row.asin ?? ''} ${p.label}`, sortValue: (p) => p.sku },
    { id: 'name', header: 'Product', cell: (p) => <span className="line-clamp-2 max-w-56 text-xs">{p.label}</span> },
    { id: 'price', header: 'Price', align: 'right', cell: (p) => <Val v={money(p.row.item_price)} />, sortValue: (p) => p.row.item_price },
    { id: 'sales', header: 'Ordered sales', align: 'right', cell: (p) => <Val v={money(p.orderedSales)} />, sortValue: (p) => p.orderedSales },
    { id: 'units', header: 'Units', align: 'right', cell: (p) => num(p.units), sortValue: (p) => p.units },
    { id: 'sessions', header: 'Sessions / conv.', align: 'right', cell: (p) => <span><Val v={num(p.sessions)} /> <span className="text-xs text-muted-foreground">{pctText(p.sessionConversion) ?? ''}</span></span>, sortValue: (p) => p.sessions },
    { id: 'spend', header: 'Ad spend', align: 'right', cell: (p) => money(p.ads.spend), sortValue: (p) => p.ads.spend },
    { id: 'adsales', header: 'Ad sales', align: 'right', cell: (p) => money(p.ads.sales), sortValue: (p) => p.ads.sales },
    { id: 'acos', header: 'ACoS / TACoS', align: 'right', cell: (p) => <span><Val v={pctText(p.ads.acos)} title="No attributed sales" /> / <Val v={pctText(p.ads.tacos)} /></span>, sortValue: (p) => p.ads.acos },
    { id: 'roas', header: 'ROAS', align: 'right', cell: (p) => <Val v={num(p.ads.roas, 2)} />, sortValue: (p) => p.ads.roas },
    { id: 'cpc', header: 'CPC / CTR', align: 'right', cell: (p) => <span><Val v={money(p.ads.cpc, true)} /> / <Val v={pctText(p.ads.ctr, 2)} /></span> },
    { id: 'orders', header: 'Ad orders', align: 'right', cell: (p) => num(p.ads.orders), sortValue: (p) => p.ads.orders },
    { id: 'cost', header: 'Product cost', align: 'right', cell: (p) => <span title={p.row.cost_source}><Val v={money(p.contribution.productCost)} /></span> },
    { id: 'fees', header: 'Amazon fees', align: 'right', cell: (p) => <span title={p.contribution.feeBasis}><Val v={money(p.contribution.referralFees === null && p.contribution.fulfilmentFees === null ? null : (p.contribution.referralFees ?? 0) + (p.contribution.fulfilmentFees ?? 0) + (p.contribution.otherFees ?? 0))} /></span> },
    { id: 'ship', header: 'Shipping + other', align: 'right', cell: (p) => money((p.contribution.shipping ?? 0) + (p.contribution.otherVariable ?? 0)) },
    { id: 'refunds', header: 'Refunds (ex-GST)', align: 'right', cell: (p) => <Val v={money(p.contribution.refundsExGst)} /> },
    { id: 'before', header: 'Contribution before ads', align: 'right', cell: (p) => <Val v={money(p.contribution.beforeAds)} title={p.contribution.missing.join('; ')} />, sortValue: (p) => p.contribution.beforeAds },
    { id: 'after', header: 'After ads', align: 'right', cell: (p) => <span className={(p.contribution.afterAds ?? 0) < 0 ? 'font-medium text-shortage' : ''}><Val v={money(p.contribution.afterAds)} title={p.contribution.missing.join('; ')} /></span>,
      sortValue: (p) => p.contribution.afterAds },
    { id: 'stock', header: 'Stock / cover', align: 'right', cell: (p) => <span title={p.stockSource === 'AMAZON' ? 'Amazon fulfillable' : p.stockSource === 'ERP' ? 'ERP warehouse' : 'unknown'}>
      <Val v={num(p.stockForCover)} /> <span className="text-xs text-muted-foreground">{p.stockCover === null ? '' : `${num(p.stockCover)} d`}</span></span>, sortValue: (p) => p.stockCover },
    { id: 'target', header: 'Target / break-even ACoS', align: 'right', cell: (p) => <span><Val v={pctText(p.targets.targetAcos)} /> / <Val v={pctText(p.targets.breakEvenAcos)} /></span> },
    { id: 'status', header: 'Status', cell: (p) => <div className="flex flex-col gap-1"><StatusBadge label={PROFIT_LABEL[p.profitStatus][0]} tone={PROFIT_LABEL[p.profitStatus][1]} />
      <StatusBadge label={STOCK_LABEL[p.stockStatus][0]} tone={STOCK_LABEL[p.stockStatus][1]} /></div> },
  ]
  const loading = data.loading
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {loading && !d ? <LoadingState variant="table" rows={8} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : d && (
          <>
            <DataCoverage dataset={d} />
            <DataTable title="Products" description="Contribution is ex-GST. Values that cannot be calculated are shown as Unavailable (hover for the reason). Click a row for details."
              columns={columns} data={rows} getRowId={(p) => p.sku} pageSize={25} onRowClick={(p) => navigate(`/amazon/products/${encodeURIComponent(p.sku)}`)}
              searchPlaceholder="Search SKU, ASIN or name"
              toolbar={<div className="flex flex-wrap gap-2">
                <SelectFilter id="pp-cat" label="Category" value={category} onChange={(v) => setCategory(v ?? 'all')} options={categories.map((c) => ({ value: c, label: c }))} />
                <SelectFilter id="pp-profit" label="Profitability" value={profit} onChange={(v) => setProfit(v ?? 'all')} options={Object.entries(PROFIT_LABEL).map(([v, [l]]) => ({ value: v, label: l }))} />
                <SelectFilter id="pp-stock" label="Stock" value={stock} onChange={(v) => setStock(v ?? 'all')} options={Object.entries(STOCK_LABEL).map(([v, [l]]) => ({ value: v, label: l }))} />
                <SelectFilter id="pp-ads" label="Advertising" value={ads} onChange={(v) => setAds(v ?? 'all')} options={[{ value: 'advertised', label: 'Advertised' }, { value: 'not', label: 'Not advertised' }]} />
              </div>}
              emptyState={{ icon: PackageSearch, title: 'No products match', description: 'Change the filters or the period.' }} />
          </>
        )}
    </>
  )
}
