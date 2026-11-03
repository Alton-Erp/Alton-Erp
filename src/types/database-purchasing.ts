/**
 * Supplier purchase order and goods receipt types, merged into `Database` in
 * ./database.ts. Mirrors supabase/migrations/20261022090100_purchase_orders.sql.
 * Clients only read these; every change goes through RPCs (src/services/purchasing.ts).
 */
import type { Json } from './database'

export type PoStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED'
export type PoTaxTreatment = 'INTRA_STATE' | 'INTER_STATE' | 'NO_GST' | 'IMPORT' | 'UNRESOLVED'
export type PoLineType = 'GOODS' | 'SERVICE' | 'CHARGE'
export type PurchaseType = 'RAW_MATERIAL' | 'FINISHED_GOODS' | 'PACKAGING' | 'MACHINERY' | 'SERVICES' | 'OTHER'
export type PoPaymentTerms = 'IMMEDIATE' | 'DAYS_7' | 'DAYS_15' | 'DAYS_30' | 'DAYS_45' | 'CUSTOM'

type ReadOnly<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }

export type PurchaseOrderRow = {
  id: string
  company_id: string
  po_number: string
  revision: number
  status: PoStatus
  supplier_id: string
  supplier_code: string
  supplier_name: string
  supplier_gstin: string | null
  supplier_pan: string | null
  supplier_state_code: string | null
  supplier_country: string
  supplier_billing_address: string | null
  supplier_shipping_address: string | null
  supplier_contact_person: string | null
  supplier_email: string | null
  supplier_phone: string | null
  buyer_legal_name: string | null
  buyer_address: string | null
  buyer_gstin: string | null
  place_of_supply_state_code: string | null
  tax_treatment: PoTaxTreatment
  po_date: string
  expected_delivery_date: string | null
  warehouse_id: string | null
  warehouse_code: string | null
  warehouse_name: string | null
  delivery_address: string | null
  purchase_type: PurchaseType
  currency_code: string
  payment_terms: PoPaymentTerms
  custom_payment_days: number | null
  payment_terms_overridden: boolean
  reference_number: string | null
  delivery_instructions: string | null
  internal_notes: string | null
  purchase_conditions: string | null
  gross_total: number
  discount_total: number
  taxable_total: number
  other_charges_total: number
  cgst_total: number
  sgst_total: number
  igst_total: number
  round_off: number
  grand_total: number
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  rejected_by: string | null
  rejected_at: string | null
  rejection_reason: string | null
  sent_by: string | null
  sent_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  cancel_reason: string | null
  closed_by: string | null
  closed_at: string | null
  close_reason: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type PurchaseOrderListRow = PurchaseOrderRow & {
  line_count: number
  total_ordered_quantity: number
  total_received_quantity: number
  total_accepted_quantity: number
  total_pending_quantity: number
  pending_value: number
  skus: string
  product_ids: string[]
  receipt_count: number
  // purchase_order_list_v2: supplier references (order level, and of the posted receipts)
  supplier_invoice_number?: string | null
  supplier_challan_number?: string | null
  receipt_invoice_numbers?: string | null
  receipt_challan_numbers?: string | null
}

export type PurchaseOrderLineRow = {
  id: string
  company_id: string
  purchase_order_id: string
  line_no: number
  line_type: PoLineType
  product_id: string | null
  sku: string | null
  description: string
  hsn_sac: string | null
  unit: string
  ordered_quantity: number
  unit_price: number | null
  master_cost_snapshot: number | null
  discount_percent: number | null
  discount_value_input: number
  gross_amount: number
  discount_amount: number
  taxable_value: number
  gst_rate: number | null
  cgst_rate: number
  sgst_rate: number
  igst_rate: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  line_total: number
  created_at: string
  updated_at: string
}

export type PurchaseOrderLineListRow = PurchaseOrderLineRow & {
  received_quantity: number
  accepted_quantity: number
  rejected_quantity: number
  pending_quantity: number
  pending_value: number
}

export type PurchaseOrderEventRow = {
  id: string
  company_id: string
  purchase_order_id: string
  event_type: string
  from_status: string | null
  to_status: string | null
  note: string | null
  details: Json
  actor_user_id: string | null
  created_at: string
}

export type PurchaseOrderAmendmentRow = {
  id: string
  company_id: string
  purchase_order_id: string
  from_revision: number
  to_revision: number
  reason: string
  previous_version: Json
  created_by: string | null
  created_at: string
}

export type GoodsReceiptRow = {
  id: string
  company_id: string
  receipt_number: string
  /** PURCHASE_ORDER = against an order; DIRECT = received without a purchase order (unlinked). */
  receipt_type: 'PURCHASE_ORDER' | 'DIRECT'
  purchase_order_id: string | null
  po_revision: number | null
  supplier_id: string | null
  warehouse_id: string | null
  /** The (reversed) receipt this one corrects. */
  corrects_receipt_id: string | null
  receipt_date: string
  supplier_document_number: string | null
  supporting_document_ref: string | null
  notes: string | null
  status: 'POSTED' | 'REVERSED'
  reversal_transaction_ids: string[] | null
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  created_by: string | null
  created_at: string
}

export type GoodsReceiptListRow = GoodsReceiptRow & {
  po_number: string | null
  supplier_name: string | null
  supplier_code: string | null
  warehouse_code: string | null
  line_count: number
  total_received: number
  total_accepted: number
  total_rejected: number
  // goods_receipt_list_v2: this receipt's own supplier references
  supplier_invoice_number?: string | null
  supplier_challan_number?: string | null
}

export type GoodsReceiptLineRow = {
  id: string
  company_id: string
  goods_receipt_id: string
  purchase_order_id: string | null
  purchase_order_line_id: string | null
  line_type: 'GOODS' | 'SERVICE'
  product_id: string | null
  unit: string
  received_quantity: number
  accepted_quantity: number
  rejected_quantity: number
  inspection_status: 'ACCEPTED' | 'PARTIALLY_ACCEPTED' | 'REJECTED'
  rejection_reason: string | null
  accepted_location_id: string | null
  rejected_location_id: string | null
  batch_id: string | null
  batch_number: string | null
  manufacturing_date: string | null
  expiry_date: string | null
  serial_numbers: string | null
  unit_cost: number | null
  gst_rate: number | null
  /** Direct receipts: accepted x cost incl. GST. */
  line_value: number | null
  accepted_transaction_id: string | null
  rejected_transaction_id: string | null
  over_receipt_reason: string | null
  created_at: string
}

export type GoodsReceiptLineListRow = GoodsReceiptLineRow & {
  receipt_number: string
  receipt_date: string
  receipt_status: 'POSTED' | 'REVERSED'
  supplier_document_number: string | null
  po_line_no: number | null
  sku: string | null
  description: string
  ordered_quantity: number | null
  accepted_location_code: string | null
  rejected_location_code: string | null
  accepted_transaction_number: string | null
  rejected_transaction_number: string | null
}

export type PurchasingTables = {
  purchase_orders: ReadOnly<PurchaseOrderRow>
  purchase_order_lines: ReadOnly<PurchaseOrderLineRow>
  purchase_order_events: ReadOnly<PurchaseOrderEventRow>
  purchase_order_amendments: ReadOnly<PurchaseOrderAmendmentRow>
  goods_receipts: ReadOnly<GoodsReceiptRow>
  goods_receipt_lines: ReadOnly<GoodsReceiptLineRow>
}

export type PurchasingViews = {
  purchase_order_list: { Row: PurchaseOrderListRow; Relationships: [] }
  purchase_order_line_list: { Row: PurchaseOrderLineListRow; Relationships: [] }
  goods_receipt_list: { Row: GoodsReceiptListRow; Relationships: [] }
  goods_receipt_line_list: { Row: GoodsReceiptLineListRow; Relationships: [] }
  // The lists plus the supplier invoice / challan references (20261109090000).
  purchase_order_list_v2: { Row: PurchaseOrderListRow; Relationships: [] }
  goods_receipt_list_v2: { Row: GoodsReceiptListRow; Relationships: [] }
}
