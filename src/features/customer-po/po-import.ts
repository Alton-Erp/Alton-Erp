// Customer PO spreadsheet import: column mapping and row validation.
// Pure TypeScript (unit-tested). Nothing here writes to the database; the
// server re-validates and matches products when the import is confirmed.

import { parseSheetDate } from '../inventory/inventory-model.ts'

export const PO_FIELDS = [
  { key: 'customer_name', label: 'Customer Name', synonyms: ['customer', 'customer name', 'buyer', 'party', 'party name', 'client', 'bill to'] },
  { key: 'po_number', label: 'Customer PO Number', synonyms: ['po number', 'po no', 'po', 'purchase order', 'purchase order number', 'order number', 'order no', 'po #'] },
  { key: 'po_date', label: 'PO Date', synonyms: ['po date', 'order date', 'date'] },
  { key: 'delivery_date', label: 'Required Delivery Date', synonyms: ['delivery date', 'required delivery date', 'required by', 'due date', 'need by', 'expected delivery'] },
  { key: 'customer_sku', label: 'Customer SKU', synonyms: ['customer sku', 'customer code', 'customer item code', 'buyer sku', 'article', 'article code', 'customer part no'] },
  { key: 'sku', label: 'Our Product SKU', synonyms: ['sku', 'our sku', 'item code', 'product code', 'material code', 'code', 'model', 'model no'] },
  { key: 'barcode', label: 'Barcode', synonyms: ['barcode', 'ean', 'gtin', 'upc', 'ean code'] },
  { key: 'description', label: 'Product Name / Description', synonyms: ['description', 'product', 'product name', 'item', 'item name', 'item description', 'particulars'] },
  { key: 'quantity', label: 'Quantity Ordered', synonyms: ['quantity', 'qty', 'order qty', 'ordered qty', 'quantity ordered', 'po qty', 'units'] },
  { key: 'unit', label: 'Unit of Measure', synonyms: ['unit', 'uom', 'unit of measure', 'units of measure'] },
  { key: 'unit_price', label: 'Unit Price', synonyms: ['unit price', 'price', 'rate', 'unit rate', 'basic rate'] },
  { key: 'currency', label: 'Currency', synonyms: ['currency', 'curr', 'currency code'] },
  { key: 'hsn', label: 'HSN', synonyms: ['hsn', 'hsn code', 'hsn sac', 'hsn/sac'] },
  { key: 'tax_rate', label: 'Tax Rate', synonyms: ['tax rate', 'gst', 'gst rate', 'gst %', 'tax', 'tax %'] },
  { key: 'remarks', label: 'Line Remarks', synonyms: ['remarks', 'remark', 'notes', 'note', 'comment', 'comments'] },
] as const

export type PoFieldKey = (typeof PO_FIELDS)[number]['key']
export type PoMapping = Record<PoFieldKey, number | null>

export interface PoLinePayload {
  source_row_number: number
  sku: string | null
  customer_sku: string | null
  barcode: string | null
  description: string | null
  quantity: number
  unit: string | null
  unit_price: number | null
  currency: string | null
  tax_rate: number | null
  hsn_code: string | null
  remarks: string | null
}

export interface PoRowResult {
  rowNumber: number
  code: string
  status: 'valid' | 'error'
  errors: string[]
  warnings: string[]
  payload: PoLinePayload | null
}

export interface PoHeaderFromFile {
  customerNames: string[]
  poNumbers: string[]
  poDates: string[]
  deliveryDates: string[]
  currencies: string[]
  /** File-level problems (e.g. several PO numbers in one file). */
  issues: string[]
}

export const MAX_PO_FILE_MB = 5
export const MAX_PO_ROWS = 5000
export const PO_FILE_TYPES = ['.xlsx', '.xls', '.csv']

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim()

export function autoMapPo(headers: string[]): PoMapping {
  const normalized = headers.map(norm)
  const used = new Set<number>()
  const mapping = {} as PoMapping
  for (const f of PO_FIELDS) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h !== '' && f.synonyms.map(norm).includes(h))
    mapping[f.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  return mapping
}

/** Columns that must be mapped (customer and PO number may instead be typed in the header form). */
export function missingPoFields(mapping: PoMapping): string[] {
  const missing: string[] = []
  if (mapping.quantity === null) missing.push('Quantity Ordered')
  if (mapping.sku === null && mapping.customer_sku === null && mapping.barcode === null && mapping.description === null) {
    missing.push('a product identifier (Our SKU, Customer SKU, Barcode or Description)')
  }
  return missing
}

