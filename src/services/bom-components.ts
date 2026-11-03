import { requireSupabase } from '@/lib/supabase'
import type { ProductOption } from '@/services/inventory'

/** A product offered as a BOM component, with its available stock when the user may see stock. */
export interface BomComponentOption extends ProductOption {
  barcode: string | null
  supplier_model_number: string | null
  product_type: string
  default_source_type: string
  preferred_supplier_id: string | null
  /** Available (storage stock less reserved); null when stock is not visible to the user. */
  available: number | null
}

const COLUMNS = 'id, sku, product_name, base_unit, track_batches, track_expiry, status, barcode, ean, supplier_model_number, product_type, default_source_type, preferred_supplier_id'

/** Characters allowed in search terms (keeps PostgREST filter syntax safe). */
const clean = (term: string) => term.replace(/[^\p{L}\p{N} ._/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)

type Row = {
  id: string; sku: string; product_name: string; base_unit: string; track_batches: boolean; track_expiry: boolean; status: string
  barcode: string | null; ean: string | null; supplier_model_number: string | null; product_type: string; default_source_type: string; preferred_supplier_id: string | null
}

async function withStock(rows: Row[]): Promise<BomComponentOption[]> {
  const stock = new Map<string, number>()
  let visible = false
  if (rows.length > 0) {
    // Stock needs inventory.read; without it the list still works, just without stock.
    const { data, error } = await requireSupabase().from('inventory_product_stock').select('product_id, available').in('product_id', rows.map((r) => r.id))
    if (!error) {
      visible = true
      for (const s of (data ?? []) as { product_id: string; available: number }[]) stock.set(s.product_id, Number(s.available))
    }
  }
  return rows.map((p) => ({
    product_id: p.id, sku: p.sku, product_name: p.product_name, base_unit: p.base_unit, track_batches: p.track_batches, track_expiry: p.track_expiry,
    product_status: p.status, barcode: p.barcode, supplier_model_number: p.supplier_model_number, product_type: p.product_type,
    default_source_type: p.default_source_type, preferred_supplier_id: p.preferred_supplier_id,
    available: visible ? (stock.get(p.id) ?? 0) : null,
  }))
}

/** Type-ahead: active products whose name, SKU, barcode, EAN or supplier model number contains the term. */
export async function searchBomComponents(term: string, limit = 20): Promise<BomComponentOption[]> {
  const t = clean(term)
  let q = requireSupabase().from('products').select(COLUMNS).is('archived_at', null).eq('status', 'ACTIVE').order('sku').limit(limit)
  if (t) q = q.or(['product_name', 'sku', 'barcode', 'ean', 'supplier_model_number'].map((c) => `${c}.ilike.%${t}%`).join(','))
  const { data, error } = await q
  if (error) throw error
  return withStock((data ?? []) as Row[])
}

/** Exact match on barcode, EAN, SKU or supplier model number (what a barcode scanner sends, followed by Enter). */
export async function findBomComponentByCode(code: string): Promise<BomComponentOption[]> {
  const t = clean(code).replace(/\s/g, '')
  if (!t) return []
  const { data, error } = await requireSupabase().from('products').select(COLUMNS).is('archived_at', null).eq('status', 'ACTIVE')
    .or(`barcode.eq.${t},ean.eq.${t},sku.ilike.${t},supplier_model_number.ilike.${t}`).limit(5)
  if (error) throw error
  // ilike treats "_" as a wildcard: keep only exact (case-insensitive) matches.
  const k = t.toLowerCase()
  return withStock(((data ?? []) as Row[]).filter((p) => p.barcode === t || p.ean === t || p.sku.toLowerCase() === k || p.supplier_model_number?.toLowerCase() === k))
}
