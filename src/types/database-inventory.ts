/**
 * Phase 4 inventory types, merged into `Database` in ./database.ts.
 * Mirrors supabase/migrations/20261012*_inventory_*.sql. Regenerate all types
 * with `supabase gen types typescript` once a project is linked.
 */
import type { Json } from './database'

export type StockSource = 'IN_HOUSE' | 'OUTSOURCED' | 'UNKNOWN'
export type TransactionType =
  | 'OPENING_STOCK'
  | 'RECEIPT'
  | 'ISSUE'
  | 'TRANSFER_OUT'
  | 'TRANSFER_IN'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'
  | 'CUSTOMER_RETURN'
  | 'SUPPLIER_RETURN'
  | 'REVERSAL'
  | 'PRODUCTION_ISSUE'
  | 'PRODUCTION_RECEIPT'
  | 'SUBCONTRACT_CONSUMPTION'
  | 'SUBCONTRACT_RECEIPT'
export type ReservationStatus = 'ACTIVE' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'RELEASED' | 'CANCELLED' | 'EXPIRED'
export type ApprovalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'POSTED' | 'CANCELLED'
export type CountStatus = 'OPEN' | 'SUBMITTED' | 'POSTED' | 'REJECTED' | 'CANCELLED'
export type StockStatus = 'OUT_OF_STOCK' | 'FULLY_RESERVED' | 'NO_THRESHOLD' | 'LOW_STOCK' | 'HEALTHY'
export type LocationType = 'GENERAL' | 'ZONE' | 'AREA' | 'RACK' | 'SHELF' | 'BIN'
export type LocationUsage = 'STORAGE' | 'REJECTED' | 'EXTERNAL_PROCESSING' | 'QUARANTINE'
export type AlertType = 'LOW_STOCK' | 'OUT_OF_STOCK' | 'FULLY_RESERVED' | 'EXPIRED' | 'EXPIRING' | 'INVALID_LOCATION' | 'UNKNOWN_SOURCE'

type ReadOnly<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }

