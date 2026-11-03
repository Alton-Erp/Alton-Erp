// Supplier purchase order import from Excel / CSV: template, parsing, grouping
// and the first (browser) validation pass. The server validates everything
// again (public.purchase_order_import_preview / purchase_order_import) and
// creates DRAFT orders only through purchase_order_save().
//
// GROUPING RULE: rows with the same "PO Reference" (case-insensitive) form ONE
// purchase order. Every row of a reference must have the same order details
// (supplier code, PO date, expected delivery date, warehouse, delivery
// instructions, remarks) or leave them blank. A conflict is an error, never a
// silent merge. The same reference cannot be imported twice for a supplier.

import { parseSheetDate } from '../inventory/inventory-model.ts'
import { STANDARD_GST_RATES } from '../products/product-model.ts'

export const PO_IMPORT_MAX_FILE_MB = 5
export const PO_IMPORT_MAX_ROWS = 1000
export const PO_IMPORT_MAX_ORDERS = 100
export const PO_IMPORT_MAX_LINES_PER_ORDER = 200
export const PO_IMPORT_FILE_TYPES = ['.xlsx', '.csv']

export const PO_IMPORT_COLUMNS = [
  { key: 'reference', label: 'PO Reference', required: true, help: 'Groups rows into one purchase order. Use the same reference on every row of an order (e.g. PO-APR-01).' },
  { key: 'supplier_code', label: 'Supplier Code', required: true, help: 'Code of an existing, active supplier. Suppliers are never created by an import.' },
  { key: 'supplier_name', label: 'Supplier Name', required: false, help: 'Optional cross-check (a different name is a warning; the supplier is matched by code).' },
  { key: 'supplier_gstin', label: 'Supplier GSTIN', required: false, help: 'Optional cross-check: must match the GSTIN on the supplier record.' },
  { key: 'supplier_state', label: 'Supplier State', required: false, help: 'Optional cross-check (name or 2-digit GST code). GST is decided from the GSTIN on record.' },
  { key: 'po_date', label: 'PO Date', required: false, help: 'YYYY-MM-DD or DD-MM-YYYY. Blank = today. Cannot be in the future.' },
  { key: 'expected_delivery_date', label: 'Expected Delivery Date', required: false, help: 'YYYY-MM-DD or DD-MM-YYYY; not before the PO date.' },
  { key: 'sku', label: 'Product Code / SKU', required: true, help: 'SKU of an active product in the Product Master. Products are never created by an import.' },
  { key: 'product_name', label: 'Product Name', required: false, help: 'Optional cross-check (a different name is a warning).' },
  { key: 'description', label: 'Description', required: false, help: 'Line description. Blank = product name.' },
  { key: 'quantity', label: 'Quantity', required: true, help: 'Greater than zero, up to 3 decimals.' },
  { key: 'unit', label: 'Unit of Measurement', required: false, help: 'Optional; must be the product\'s unit (e.g. PCS, KG).' },
  { key: 'unit_price', label: 'Unit Price', required: true, help: 'Price per unit excluding GST, zero or more, up to 4 decimals.' },
  { key: 'discount_percent', label: 'Discount Percentage', required: false, help: '0–100, up to 2 decimals.' },
  { key: 'gst_rate', label: 'GST Rate', required: false, help: `One of ${STANDARD_GST_RATES.join(', ')}. Blank = the product's rate. CGST/SGST or IGST is decided by the ERP.` },
  { key: 'warehouse', label: 'Warehouse', required: true, help: 'Code of an active delivery warehouse.' },
  { key: 'delivery_instructions', label: 'Delivery Instructions', required: false, help: 'Order level: same on every row of the order (or blank).' },
  { key: 'remarks', label: 'Remarks', required: false, help: 'Order level internal notes: same on every row of the order (or blank).' },
] as const

export type PoImportField = (typeof PO_IMPORT_COLUMNS)[number]['key']
type HeaderField = 'supplier_code' | 'supplier_name' | 'supplier_gstin' | 'supplier_state' | 'po_date' | 'expected_delivery_date' | 'warehouse' | 'delivery_instructions' | 'remarks'
const HEADER_FIELDS: HeaderField[] = ['supplier_code', 'supplier_name', 'supplier_gstin', 'supplier_state', 'po_date', 'expected_delivery_date', 'warehouse', 'delivery_instructions', 'remarks']
/** Order details that must not conflict between rows of one reference. */
const CONSISTENT_FIELDS: HeaderField[] = ['supplier_code', 'po_date', 'expected_delivery_date', 'warehouse', 'delivery_instructions', 'remarks']

