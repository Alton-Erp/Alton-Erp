// BOM tools (clone, generate multiple, comparison): pure helpers shared by the screens.
//
// Cost uses the existing BOM cost method (bom_version_history / bomUnitCost): per finished unit, each
// component costs quantity × (1 + wastage %) × unit cost ÷ output quantity (4 decimals), and the BOM
// costs the sum (2 decimals). The unit cost is the component's Product Master Cost (product_master_list,
// with its standard-cost fallback). Nothing here is stored; no cost, stock or ledger value is changed.

import type { ProductFormValues } from '../products/product-validation.ts'
import type { ProductInput } from '../products/product-model.ts'
import { validateBomLine } from './production-model.ts'

/** Rounds half away from zero to `d` decimals without binary floating-point drift (2.675 → 2.68). */
export function roundTo(v: number, d: number): number {
  const s = Number(v.toPrecision(12))
  const t = String(s)
  if (/e/i.test(t)) return Math.round(s * 10 ** d) / 10 ** d
  const r = Number(`${Math.round(Number(`${Math.abs(s)}e${d}`))}e-${d}`)
  return s < 0 ? -r : r
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

export interface CostLine {
  quantity: number | string
  wastage: number | string
  /** Product Master Cost of the component per inventory unit; null when it has none. */
  unitCost: number | null | undefined
}

export interface BomCostLine {
  /** Cost of the line for one BOM batch (the output quantity), incl. wastage. */
  batchCost: number | null
  /** Cost of the line per finished unit (4 decimals, as the BOM version history). */
  perUnit: number | null
}

export interface BomCost {
  lines: BomCostLine[]
  /** Total material cost of one BOM batch (2 decimals), over the lines with a cost. */
  total: number
  /** Material cost per finished unit (2 decimals), over the lines with a cost. */
  perUnit: number
  /** False when a component has no cost: the totals are then incomplete. */
  complete: boolean
  missing: number
  /** True when no component has a cost (the totals mean nothing). */
  none: boolean
}

/** Material cost of a BOM: Component Cost = Required Quantity × (1 + wastage %) × Unit Cost. */
export function bomCost(lines: CostLine[], outputQuantity: number | string): BomCost {
  const out = num(outputQuantity)
  const result: BomCostLine[] = lines.map((l) => {
    const q = num(l.quantity)
    const w = num(l.wastage) ?? 0
    const c = num(l.unitCost)
    if (q === null || c === null) return { batchCost: null, perUnit: null }
    const batch = q * (1 + w / 100) * c
    return { batchCost: batch, perUnit: out && out > 0 ? roundTo(batch / out, 4) : null }
  })
  const missing = result.filter((l) => l.batchCost === null).length
  return {
    lines: result.map((l) => ({ ...l, batchCost: l.batchCost === null ? null : roundTo(l.batchCost, 2) })),
    total: roundTo(result.reduce((s, l) => s + (l.batchCost ?? 0), 0), 2),
    perUnit: roundTo(result.reduce((s, l) => s + (l.perUnit ?? 0), 0), 2),
    complete: missing === 0 && lines.length > 0,
    missing,
    none: missing === lines.length,
  }
}

/** Cost difference of a BOM from its source BOM (per finished unit). */
export function costDifference(current: number | null, source: number | null): { amount: number | null; percent: number | null } {
  if (current === null || source === null) return { amount: null, percent: null }
  const amount = roundTo(current - source, 2)
  return { amount, percent: source > 0 ? roundTo((amount / source) * 100, 2) : null }
}

// ---------------------------------------------------------------------------
// Component lines (editor state)
// ---------------------------------------------------------------------------
export interface ComponentRef {
  product_id: string
  sku: string
  product_name: string
  base_unit: string
  /** Available stock (storage less reserved) when the user may see stock; null otherwise. */
  available?: number | null
}

export interface EditorLine {
  key: string
  product: ComponentRef | null
  quantity: string
  wastage: string
  notes: string
  /** '' = the component's default source. */
  source: string
  /** '' = the component's preferred supplier. */
  supplierId: string
}

export const newLine = (wastage = '0'): EditorLine => ({ key: crypto.randomUUID(), product: null, quantity: '', wastage, notes: '', source: '', supplierId: '' })

/** A line whose component was cleared (× on the line): same position and key, empty component, default quantity and wastage, no remarks. */
export const clearLineComponent = (line: EditorLine, wastage = '0'): EditorLine => ({ ...newLine(wastage), key: line.key })

/** Stored component rows (BOM or template items) as editable lines. */
export function linesFromItems(items: {
  component_product_id: string; sku: string; product_name: string; unit?: string; inventory_unit?: string | null
  quantity_required: number | string; wastage_percentage: number | string; notes: string | null; source_type?: string | null; preferred_supplier_id?: string | null
}[]): EditorLine[] {
  return items.map((i) => ({
    key: crypto.randomUUID(),
    product: { product_id: i.component_product_id, sku: i.sku, product_name: i.product_name, base_unit: i.inventory_unit ?? i.unit ?? '' },
    quantity: String(Number(i.quantity_required)),
    wastage: String(Number(i.wastage_percentage)),
    notes: i.notes ?? '',
    source: i.source_type ?? '',
    supplierId: i.preferred_supplier_id ?? '',
  }))
}

/** A saved BOM whose components were copied into a generated product (provenance only; it is never changed). */
export interface TemplateRef {
  bom_id: string
  bom_code: string
  version: number
  sku: string
  product_name: string
  components: number
}

/**
 * Exact sum of two non-negative decimal quantities as text (no floating-point error: 0.1 + 0.2 = "0.3"). A blank value counts as 0.
 * Null when either value is not a plain non-negative number.
 */
export function addQuantities(a: string, b: string): string | null {
  const plain = (v: string): string | null => {
    const t = v.trim()
    if (t === '') return '0'
    if (/^\d+(\.\d+)?$/.test(t)) return t
    if (/^\d*\.\d+$/.test(t)) return `0${t}`
    // Values from the database may come as numbers in exponent form (e.g. "1e-7"): BOM quantities have at most 6 decimals.
    const n = Number(t)
    return Number.isFinite(n) && n >= 0 && /e/i.test(t) ? n.toFixed(6) : null
  }
  const x = plain(a)
  const y = plain(b)
  if (x === null || y === null) return null
  const scale = Math.max((x.split('.')[1] ?? '').length, (y.split('.')[1] ?? '').length)
  const big = (v: string) => BigInt((v.split('.')[0] ?? '0') + (v.split('.')[1] ?? '').padEnd(scale, '0'))
  const sum = (big(x) + big(y)).toString().padStart(scale + 1, '0')
  if (scale === 0) return sum
  const out = `${sum.slice(0, -scale)}.${sum.slice(-scale)}`.replace(/0+$/, '').replace(/\.$/, '')
  return out
}

/** The result of copying a template BOM into a product's component list. */
export interface TemplateApplyResult {
  lines: EditorLine[]
  /** SKUs whose Required Qty was increased (add). */
  merged: string[]
  /** SKUs appended as new lines. */
  added: string[]
  /** Why nothing was changed (add: different inventory unit, invalid quantity); null when applied. */
  error: string | null
}

const sameComponent = (a: ComponentRef, b: ComponentRef) =>
  a.product_id === b.product_id || (a.sku.trim() !== '' && a.sku.trim().toLowerCase() === b.sku.trim().toLowerCase())

/**
 * Copies a template BOM's component lines into a product's own editable list. The copies are new objects with new keys (nothing is
 * shared with the source lines, so editing them cannot change the template).
 *  - 'replace': the template's lines only.
 *  - 'add': merge. A template component already in the list (same product id or SKU) increases that line's Required Qty by the
 *    template quantity (exact decimal sum; the line keeps its wastage, remarks, source and supplier); others are appended. Running it
 *    again adds the quantities again. All or nothing: a different inventory unit (no unit conversion exists) or an invalid quantity on
 *    the existing line changes nothing and returns `error`.
 */
export function applyTemplateLines(current: EditorLine[], template: EditorLine[], mode: 'replace' | 'add'): TemplateApplyResult {
  const copies = template.filter((l) => l.product).map((l) => ({ ...l, key: crypto.randomUUID(), product: { ...l.product! } }))
  if (mode === 'replace') return { lines: copies, merged: [], added: copies.map((l) => l.product.sku), error: null }
  const lines = filledLines(current).map((l) => ({ ...l }))
  const merged: string[] = []
  const added: string[] = []
  for (const t of copies) {
    const i = lines.findIndex((l) => l.product && sameComponent(l.product, t.product))
    if (i < 0) {
      lines.push(t)
      added.push(t.product.sku)
      continue
    }
    const existing = lines[i]
    const unitA = existing.product!.base_unit.trim().toUpperCase()
    const unitB = t.product.base_unit.trim().toUpperCase()
    if (unitA !== unitB) {
      return { lines: current, merged: [], added: [], error: `${t.product.sku}: the list has it in ${existing.product!.base_unit || '?'} but the template in ${t.product.base_unit || '?'}. ` +
        'Quantities in different units cannot be added (no unit conversion is set up). Nothing was changed; adjust the line by hand.' }
    }
    const q = addQuantities(existing.quantity, t.quantity)
    if (q === null) {
      return { lines: current, merged: [], added: [], error: `${existing.product!.sku}: enter a valid Required Qty on its line before adding (now “${existing.quantity}”). Nothing was changed.` }
    }
    lines[i] = { ...existing, quantity: q }
    merged.push(t.product.sku)
  }
  return { lines, merged, added, error: null }
}

/** Lines that hold something (a component or a quantity). */
export const filledLines = (lines: EditorLine[]) => lines.filter((l) => l.product || l.quantity.trim() !== '')

/**
 * Problem with a component list, or null. Same rules as the BOM editor and the database: a component
 * on one line only, not the output product, quantity > 0 (whole pieces for PCS/NOS/SET/PAIR), wastage 0–99.99 %.
 */
export function componentProblem(lines: EditorLine[], outputProductId?: string | null): string | null {
  const filled = filledLines(lines)
  if (filled.length === 0) return 'Add at least one component.'
  const seen = new Map<string, number>()
  for (const [i, l] of filled.entries()) {
    const n = i + 1
    if (!l.product) return `Line ${n}: select the component.`
    if (outputProductId && l.product.product_id === outputProductId) return `Line ${n}: a product cannot be a component of itself.`
    const dup = seen.get(l.product.product_id)
    if (dup) return `Line ${n}: ${l.product.sku} is already on line ${dup}. Combine the quantities on one line.`
    seen.set(l.product.product_id, n)
    const p = validateBomLine({ quantity: l.quantity, wastage: l.wastage, unit: l.product.base_unit })
    if (p) return `Line ${n} (${l.product.sku}): ${p}`
  }
  return null
}

/** Lines as BOM / template items for the database (unit = the component's inventory unit). */
export function itemsFromLines(lines: EditorLine[]) {
  // Only lines with a component (componentProblem refuses a quantity without one before anything is saved).
  return filledLines(lines).filter((l) => l.product).map((l) => ({
    component_product_id: l.product!.product_id,
    quantity_required: Number(l.quantity),
    unit: l.product!.base_unit,
    wastage_percentage: Number(l.wastage.trim() || 0),
    notes: l.notes.trim() || null,
    source_type: l.source || null,
    preferred_supplier_id: l.supplierId || null,
  }))
}

/** What changed in a component list compared with its source (by component). */
export function lineChanges(source: EditorLine[], current: EditorLine[]): { added: string[]; removed: string[]; changed: string[] } {
  const s = new Map(filledLines(source).filter((l) => l.product).map((l) => [l.product!.product_id, l]))
  const c = new Map(filledLines(current).filter((l) => l.product).map((l) => [l.product!.product_id, l]))
  const added = [...c.values()].filter((l) => !s.has(l.product!.product_id)).map((l) => l.product!.sku)
  const removed = [...s.values()].filter((l) => !c.has(l.product!.product_id)).map((l) => l.product!.sku)
  const changed = [...c.values()].filter((l) => {
    const o = s.get(l.product!.product_id)
    return o && (Number(o.quantity) !== Number(l.quantity) || Number(o.wastage || 0) !== Number(l.wastage || 0))
  }).map((l) => l.product!.sku)
  return { added, removed, changed }
}

// ---------------------------------------------------------------------------
// Comparison of two or more BOMs
// ---------------------------------------------------------------------------
export interface CompareBom {
  id: string
  label: string
  output_quantity: number | string
  items: { component_product_id: string; sku: string; product_name: string; unit: string; quantity_required: number | string; wastage_percentage: number | string }[]
}

export type CompareState = 'SAME' | 'ADDED' | 'REMOVED' | 'CHANGED' | 'BASE' | 'ABSENT'

export interface CompareCell {
  /** Quantity per finished unit, before wastage (6 decimals); null when the component is not in this BOM. */
  perUnit: number | null
  wastage: number | null
  /** Component cost per finished unit incl. wastage; null when absent or without a cost. */
  cost: number | null
  state: CompareState
}

export interface CompareRow {
  component_product_id: string
  sku: string
  product_name: string
  unit: string
  unitCost: number | null
  cells: CompareCell[]
  /** True when the component is not the same in every BOM. */
  differs: boolean
}

export interface CompareResult {
  rows: CompareRow[]
  /** difference / percent against the baseline, only when both totals are complete. */
  totals: { perUnit: number; complete: boolean; none: boolean; difference: number | null; percent: number | null }[]
}

/**
 * Components of several BOMs side by side, per finished unit (so BOMs with different output quantities
 * compare). The first BOM is the baseline: in each other BOM a component is ADDED (not in the baseline),
 * REMOVED (only in the baseline), CHANGED (quantity or wastage differs) or SAME.
 */
export function compareBoms(boms: CompareBom[], unitCost: (productId: string) => number | null): CompareResult {
  const order: string[] = []
  const info = new Map<string, { sku: string; product_name: string; unit: string }>()
  for (const b of boms) {
    for (const i of b.items) {
      if (!info.has(i.component_product_id)) {
        order.push(i.component_product_id)
        info.set(i.component_product_id, { sku: i.sku, product_name: i.product_name, unit: i.unit })
      }
    }
  }
  const rows = order.map((id): CompareRow => {
    const cost = unitCost(id)
    const cells = boms.map((b): CompareCell => {
      const it = b.items.find((x) => x.component_product_id === id)
      const out = num(b.output_quantity) ?? 1
      if (!it) return { perUnit: null, wastage: null, cost: null, state: 'ABSENT' }
      const w = num(it.wastage_percentage) ?? 0
      const perUnit = roundTo(Number(it.quantity_required) / out, 6)
      return { perUnit, wastage: w, cost: cost === null ? null : roundTo((Number(it.quantity_required) * (1 + w / 100) * cost) / out, 4), state: 'SAME' }
    })
    const base = cells[0]
    cells.forEach((c, i) => {
      if (i === 0) c.state = c.perUnit === null ? 'ABSENT' : 'BASE'
      else if (c.perUnit === null) c.state = base.perUnit === null ? 'ABSENT' : 'REMOVED'
      else if (base.perUnit === null) c.state = 'ADDED'
      else c.state = c.perUnit !== base.perUnit || c.wastage !== base.wastage ? 'CHANGED' : 'SAME'
    })
    const present = cells.filter((c) => c.perUnit !== null)
    const differs = present.length !== cells.length || present.some((c) => c.perUnit !== present[0].perUnit || c.wastage !== present[0].wastage)
    return { component_product_id: id, ...info.get(id)!, unitCost: cost, cells, differs }
  })
  const totals = boms.map((b) => bomCost(b.items.map((i) => ({ quantity: i.quantity_required, wastage: i.wastage_percentage, unitCost: unitCost(i.component_product_id) })), b.output_quantity))
  const base = totals[0]?.complete ? totals[0].perUnit : null
  return {
    rows,
    totals: totals.map((t, i) => {
      const d = i === 0 || !t.complete ? { amount: null, percent: null } : costDifference(t.perUnit, base)
      return { perUnit: t.perUnit, complete: t.complete, none: t.none, difference: d.amount, percent: d.percent }
    }),
  }
}

// ---------------------------------------------------------------------------
// New product details (Generate multiple, rows that are new products)
// ---------------------------------------------------------------------------

/**
 * The new product starts as a copy of the source product's Product Master fields, except what identifies
 * the source or is its own value: SKU, name, barcode, EAN, image, model / supplier numbers and its Cost
 * (the new product's cost is entered when known; the BOM estimate is shown instead).
 */
export function similarProductValues(source: ProductFormValues, overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    ...source,
    sku: '', product_name: '', barcode: '', ean: '', image_url: '', model_number: '', supplier_model_number: '', supplier_product_name: '',
    standard_cost: '', status: 'ACTIVE', has_bom: false,
    ...overrides,
  }
}

/** Product Master fields copied from the source product without a field on the screen (shown read-only). */
/** The validated product as sent to bom_create_similar_products (status and BOM flag are set by the database). */
export function productPayload(input: ProductInput): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...input }
  delete rest.status
  return rest
}
