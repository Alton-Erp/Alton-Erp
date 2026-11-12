// Layout rules shared by the dashboard charts, kept free of React so they can be unit-tested:
// enough height per bar, labels truncated (full text in a tooltip), value labels given room,
// compact Indian axis ticks and top-N grouping with an "Others" row.

/** Height of one bar row (bar plus spacing) in a horizontal bar chart. */
export const BAR_ROW_HEIGHT = 30
const BAR_CHART_PADDING = 16
/** Average glyph width of the 12px axis font, used to size labels without measuring the DOM. */
const CHAR_PX = 7

/** Pixel height a horizontal bar chart needs so that no two category labels overlap. */
export function barChartHeight(rows: number, rowHeight = BAR_ROW_HEIGHT): number {
  return Math.max(rows, 1) * rowHeight + BAR_CHART_PADDING
}

/** Card height for a bar chart: grows with the rows, scrolls inside once above `max`. */
export function barCardHeight(rows: number, { min = 200, max = 560 }: { min?: number; max?: number } = {}): number {
  return Math.min(Math.max(barChartHeight(rows), min), max)
}

/** Characters that fit in an axis label of `widthPx` pixels. */
export const labelChars = (widthPx: number) => Math.max(Math.floor((widthPx - 8) / CHAR_PX), 4)

/** Shortens a label to `max` characters with an ellipsis (the full text goes in the tooltip). */
export function truncateLabel(label: string, max: number): string {
  const s = String(label ?? '')
  return s.length <= max ? s : `${s.slice(0, Math.max(max - 1, 1)).trimEnd()}…`
}

/** Right margin that keeps the longest value label inside the chart. */
export function valueLabelMargin(formatted: string[]): number {
  const longest = formatted.reduce((m, s) => Math.max(m, s.length), 0)
  return Math.max(longest * CHAR_PX + 12, 40)
}

/** Width of a numeric Y axis for the given tick texts. */
export function axisWidth(ticks: string[]): number {
  const longest = ticks.reduce((m, s) => Math.max(m, s.length), 0)
  return Math.min(Math.max(longest * CHAR_PX + 8, 40), 96)
}

const COMPACT = [
  { value: 1e7, suffix: 'Cr' },
  { value: 1e5, suffix: 'L' },
  { value: 1e3, suffix: 'K' },
] as const

/**
 * Compact Indian axis tick: 5,26,000 → "5.26L", 1,20,00,000 → "1.2Cr", 12,500 → "12.5K".
 * Axis ticks only; tooltips, labels and tables keep the full figure.
 */
export function compactIndian(value: number): string {
  if (!Number.isFinite(value)) return ''
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  for (const { value: v, suffix } of COMPACT) {
    if (abs >= v) {
      const n = abs / v
      const text = n >= 100 ? Math.round(n).toLocaleString('en-IN') : String(Number(n.toFixed(n >= 10 ? 1 : 2)))
      return `${sign}${text}${suffix}`
    }
  }
  return `${sign}${Number(abs.toFixed(2)).toLocaleString('en-IN')}`
}

export interface RankedDatum {
  label: string
  value: number
  /** True for the grouped "Others" row (no single record behind it). */
  others?: boolean
  /** Categories folded into the "Others" row. */
  members?: number
  /** Position in the input array (for drill-downs); -1 for "Others". */
  index: number
}

/**
 * Sorts by value (largest first) and keeps the first `limit` rows; the rest are added up into one
 * "Others" row when there is more than one of them. `limit` null keeps every row.
 */
export function rankTopN(data: { label: string; value: number }[], limit: number | null, othersLabel = 'Others'): RankedDatum[] {
  const sorted = data
    .map((d, index) => ({ label: d.label, value: Number(d.value) || 0, index }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
  if (limit === null || sorted.length <= limit + 1) return sorted
  const head = sorted.slice(0, limit)
  const rest = sorted.slice(limit)
  return [...head, { label: `${othersLabel} (${rest.length})`, value: rest.reduce((s, d) => s + d.value, 0), others: true, members: rest.length, index: -1 }]
}
