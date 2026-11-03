// BOM spreadsheet import: one row per component, grouped by finished-product
// SKU. Pure TypeScript (no React/Supabase) so the rules are unit-tested.
//
// Each finished product becomes one new BOM version (draft, optionally
// activated). A BOM is imported complete or not at all: if any of its rows has
// an error, that whole BOM is held back and every row says why, so a BOM is
// never saved with a component silently missing. Other BOMs in the file still
// import.

import { BOM_OUTPUT_TYPES, BOM_SOURCE_LABELS, PRODUCT_TYPE_LABELS, findUnit, parseBomSource, parseProductType, skuKey, type BomSource, type ProductType } from '../products/product-model.ts'
import { planningChanges, validatePlanning, type BomPlanningPatch, type BomPlanningValues, type StoredPlanning } from './bom-planning-model.ts'
import { validateBomLine } from './production-model.ts'

export const MAX_BOM_IMPORT_ROWS = 5000

export const BOM_IMPORT_FIELDS = [
  { key: 'finished_sku', label: 'Finished Product SKU', required: true, synonyms: ['finished product sku', 'finished sku', 'fg sku', 'product sku', 'parent sku', 'output sku', 'assembly sku'] },
  // Product Planning & Classification (one value per BOM; stored on the finished product).
  { key: 'product_name', label: 'Product Name', required: false, synonyms: ['product name', 'finished product name', 'finished product', 'fg name'] },
  { key: 'product_type', label: 'Product Type', required: false, synonyms: ['product type', 'finished product type', 'type'] },
  { key: 'tax_rate', label: 'Tax Rate (%)', required: false, synonyms: ['tax rate (%)', 'tax rate', 'tax %', 'gst rate', 'gst rate (%)', 'gst %', 'gst'] },
  { key: 'lead_time_days', label: 'Lead Time (Days)', required: false, synonyms: ['lead time (days)', 'lead time days', 'lead time', 'lead days'] },
  { key: 'group_head', label: 'Group Head', required: false, synonyms: ['group head', 'grouphead', 'product group', 'group'] },
  { key: 'minimum_cover_days', label: 'Minimum Stock Days', required: false, synonyms: ['minimum stock days', 'min stock days', 'minimum stock (days)', 'minimum cover days'] },
  { key: 'component_sku', label: 'Component SKU', required: true, synonyms: ['component sku', 'component code', 'item code', 'material sku', 'child sku', 'raw material sku', 'component'] },
  { key: 'quantity', label: 'Quantity per Output', required: true, synonyms: ['quantity per output', 'quantity', 'qty', 'qty per unit', 'quantity required', 'qty required', 'quantity per finished product'] },
  { key: 'unit', label: 'Unit', required: false, synonyms: ['unit', 'uom', 'unit of measure', 'unit of measurement'] },
  { key: 'source', label: 'Source', required: false, synonyms: ['source', 'source type', 'component source', 'make or buy'] },
  { key: 'wastage', label: 'Wastage %', required: false, synonyms: ['wastage %', 'wastage', 'wastage percentage', 'scrap %', 'loss %'] },
  { key: 'supplier', label: 'Preferred Supplier', required: false, synonyms: ['preferred supplier', 'supplier', 'supplier code', 'vendor'] },
  { key: 'remarks', label: 'Remarks', required: false, synonyms: ['remarks', 'notes', 'comments', 'remark'] },
  { key: 'output_quantity', label: 'Output Quantity', required: false, synonyms: ['output quantity', 'output qty', 'batch quantity', 'batch size', 'bom quantity'] },
] as const

export type BomImportFieldKey = (typeof BOM_IMPORT_FIELDS)[number]['key']
export type BomColumnMapping = Record<BomImportFieldKey, number | null>

export interface BomImportProduct extends StoredPlanning {
  id: string
  sku: string
  product_name: string
  product_type: ProductType | string
  base_unit: string
  status: string
  archived?: boolean
}

/** The latest non-archived BOM version of a product, to avoid duplicate BOMs. */
export interface ExistingBom {
  id: string
  bom_code: string
  version: number
  status: string
  output_quantity: number
  items: { component_product_id: string; quantity_required: number; unit: string; wastage_percentage: number; source_type: string | null; preferred_supplier_id: string | null; notes: string | null }[]
}

/**
 * What saving a valid BOM does:
 *   new-version  - a new version (the latest one is active / approved and differs)
 *   update-draft - the latest version is still a draft and differs: it is updated in place
 *   unchanged    - the components match the latest version: no BOM is written
 *                  (planning fields are still updated on the product)
 */
export type BomSaveMode = 'new-version' | 'update-draft' | 'unchanged'

