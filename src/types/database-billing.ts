/**
 * Phase 8 billing types, merged into `Database` in ./database.ts. Mirrors
 * supabase/migrations/20261016*.sql. All tables are read-only for clients;
 * every change goes through RPCs (src/services/billing.ts). Amounts arrive from
 * PostgREST as numbers (numeric); the database is the only place they are
 * calculated.
 */
import type { Json } from './database'

export type InvoiceStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ISSUED' | 'CANCELLED' | 'DISCARDED'
export type InvoiceDisplayStatus = InvoiceStatus | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE'
export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID'
export type SupplyCategory = 'TAXABLE' | 'EXEMPT' | 'ZERO_RATED' | 'NON_GST'
export type TaxTreatment = 'INTRA_STATE' | 'INTER_STATE' | 'NONE' | 'UNRESOLVED'
export type NoteType = 'CREDIT' | 'DEBIT'
export type NoteStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'ISSUED' | 'CANCELLED' | 'DISCARDED'
export type NoteReason = 'SALES_RETURN' | 'QUALITY_ISSUE' | 'PRICE_CORRECTION' | 'SHORT_SUPPLY' | 'COMMERCIAL_ADJUSTMENT' | 'ADDITIONAL_CHARGE' | 'OTHER'
export type PaymentMethod = 'BANK_TRANSFER' | 'UPI' | 'CHEQUE' | 'CASH' | 'CARD' | 'DEMAND_DRAFT' | 'OTHER'

type ReadOnly<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }

export type InvoiceSettingsRow = {
  company_id: string
  gst_registered: boolean
  seller_pan: string | null
  invoice_prefix: string
  credit_note_prefix: string
  debit_note_prefix: string
  receipt_prefix: string
  include_fy_in_number: boolean
  number_padding: number
  fy_start_month: number
  default_payment_terms_days: number
  billing_basis: 'DISPATCH' | 'DELIVERY'
  allow_partial_dispatch_invoicing: boolean
  allow_line_discount: boolean
  require_approval: boolean
  round_off_enabled: boolean
  other_charge_enabled: boolean
  other_charge_label: string | null
  other_charge_sac: string | null
  other_charge_gst_rate: number | null
  allowed_special_categories: string[]
  payment_methods: PaymentMethod[]
  terms_text: string | null
  footer_text: string | null
  bank_account_name: string | null
  bank_name: string | null
  bank_account_number: string | null
  bank_ifsc: string | null
  bank_branch: string | null
  show_bank_details: boolean
  e_invoice_status: 'NOT_CONFIGURED'
  updated_by: string | null
  updated_at: string
  // Stage 6 (20261107090000_invoicing_v2.sql)
  pricing_mode: 'EXCLUSIVE' | 'INCLUSIVE'
  rounding_mode: 'NEAREST' | 'UP' | 'DOWN'
  gst_rates: number[]
  freight_sac: string | null
  freight_gst_rate: number
  packing_sac: string | null
  packing_gst_rate: number
  default_invoice_type: 'TAX_INVOICE' | 'PROFORMA'
  invoice_date_format: 'DD-MM-YYYY' | 'DD/MM/YYYY' | 'DD MMM YYYY' | 'YYYY-MM-DD'
  default_payment_method: PaymentMethod
  bank_accounts: BankAccount[]
  authorized_signatory: string | null
  invoice_template: 'CLASSIC' | 'COMPACT'
  show_logo: boolean
}

export type BankAccount = { label?: string | null; bank_name?: string | null; account_name?: string | null; account_number: string; ifsc: string; branch?: string | null; upi_id?: string | null }

