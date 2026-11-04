// Reporting centre definitions (Stage 7). Pure TypeScript so it can be unit
// tested. Every report is computed by public.erp_report in the database; this
// file only says how to show and filter it.

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'percent' | 'bool'
export interface ReportColumn { key: string; label: string; type?: ColumnType; total?: boolean }
export type ReportFilterKind = 'date' | 'product' | 'customer' | 'supplier'
export interface ReportDef {
  key: string
  title: string
  group: 'Products & stock' | 'Purchase' | 'Production' | 'Sales' | 'Invoicing & payments'
  description: string
  filters: ReportFilterKind[]
  columns: ReportColumn[]
  /** Record a row opens, when there is one. */
  link?: (row: Record<string, unknown>) => string | null
}

const id = (k: string, base: string) => (row: Record<string, unknown>) => (row[k] ? `${base}${String(row[k])}` : null)

export const REPORTS: ReportDef[] = [
  { key: 'PRODUCTS', title: 'Product Master Report', group: 'Products & stock', description: 'Every product with type, unit, HSN, GST, MRP, prices, lead time, reorder level (days), supplier details, dimensions and BOM status.',
    filters: ['product'], link: id('id', '/products/'), columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'product_type', label: 'Type' }, { key: 'category', label: 'Category' },
      { key: 'unit', label: 'Unit' }, { key: 'hsn_code', label: 'HSN' }, { key: 'gst_rate', label: 'GST %', type: 'number' }, { key: 'mrp', label: 'MRP', type: 'money' },
      { key: 'selling_price', label: 'Selling price', type: 'money' }, { key: 'standard_cost', label: 'Standard cost', type: 'money' },
      { key: 'lead_time_days', label: 'Lead time (days)', type: 'number' }, { key: 'reorder_level_days', label: 'Reorder level (days)', type: 'number' },
      { key: 'reorder_level', label: 'Reorder qty (earlier)', type: 'number' }, { key: 'supplier_model_number', label: 'Supplier model no.' },
      { key: 'supplier_product_name', label: 'Supplier product name' }, { key: 'length_cm', label: 'Length (cm)', type: 'number' },
      { key: 'width_cm', label: 'Width (cm)', type: 'number' }, { key: 'height_cm', label: 'Height (cm)', type: 'number' },
      { key: 'bom', label: 'Approved BOM', type: 'bool' }, { key: 'status', label: 'Status' }] },
  { key: 'REORDER_PLANNING', title: 'Reorder Planning (Days of Cover)', group: 'Products & stock', description: 'Available, reserved and incoming stock, average daily consumption (last 90 days), days of cover, lead time and the reorder recommendation.',
    filters: ['product'], link: id('product_id', '/inventory/stock/'), columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'unit', label: 'Unit' }, { key: 'status', label: 'Recommendation' },
      { key: 'available', label: 'Available', type: 'number' }, { key: 'reserved', label: 'Reserved', type: 'number' }, { key: 'incoming', label: 'Incoming', type: 'number' },
      { key: 'avg_daily', label: 'Avg / day', type: 'number' }, { key: 'coverage_days', label: 'Days of cover', type: 'number' },
      { key: 'reorder_level_days', label: 'Reorder level (days)', type: 'number' }, { key: 'lead_time_days', label: 'Lead time (days)', type: 'number' },
      { key: 'suggested_quantity', label: 'Suggested order', type: 'number' }] },
  { key: 'STOCK_REGISTER', title: 'Stock Register', group: 'Products & stock', description: 'Physical, reserved, available and rejected stock per product (current).',
    filters: ['product'], link: id('product_id', '/inventory/stock/'), columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'product_type', label: 'Type' }, { key: 'unit', label: 'Unit' },
      { key: 'on_hand', label: 'Physical', type: 'number' }, { key: 'reserved', label: 'Reserved', type: 'number' }, { key: 'available', label: 'Available', type: 'number' },
      { key: 'rejected', label: 'Rejected', type: 'number' }] },
  { key: 'STOCK_MOVEMENTS', title: 'Stock Movement Report', group: 'Products & stock', description: 'Every posted stock movement in the period (in +, out −).',
    filters: ['date', 'product'], columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Movement' }, { key: 'type', label: 'Type' }, { key: 'sku', label: 'SKU' },
      { key: 'product_name', label: 'Product' }, { key: 'product_version', label: 'Version' }, { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'unit', label: 'Unit' }, { key: 'warehouse', label: 'Warehouse' },
      { key: 'location', label: 'Location' }, { key: 'reference', label: 'Reference' }, { key: 'reason', label: 'Reason' }] },
  { key: 'INVENTORY_VALUATION', title: 'Inventory Valuation', group: 'Products & stock', description: 'Current stock at the weighted-average receipt cost of each lot. Lots without a cost are shown, not guessed.',
    filters: ['product'], link: id('product_id', '/inventory/stock/'), columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'product_type', label: 'Type' }, { key: 'unit', label: 'Unit' },
      { key: 'on_hand', label: 'Physical', type: 'number' }, { key: 'average_cost', label: 'Average cost', type: 'money' }, { key: 'value', label: 'Value', type: 'money', total: true },
      { key: 'uncosted_quantity', label: 'Quantity without cost', type: 'number' }] },
  { key: 'LOW_STOCK', title: 'Low Stock Report', group: 'Products & stock', description: 'Products whose days of cover are at or below their reorder level (days) or below an earlier reorder quantity, and products out of stock.',
    filters: ['product'], link: id('product_id', '/inventory/stock/'), columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'unit', label: 'Unit' }, { key: 'on_hand', label: 'Physical', type: 'number' },
      { key: 'reserved', label: 'Reserved', type: 'number' }, { key: 'available', label: 'Available', type: 'number' },
      { key: 'reorder_level_days', label: 'Reorder level (days)', type: 'number' }, { key: 'lead_time_days', label: 'Lead time (days)', type: 'number' },
      { key: 'reorder_level', label: 'Reorder qty (earlier)', type: 'number' }, { key: 'status', label: 'Status' }] },
  { key: 'PURCHASE_REGISTER', title: 'Purchase Register', group: 'Purchase', description: 'Purchase orders in the period with value and what is still to be received.',
    filters: ['date', 'supplier', 'product'], link: id('id', '/purchase-orders/'), columns: [
      { key: 'po_number', label: 'PO' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Supplier' }, { key: 'status', label: 'Status' },
      { key: 'supplier_invoice_number', label: 'Supplier invoice' }, { key: 'supplier_challan_number', label: 'Supplier challan' },
      { key: 'grn_invoice_numbers', label: 'GRN invoices' }, { key: 'grn_challan_numbers', label: 'GRN challans' },
      { key: 'expected', label: 'Expected', type: 'date' }, { key: 'taxable', label: 'Taxable', type: 'money', total: true }, { key: 'gst', label: 'GST', type: 'money', total: true },
      { key: 'grand_total', label: 'Total', type: 'money', total: true }, { key: 'pending_value', label: 'Pending value', type: 'money', total: true }] },
  { key: 'GRN_REGISTER', title: 'GRN Register', group: 'Purchase', description: 'Goods received per line: received, accepted, rejected and value.',
    filters: ['date', 'supplier', 'product'], link: id('id', '/goods-receipts/'), columns: [
      { key: 'receipt_number', label: 'GRN' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'supplier', label: 'Supplier' }, { key: 'po_number', label: 'PO' },
      { key: 'supplier_invoice_number', label: 'Supplier invoice' }, { key: 'supplier_challan_number', label: 'Supplier challan' },
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'product_version', label: 'Version' }, { key: 'received', label: 'Received', type: 'number' }, { key: 'accepted', label: 'Accepted', type: 'number' },
      { key: 'rejected', label: 'Rejected', type: 'number' }, { key: 'unit', label: 'Unit' }, { key: 'value', label: 'Value', type: 'money', total: true }, { key: 'status', label: 'Status' }] },
  { key: 'SUPPLIER_PURCHASES', title: 'Supplier-wise Purchase Report', group: 'Purchase', description: 'Per supplier: orders, ordered value, goods received, payments and outstanding.',
    filters: ['date', 'supplier'], columns: [
      { key: 'supplier_code', label: 'Code' }, { key: 'supplier', label: 'Supplier' }, { key: 'orders', label: 'POs', type: 'number', total: true },
      { key: 'ordered_value', label: 'Ordered', type: 'money', total: true }, { key: 'received_value', label: 'Received', type: 'money', total: true },
      { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'outstanding', label: 'Outstanding (all time)', type: 'money', total: true }] },
  { key: 'PRODUCTION_REGISTER', title: 'Production Register', group: 'Production', description: 'Production orders: planned, good, rejected and scrap output.',
    filters: ['date', 'product'], link: id('id', '/production/orders/'), columns: [
      { key: 'order_number', label: 'Order' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' },
      { key: 'product_version', label: 'Product version' }, { key: 'bom', label: 'BOM version' }, { key: 'unit', label: 'Unit' }, { key: 'planned', label: 'Planned', type: 'number' }, { key: 'good', label: 'Good', type: 'number' }, { key: 'rejected', label: 'Rejected', type: 'number' },
      { key: 'scrap', label: 'Scrap', type: 'number' }, { key: 'status', label: 'Status' }, { key: 'completed', label: 'Completed', type: 'date' }] },
  { key: 'MATERIAL_CONSUMPTION', title: 'Material Consumption Report', group: 'Production', description: 'Materials consumed by production: BOM standard against actual.',
    filters: ['date', 'product'], columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'order_number', label: 'Order' }, { key: 'bom', label: 'BOM version' }, { key: 'finished_sku', label: 'For' }, { key: 'sku', label: 'Material' },
      { key: 'product_name', label: 'Name' }, { key: 'component_version', label: 'Material version' }, { key: 'unit', label: 'Unit' }, { key: 'planned', label: 'Standard', type: 'number' }, { key: 'actual', label: 'Actual', type: 'number' },
      { key: 'difference', label: 'Difference', type: 'number' }, { key: 'status', label: 'Status' }] },
  { key: 'PRODUCTION_WASTAGE', title: 'Production Wastage Report', group: 'Production', description: 'Rejected and scrapped output, loss % and material used above the BOM standard.',
    filters: ['date', 'product'], columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'receipt_number', label: 'Receipt' }, { key: 'order_number', label: 'Order' }, { key: 'sku', label: 'SKU' },
      { key: 'product_version', label: 'Version' }, { key: 'unit', label: 'Unit' }, { key: 'good', label: 'Good', type: 'number' }, { key: 'rejected', label: 'Rejected', type: 'number' }, { key: 'scrap', label: 'Scrap', type: 'number' },
      { key: 'loss_percent', label: 'Loss %', type: 'percent' }, { key: 'material_over_use', label: 'Material above standard', type: 'number' }, { key: 'reason', label: 'Reason' }] },
  { key: 'SALES_ORDER_REGISTER', title: 'Sales Order Register', group: 'Sales', description: 'Sales orders in the period with status and order value (not revenue).',
    filters: ['date', 'customer', 'product'], link: id('id', '/sales/orders/'), columns: [
      { key: 'order_number', label: 'Order' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'reference', label: 'Reference' },
      { key: 'status', label: 'Status' }, { key: 'taxable', label: 'Taxable', type: 'money', total: true }, { key: 'grand_total', label: 'Order value', type: 'money', total: true },
      { key: 'delivery', label: 'Delivery', type: 'date' }] },
  { key: 'CUSTOMER_SALES', title: 'Customer-wise Sales Report', group: 'Sales', description: 'Per customer: order value, invoiced revenue, collections and outstanding — kept separate.',
    filters: ['date', 'customer'], columns: [
      { key: 'customer_code', label: 'Code' }, { key: 'customer', label: 'Customer' }, { key: 'orders', label: 'Orders', type: 'number', total: true },
      { key: 'order_value', label: 'Order value', type: 'money', total: true }, { key: 'invoiced', label: 'Invoiced', type: 'money', total: true },
      { key: 'collected', label: 'Collected', type: 'money', total: true }, { key: 'outstanding', label: 'Outstanding (all time)', type: 'money', total: true }] },
  { key: 'PRODUCT_SALES', title: 'Product-wise Sales Report', group: 'Sales', description: 'Per product: ordered, dispatched and invoiced quantities and invoiced value.',
    filters: ['date', 'customer', 'product'], columns: [
      { key: 'sku', label: 'SKU' }, { key: 'product_name', label: 'Product' }, { key: 'unit', label: 'Unit' }, { key: 'ordered', label: 'Ordered', type: 'number' },
      { key: 'order_value', label: 'Order value', type: 'money', total: true }, { key: 'dispatched', label: 'Dispatched', type: 'number' }, { key: 'invoiced', label: 'Invoiced', type: 'number' },
      { key: 'invoiced_taxable', label: 'Invoiced (taxable)', type: 'money', total: true }] },
  { key: 'DISPATCH', title: 'Dispatch Report', group: 'Sales', description: 'Dispatched consignments per line with vehicle and invoicing status.',
    filters: ['date', 'customer', 'product'], columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Dispatch' }, { key: 'order_number', label: 'Order' }, { key: 'customer', label: 'Customer' },
      { key: 'sku', label: 'SKU' }, { key: 'quantity', label: 'Quantity', type: 'number' }, { key: 'unit', label: 'Unit' }, { key: 'vehicle', label: 'Vehicle' },
      { key: 'status', label: 'Status' }, { key: 'invoiced', label: 'Invoiced', type: 'bool' }] },
  { key: 'INVOICE_REGISTER', title: 'Sales Invoice Register', group: 'Invoicing & payments', description: 'Issued and cancelled invoices with tax, payments and balance.',
    filters: ['date', 'customer', 'product'], link: id('id', '/billing/invoices/'), columns: [
      { key: 'invoice_number', label: 'Invoice' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'gstin', label: 'GSTIN' },
      { key: 'taxable', label: 'Taxable', type: 'money', total: true }, { key: 'cgst', label: 'CGST', type: 'money', total: true }, { key: 'sgst', label: 'SGST', type: 'money', total: true },
      { key: 'igst', label: 'IGST', type: 'money', total: true }, { key: 'grand_total', label: 'Total', type: 'money', total: true }, { key: 'paid', label: 'Paid', type: 'money', total: true },
      { key: 'balance', label: 'Balance', type: 'money', total: true }, { key: 'status', label: 'Status' }, { key: 'due_date', label: 'Due', type: 'date' }] },
  { key: 'GST_SUMMARY', title: 'GST Summary', group: 'Invoicing & payments', description: 'Taxable value and tax by HSN and rate for invoices, credit notes and debit notes. For your records; nothing is filed.',
    filters: ['date', 'customer', 'product'], columns: [
      { key: 'document', label: 'Document' }, { key: 'hsn_sac', label: 'HSN/SAC' }, { key: 'gst_rate', label: 'GST %', type: 'number' },
      { key: 'taxable', label: 'Taxable', type: 'money' }, { key: 'cgst', label: 'CGST', type: 'money' }, { key: 'sgst', label: 'SGST', type: 'money' },
      { key: 'igst', label: 'IGST', type: 'money' }, { key: 'total', label: 'Total', type: 'money' }] },
  { key: 'CUSTOMER_OUTSTANDING', title: 'Customer Outstanding Report', group: 'Invoicing & payments', description: 'Open invoice balances, overdue amounts and the ledger balance (opening + invoices + debit notes − credit notes − payments).',
    filters: ['customer'], link: id('party_id', '/ledger/'), columns: [
      { key: 'party_code', label: 'Code' }, { key: 'customer', label: 'Customer' }, { key: 'open_invoices', label: 'Open invoices', type: 'number', total: true },
      { key: 'invoice_outstanding', label: 'Invoice outstanding', type: 'money', total: true }, { key: 'overdue', label: 'Overdue', type: 'money', total: true },
      { key: 'receivable', label: 'Ledger balance', type: 'money', total: true }] },
  { key: 'SUPPLIER_OUTSTANDING', title: 'Supplier Outstanding Report', group: 'Invoicing & payments', description: 'Goods accepted on GRNs minus payments made (plus opening balance). Purchase orders are not payables.',
    filters: ['supplier'], link: id('party_id', '/ledger/'), columns: [
      { key: 'party_code', label: 'Code' }, { key: 'supplier', label: 'Supplier' }, { key: 'received_value', label: 'Goods received', type: 'money', total: true },
      { key: 'paid', label: 'Paid', type: 'money', total: true }, { key: 'payable', label: 'Outstanding', type: 'money', total: true }] },
  { key: 'PAYMENT_COLLECTION', title: 'Payment Collection Report', group: 'Invoicing & payments', description: 'Customer receipts in the period, with the invoices they were applied to. Reversed receipts are marked.',
    filters: ['date', 'customer'], columns: [
      { key: 'receipt_number', label: 'Receipt' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'customer', label: 'Customer' }, { key: 'method', label: 'Mode' },
      { key: 'reference', label: 'Reference' }, { key: 'amount', label: 'Amount', type: 'money', total: true }, { key: 'allocated', label: 'Applied', type: 'money', total: true },
      { key: 'invoices', label: 'Invoices' }, { key: 'status', label: 'Status' }] },
]