export interface BomImportSupplier {
  id: string
  supplier_code: string
  legal_name: string
  display_name?: string | null
  status: string
}

export interface BomImportContext {
  /** Products by skuKey(). */
  products: Map<string, BomImportProduct>
  suppliers: BomImportSupplier[]
  /** Active (approved) BOM version per finished product id, if any. */
  activeVersions?: Map<string, number>
  /** Latest non-archived BOM version per finished product id. */
  latestBoms?: Map<string, ExistingBom>
  /** The user may change the Product Master (products.update): needed to save planning fields. */
  canUpdateProducts?: boolean
}

export interface BomImportLine {
  rowNumber: number
  component: BomImportProduct
  quantity: number
  unit: string
  source: BomSource | null
  wastage: number
  supplierId: string | null
  remarks: string | null
}

export interface BomImportRow {
  rowNumber: number
  finishedSku: string
  componentSku: string
  errors: string[]
  warnings: string[]
}

export interface BomImportGroup {
  finishedSku: string
  product: BomImportProduct | null
  outputQuantity: number
  /** Row that set the output quantity (later rows must agree). */
  outputRow?: number
  lines: BomImportLine[]
  rows: BomImportRow[]
  /** Errors that block this BOM (its own and its rows'). */
  errors: string[]
  warnings: string[]
  status: 'valid' | 'error'
  /** Planning values given in the file and the row that set each one. */
  planning: Partial<BomPlanningValues>
  planningRows: Partial<Record<keyof BomPlanningValues, number>>
  /** Product columns that change (only fields that differ from the Product Master). */
  planningPatch: BomPlanningPatch
  planningChanges: { label: string; from: string; to: string }[]
  saveMode: BomSaveMode
  /** The BOM that is updated in place or matched (update-draft / unchanged). */
  existingBom?: ExistingBom
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9#%]+/g, ' ').trim()

export function autoMapBomColumns(headers: string[]): BomColumnMapping {
  const normalized = headers.map(normalizeHeader)
  const used = new Set<number>()
  const mapping = {} as BomColumnMapping
  for (const field of BOM_IMPORT_FIELDS) {
    const synonyms = field.synonyms.map(normalizeHeader)
    const index = normalized.findIndex((h, i) => !used.has(i) && h !== '' && synonyms.includes(h))
    mapping[field.key] = index >= 0 ? index : null
    if (index >= 0) used.add(index)
  }
  return mapping
}

export function detectBomHeaderRow(rows: string[][]): number {
  let best = -1
  let bestScore = 1
  rows.slice(0, 20).forEach((row, index) => {
    const score = Object.values(autoMapBomColumns(row)).filter((v) => v !== null).length
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  })
  return best >= 0 ? best : rows.findIndex((row) => row.some((cell) => cell !== ''))
}

export function missingBomFields(mapping: BomColumnMapping): string[] {
  return BOM_IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === null).map((f) => f.label)
}

function parseNumber(value: string): number | null {
  const v = value.trim().replace(/,/g, '').replace(/%$/, '').trim()
  if (v === '' || !/^\d+(\.\d+)?$/.test(v)) return null
  return Number(v)
}