/** Row with the most recognised headers among the first 25 (skips letterhead rows). */
export function detectPoHeader(rows: string[][]): number {
  let best = -1
  let bestScore = 1
  rows.slice(0, 25).forEach((row, i) => {
    const score = Object.values(autoMapPo(row)).filter((v) => v !== null).length
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  return best >= 0 ? best : rows.findIndex((r) => r.some((c) => c !== ''))
}

/** Number with optional thousands separators / currency symbol; null when invalid, undefined when blank. */
export function parseDecimal(value: string, maxDecimals: number): number | null | undefined {
  const v = value.trim().replace(/^(₹|rs\.?|inr)\s*/i, '').replace(/,/g, '').trim()
  if (v === '') return undefined
  if (!/^-?\d+(\.\d+)?$/.test(v) || (v.split('.')[1]?.length ?? 0) > maxDecimals) return null
  return Number(v)
}

export function validatePoRows(rows: string[][], mapping: PoMapping, firstDataRowNumber = 2): { rows: PoRowResult[]; header: PoHeaderFromFile } {
  const cell = (row: string[], key: PoFieldKey) => (mapping[key] === null ? '' : String(row[mapping[key]!] ?? '').trim())
  const mapped = Object.values(mapping).filter((i): i is number => i !== null)
  const seenCode = new Map<string, number>()
  const seenRow = new Map<string, number>()
  const header = { customerNames: new Set<string>(), poNumbers: new Set<string>(), poDates: new Set<string>(), deliveryDates: new Set<string>(), currencies: new Set<string>() }
  const issues: string[] = []
  const out: PoRowResult[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + firstDataRowNumber
    if (mapped.every((i) => String(row[i] ?? '').trim() === '')) return
    const errors: string[] = []
    const warnings: string[] = []

    const sku = cell(row, 'sku')
    const customerSku = cell(row, 'customer_sku')
    const barcode = cell(row, 'barcode')
    const description = cell(row, 'description')
    if (!sku && !customerSku && !barcode && !description) errors.push('No product identification (SKU, customer SKU, barcode or description).')
    else if (!sku && !customerSku && !barcode) warnings.push('Only a description: the product must be selected manually (no automatic description matching).')
    if (barcode && !/^[A-Za-z0-9-]{4,64}$/.test(barcode)) errors.push('Barcode may contain 4–64 letters, digits or hyphens.')
    if (sku.length > 100 || customerSku.length > 100) errors.push('Product codes are limited to 100 characters.')
    if (description.length > 500) errors.push('Description is limited to 500 characters.')

    const qty = parseDecimal(cell(row, 'quantity'), 3)
    if (qty === undefined) errors.push('Quantity is required.')
    else if (qty === null) errors.push('Quantity must be a number (up to 3 decimals).')
    else if (qty <= 0) errors.push('Quantity must be greater than zero.')

    const unitRaw = cell(row, 'unit').toUpperCase().replace(/[^A-Z]/g, '')
    if (cell(row, 'unit') && !/^[A-Z]{1,10}$/.test(unitRaw)) errors.push(`Unit "${cell(row, 'unit')}" is not valid (1–10 letters).`)

    const price = parseDecimal(cell(row, 'unit_price'), 4)
    if (price === null || (price !== undefined && price < 0)) errors.push('Unit price must be zero or more (up to 4 decimals).')
    const tax = parseDecimal(cell(row, 'tax_rate').replace(/%$/, ''), 2)
    if (tax === null || (tax !== undefined && (tax < 0 || tax > 100))) errors.push('Tax rate must be between 0 and 100.')
    const currency = cell(row, 'currency').toUpperCase()
    if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push(`Currency "${cell(row, 'currency')}" must be a 3-letter code (e.g. INR).`)
    const hsn = cell(row, 'hsn').replace(/\s/g, '')
    if (hsn && !/^([0-9]{4}|[0-9]{6}|[0-9]{8})$/.test(hsn)) errors.push('HSN must have 4, 6 or 8 digits.')

    const customerName = cell(row, 'customer_name')
    const poNumber = cell(row, 'po_number')
    const poDateRaw = cell(row, 'po_date')
    const dueRaw = cell(row, 'delivery_date')
    if (customerName) header.customerNames.add(customerName.replace(/\s+/g, ' '))
    if (poNumber) header.poNumbers.add(poNumber)
    if (poDateRaw) {
      const d = parseSheetDate(poDateRaw)
      if (d === null) errors.push(`PO date "${poDateRaw}" is not a valid date (use YYYY-MM-DD or DD-MM-YYYY).`)
      else if (d) header.poDates.add(d)
    }
    if (dueRaw) {
      const d = parseSheetDate(dueRaw)
      if (d === null) errors.push(`Delivery date "${dueRaw}" is not a valid date (use YYYY-MM-DD or DD-MM-YYYY).`)
      else if (d) header.deliveryDates.add(d)
    }
    if (currency && /^[A-Z]{3}$/.test(currency)) header.currencies.add(currency)

    const code = (sku || customerSku || barcode).toUpperCase()
    if (code) {
      const first = seenCode.get(code)
      if (first !== undefined) warnings.push(`Same product code as row ${first}: review whether it is a separate demand.`)
      else seenCode.set(code, rowNumber)
    }
    const signature = mapped.map((i) => String(row[i] ?? '').trim().toLowerCase()).join('|')
    const identical = seenRow.get(signature)
    if (identical !== undefined) warnings.push(`Identical to row ${identical} (possible accidental repeat).`)
    else seenRow.set(signature, rowNumber)

    out.push({
      rowNumber,
      code: sku || customerSku || barcode || description,
      status: errors.length ? 'error' : 'valid',
      errors,
      warnings,
      payload: errors.length
        ? null
        : {
            source_row_number: rowNumber,
            sku: sku || null,
            customer_sku: customerSku || null,
            barcode: barcode || null,
            description: description || null,
            quantity: qty as number,
            unit: unitRaw || null,
            unit_price: price ?? null,
            currency: currency || null,
            tax_rate: tax ?? null,
            hsn_code: hsn || null,
            remarks: cell(row, 'remarks').slice(0, 500) || null,
          },
    })
  })

  if (header.customerNames.size > 1) issues.push(`The file names ${header.customerNames.size} different customers (${[...header.customerNames].slice(0, 3).join(', ')}). Import one customer's PO at a time.`)
  if (header.poNumbers.size > 1) issues.push(`The file contains ${header.poNumbers.size} PO numbers (${[...header.poNumbers].slice(0, 3).join(', ')}). Import one PO at a time.`)
  if (header.poDates.size > 1) issues.push('Rows have different PO dates.')
  if (header.currencies.size > 1) issues.push('Rows use different currencies.')

  return {
    rows: out,
    header: {
      customerNames: [...header.customerNames],
      poNumbers: [...header.poNumbers],
      poDates: [...header.poDates],
      deliveryDates: [...header.deliveryDates].sort(),
      currencies: [...header.currencies],
      issues,
    },
  }
}

/** File-type and size check (no macros or scripts are ever executed; formulas are not evaluated). */
export function checkPoFile(name: string, size: number): string | null {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
  if (!PO_FILE_TYPES.includes(ext)) return `"${name}" is not a supported file. Use ${PO_FILE_TYPES.join(', ')}.`
  if (size === 0) return 'The file is empty.'
  if (size > MAX_PO_FILE_MB * 1024 * 1024) return `Files must be ${MAX_PO_FILE_MB} MB or smaller.`
  return null
}

/** SHA-256 fingerprint (hex) used to detect re-uploads of the same file. */
export async function fileFingerprint(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export const PO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  UPLOADED: 'Uploaded',
  VALIDATION_REQUIRED: 'Validation required',
  PRODUCT_MATCHING_REQUIRED: 'Product matching required',
  READY_FOR_ALLOCATION: 'Ready for allocation',
  PARTIALLY_ALLOCATED: 'Partially allocated',
  FULLY_ALLOCATED: 'Fully allocated',
  PARTIALLY_FULFILLED: 'Partially fulfilled',
  FULFILLED: 'Fulfilled',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
}

export const LINE_STATUS_LABELS: Record<string, string> = {
  MATCHED: 'Matched',
  UNMATCHED: 'Unmatched',
  AMBIGUOUS: 'Ambiguous',
  INVALID: 'Invalid',
  DUPLICATE_REVIEW: 'Duplicate review',
  EXCLUDED: 'Excluded',
}

export const AVAILABILITY_LABELS: Record<string, string> = {
  FULLY_AVAILABLE: 'Fully available',
  PARTIALLY_AVAILABLE: 'Partially available',
  OUT_OF_STOCK: 'Out of stock',
  PRODUCT_UNMATCHED: 'Product unmatched',
  UNIT_MISMATCH: 'Unit mismatch',
  REVIEW_REQUIRED: 'Review required',
  EXCLUDED: 'Excluded',
}

export const MATCH_METHOD_LABELS: Record<string, string> = {
  SKU: 'Exact internal SKU',
  CUSTOMER_SKU: 'Verified customer code',
  BARCODE: 'Exact barcode',
  NORMALIZED_CODE: 'Code ignoring spaces / punctuation',
  MANUAL: 'Selected manually',
}

export const STATUS_REASON_LABELS: Record<string, string> = {
  UNIT_MISMATCH: 'Unit differs from the product unit (no conversion)',
  PRODUCT_INACTIVE: 'Matched product is inactive',
  NO_PRODUCT_CODE: 'No product code in the file',
  EXCLUDED: 'Excluded from fulfilment',
}

export const STRATEGY_LABELS: Record<string, string> = {
  IN_HOUSE_FIRST: 'In-house first',
  OUTSOURCED_FIRST: 'Outsourced first',
  EARLIEST_BATCH: 'Earliest eligible batch first (FEFO, then FIFO)',
  WAREHOUSE_PRIORITY: 'Warehouse priority',
  MANUAL: 'Manual allocation',
}
