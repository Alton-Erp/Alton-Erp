import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { isIsoDate, presetRange, type PeriodPreset } from '@/features/analytics/analytics-period'
import { describeDataError } from '@/lib/errors'
import { toIsoDate } from '@/lib/format'
import { fetchAnalyticsContext, type AnalyticsContext } from '@/services/analytics'

// ---------------------------------------------------------------------------
// Context (company, today, financial year, access) — loaded once per session.
// ---------------------------------------------------------------------------
let contextPromise: Promise<AnalyticsContext> | null = null

export function useAnalyticsContext() {
  const [state, setState] = useState<{ data: AnalyticsContext | null; error: string | null }>({ data: null, error: null })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    contextPromise ??= fetchAnalyticsContext()
    contextPromise.then(
      (data) => { if (!cancelled) setState({ data, error: null }) },
      (e: unknown) => { contextPromise = null; if (!cancelled) setState({ data: null, error: describeDataError(e) }) },
    )
    return () => { cancelled = true }
  }, [attempt])
  const reload = useCallback(() => { contextPromise = null; setAttempt((n) => n + 1) }, [])
  return { ...state, reload }
}

// ---------------------------------------------------------------------------
// Filters, kept in the URL (shareable, back button) and the period remembered
// for the session so every analytics page opens on the same period.
// ---------------------------------------------------------------------------
export interface AnalyticsFilters {
  preset: PeriodPreset
  from: string
  to: string
  fy: string | null
  asOf: string | null
  warehouseId: string | null
  categoryId: string | null
  customerId: string | null
  customerKey: string | null
  productId: string | null
  productLabel: string | null
  sourceType: string | null
  orderStatus: string | null
  supplier: string | null
  orderId: string | null
  orderLabel: string | null
}

const KEYS = { preset: 'p', from: 'from', to: 'to', fy: 'fy', asOf: 'asof', warehouseId: 'wh', categoryId: 'cat', customerId: 'cust', customerKey: 'ckey',
  productId: 'prod', productLabel: 'prodl', sourceType: 'src', orderStatus: 'st', supplier: 'sup', orderId: 'ord', orderLabel: 'ordl' } as const
const PERIOD_STORE = 'alton.analytics.period'
const PRESETS: PeriodPreset[] = ['today', 'this_week', 'this_month', 'previous_month', 'this_quarter', 'current_fy', 'previous_fy', 'custom']

function readStoredPeriod(): { p?: string; from?: string; to?: string; fy?: string } {
  try { return JSON.parse(sessionStorage.getItem(PERIOD_STORE) ?? '{}') as { p?: string; from?: string; to?: string; fy?: string } } catch { return {} }
}