/** Validates and groups rows. Never touches the database. */
export function validateBomRows(rows: string[][], mapping: BomColumnMapping, ctx: BomImportContext, firstDataRowNumber = 2): BomImportGroup[] {
  const cell = (row: string[], key: BomImportFieldKey) => {
    const index = mapping[key]
    return index === null ? '' : String(row[index] ?? '').trim()
  }
  const mapped = Object.values(mapping).filter((i): i is number => i !== null)
  const supplierByKey = new Map<string, BomImportSupplier>()
  for (const s of ctx.suppliers) {
    supplierByKey.set(s.supplier_code.trim().toLowerCase(), s)
    supplierByKey.set(s.legal_name.trim().toLowerCase(), s)
    if (s.display_name) supplierByKey.set(s.display_name.trim().toLowerCase(), s)
  }

  const groups = new Map<string, BomImportGroup>()
  const order: string[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + firstDataRowNumber
    if (mapped.every((i) => String(row[i] ?? '').trim() === '')) return
    const finishedSku = cell(row, 'finished_sku')
    const componentSku = cell(row, 'component_sku')
    const result: BomImportRow = { rowNumber, finishedSku, componentSku, errors: [], warnings: [] }

    const key = finishedSku ? skuKey(finishedSku) : `(row ${rowNumber})`
    let group = groups.get(key)
    if (!group) {
      const product = finishedSku ? ctx.products.get(skuKey(finishedSku)) ?? null : null
      group = { finishedSku, product, outputQuantity: 1, lines: [], rows: [], errors: [], warnings: [], status: 'valid',
        planning: {}, planningRows: {}, planningPatch: {}, planningChanges: [], saveMode: 'new-version' }
      if (!finishedSku) group.errors.push(`Row ${rowNumber}: Finished Product SKU is required.`)
      else if (!product) group.errors.push(`Finished product "${finishedSku}" is not in the Product Master. Add it first (it can be added with only a name and type).`)
      else if (product.archived || product.status !== 'ACTIVE') group.errors.push(`Finished product ${product.sku} is inactive.`)
      else if (!BOM_OUTPUT_TYPES.includes(product.product_type as ProductType)) {
        group.errors.push(`${product.sku} is a ${String(product.product_type).toLowerCase().replace(/_/g, ' ')}; raw materials, packing material and consumables cannot have a BOM.`)
      } else {
        const active = ctx.activeVersions?.get(product.id)
        if (active) group.warnings.push(`${product.sku} already has active BOM version ${active}. This import adds a new version; activating it replaces version ${active} (kept in history).`)
      }
      groups.set(key, group)
      order.push(key)
    }
    group.rows.push(result)

    // Output quantity: one value per BOM.
    const rawOutput = cell(row, 'output_quantity')
    if (rawOutput) {
      const out = parseNumber(rawOutput)
      if (out === null || out <= 0) result.errors.push(`Output Quantity "${rawOutput}" must be a number greater than zero.`)
      else if (group.outputRow === undefined) {
        group.outputQuantity = out
        group.outputRow = rowNumber
      } else if (out !== group.outputQuantity) {
        result.errors.push(`Output Quantity ${out} differs from ${group.outputQuantity} on row ${group.outputRow}. Use one output quantity per BOM.`)
      }
    }

    // Product Name / Product Type: checked against the Product Master (a BOM import never renames or retypes a product).
    const rawName = cell(row, 'product_name')
    if (rawName && group.product && rawName.toLowerCase().replace(/\s+/g, ' ') !== group.product.product_name.trim().toLowerCase().replace(/\s+/g, ' ')) {
      result.errors.push(`Product Name "${rawName}" does not match ${group.product.sku} in the Product Master ("${group.product.product_name}"). Correct the name or the SKU.`)
    }
    const rawType = cell(row, 'product_type')
    if (rawType) {
      const t = parseProductType(rawType)
      if (!t) result.errors.push(`Product Type "${rawType}" is not recognised. Use: ${Object.values(PRODUCT_TYPE_LABELS).join(', ')}.`)
      else if (group.product && t !== group.product.product_type) {
        result.errors.push(`Product Type "${rawType}" differs from the Product Master (${PRODUCT_TYPE_LABELS[group.product.product_type as ProductType] ?? group.product.product_type}). Change the type in the Product Master, not in a BOM file.`)
      }
    }

    // Planning fields: one value per BOM (later rows may repeat it or leave it blank).
    const planningCells: [keyof BomPlanningValues, string, string][] = [
      ['taxRate', cell(row, 'tax_rate'), 'Tax Rate (%)'], ['leadTimeDays', cell(row, 'lead_time_days'), 'Lead Time (Days)'],
      ['groupHead', cell(row, 'group_head'), 'Group Head'], ['minimumCoverDays', cell(row, 'minimum_cover_days'), 'Minimum Stock Days'],
    ]
    for (const [field, raw, label] of planningCells) {
      if (!raw) continue
      const { errors: problems, patch } = validatePlanning({ [field]: raw })
      const problem = problems[field]
      if (problem) { result.errors.push(problem); continue }
      const value = Object.values(patch)[0]
      const firstRow = group.planningRows[field]
      if (firstRow === undefined) {
        group.planning[field] = raw
        group.planningRows[field] = rowNumber
      } else {
        const firstValue = Object.values(validatePlanning({ [field]: group.planning[field] }).patch)[0]
        const differs = typeof value === 'string' ? value.toLowerCase() !== String(firstValue ?? '').toLowerCase() : value !== firstValue
        if (differs) result.errors.push(`${label} ${raw} differs from ${group.planning[field]} on row ${firstRow}. Use one value per BOM.`)
      }
    }

    // Component.
    const component = componentSku ? ctx.products.get(skuKey(componentSku)) ?? null : null
    if (!componentSku) result.errors.push('Component SKU is required.')
    else if (!component) result.errors.push(`Component "${componentSku}" is not in the Product Master. Add it first (name and type are enough).`)
    else if (component.archived || component.status !== 'ACTIVE') result.errors.push(`Component ${component.sku} is inactive.`)
    else if (group.product && component.id === group.product.id) result.errors.push('A product cannot be a component of itself.')
    else if (group.lines.some((l) => l.component.id === component.id)) {
      const first = group.lines.find((l) => l.component.id === component.id)!
      result.errors.push(`${component.sku} is listed twice for ${finishedSku} (first on row ${first.rowNumber}). Combine the quantities on one row.`)
    }

    // Unit must match the component's inventory unit (no conversion).
    const rawUnit = cell(row, 'unit')
    let unit = component?.base_unit ?? ''
    if (rawUnit && component) {
      const u = findUnit(rawUnit) ?? rawUnit.toUpperCase()
      if (u !== component.base_unit) result.errors.push(`Unit ${rawUnit} does not match the inventory unit of ${component.sku} (${component.base_unit}). Enter the quantity in ${component.base_unit}.`)
      unit = u
    }

    const rawQty = cell(row, 'quantity')
    const rawWastage = cell(row, 'wastage').replace(/%$/, '').trim()
    if (!rawQty) result.errors.push('Quantity per Output is required.')
    else {
      const problem = validateBomLine({ quantity: rawQty.replace(/,/g, ''), wastage: rawWastage, unit: component?.base_unit ?? unit })
      if (problem) result.errors.push(problem)
    }

    const rawSource = cell(row, 'source')
    let source: BomSource | null = null
    if (rawSource) {
      source = parseBomSource(rawSource)
      if (!source) result.errors.push(`Source "${rawSource}" is not recognised. Use: ${Object.values(BOM_SOURCE_LABELS).join(', ')} (or leave blank to use the product's default).`)
    }

    const rawSupplier = cell(row, 'supplier')
    let supplierId: string | null = null
    if (rawSupplier) {
      const s = supplierByKey.get(rawSupplier.toLowerCase())
      if (!s) result.warnings.push(`Supplier "${rawSupplier}" was not found by code or name; the component's preferred supplier is used instead.`)
      else if (s.status !== 'ACTIVE') result.warnings.push(`Supplier "${rawSupplier}" is inactive; the component's preferred supplier is used instead.`)
      else supplierId = s.id
    }

    const remarks = cell(row, 'remarks')
    if (remarks.length > 500) result.errors.push('Remarks are limited to 500 characters.')

    if (result.errors.length === 0 && component) {
      group.lines.push({
        rowNumber,
        component,
        quantity: Number(rawQty.replace(/,/g, '')),
        unit: component.base_unit,
        source,
        wastage: rawWastage === '' ? 0 : Number(rawWastage),
        supplierId,
        remarks: remarks || null,
      })
    }
  })

  // Finalise: a BOM with any error is held back as a whole.
  return order.map((k) => {
    const g = groups.get(k)!
    const bad = g.rows.filter((r) => r.errors.length > 0)
    if (bad.length > 0) g.errors.push(`${bad.length} row(s) have errors (row ${bad.map((r) => r.rowNumber).join(', ')}). The BOM is imported only when all its rows are correct.`)
    if (g.errors.length === 0 && g.lines.length === 0) g.errors.push('No components.')

    if (g.product && g.errors.length === 0) {
      // Planning fields: only what differs from the Product Master is written.
      const { patch, changes } = planningChanges(g.product, validatePlanning(g.planning).patch)
      g.planningPatch = patch
      g.planningChanges = changes
      if (changes.length > 0 && ctx.canUpdateProducts === false) {
        g.warnings.push(`Planning fields (${changes.map((c) => c.label).join(', ')}) are not saved: changing the Product Master needs the products.update permission.`)
        g.planningPatch = {}
        g.planningChanges = []
      }
      // Duplicate BOMs: compare with the latest non-archived version.
      const latest = ctx.latestBoms?.get(g.product.id)
      if (latest) {
        const activeWarning = (w: string) => w.startsWith(`${g.product!.sku} already has active BOM version`)
        if (sameComponents(latest, g)) {
          g.saveMode = 'unchanged'
          g.existingBom = latest
          g.warnings = g.warnings.filter((w) => !activeWarning(w))
          g.warnings.push(`Components match ${latest.bom_code} v${latest.version}: no new BOM version is created${g.planningChanges.length ? '; only the planning fields are updated' : ''}.`)
        } else if (latest.status === 'DRAFT' || latest.status === 'REJECTED') {
          g.saveMode = 'update-draft'
          g.existingBom = latest
          g.warnings = g.warnings.filter((w) => !activeWarning(w))
          g.warnings.push(`${latest.bom_code} v${latest.version} is still a draft: it is updated with these components instead of adding another version.`)
        }
      }
    }
    g.status = g.errors.length > 0 ? 'error' : 'valid'
    if (g.status === 'error') {
      for (const r of g.rows) {
        if (r.errors.length === 0) r.warnings.push(`Held back: another row of ${g.finishedSku || 'this BOM'} has an error, so the whole BOM was not imported.`)
      }
    }
    return g
  })
}

