import type { SourceKey } from './drill-registry'

export type ColumnKind = 'text' | 'date' | 'datetime' | 'money' | 'number' | 'status' | 'bool'

export interface DrillColumn {
  key: string
  label: string
  kind?: ColumnKind
  /** Shown by default (others can be switched on). */
  visible?: boolean
  /** Server-side sorting (columns of the view). */
  sortable?: boolean
  /** Value from a nested field (RPC rows). */
  get?: (row: Record<string, unknown>) => unknown
  /** Text shown (and exported) when the value is empty, instead of a dash. */
  empty?: (row: Record<string, unknown>) => string | null
  /** Short note after the formatted value (screen only). */
  note?: (row: Record<string, unknown>) => string | null
}

const c = (key: string, label: string, kind: ColumnKind = 'text', visible = true, sortable = true): DrillColumn => ({ key, label, kind, visible, sortable })

const unitsText = (row: Record<string, unknown>, field: 'ordered' | 'dispatched' | 'reserved') => {
  const list = Array.isArray(row.units) ? (row.units as Record<string, unknown>[]) : []
  return list.map((u) => `${Number(u[field] ?? 0)} ${u.unit}`).join(', ')
}

/** Stock on hand with no lot cost (the stock reports never value it at zero). */
const notValued = (r: Record<string, unknown>) => (Number(r.on_hand ?? 0) > 0 ? 'Not Valued' : null)

