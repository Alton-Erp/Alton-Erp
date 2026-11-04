import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useAuth } from '@/auth/use-auth'
import { usePermissions } from '@/auth/use-permissions'
import type { PermissionCode } from '@/auth/permissions'
import { getPresetRange } from '@/lib/date-range'
import { parseIsoDate, toIsoDate } from '@/lib/format'
import type { DateRangePreset, DateRangeValue } from '@/types'

import { todayIn } from './drill-conditions'
import { contextToParams, DASHBOARDS, METRICS, type DashboardKey, type DrillContext } from './drill-registry'

/** Company time zone and today's date there (the database uses the same). */
export function useCompanyClock() {
  const { access } = useAuth()
  const tz = access?.company?.timezone || 'UTC'
  const today = todayIn(tz)
  // Stable while the date and zone are unchanged (used in effect and query dependencies).
  return useMemo(() => ({ tz, today }), [tz, today])
}

/**
 * Links from a dashboard's figures to the records behind them.
 * `href` returns null when the user may not open those records (the card is then not a link).
 */
export function useDrill(from: DashboardKey) {
  const { hasAny } = usePermissions()
  const clock = useCompanyClock()
  const can = useCallback((key: string) => {
    const m = METRICS[key]
    return Boolean(m && hasAny(m.permissions as PermissionCode[]))
  }, [hasAny])
  const href = useCallback((key: string, ctx: Partial<DrillContext> = {}): string | null => {
    const m = METRICS[key]
    if (!m || !hasAny(m.permissions as PermissionCode[])) return null
    const full: DrillContext = { from: clock.today, to: clock.today, today: clock.today, tz: clock.tz, ...ctx }
    const params = contextToParams(full)
    if (from !== m.dashboard) params.set('via', from)
    if (m.target === 'products') {
      params.set('drill', key)
      return `/products?${params}`
    }
    return `/drilldown/${encodeURIComponent(key)}?${params}`
  }, [hasAny, clock.today, clock.tz, from])
  return { href, can, ...clock }
}

/** Address of a dashboard with the filters a figure was opened with (breadcrumb "back to dashboard"). */
export function dashboardHref(dashboard: DashboardKey, ctx: Partial<DrillContext>): string {
  const p = new URLSearchParams()
  for (const k of ['from', 'to', 'customer', 'status', 'payment'] as const) {
    const v = ctx[k]
    if (v) p.set(k, v)
  }
  const s = p.toString()
  return `${DASHBOARDS[dashboard].path}${s ? `?${s}` : ''}`
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A dashboard's period kept in the address (?from=&to=), so browser Back from a drill-down page
 * returns to the same period. Falls back to the preset.
 */
export function useUrlDateRange(preset: Exclude<DateRangePreset, 'custom'>): [DateRangeValue, (r: DateRangeValue) => void] {
  const [params, setParams] = useSearchParams()
  const from = params.get('from')
  const to = params.get('to')
  const range = useMemo<DateRangeValue>(() => {
    if (from && to && DATE.test(from) && DATE.test(to) && from <= to) {
      const p = params.get('range') as DateRangePreset | null
      return { preset: p ?? 'custom', from: parseIsoDate(from), to: parseIsoDate(to) }
    }
    return getPresetRange(preset)
  }, [from, to, params, preset])
  const setRange = useCallback((r: DateRangeValue) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('from', toIsoDate(r.from))
      next.set('to', toIsoDate(r.to))
      next.set('range', r.preset)
      return next
    }, { replace: true })
  }, [setParams])
  return [range, setRange]
}

/** A dashboard filter kept in the address (?name=value); `fallback` when absent. */
export function useUrlParam(name: string, fallback: string): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(name) ?? fallback
  const set = useCallback((v: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (v === fallback) next.delete(name)
      else next.set(name, v)
      return next
    }, { replace: true })
  }, [name, fallback, setParams])
  return [value, set]
}
