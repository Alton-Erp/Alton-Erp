import type { CellValue } from '@/features/products/spreadsheet'
import type {
  BatchDetail, BatchLine, BatchLineInput, BatchStatus, BulkOperation, ResolvedSku, RevisionRow, WhereUsedRow, WhereUsedStatus,
} from '@/services/bom-bulk'

/** Bulk BOM management: labels, Excel import parsing / validation and export rows (pure, unit-tested). */

export const OPERATION_LABELS: Record<BulkOperation, string> = {
  REPLACE: 'Bulk replace',
  DELETE: 'Bulk delete',
  ADD: 'Bulk add',
  EDIT: 'Bulk edit',
  RESTORE: 'Reversal',
}

export const OPERATION_HINTS: Record<Exclude<BulkOperation, 'RESTORE'>, string> = {
  REPLACE: 'Swap one component for another in the selected BOMs. Quantities and wastage are kept unless you change them.',
  DELETE: 'Remove a component from the selected BOMs. Earlier revisions keep it.',
  ADD: 'Add one or more components to several BOMs, with a quantity per BOM.',
  EDIT: 'Change quantity, wastage, notes or source of a component in the selected BOMs.',
}

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  APPROVED: 'Approved — ready to publish',
  REJECTED: 'Rejected',
  PUBLISHED: 'Published',
  CANCELLED: 'Cancelled',
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export const BATCH_STATUS_TONE: Record<BatchStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  REJECTED: 'danger',
  PUBLISHED: 'success',
  CANCELLED: 'neutral',
}

export const LIFECYCLE_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  SCHEDULED: 'Scheduled',
  SUPERSEDED: 'Superseded',
  ARCHIVED: 'Archived',
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  REJECTED: 'Rejected',
}

export const WHERE_USED_FILTERS: { value: WhereUsedStatus; label: string }[] = [
  { value: 'CURRENT', label: 'Current revisions' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'PENDING_APPROVAL', label: 'Pending approval' },
  { value: 'SUPERSEDED', label: 'Superseded' },
  { value: 'ARCHIVED', label: 'Archived' },
  { value: 'ALL', label: 'All versions' },
]

export const EVENT_LABELS: Record<string, string> = {
  CREATED: 'Created',
  EDITED: 'Edited',
  SUBMITTED: 'Submitted for approval',
  WITHDRAWN: 'Withdrawn',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PUBLISHED: 'Published',
  PUBLISH_FAILED: 'Publishing failed (nothing changed)',
  CANCELLED: 'Cancelled',
}

const trimNum = (v: number) => String(Number(v.toFixed(6)))

const blank = (v: unknown) => v === undefined || v === null || v === ''

/** Drops empty optional values so the server applies its defaults (keep quantity, wastage …); notes are kept as given. */
export function cleanLine(line: BatchLineInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(line)) {
    if (k === 'notes') { if (v !== undefined) out[k] = v; continue }
    if (!blank(v)) out[k] = typeof v === 'number' ? String(v) : v
  }
  return out
}

export function qtyText(q: number | null | undefined, unit: string | null | undefined): string {
  if (q === null || q === undefined) return '—'
  return `${trimNum(Number(q))}${unit ? ` ${unit}` : ''}`
}

/** "1.5 KG → 3 PCS" style description of one line (old → new). */
export function changeText(l: BatchLine): string {
  switch (l.action) {
    case 'DELETE':
      return `Remove ${qtyText(l.old_quantity, l.old_unit)}`
    case 'ADD':
      return l.old_quantity !== null ? `Add ${qtyText(l.new_quantity, l.new_unit)} to existing ${qtyText(l.old_quantity, l.old_unit)}` : `Add ${qtyText(l.new_quantity, l.new_unit)}`
    case 'RESTORE':
      return 'Restore all components of the earlier revision'
    default: {
      const q = `${qtyText(l.old_quantity, l.old_unit)} → ${qtyText(l.new_quantity, l.new_unit)}`
      const w = l.old_wastage !== null && l.new_wastage !== null && Number(l.old_wastage) !== Number(l.new_wastage)
        ? `; wastage ${trimNum(Number(l.old_wastage))}% → ${trimNum(Number(l.new_wastage))}%` : ''
      return q + w
    }
  }
}

