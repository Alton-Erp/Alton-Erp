// BOM "Product Planning & Classification": the finished product's tax rate,
// lead time, group head and minimum stock days (stored on the Product Master:
// products.gst_rate, lead_time_days, group_head, minimum_cover_days), plus the BOM
// Excel export layout. Pure TypeScript (no React/Supabase) so it is unit-tested.

import { parseDecimal } from '../products/product-model.ts'

/** Upper limit for planning days (10 years), as in the Product Master. */
export const MAX_PLANNING_DAYS = 3650

export interface BomPlanningValues {
  taxRate: string
  leadTimeDays: string
  groupHead: string
  minimumCoverDays: string
}

/** The product columns the planning fields are stored in. */
export interface BomPlanningPatch {
  gst_rate?: number | null
  lead_time_days?: number | null
  group_head?: string | null
  minimum_cover_days?: number | null
}

export interface StoredPlanning {
  gst_rate?: number | string | null
  lead_time_days?: number | string | null
  group_head?: string | null
  minimum_cover_days?: number | string | null
}

export const PLANNING_LABELS: Record<keyof BomPlanningPatch, string> = {
  gst_rate: 'Tax Rate (%)',
  lead_time_days: 'Lead Time (Days)',
  group_head: 'Group Head',
  minimum_cover_days: 'Minimum Stock Days',
}

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)))

export const planningValuesFrom = (p: StoredPlanning | null | undefined): BomPlanningValues => ({
  taxRate: str(p?.gst_rate),
  leadTimeDays: str(p?.lead_time_days),
  groupHead: p?.group_head ?? '',
  minimumCoverDays: str(p?.minimum_cover_days),
})

/** Tax rate problem (0–100 %, up to 2 decimals), or null. */
export function taxRateProblem(value: string): string | null {
  const n = parseDecimal(value, 2)
  if (n === undefined) return null
  if (Number.isNaN(n) || n < 0 || n > 100) return `Tax Rate "${value}" must be a percentage from 0 to 100 (up to 2 decimals).`
  return null
}

/** Days problem (0–3650, up to 2 decimals), or null. */
export function daysProblem(label: string, value: string): string | null {
  const n = parseDecimal(value, 2)
  if (n === undefined) return null
  if (Number.isNaN(n) || n < 0 || n > MAX_PLANNING_DAYS) return `${label} "${value}" must be a number of days from 0 to ${MAX_PLANNING_DAYS} (up to 2 decimals).`
  return null
}

export const normalizeGroupHead = (value: string) => value.trim().replace(/\s+/g, ' ')

/**
 * Validates the form / file values and returns the product columns they set.
 * A blank value clears the field (form) — imports pass only non-blank values.
 */
export function validatePlanning(values: Partial<BomPlanningValues>): { errors: Partial<Record<keyof BomPlanningValues, string>>; patch: BomPlanningPatch } {
  const errors: Partial<Record<keyof BomPlanningValues, string>> = {}
  const patch: BomPlanningPatch = {}
  if (values.taxRate !== undefined) {
    const p = taxRateProblem(values.taxRate)
    if (p) errors.taxRate = p
    else patch.gst_rate = parseDecimal(values.taxRate, 2) ?? null
  }
  if (values.leadTimeDays !== undefined) {
    const p = daysProblem('Lead Time', values.leadTimeDays)
    if (p) errors.leadTimeDays = p
    else patch.lead_time_days = parseDecimal(values.leadTimeDays, 2) ?? null
  }
  if (values.minimumCoverDays !== undefined) {
    const p = daysProblem('Minimum Stock Days', values.minimumCoverDays)
    if (p) errors.minimumCoverDays = p
    else patch.minimum_cover_days = parseDecimal(values.minimumCoverDays, 2) ?? null
  }
  if (values.groupHead !== undefined) {
    const g = normalizeGroupHead(values.groupHead)
    if (g.length > 100) errors.groupHead = 'Group Head is limited to 100 characters.'
    else patch.group_head = g || null
  }
  return { errors, patch }
}