export const findReport = (key: string | undefined) => REPORTS.find((r) => r.key === (key ?? '').toUpperCase())

/** Column totals (only columns marked total; reversed receipts and cancelled invoices are left out of money totals). */
export function reportTotals(def: ReportDef, rows: Record<string, unknown>[]): Record<string, number> {
  const counted = rows.filter((r) => r.status !== 'REVERSED' && r.status !== 'CANCELLED')
  const out: Record<string, number> = {}
  for (const c of def.columns.filter((c) => c.total)) {
    out[c.key] = Math.round(counted.reduce((s, r) => s + (Number(r[c.key]) || 0), 0) * 100) / 100
  }
  return out
}

/** Cell text for Excel and print (numbers stay numbers for Excel). */
export function cellValue(c: ReportColumn, v: unknown): string | number {
  if (v === null || v === undefined || v === '') return ''
  if (c.type === 'bool') return v === true || v === 'true' ? 'Yes' : 'No'
  if (c.type === 'number' || c.type === 'money' || c.type === 'percent') return Number(v)
  return String(v)
}

export function reportSheet(def: ReportDef, rows: Record<string, unknown>[]): (string | number)[][] {
  const totals = reportTotals(def, rows)
  const out: (string | number)[][] = [def.columns.map((c) => c.label), ...rows.map((r) => def.columns.map((c) => cellValue(c, r[c.key])))]
  if (Object.keys(totals).length) out.push(def.columns.map((c, i) => (i === 0 ? 'Total' : c.key in totals ? totals[c.key] : '')))
  return out
}