export function quantityDelta(l: BatchLine): number | null {
  if (l.action === 'DELETE') return l.old_quantity === null ? null : -Number(l.old_quantity)
  if (l.action === 'RESTORE' || l.new_quantity === null) return null
  if (l.old_unit && l.new_unit && l.old_unit !== l.new_unit) return null
  return Number(l.new_quantity) - Number(l.old_quantity ?? 0)
}

/** Distinct BOMs (by source BOM) that have at least one error. */
export function bomsWithErrors(lines: BatchLine[]): Set<string> {
  return new Set(lines.filter((l) => l.validation_errors.length > 0).map((l) => l.source_bom_id))
}

/** Line ids of every line belonging to a BOM that has an error (to remove them together). */
export function lineIdsOfFailingBoms(lines: BatchLine[]): string[] {
  const bad = bomsWithErrors(lines)
  return lines.filter((l) => bad.has(l.source_bom_id)).map((l) => l.id)
}

// ---------------------------------------------------------------------------
// Excel import
// ---------------------------------------------------------------------------
export type ImportOperation = Exclude<BulkOperation, 'RESTORE'>

interface ImportColumn { key: keyof ImportRowValues; label: string; aliases: string[]; required: boolean }
export interface ImportRowValues {
  finishedSku: string
  componentSku: string
  newComponentSku: string
  quantity: string
  factor: string
  unit: string
  wastage: string
  notes: string
}
export interface ImportRow extends ImportRowValues {
  rowNumber: number
  errors: string[]
  finishedProductId?: string
  componentId?: string
  newComponentId?: string
}

const col = (key: keyof ImportRowValues, label: string, required: boolean, aliases: string[] = []): ImportColumn => ({ key, label, required, aliases })

export const IMPORT_COLUMNS: Record<ImportOperation, ImportColumn[]> = {
  ADD: [
    col('finishedSku', 'Finished Product SKU', true, ['finished sku', 'product sku', 'finished product']),
    col('componentSku', 'Component SKU', true, ['component']),
    col('quantity', 'Quantity', true, ['qty', 'quantity required']),
    col('unit', 'Unit', false, ['uom']),
    col('wastage', 'Wastage %', false, ['wastage', 'wastage percentage']),
    col('notes', 'Notes', false),
  ],
  EDIT: [
    col('finishedSku', 'Finished Product SKU', true, ['finished sku', 'product sku', 'finished product']),
    col('componentSku', 'Component SKU', true, ['component']),
    col('quantity', 'New Quantity', false, ['quantity', 'qty']),
    col('unit', 'Unit', false, ['uom']),
    col('wastage', 'New Wastage %', false, ['wastage %', 'wastage', 'wastage percentage']),
    col('notes', 'Notes', false),
  ],
  DELETE: [
    col('finishedSku', 'Finished Product SKU', true, ['finished sku', 'product sku', 'finished product']),
    col('componentSku', 'Component SKU', true, ['component']),
  ],
  REPLACE: [
    col('finishedSku', 'Finished Product SKU', true, ['finished sku', 'product sku', 'finished product']),
    col('componentSku', 'Old Component SKU', true, ['old component', 'component sku']),
    col('newComponentSku', 'New Component SKU', true, ['new component', 'replacement sku']),
    col('quantity', 'New Quantity', false, ['quantity', 'qty']),
    col('factor', 'Conversion Factor', false, ['factor']),
    col('wastage', 'Wastage %', false, ['wastage', 'new wastage %']),
  ],
}

