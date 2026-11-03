import { Calculator, Loader2, Save } from 'lucide-react'
import { useMemo, useState } from 'react'

import { usePermissions } from '@/auth/use-permissions'
import { ErrorState } from '@/components/common/error-state'
import { FilterTabs } from '@/components/common/filter-tabs'
import { LoadingState } from '@/components/common/loading-state'
import { PageHeader } from '@/components/common/page-header'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { allocateBudget, scenarios, toAllocItem, type AllocSummary } from '@/features/amazon/allocator'
import { AmazonToolbar, DemoBanner, NoAmazonData, Val } from '@/features/amazon/amazon-ui'
import { CONFIDENCE_TONE, money, num, pctText } from '@/features/amazon/format'
import { isEmptyDataset, useAmazonDataset, useAmazonView } from '@/features/amazon/use-amazon'
import { MiniTable } from '@/features/analytics/analytics-ui'
import { useAsync } from '@/hooks/use-async'
import { describeDataError } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { fetchBudgetPlans, saveBudgetPlan } from '@/services/amazon'

type ScenarioKey = 'current' | 'p10' | 'p20' | 'p30' | 'custom'
const SCENARIOS: { value: ScenarioKey; label: string; factor: number | null }[] = [
  { value: 'current', label: 'Current spend', factor: 1 }, { value: 'p10', label: '+10%', factor: 1.1 }, { value: 'p20', label: '+20%', factor: 1.2 },
  { value: 'p30', label: '+30%', factor: 1.3 }, { value: 'custom', label: 'Custom budget', factor: null },
]
const range = (t: [number, number, number] | null | undefined) => (t ? `${money(t[0])} – ${money(t[2])} (central ${money(t[1])})` : null)