/** Quantities per unit, never added across units: "8 PCS · 50 KG". */
export function unitsText(list: { unit: string; quantity: number | string }[] | null | undefined, empty = '0'): string {
  const parts = (list ?? []).filter((u) => Number(u.quantity) !== 0).map((u) => `${Number(Number(u.quantity).toFixed(3))} ${u.unit}`)
  return parts.length ? parts.join(' · ') : empty
}

export const ACTIVITY_LABELS: Record<string, string> = {
  PRODUCT_CREATED: 'Product created', PRODUCT_UPDATED: 'Product updated', BOM_UPDATED: 'BOM updated', SUPPLIER_ADDED: 'Supplier added',
  CUSTOMER_ADDED: 'Customer added', PURCHASE_ORDER_CREATED: 'Purchase order created', GOODS_RECEIVED: 'Goods received', GOODS_RECEIPT_REVERSED: 'Goods receipt reversed',
  PRODUCTION_STARTED: 'Production started', PRODUCTION_COMPLETED: 'Production completed', PRODUCTION_CORRECTED: 'Production corrected',
  SALES_ORDER_CREATED: 'Sales order created', STOCK_RESERVED: 'Stock reserved', STOCK_DISPATCHED: 'Stock dispatched', INVOICE_CREATED: 'Invoice created',
  PAYMENT_RECEIVED: 'Payment received', PAYMENT_REVERSED: 'Payment reversed', STOCK_ADJUSTED: 'Stock adjusted', STOCK_REVERSED: 'Stock movement reversed',
}

/** Correction history = the activity types that undo or change an earlier record. */
export const CORRECTION_TYPES = ['GOODS_RECEIPT_REVERSED', 'PRODUCTION_CORRECTED', 'PAYMENT_REVERSED', 'STOCK_REVERSED', 'STOCK_ADJUSTED']
