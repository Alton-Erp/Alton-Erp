// Stage 5 sales order helpers. Pure TypeScript (relative imports, no React) so
// they can be unit-tested with Node. The database recalculates and validates
// everything again (supabase/migrations/20261106090000_sales_orders_v2.sql).
import { isWholeUnit } from '../inventory/whole-units.ts'
import { normalizeImportDate } from '../production/production-v2-model.ts'

export type SoV2Status = 'DRAFT' | 'OPEN' | 'PARTIALLY_RESERVED' | 'STOCK_SHORTAGE' | 'PRODUCTION_PENDING' | 'READY_FOR_DISPATCH'
  | 'PARTIALLY_DISPATCHED' | 'FULLY_DISPATCHED' | 'CANCELLED'

export const SO_V2_STATUS: Record<SoV2Status, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  OPEN: { label: 'Open', tone: 'info' },
  PARTIALLY_RESERVED: { label: 'Partially Reserved', tone: 'info' },
  STOCK_SHORTAGE: { label: 'Stock Shortage', tone: 'danger' },
  PRODUCTION_PENDING: { label: 'Production Pending', tone: 'warning' },
  READY_FOR_DISPATCH: { label: 'Ready for Dispatch', tone: 'success' },
  PARTIALLY_DISPATCHED: { label: 'Partially Dispatched', tone: 'warning' },
  FULLY_DISPATCHED: { label: 'Fully Dispatched', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}

export const soStatusMeta = (s: string) => SO_V2_STATUS[s as SoV2Status] ?? { label: s, tone: 'neutral' as const }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface PriceLineInput { quantity: number; unitPrice: number | null; discountPercent: number | null; discountAmount: number | null; gstRate: number | null }

/** Same formula as private.so_v2_price: discount % wins over an amount; GST on the taxable value. */
export function priceLine(l: PriceLineInput) {
  const gross = r2(l.quantity * (l.unitPrice ?? 0))
  const discount = l.discountPercent !== null ? r2(gross * l.discountPercent / 100) : Math.min(l.discountAmount ?? 0, gross)
  const taxable = r2(gross - discount)
  const gst = r2(taxable * (l.gstRate ?? 0) / 100)
  return { gross, discount, taxable, gst, total: r2(taxable + gst) }
}

export function priceOrder(lines: PriceLineInput[], charges: { freight: number; other: number; gstRate: number }, interState: boolean) {
  const priced = lines.map(priceLine)
  const sum = (f: (p: ReturnType<typeof priceLine>) => number) => r2(priced.reduce((s, p) => s + f(p), 0))
  const chargeTotal = r2(charges.freight + charges.other)
  const gst = r2(sum((p) => p.gst) + r2(chargeTotal * charges.gstRate / 100))
  const cgst = interState ? 0 : r2(gst / 2)
  return {
    lines: priced,
    subtotal: sum((p) => p.gross),
    discount: sum((p) => p.discount),
    taxable: r2(sum((p) => p.taxable) + chargeTotal),
    freight: charges.freight,
    other: charges.other,
    gst,
    cgst,
    sgst: interState ? 0 : r2(gst - cgst),
    igst: interState ? gst : 0,
    grandTotal: r2(sum((p) => p.taxable) + chargeTotal + gst),
  }
}

/** Intra-state when the company and customer GST states match (or either is unknown), as the database does. */
export function isInterState(companyGstin: string | null, customerStateOrGstin: string | null): boolean {
  const a = companyGstin?.slice(0, 2) ?? null
  const b = customerStateOrGstin ? customerStateOrGstin.slice(0, 2) : null
  return Boolean(a && b && a !== b)
}

export interface FormLine { product: { unit: string; sku: string } | null; quantity: string; unitPrice: string; discountPercent: string; discountAmount: string; gstRate: string }