const same = (a: unknown, b: unknown) => {
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === ''
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return String(a) === String(b)
}

/** Only the fields that differ from what the product has stored. */
export function planningChanges(stored: StoredPlanning | null | undefined, patch: BomPlanningPatch): { patch: BomPlanningPatch; changes: { label: string; from: string; to: string }[] } {
  const out: BomPlanningPatch = {}
  const changes: { label: string; from: string; to: string }[] = []
  for (const key of Object.keys(patch) as (keyof BomPlanningPatch)[]) {
    const from = stored?.[key] ?? null
    const to = patch[key] ?? null
    if (!same(from, to)) {
      ;(out as Record<string, unknown>)[key] = to
      changes.push({ label: PLANNING_LABELS[key], from: from === null || from === '' ? '—' : String(typeof from === 'string' && key !== 'group_head' ? Number(from) : from), to: to === null ? '—' : String(to) })
    }
  }
  return { patch: out, changes }
}

// ---------------------------------------------------------------------------
// BOM Excel export (same columns as the import template, so it can be re-imported)
// ---------------------------------------------------------------------------
export interface BomExportBom {
  id: string
  bom_code: string
  version: number
  status: string
  sku: string
  product_name: string
  product_type: string
  output_quantity: number | string
  tax_rate?: number | string | null
  lead_time_days?: number | string | null
  group_head?: string | null
  minimum_cover_days?: number | string | null
}

export interface BomExportItem {
  bom_id: string
  line_no: number
  sku: string
  quantity_required: number | string
  unit: string
  wastage_percentage: number | string
  source_type?: string | null
  preferred_supplier_id?: string | null
  notes?: string | null
}

export const BOM_EXPORT_EXTRA_COLUMNS = ['BOM Code', 'Version', 'Status'] as const

const n = (v: number | string | null | undefined) => (v === null || v === undefined || v === '' ? '' : Number(v))

/**
 * One row per component, in the import template's column order
 * (headers = the import labels), plus BOM code, version and status for reference.
 * A BOM without components gets one row with its header values.
 */
export function bomExportRows(
  headers: readonly string[],
  boms: BomExportBom[],
  items: BomExportItem[],
  opts: { typeLabel: (t: string) => string; sourceLabel: (s: string) => string; supplierCode: (id: string) => string },
): (string | number)[][] {
  const byBom = new Map<string, BomExportItem[]>()
  for (const i of items) byBom.set(i.bom_id, [...(byBom.get(i.bom_id) ?? []), i])
  const rows: (string | number)[][] = [[...headers, ...BOM_EXPORT_EXTRA_COLUMNS]]
  for (const b of boms) {
    const lines = (byBom.get(b.id) ?? []).sort((x, y) => x.line_no - y.line_no)
    const head: Record<string, string | number> = {
      'Finished Product SKU': b.sku, 'Product Name': b.product_name, 'Product Type': opts.typeLabel(b.product_type),
      'Tax Rate (%)': n(b.tax_rate), 'Lead Time (Days)': n(b.lead_time_days), 'Group Head': b.group_head ?? '',
      'Minimum Stock Days': n(b.minimum_cover_days), 'Output Quantity': n(b.output_quantity),
    }
    for (const l of lines.length > 0 ? lines : [null]) {
      const cells: Record<string, string | number> = {
        ...head,
        'Component SKU': l?.sku ?? '', 'Quantity per Output': l ? n(l.quantity_required) : '', Unit: l?.unit ?? '',
        Source: l?.source_type ? opts.sourceLabel(l.source_type) : '', 'Wastage %': l ? n(l.wastage_percentage) : '',
        'Preferred Supplier': l?.preferred_supplier_id ? opts.supplierCode(l.preferred_supplier_id) : '', Remarks: l?.notes ?? '',
      }
      rows.push([...headers.map((h) => cells[h] ?? ''), b.bom_code, b.version, b.status])
    }
  }
  return rows
}