export type WarehouseRow = {
  id: string
  company_id: string
  warehouse_code: string
  warehouse_name: string
  address: string | null
  status: 'ACTIVE' | 'INACTIVE'
  is_default: boolean
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type LocationRow = {
  id: string
  company_id: string
  warehouse_id: string
  parent_location_id: string | null
  location_code: string
  location_name: string
  location_type: LocationType
  stock_usage: LocationUsage
  external_holder: string | null
  is_default: boolean
  status: 'ACTIVE' | 'INACTIVE'
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type BatchRow = {
  id: string
  company_id: string
  product_id: string
  batch_number: string | null
  is_system_lot: boolean
  source_type: StockSource
  supplier_id: string | null
  manufacturing_date: string | null
  expiry_date: string | null
  unit_cost: number | null
  currency_code: string
  reference_type: string | null
  reference_id: string | null
  received_warehouse_id: string | null
  received_location_id: string | null
  status: 'ACTIVE' | 'CLOSED'
  created_by: string | null
  created_at: string
}

export type BalanceRow = {
  id: string
  company_id: string
  product_id: string
  batch_id: string
  warehouse_id: string
  location_id: string
  source_type: StockSource
  on_hand: number
  reserved: number
  last_movement_at: string | null
  updated_at: string
}

export type TransactionRow = {
  id: string
  company_id: string
  transaction_number: string
  transaction_type: TransactionType
  direction: 1 | -1
  product_id: string
  batch_id: string
  warehouse_id: string
  location_id: string
  quantity: number
  unit: string
  source_type: StockSource
  unit_cost: number | null
  reference_type: string | null
  reference_number: string | null
  reference_id: string | null
  reason: string
  notes: string | null
  transaction_date: string
  status: 'POSTED'
  document_type: string | null
  document_id: string | null
  transfer_group_id: string | null
  reversal_of_transaction_id: string | null
  created_by: string | null
  approved_by: string | null
  created_at: string
}

export type ReservationRow = {
  id: string
  company_id: string
  reservation_number: string
  product_id: string
  batch_id: string
  warehouse_id: string
  location_id: string
  quantity: number
  fulfilled_quantity: number
  released_quantity: number
  reservation_status: ReservationStatus
  reference_type: string
  reference_number: string
  reference_id: string | null
  notes: string | null
  reserved_by: string | null
  reserved_at: string
  expires_at: string | null
  released_by: string | null
  released_at: string | null
  updated_at: string
}

export type OpeningBatchRow = {
  id: string
  company_id: string
  document_number: string
  source: 'MANUAL' | 'IMPORT'
  file_name: string | null
  status: 'PENDING_APPROVAL' | 'POSTED' | 'REJECTED' | 'CANCELLED'
  line_count: number
  notes: string | null
  requested_by: string | null
  requested_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  posted_at: string | null
  updated_at: string
}

export type OpeningLineRow = {
  id: string
  company_id: string
  opening_batch_id: string
  line_no: number
  product_id: string
  warehouse_id: string
  location_id: string
  source_type: StockSource
  batch_number: string | null
  manufacturing_date: string | null
  expiry_date: string | null
  unit_cost: number | null
  quantity: number
  effective_date: string
  reference: string | null
  notes: string | null
  status: OpeningBatchRow['status']
  posted_transaction_id: string | null
  created_at: string
}

export type AdjustmentRow = {
  id: string
  company_id: string
  adjustment_number: string
  adjustment_type: 'QUANTITY' | 'SOURCE_CORRECTION'
  product_id: string
  batch_id: string | null
  batch_number: string | null
  warehouse_id: string
  location_id: string
  source_type: StockSource
  target_source_type: 'IN_HOUSE' | 'OUTSOURCED' | null
  system_quantity: number
  counted_quantity: number | null
  correction_quantity: number | null
  difference: number | null
  unit_cost: number | null
  reason_code: string
  /** Reason from ERP Settings (migration 20261201090000); null for older adjustments. */
  reason_label?: string | null
  notes: string | null
  reference: string | null
  effective_date: string
  status: ApprovalStatus
  requested_by: string | null
  requested_at: string
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  posted_at: string | null
  updated_at: string
}

export type CountRow = {
  id: string
  company_id: string
  count_number: string
  warehouse_id: string
  location_id: string | null
  include_sublocations: boolean
  product_ids: string[] | null
  status: CountStatus
  snapshot_at: string
  notes: string | null
  created_by: string | null
  created_at: string
  submitted_by: string | null
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  posted_at: string | null
  updated_at: string
}

export type CountLineRow = {
  id: string
  company_id: string
  count_id: string
  product_id: string
  batch_id: string | null
  batch_number: string | null
  expiry_date: string | null
  source_type: StockSource
  warehouse_id: string
  location_id: string
  system_quantity: number
  counted_quantity: number | null
  variance: number | null
  is_added: boolean
  counted_by: string | null
  counted_at: string | null
  notes: string | null
  posted_transaction_id: string | null
  created_at: string
}

export type AlertRow = {
  id: string
  company_id: string
  alert_key: string
  alert_type: AlertType
  severity: 'CRITICAL' | 'WARNING' | 'INFO'
  product_id: string | null
  batch_id: string | null
  warehouse_id: string | null
  location_id: string | null
  details: Json
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'
  first_detected_at: string
  last_detected_at: string
  acknowledged_by: string | null
  acknowledged_at: string | null
  acknowledgement_note: string | null
  resolved_at: string | null
  notified_at: string | null
}

export type StockDetailRow = {
  balance_id: string
  company_id: string
  product_id: string
  sku: string
  product_name: string
  barcode: string | null
  category_id: string | null
  category_name: string | null
  product_type: string
  default_source_type: string
  base_unit: string
  reorder_level: number | null
  product_status: string
  product_archived: boolean
  batch_id: string
  batch_number: string | null
  is_system_lot: boolean
  source_type: StockSource
  manufacturing_date: string | null
  expiry_date: string | null
  warehouse_id: string
  warehouse_code: string
  warehouse_name: string
  warehouse_status: string
  location_id: string
  location_code: string
  location_name: string
  location_status: string
  on_hand: number
  reserved: number
  available: number
  last_movement_at: string | null
}

export type ProductStockRow = {
  product_id: string
  company_id: string
  sku: string
  product_name: string
  barcode: string | null
  brand: string | null
  model_number: string | null
  category_id: string | null
  category_name: string | null
  product_type: string
  default_source_type: string
  base_unit: string
  reorder_level: number | null
  product_status: string
  archived_at: string | null
  track_batches: boolean
  on_hand: number
  reserved: number
  available: number
  in_house_on_hand: number
  outsourced_on_hand: number
  unknown_source_on_hand: number
  last_movement_at: string | null
  has_history: boolean
  stock_status: StockStatus
}

export type TransactionListRow = TransactionRow & {
  sku: string
  product_name: string
  batch_number: string | null
  warehouse_code: string
  warehouse_name: string
  location_code: string
  location_name: string
  quantity_in: number | null
  quantity_out: number | null
  counterpart_location_id: string | null
  counterpart_location_code: string | null
  counterpart_warehouse_code: string | null
  reversed_by_transaction_id: string | null
  reversed_by_number: string | null
  reversal_of_number: string | null
}

/** Per-product stock split by location usage (Phase 5). */
export type ProductUsageStockRow = {
  company_id: string
  product_id: string
  storage_on_hand: number
  rejected_on_hand: number
  external_on_hand: number
}

export type InventoryTables = {
  warehouses: {
    Row: WarehouseRow
    Insert: { company_id: string; warehouse_code: string; warehouse_name: string; address?: string | null; status?: 'ACTIVE' | 'INACTIVE'; is_default?: boolean }
    Update: { warehouse_name?: string; address?: string | null; status?: 'ACTIVE' | 'INACTIVE'; is_default?: boolean }
    Relationships: []
  }
  inventory_locations: {
    Row: LocationRow
    Insert: {
      company_id: string
      warehouse_id: string
      parent_location_id?: string | null
      location_code: string
      location_name: string
      location_type?: LocationType
      status?: 'ACTIVE' | 'INACTIVE'
      stock_usage?: LocationUsage
      external_holder?: string | null
    }
    Update: {
      parent_location_id?: string | null
      location_name?: string
      location_type?: LocationType
      status?: 'ACTIVE' | 'INACTIVE'
      stock_usage?: LocationUsage
      external_holder?: string | null
    }
    Relationships: []
  }
  inventory_batches: ReadOnly<BatchRow>
  inventory_balances: ReadOnly<BalanceRow>
  inventory_transactions: ReadOnly<TransactionRow>
  stock_reservations: ReadOnly<ReservationRow>
  inventory_opening_batches: ReadOnly<OpeningBatchRow>
  inventory_opening_lines: ReadOnly<OpeningLineRow>
  inventory_adjustments: ReadOnly<AdjustmentRow>
  inventory_counts: ReadOnly<CountRow>
  inventory_count_lines: ReadOnly<CountLineRow>
  inventory_alerts: ReadOnly<AlertRow>
}

export type InventoryViews = {
  inventory_stock_detail: { Row: StockDetailRow; Relationships: [] }
  inventory_product_stock: { Row: ProductStockRow; Relationships: [] }
  inventory_transaction_list: { Row: TransactionListRow; Relationships: [] }
  inventory_product_usage_stock: { Row: ProductUsageStockRow; Relationships: [] }
}

type Rpc<Args, Returns> = { Args: Args; Returns: Returns }
type Key = { p_idempotency_key: string }

export type InventoryFunctions = {
  inventory_post_receipt: Rpc<
    {
      p_product_id: string
      p_location_id: string
      p_quantity: number
      p_source_type: string
      p_batch_number?: string | null
      p_manufacturing_date?: string | null
      p_expiry_date?: string | null
      p_unit_cost?: number | null
      p_transaction_type?: string
      p_reference_type?: string | null
      p_reference_number?: string | null
      p_reason?: string | null
      p_notes?: string | null
    } & Key,
    Json
  >
  inventory_post_issue: Rpc<
    {
      p_product_id: string
      p_location_id: string
      p_quantity: number
      p_batch_id?: string | null
      p_source_type?: string | null
      p_transaction_type?: string
      p_reference_type?: string | null
      p_reference_number?: string | null
      p_reason?: string | null
      p_notes?: string | null
    } & Key,
    Json
  >
  inventory_transfer_stock: Rpc<
    {
      p_product_id: string
      p_from_location_id: string
      p_to_location_id: string
      p_quantity: number
      p_batch_id?: string | null
      p_source_type?: string | null
      p_reference_number?: string | null
      p_reason?: string | null
      p_notes?: string | null
    } & Key,
    Json
  >
  inventory_reverse_transaction: Rpc<{ p_transaction_id: string; p_reason: string } & Key, Json>
  inventory_create_reservation: Rpc<
    {
      p_product_id: string
      p_location_id: string
      p_quantity: number
      p_reference_type: string
      p_reference_number: string
      p_batch_id?: string | null
      p_source_type?: string | null
      p_notes?: string | null
      p_expires_at?: string | null
    } & Key,
    Json
  >
  inventory_release_reservation: Rpc<{ p_reservation_id: string; p_action: 'RELEASE' | 'CANCEL'; p_note?: string | null }, Json>
  inventory_fulfil_reservation: Rpc<
    { p_reservation_id: string; p_quantity: number; p_reference_number?: string | null; p_notes?: string | null } & Key,
    Json
  >
  inventory_expire_reservations: Rpc<Record<PropertyKey, never>, number>
  inventory_submit_opening_stock: Rpc<
    { p_lines: Json; p_source: 'MANUAL' | 'IMPORT'; p_file_name?: string | null; p_notes?: string | null } & Key,
    Json
  >
  inventory_review_opening_stock: Rpc<{ p_opening_batch_id: string; p_decision: 'APPROVE' | 'REJECT'; p_note?: string | null } & Key, Json>
  inventory_cancel_opening_stock: Rpc<{ p_opening_batch_id: string }, Json>
  inventory_create_adjustment: Rpc<
    {
      p_adjustment_type: 'QUANTITY' | 'SOURCE_CORRECTION'
      p_product_id: string
      p_location_id: string
      p_reason_code: string
      p_batch_id?: string | null
      p_batch_number?: string | null
      p_source_type?: string | null
      p_counted_quantity?: number | null
      p_correction_quantity?: number | null
      p_target_source_type?: string | null
      p_unit_cost?: number | null
      p_notes?: string | null
      p_reference?: string | null
      p_effective_date?: string | null
      p_submit?: boolean
    } & Key,
    Json
  >
  inventory_update_adjustment_status: Rpc<{ p_adjustment_id: string; p_action: 'SUBMIT' | 'CANCEL' }, Json>
  inventory_review_adjustment: Rpc<{ p_adjustment_id: string; p_decision: 'APPROVE' | 'REJECT'; p_note?: string | null } & Key, Json>
  inventory_create_count: Rpc<
    { p_warehouse_id: string; p_location_id?: string | null; p_include_sublocations?: boolean; p_product_ids?: string[] | null; p_notes?: string | null } & Key,
    Json
  >
  inventory_record_count: Rpc<{ p_count_id: string; p_lines: Json }, Json>
  inventory_add_count_line: Rpc<
    { p_count_id: string; p_product_id: string; p_location_id: string; p_source_type: string; p_batch_number?: string | null; p_expiry_date?: string | null },
    Json
  >
  inventory_submit_count: Rpc<{ p_count_id: string }, Json>
  inventory_review_count: Rpc<{ p_count_id: string; p_decision: 'APPROVE' | 'REJECT'; p_note?: string | null } & Key, Json>
  inventory_cancel_count: Rpc<{ p_count_id: string }, Json>
  inventory_overview: Rpc<Record<PropertyKey, never>, Json>
  inventory_movement_trend: Rpc<
    { p_from: string; p_to: string; p_bucket?: 'day' | 'week' | 'month' | 'year' },
    { bucket: string; unit: string; quantity_in: number; quantity_out: number; transactions: number }[]
  >
  inventory_stock_as_of: Rpc<
    { p_cutoff: string },
    {
      product_id: string
      sku: string
      product_name: string
      unit: string
      category_name: string | null
      warehouse_code: string
      warehouse_name: string
      location_code: string
      batch_number: string | null
      source_type: StockSource
      quantity: number
    }[]
  >
  inventory_valuation: Rpc<
    Record<PropertyKey, never>,
    {
      product_id: string
      sku: string
      product_name: string
      unit: string
      category_name: string | null
      source_type: StockSource
      warehouse_code: string
      location_code: string
      batch_number: string | null
      on_hand: number
      unit_cost: number | null
      value: number | null
    }[]
  >
  inventory_reconcile: Rpc<Record<PropertyKey, never>, Json>
  inventory_policy_info: Rpc<Record<PropertyKey, never>, Json>
  inventory_find_product_by_code: Rpc<
    { p_code: string },
    {
      product_id: string
      sku: string
      product_name: string
      base_unit: string
      track_batches: boolean
      track_expiry: boolean
      product_status: string
      matched_on: 'BARCODE' | 'SKU'
    }[]
  >
  inventory_refresh_alerts: Rpc<Record<PropertyKey, never>, Json>
  inventory_acknowledge_alert: Rpc<{ p_alert_id: string; p_note?: string | null }, Json>
}
