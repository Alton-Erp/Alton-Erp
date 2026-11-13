import type { DateRangePreset, DateRangeValue } from '@/types'
import { formatDate } from '@/lib/format'

export const DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_month', label: 'This Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' },
]

/** Management Dashboard filter: Today / This week / This month / This year / Custom. */
export const DASHBOARD_DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' },
]

/** Extended presets used by inventory pages. */
/** Support Centre: Today, Yesterday, This Week, This Month, Custom Range. */
export const SUPPORT_DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'custom', label: 'Custom Range' },
]

export const EXTENDED_DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last_7_days', label: 'Last 7 Days' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'this_year', label: 'This Year' },
  { value: 'previous_year', label: 'Previous Year' },
  { value: 'custom', label: 'Custom' },
]

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

export function getPresetRange(
  preset: Exclude<DateRangePreset, 'custom'>,
  now = new Date(),
): DateRangeValue {
  switch (preset) {
    case 'today':
      return { preset, from: startOfDay(now), to: endOfDay(now) }
    case 'yesterday': {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      return { preset, from: startOfDay(y), to: endOfDay(y) }
    }
    case 'this_week': {
      // Weeks start on Monday (Indian business convention).
      const back = (now.getDay() + 6) % 7
      return { preset, from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - back), to: endOfDay(now) }
    }
    case 'last_7_days':
      return { preset, from: startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: endOfDay(now) }
    case 'this_month':
      return { preset, from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) }
    case 'last_month':
      return {
        preset,
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1),
        to: endOfDay(new Date(now.getFullYear(), now.getMonth(), 0)),
      }
    case 'this_year':
      return { preset, from: new Date(now.getFullYear(), 0, 1), to: endOfDay(now) }
    case 'previous_year':
      return { preset, from: new Date(now.getFullYear() - 1, 0, 1), to: endOfDay(new Date(now.getFullYear() - 1, 11, 31)) }
  }
}

export function createCustomRange(from: Date, to: Date): DateRangeValue {
  const [start, end] = from <= to ? [from, to] : [to, from]
  return { preset: 'custom', from: startOfDay(start), to: endOfDay(end) }
}

/** Bucket size that keeps a trend chart readable for the range length. */
export function bucketForRange(range: DateRangeValue): 'day' | 'week' | 'month' | 'year' {
  const days = daysInRange(range)
  if (days <= 62) return 'day'
  if (days <= 190) return 'week'
  if (days <= 1100) return 'month'
  return 'year'
}

export function describeRange(range: DateRangeValue): string {
  if (range.preset === 'today') return formatDate(range.from)
  return `${formatDate(range.from)} – ${formatDate(range.to)}`
}

export function isWithinRange(date: Date, range: DateRangeValue): boolean {
  return date >= range.from && date <= range.to
}

export function daysInRange(range: DateRangeValue): number {
  return Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000))
}