const nextMonth = (today: string) => {
  const [y, m] = today.split('-').map(Number)
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

export default function AmazonBudgetPlannerPage() {
  const { has } = usePermissions()
  const { view, setPreset, setRange, setMode, demo, today } = useAmazonView()
  const [refresh, setRefresh] = useState(0)
  const data = useAmazonDataset(view, { refresh })
  const plans = useAsync(() => fetchBudgetPlans(demo), [demo, refresh])
  const d = data.data
  const [mode, setModeInput] = useState<'PROFIT' | 'GROWTH'>('PROFIT')
  const [scenario, setScenario] = useState<ScenarioKey>('current')
  const [custom, setCustom] = useState('')
  const [dailyLimit, setDailyLimit] = useState('')
  const [elasticity, setElasticity] = useState('0.6')
  const [safety, setSafety] = useState('')
  const [minContribution, setMinContribution] = useState('')
  const [limits, setLimits] = useState<Record<string, { min: string; max: string }>>({})
  const [planName, setPlanName] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const model = useMemo(() => {
    if (!d) return null
    const periodDays = d.status.period_days
    const candidates = d.products.filter((p) => p.ads.spend > 0 || p.ads.clicks > 0 || limits[p.sku]?.min)
    const parse = (v: string | undefined) => (v && Number(v) >= 0 ? Number(v) : undefined)
    const items = candidates.map((p) => toAllocItem(p, periodDays, { min: parse(limits[p.sku]?.min), max: parse(limits[p.sku]?.max) }))
    const currentMonthly = Math.round(items.reduce((s, i) => s + i.dailySpend, 0) * 30)
    const base = { mode, dailyLimit: parse(dailyLimit) ?? d.settings.max_daily_budget, elasticity: Number(elasticity), safetyDays: parse(safety) ?? d.settings.low_stock_cover_days,
      minClicks: d.settings.min_clicks_for_decision, maxBidChangePct: d.settings.max_bid_change_pct, minContribution: parse(minContribution) ?? null }
    const budgets = SCENARIOS.filter((s) => s.factor !== null).map((s) => ({ label: s.label, monthly: Math.round(currentMonthly * (s.factor ?? 1)) }))
    if (parse(custom) !== undefined) budgets.push({ label: 'Custom budget', monthly: parse(custom)! })
    const runs = scenarios(items, base, budgets)
    const chosenLabel = SCENARIOS.find((s) => s.value === scenario)!.label
    const chosen: AllocSummary | null = runs.find((r) => r.label === chosenLabel)?.result ?? (scenario === 'custom' ? null : allocateBudget(items, { ...base, monthlyBudget: currentMonthly }))
    return { items, currentMonthly, runs, chosen, base, periodDays, excluded: d.products.length - candidates.length }
  }, [d, mode, scenario, custom, dailyLimit, elasticity, safety, minContribution, limits])

  const save = async () => {
    if (!model?.chosen) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const name = planName.trim() || `${model.chosen.mode === 'PROFIT' ? 'Profit' : 'Growth'} plan ${money(model.chosen.monthlyBudget)}`
      await saveBudgetPlan(name, nextMonth(today), { total_budget: model.chosen.monthlyBudget, mode, scenario, elasticity: Number(elasticity), daily_limit: model.base.dailyLimit,
        safety_days: model.base.safetyDays, period: { from: view.from, to: view.to }, limits }, model.chosen, model.chosen.assumptions, demo)
      setMessage('Plan saved. It is a planning record only: no campaign budget was changed. Use AI Recommendations / campaign pages to request approved changes.')
      setRefresh((n) => n + 1)
    } catch (e) { setError(describeDataError(e)) } finally { setBusy(false) }
  }

  const overMonthly = d?.settings.max_monthly_budget != null && model?.chosen && model.chosen.monthlyBudget > d.settings.max_monthly_budget
  return (
    <>
      <PageHeader />
      <AmazonToolbar view={view} setPreset={setPreset} setRange={setRange} setMode={setMode} loading={data.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      <DemoBanner demo={demo} />
      {data.loading && !d ? <LoadingState variant="table" rows={6} /> : data.error ? <ErrorState message={describeDataError(data.error)} onRetry={data.reload} />
        : isEmptyDataset(d) ? <NoAmazonData dataset={d} demo={demo} /> : d && model && (
          <div className="space-y-6">
            {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">{message}</p>}
            {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">{error}</p>}
            <Card>
              <CardHeader><div><CardTitle>Inputs</CardTitle>
                <CardDescription>History: {view.from} to {view.to} ({model.periodDays} days). Current advertising run-rate ≈ {money(model.currentMonthly)} per month across {model.items.length} advertised product(s).</CardDescription></div></CardHeader>
              <CardContent className="flex flex-wrap items-end gap-3 text-sm">
                <div className="space-y-1"><Label htmlFor="bp-mode">Priority</Label>
                  <Select value={mode} onValueChange={(v) => setModeInput(v as 'PROFIT' | 'GROWTH')}><SelectTrigger id="bp-mode" className="w-52"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="PROFIT">Profit (stop at break-even)</SelectItem><SelectItem value="GROWTH">Growth (stop at target ACoS)</SelectItem></SelectContent></Select></div>
                <div className="space-y-1"><Label htmlFor="bp-custom">Custom monthly budget</Label><Input id="bp-custom" className="w-40" inputMode="decimal" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="₹" /></div>
                <div className="space-y-1"><Label htmlFor="bp-daily">Max daily total</Label><Input id="bp-daily" className="w-36" inputMode="decimal" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} placeholder={d.settings.max_daily_budget ? String(d.settings.max_daily_budget) : 'none'} /></div>
                <div className="space-y-1"><Label htmlFor="bp-elast">Diminishing returns</Label>
                  <Select value={elasticity} onValueChange={setElasticity}><SelectTrigger id="bp-elast" className="w-48"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="0.4">Strong (0.4)</SelectItem><SelectItem value="0.6">Moderate (0.6, default)</SelectItem><SelectItem value="0.8">Weak (0.8)</SelectItem></SelectContent></Select></div>
                <div className="space-y-1"><Label htmlFor="bp-safety">Stock safety days</Label><Input id="bp-safety" className="w-28" inputMode="numeric" value={safety} onChange={(e) => setSafety(e.target.value)} placeholder={String(d.settings.low_stock_cover_days)} /></div>
                <div className="space-y-1"><Label htmlFor="bp-minc">Min. monthly contribution</Label><Input id="bp-minc" className="w-40" inputMode="decimal" value={minContribution} onChange={(e) => setMinContribution(e.target.value)} placeholder="optional" /></div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><div><CardTitle>Scenario comparison</CardTitle><CardDescription>Forecast ranges use diminishing-returns factors 0.4–0.8 and cover only items with enough data. Not a guarantee of sales, profit or placement.</CardDescription></div></CardHeader>
              <CardContent>
                <MiniTable headers={['Scenario', 'Monthly budget', 'Allocated', 'Unallocated', 'Attributed sales (range)', 'Contribution after ads (range)', 'Min. contribution met']}
                  rows={model.runs.map((r) => [r.label, money(r.monthly), money(r.result.allocatedMonthly), money(r.result.unallocatedMonthly),
                    <Val key="s" v={range(r.result.forecastSalesMonthly)} title="Not enough data to forecast" />, <Val key="c" v={range(r.result.forecastContributionMonthly)} title="Costs incomplete or not enough data" />,
                    r.result.minContributionMet === null ? '-' : r.result.minContributionMet ? 'Yes' : 'No'])} />
                <p className="mt-2 text-xs text-muted-foreground">Unallocated budget means no item could use more money without crossing its {mode === 'PROFIT' ? 'break-even' : 'target'} ACoS or stock limit; it is not forced out.</p>
              </CardContent>
            </Card>

            <FilterTabs label="Scenario" value={scenario} onChange={setScenario} options={SCENARIOS.map((s) => ({ value: s.value, label: s.label }))} />
            {!model.chosen ? <p className="text-sm text-muted-foreground">Enter a custom monthly budget above.</p> : <>
              {overMonthly && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">This budget exceeds the company maximum monthly budget ({money(d.settings.max_monthly_budget)}). Change requests above the limit will be refused.</p>}
              <Card>
                <CardHeader><div><CardTitle>Allocation — {SCENARIOS.find((s) => s.value === scenario)?.label} ({money(model.chosen.monthlyBudget)} / month)</CardTitle>
                  <CardDescription>Set a minimum (test) or maximum daily budget per product to constrain the plan.</CardDescription></div></CardHeader>
                <CardContent>
                  <MiniTable headers={['Product', 'Confidence', 'Current / day', 'Proposed / day', 'Change / month', 'Marginal ACoS', 'Bid change', 'Stock cover', 'Sales forecast / month', 'Min / max per day', 'Why']}
                    align={['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left']}
                    rows={model.chosen.items.map((r) => [
                      <span key="l" className="text-xs font-medium">{r.label}</span>, <StatusBadge key="c" label={r.confidence} tone={CONFIDENCE_TONE[r.confidence]} />,
                      money(r.currentDaily, true), <strong key="p">{money(r.proposedDaily, true)}</strong>,
                      <span key="ch" className={r.changeMonthly < 0 ? 'text-shortage' : r.changeMonthly > 0 ? 'text-available' : ''}>{money(r.changeMonthly)}</span>,
                      <Val key="m" v={pctText(r.marginalAcos)} title="Not modelled" />, <Val key="b" v={r.bidChangePct === null ? null : `${r.bidChangePct > 0 ? '+' : ''}${r.bidChangePct}%`} title="Not enough data" />,
                      <span key="sc">{r.stockCoverDays === null ? 'unknown' : `${num(r.stockCoverDays)} d`}{r.stockoutRisk ? ' ⚠' : ''}</span>,
                      <Val key="f" v={r.forecast ? `${money(r.forecast.salesMonthly[0])}–${money(r.forecast.salesMonthly[2])}` : null} title="No forecast (low confidence)" />,
                      <div key="lim" className="flex gap-1">
                        <Input aria-label={`Minimum daily budget for ${r.key}`} className="h-7 w-20 text-xs" inputMode="decimal" placeholder="min" value={limits[r.key]?.min ?? ''}
                          onChange={(e) => setLimits((s) => ({ ...s, [r.key]: { min: e.target.value, max: s[r.key]?.max ?? '' } }))} />
                        <Input aria-label={`Maximum daily budget for ${r.key}`} className="h-7 w-20 text-xs" inputMode="decimal" placeholder="max" value={limits[r.key]?.max ?? ''}
                          onChange={(e) => setLimits((s) => ({ ...s, [r.key]: { min: s[r.key]?.min ?? '', max: e.target.value } }))} />
                      </div>,
                      <ul key="w" className="max-w-80 list-disc pl-4 text-xs text-muted-foreground">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>,
                    ])} empty="No advertised products in the period: there is no history to allocate from." />
                  {model.excluded > 0 && <p className="mt-2 text-xs text-muted-foreground">{model.excluded} product(s) without advertising history are not shown; the allocator has no history to model them (start them with a small manual test budget).</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><div><CardTitle>Assumptions</CardTitle></div></CardHeader>
                <CardContent><ul className="list-disc space-y-1 pl-5 text-sm">{model.chosen.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></CardContent>
              </Card>
              {has('amazon.manage') && (
                <Card><CardContent className="flex flex-wrap items-end gap-3 p-4">
                  <div className="space-y-1"><Label htmlFor="bp-name">Plan name</Label><Input id="bp-name" className="w-72" maxLength={120} value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="e.g. November profit plan" /></div>
                  <Button disabled={busy} onClick={() => void save()}>{busy ? <Loader2 className="animate-spin" /> : <Save />} Save plan for {nextMonth(today).slice(0, 7)}</Button>
                  <p className="basis-full text-xs text-muted-foreground">Saving records the plan only. Nothing is changed on Amazon.</p>
                </CardContent></Card>
              )}
            </>}

            <Card>
              <CardHeader><div><CardTitle>Saved plans</CardTitle></div></CardHeader>
              <CardContent>
                {plans.error ? <ErrorState message={describeDataError(plans.error)} onRetry={plans.reload} /> : (
                  <MiniTable headers={['Name', 'Month', 'Budget', 'Allocated', 'Saved']} align={['left', 'left', 'right', 'right', 'left']}
                    rows={(plans.data ?? []).map((p) => [p.name, p.month.slice(0, 7), money(Number(p.inputs.total_budget ?? 0)), money(Number((p.allocation as { allocatedMonthly?: number }).allocatedMonthly ?? 0)), formatDateTime(p.created_at)])}
                    empty="No saved plans." />
                )}
              </CardContent>
            </Card>
            <p className="flex items-center gap-2 text-xs text-muted-foreground"><Calculator className="size-3.5" /> The planner never changes campaigns. Placement, ranking, sales and profit are not guaranteed.</p>
          </div>
        )}
    </>
  )
}
