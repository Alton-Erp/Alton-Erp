import { requireSupabase } from '@/lib/supabase'
import type { ImportPreviewRow, ProductionImportRow, UnitQty } from '@/features/production/production-v2-model'

/**
 * Stage 4 simple production flow (migration 20261105090000_production_v2.sql).
 * Every change goes through a SECURITY DEFINER function that checks permissions,
 * locks rows and moves stock only on completion; each action carries a request id.
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface V2Line {
  order_material_id?: string
  component_product_id: string
  line_no: number
  sku: string
  product_name: string
  product_type: string
  source_type: string
  unit: string
  quantity_per_unit: number
  wastage_percentage: number
  base_quantity: number
  required: number
  issued?: number
  reserved: number
  available: number
  shortage: number
}

export interface V2Preview {
  product: { id: string; sku: string; product_name: string; product_type: string; unit: string; track_batches: boolean; track_expiry: boolean }
  bom: { id: string; bom_code: string; version: number; output_quantity: number; item_count: number } | null
  warehouse_id: string | null
  lines: V2Line[]
  warnings: string[]
}

export interface CompletionData {
  production_date?: string
  actual_quantity: string
  rejected_quantity?: string
  wastage_quantity?: string
  remarks?: string | null
  batch_number?: string | null
  expiry_date?: string | null
  rejected_location_id?: string | null
  materials?: { order_material_id: string; quantity: string }[]
}

export interface CompletionResult {
  order_id: string
  production_order_number: string
  receipt_number: string
  accepted: number
  rejected: number
  wastage: number
  unit: string
  unit_cost: number | null
  transaction_numbers: string[]
  warnings: string[]
}

export interface SaveData {
  product_id?: string
  production_date?: string
  planned_quantity?: string
  warehouse_id?: string | null
  remarks?: string | null
  complete?: boolean
}

export interface SaveResult {
  order_id: string
  production_order_number: string
  status: string
  bom_code: string
  bom_version: number
  requirements: V2Line[]
  completion: CompletionResult | null
  warnings: string[]
}

export const fetchProductionPreview = (productId: string, quantity: number | null, warehouseId: string | null) =>
  rpc<V2Preview>('production_v2_preview', { p_product_id: productId, p_quantity: quantity, p_warehouse_id: warehouseId })

export const saveProductionOrderV2 = (orderId: string | null, data: SaveData & Partial<CompletionData>, key: string | null) =>
  rpc<SaveResult>('production_order_v2_save', { p_order_id: orderId, p_data: data, p_idempotency_key: key })

export const completeProductionV2 = (orderId: string, data: CompletionData, key: string) =>
  rpc<CompletionResult>('production_order_v2_complete', { p_order_id: orderId, p_data: data, p_idempotency_key: key })

export const correctProductionV2 = (orderId: string, reason: string, data: CompletionData | null, key: string) =>
  rpc<{ status: string; reversal_numbers: string[]; completion: CompletionResult | null; warnings: string[] }>('production_order_v2_correct', {
    p_order_id: orderId, p_reason: reason, p_data: data, p_idempotency_key: key,
  })

export const fetchOrderRequirementsV2 = (orderId: string) => rpc<V2Line[]>('production_order_v2_requirements', { p_order_id: orderId })

export const addBomComponents = (productId: string, items: { component_product_id: string; quantity_per_unit: string; wastage_percentage?: string; source_type?: string | null }[], key: string) =>
  rpc<{ bom_id: string; bom_code: string; version: number; components: number; added: number; replaced_version: number | null }>('production_bom_add_components', {
    p_product_id: productId, p_items: items, p_idempotency_key: key,
  })

export interface ProductionDashboard {
  from: string
  to: string
  today: string
  orders: number
  orders_completed: number
  open_orders: number
  produced_today: UnitQty[]
  produced_month: UnitQty[]
  finished_goods: UnitQty[]
  raw_materials: UnitQty[]
  components: UnitQty[]
  rejected: UnitQty[]
  wastage: UnitQty[]
  pending: UnitQty[]
  shortages: { component_product_id: string; sku: string; product_name: string; unit: string; needed: number; reserved: number; available: number; shortage: number; orders: number }[]
  recent: { id: string; created_at: string; event_type: string; to_status: string | null; note: string | null; details: Record<string, unknown>; order_id: string; production_order_number: string; sku: string; product_name: string; unit: string }[]
}

export const fetchProductionDashboard = (from: string, to: string) => rpc<ProductionDashboard>('production_dashboard', { p_from: from, p_to: to })

export interface ImportPreview {
  warehouse_id: string
  rows: (ImportPreviewRow & { materials: { sku: string; unit: string; required: number; available: number; shortage: number }[] })[]
  total: number
  valid: number
  warnings: number
  errors: number
  to_complete: number
}

export const previewProductionImport = (rows: ProductionImportRow[], warehouseId: string | null) =>
  rpc<ImportPreview>('production_import_preview', { p_rows: rows, p_warehouse_id: warehouseId })

export interface ImportResult {
  job_id: string
  created: { row_number: number; sku: string; order_id: string; production_order_number: string; status: string; warnings: string[] }[]
  failed: { row_number: number; sku: string; messages: string[] }[]
  created_count: number
  failed_count: number
}

export const runProductionImport = (rows: ProductionImportRow[], warehouseId: string | null, file: { file_name: string; file_hash?: string | null; total_rows: number }, key: string) =>
  rpc<ImportResult>('production_import', { p_rows: rows, p_warehouse_id: warehouseId, p_file: file, p_idempotency_key: key })
