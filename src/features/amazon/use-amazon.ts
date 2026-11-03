import { useMemo } from 'react'

import { useAuth } from '@/auth/use-auth'
import { analyseCampaign, analyseProduct, type AmazonSettings, type CampaignAnalysis, type ProductAnalysis } from '@/features/amazon/analysis'
import { useAsync } from '@/hooks/use-async'
import { usePersistentState } from '@/hooks/use-persistent-state'
import { fetchCampaignPerformance, fetchDataStatus, fetchProductPerformance, type DataStatus } from '@/services/amazon'

export type AmazonPreset = 'today' | 'yesterday' | 'last_7' | 'last_30' | 'this_month' | 'previous_month' | 'custom'
export const AMAZON_PRESETS: { value: AmazonPreset; label: string }[] = [
  { value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: 'last_7', label: 'Last 7 days' }, { value: 'last_30', label: 'Last 30 days' },
  { value: 'this_month', label: 'This month' }, { value: 'previous_month', label: 'Previous month' }, { value: 'custom', label: 'Custom range' },
]

export interface AmazonView {
  preset: AmazonPreset
  from: string
  to: string
  mode: 'LIVE' | 'DEMO'
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (date: string, n: number) => iso(new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000))

/** Today in the company time zone (YYYY-MM-DD). */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function presetRange(preset: Exclude<AmazonPreset, 'custom'>, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number)
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) }
    case 'last_7': return { from: addDays(today, -6), to: today }
    case 'last_30': return { from: addDays(today, -29), to: today }
    case 'this_month': return { from: `${today.slice(0, 7)}-01`, to: today }
    case 'previous_month': {
      const start = iso(new Date(Date.UTC(m === 1 ? y - 1 : y, (m + 10) % 12, 1)))
      return { from: start, to: addDays(`${today.slice(0, 7)}-01`, -1) }
    }
  }
}

/** Period and LIVE / DEMO mode, remembered per browser; dates resolved in the company time zone. */
export function useAmazonView() {
  const { access } = useAuth()
  const tz = access?.company?.timezone ?? 'Asia/Kolkata'
  const today = todayIn(tz)
  const [stored, setStored] = usePersistentState<AmazonView>('alton-erp:amazon-view', { preset: 'last_30', from: '', to: '', mode: 'LIVE' })
  const view = useMemo<AmazonView>(() => {
    if (stored.preset === 'custom' && stored.from && stored.to && stored.from <= stored.to) return stored
    const r = presetRange(stored.preset === 'custom' ? 'last_30' : stored.preset, today)
    return { ...stored, preset: stored.preset === 'custom' ? 'last_30' : stored.preset, ...r }
  }, [stored, today])
  return {
    view, today, demo: view.mode === 'DEMO',
    setPreset: (preset: AmazonPreset) => setStored((s) => ({ ...s, preset, ...(preset === 'custom' ? { from: view.from, to: view.to } : {}) })),
    setRange: (from: string, to: string) => setStored((s) => ({ ...s, preset: 'custom', from, to })),
    setMode: (mode: 'LIVE' | 'DEMO') => setStored((s) => ({ ...s, mode })),
  }
}

export interface AmazonDataset {
  status: DataStatus
  settings: AmazonSettings
  products: ProductAnalysis[]
  productMap: Map<string, ProductAnalysis>
  campaigns: CampaignAnalysis[]
  today: string
  generatedAt: string
}

/** Loads status, products and (optionally) campaigns for the view, analysed with the shared formulas. */
export function useAmazonDataset(view: AmazonView, opts: { campaigns?: boolean; refresh?: number } = {}) {
  const demo = view.mode === 'DEMO'
  return useAsync<AmazonDataset>(async () => {
    const [status, perf, camps] = await Promise.all([
      fetchDataStatus(view.from, view.to, demo),
      fetchProductPerformance(view.from, view.to, demo),
      opts.campaigns ? fetchCampaignPerformance(view.from, view.to, demo) : Promise.resolve({ rows: [] }),
    ])
    const products = perf.rows.map((r) => analyseProduct(r, perf.settings, perf.today))
    const productMap = new Map(products.map((p) => [p.sku, p]))
    return { status, settings: perf.settings, products, productMap, campaigns: camps.rows.map((c) => analyseCampaign(c, productMap)), today: perf.today, generatedAt: perf.generated_at }
  }, [view.from, view.to, demo, opts.campaigns, opts.refresh ?? 0])
}

/** True when the period has no Amazon data of the selected kind (drives the "not connected / no data" state). */
export const isEmptyDataset = (d: AmazonDataset | undefined) => !d || (d.status.listings === 0 && d.status.sales_days === 0 && d.status.campaign_days === 0)