export function importTemplate(op: ImportOperation): CellValue[][] {
  const head = IMPORT_COLUMNS[op].map((c) => c.label)
  const sample: Record<ImportOperation, CellValue[]> = {
    ADD: ['FG-001', 'PK-BOX-01', 1, 'PCS', 0, 'Outer carton'],
    EDIT: ['FG-001', 'RM-GLAZE-01', 1.25, '', 3, ''],
    DELETE: ['FG-001', 'PK-OLD-01'],
    REPLACE: ['FG-001', 'RM-GLAZE-01', 'RM-GLAZE-02', '', 1, ''],
  }
  return [head, sample[op]]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim()

/** Header row = first row with any text. Returns rows keyed by column, with spreadsheet row numbers. */
export function parseImportSheet(op: ImportOperation, sheet: string[][]): { rows: ImportRow[]; error: string | null } {
  const headerIndex = sheet.findIndex((r) => r.some((c) => (c ?? '').trim() !== ''))
  if (headerIndex < 0) return { rows: [], error: 'The sheet is empty.' }
  const header = sheet[headerIndex].map((h) => norm(h ?? ''))
  const columns = IMPORT_COLUMNS[op]
  const position = new Map<keyof ImportRowValues, number>()
  for (const c of columns) {
    const names = [norm(c.label), ...c.aliases.map(norm)]
    const i = header.findIndex((h) => names.includes(h))
    if (i >= 0) position.set(c.key, i)
  }
  const missing = columns.filter((c) => c.required && !position.has(c.key)).map((c) => c.label)
  if (missing.length) return { rows: [], error: `Missing column(s): ${missing.join(', ')}. Download the template for the expected headings.` }
  const rows: ImportRow[] = []
  for (let r = headerIndex + 1; r < sheet.length; r++) {
    const cells = sheet[r] ?? []
    if (!cells.some((c) => (c ?? '').trim() !== '')) continue
    const get = (k: keyof ImportRowValues) => (position.has(k) ? String(cells[position.get(k)!] ?? '').trim() : '')
    rows.push({
      rowNumber: r + 1, errors: [], finishedSku: get('finishedSku'), componentSku: get('componentSku'), newComponentSku: get('newComponentSku'),
      quantity: get('quantity'), factor: get('factor'), unit: get('unit').toUpperCase(), wastage: get('wastage').replace(/%$/, ''), notes: get('notes'),
    })
  }
  if (rows.length === 0) return { rows, error: 'No data rows below the headings.' }
  if (rows.length > 5000) return { rows: [], error: `At most 5000 rows per import (this file has ${rows.length}).` }
  return { rows, error: null }
}

const isNum = (s: string) => s !== '' && Number.isFinite(Number(s))
const decimals = (s: string) => (s.includes('.') ? s.split('.')[1].length : 0)

/** Checks that need no database: required values, numbers, ranges, repeated rows. */
export function validateImportRows(op: ImportOperation, rows: ImportRow[]): ImportRow[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const errors: string[] = []
    if (!row.finishedSku) errors.push('Finished Product SKU is missing.')
    if (!row.componentSku) errors.push(op === 'REPLACE' ? 'Old Component SKU is missing.' : 'Component SKU is missing.')
    if (op === 'REPLACE' && !row.newComponentSku) errors.push('New Component SKU is missing.')
    if (op === 'REPLACE' && row.newComponentSku && row.newComponentSku.toLowerCase() === row.componentSku.toLowerCase()) errors.push('Old and new component are the same.')
    if (op === 'ADD' && !row.quantity) errors.push('Quantity is missing.')
    if (row.quantity) {
      if (!isNum(row.quantity) || Number(row.quantity) <= 0) errors.push(`Quantity "${row.quantity}" must be a number greater than zero.`)
      else if (decimals(row.quantity) > 6) errors.push('Quantity has more than 6 decimals.')
    }
    if (row.factor && (!isNum(row.factor) || Number(row.factor) <= 0)) errors.push(`Conversion factor "${row.factor}" must be a number greater than zero.`)
    if (row.wastage && (!isNum(row.wastage) || Number(row.wastage) < 0 || Number(row.wastage) >= 100 || decimals(row.wastage) > 2)) {
      errors.push(`Wastage "${row.wastage}" must be between 0 and 99.99.`)
    }
    if (row.notes.length > 500) errors.push('Notes are limited to 500 characters.')
    if (op === 'EDIT' && !row.quantity && !row.wastage && !row.unit && !row.notes) errors.push('Nothing to change on this row.')
    const key = `${row.finishedSku.toLowerCase()}|${row.componentSku.toLowerCase()}`
    if (row.finishedSku && row.componentSku) {
      if (seen.has(key)) errors.push(`Same finished product and component as row ${seen.get(key)}.`)
      else seen.set(key, row.rowNumber)
    }
    return { ...row, errors }
  })
}

