// Product Cost Intelligence (migration 20261208090000). Reads: views product_master_list / bom_cost_list and the
// table product_cost_history (RLS: products.read, production_bom.read). Every write goes through a database
// function (products.update): the cost rules run only in the database.
import { requireSupabase } from '@/lib/supabase'
import type { BomCostRow } from '@/features/production/bom-cost-columns'

const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: { code?: string; message: string } | null }>)(fn, args)
  if (error) throw error
  return data
}

/** True when the error means the migration is not applied (missing view, table or function). */
export const isMissingCostFeature = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code
  return code === 'PGRST205' || code === '42P01' || code === 'PGRST202' || code === '42883'
}

/** BOM list cost columns for the given BOMs (empty map before the migration). */
export async function fetchBomCosts(ids: string[]): Promise<Map<string, BomCostRow>> {
  const map = new Map<string, BomCostRow>()
  if (ids.length === 0) return map
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db().from('bom_cost_list' as never).select('*').in('bom_id', ids.slice(i, i + 200))
    if (error) {
      if (isMissingCostFeature(error)) return map
      throw error
    }
    for (const r of (data ?? []) as BomCostRow[]) map.set(r.bom_id, r)
  }
  return map
}

export interface ProductCostHistoryRow {
  id: string
  previous_cost: number | null
  new_cost: number
  previous_source: string | null
  new_source: 'BOM' | 'GRN' | 'MANUAL'
  event: string
  bom_id: string | null
  bom_code: string | null
  bom_version: number | null
  goods_receipt_id: string | null
  receipt_number: string | null
  reason: string
  created_by: string | null
  created_at: string
}

/** Cost history of one product, newest first (null before the migration). */
export async function fetchProductCostHistory(productId: string): Promise<ProductCostHistoryRow[] | null> {
  const { data, error } = await db().from('product_cost_history' as never).select('*').eq('product_id', productId)
    .order('created_at', { ascending: false }).limit(200)
  if (error) {
    if (isMissingCostFeature(error)) return null
    throw error
  }
  return (data ?? []) as ProductCostHistoryRow[]
}

export interface SourcingProposal {
  product_id: string
  sku: string
  product_name: string
  current_method: 'IN_HOUSE' | 'OUTSOURCED' | 'HYBRID'
  proposed_method: 'IN_HOUSE' | 'OUTSOURCED' | 'HYBRID'
  approved_boms: number
  posted_grns: number
  reason: string
}

/** Proposed sourcing method from the BOM and GRN history (read only). */
export async function fetchSourcingProposal(productId: string): Promise<SourcingProposal | null> {
  try {
    const rows = await rpc<SourcingProposal[]>('product_sourcing_proposals', { p_product_ids: [productId], p_only_different: false })
    return rows?.[0] ?? null
  } catch (e) {
    if (isMissingCostFeature(e)) return null
    throw e
  }
}

export const applySourcingMethod = (productId: string, method: SourcingProposal['proposed_method'], reason: string | null) =>
  rpc<{ changed: boolean; master_cost: number | null }>('product_sourcing_apply', { p_product_id: productId, p_method: method, p_reason: reason })

export const setDefaultCostSource = (productId: string, source: 'BOM' | 'GRN', reason: string | null) =>
  rpc<{ default_cost_source: 'BOM' | 'GRN'; master_cost: number | null }>('product_cost_set_default_source', { p_product_id: productId, p_source: source, p_reason: reason })

/** Recalculate BOM and Product Master costs (all, or the given products). History only where a cost changes. */
export const recalculateCosts = (productIds: string[] | null) =>
  rpc<{ products: number; changed: number }>('product_cost_recalculate', { p_product_ids: productIds })