const eqText = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim()

/** Same output quantity and the same components with the same quantity, unit, wastage, source, supplier and remarks. */
export function sameComponents(bom: ExistingBom, g: Pick<BomImportGroup, 'outputQuantity' | 'lines'>): boolean {
  if (Number(bom.output_quantity) !== g.outputQuantity || bom.items.length !== g.lines.length) return false
  const stored = new Map(bom.items.map((i) => [i.component_product_id, i]))
  return g.lines.every((l) => {
    const s = stored.get(l.component.id)
    return !!s && Number(s.quantity_required) === l.quantity && s.unit === l.unit && Number(s.wastage_percentage) === l.wastage
      && (s.source_type ?? null) === (l.source ?? null) && (s.preferred_supplier_id ?? null) === (l.supplierId ?? null) && eqText(s.notes, l.remarks)
  })
}

export function summarizeBomImport(groups: BomImportGroup[]) {
  return {
    boms: groups.length,
    valid: groups.filter((g) => g.status === 'valid').length,
    errors: groups.filter((g) => g.status === 'error').length,
    rows: groups.reduce((s, g) => s + g.rows.length, 0),
    components: groups.filter((g) => g.status === 'valid').reduce((s, g) => s + g.lines.length, 0),
    newVersions: groups.filter((g) => g.status === 'valid' && g.saveMode === 'new-version').length,
    draftUpdates: groups.filter((g) => g.status === 'valid' && g.saveMode === 'update-draft').length,
    unchanged: groups.filter((g) => g.status === 'valid' && g.saveMode === 'unchanged').length,
    planningUpdates: groups.filter((g) => g.status === 'valid' && g.planningChanges.length > 0).length,
  }
}