/** Checks against the Product Master (SKUs, current BOM, active, unit) and fills ids. */
export function applyResolvedSkus(op: ImportOperation, rows: ImportRow[], resolved: ResolvedSku[]): ImportRow[] {
  const bySku = new Map(resolved.map((r) => [r.sku_key, r]))
  const find = (sku: string) => bySku.get(sku.trim().toLowerCase())
  return rows.map((row) => {
    const errors = [...row.errors]
    const fg = row.finishedSku ? find(row.finishedSku) : undefined
    const comp = row.componentSku ? find(row.componentSku) : undefined
    const repl = row.newComponentSku ? find(row.newComponentSku) : undefined
    if (row.finishedSku && !fg) errors.push(`Finished product ${row.finishedSku} is not in the Product Master.`)
    else if (fg && !fg.current_bom_id) errors.push(`${fg.sku} has no approved BOM.`)
    if (row.componentSku && !comp) errors.push(`Component ${row.componentSku} is not in the Product Master.`)
    if (row.newComponentSku && !repl) errors.push(`Component ${row.newComponentSku} is not in the Product Master.`)
    const added = op === 'ADD' ? comp : op === 'REPLACE' ? repl : undefined
    if (added && added.status !== 'ACTIVE') errors.push(`${added.sku} is ${added.status.toLowerCase()} and cannot be used.`)
    const unitOf = op === 'REPLACE' ? repl : comp
    if (row.unit && unitOf && row.unit !== unitOf.base_unit) {
      errors.push(`Unit ${row.unit} differs from the inventory unit of ${unitOf.sku} (${unitOf.base_unit}); no unit conversion is configured.`)
    }
    return { ...row, errors, finishedProductId: fg?.product_id, componentId: comp?.product_id, newComponentId: repl?.product_id }
  })
}

export function importSkus(rows: ImportRow[]): string[] {
  return [...new Set(rows.flatMap((r) => [r.finishedSku, r.componentSku, r.newComponentSku]).filter(Boolean))]
}

export function linesFromImport(op: ImportOperation, rows: ImportRow[]): { lines: BatchLineInput[]; rowNumbers: number[] } {
  const valid = rows.filter((r) => r.errors.length === 0 && r.finishedProductId && r.componentId && (op !== 'REPLACE' || r.newComponentId))
  return {
    lines: valid.map((r) => ({
      finished_product_id: r.finishedProductId, component_product_id: r.componentId!, new_component_product_id: op === 'REPLACE' ? r.newComponentId : undefined,
      quantity: r.quantity || null, factor: r.factor || null, unit: r.unit || null, wastage_percentage: r.wastage || null,
      ...(r.notes ? { notes: r.notes } : {}),
    })),
    rowNumbers: valid.map((r) => r.rowNumber),
  }
}

// ---------------------------------------------------------------------------
// Export rows
// ---------------------------------------------------------------------------
export function whereUsedExportRows(rows: WhereUsedRow[], fmtDate: (iso: string) => string): CellValue[][] {
  return [
    ['Finished Product SKU', 'Finished Product', 'BOM Number', 'Revision', 'Status', 'Current Revision', 'Effective From', 'Effective To',
      'Component SKU', 'Component', 'Quantity', 'UOM', 'Inventory Unit', 'Wastage %', 'Output Quantity', 'Quantity per Unit', 'Notes'],
    ...rows.map((r) => [r.sku, r.product_name, r.bom_code, r.version, LIFECYCLE_LABELS[r.lifecycle] ?? r.lifecycle, r.is_current ? 'Yes' : 'No',
      fmtDate(r.effective_from), r.effective_to ? fmtDate(r.effective_to) : '', r.component_sku, r.component_name, Number(r.quantity), r.unit,
      r.inventory_unit, Number(r.wastage_percentage), Number(r.output_quantity), Number(r.quantity_per_unit), r.notes ?? '']),
  ]
}