export type SalesInvoiceRow = {
  id: string
  company_id: string
  invoice_number: string | null
  numbering_scope: string | null
  financial_year: string | null
  invoice_type: 'TAX_INVOICE' | 'BILL_OF_SUPPLY'
  invoice_date: string
  due_date: string | null
  payment_terms_days: number
  customer_id: string
  customer_code_snapshot: string
  customer_legal_name: string
  customer_billing_address: string | null
  customer_shipping_address: string | null
  customer_gstin: string | null
  customer_registration_type: string | null
  customer_billing_state_code: string | null
  customer_shipping_state_code: string | null
  seller_legal_name: string
  seller_address: string | null
  seller_gstin: string | null
  seller_pan: string | null
  seller_state_code: string | null
  place_of_supply_state_code: string | null
  supply_category: SupplyCategory
  special_category_reason: string | null
  tax_treatment: TaxTreatment
  order_references: string | null
  dispatch_references: string | null
  currency: string
  gross_total: number
  discount_total: number
  taxable_subtotal: number
  other_charges_total: number
  cgst_total: number
  sgst_total: number
  igst_total: number
  round_off: number
  grand_total: number
  status: InvoiceStatus
  notes: string | null
  internal_notes: string | null
  terms_snapshot: string | null
  footer_snapshot: string | null
  bank_snapshot: { account_name: string; bank_name: string | null; account_number: string; ifsc: string; branch: string | null } | null
  tax_review_note: string | null
  tax_review_by: string | null
  tax_review_at: string | null
  e_invoice_status: 'NOT_CONFIGURED'
  submitted_by: string | null
  submitted_at: string | null
  issued_by: string | null
  issued_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
  // Stage 6
  source: 'DISPATCH' | 'SALES_ORDER' | 'MANUAL' | 'IMPORT'
  sales_order_id: string | null
  is_proforma: boolean
  proforma_number: string | null
  pricing_mode: 'EXCLUSIVE' | 'INCLUSIVE'
  invoice_discount_percent: number | null
  invoice_discount_amount: number
  invoice_discount_total: number
  transport_details: string | null
  vehicle_number: string | null
  eway_bill_number: string | null
  customer_pan: string | null
}

export type SalesInvoiceListRow = SalesInvoiceRow & {
  credited: number
  debited: number
  paid: number
  balance_due: number | null
  payment_status: PaymentStatus | null
  display_status: InvoiceDisplayStatus
  days_overdue: number | null
  line_count: number
}

export type SalesInvoiceLineRow = {
  id: string
  company_id: string
  invoice_id: string
  line_no: number
  line_type: 'PRODUCT' | 'CHARGE'
  product_id: string | null
  sales_order_id: string | null
  sales_order_line_id: string | null
  fulfilment_line_id: string | null
  sku: string | null
  description: string
  hsn_sac: string | null
  unit: string | null
  quantity: number
  unit_price: number | null
  discount_percent: number
  discount_amount: number
  gross_amount: number
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
  charge_kind: 'FREIGHT' | 'PACKING' | 'OTHER' | null
  invoice_discount_share: number
}

