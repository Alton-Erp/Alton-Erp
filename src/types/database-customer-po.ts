/**
 * Phase 6 customer PO and customer types, merged into `Database` in
 * ./database.ts. Mirrors supabase/migrations/20261014*_customer*.sql.
 * Customers are written directly (RLS + column grants); everything else is
 * read-only for clients and changed through RPCs (src/services/customer-po.ts).
 */
import type { Json } from './database'
import type { ReservationRow } from './database-inventory'

export type PoStatus =
  | 'DRAFT'
  | 'UPLOADED'
  | 'VALIDATION_REQUIRED'
  | 'PRODUCT_MATCHING_REQUIRED'
  | 'READY_FOR_ALLOCATION'
  | 'PARTIALLY_ALLOCATED'
  | 'FULLY_ALLOCATED'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILLED'
  | 'ON_HOLD'
  | 'CANCELLED'
export type PoLineStatus = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS' | 'INVALID' | 'DUPLICATE_REVIEW' | 'EXCLUDED'
export type AllocationStrategy = 'IN_HOUSE_FIRST' | 'OUTSOURCED_FIRST' | 'EARLIEST_BATCH' | 'WAREHOUSE_PRIORITY' | 'MANUAL'

type ReadOnly<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }

export type CustomerRow = {
  id: string
  company_id: string
  customer_code: string
  customer_name: string
  contact_email: string | null
  status: 'ACTIVE' | 'INACTIVE'
  notes: string | null
  /** Billing identity (Phase 8). */
  legal_name: string | null
  gstin: string | null
  gst_registration_type: GstRegistrationType | null
  pan: string | null
  billing_address: string | null
  billing_state_code: string | null
  shipping_address: string | null
  shipping_state_code: string | null
  payment_terms_days: number | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type GstRegistrationType = 'REGISTERED' | 'COMPOSITION' | 'UNREGISTERED' | 'CONSUMER' | 'SEZ' | 'OVERSEAS'

export type CustomerBillingFields = Pick<CustomerRow, 'legal_name' | 'gstin' | 'gst_registration_type' | 'pan' | 'billing_address' | 'billing_state_code'
  | 'shipping_address' | 'shipping_state_code' | 'payment_terms_days'>

export type CustomerProductCodeRow = {
  id: string
  company_id: string
  customer_id: string
  customer_sku: string
  product_id: string
  verified_by: string | null
  created_at: string
}

export type PoImportBatchRow = {
  id: string
  company_id: string
  file_name: string
  file_hash: string | null
  file_size: number | null
  sheet_name: string | null
  rows_read: number
  valid_rows: number
  invalid_rows: number
  matched_rows: number
  unmatched_rows: number
  validation_status: 'VALID' | 'VALID_WITH_REJECTED_ROWS' | 'INVALID'
  import_status: 'IMPORTED' | 'REJECTED'
  error_summary: Json
  uploaded_by: string | null
  uploaded_at: string
}

export type CustomerPoRow = {
  id: string
  company_id: string
  po_reference: string
  customer_id: string | null
  customer_name_snapshot: string
  customer_key: string
  customer_po_number: string
  revision: number
  previous_revision_id: string | null
  is_current: boolean
  po_date: string
  required_delivery_date: string | null
  currency: string | null
  fulfilment_warehouse_id: string | null
  status: PoStatus
  status_before_hold: PoStatus | null
  hold_reason: string | null
  cancel_reason: string | null
  source_filename: string | null
  file_hash: string | null
  import_batch_id: string | null
  notes: string | null
  uploaded_by: string | null
  reviewed_by: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  last_analysis_at: string | null
  created_at: string
  updated_at: string
}

export type CustomerPoListRow = CustomerPoRow & {
  customer_code: string | null
  fulfilment_warehouse_code: string | null
  line_count: number
  unmatched_lines: number
  review_lines: number
  unit_totals: { unit: string; ordered: number; dispatched: number; allocated: number }[] | null
}

export type CustomerPoLineRow = {
  id: string
  company_id: string
  purchase_order_id: string
  line_no: number
  source_row_number: number
  uploaded_sku: string | null
  uploaded_customer_sku: string | null
  uploaded_barcode: string | null
  uploaded_description: string | null
  uploaded_quantity: number
  uploaded_unit: string | null
  product_id: string | null
  quantity_ordered: number
  unit: string | null
  unit_price: number | null
  currency: string | null
  tax_rate: number | null
  hsn_code: string | null
  remarks: string | null
  line_status: PoLineStatus
  status_reason: string | null
  matching_method: string | null
  match_note: string | null
  candidate_product_ids: string[]
  matched_by: string | null
  matched_at: string | null
  flagged_for_new_product: boolean
  duplicate_of_line_id: string | null
  duplicate_confirmed: boolean
  quantity_dispatched: number
  shortage_status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED'
  shortage_priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
  shortage_owner: string | null
  created_at: string
  updated_at: string
}

export type CustomerPoLineListRow = CustomerPoLineRow & {
  po_reference: string
  customer_po_number: string
  revision: number
  customer_name_snapshot: string
  po_status: PoStatus
  is_current: boolean
  sku: string | null
  product_name: string | null
  base_unit: string | null
  product_status: string | null
  category_name: string | null
  allocated_open: number
}

export type PoEventRow = {
  id: string
  company_id: string
  purchase_order_id: string
  line_id: string | null
  event_type: string
  from_status: string | null
  to_status: string | null
  note: string | null
  details: Json
  actor_user_id: string | null
  created_at: string
}

export type PoAllocationRunRow = {
  id: string
  company_id: string
  purchase_order_id: string
  run_type: 'DRAFT' | 'COMMITTED'
  strategy: AllocationStrategy
  plan: Json
  result: Json
  note: string | null
  created_by: string | null
  created_at: string
}

export type PoSnapshotRow = {
  id: string
  company_id: string
  purchase_order_id: string
  taken_at: string
  taken_by: string | null
  summary: Json
  lines: Json
}

export type PoShortageNoteRow = {
  id: string
  company_id: string
  line_id: string
  note: string
  created_by: string | null
  created_at: string
}

export type PoAllocationListRow = ReservationRow & {
  purchase_order_id: string
  line_no: number
  po_reference: string
  customer_po_number: string
  customer_name_snapshot: string
  po_status: PoStatus
  sku: string
  product_name: string
  base_unit: string
  batch_number: string | null
  expiry_date: string | null
  warehouse_code: string | null
  location_code: string | null
}

export type CustomerPoTables = {
  customers: {
    Row: CustomerRow
    Insert: { company_id: string; customer_code: string; customer_name: string; contact_email?: string | null; status?: 'ACTIVE' | 'INACTIVE'; notes?: string | null } & Partial<CustomerBillingFields>
    Update: { customer_name?: string; contact_email?: string | null; status?: 'ACTIVE' | 'INACTIVE'; notes?: string | null } & Partial<CustomerBillingFields>
    Relationships: []
  }
  customer_product_codes: ReadOnly<CustomerProductCodeRow>
  customer_po_import_batches: ReadOnly<PoImportBatchRow>
  customer_purchase_orders: ReadOnly<CustomerPoRow>
  customer_purchase_order_lines: ReadOnly<CustomerPoLineRow>
  customer_po_events: ReadOnly<PoEventRow>
  customer_po_allocation_runs: ReadOnly<PoAllocationRunRow>
  customer_po_analysis_snapshots: ReadOnly<PoSnapshotRow>
  customer_po_shortage_notes: ReadOnly<PoShortageNoteRow>
}

export type CustomerPoViews = {
  customer_po_list: { Row: CustomerPoListRow; Relationships: [] }
  customer_po_line_list: { Row: CustomerPoLineListRow; Relationships: [] }
  customer_po_allocation_list: { Row: PoAllocationListRow; Relationships: [] }
}