export function batchExportSheets(d: BatchDetail): { name: string; rows: CellValue[][] }[] {
  const b = d.batch
  const lines: CellValue[][] = [
    ['Line', 'Action', 'Finished Product SKU', 'Finished Product', 'BOM Number', 'From Revision', 'New Revision', 'Component SKU', 'Component',
      'New Component SKU', 'New Component', 'Old Quantity', 'Old UOM', 'New Quantity', 'New UOM', 'Old Wastage %', 'New Wastage %', 'Errors', 'Warnings'],
    ...d.lines.map((l) => [l.line_no, OPERATION_LABELS[l.action], l.finished_sku ?? '', l.finished_name ?? '', l.bom_code ?? '', l.source_version ?? '',
      l.result_version ?? '', l.component_sku ?? '', l.component_name ?? '', l.new_component_sku ?? '', l.new_component_name ?? '',
      l.old_quantity === null ? '' : Number(l.old_quantity), l.old_unit ?? '', l.new_quantity === null ? '' : Number(l.new_quantity), l.new_unit ?? '',
      l.old_wastage === null ? '' : Number(l.old_wastage), l.new_wastage === null ? '' : Number(l.new_wastage),
      l.validation_errors.join(' | '), l.warnings.join(' | ')]),
  ]
  const head: CellValue[][] = [
    ['Batch', b.batch_number], ['Operation', OPERATION_LABELS[b.operation]], ['Status', BATCH_STATUS_LABELS[b.status]], ['Reason', b.reason],
    ['Effective from', b.effective_from], ['BOMs', b.summary.boms ?? 0], ['Lines', b.summary.lines ?? 0], ['Lines with errors', b.summary.lines_with_errors ?? 0],
  ]
  const sheets = [{ name: 'Summary', rows: head }, { name: 'Changes', rows: lines }]
  if (d.impact?.production_orders?.length) {
    sheets.push({ name: 'Production orders', rows: [
      ['Order', 'Status', 'Product SKU', 'BOM', 'Revision', 'Planned Quantity', 'Unit', 'Planned Start', 'Effect'],
      ...d.impact.production_orders.map((o) => [o.production_order_number, o.status, o.sku, o.bom_code, o.bom_version, Number(o.planned_quantity), o.unit, o.planned_start_date, o.effect]),
    ] })
  }
  if (d.impact?.components.length) {
    sheets.push({ name: 'Inventory impact', rows: [
      ['Component SKU', 'Component', 'Unit', 'Role', 'Current BOMs', 'Current BOMs after', 'On hand', 'Available', 'Open PO quantity', 'Consumed (90 days)', 'Open order requirement'],
      ...d.impact.components.map((c) => [c.sku, c.product_name, c.unit, c.roles, c.current_boms, c.current_boms_after, c.on_hand ?? '', c.available ?? '',
        c.open_po_quantity ?? '', c.consumed_90_days ?? '', c.open_order_requirement ?? '']),
    ] })
  }
  return sheets
}

export function revisionExportRows(rows: RevisionRow[], fmt: (iso: string) => string): CellValue[][] {
  return [
    ['Finished Product SKU', 'Finished Product', 'BOM Number', 'Revision', 'Status', 'Effective From', 'Effective To', 'Approved', 'Approved By',
      'Created By', 'Reason', 'Bulk Change Batch'],
    ...rows.map((r) => [r.sku, r.product_name, r.bom_code, r.version, LIFECYCLE_LABELS[r.lifecycle] ?? r.lifecycle, r.effective_from, r.effective_to ?? '',
      r.approved_at ? fmt(r.approved_at) : '', r.approved_by_name ?? '', r.created_by_name ?? '', r.change_reason ?? '', r.batch_number ?? '']),
  ]
}

/** Components that would be left with stock or open purchase orders and no current BOM. */
export function unusedAfterChange(d: BatchDetail): string[] {
  return (d.impact?.components ?? [])
    .filter((c) => c.roles.includes('REMOVED') && c.current_boms_after === 0 && ((c.available ?? 0) > 0 || (c.open_po_quantity ?? 0) > 0))
    .map((c) => `${c.sku}: ${c.available !== null ? `${trimNum(Number(c.available))} ${c.unit} available` : 'stock not visible'}${c.open_po_quantity ? `, ${trimNum(Number(c.open_po_quantity))} ${c.unit} on open purchase orders` : ''} — no current BOM will use it.`)
}
