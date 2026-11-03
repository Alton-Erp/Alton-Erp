// Stage 6 invoicing helpers. Pure TypeScript (relative imports, no React) so
// they can be unit-tested with Node. The database recalculates and validates
// everything again (supabase/migrations/20261107090000_invoicing_v2.sql);
// these give the operator the same figures while typing.
import { isWholeUnit } from '../inventory/whole-units.ts'
import { normalizeImportDate } from '../production/production-v2-model.ts'

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export type PricingMode = 'EXCLUSIVE' | 'INCLUSIVE'
export type RoundingMode = 'NEAREST' | 'UP' | 'DOWN'
export type TaxTreatment = 'INTRA_STATE' | 'INTER_STATE' | 'NONE'

export interface InvoiceLineInput {
  quantity: number
  unitPrice: number | null
  discountPercent: number | null
  discountAmount: number | null
  gstRate: number | null
}

export interface InvoiceCalcInput {
  lines: InvoiceLineInput[]
  charges: { kind: 'FREIGHT' | 'PACKING' | 'OTHER'; amount: number; gstRate: number }[]
  pricingMode: PricingMode
  invoiceDiscountPercent: number | null
  invoiceDiscountAmount: number | null
  treatment: TaxTreatment
  roundOff: boolean
  roundingMode: RoundingMode
}

export interface CalcLine { gross: number; discount: number; invoiceDiscount: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }

function taxLine(net: number, rate: number, inclusive: boolean, treatment: TaxTreatment) {
  const r = treatment === 'NONE' ? 0 : rate
  const taxable = inclusive ? r2(net * 100 / (100 + r)) : net
  if (treatment === 'INTER_STATE') {
    const igst = inclusive ? r2(net - taxable) : r2(taxable * r / 100)
    return { taxable, cgst: 0, sgst: 0, igst }
  }
  if (treatment === 'INTRA_STATE') {
    if (inclusive) {
      const tax = r2(net - taxable)
      const cgst = r > 0 ? r2(tax / 2) : 0
      return { taxable, cgst, sgst: r > 0 ? r2(tax - cgst) : 0, igst: 0 }
    }
    const half = r2(taxable * (r / 2) / 100)
    return { taxable, cgst: half, sgst: half, igst: 0 }
  }
  return { taxable, cgst: 0, sgst: 0, igst: 0 }
}

/** Same steps as private.invoice_recalculate (line discount, shared invoice discount, tax, charges, rounding). */
export function calculateInvoice(input: InvoiceCalcInput) {
  const base = input.lines.map((l) => {
    const gross = r2(l.quantity * (l.unitPrice ?? 0))
    const discount = Math.min((l.discountPercent ?? 0) > 0 ? r2(gross * (l.discountPercent ?? 0) / 100) : (l.discountAmount ?? 0), gross)
    return { gross, discount, net: r2(gross - discount) }
  })
  const netTotal = r2(base.reduce((s, b) => s + b.net, 0))
  let hd = (input.invoiceDiscountPercent ?? 0) > 0 ? r2(netTotal * (input.invoiceDiscountPercent ?? 0) / 100) : Math.min(input.invoiceDiscountAmount ?? 0, netTotal)
  const shares = base.map(() => 0)
  if (hd > 0 && netTotal > 0) {
    base.forEach((b, i) => { shares[i] = r2(hd * b.net / netTotal) })
    const rest = r2(hd - shares.reduce((s, x) => s + x, 0))
    if (rest !== 0) {
      let top = 0
      base.forEach((b, i) => { if (b.net > base[top].net) top = i })
      shares[top] = Math.max(r2(shares[top] + rest), 0)
    }
  } else {
    hd = 0
  }
  const lines: CalcLine[] = base.map((b, i) => {
    const net = Math.max(r2(b.net - shares[i]), 0)
    const t = taxLine(net, input.lines[i].gstRate ?? 0, input.pricingMode === 'INCLUSIVE', input.treatment)
    return { gross: b.gross, discount: b.discount, invoiceDiscount: shares[i], ...t, total: r2(t.taxable + t.cgst + t.sgst + t.igst) }
  })
  const charges = input.charges.filter((c) => c.amount > 0).map((c) => {
    const t = taxLine(r2(c.amount), c.gstRate, false, input.treatment)
    return { kind: c.kind, ...t, total: r2(t.taxable + t.cgst + t.sgst + t.igst) }
  })
  const all = [...lines, ...charges]
  const sum = (f: (x: { taxable: number; cgst: number; sgst: number; igst: number; total: number }) => number) => r2(all.reduce((s, x) => s + f(x), 0))
  const total = sum((x) => x.total)
  const grand = !input.roundOff ? total : input.roundingMode === 'UP' ? Math.ceil(total - 1e-9) : input.roundingMode === 'DOWN' ? Math.floor(total + 1e-9) : Math.round(total)
  return {
    lines,
    charges,
    subtotal: r2(lines.reduce((s, l) => s + l.gross, 0)),
    lineDiscount: r2(lines.reduce((s, l) => s + l.discount, 0)),
    invoiceDiscount: hd,
    discount: r2(lines.reduce((s, l) => s + l.discount, 0) + hd),
    taxable: sum((x) => x.taxable),
    chargesTaxable: r2(charges.reduce((s, c) => s + c.taxable, 0)),
    cgst: sum((x) => x.cgst),
    sgst: sum((x) => x.sgst),
    igst: sum((x) => x.igst),
    roundOff: r2(grand - total),
    grandTotal: r2(grand),
  }
}

