import type { CellValue } from '@/features/products/spreadsheet'

/** Display helpers for analytics. Values are always computed by the database. */

const QTY = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })
const MONEY = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 0 })
const MONEY_EXACT = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const COMPACT = new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 })

export const qty = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : QTY.format(Number(v)))
/** Whole-rupee display for KPI cards; exports keep the exact 2-decimal value. */
export const inr = (v: number | string | null | undefined, exact = false) => (v === null || v === undefined ? '—' : (exact ? MONEY_EXACT : MONEY).format(Number(v)))
export const compact = (v: number) => COMPACT.format(v)

/** Percentage with one decimal; null (no denominator) shows a dash, never 0%. */
export const pct = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 })}%`)

/** a / b as a percentage with one decimal, or null when b is zero (undefined, not 0%). */
export function percentOf(a: number, b: number): number | null {
  if (!b) return null
  return Math.round((1000 * a) / b) / 10
}

/**
 * Quantities per unit, e.g. "110 PCS · 4 NOS". Units are never added
 * together. An empty list means none (zero), shown as "0".
 */
export function unitList<T extends { unit: string }>(rows: T[] | null | undefined, field: keyof T): string {
  const items = (rows ?? []).filter((r) => Number(r[field]) !== 0)
  if (!items.length) return '0'
  return items.map((r) => `${qty(Number(r[field]))} ${r.unit}`).join(' · ')
}

/** Sum money values in paise to avoid floating-point drift in client totals. */
export const sumMoney = (values: (number | string | null | undefined)[]) =>
  values.reduce<number>((s, v) => s + Math.round(Number(v ?? 0) * 100), 0) / 100

export const STATUS_LABEL = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export interface ActiveFilter {
  label: string
  value: string
}

/** Rows describing the report for exports and print headers. */
export function reportMetaRows(meta: {
  title: string
  company: string
  generatedAt: string
  period: string
  asOf?: string | null
  filters: ActiveFilter[]
  notes?: string[]
}): CellValue[][] {
  const rows: CellValue[][] = [
    ['Report', meta.title],
    ['Company', meta.company],
    ['Generated at', meta.generatedAt],
    ['Reporting period', meta.period],
  ]
  if (meta.asOf) rows.push(['Balances / current state as of', meta.asOf])
  rows.push(['Filters', meta.filters.length ? meta.filters.map((f) => `${f.label}: ${f.value}`).join('; ') : 'None'])
  for (const n of meta.notes ?? []) rows.push(['Note', n])
  return rows
}

export interface ExportSection {
  name: string
  headers: string[]
  rows: CellValue[][]
}

/**
 * Builds the sheets of an export: a report-information sheet followed by one
 * sheet per section (Excel), or everything on one sheet (CSV).
 */
export function buildExportSheets(meta: CellValue[][], sections: ExportSection[], format: 'xlsx' | 'csv'): { name: string; rows: CellValue[][] }[] {
  if (format === 'xlsx') {
    return [{ name: 'Report info', rows: meta }, ...sections.map((s) => ({ name: s.name.slice(0, 31), rows: [s.headers, ...s.rows] }))]
  }
  const rows: CellValue[][] = [...meta]
  for (const s of sections) rows.push([], [s.name], s.headers, ...s.rows)
  return [{ name: 'Report', rows }]
}
