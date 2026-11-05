// "Products with Missing Information" list: which of the four checks of product_kpis.incomplete
// a product misses (HSN code, GST rate, category, and the selling price or a cost for its type).
// Built on productGaps(); the BOM check is not part of this count.

import { productGaps, type CompletenessInput, type ProductGap } from './product-completeness.ts'

const SHORT: Record<Exclude<ProductGap['key'], 'bom'>, string> = {
  hsn: 'HSN code', gst: 'GST rate', category: 'Category', price: 'Selling price', cost: 'Standard / manufacturing cost',
}
const CHECKS = 4

export interface MissingInfo {
  missing: string[]
  done: number
  total: number
  percent: number
}

export function missingInfo(p: CompletenessInput): MissingInfo {
  const missing = productGaps(p).filter((g) => g.key !== 'bom').map((g) => SHORT[g.key as Exclude<ProductGap['key'], 'bom'>])
  const done = CHECKS - missing.length
  return { missing, done, total: CHECKS, percent: Math.round((100 * done) / CHECKS) }
}