/** Intra-state when the seller's GSTIN state equals the place of supply; 96 (outside India) is inter-state. */
export function treatmentFor(sellerGstin: string | null, placeOfSupply: string | null, gstRegistered = true): TaxTreatment | null {
  if (!gstRegistered) return 'NONE'
  if (placeOfSupply === '96') return 'INTER_STATE'
  const seller = sellerGstin?.slice(0, 2) ?? null
  if (!seller || !placeOfSupply) return null
  return seller === placeOfSupply ? 'INTRA_STATE' : 'INTER_STATE'
}

/** Document heading used on screen and in the PDF. A proforma is never called a tax invoice. */
export function documentTitle(inv: { is_proforma?: boolean | null; invoice_type?: string | null; status?: string | null }): string {
  if (inv.is_proforma) return 'PROFORMA INVOICE'
  return inv.invoice_type === 'BILL_OF_SUPPLY' ? 'BILL OF SUPPLY' : 'TAX INVOICE'
}

export type InvoiceStatusKey = 'DRAFT' | 'PROFORMA' | 'ISSUED' | 'CANCELLED' | 'DISCARDED' | 'PENDING_APPROVAL'
export type PaymentStatusKey = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED'

/** Payment status as the spec names it: Unpaid / Partially Paid / Paid / Overdue / Cancelled. */
export function paymentStatusOf(row: { status: string; payment_status?: string | null; display_status?: string | null }): PaymentStatusKey | null {
  if (row.status === 'CANCELLED') return 'CANCELLED'
  if (row.status !== 'ISSUED') return null
  if (row.payment_status === 'PAID') return 'PAID'
  if (row.display_status === 'OVERDUE') return 'OVERDUE'
  return row.payment_status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : 'UNPAID'
}