export type PoImportRow = { row_number: number } & Record<PoImportField, string>

export interface PoImportGroup {
  reference: string
  header: Record<HeaderField, string>
  rows: PoImportRow[]
}

export interface RowError {
  row: number | null
  reference: string | null
  message: string
}

export interface ParsedPoImport {
  /** Problems with the whole file (missing columns, too many rows…). Nothing can be imported. */
  fileErrors: string[]
  groups: PoImportGroup[]
  /** Row-level problems found in the browser; their orders are not sent. */
  rowErrors: RowError[]
  dataRows: number
  blankRows: number
}

/** Template sheets: the import sheet (headers only) and an instructions sheet. */
export function templateSheets(): { name: string; rows: (string | number | null)[][] }[] {
  return [
    { name: 'Purchase Orders', rows: [PO_IMPORT_COLUMNS.map((c) => c.label)] },
    {
      name: 'Instructions',
      rows: [
        ['Column', 'Required', 'How to fill it'],
        ...PO_IMPORT_COLUMNS.map((c) => [c.label, c.required ? 'Yes' : 'No', c.help]),
        [],
        ['Rules'],
        ['One row per product line. Rows with the same PO Reference become ONE draft purchase order; different references are never merged.'],
        ['Order details (supplier, dates, warehouse, delivery instructions, remarks) must be identical on every row of a reference, or left blank after the first row.'],
        ['Totals and GST (CGST + SGST or IGST) are calculated by the ERP from its own records; do not add total columns.'],
        [`Limits: ${PO_IMPORT_MAX_ROWS} rows, ${PO_IMPORT_MAX_ORDERS} orders, ${PO_IMPORT_MAX_LINES_PER_ORDER} lines per order, ${PO_IMPORT_MAX_FILE_MB} MB.`],
        ['Formulas are not evaluated and cells starting with =, + or @ are rejected. Enter plain values.'],
        ['Imported orders are drafts: review each one and submit it for approval in the ERP.'],
        [],
        ['Example (do not paste into the import sheet unless the codes exist in your ERP)'],
        PO_IMPORT_COLUMNS.map((c) => c.label),
        ['PO-APR-01', 'SUP-000001', 'Shree Clay Works Pvt Ltd', '27AAPFU0939F1ZV', 'Maharashtra', '2026-10-28', '2026-11-05', 'WB-101', 'Wash basin', '', 10, 'PCS', 950, 5, 18, 'MAIN', 'Deliver to gate 2', 'Rush order'],
        ['PO-APR-01', 'SUP-000001', '', '', '', '', '', 'CLAY-01', 'Ball clay', '', 250, 'KG', 12.5, '', 5, '', '', ''],
      ],
    },
  ]
}

const normaliseHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const HEADER_ALIASES: Record<string, PoImportField> = Object.fromEntries([
  ...PO_IMPORT_COLUMNS.map((c) => [normaliseHeader(c.label), c.key]),
  ['po ref', 'reference'], ['reference', 'reference'], ['po reference no', 'reference'],
  ['sku', 'sku'], ['product code', 'sku'], ['uom', 'unit'], ['unit', 'unit'], ['gst', 'gst_rate'], ['gst rate %', 'gst_rate'],
  ['discount', 'discount_percent'], ['discount %', 'discount_percent'], ['warehouse code', 'warehouse'],
].map(([k, v]) => [normaliseHeader(k), v as PoImportField]))

/** A text cell that a spreadsheet program could execute as a formula. */
export function isUnsafeCell(value: string): boolean {
  return /^[=+@\t\r]/.test(value) || /^-[^\d.]/.test(value)
}

const QTY_RE = /^\d+(\.\d{1,3})?$/
const PRICE_RE = /^\d+(\.\d{1,4})?$/
const PCT_RE = /^\d+(\.\d{1,2})?$/
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,49}$/
const clean = (s: string) => s.replace(/,/g, '').replace(/%$/, '').trim()

