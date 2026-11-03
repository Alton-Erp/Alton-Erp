/**
 * Phase 7 sales order, fulfilment, delivery and return types, merged into
 * `Database` in ./database.ts. Mirrors supabase/migrations/20261015*.sql.
 * Every table is read-only for clients; all changes go through RPCs
 * (src/services/sales.ts).
 */
import type { Json } from './database'

export type SalesOrderStatus =
  | 'DRAFT'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'PARTIALLY_ALLOCATED'
  | 'READY_FOR_FULFILMENT'
  | 'IN_FULFILMENT'
  | 'PARTIALLY_FULFILLED'
  | 'FULFILLED'
  | 'ON_HOLD'
  | 'CANCELLED'
export type OrderFulfilmentStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'PARTIALLY_DISPATCHED' | 'DISPATCHED' | 'PARTIALLY_DELIVERED' | 'DELIVERED'
export type FulfilmentStatus =
  | 'PENDING'
  | 'PICKING'
  | 'PICKED'
  | 'PACKING'
  | 'PACKED'
  | 'READY_FOR_DISPATCH'
  | 'DISPATCHED'
  | 'IN_TRANSIT'
  | 'PARTIALLY_DELIVERED'
  | 'DELIVERED'
  | 'DELIVERY_EXCEPTION'
  | 'CANCELLED'
export type SoLineStatus = 'OPEN' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED'
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
export type TransportMode = 'ROAD' | 'RAIL' | 'AIR' | 'SEA' | 'COURIER' | 'CUSTOMER_PICKUP' | 'OTHER'
export type DeliveryEventType =
  | 'DISPATCHED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'ARRIVED'
  | 'OUT_FOR_DELIVERY'
  | 'PARTIALLY_DELIVERED'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'RETURNED_TO_SENDER'
  | 'EXCEPTION'
export type ReturnStatus = 'REQUESTED' | 'AUTHORIZED' | 'RECEIVED' | 'UNDER_INSPECTION' | 'ACCEPTED' | 'REJECTED' | 'CLOSED'
export type ReturnReason = 'DAMAGED_IN_TRANSIT' | 'DEFECTIVE' | 'WRONG_ITEM' | 'EXCESS_QUANTITY' | 'NOT_REQUIRED' | 'DELIVERY_REFUSED' | 'OTHER'
export type Disposition = 'RESTOCK' | 'QUARANTINE' | 'REPAIR' | 'SCRAP' | 'RETURN_TO_CUSTOMER' | 'PENDING_REVIEW'

type ReadOnly<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }

