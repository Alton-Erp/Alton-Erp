import { CURRENCY, LOCALE } from '@/config/app'
import { DATE_PATTERNS, formatDatePattern, type DatePattern } from '@/lib/date-pattern'

const numberFormatter = new Intl.NumberFormat(LOCALE)
const currencyFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  maximumFractionDigits: 0,
})
const compactCurrencyFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: CURRENCY,
  notation: 'compact',
  maximumFractionDigits: 1,
})
const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

export function formatNumber(value: number): string {
  return numberFormatter.format(value)
}

export function formatCurrency(value: number): string {
  return currencyFormatter.format(value)
}

export function formatCompactCurrency(value: number): string {
  return compactCurrencyFormatter.format(value)
}

// Company date format (ERP Settings); "DD MMM YYYY" uses the locale formatter as before.
let datePattern: DatePattern = 'DD MMM YYYY'
export function setDatePattern(pattern: DatePattern) {
  datePattern = DATE_PATTERNS.includes(pattern) ? pattern : 'DD MMM YYYY'
}
export const getDatePattern = () => datePattern

export function formatDate(value: Date | string): string {
  // Date-only strings are calendar dates; full timestamps are shown in local time.
  const date = typeof value === 'string' ? (value.includes('T') ? new Date(value) : parseIsoDate(value)) : value
  return datePattern === 'DD MMM YYYY' ? dateFormatter.format(date) : formatDatePattern(date, datePattern)
}

/**
 * Date + time in the given IANA timezone (e.g. the company's configured
 * timezone). Database timestamps are stored in UTC.
 */
export function formatDateTime(value: Date | string, timeZone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value
  try {
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date)
  } catch {
    // Unknown timezone: fall back to the browser's.
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** yyyy-mm-dd in local time (avoids UTC shifting of toISOString). */
export function toIsoDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Parses yyyy-mm-dd as a local date. */
export function parseIsoDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}
