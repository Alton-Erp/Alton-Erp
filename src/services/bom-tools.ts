// BOM templates, similar products and comparison (migration 20261203090000). Reads use the existing views
// (RLS: production_bom.read, products.read, inventory.read); every write goes through a database function.
import { requireSupabase } from '@/lib/supabase'
import type { BomItemListRow, BomListRow } from '@/types/database-production'

const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: { code?: string; message: string } | null }>)(fn, args)
  if (error) throw error
  return data
}

export type TemplateStatus = 'ACTIVE' | 'ARCHIVED'

export interface BomTemplateRow {
  id: string
  company_id: string
  template_name: string
  description: string | null
  category_id: string | null
  output_quantity: number
  output_unit: string
  status: TemplateStatus
  source_bom_id: string | null
  source_bom_code: string | null
  source_bom_version: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface BomTemplateItem {
  id: string
  line_no: number
  component_product_id: string
  sku: string
  product_name: string
  unit: string
  quantity_required: number
  wastage_percentage: number
  notes: string | null
  source_type: string | null
  preferred_supplier_id: string | null
}

export interface BomTemplateSummary extends BomTemplateRow {
  component_count: number
}

/** Whether the database has the template tables (migration applied). */
export const isMissingRelation = (e: unknown) => ['PGRST205', '42P01'].includes((e as { code?: string } | null)?.code ?? '')

export async function fetchTemplates(): Promise<BomTemplateSummary[]> {
  const [t, i] = await Promise.all([
    db().from('bom_templates' as never).select('*').order('template_name'),
    db().from('bom_template_items' as never).select('template_id'),
  ])
  if (t.error) throw t.error
  if (i.error) throw i.error
  const counts = new Map<string, number>()
  for (const r of (i.data ?? []) as { template_id: string }[]) counts.set(r.template_id, (counts.get(r.template_id) ?? 0) + 1)
  return ((t.data ?? []) as BomTemplateRow[]).map((r) => ({ ...r, component_count: counts.get(r.id) ?? 0 }))
}

export async function fetchTemplate(id: string): Promise<{ template: BomTemplateRow; items: BomTemplateItem[] }> {
  const { data, error } = await db().from('bom_templates' as never).select('*').eq('id', id).single()
  if (error) throw error
  const items = await db().from('bom_template_items' as never).select('*').eq('template_id', id).order('line_no')
  if (items.error) throw items.error
  const rows = (items.data ?? []) as Omit<BomTemplateItem, 'sku' | 'product_name'>[]
  const products = await productNames(rows.map((r) => r.component_product_id))
  return {
    template: data as BomTemplateRow,
    items: rows.map((r) => ({ ...r, sku: products.get(r.component_product_id)?.sku ?? '?', product_name: products.get(r.component_product_id)?.product_name ?? 'Unknown product' })),
  }
}

async function productNames(ids: string[]) {
  const map = new Map<string, { sku: string; product_name: string; base_unit: string }>()
  if (ids.length === 0) return map
  const { data, error } = await db().from('products').select('id, sku, product_name, base_unit').in('id', [...new Set(ids)])
  if (error) throw error
  for (const p of data ?? []) map.set(p.id, p)
  return map
}

export interface TemplateHeader {
  template_name: string
  description: string | null
  category_id: string | null
  output_quantity: number
  output_unit: string
  source_bom_id?: string | null
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

export const saveTemplate = (templateId: string | null, header: TemplateHeader, items: BomToolItem[], key: string | null) =>
  rpc<{ template_id: string; template_name: string; components: number }>('bom_template_save', {
    p_template_id: templateId, p_template: header, p_items: items, p_idempotency_key: key,
  })

export const setTemplateStatus = (templateId: string, status: TemplateStatus) =>
  rpc<{ template_id: string; status: TemplateStatus; changed: boolean }>('bom_template_set_status', { p_template_id: templateId, p_status: status })

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
  cost_source: 'PURCHASE' | 'STANDARD' | null
  /** Available stock; null when the user may not see stock. */
  available: number | null
}

/** Cost and stock of components (one query each). Missing permissions give null values, never an error. */
export async function fetchComponentInfo(ids: string[]): Promise<Map<string, ComponentInfo>> {
  const unique = [...new Set(ids)].filter(Boolean)
  const map = new Map<string, ComponentInfo>()
  if (unique.length === 0) return map
  let rows: { id: string; sku: string; product_name: string; base_unit: string; cost: number | null; source: 'PURCHASE' | 'STANDARD' | null }[] = []
  const view = await db().from('product_master_list' as never).select('id, sku, product_name, base_unit, master_cost, master_cost_source').in('id', unique)
  if (!view.error) {
    rows = ((view.data ?? []) as { id: string; sku: string; product_name: string; base_unit: string; master_cost: number | null; master_cost_source: 'PURCHASE' | 'STANDARD' | null }[])
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