/**
 * Parses sheet rows (index 0 = spreadsheet row 1, header on row 1) into
 * orders. Pure: used by the page and the unit tests. `today` is YYYY-MM-DD.
 */
export function parsePoImport(sheet: string[][], today: string): ParsedPoImport {
  const out: ParsedPoImport = { fileErrors: [], groups: [], rowErrors: [], dataRows: 0, blankRows: 0 }
  const headerRow = sheet[0] ?? []
  const col = new Map<PoImportField, number>()
  headerRow.forEach((h, i) => {
    const key = HEADER_ALIASES[normaliseHeader(h)]
    if (key && !col.has(key)) col.set(key, i)
  })
  const missing = PO_IMPORT_COLUMNS.filter((c) => c.required && !col.has(c.key)).map((c) => c.label)
  if (sheet.length === 0 || headerRow.every((h) => !h.trim())) {
    out.fileErrors.push('The first sheet is empty. Use the downloaded template: column headings in row 1, one product line per row below.')
    return out
  }
  if (missing.length) {
    out.fileErrors.push(`Row 1 must contain the template column headings. Missing: ${missing.join(', ')}.`)
    return out
  }

  const rows: PoImportRow[] = []
  for (let i = 1; i < sheet.length; i++) {
    const cells = sheet[i] ?? []
    if (cells.every((c) => !String(c ?? '').trim())) { out.blankRows++; continue }
    const row = { row_number: i + 1 } as PoImportRow
    for (const c of PO_IMPORT_COLUMNS) row[c.key] = String(cells[col.get(c.key) ?? -1] ?? '').trim()
    rows.push(row)
  }
  out.dataRows = rows.length
  // Trailing blank rows are not worth reporting as "skipped".
  if (rows.length === 0) {
    out.fileErrors.push('The file has no product rows below the headings.')
    return out
  }
  if (rows.length > PO_IMPORT_MAX_ROWS) {
    out.fileErrors.push(`The file has ${rows.length} rows; at most ${PO_IMPORT_MAX_ROWS} can be imported at once. Split the file.`)
    return out
  }

  const err = (row: PoImportRow, message: string) => out.rowErrors.push({ row: row.row_number, reference: row.reference || null, message })
  const byRef = new Map<string, PoImportRow[]>()
  for (const r of rows) {
    const unsafe = PO_IMPORT_COLUMNS.filter((c) => isUnsafeCell(r[c.key])).map((c) => c.label)
    if (unsafe.length) err(r, `${unsafe.join(', ')}: cells must not start with =, +, - or @ (formulas are not allowed). Enter plain values.`)
    if (!r.reference) { err(r, 'PO Reference is required: it groups rows into one purchase order.'); continue }
    if (!REF_RE.test(r.reference)) err(r, 'PO Reference must be 1–50 letters, digits, spaces or . _ / -.')
    if (!r.supplier_code) err(r, 'Supplier Code is required.')
    if (!r.sku) err(r, 'Product Code / SKU is required.')
    if (!r.warehouse) err(r, 'Warehouse is required (warehouse code).')
    const qty = clean(r.quantity)
    if (!qty) err(r, 'Quantity is required.')
    else if (!QTY_RE.test(qty) || Number(qty) <= 0) err(r, `Quantity "${r.quantity}" must be a number greater than zero with at most 3 decimals.`)
    else r.quantity = qty
    const price = clean(r.unit_price)
    if (!price) err(r, 'Unit Price is required.')
    else if (!PRICE_RE.test(price)) err(r, `Unit Price "${r.unit_price}" must be zero or more with at most 4 decimals (no negative prices).`)
    else r.unit_price = price
    if (r.discount_percent) {
      const d = clean(r.discount_percent)
      if (!PCT_RE.test(d) || Number(d) > 100) err(r, `Discount Percentage "${r.discount_percent}" must be between 0 and 100.`)
      else r.discount_percent = d
    }
    if (r.gst_rate) {
      const g = clean(r.gst_rate)
      if (!/^\d+(\.\d+)?$/.test(g) || !STANDARD_GST_RATES.includes(Number(g))) err(r, `GST Rate "${r.gst_rate}" is not supported. Use one of ${STANDARD_GST_RATES.join(', ')}.`)
      else r.gst_rate = String(Number(g))
    }
    if (r.unit) r.unit = r.unit.toUpperCase()
    for (const f of ['po_date', 'expected_delivery_date'] as const) {
      if (!r[f]) continue
      const d = parseSheetDate(r[f])
      if (!d) err(r, `${f === 'po_date' ? 'PO Date' : 'Expected Delivery Date'} "${r[f]}" is not a valid date. Use YYYY-MM-DD or DD-MM-YYYY.`)
      else r[f] = d
    }
    if (r.po_date && /^\d{4}-\d{2}-\d{2}$/.test(r.po_date) && r.po_date > today) err(r, 'PO Date cannot be in the future.')
    if (r.supplier_gstin) r.supplier_gstin = r.supplier_gstin.toUpperCase()
    const key = r.reference.toLowerCase()
    byRef.set(key, [...(byRef.get(key) ?? []), r])
  }

  for (const [, group] of byRef) {
    const header = Object.fromEntries(HEADER_FIELDS.map((f) => [f, group.find((r) => r[f])?.[f] ?? ''])) as Record<HeaderField, string>
    for (const r of group) {
      for (const f of CONSISTENT_FIELDS) {
        if (r[f] && header[f] && r[f].toUpperCase() !== header[f].toUpperCase()) {
          const label = PO_IMPORT_COLUMNS.find((c) => c.key === f)!.label
          err(r, `${label} "${r[f]}" differs from "${header[f]}" on another row of PO Reference ${group[0].reference}. All rows of one order must have the same order details (use a different reference for a different order).`)
        }
      }
    }
    if (header.po_date && header.expected_delivery_date && /^\d{4}/.test(header.po_date) && /^\d{4}/.test(header.expected_delivery_date) && header.expected_delivery_date < header.po_date) {
      err(group[0], 'Expected Delivery Date cannot be before the PO Date.')
    }
    if (group.length > PO_IMPORT_MAX_LINES_PER_ORDER) err(group[0], `PO Reference ${group[0].reference} has ${group.length} lines; at most ${PO_IMPORT_MAX_LINES_PER_ORDER} per order.`)
    out.groups.push({ reference: group[0].reference, header, rows: group })
  }
  if (out.groups.length > PO_IMPORT_MAX_ORDERS) out.fileErrors.push(`The file has ${out.groups.length} purchase orders; at most ${PO_IMPORT_MAX_ORDERS} can be imported at once. Split the file.`)
  out.rowErrors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0))
  return out
}