/** Browser-side checks of the order form (messages; empty = ok). */
export function validateSoForm(customerId: string | null, lines: FormLine[], charges: { freight: string; other: string }): string[] {
  const errors: string[] = []
  const num = (v: string) => /^\d+(\.\d+)?$/.test(v.trim())
  if (!customerId) errors.push('Choose the customer.')
  const filled = lines.filter((l) => l.product || l.quantity.trim())
  if (filled.length === 0) errors.push('Add at least one product.')
  filled.forEach((l, i) => {
    const n = `Line ${i + 1}`
    if (!l.product) return errors.push(`${n}: choose the product.`)
    const q = l.quantity.trim()
    if (!num(q) || Number(q) <= 0) errors.push(`${n} (${l.product.sku}): enter a quantity greater than zero.`)
    else if (isWholeUnit(l.product.unit) && !Number.isInteger(Number(q))) errors.push(`${n} (${l.product.sku}): ${l.product.unit} is counted in whole pieces.`)
    if (l.unitPrice.trim() && !num(l.unitPrice)) errors.push(`${n}: the selling price must be a number.`)
    if (l.discountPercent.trim() && (!num(l.discountPercent) || Number(l.discountPercent) > 100)) errors.push(`${n}: discount % must be 0 to 100.`)
    if (l.discountAmount.trim() && !num(l.discountAmount)) errors.push(`${n}: the discount amount must be a number.`)
    if (l.gstRate.trim() && (!num(l.gstRate) || Number(l.gstRate) > 100)) errors.push(`${n}: GST rate must be 0 to 100.`)
  })
  if (charges.freight.trim() && !num(charges.freight)) errors.push('Freight must be a number.')
  if (charges.other.trim() && !num(charges.other)) errors.push('Other charges must be a number.')
  return errors
}

// ---------------------------------------------------------------------------
// Excel import
// ---------------------------------------------------------------------------
export const SALES_IMPORT_COLUMNS = ['Order Date', 'Customer Name', 'Customer GSTIN', 'Customer Reference', 'Product SKU', 'Product Name', 'Quantity', 'Unit',
  'Selling Price', 'Discount', 'GST Rate', 'Expected Delivery Date', 'Remarks'] as const
export const MAX_SALES_IMPORT_ROWS = 2000

type Key = 'order_date' | 'customer_name' | 'customer_gstin' | 'customer_reference' | 'sku' | 'product_name' | 'quantity' | 'unit' | 'selling_price'
  | 'discount' | 'gst_rate' | 'expected_delivery_date' | 'remarks'
const ALIASES: Record<Key, string[]> = {
  order_date: ['order date', 'date', 'so date'],
  customer_name: ['customer name', 'customer', 'party', 'party name'],
  customer_gstin: ['customer gstin', 'gstin', 'gst number', 'gst no'],
  customer_reference: ['customer reference', 'reference', 'order number', 'order no', 'customer po', 'po number', 'customer order number'],
  sku: ['product sku', 'sku', 'product code', 'item code'],
  product_name: ['product name', 'product', 'item', 'item name'],
  quantity: ['quantity', 'qty'],
  unit: ['unit', 'uom', 'unit of measurement'],
  selling_price: ['selling price', 'price', 'rate', 'unit price'],
  discount: ['discount', 'discount %', 'discount percentage', 'disc'],
  gst_rate: ['gst rate', 'gst', 'gst %', 'tax rate'],
  expected_delivery_date: ['expected delivery date', 'delivery date', 'expected date'],
  remarks: ['remarks', 'notes', 'comments'],
}
const REQUIRED: Key[] = ['order_date', 'sku', 'quantity']
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim()

export type SalesImportRow = Record<Key, string> & { row_number: number }