/** Columns of each list, in the order shown. */
export const COLUMNS: Record<SourceKey, DrillColumn[]> = {
  products: [c('sku', 'SKU'), c('product_name', 'Product'), c('product_type', 'Type', 'status'), c('default_source_type', 'Source', 'status'), c('status', 'Status', 'status'),
    c('base_unit', 'Unit'), c('hsn_code', 'HSN', 'text', false), c('standard_cost', 'Standard cost', 'money', false), c('selling_price', 'Selling price', 'money', false),
    c('has_bom', 'BOM', 'bool', false), c('created_at', 'Created', 'datetime'), c('updated_at', 'Updated', 'datetime', false)],
  product_stock: [c('sku', 'SKU'), c('product_name', 'Product'), c('category_name', 'Category'), c('product_type', 'Type', 'status', false), c('base_unit', 'Unit'),
    c('on_hand', 'On hand', 'number'), c('reserved', 'Reserved', 'number'), c('available', 'Available', 'number'), c('reorder_level', 'Reorder level', 'number', false),
    c('in_house_on_hand', 'In-house', 'number', false), c('outsourced_on_hand', 'Outsourced', 'number', false), c('stock_status', 'Stock status', 'status'),
    c('last_movement_at', 'Last movement', 'datetime', false)],
  // Total Stock: valuation from inventory_product_stock_value. No cost is shown as "Not Valued", never ₹0.
  product_stock_value: [c('sku', 'SKU'), c('product_name', 'Product'), c('category_name', 'Category'), c('product_type', 'Type', 'status', false), c('base_unit', 'Unit'),
    c('on_hand', 'On hand', 'number'), c('reserved', 'Reserved', 'number'), c('available', 'Available', 'number'),
    { ...c('unit_cost', 'Unit Cost (₹)', 'money'), empty: notValued },
    { ...c('stock_value', 'Total Stock Value (₹)', 'money'), empty: notValued, note: (r) => (r.valuation_status === 'PARTIAL' ? 'part valued' : null) },
    c('stock_status', 'Stock status', 'status'), c('valuation_status', 'Valuation', 'status', false), c('unvalued_on_hand', 'Quantity not valued', 'number', false),
    c('reorder_level', 'Reorder level', 'number', false), c('in_house_on_hand', 'In-house', 'number', false), c('outsourced_on_hand', 'Outsourced', 'number', false),
    c('last_movement_at', 'Last movement', 'datetime', false)],
  stock_detail: [c('sku', 'SKU'), c('product_name', 'Product'), c('warehouse_code', 'Warehouse'), c('location_code', 'Location'), c('batch_number', 'Lot / batch'),
    c('source_type', 'Source', 'status', false), c('base_unit', 'Unit'), c('on_hand', 'On hand', 'number'), c('reserved', 'Reserved', 'number'), c('available', 'Available', 'number'),
    c('last_movement_at', 'Last movement', 'datetime', false)],
  movements: [c('transaction_date', 'Date', 'datetime'), c('transaction_number', 'Number'), c('transaction_type', 'Type', 'status'), c('sku', 'SKU'), c('product_name', 'Product'),
    c('quantity_in', 'In', 'number'), c('quantity_out', 'Out', 'number'), c('unit', 'Unit'), c('warehouse_code', 'Warehouse'), c('location_code', 'Location', 'text', false),
    c('reference_number', 'Reference'), c('reason', 'Reason', 'text', false)],
  purchase_orders: [c('po_number', 'PO number'), c('po_date', 'Date', 'date'), c('supplier_name', 'Supplier'), c('status', 'Status', 'status'),
    c('expected_delivery_date', 'Expected', 'date'), c('grand_total', 'Value', 'money'), c('pending_value', 'Pending value', 'money'), c('warehouse_code', 'Warehouse', 'text', false),
    c('reference_number', 'Reference', 'text', false), c('receipt_count', 'GRNs', 'number', false)],
  grns: [c('receipt_number', 'GRN'), c('receipt_date', 'Date', 'date'), c('supplier_name', 'Supplier'), c('po_number', 'PO'), c('receipt_type', 'Type', 'status'),
    c('status', 'Status', 'status'), c('total_accepted', 'Accepted', 'number'), c('total_rejected', 'Rejected', 'number'), c('supplier_document_number', 'Supplier document', 'text', false),
    c('warehouse_code', 'Warehouse', 'text', false)],
  grn_lines: [c('receipt_number', 'GRN'), c('receipt_date', 'Date', 'date'), c('sku', 'SKU'), c('description', 'Description'), c('unit', 'Unit'),
    c('received_quantity', 'Received', 'number'), c('accepted_quantity', 'Accepted', 'number'), c('rejected_quantity', 'Rejected', 'number'), c('rejection_reason', 'Reason')],
  production_orders: [c('production_order_number', 'Order'), c('sku', 'SKU'), c('product_name', 'Product'), c('status', 'Status', 'status'), c('unit', 'Unit'),
    c('planned_quantity', 'Planned', 'number'), c('actual_quantity', 'Produced', 'number'), c('planned_start_date', 'Planned start', 'date'),
    c('target_completion_date', 'Target', 'date', false), c('actual_completion_date', 'Completed', 'date', false), c('bom_code', 'BOM', 'text', false)],
  production_outputs: [c('receipt_number', 'Receipt'), c('production_date', 'Date', 'date'), c('production_order_number', 'Order'), c('sku', 'SKU'), c('product_name', 'Product'),
    c('unit', 'Unit'), c('good_quantity', 'Good', 'number'), c('rejected_quantity', 'Rejected', 'number'), c('scrap_quantity', 'Scrap', 'number', false), c('status', 'Status', 'status', false)],
  production_consumption: [c('consumption_date', 'Date', 'date'), c('production_order_number', 'Order'), c('sku', 'SKU'), c('product_name', 'Material'), c('unit', 'Unit'),
    c('planned_quantity', 'Planned', 'number'), c('actual_quantity', 'Consumed', 'number'), c('warehouse_code', 'Warehouse', 'text', false), c('transaction_number', 'Transaction', 'text', false)],
  invoices: [{ ...c('invoice_number', 'Invoice'), get: (r) => r.invoice_number ?? r.proforma_number ?? '(draft)' }, c('invoice_date', 'Date', 'date'),
    c('customer_legal_name', 'Customer'), c('status', 'Status', 'status'), c('payment_status', 'Payment', 'status'), c('due_date', 'Due', 'date', false),
    c('taxable_subtotal', 'Taxable', 'money', false), { ...c('cgst_total', 'GST', 'money', false), get: (r) => Number(r.cgst_total ?? 0) + Number(r.sgst_total ?? 0) + Number(r.igst_total ?? 0), sortable: false },
    c('grand_total', 'Total', 'money'), c('paid', 'Received', 'money', false), c('balance_due', 'Balance', 'money')],
  payments: [c('receipt_number', 'Receipt'), c('receipt_date', 'Date', 'date'), c('customer_name', 'Customer'), c('payment_method', 'Method', 'status'),
    c('amount_received', 'Amount', 'money'), c('allocated_amount', 'Allocated', 'money', false), c('unallocated_amount', 'Unallocated', 'money', false), c('status', 'Status', 'status')],
  sales_orders_view: [c('sales_order_number', 'Order'), c('order_date', 'Date', 'date'), c('customer_name_snapshot', 'Customer'), c('order_status', 'Status', 'status'),
    c('grand_total', 'Value', 'money'), c('requested_delivery_date', 'Delivery', 'date', false), c('customer_reference', 'Customer ref.', 'text', false)],
  sales_orders: [c('sales_order_number', 'Order'), c('order_date', 'Date', 'date'), c('customer_name', 'Customer'), c('status', 'Status', 'status'), c('grand_total', 'Value', 'money'),
    { ...c('ordered', 'Ordered'), get: (r) => unitsText(r, 'ordered'), sortable: false }, { ...c('dispatched', 'Dispatched'), get: (r) => unitsText(r, 'dispatched'), sortable: false },
    { ...c('reserved', 'Reserved'), get: (r) => unitsText(r, 'reserved'), sortable: false, visible: false }, c('customer_reference', 'Customer ref.', 'text', false)],
  parties: [c('party_code', 'Code'), c('party_name', 'Name'), c('party_type', 'Type', 'status'), c('status', 'Status', 'status'), c('gstin', 'GSTIN', 'text', false),
    c('city', 'City', 'text', false), c('receivable', 'Receivable', 'money'), c('payable', 'Payable', 'money'), c('overdue', 'Overdue', 'money', false), c('last_activity', 'Last activity', 'date', false)],
  production_shortages: [c('sku', 'SKU'), c('product_name', 'Material'), c('unit', 'Unit'), c('needed', 'Still to issue', 'number'), c('reserved', 'Reserved', 'number'),
    c('available', 'Free stock', 'number'), c('shortage', 'Shortage', 'number'), c('orders', 'Orders', 'number')],
  sales_shortages: [c('sku', 'SKU'), c('product_name', 'Material'), c('unit', 'Unit'), c('required', 'Required', 'number'), c('reserved', 'Reserved', 'number'),
    c('available', 'Available', 'number'), c('shortage', 'Shortage', 'number'), c('preferred_supplier_name', 'Preferred supplier', 'text', false), c('orders', 'Orders', 'number')],
}