/** References with a browser-side error (their orders are not sent to the server). */
export function invalidReferences(parsed: ParsedPoImport): Set<string> {
  return new Set(parsed.rowErrors.map((e) => (e.reference ?? '').toLowerCase()).filter(Boolean))
}

/** Payload for the server: only the order details and line values (never ids, company, status or totals). */
export function groupPayload(g: PoImportGroup) {
  return {
    reference: g.reference,
    header: g.header,
    rows: g.rows.map((r) => ({
      row_number: r.row_number, sku: r.sku, product_name: r.product_name, description: r.description, quantity: r.quantity, unit: r.unit,
      unit_price: r.unit_price, discount_percent: r.discount_percent || null, gst_rate: r.gst_rate || null,
      supplier_code: r.supplier_code, po_date: r.po_date, expected_delivery_date: r.expected_delivery_date, warehouse: r.warehouse,
      delivery_instructions: r.delivery_instructions, remarks: r.remarks,
    })),
  }
}

/** Rows the browser rejected, for the import history (Bulk Operations). */
export function rejectedRowsPayload(parsed: ParsedPoImport, skippedRefs: Set<string>) {
  const out: { row_number: number; reference: string | null; messages: string[] }[] = []
  const byRow = new Map<number, string[]>()
  for (const e of parsed.rowErrors) if (e.row !== null) byRow.set(e.row, [...(byRow.get(e.row) ?? []), e.message])
  for (const g of parsed.groups) {
    if (!skippedRefs.has(g.reference.toLowerCase())) continue
    for (const r of g.rows) out.push({ row_number: r.row_number, reference: g.reference, messages: byRow.get(r.row_number) ?? [`Not imported: another row of PO Reference ${g.reference} has errors.`] })
  }
  // Rows without a reference never formed an order.
  for (const e of parsed.rowErrors) if (!e.reference && e.row !== null) out.push({ row_number: e.row, reference: null, messages: [e.message] })
  return out
}
