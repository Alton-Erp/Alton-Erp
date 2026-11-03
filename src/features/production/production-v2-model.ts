// Stage 4 production helpers. Pure TypeScript (relative imports, no React) so
// they can be unit-tested with Node. The database recalculates and validates
// everything again (supabase/migrations/20261105090000_production_v2.sql).
import { bomRequirement, isWholeUnit, parseUnitQty } from '../inventory/whole-units.ts'

export const SOURCE_TYPE_LABELS: Record<string, string> = { IN_HOUSE: 'In-house', OUTSOURCED: 'Outsourced', PURCHASED: 'Purchased' }

export const V2_EVENT_LABELS: Record<string, string> = {
  PRODUCTION_RECORDED: 'Production recorded',
  PRODUCTION_REVERSED: 'Production reversed',
  PRODUCTION_CORRECTED: 'Production corrected',
  REOPENED: 'Reopened',
}

/** Status words for the simple flow (the step-by-step statuses still exist underneath). */
export function simpleStatus(status: string): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' } {
  switch (status) {
    case 'DRAFT': case 'PENDING_APPROVAL': return { label: 'Draft', tone: 'neutral' }
    case 'APPROVED': return { label: 'Open', tone: 'info' }
    case 'MATERIALS_RESERVED': return { label: 'Open · materials reserved', tone: 'info' }
    case 'IN_PROGRESS': case 'PARTIALLY_COMPLETED': return { label: 'In production', tone: 'warning' }
    case 'COMPLETED': return { label: 'Completed', tone: 'success' }
    case 'ON_HOLD': return { label: 'On hold', tone: 'warning' }
    case 'CANCELLED': return { label: 'Cancelled', tone: 'danger' }
    default: return { label: status, tone: 'neutral' }
  }
}

export interface UnitQty { unit: string; quantity: number | string }

/** "1,200 PCS · 50 KG" — quantities of different units are never added together. */
export function formatByUnit(list: UnitQty[] | null | undefined): string {
  if (!list || list.length === 0) return '0'
  const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })
  return list.map((q) => `${fmt.format(Number(q.quantity))} ${q.unit}`).join(' · ')
}

export interface MaterialLine {
  order_material_id: string
  sku: string
  unit: string
  quantity_per_unit: number | string
  wastage_percentage: number | string
  issued?: number | string
}

/** Standard consumption for a produced quantity (BOM ratio plus wastage, rounded like the database). */
export function standardFor(line: Pick<MaterialLine, 'quantity_per_unit' | 'wastage_percentage' | 'unit'>, produced: number): number {
  if (!(produced > 0)) return 0
  return bomRequirement(Number(line.quantity_per_unit), 1, produced, Number(line.wastage_percentage), line.unit).planned
}

/** Default "consumed now" per material: the standard for the output minus anything already issued. */
export function defaultConsumption(lines: MaterialLine[], produced: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of lines) {
    const q = Math.max(standardFor(l, produced) - Number(l.issued ?? 0), 0)
    out[l.order_material_id] = String(Math.round(q * 1000) / 1000)
  }
  return out
}

export interface CompletionInput {
  actual: string
  rejected: string
  wastage: string
  consumed: Record<string, string>
}

/** Browser-side checks of the completion form; returns messages (empty = ok). */
export function validateCompletion(input: CompletionInput, unit: string, lines: MaterialLine[]): string[] {
  const errors: string[] = []
  const actual = parseUnitQty(input.actual, unit, { allowZero: true })
  const rejected = parseUnitQty(input.rejected, unit, { allowZero: true })
  const wastage = parseUnitQty(input.wastage, unit, { allowZero: true })
  const rule = isWholeUnit(unit) ? `whole ${unit}` : 'up to 3 decimals'
  if (actual === null) errors.push(`Actual quantity must be a number (${rule}).`)
  if (rejected === null) errors.push(`Rejected quantity must be a number (${rule}).`)
  if (wastage === null) errors.push(`Wastage must be a number (${rule}).`)
  if (actual !== null && wastage !== null && actual + wastage === 0) errors.push('Enter the actual quantity produced.')
  if (actual !== null && rejected !== null && rejected > actual) errors.push('Rejected quantity cannot be more than the actual quantity produced.')
  for (const l of lines) {
    const v = input.consumed[l.order_material_id] ?? ''
    if (parseUnitQty(v, l.unit, { allowZero: true }) === null) errors.push(`${l.sku}: quantity consumed must be ${isWholeUnit(l.unit) ? `whole ${l.unit}` : 'a number with up to 3 decimals'}.`)
  }
  return errors
}

// ---------------------------------------------------------------------------
// Excel upload
// ---------------------------------------------------------------------------
export const PRODUCTION_IMPORT_COLUMNS = ['Production Date', 'Finished Product SKU', 'Planned Quantity', 'Actual Quantity', 'Rejected Quantity', 'Remarks'] as const
export const MAX_PRODUCTION_IMPORT_ROWS = 1000