const id = (r: Record<string, unknown>, k: string) => (typeof r[k] === 'string' && r[k] ? encodeURIComponent(r[k] as string) : null)
const to = (path: string, value: string | null) => (value ? path.replace(':id', value) : null)

/** The original record of a row. */
export const RECORD_LINK: Record<SourceKey, (row: Record<string, unknown>) => string | null> = {
  products: (r) => to('/products/:id', id(r, 'id')),
  product_stock: (r) => to('/inventory/stock/:id', id(r, 'product_id')),
  product_stock_value: (r) => to('/inventory/stock/:id', id(r, 'product_id')),
  stock_detail: (r) => to('/inventory/stock/:id', id(r, 'product_id')),
  movements: (r) => to('/inventory/stock/:id', id(r, 'product_id')),
  purchase_orders: (r) => to('/purchase-orders/:id', id(r, 'id')),
  grns: (r) => to('/goods-receipts/:id', id(r, 'id')),
  grn_lines: (r) => to('/goods-receipts/:id', id(r, 'goods_receipt_id')),
  production_orders: (r) => to('/production/orders/:id', id(r, 'id')),
  production_outputs: (r) => to('/production/orders/:id', id(r, 'production_order_id')),
  production_consumption: (r) => to('/production/orders/:id', id(r, 'production_order_id')),
  invoices: (r) => to('/billing/invoices/:id', id(r, 'id')),
  payments: (r) => to('/billing/payments?receipt=:id', id(r, 'id')),
  sales_orders_view: (r) => to('/sales/orders/:id', id(r, 'id')),
  sales_orders: (r) => to('/sales/orders/:id', id(r, 'id')),
  parties: (r) => to('/ledger/:id', id(r, 'party_id')),
  production_shortages: (r) => to('/inventory/stock/:id', id(r, 'component_product_id')),
  sales_shortages: (r) => to('/inventory/stock/:id', id(r, 'product_id')),
}

/** The module's own list (full features: actions, imports, etc.). */
export const MODULE_LIST: Record<SourceKey, { label: string; path: string }> = {
  products: { label: 'Product Master', path: '/products' },
  product_stock: { label: 'Stock Register', path: '/inventory/stock' },
  product_stock_value: { label: 'Stock Register', path: '/inventory/stock' },
  stock_detail: { label: 'Stock Register', path: '/inventory/stock' },
  movements: { label: 'Stock Movements', path: '/inventory/movements' },
  purchase_orders: { label: 'Purchase Orders', path: '/purchase-orders' },
  grns: { label: 'Goods Received', path: '/goods-receipts' },
  grn_lines: { label: 'Goods Received', path: '/goods-receipts' },
  production_orders: { label: 'Production Orders', path: '/production/orders' },
  production_outputs: { label: 'Finished Goods Receipts', path: '/production/receipts' },
  production_consumption: { label: 'Material Consumption', path: '/production/consumption' },
  invoices: { label: 'Invoices', path: '/billing/invoices' },
  payments: { label: 'Payments', path: '/billing/payments' },
  sales_orders_view: { label: 'Sales Orders', path: '/sales/orders' },
  sales_orders: { label: 'Sales Orders', path: '/sales/orders' },
  parties: { label: 'Ledger', path: '/ledger' },
  production_shortages: { label: 'Production Dashboard', path: '/production' },
  sales_shortages: { label: 'Sales Dashboard', path: '/sales/dashboard' },
}

/** Every column has a label and every source has columns (unit-tested). */
export const columnValue = (col: DrillColumn, row: Record<string, unknown>) => (col.get ? col.get(row) : row[col.key])
