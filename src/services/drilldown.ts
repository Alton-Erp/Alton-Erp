import { applyConditions, matchesConditions, productJoin, type Condition, type FilterBuilder } from '@/features/drilldown/drill-conditions'
import { SOURCES, type DrillContext, type DrillMetric } from '@/features/drilldown/drill-registry'
import { requireSupabase } from '@/lib/supabase'

export type DrillRow = Record<string, unknown>

export interface DrillQuery {
  search: string
  sort: { column: string; ascending: boolean } | null
  page: number
  pageSize: number
}

export interface DrillPage {
  rows: DrillRow[]
  total: number
  /** Measure over every matching record (sum figures); null when there are too many records to add up here. */
  measureTotal: number | null
  /** Per-unit totals of a quantity figure. */
  unitTotals: { unit: string; quantity: number }[] | null
}

/** Records added up in the browser for a sum figure (beyond this the page shows the count only). */
const MEASURE_LIMIT = 10000
/** Export limit (rows). */
export const EXPORT_LIMIT = 20000

const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/[,()]/g, ' ')}%`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = any

function viewQuery(metric: DrillMetric, ctx: DrillContext, columns: string, count: boolean, search: string): AnyQuery {
  const src = SOURCES[metric.source]
  if (src.kind !== 'view') throw new Error('Not a view source.')
  const conds: Condition[] = metric.conditions(ctx)
  const join = productJoin(conds)
  // A product column filter is an inner join on the row's product (company RLS applies to products too).
  const select = join ? `${columns},product:products!${join.fk}!inner(${join.cols.join(',')})` : columns
  let q: AnyQuery = requireSupabase().from(src.relation as never).select(select, count ? { count: 'exact' } : undefined)
  q = applyConditions(q as FilterBuilder<AnyQuery>, conds)
  const term = search.trim()
  if (term) q = q.or(src.search.map((c) => `${c}.ilike.${like(term)}`).join(','))
  return q
}

function measureOf(metric: DrillMetric, row: DrillRow): number {
  return metric.measure.kind === 'sum' ? metric.measure.columns.reduce((s, c) => s + Number(row[c] ?? 0), 0) : 0
}

function unitTotalsOf(metric: DrillMetric, rows: DrillRow[]) {
  if (metric.measure.kind !== 'sum' || !metric.measure.unitColumn) return null
  const by = new Map<string, number>()
  for (const r of rows) {
    const u = String(r[metric.measure.unitColumn] ?? '')
    by.set(u, (by.get(u) ?? 0) + measureOf(metric, r))
  }
  return [...by.entries()].map(([unit, quantity]) => ({ unit, quantity: Math.round(quantity * 1000) / 1000 })).sort((a, b) => a.unit.localeCompare(b.unit))
}

// ---------------------------------------------------------------------------
// RPC sources: the database computes the status; the same conditions select the rows here.
// ---------------------------------------------------------------------------
async function rpcRows(metric: DrillMetric, ctx: DrillContext): Promise<DrillRow[]> {
  const src = SOURCES[metric.source]
  if (src.kind !== 'rpc') throw new Error('Not an RPC source.')
  const { data, error } = await requireSupabase().rpc(src.fn as never, (metric.rpcArgs ? metric.rpcArgs(ctx) : {}) as never)
  if (error) throw error
  const raw = src.path ? (data as Record<string, unknown> | null)?.[src.path] : data
  const rows = (Array.isArray(raw) ? raw : []) as DrillRow[]
  const conds = metric.conditions(ctx)
  return rows.filter((r) => matchesConditions(r, conds))
}

function searchRows(metric: DrillMetric, rows: DrillRow[], search: string) {
  const term = search.trim().toLowerCase()
  if (!term) return rows
  const cols = SOURCES[metric.source].search
  return rows.filter((r) => cols.some((c) => String(r[c] ?? '').toLowerCase().includes(term)))
}

function sortRows(rows: DrillRow[], sort: { column: string; ascending: boolean }) {
  const dir = sort.ascending ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[sort.column]
    const y = b[sort.column]
    if (x === y) return 0
    if (x === null || x === undefined) return 1
    if (y === null || y === undefined) return -1
    const nx = Number(x)
    const ny = Number(y)
    return (Number.isFinite(nx) && Number.isFinite(ny) && typeof x !== 'string' ? nx - ny : String(x).localeCompare(String(y), undefined, { numeric: true })) * dir
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function fetchDrillPage(metric: DrillMetric, ctx: DrillContext, q: DrillQuery): Promise<DrillPage> {
  const src = SOURCES[metric.source]
  const sort = q.sort ?? src.sort
  if (src.kind === 'rpc') {
    const all = sortRows(searchRows(metric, await rpcRows(metric, ctx), q.search), sort)
    const start = q.page * q.pageSize
    return {
      rows: all.slice(start, start + q.pageSize), total: all.length,
      measureTotal: metric.measure.kind === 'sum' ? all.reduce((s, r) => s + measureOf(metric, r), 0) : null,
      unitTotals: unitTotalsOf(metric, all),
    }
  }
  const start = q.page * q.pageSize
  const { data, error, count } = await viewQuery(metric, ctx, '*', true, q.search)
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    .order(src.id, { ascending: true })
    .range(start, start + q.pageSize - 1)
  if (error) throw error
  const total = count ?? 0
  let measureTotal: number | null = null
  let unitTotals: DrillPage['unitTotals'] = null
  if (metric.measure.kind === 'sum') {
    if (total <= q.pageSize && start === 0) {
      measureTotal = (data ?? []).reduce((s: number, r: DrillRow) => s + measureOf(metric, r), 0)
      unitTotals = unitTotalsOf(metric, data ?? [])
    } else if (total <= MEASURE_LIMIT) {
      // Only the measured columns of every matching record (no full rows).
      const cols = [...new Set([src.id, ...metric.measure.columns, ...(metric.measure.unitColumn ? [metric.measure.unitColumn] : [])])].join(',')
      const all: DrillRow[] = []
      for (let from = 0; from < total; from += 1000) {
        const page = await viewQuery(metric, ctx, cols, false, q.search).order(src.id).range(from, from + 999)
        if (page.error) throw page.error
        all.push(...(page.data ?? []))
      }
      measureTotal = all.reduce((s, r) => s + measureOf(metric, r), 0)
      unitTotals = unitTotalsOf(metric, all)
    }
  }
  return { rows: (data ?? []) as DrillRow[], total, measureTotal, unitTotals }
}

/** Every matching record (export), up to EXPORT_LIMIT. */
export async function fetchAllDrillRows(metric: DrillMetric, ctx: DrillContext, q: Pick<DrillQuery, 'search' | 'sort'>): Promise<DrillRow[]> {
  const src = SOURCES[metric.source]
  const sort = q.sort ?? src.sort
  if (src.kind === 'rpc') return sortRows(searchRows(metric, await rpcRows(metric, ctx), q.search), sort).slice(0, EXPORT_LIMIT)
  const rows: DrillRow[] = []
  for (let from = 0; from < EXPORT_LIMIT; from += 1000) {
    const { data, error } = await viewQuery(metric, ctx, '*', false, q.search)
      .order(sort.column, { ascending: sort.ascending, nullsFirst: false }).order(src.id).range(from, from + 999)
    if (error) throw error
    rows.push(...((data ?? []) as DrillRow[]))
    if ((data ?? []).length < 1000) break
  }
  return rows
}