/** Downloadable report: every row with its BOM outcome, errors and warnings. */
export function buildBomImportReport(groups: (BomImportGroup & { saveError?: string; result?: string })[]): (string | number)[][] {
  const header = ['Row', 'Finished Product SKU', 'Component SKU', 'Result', 'Errors', 'Warnings', 'Planning changes']
  const rows: (string | number)[][] = []
  for (const g of groups) {
    const outcome = g.saveError ? 'Failed' : g.status === 'error' ? 'Not imported' : g.result ?? 'Ready'
    const planning = (g.planningChanges ?? []).map((c) => `${c.label}: ${c.from} → ${c.to}`).join(' | ')
    g.rows.forEach((r, i) => {
      rows.push([r.rowNumber, r.finishedSku, r.componentSku, outcome, [...r.errors, ...(g.saveError ? [g.saveError] : []), ...g.errors.filter((e) => !e.includes('row(s) have errors'))].join(' | '),
        [...r.warnings, ...g.warnings].join(' | '), i === 0 ? planning : ''])
    })
  }
  return [header, ...rows.sort((a, b) => Number(a[0]) - Number(b[0]))]
}

/** Template rows: header plus an example of a finished good with a subassembly. */
export function bomTemplateRows(): (string | number)[][] {
  const planning = { product_name: 'Wall-hung closet', product_type: 'Finished Good', tax_rate: 18, lead_time_days: 12, group_head: 'Sanitaryware', minimum_cover_days: 15 }
  const lines: Partial<Record<BomImportFieldKey, string | number>>[] = [
    { finished_sku: 'FG-000001', ...planning, component_sku: 'SUB-000001', quantity: 1, unit: 'PCS', source: 'In-house', remarks: 'Flush tank assembly', output_quantity: 1 },
    { finished_sku: 'FG-000001', ...planning, component_sku: 'RM-000001', quantity: 18.5, unit: 'KG', source: 'Purchased', wastage: 3, supplier: 'S-CLAY', remarks: 'Ceramic body', output_quantity: 1 },
    { finished_sku: 'FG-000001', component_sku: 'OSC-000001', quantity: 1, unit: 'PCS', source: 'Outsourced', supplier: 'S-FIT', remarks: 'Chrome flush plate', output_quantity: 1 },
    { finished_sku: 'FG-000001', component_sku: 'PKG-000001', quantity: 1, unit: 'PCS', remarks: 'Carton', output_quantity: 1 },
  ]
  return [BOM_IMPORT_FIELDS.map((f) => f.label), ...lines.map((l) => BOM_IMPORT_FIELDS.map((f) => l[f.key] ?? ''))]
}
