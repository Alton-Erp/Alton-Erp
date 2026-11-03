/**
 * Phase 5 manufacturing & outsourcing types, merged into `Database` in
 * ./database.ts. Mirrors supabase/migrations/20261013*_production_*.sql and
 * 20261013090400_outsourcing.sql. Clients only read these tables; every change
 * goes through an RPC (see src/services/production.ts).
 */
import type { Json } from './database'

export type BomStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'ARCHIVED'
export type ProductionStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'MATERIALS_RESERVED'
  | 'IN_PROGRESS'
  | 'PARTIALLY_COMPLETED'
  | 'COMPLETED'
  | 'ON_HOLD'
  | 'CANCELLED'
export type ProductionPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT'
export type OutsourcingType = 'OUTSOURCED_FINISHED_GOODS' | 'OUTSOURCED_PROCESSING'
export type OutsourcingStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'MATERIALS_DISPATCHED'
  | 'PARTIALLY_RECEIVED'
  | 'COMPLETED'
  | 'ON_HOLD'
  | 'CANCELLED'
export type PostedStatus = 'POSTED' | 'REVERSED'
export type QualityStatus = 'NOT_INSPECTED' | 'ACCEPTED' | 'ACCEPTED_WITH_DEVIATION'
export type RejectionDisposition = 'RETURN_TO_SUPPLIER' | 'HELD_FOR_REWORK' | 'SCRAP' | 'PENDING_DECISION'

type ReadOnly<Row> = { Row: Row; Insert: never; Update: never; Relationships: [] }

