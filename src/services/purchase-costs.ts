import type { ProductPurchaseCost, PurchaseCostHistory } from '@/features/products/purchase-cost'
import { requireSupabase } from '@/lib/supabase'

/**
 * Purchase Cost Intelligence (migration 20261123090000). Every call runs as the signed-in user; the functions
 * check products.read (and the override permission chosen in ERP Settings) inside the user's company.
 * The cost itself is written only by the goods receipt posting in the database, never from the browser.
 */
type UntypedRpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>
const rpc: UntypedRpc = (fn, args) => (requireSupabase().rpc as unknown as UntypedRpc)(fn, args)

/** The database update is not applied yet: the screens show no purchase cost instead of an error. */
export function isMissingFunction(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null
  return e?.code === 'PGRST202' || e?.code === '42883' || /could not find the function|does not exist/i.test(e?.message ?? '')
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

/** Last Purchase Cost of each product; with a supplier, also that supplier's latest valid price. */
export async function fetchPurchaseCosts(ids: string[], supplierId: string | null = null): Promise<Map<string, ProductPurchaseCost>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const out = new Map<string, ProductPurchaseCost>()
  for (let i = 0; i < unique.length; i += 500) {
    const { data, error } = await rpc('product_purchase_costs', { p_ids: unique.slice(i, i + 500), p_supplier: supplierId })
    if (error) {
      if (isMissingFunction(error)) return out
      throw error
    }
    for (const row of (data ?? []) as ProductPurchaseCost[]) {
      out.set(row.product_id, {
        ...row,
        last_cost: num(row.last_cost),
        previous_cost: num(row.previous_cost),
        difference: num(row.difference),
        change_percent: num(row.change_percent),
        supplier_last_cost: num(row.supplier_last_cost),
        threshold: Number(row.threshold ?? 10),
      })
    }
  }
  return out
}

/** Purchase Cost History of one product; null while the database update is not applied. */
export async function fetchPurchaseCostHistory(productId: string): Promise<PurchaseCostHistory | null> {
  const { data, error } = await rpc('product_purchase_cost_history', { p_product_id: productId })
  if (error) {
    if (isMissingFunction(error)) return null
    throw error
  }
  return data as PurchaseCostHistory
}

/** Exceptional manual override (permission chosen in ERP Settings → Products); recorded and audited. */
export async function overridePurchaseCost(productId: string, cost: number, reason: string) {
  const { data, error } = await rpc('product_purchase_cost_override', { p_product_id: productId, p_cost: cost, p_reason: reason })
  if (error) throw error
  return data as { event_id: string; cost: number }
}
