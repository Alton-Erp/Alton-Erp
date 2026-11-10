// Missing information on a product. These are recommendations only: a product
// is always saved, and the gaps are listed so they can be filled in later.
// Matches the "incomplete" and "without_bom" counts of public.product_kpis().

import { BOM_EXPECTED_TYPES, type ProductType } from './product-model.ts'

export interface CompletenessInput {
  product_type: ProductType | string
  status?: string
  hsn_code: string | null
  gst_rate: number | null
  category_id: string | null
  selling_price: number | null
  /** Cost (the one product cost; the database keeps standard_manufacturing_cost equal to it). */
  standard_cost: number | null
  /** Earlier column: equal to Cost after migration 20261127090000; read only so the rule matches product_kpis() before it. */
  standard_manufacturing_cost?: number | null
}

export interface ProductGap {
  key: 'hsn' | 'gst' | 'category' | 'price' | 'cost' | 'bom'
  message: string
}

/**
 * Lists missing information. `hasActiveBom` is only checked for finished goods
 * and subassemblies; pass `undefined` when it is not known (e.g. in an import).
 */
export function productGaps(p: CompletenessInput, hasActiveBom?: boolean): ProductGap[] {
  const gaps: ProductGap[] = []
  if (!p.hsn_code) gaps.push({ key: 'hsn', message: 'HSN code is missing (needed on GST invoices and purchase orders).' })
  if (p.gst_rate === null || p.gst_rate === undefined) gaps.push({ key: 'gst', message: 'GST rate is missing.' })
  if (!p.category_id) gaps.push({ key: 'category', message: 'No category assigned.' })
  if (p.product_type === 'FINISHED_GOOD') {
    if (p.selling_price === null || p.selling_price === undefined) gaps.push({ key: 'price', message: 'Selling price is missing.' })
  } else if ((p.standard_cost ?? null) === null && (p.standard_manufacturing_cost ?? null) === null) {
    gaps.push({ key: 'cost', message: 'Cost is missing, so production costs will be incomplete.' })
  }
  if (hasActiveBom === false && BOM_EXPECTED_TYPES.includes(p.product_type as ProductType)) {
    gaps.push({ key: 'bom', message: 'No active bill of materials, so material requirements cannot be calculated yet.' })
  }
  return gaps
}