export function parseSalesSheet(rows: string[][]): { headerRow: number; missing: string[]; rows: SalesImportRow[] } {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] ?? []).map((c) => norm(String(c ?? '')))
    const map: Partial<Record<Key, number>> = {}
    for (const k of Object.keys(ALIASES) as Key[]) {
      const idx = cells.findIndex((c) => ALIASES[k].includes(c))
      if (idx >= 0) map[k] = idx
    }
    if (!REQUIRED.every((k) => map[k] !== undefined) || (map.customer_name === undefined && map.customer_gstin === undefined)) continue
    const cell = (r: string[], k: Key) => (map[k] === undefined ? '' : String(r[map[k]!] ?? '').trim())
    const out: SalesImportRow[] = []
    rows.slice(i + 1).forEach((r, j) => {
      if (!r || r.every((c) => String(c ?? '').trim() === '')) return
      out.push({
        row_number: i + j + 2,
        order_date: normalizeImportDate(cell(r, 'order_date')),
        customer_name: cell(r, 'customer_name'),
        customer_gstin: cell(r, 'customer_gstin').toUpperCase(),
        customer_reference: cell(r, 'customer_reference'),
        sku: cell(r, 'sku'),
        product_name: cell(r, 'product_name'),
        quantity: cell(r, 'quantity').replace(/,/g, ''),
        unit: cell(r, 'unit').toUpperCase(),
        selling_price: cell(r, 'selling_price').replace(/,/g, ''),
        discount: cell(r, 'discount'),
        gst_rate: cell(r, 'gst_rate'),
        expected_delivery_date: cell(r, 'expected_delivery_date') ? normalizeImportDate(cell(r, 'expected_delivery_date')) : '',
        remarks: cell(r, 'remarks'),
      })
    })
    return { headerRow: i + 1, missing: [], rows: out }
  }
  return { headerRow: 0, missing: ['Order Date', 'Customer Name or Customer GSTIN', 'Product SKU', 'Quantity'], rows: [] }
}

export function salesTemplateRows(today: string): (string | number)[][] {
  return [
    [...SALES_IMPORT_COLUMNS],
    [today, 'Xylo Homes', '27AABCX1234A1Z5', 'PO-778', 'FG-000001', 'Wash basin', 100, 'PCS', 1000, 10, 18, '', 'Rows with the same customer and reference form one order'],
    [today, 'Xylo Homes', '27AABCX1234A1Z5', 'PO-778', 'FG-000002', 'Closet', 50, 'PCS', 2500, '', '', '', ''],
  ]
}

export interface ImportGroup {
  first_row: number
  status: 'VALID' | 'WARNING' | 'ERROR'
  errors: string[]
  warnings: string[]
  customer_name: string | null
  customer_reference: string | null
  order_date: string | null
  estimated_total: number
  rows: { row_number: number; sku: string | null; product_name: string | null; quantity: number | null; unit: string | null; unit_price: number | null; errors: string[]; warnings: string[]; line_total: number | null }[]
}

/** Error report: one line per spreadsheet row with the order result and every message. */
export function buildSalesImportReport(
  groups: ImportGroup[],
  result?: { created: { first_row: number; sales_order_number: string }[]; failed: { first_row: number; messages: string[] }[] },
): (string | number)[][] {
  const created = new Map((result?.created ?? []).map((c) => [c.first_row, c.sales_order_number]))
  const failed = new Map((result?.failed ?? []).map((f) => [f.first_row, f.messages]))
  const out: (string | number)[][] = [['Row', 'Customer', 'Customer Reference', 'Product SKU', 'Quantity', 'Result', 'Sales Order', 'Errors', 'Warnings']]
  for (const g of groups) {
    const so = created.get(g.first_row)
    const result = so ? 'Imported' : failed.has(g.first_row) || g.status === 'ERROR' ? 'Not imported' : 'Ready'
    for (const r of g.rows) {
      out.push([r.row_number, g.customer_name ?? '', g.customer_reference ?? '', r.sku ?? '', r.quantity ?? '', result, so ?? '',
        [...r.errors, ...(failed.get(g.first_row) ?? g.errors)].join(' '), [...r.warnings, ...g.warnings].join(' ')])
    }
  }
  return out
}