export type InvoiceDispatchAllocationRow = {
  id: string
  company_id: string
  invoice_id: string
  invoice_line_id: string
  fulfilment_line_id: string
  quantity: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export type InvoiceableDispatchRow = {
  fulfilment_line_id: string
  company_id: string
  fulfilment_id: string
  fulfilment_number: string
  actual_dispatch_at: string
  fulfilment_status: string
  sales_order_id: string
  sales_order_number: string
  customer_id: string | null
  customer_name_snapshot: string
  customer_po_number: string | null
  order_currency: string | null
  sales_order_line_id: string
  order_line_no: number
  quantity_ordered: number
  order_line_dispatched: number
  unit_price_snapshot: number | null
  product_id: string
  sku: string
  product_name: string
  hsn_code: string | null
  gst_rate: number | null
  selling_price: number | null
  unit: string
  quantity_dispatched: number
  quantity_delivered: number
  quantity_returned: number
  quantity_invoiced: number
  quantity_invoiceable: number
}

export type CustomerPaymentRow = {
  id: string
  company_id: string
  receipt_number: string
  customer_id: string
  receipt_date: string
  amount_received: number
  currency: string
  payment_method: PaymentMethod
  transaction_reference: string | null
  bank_reference: string | null
  notes: string | null
  status: 'RECORDED' | 'REVERSED'
  verification_status: 'UNVERIFIED'
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  recorded_by: string | null
  created_at: string
}

export type CustomerPaymentListRow = CustomerPaymentRow & {
  customer_code: string
  customer_name: string
  allocated_amount: number
  unallocated_amount: number
  allocation_count: number
}

export type PaymentAllocationRow = {
  id: string
  company_id: string
  invoice_id: string
  payment_id: string
  allocated_amount: number
  allocation_date: string
  status: 'ACTIVE' | 'REVERSED'
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  created_by: string | null
  created_at: string
}

export type PaymentAllocationListRow = PaymentAllocationRow & {
  invoice_number: string | null
  invoice_date: string
  customer_id: string
  receipt_number: string
  receipt_date: string
  payment_method: PaymentMethod
}

export type AdjustmentNoteRow = {
  id: string
  company_id: string
  note_number: string | null
  numbering_scope: string | null
  financial_year: string | null
  note_type: NoteType
  customer_id: string
  original_invoice_id: string
  note_date: string
  reason_code: NoteReason
  reason: string
  supporting_reference: string | null
  customer_return_id: string | null
  tax_treatment: TaxTreatment
  taxable_amount: number
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  total_amount: number
  status: NoteStatus
  tax_review_note: string | null
  tax_review_by: string | null
  tax_review_at: string | null
  submitted_by: string | null
  submitted_at: string | null
  issued_by: string | null
  issued_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  cancellation_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type AdjustmentNoteListRow = AdjustmentNoteRow & {
  invoice_number: string | null
  invoice_date: string
  invoice_total: number
  customer_name: string
  customer_code: string
  return_number: string | null
  line_count: number
}

export type AdjustmentNoteLineRow = {
  id: string
  company_id: string
  note_id: string
  line_no: number
  invoice_line_id: string
  customer_return_line_id: string | null
  description: string
  hsn_sac: string | null
  quantity: number | null
  taxable_amount: number
  gst_rate: number | null
  cgst_amount: number
  sgst_amount: number
  igst_amount: number
  line_total: number
  created_at: string
}

export type BillingEventRow = {
  id: string
  company_id: string
  entity_type: 'INVOICE' | 'PAYMENT' | 'ALLOCATION' | 'NOTE' | 'SETTINGS'
  entity_id: string | null
  invoice_id: string | null
  event_type: string
  from_status: string | null
  to_status: string | null
  note: string | null
  details: Json
  actor_user_id: string | null
  created_at: string
}

export type BillingTables = {
  invoice_settings: ReadOnly<InvoiceSettingsRow>
  sales_invoices: ReadOnly<SalesInvoiceRow>
  sales_invoice_lines: ReadOnly<SalesInvoiceLineRow>
  sales_invoice_dispatch_allocations: ReadOnly<InvoiceDispatchAllocationRow>
  customer_payments: ReadOnly<CustomerPaymentRow>
  invoice_payment_allocations: ReadOnly<PaymentAllocationRow>
  invoice_adjustment_notes: ReadOnly<AdjustmentNoteRow>
  invoice_adjustment_note_lines: ReadOnly<AdjustmentNoteLineRow>
  billing_events: ReadOnly<BillingEventRow>
}

export type BillingViews = {
  sales_invoice_list: { Row: SalesInvoiceListRow; Relationships: [] }
  invoiceable_dispatch_list: { Row: InvoiceableDispatchRow; Relationships: [] }
  customer_payment_list: { Row: CustomerPaymentListRow; Relationships: [] }
  invoice_payment_allocation_list: { Row: PaymentAllocationListRow; Relationships: [] }
  adjustment_note_list: { Row: AdjustmentNoteListRow; Relationships: [] }
}
