/**
 * Pure helpers for the Management Dashboard: chart bucketing for the selected
 * period and the manufactured / outsourced stock split. No data is invented —
 * empty buckets are shown as 0 because nothing was recorded on those days.
 */

export type ChartBucket = 'day' | 'week' | 'month'

const DAY_MS = 86_400_000
const DAY_LABEL = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })
const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })

/** 'YYYY-MM-DD' → UTC midnight (milliseconds). */
function isoToUtc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function utcToIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Day buckets up to a month, weeks up to about four months, months beyond. */
export function chartBucket(from: string, to: string): ChartBucket {
  const days = Math.round((isoToUtc(to) - isoToUtc(from)) / DAY_MS) + 1
  if (days <= 31) return 'day'
  if (days <= 120) return 'week'
  return 'month'
}

/** Start of the bucket that holds `iso` (weeks start on Monday). */
export function bucketStart(iso: string, bucket: ChartBucket): string {
  const ms = isoToUtc(iso)
  if (bucket === 'day') return utcToIso(ms)
  if (bucket === 'week') {
    const weekday = (new Date(ms).getUTCDay() + 6) % 7
    return utcToIso(ms - weekday * DAY_MS)
  }
  return `${iso.slice(0, 7)}-01`
}

export function bucketLabel(start: string, bucket: ChartBucket): string {
  const date = new Date(isoToUtc(start))
  if (bucket === 'month') return MONTH_LABEL.format(date)
  return bucket === 'week' ? `w/c ${DAY_LABEL.format(date)}` : DAY_LABEL.format(date)
}

/** Every bucket start from `from` to `to`, in order. */
export function bucketStarts(from: string, to: string, bucket: ChartBucket): string[] {
  const out: string[] = []
  let cursor = bucketStart(from, bucket)
  const end = isoToUtc(to)
  while (isoToUtc(cursor) <= end && out.length < 400) {
    out.push(cursor)
    if (bucket === 'month') {
      const d = new Date(isoToUtc(cursor))
      cursor = utcToIso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
    } else {
      cursor = utcToIso(isoToUtc(cursor) + (bucket === 'week' ? 7 : 1) * DAY_MS)
    }
  }
  return out
}

export type BucketPoint<K extends string> = { start: string; label: string } & Record<K, number>

/**
 * Sums daily rows (`day` = 'YYYY-MM-DD') into buckets covering the whole period,
 * so the chart axis is continuous. Rows outside the period are ignored.
 */
export function bucketSeries<K extends string>(
  rows: readonly ({ day: string } & Partial<Record<K, number | string | null>>)[],
  keys: readonly K[],
  from: string,
  to: string,
  bucket: ChartBucket = chartBucket(from, to),
): BucketPoint<K>[] {
  const starts = bucketStarts(from, to, bucket)
  const index = new Map(starts.map((s, i) => [s, i]))
  const points = starts.map((start) => {
    const p = { start, label: bucketLabel(start, bucket) } as BucketPoint<K>
    for (const k of keys) (p as Record<string, number | string>)[k] = 0
    return p
  })
  for (const row of rows) {
    const day = String(row.day).slice(0, 10)
    if (day < from || day > to) continue
    const i = index.get(bucketStart(day, bucket))
    if (i === undefined) continue
    for (const k of keys) {
      const v = Number(row[k] ?? 0)
      if (Number.isFinite(v)) (points[i] as Record<string, number | string>)[k] = Math.round(((points[i][k] as number) + v) * 1000) / 1000
    }
  }
  return points
}

export interface SourceUnitRow { unit: string; on_hand: number | string; in_house: number | string; outsourced: number | string; unknown: number | string }
export interface StockBySource { unit: string; total: number; manufactured: number; outsourced: number; unknown: number }

/** Stock on hand per unit split by its recorded source (in-house = manufactured). PCS first; units are never added together. */
export function stockBySource(units: readonly SourceUnitRow[] | null | undefined): StockBySource[] {
  return (units ?? [])
    .map((u) => ({ unit: u.unit, total: Number(u.on_hand) || 0, manufactured: Number(u.in_house) || 0, outsourced: Number(u.outsourced) || 0, unknown: Number(u.unknown) || 0 }))
    .filter((u) => u.total !== 0 || u.manufactured !== 0 || u.outsourced !== 0 || u.unknown !== 0)
    .sort((a, b) => (a.unit === 'PCS' ? -1 : b.unit === 'PCS' ? 1 : b.total - a.total || a.unit.localeCompare(b.unit)))
}

/** "1,200 PCS · 35 KG" for one field of the split; `empty` when nothing is held. */
export function sourceText(rows: readonly StockBySource[], field: 'total' | 'manufactured' | 'outsourced' | 'unknown', empty = '0'): string {
  const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })
  const parts = rows.filter((r) => r[field] !== 0).map((r) => `${fmt.format(r[field])} ${r.unit}`)
  return parts.length ? parts.join(' · ') : empty
}

/** The unit with the most recorded quantity across a series (PCS preferred on ties), so one chart never mixes units. */
export function mainUnit(rows: readonly { unit: string; quantity: number }[]): string | null {
  const totals = new Map<string, number>()
  for (const r of rows) totals.set(r.unit, (totals.get(r.unit) ?? 0) + Math.abs(Number(r.quantity) || 0))
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || (a[0] === 'PCS' ? -1 : b[0] === 'PCS' ? 1 : a[0].localeCompare(b[0])))[0]?.[0] ?? null
}