/** The default period is the page's own, else the company's eporting.default_period (ERP Settings), else this month. */
export function useAnalyticsFilters(ctx: AnalyticsContext | null, pageDefault?: PeriodPreset) {
  const [params, setParams] = useSearchParams()
  const [localToday] = useState(() => toIsoDate(new Date()))
  const today = ctx?.today ?? localToday
  const fyStartMonth = ctx?.fy_start_month ?? 4
  const companyDefault = ctx?.default_period && (PRESETS as string[]).includes(ctx.default_period) ? (ctx.default_period as PeriodPreset) : null
  const defaultPreset: PeriodPreset = pageDefault ?? companyDefault ?? 'this_month'

  const filters = useMemo<AnalyticsFilters>(() => {
    const stored = params.has(KEYS.preset) ? {} : readStoredPeriod()
    const rawPreset = params.get(KEYS.preset) ?? stored.p ?? defaultPreset
    const preset = (PRESETS as string[]).includes(rawPreset) ? (rawPreset as PeriodPreset) : defaultPreset
    let from = params.get(KEYS.from) ?? stored.from ?? null
    let to = params.get(KEYS.to) ?? stored.to ?? null
    if (preset !== 'custom' || !isIsoDate(from) || !isIsoDate(to) || from > to) {
      const r = presetRange(preset === 'custom' ? defaultPreset === 'custom' ? 'this_month' : defaultPreset : preset, today, fyStartMonth)
      from = r.from
      to = r.to
    }
    const get = (k: keyof typeof KEYS) => params.get(KEYS[k]) || null
    const asOf = get('asOf')
    return {
      preset: preset === 'custom' && from && to ? 'custom' : preset, from: from!, to: to!, fy: get('fy') ?? (stored.fy || null),
      asOf: isIsoDate(asOf) ? asOf : null, warehouseId: get('warehouseId'), categoryId: get('categoryId'), customerId: get('customerId'),
      customerKey: get('customerKey'), productId: get('productId'), productLabel: get('productLabel'), sourceType: get('sourceType'),
      orderStatus: get('orderStatus'), supplier: get('supplier'), orderId: get('orderId'), orderLabel: get('orderLabel'),
    }
  }, [params, today, fyStartMonth, defaultPreset])

  const update = useCallback((changes: Partial<AnalyticsFilters>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(changes) as [keyof AnalyticsFilters, string | null][]) {
        const key = KEYS[k as keyof typeof KEYS]
        if (!key) continue
        if (v === null || v === undefined || v === '') next.delete(key)
        else next.set(key, v)
      }
      if (changes.preset && changes.preset !== 'custom') { next.delete(KEYS.from); next.delete(KEYS.to) }
      if (changes.preset && changes.fy === undefined) next.delete(KEYS.fy)
      try {
        sessionStorage.setItem(PERIOD_STORE, JSON.stringify({ p: next.get(KEYS.preset) ?? undefined, from: next.get(KEYS.from) ?? undefined,
          to: next.get(KEYS.to) ?? undefined, fy: next.get(KEYS.fy) ?? undefined }))
      } catch { /* storage unavailable: the URL still holds the period */ }
      return next
    }, { replace: true })
  }, [setParams])

  const reset = useCallback(() => setParams((prev) => {
    const next = new URLSearchParams()
    for (const k of [KEYS.preset, KEYS.from, KEYS.to, KEYS.fy]) { const v = prev.get(k); if (v) next.set(k, v) }
    return next
  }, { replace: true }), [setParams])

  return { filters, update, reset, today }
}

// ---------------------------------------------------------------------------
// Query state that keeps the last successful result when a refresh fails, so
// the page can say exactly which data is stale instead of going blank.
// ---------------------------------------------------------------------------
export interface AnalyticsQuery<T> {
  data: T | null
  loading: boolean
  error: string | null
  /** Time of the last successful load (server time). */
  lastSuccessAt: string | null
  /** Time of the last failed attempt, if the latest attempt failed. */
  failedAt: string | null
  stale: boolean
  reload: () => void
}

export function useAnalyticsQuery<T extends { generated_at?: string }>(loader: (() => Promise<T>) | null, deps: readonly unknown[]): AnalyticsQuery<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null; lastSuccessAt: string | null; failedAt: string | null; key: string }>(
    { data: null, loading: Boolean(loader), error: null, lastSuccessAt: null, failedAt: null, key: '' })
  const [attempt, setAttempt] = useState(0)
  const key = JSON.stringify(deps)

  useEffect(() => {
    if (!loader) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return
      setState((s) => ({ ...s, loading: true }))
      return loader().then(
        (data) => { if (!cancelled) setState({ data, loading: false, error: null, lastSuccessAt: data?.generated_at ?? new Date().toISOString(), failedAt: null, key }) },
        (e: unknown) => {
          if (!cancelled) setState((s) => ({ ...s, loading: false, error: describeDataError(e), failedAt: new Date().toISOString(), data: s.key === key ? s.data : null }))
        },
      )
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, loader === null])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])
  return { data: state.data, loading: state.loading, error: state.error, lastSuccessAt: state.lastSuccessAt, failedAt: state.failedAt,
    stale: Boolean(state.error && state.data), reload }
}
