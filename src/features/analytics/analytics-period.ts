/**
 * Reporting periods for the analytics pages. Pure date arithmetic on ISO
 * dates (YYYY-MM-DD) so results do not depend on the browser's time zone;
 * "today" comes from the server in the company time zone.
 */

export type PeriodPreset = 'today' | 'this_week' | 'this_month' | 'previous_month' | 'this_quarter' | 'current_fy' | 'previous_fy' | 'custom'

export const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'previous_month', label: 'Previous month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'current_fy', label: 'Current financial year' },
  { value: 'previous_fy', label: 'Previous financial year' },
  { value: 'custom', label: 'Custom range' },
]

export interface Period {
  preset: PeriodPreset
  from: string
  to: string
}

const pad = (n: number) => String(n).padStart(2, '0')
export const isoOf = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}
export function partsOf(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d }
}
export const isIsoDate = (s: string | null | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(...(Object.values(partsOf(s)) as [number, number, number])) === s)

export function addDays(iso: string, days: number): string {
  const { y, m, d } = partsOf(iso)
  return isoOf(y, m, d + days)
}

export function daysBetween(from: string, to: string): number {
  const a = partsOf(from)
  const b = partsOf(to)
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000)
}

/** Start of the financial year containing `iso` (April-March when startMonth = 4). */
export function fyStart(iso: string, startMonth = 4): string {
  const { y, m } = partsOf(iso)
  return isoOf(m >= startMonth ? y : y - 1, startMonth, 1)
}

export function fyLabel(startIso: string, startMonth = 4): string {
  const { y } = partsOf(startIso)
  return startMonth === 1 ? String(y) : `${y}-${String((y + 1) % 100).padStart(2, '0')}`
}

/** Date range of a preset, ending no later than today (no future dates). */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, today: string, startMonth = 4): { from: string; to: string } {
  const { y, m, d } = partsOf(today)
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'this_week': {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
      return { from: addDays(today, -((dow + 6) % 7)), to: today }
    }
    case 'this_month':
      return { from: isoOf(y, m, 1), to: today }
    case 'previous_month':
      return { from: isoOf(y, m - 1, 1), to: isoOf(y, m, 0) }
    case 'this_quarter': {
      // Quarters aligned to the financial year (Apr-Jun, Jul-Sep, ... for April).
      const offset = (((m - startMonth) % 3) + 3) % 3
      return { from: isoOf(y, m - offset, 1), to: today }
    }
    case 'current_fy':
      return { from: fyStart(today, startMonth), to: today }
    case 'previous_fy': {
      const start = fyStart(today, startMonth)
      return { from: fyStart(addDays(start, -1), startMonth), to: addDays(start, -1) }
    }
  }
}

/** The last `count` financial years, the current one first (its end is today). */
export function financialYears(today: string, startMonth = 4, count = 5): { label: string; from: string; to: string }[] {
  const out: { label: string; from: string; to: string }[] = []
  let start = fyStart(today, startMonth)
  for (let i = 0; i < count; i++) {
    const { y } = partsOf(start)
    const end = addDays(isoOf(y + 1, startMonth, 1), -1)
    out.push({ label: fyLabel(start, startMonth), from: start, to: i === 0 ? today : end })
    start = fyStart(addDays(start, -1), startMonth)
  }
  return out
}

/** Bucket that keeps trend charts readable for the range length. */
export function bucketFor(from: string, to: string): 'day' | 'week' | 'month' {
  const days = daysBetween(from, to) + 1
  if (days <= 62) return 'day'
  if (days <= 190) return 'week'
  return 'month'
}

const LONG = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
const MONTH = new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' })
const DAY = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' })
const toUtc = (iso: string) => { const { y, m, d } = partsOf(iso); return new Date(Date.UTC(y, m - 1, d)) }
export const formatIso = (iso: string) => LONG.format(toUtc(iso))
export const formatBucket = (iso: string, bucket: string) => (bucket === 'month' ? MONTH.format(toUtc(iso)) : DAY.format(toUtc(iso)))
export const describePeriod = (p: { from: string; to: string }) => (p.from === p.to ? formatIso(p.from) : `${formatIso(p.from)} – ${formatIso(p.to)}`)

/**
 * The instant a calendar day starts in a time zone (e.g. "2026-10-01" in
 * Asia/Kolkata -> 2026-09-30T18:30:00.000Z), used to filter timestamp columns
 * the same way the database does.
 */
export function dayStartInstant(iso: string, timeZone: string): string {
  const { y, m, d } = partsOf(iso)
  const guess = Date.UTC(y, m - 1, d)
  const offsetMinutes = (instant: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(instant))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return (local - instant) / 60_000
  }
  const first = guess - offsetMinutes(guess) * 60_000
  return new Date(guess - offsetMinutes(first) * 60_000).toISOString()
}
