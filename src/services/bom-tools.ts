// Generate multiple BOMs and comparison (migration 20261203090000). Reads use the existing views
// (RLS: production_bom.read, products.read, inventory.read); every write goes through a database function.
// The template pages and the similar-product page were removed from the app; their tables and functions stay in the
// database unchanged (no data is dropped).
import type { MasterCostSource } from '@/features/products/master-cost'
import { requireSupabase } from '@/lib/supabase'
import type { BomItemListRow, BomListRow } from '@/types/database-production'

const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: { code?: string; message: string } | null }>)(fn, args)
  if (error) throw error
  return data
}

export type BomToolItem = {
  component_product_id: string
  quantity_required: number
  unit: string
  wastage_percentage: number
  notes: string | null
  source_type: string | null
  preferred_supplier_id: string | null
}

export interface SimilarProductInput {
  product: Record<string, unknown>
  bom: { output_quantity: number; effective_from?: string | null; notes?: string | null; change_reason?: string | null; process_instructions?: string | null }
  items: BomToolItem[]
}

export interface SimilarProductResult {
  product_id: string
  sku: string
  product_name: string
  bom_id: string
  bom_code: string
  version: number
  status: 'DRAFT'
  components: number
}

/** New finished products with a DRAFT BOM each, in one transaction (nothing is activated; no stock moves). */
export const createSimilarProducts = (source: { bom_id?: string; template_id?: string }, products: SimilarProductInput[], key: string) =>
  rpc<{ created: number; products: SimilarProductResult[] }>('bom_create_similar_products', {
    p_source: source, p_products: products, p_idempotency_key: key,
  })

export interface GeneratedBom extends Omit<SimilarProductResult, 'status'> {
  status: 'DRAFT'
  /** true: a draft BOM for a product already in the Product Master; false: a new product was created. */
  existing_product: boolean
}

/**
 * Generate Multiple with rows that are existing Product Master products (migration 20261207090000): each entry is
 * { product_id } (new draft BOM for that product) or { product } (new product, as createSimilarProducts), in one
 * transaction. Nothing is activated; no stock moves.
 */
export type GenerateEntry = Omit<SimilarProductInput, 'product'> & ({ product_id: string } | { product: Record<string, unknown> })
export const generateMultipleBoms = (sourceBomId: string, entries: GenerateEntry[], key: string) =>
  rpc<{ created: number; products: GeneratedBom[] }>('bom_generate_multiple', { p_source: { bom_id: sourceBomId }, p_entries: entries, p_idempotency_key: key })

// ---------------------------------------------------------------------------
// Component information for the editor: Product Master Cost and available stock
// ---------------------------------------------------------------------------
export interface ComponentInfo {
  product_id: string
  sku: string
  product_name: string
  base_unit: string
  /** Product Master Cost (product_master_list, with its standard-cost fallback); null when none. */
  unit_cost: number | null
  cost_source: MasterCostSource | null
  /** Available stock; null when the user may not see stock. */
  available: number | null
}

/** Cost and stock of components (one query each). Missing permissions give null values, never an error. */
export async function fetchComponentInfo(ids: string[]): Promise<Map<string, ComponentInfo>> {
  const unique = [...new Set(ids)].filter(Boolean)
  const map = new Map<string, ComponentInfo>()
  if (unique.length === 0) return map
  let rows: { id: string; sku: string; product_name: string; base_unit: string; cost: number | null; source: MasterCostSource | null }[] = []
  const view = await db().from('product_master_list' as never).select('id, sku, product_name, base_unit, master_cost, master_cost_source').in('id', unique)
  if (!view.error) {
    rows = ((view.data ?? []) as { id: string; sku: string; product_name: string; base_unit: string; master_cost: number | null; master_cost_source: MasterCostSource | null }[])
      .map((r) => ({ id: r.id, sku: r.sku, product_name: r.product_name, base_unit: r.base_unit, cost: r.master_cost === null ? null : Number(r.master_cost), source: r.master_cost_source }))
  } else {
    // Database without the Product Master Cost view: the standard cost, by the same fallback rule.
    const p = await db().from('products').select('id, sku, product_name, base_unit, standard_cost, standard_manufacturing_cost').in('id', unique)
    if (p.error) throw p.error
    rows = (p.data ?? []).map((r) => {
      const c = r.standard_manufacturing_cost ?? r.standard_cost
      return { id: r.id, sku: r.sku, product_name: r.product_name, base_unit: r.base_unit, cost: c === null ? null : Number(c), source: c === null ? null : 'STANDARD' as const }
    })
  }
  const stock = await db().from('inventory_product_stock').select('product_id, available').in('product_id', unique)
  const available = new Map<string, number>()
  if (!stock.error) for (const s of (stock.data ?? []) as { product_id: string; available: number }[]) available.set(s.product_id, Number(s.available))
  for (const r of rows) {
    map.set(r.id, { product_id: r.id, sku: r.sku, product_name: r.product_name, base_unit: r.base_unit, unit_cost: r.cost, cost_source: r.source,
      available: stock.error ? null : (available.get(r.id) ?? 0) })
  }
  return map
}

/** BOM headers and components for the comparison (any versions the user may read). */
export async function fetchBomsForCompare(ids: string[]): Promise<{ bom: BomListRow; items: BomItemListRow[] }[]> {
  if (ids.length === 0) return []
  const [b, i] = await Promise.all([
    db().from('bom_list_v2').select('*').in('id', ids),
    db().from('bom_item_list').select('*').in('bom_id', ids).order('line_no'),
  ])
  if (b.error) throw b.error
  if (i.error) throw i.error
  const boms = (b.data ?? []) as BomListRow[]
  return ids.map((id) => boms.find((x) => x.id === id)).filter((x): x is BomListRow => Boolean(x))
    .map((bom) => ({ bom, items: ((i.data ?? []) as BomItemListRow[]).filter((x) => x.bom_id === bom.id) }))
}