export type BomRow = {
  id: string
  company_id: string
  bom_code: string
  finished_product_id: string
  version: number
  status: BomStatus
  effective_from: string
  effective_to: string | null
  output_quantity: number
  output_unit: string
  notes: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  review_note: string | null
  archived_by: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type BomListRow = BomRow & {
  sku: string
  product_name: string
  product_type: string
  product_status: string
  item_count: number
  /** Product planning fields (bom_list_v2, migration 20261114090000): the finished product's values. */
  tax_rate?: number | null
  lead_time_days?: number | null
  group_head?: string | null
  minimum_cover_days?: number | null
  ean?: string | null
}

export type BomItemRow = {
  id: string
  company_id: string
  bom_id: string
  line_no: number
  component_product_id: string
  quantity_required: number
  unit: string
  wastage_percentage: number
  notes: string | null
  created_at: string
  source_type: 'IN_HOUSE' | 'OUTSOURCED' | 'PURCHASED' | null
  preferred_supplier_id: string | null
}

export type BomItemListRow = BomItemRow & {
  sku: string
  product_name: string
  product_type: string
  inventory_unit: string
  product_status: string
  product_archived: boolean
  standard_cost: number | null
}

export type ProductionOrderRow = {
  id: string
  company_id: string
  production_order_number: string
  finished_product_id: string
  bom_id: string
  bom_code: string
  bom_version: number
  unit: string
  planned_quantity: number
  completed_quantity: number
  rejected_quantity: number
  scrap_quantity: number
  actual_quantity: number
  status: ProductionStatus
  status_before_hold: ProductionStatus | null
  priority: ProductionPriority
  source_warehouse_id: string
  destination_warehouse_id: string
  planned_start_date: string
  target_completion_date: string
  actual_start_date: string | null
  actual_completion_date: string | null
  notes: string | null
  review_note: string | null
  hold_reason: string | null
  cancel_reason: string | null
  completion_note: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  started_by: string | null
  completed_by: string | null
  completed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export type ProductionOrderListRow = ProductionOrderRow & {
  sku: string
  product_name: string
  source_warehouse_code: string | null
  destination_warehouse_code: string | null
  material_lines: number
  material_lines_issued: number
  material_status: 'NOT_ISSUED' | 'PARTIALLY_ISSUED' | 'FULLY_ISSUED'
  is_overdue: boolean
}

export type OrderMaterialRow = {
  id: string
  company_id: string
  production_order_id: string
  line_no: number
  component_product_id: string
  unit: string
  quantity_per_unit: number
  wastage_percentage: number
  base_quantity: number
  planned_quantity: number
  issued_quantity: number
}

export type ConsumptionRow = {
  id: string
  company_id: string
  production_order_id: string
  order_material_id: string
  component_product_id: string
  batch_id: string
  warehouse_id: string
  location_id: string
  planned_quantity: number
  actual_quantity: number
  unit: string
  reserved_quantity_used: number
  inventory_transaction_id: string
  consumption_date: string
  over_issue_reason: string | null
  notes: string | null
  status: PostedStatus
  reversal_transaction_ids: string[] | null
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  recorded_by: string | null
  created_at: string
}

export type ConsumptionListRow = ConsumptionRow & {
  production_order_number: string
  order_status: ProductionStatus
  sku: string
  product_name: string
  batch_number: string | null
  source_type: string | null
  warehouse_code: string | null
  location_code: string | null
  transaction_number: string | null
}

export type OutputReceiptRow = {
  id: string
  company_id: string
  receipt_number: string
  production_order_id: string
  product_id: string
  batch_id: string | null
  good_quantity: number
  rejected_quantity: number
  scrap_quantity: number
  unit: string
  good_location_id: string | null
  rejected_location_id: string | null
  good_transaction_id: string | null
  rejected_transaction_id: string | null
  production_date: string
  unit_cost: number | null
  quality_status: QualityStatus
  rejection_reason: string | null
  over_production_reason: string | null
  notes: string | null
  status: PostedStatus
  reversal_transaction_ids: string[] | null
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  created_by: string | null
  created_at: string
}

export type OutputListRow = OutputReceiptRow & {
  production_order_number: string
  order_status: ProductionStatus
  order_planned_quantity: number
  sku: string
  product_name: string
  batch_number: string | null
  good_location_code: string | null
  good_warehouse_code: string | null
  rejected_location_code: string | null
  good_transaction_number: string | null
  rejected_transaction_number: string | null
}

export type OrderEventRow = {
  id: string
  company_id: string
  event_type: string
  from_status: string | null
  to_status: string | null
  note: string | null
  details: Json
  actor_user_id: string | null
  created_at: string
}

export type ProductionEventRow = OrderEventRow & { production_order_id: string }
export type OutsourcingEventRow = OrderEventRow & { outsourcing_order_id: string }

export type OutsourcingOrderRow = {
  id: string
  company_id: string
  outsourcing_order_number: string
  order_type: OutsourcingType
  supplier_id: string | null
  supplier_name: string
  supplier_reference: string | null
  product_id: string
  bom_id: string | null
  bom_code: string | null
  bom_version: number | null
  unit: string
  ordered_quantity: number
  received_quantity: number
  accepted_quantity: number
  rejected_quantity: number
  status: OutsourcingStatus
  status_before_hold: OutsourcingStatus | null
  dispatch_date: string | null
  expected_return_date: string
  destination_warehouse_id: string
  external_location_id: string | null
  reference_number: string | null
  unit_cost: number | null
  currency_code: string
  notes: string | null
  review_note: string | null
  hold_reason: string | null
  cancel_reason: string | null
  completion_note: string | null
  created_by: string | null
  submitted_by: string | null
  submitted_at: string | null
  approved_by: string | null
  approved_at: string | null
  completed_by: string | null
  completed_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
}

export type OutsourcingOrderListRow = OutsourcingOrderRow & {
  sku: string
  product_name: string
  destination_warehouse_code: string | null
  external_location_code: string | null
  external_holder: string | null
  pending_quantity: number
  material_lines: number
  material_lines_held: number
}

export type OutsourcingMaterialRow = {
  id: string
  company_id: string
  outsourcing_order_id: string
  line_no: number
  component_product_id: string
  unit: string
  quantity_per_unit: number | null
  planned_quantity: number
  dispatched_quantity: number
  returned_quantity: number
  consumed_quantity: number
}

export type OutsourcingMaterialListRow = OutsourcingMaterialRow & {
  sku: string
  product_name: string
  inventory_unit: string
  held_quantity: number
}

export type OutsourcingReceiptRow = {
  id: string
  company_id: string
  receipt_number: string
  outsourcing_order_id: string
  product_id: string
  batch_id: string | null
  received_quantity: number
  accepted_quantity: number
  rejected_quantity: number
  unit: string
  accepted_location_id: string | null
  rejected_location_id: string | null
  accepted_transaction_id: string | null
  rejected_transaction_id: string | null
  receipt_date: string
  unit_cost: number | null
  supplier_document_number: string | null
  rejection_disposition: RejectionDisposition | null
  rejection_reason: string | null
  over_receipt_reason: string | null
  notes: string | null
  status: PostedStatus
  reversal_transaction_ids: string[] | null
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  created_by: string | null
  created_at: string
}

export type OutsourcingReceiptListRow = OutsourcingReceiptRow & {
  outsourcing_order_number: string
  order_type: OutsourcingType
  supplier_name: string
  order_status: OutsourcingStatus
  sku: string
  product_name: string
  batch_number: string | null
  accepted_location_code: string | null
  accepted_warehouse_code: string | null
  rejected_location_code: string | null
  accepted_transaction_number: string | null
  rejected_transaction_number: string | null
}

export type OutsourcingMovementRow = {
  id: string
  company_id: string
  outsourcing_order_id: string
  order_material_id: string
  component_product_id: string
  movement_type: 'DISPATCH' | 'RETURN' | 'CONSUMPTION'
  batch_id: string
  from_location_id: string
  to_location_id: string | null
  quantity: number
  unit: string
  transfer_group_id: string | null
  out_transaction_id: string
  in_transaction_id: string | null
  receipt_id: string | null
  movement_date: string
  over_dispatch_reason: string | null
  notes: string | null
  status: PostedStatus
  reversal_transaction_ids: string[] | null
  reversal_reason: string | null
  reversed_by: string | null
  reversed_at: string | null
  created_by: string | null
  created_at: string
}

export type OutsourcingMovementListRow = OutsourcingMovementRow & {
  outsourcing_order_number: string
  supplier_name: string
  sku: string
  product_name: string
  batch_number: string | null
  from_location_code: string | null
  to_location_code: string | null
  out_transaction_number: string | null
}

export type ProductionTables = {
  boms: ReadOnly<BomRow>
  bom_items: ReadOnly<BomItemRow>
  production_orders: ReadOnly<ProductionOrderRow>
  production_order_materials: ReadOnly<OrderMaterialRow>
  production_material_consumption: ReadOnly<ConsumptionRow>
  production_output_receipts: ReadOnly<OutputReceiptRow>
  production_order_events: ReadOnly<ProductionEventRow>
  outsourcing_orders: ReadOnly<OutsourcingOrderRow>
  outsourcing_order_materials: ReadOnly<OutsourcingMaterialRow>
  outsourcing_receipts: ReadOnly<OutsourcingReceiptRow>
  outsourcing_material_movements: ReadOnly<OutsourcingMovementRow>
  outsourcing_order_events: ReadOnly<OutsourcingEventRow>
}

export type ProductionViews = {
  bom_list: { Row: BomListRow; Relationships: [] }
  bom_list_v2: { Row: BomListRow; Relationships: [] }
  bom_item_list: { Row: BomItemListRow; Relationships: [] }
  production_order_list: { Row: ProductionOrderListRow; Relationships: [] }
  production_consumption_list: { Row: ConsumptionListRow; Relationships: [] }
  production_output_list: { Row: OutputListRow; Relationships: [] }
  outsourcing_order_list: { Row: OutsourcingOrderListRow; Relationships: [] }
  outsourcing_material_list: { Row: OutsourcingMaterialListRow; Relationships: [] }
  outsourcing_receipt_list: { Row: OutsourcingReceiptListRow; Relationships: [] }
  outsourcing_movement_list: { Row: OutsourcingMovementListRow; Relationships: [] }
}