export type SalesOrderRow = {
  id: string
  company_id: string
  sales_order_number: string
  source: 'CUSTOMER_PO' | 'MANUAL'
  customer_id: string | null
  customer_key: string
  customer_name_snapshot: string
  customer_purchase_order_id: string | null
  customer_po_number: string | null
  source_po_reference: string | null
  source_filename: string | null
  order_date: string
  requested_delivery_date: string | null
  shipping_address_snapshot: string | null
  billing_address_snapshot: string | null
  order_status: SalesOrderStatus
  status_before_hold: string | null
  fulfilment_status: OrderFulfilmentStatus
  priority: Priority
  warehouse_id: string | null
  currency: string | null
  customer_reference: string | null
  internal_notes: string | null
  hold_reason: string | null
  cancel_reason: string | null
  created_by: string | null
  confirmed_by: string | null
  confirmed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export type UnitTotals = { unit: string; ordered: number; cancelled: number; dispatched: number; delivered: number; returned: number; remaining: number; reserved: number }

export type SalesOrderListRow = SalesOrderRow & {
  customer_code: string | null
  warehouse_code: string | null
  line_count: number
  unit_totals: UnitTotals[] | null
  fulfilment_count: number
  last_dispatch_at: string | null
  has_exception: boolean
}

export type SalesOrderLineRow = {
  id: string
  company_id: string
  sales_order_id: string
  line_no: number
  customer_purchase_order_line_id: string | null
  product_id: string
  sku_snapshot: string
  product_name_snapshot: string
  customer_sku_snapshot: string | null
  quantity_ordered: number
  quantity_cancelled: number
  quantity_dispatched: number
  quantity_delivered: number
  quantity_returned: number
  unit: string
  unit_price_snapshot: number | null
  currency: string | null
  requested_delivery_date: string | null
  line_status: SoLineStatus
  backorder_reason: string | null
  expected_fulfilment_date: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export type SalesOrderLineListRow = SalesOrderLineRow & {
  sales_order_number: string
  order_status: SalesOrderStatus
  customer_name_snapshot: string
  customer_id: string | null
  customer_po_number: string | null
  order_date: string
  order_requested_date: string | null
  priority: Priority
  order_warehouse_id: string | null
  barcode: string | null
  base_unit: string
  product_status: string
  default_source_type: string
  po_line_no: number | null
  quantity_effective: number
  quantity_remaining: number
  quantity_reserved: number
  quantity_planned: number
  quantity_picked: number
  quantity_packed: number
  quantity_unreserved: number
  available_now: number
}

export type SalesOrderReservationRow = {
  id: string
  company_id: string
  reservation_number: string
  reservation_status: string
  quantity: number
  fulfilled_quantity: number
  released_quantity: number
  remaining: number
  planned: number
  reserved_at: string
  notes: string | null
  batch_id: string
  location_id: string
  warehouse_id: string
  product_id: string
  sales_order_line_id: string
  line_no: number
  sales_order_id: string
  sku: string
  product_name: string
  unit: string
  sales_order_number: string
  customer_name_snapshot: string
  batch_number: string | null
  expiry_date: string | null
  source_type: string
  batch_status: string
  warehouse_code: string
  location_code: string
  stock_usage: string
  location_status: string
}

export type FulfilmentRow = {
  id: string
  company_id: string
  fulfilment_number: string
  sales_order_id: string
  warehouse_id: string
  fulfilment_status: FulfilmentStatus
  planned_dispatch_date: string | null
  expected_delivery_date: string | null
  actual_dispatch_at: string | null
  carrier_name: string | null
  transport_mode: TransportMode | null
  vehicle_number: string | null
  lr_number: string | null
  tracking_number: string | null
  eway_bill_number: string | null
  delivery_reference: string | null
  document_references: string | null
  dispatch_notes: string | null
  packing_notes: string | null
  notes: string | null
  reopen_reason: string | null
  exception_reason: string | null
  cancel_reason: string | null
  created_by: string | null
  picked_at: string | null
  packed_at: string | null
  ready_at: string | null
  dispatched_by: string | null
  delivered_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export type FulfilmentListRow = FulfilmentRow & {
  sales_order_number: string
  customer_name_snapshot: string
  customer_id: string | null
  customer_key: string
  customer_po_number: string | null
  order_status: SalesOrderStatus
  priority: Priority
  order_requested_date: string | null
  shipping_address_snapshot: string | null
  warehouse_code: string
  warehouse_name: string
  line_count: number
  to_pick: number
  picked: number
  packed: number
  damaged: number
  dispatched: number
  delivered: number
  units: string | null
  pick_exceptions: number
  pack_exceptions: number
  is_overdue: boolean
  delivery_days_late: number | null
  last_event_type: DeliveryEventType | null
  last_event_at: string | null
  last_event_location: string | null
}

export type FulfilmentLineRow = {
  id: string
  company_id: string
  fulfilment_id: string
  line_no: number
  sales_order_line_id: string
  product_id: string
  reservation_id: string
  batch_id: string
  location_id: string
  quantity_to_pick: number
  quantity_picked: number
  quantity_packed: number
  quantity_damaged: number
  quantity_dispatched: number
  quantity_delivered: number
  pick_exception: string | null
  pack_exception: string | null
  picked_by: string | null
  picked_at: string | null
  packed_by: string | null
  packed_at: string | null
  issue_transaction_id: string | null
  created_at: string
  updated_at: string
}

export type FulfilmentLineListRow = FulfilmentLineRow & {
  fulfilment_number: string
  fulfilment_status: FulfilmentStatus
  sales_order_id: string
  warehouse_id: string
  sales_order_number: string
  customer_name_snapshot: string
  order_line_no: number
  quantity_ordered: number
  quantity_cancelled: number
  order_line_dispatched: number
  order_line_remaining: number
  sku: string
  product_name: string
  barcode: string | null
  unit: string
  batch_number: string | null
  expiry_date: string | null
  source_type: string
  warehouse_code: string
  location_code: string
  reservation_number: string
  reservation_remaining: number
  stock_problem: string | null
  issue_transaction_number: string | null
}

export type DeliveryEventRow = {
  id: string
  company_id: string
  fulfilment_id: string
  event_type: DeliveryEventType
  event_at: string
  location: string | null
  description: string | null
  reference_number: string | null
  failure_reason: string | null
  delivered_quantities: Json
  source: 'MANUAL' | 'SYSTEM' | 'CARRIER'
  verified: boolean
  recorded_by: string | null
  created_at: string
}

export type SalesOrderEventRow = {
  id: string
  company_id: string
  sales_order_id: string
  fulfilment_id: string | null
  return_id: string | null
  line_id: string | null
  event_type: string
  from_status: string | null
  to_status: string | null
  note: string | null
  details: Json
  actor_user_id: string | null
  created_at: string
}

export type CustomerReturnRow = {
  id: string
  company_id: string
  return_number: string
  sales_order_id: string
  fulfilment_id: string | null
  customer_id: string | null
  customer_name_snapshot: string
  return_date: string
  reason_code: ReturnReason
  reason_note: string | null
  customer_reference: string | null
  status: ReturnStatus
  receipt_location_id: string | null
  notes: string | null
  requested_by: string | null
  authorized_by: string | null
  authorized_at: string | null
  decision_note: string | null
  received_by: string | null
  received_at: string | null
  inspected_by: string | null
  inspected_at: string | null
  inspection_note: string | null
  closed_by: string | null
  closed_at: string | null
  created_at: string
  updated_at: string
}

export type CustomerReturnListRow = CustomerReturnRow & {
  sales_order_number: string
  customer_po_number: string | null
  fulfilment_number: string | null
  receipt_location_code: string | null
  line_count: number
  requested: number
  received: number
  units: string | null
  restocked: number
  pending_dispositions: number
}

export type CustomerReturnLineRow = {
  id: string
  company_id: string
  return_id: string
  line_no: number
  sales_order_line_id: string
  fulfilment_line_id: string
  product_id: string
  batch_id: string
  quantity_requested: number
  quantity_received: number
  disposition: Disposition
  inspection_note: string | null
  receipt_transaction_id: string | null
  disposition_posted: boolean
  disposition_transaction_ids: string[]
  created_at: string
  updated_at: string
}

export type CustomerReturnLineListRow = CustomerReturnLineRow & {
  return_number: string
  return_status: ReturnStatus
  sales_order_id: string
  reason_code: ReturnReason
  sku: string
  product_name: string
  unit: string
  batch_number: string | null
  fulfilment_number: string
  fulfilment_line_dispatched: number
  receipt_transaction_number: string | null
}

export type SalesTables = {
  sales_orders: ReadOnly<SalesOrderRow>
  sales_order_lines: ReadOnly<SalesOrderLineRow>
  sales_order_events: ReadOnly<SalesOrderEventRow>
  fulfilments: ReadOnly<FulfilmentRow>
  fulfilment_lines: ReadOnly<FulfilmentLineRow>
  delivery_events: ReadOnly<DeliveryEventRow>
  customer_returns: ReadOnly<CustomerReturnRow>
  customer_return_lines: ReadOnly<CustomerReturnLineRow>
}

export type SalesViews = {
  sales_order_list: { Row: SalesOrderListRow; Relationships: [] }
  sales_order_line_list: { Row: SalesOrderLineListRow; Relationships: [] }
  sales_order_reservation_list: { Row: SalesOrderReservationRow; Relationships: [] }
  fulfilment_list: { Row: FulfilmentListRow; Relationships: [] }
  fulfilment_line_list: { Row: FulfilmentLineListRow; Relationships: [] }
  customer_return_list: { Row: CustomerReturnListRow; Relationships: [] }
  customer_return_line_list: { Row: CustomerReturnLineListRow; Relationships: [] }
}