export const PAYMENT_STATUS_META: Record<PaymentStatusKey, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  UNPAID: { label: 'Unpaid', tone: 'info' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
  OVERDUE: { label: 'Overdue', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
}

export const PAYMENT_MODES: { value: string; label: string }[] = [
  { value: 'BANK_TRANSFER', label: 'Bank' },
  { value: 'UPI', label: 'UPI' },
  { value: 'CASH', label: 'Cash' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CARD', label: 'Card' },
  { value: 'DEMAND_DRAFT', label: 'Demand draft' },
  { value: 'OTHER', label: 'Other' },
]
export const paymentModeLabel = (v: string) => PAYMENT_MODES.find((m) => m.value === v)?.label ?? v

// ---------------------------------------------------------------------------
// Form checks
// ---------------------------------------------------------------------------
export interface InvoiceFormLine {
  product: { unit: string; sku: string } | null
  quantity: string
  unitPrice: string
  discountPercent: string
  discountAmount: string
  gstRate: string
  pending?: number | null
}

const isNum = (v: string) => /^\d+(\.\d+)?$/.test(v.trim())

/** Browser-side checks of the invoice form (messages; empty = ok). */
export function validateInvoiceForm(
  f: { customerId: string | null; invoiceDate: string; dueDate: string; ewayBill: string; gstin: string; pan: string; invoiceDiscountPercent: string; invoiceDiscountAmount: string; charges: Record<string, string> },
  lines: InvoiceFormLine[],
): string[] {
  const errors: string[] = []
  if (!f.customerId) errors.push('Choose the customer.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.invoiceDate)) errors.push('Enter the invoice date.')
  if (f.dueDate && f.invoiceDate && f.dueDate < f.invoiceDate) errors.push('The due date must be on or after the invoice date.')
  if (f.ewayBill.trim() && !/^\d{12}$/.test(f.ewayBill.trim())) errors.push('An e-way bill number has 12 digits.')
  if (f.gstin.trim() && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(f.gstin.trim().toUpperCase())) errors.push('The customer GSTIN is not valid.')
  if (f.pan.trim() && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(f.pan.trim().toUpperCase())) errors.push('The customer PAN is not valid (e.g. ABCDE1234F).')
  if (f.invoiceDiscountPercent.trim() && (!isNum(f.invoiceDiscountPercent) || Number(f.invoiceDiscountPercent) > 100)) errors.push('The invoice discount % must be 0 to 100.')
  if (f.invoiceDiscountAmount.trim() && !isNum(f.invoiceDiscountAmount)) errors.push('The invoice discount amount must be a number.')
  if (Number(f.invoiceDiscountPercent || 0) > 0 && Number(f.invoiceDiscountAmount || 0) > 0) errors.push('Give the invoice discount as a percentage or an amount, not both.')
  for (const [k, v] of Object.entries(f.charges)) if (v.trim() && !isNum(v)) errors.push(`${k} must be a number.`)
  const filled = lines.filter((l) => l.product || l.quantity.trim())
  if (filled.length === 0) errors.push('Add at least one product.')
  filled.forEach((l, i) => {
    const n = `Line ${i + 1}`
    if (!l.product) return errors.push(`${n}: choose the product.`)
    const q = l.quantity.trim()
    if (!isNum(q) || Number(q) <= 0) errors.push(`${n} (${l.product.sku}): enter a quantity greater than zero.`)
    else if (isWholeUnit(l.product.unit) && !Number.isInteger(Number(q))) errors.push(`${n} (${l.product.sku}): ${l.product.unit} is counted in whole pieces.`)
    else if (l.pending != null && Number(q) > l.pending) errors.push(`${n} (${l.product.sku}): only ${l.pending} ${l.product.unit} of the sales order is left to invoice.`)
    if (l.unitPrice.trim() && !isNum(l.unitPrice)) errors.push(`${n}: the rate must be a number.`)
    if (!l.unitPrice.trim()) errors.push(`${n} (${l.product.sku}): enter the rate.`)
    if (l.discountPercent.trim() && (!isNum(l.discountPercent) || Number(l.discountPercent) > 100)) errors.push(`${n}: discount % must be 0 to 100.`)
    if (l.discountAmount.trim() && !isNum(l.discountAmount)) errors.push(`${n}: the discount amount must be a number.`)
    if (Number(l.discountPercent || 0) > 0 && Number(l.discountAmount || 0) > 0) errors.push(`${n}: give either a discount % or an amount, not both.`)
    if (l.gstRate.trim() && (!isNum(l.gstRate) || Number(l.gstRate) > 100)) errors.push(`${n}: GST rate must be 0 to 100.`)
  })
  return errors
}

/** Warnings shown before saving a change that affects balances or tax. */
export function changeWarnings(before: { grandTotal: number; placeOfSupply: string | null; customerId: string | null } | null,
  after: { grandTotal: number; placeOfSupply: string | null; customerId: string | null }): string[] {
  if (!before) return []
  const w: string[] = []
  if (before.customerId && before.customerId !== after.customerId) w.push('The customer changes: addresses, GSTIN and place of supply are taken from the new customer.')
  if (before.placeOfSupply !== after.placeOfSupply) w.push(`The place of supply changes (${before.placeOfSupply ?? '—'} → ${after.placeOfSupply ?? '—'}); CGST/SGST or IGST is recalculated.`)
  if (r2(before.grandTotal) !== r2(after.grandTotal)) w.push(`The invoice total changes from ${before.grandTotal.toFixed(2)} to ${after.grandTotal.toFixed(2)}.`)
  return w
}

// ---------------------------------------------------------------------------
// Excel import
// ---------------------------------------------------------------------------
export const INVOICE_IMPORT_COLUMNS = ['Invoice Number', 'Invoice Date', 'Due Date', 'Customer Name', 'Customer GSTIN', 'Sales Order Number', 'Product SKU',
  'Product Name', 'HSN Code', 'Quantity', 'Unit', 'Rate', 'Discount', 'GST Rate', 'Place of Supply', 'Payment Terms', 'Remarks'] as const
export const MAX_INVOICE_IMPORT_ROWS = 2000

type Key = 'invoice_number' | 'invoice_date' | 'due_date' | 'customer_name' | 'customer_gstin' | 'sales_order_number' | 'sku' | 'product_name' | 'hsn_code'
  | 'quantity' | 'unit' | 'rate' | 'discount' | 'gst_rate' | 'place_of_supply' | 'payment_terms' | 'remarks'
const ALIASES: Record<Key, string[]> = {
  invoice_number: ['invoice number', 'invoice no', 'invoice', 'bill number', 'bill no', 'inv no'],
  invoice_date: ['invoice date', 'date', 'bill date'],
  due_date: ['due date', 'payment due date'],
  customer_name: ['customer name', 'customer', 'party', 'party name'],
  customer_gstin: ['customer gstin', 'gstin', 'gst number', 'gst no'],
  sales_order_number: ['sales order number', 'sales order', 'so number', 'so no'],
  sku: ['product sku', 'sku', 'product code', 'item code'],
  product_name: ['product name', 'product', 'item', 'item name', 'description'],
  hsn_code: ['hsn code', 'hsn', 'hsn sac', 'hsn/sac'],
  quantity: ['quantity', 'qty'],
  unit: ['unit', 'uom'],
  rate: ['rate', 'price', 'unit price', 'selling price'],
  discount: ['discount', 'discount %', 'disc'],
  gst_rate: ['gst rate', 'gst', 'gst %', 'tax rate'],
  place_of_supply: ['place of supply', 'pos', 'state'],
  payment_terms: ['payment terms', 'terms', 'credit days'],
  remarks: ['remarks', 'notes', 'comments'],
}
const REQUIRED: Key[] = ['invoice_number', 'invoice_date', 'sku', 'quantity']
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%/]+/g, ' ').trim()

export type InvoiceImportRow = Record<Key, string> & { row_number: number }

export function parseInvoiceSheet(rows: string[][]): { headerRow: number; missing: string[]; rows: InvoiceImportRow[] } {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = (rows[i] ?? []).map((c) => norm(String(c ?? '')))
    const map: Partial<Record<Key, number>> = {}
    for (const k of Object.keys(ALIASES) as Key[]) {
      const idx = cells.findIndex((c, j) => ALIASES[k].includes(c) && !Object.values(map).includes(j))
      if (idx >= 0) map[k] = idx
    }
    if (!REQUIRED.every((k) => map[k] !== undefined) || (map.customer_name === undefined && map.customer_gstin === undefined)) continue
    const cell = (r: string[], k: Key) => (map[k] === undefined ? '' : String(r[map[k]!] ?? '').trim())
    const out: InvoiceImportRow[] = []
    rows.slice(i + 1).forEach((r, j) => {
      if (!r || r.every((c) => String(c ?? '').trim() === '')) return
      out.push({
        row_number: i + j + 2,
        invoice_number: cell(r, 'invoice_number').toUpperCase(),
        invoice_date: normalizeImportDate(cell(r, 'invoice_date')),
        due_date: cell(r, 'due_date') ? normalizeImportDate(cell(r, 'due_date')) : '',
        customer_name: cell(r, 'customer_name'),
        customer_gstin: cell(r, 'customer_gstin').toUpperCase(),
        sales_order_number: cell(r, 'sales_order_number'),
        sku: cell(r, 'sku'),
        product_name: cell(r, 'product_name'),
        hsn_code: cell(r, 'hsn_code'),
        quantity: cell(r, 'quantity').replace(/,/g, ''),
        unit: cell(r, 'unit').toUpperCase(),
        rate: cell(r, 'rate').replace(/,/g, ''),
        discount: cell(r, 'discount'),
        gst_rate: cell(r, 'gst_rate'),
        place_of_supply: cell(r, 'place_of_supply'),
        payment_terms: cell(r, 'payment_terms'),
        remarks: cell(r, 'remarks'),
      })
    })
    return { headerRow: i + 1, missing: [], rows: out }
  }
  return { headerRow: 0, missing: ['Invoice Number', 'Invoice Date', 'Customer Name or Customer GSTIN', 'Product SKU', 'Quantity'], rows: [] }
}