type FieldKey = 'production_date' | 'sku' | 'planned_quantity' | 'actual_quantity' | 'rejected_quantity' | 'remarks'
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  production_date: ['production date', 'date', 'prod date'],
  sku: ['finished product sku', 'sku', 'product sku', 'finished sku', 'product code', 'item code'],
  planned_quantity: ['planned quantity', 'planned qty', 'planned', 'plan qty'],
  actual_quantity: ['actual quantity', 'actual qty', 'actual', 'produced', 'produced quantity'],
  rejected_quantity: ['rejected quantity', 'rejected qty', 'rejected', 'rejection'],
  remarks: ['remarks', 'remark', 'notes', 'comments'],
}
const REQUIRED: FieldKey[] = ['production_date', 'sku', 'planned_quantity']
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export interface ProductionImportRow {
  row_number: number
  production_date: string
  sku: string
  planned_quantity: string
  actual_quantity: string
  rejected_quantity: string
  remarks: string
}

/** Dates as YYYY-MM-DD; DD-MM-YYYY, DD/MM/YYYY and DD.MM.YYYY are converted. Anything else is passed on (the server reports it). */
// Order of day and month in imported dates such as 03/04/2026 (ERP Settings → Excel import).
let importDateOrder: 'DMY' | 'MDY' = 'DMY'
export function setImportDateOrder(order: 'DMY' | 'MDY') {
  importDateOrder = order === 'MDY' ? 'MDY' : 'DMY'
}

export function normalizeImportDate(text: string): string {
  const t = text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t)
  if (m) {
    const [, a, b, y] = m
    const [d, mo] = importDateOrder === 'MDY' ? [b, a] : [a, b]
    const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
    const dt = new Date(`${iso}T00:00:00Z`)
    if (!Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso) return iso
  }
  return t
}

/**
 * Finds the header row (first row naming the required columns) and maps the
 * data rows. Blank rows are not records and are left out; every other row is
 * returned, valid or not, so nothing is skipped silently.
 */
export function parseProductionSheet(rows: string[][]): { headerRow: number; missing: string[]; rows: ProductionImportRow[] } {
  let headerIndex = -1
  let map: Partial<Record<FieldKey, number>> = {}
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] ?? []).map((c) => norm(String(c ?? '')))
    const found: Partial<Record<FieldKey, number>> = {}
    for (const key of Object.keys(FIELD_ALIASES) as FieldKey[]) {
      const idx = cells.findIndex((c) => FIELD_ALIASES[key].includes(c))
      if (idx >= 0) found[key] = idx
    }
    if (REQUIRED.every((k) => found[k] !== undefined)) { headerIndex = i; map = found; break }
  }
  if (headerIndex < 0) {
    return { headerRow: 0, missing: ['Production Date', 'Finished Product SKU', 'Planned Quantity'], rows: [] }
  }
  const cell = (r: string[], k: FieldKey) => (map[k] === undefined ? '' : String(r[map[k]!] ?? '').trim())
  const out: ProductionImportRow[] = []
  rows.slice(headerIndex + 1).forEach((r, i) => {
    if (!r || r.every((c) => String(c ?? '').trim() === '')) return
    out.push({
      row_number: headerIndex + i + 2,
      production_date: normalizeImportDate(cell(r, 'production_date')),
      sku: cell(r, 'sku'),
      planned_quantity: cell(r, 'planned_quantity').replace(/,/g, ''),
      actual_quantity: cell(r, 'actual_quantity').replace(/,/g, ''),
      rejected_quantity: cell(r, 'rejected_quantity').replace(/,/g, ''),
      remarks: cell(r, 'remarks'),
    })
  })
  return { headerRow: headerIndex + 1, missing: [], rows: out }
}

export function productionTemplateRows(today: string): (string | number)[][] {
  return [
    [...PRODUCTION_IMPORT_COLUMNS],
    [today, 'FG-000001', 100, '', '', 'Open order: materials are reserved, nothing is consumed yet'],
    [today, 'FG-000001', 50, 50, 2, 'Completed production: materials consumed, 48 accepted into stock'],
  ]
}

export interface ImportPreviewRow {
  row_number: number
  status: 'VALID' | 'WARNING' | 'ERROR'
  errors: string[]
  warnings: string[]
  sku: string | null
  product_name: string | null
  bom_code: string | null
  bom_version: number | null
  production_date: string | null
  planned_quantity: number | null
  actual_quantity: number | null
  rejected_quantity: number | null
  complete: boolean
}

/** Error report: every row with its outcome and messages. */
export function buildProductionImportReport(
  rows: ImportPreviewRow[],
  results?: { created: { row_number: number; production_order_number: string; status: string }[]; failed: { row_number: number; messages: string[] }[] },
): (string | number)[][] {
  const created = new Map((results?.created ?? []).map((c) => [c.row_number, c]))
  const failed = new Map((results?.failed ?? []).map((f) => [f.row_number, f]))
  return [
    ['Row', 'Finished Product SKU', 'Production Date', 'Planned', 'Actual', 'Rejected', 'Result', 'Order', 'Errors', 'Warnings'],
    ...rows.map((r) => {
      const c = created.get(r.row_number)
      const f = failed.get(r.row_number)
      const result = c ? (c.status === 'COMPLETED' ? 'Recorded (completed)' : 'Order created') : f ? 'Not imported' : r.status === 'ERROR' ? 'Error' : 'Ready'
      const errors = f ? f.messages : r.errors
      return [r.row_number, r.sku ?? '', r.production_date ?? '', r.planned_quantity ?? '', r.actual_quantity ?? '', r.rejected_quantity ?? '',
        result, c?.production_order_number ?? '', errors.join(' '), r.warnings.join(' ')]
    }),
  ]
}