export function invoiceTemplateRows(today: string): (string | number)[][] {
  return [
    [...INVOICE_IMPORT_COLUMNS],
    ['OLD-1001', today, '', 'Xylo Homes', '27AABCX1234A1Z5', '', 'FG-000001', 'Wash basin', '69101000', 10, 'PCS', 1000, 10, 18, '27', '30 days', 'Rows with the same invoice number form one invoice'],
    ['OLD-1001', today, '', 'Xylo Homes', '27AABCX1234A1Z5', '', 'FG-000002', 'Closet', '69101000', 5, 'PCS', 2500, '', 18, '27', '30 days', ''],
  ]
}

export interface InvoiceImportGroup {
  invoice_number: string | null
  first_row: number
  status: 'VALID' | 'WARNING' | 'ERROR'
  errors: string[]
  warnings: string[]
  invoice_date: string | null
  customer_name: string | null
  customer_gstin: string | null
  sales_order_number: string | null
  place_of_supply: string | null
  estimated_total: number
  rows: { row_number: number; sku: string | null; product_name: string | null; quantity: number | null; unit: string | null; rate: number | null; gst_rate: number | null; errors: string[]; warnings: string[]; line_value: number | null }[]
}

/** Error report: one line per spreadsheet row with the invoice result and every message. */
export function buildInvoiceImportReport(
  groups: InvoiceImportGroup[],
  result?: { created: { first_row: number; invoice_number: string }[]; failed: { first_row: number; messages: string[] }[] },
): (string | number)[][] {
  const created = new Map((result?.created ?? []).map((c) => [c.first_row, c.invoice_number]))
  const failed = new Map((result?.failed ?? []).map((f) => [f.first_row, f.messages]))
  const out: (string | number)[][] = [['Row', 'Invoice Number', 'Customer', 'Product SKU', 'Quantity', 'Result', 'Errors', 'Warnings']]
  for (const g of groups) {
    const inv = created.get(g.first_row)
    const res = inv ? 'Imported' : failed.has(g.first_row) || g.status === 'ERROR' ? 'Not imported' : 'Ready'
    for (const r of g.rows) {
      out.push([r.row_number, g.invoice_number ?? '', g.customer_name ?? '', r.sku ?? '', r.quantity ?? '', res,
        [...r.errors, ...(failed.get(g.first_row) ?? g.errors)].join(' '), [...r.warnings, ...g.warnings].join(' ')])
    }
  }
  return out
}
