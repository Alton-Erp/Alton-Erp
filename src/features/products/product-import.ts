// Spreadsheet import: column mapping and row validation. Pure TypeScript (no
// React/Supabase) so the rules are unit-tested in tests/unit. Previewing and
// validating never touches the database; saving is a separate explicit step.
//
// V2 rules:
//   * Only Product Name and Product Type are needed. A blank SKU gets the next
//     automatic code, a blank source type / unit gets its default; each is a
//     warning, never an error.
//   * Existing SKUs can be skipped, treated as errors, or UPDATED. An update
//     changes only the columns that have a value in the file (a blank cell never
//     erases data) and lists every field change (old → new) for review first.

import { productGaps, type ProductGap } from './product-completeness.ts'
import {
  PRODUCT_TYPE_LABELS,
  SKU_PREFIXES,
  SOURCE_TYPE_LABELS,
  defaultSourceFor,
  findUnit,
  parseProductType,
  parseSourceType,
  skuKey,
  type ProductInput,
} from './product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct, type ProductField, type ProductFormValues } from './product-validation.ts'

export const MAX_IMPORT_ROWS = 5000
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024

export const IMPORT_FIELDS = [
  { key: 'sku', label: 'SKU', required: false, synonyms: ['sku', 'sku code', 'product code', 'item code', 'code'] },
  { key: 'product_name', label: 'Product Name', required: true, synonyms: ['product name', 'name', 'item name', 'product'] },
  { key: 'description', label: 'Description', required: false, synonyms: ['description', 'product description', 'details'] },
  { key: 'category', label: 'Category', required: false, synonyms: ['category', 'product category', 'category name', 'category code'] },
  { key: 'brand', label: 'Manufacturer / Brand', required: false, synonyms: ['brand', 'brand name', 'manufacturer', 'make', 'manufacturer brand'] },
  { key: 'model_number', label: 'Model Number', required: false, synonyms: ['model number', 'model no', 'model', 'model #'] },
  { key: 'barcode', label: 'Barcode', required: false, synonyms: ['barcode', 'upc', 'gtin', 'bar code'] },
  { key: 'ean', label: 'EAN', required: false, synonyms: ['ean', 'ean code', 'ean number', 'ean 13', 'ean13', 'ean 8', 'ean8', 'european article number'] },
  { key: 'supplier_model_number', label: 'Supplier Model No.', required: false, synonyms: ['supplier model no', 'supplier model no.', 'supplier model number', 'supplier model', 'vendor model no', 'vendor model number'] },
  { key: 'supplier_product_name', label: 'Supplier Product Name', required: false, synonyms: ['supplier product name', 'supplier item name', 'vendor product name', 'vendor item name', 'supplier description'] },
  { key: 'product_type', label: 'Product Type', required: true, synonyms: ['product type', 'type', 'item type'] },
  { key: 'source_type', label: 'Source Type', required: false, synonyms: ['source type', 'source', 'default source', 'default source type', 'sourcing'] },
  { key: 'unit', label: 'Unit', required: false, synonyms: ['unit', 'uom', 'unit of measure', 'unit of measurement', 'base unit'] },
  { key: 'length_cm', label: 'Length (cm)', required: false, synonyms: ['length (cm)', 'length cm', 'length'] },
  { key: 'width_cm', label: 'Width (cm)', required: false, synonyms: ['width (cm)', 'width cm', 'width', 'breadth'] },
  { key: 'height_cm', label: 'Height (cm)', required: false, synonyms: ['height (cm)', 'height cm', 'height', 'depth'] },
  { key: 'hsn_code', label: 'HSN Code', required: false, synonyms: ['hsn code', 'hsn', 'hsn/sac', 'hsn sac'] },
  { key: 'gst_rate', label: 'GST Rate', required: false, synonyms: ['gst rate', 'gst', 'gst %', 'gst rate (%)', 'gst rate %', 'tax rate'] },
  { key: 'selling_price', label: 'Selling Price', required: false, synonyms: ['selling price', 'sale price', 'price', 'rate'] },
  { key: 'mrp', label: 'MRP', required: false, synonyms: ['mrp', 'mrp (inr)', 'maximum retail price', 'm.r.p', 'm r p'] },
  { key: 'standard_cost', label: 'Standard Purchase Cost', required: false, synonyms: ['standard purchase cost', 'purchase cost', 'standard cost', 'cost', 'cost price', 'purchase price'] },
  { key: 'standard_manufacturing_cost', label: 'Standard Manufacturing Cost', required: false, synonyms: ['standard manufacturing cost', 'manufacturing cost', 'mfg cost', 'production cost'] },
  { key: 'minimum_selling_price', label: 'Minimum Selling Price', required: false, synonyms: ['minimum selling price', 'min selling price', 'min price'] },
  { key: 'lead_time_days', label: 'Lead Time (Days)', required: false, synonyms: ['lead time (days)', 'lead time days', 'lead time', 'lead days'] },
  { key: 'reorder_level_days', label: 'Reorder Level (Days)', required: false, synonyms: ['reorder level (days)', 'reorder level days', 'reorder days', 'days of cover'] },
  { key: 'minimum_cover_days', label: 'Minimum Stock Days', required: false, synonyms: ['minimum stock days', 'min stock days', 'minimum stock (days)', 'minimum cover days', 'minimum days of cover'] },
  { key: 'group_head', label: 'Group Head', required: false, synonyms: ['group head', 'grouphead', 'product group', 'group'] },
  { key: 'is_manufacturable', label: 'Manufacturable', required: false, synonyms: ['manufacturable', 'is manufacturable'] },
  { key: 'preferred_supplier', label: 'Preferred Supplier', required: false, synonyms: ['preferred supplier', 'supplier', 'vendor', 'supplier code'] },
  { key: 'remarks', label: 'Remarks', required: false, synonyms: ['remarks', 'remark', 'notes', 'comments'] },
] as const

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key']
export type ColumnMapping = Record<ImportFieldKey, number | null>
export type DuplicateMode = 'skip' | 'error' | 'update'

export interface ImportCategory {
  id: string
  name: string
  code: string
  is_active: boolean
}

export interface ImportSupplier {
  id: string
  supplier_code: string
  legal_name: string
  display_name?: string | null
  status: string
}

/** The stored product an "update" row is compared with. */
export interface ExistingProduct {
  id: string
  sku: string
  values: ProductFormValues
}

export interface FieldChange {
  field: keyof ProductInput
  label: string
  from: string
  to: string
}

export interface ImportRowResult {
  /** Spreadsheet row number (header is row 1). */
  rowNumber: number
  sku: string
  productName: string
  status: 'valid' | 'skipped' | 'error'
  /** What saving a valid row does. */
  action?: 'create' | 'update'
  /** For updates: the product being changed and the field-level changes. */
  productId?: string
  changes?: FieldChange[]
  errors: string[]
  warnings: string[]
  /** Full insert payload (create) or only the changed fields (update). */
  input: ProductInput | null
}

export interface ImportContext {
  categories: ImportCategory[]
  /** skuKey() of SKUs already in the product master. */
  existingSkus: Set<string>
  existingBarcodes: Set<string>
  /** Product id that owns each EAN already in the product master (company-wide). */
  eanOwners?: Map<string, string>
  duplicateMode: DuplicateMode
  /** Needed for update mode: stored products by skuKey(). */
  existingProducts?: Map<string, ExistingProduct>
  /** Product id that owns each existing barcode (lets an update keep its own barcode). */
  barcodeOwners?: Map<string, string>
  suppliers?: ImportSupplier[]
}

const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9#%]+/g, ' ').trim()

/** Maps each field to the first matching header (each header used once). */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader)
  const used = new Set<number>()
  const mapping = {} as ColumnMapping
  for (const field of IMPORT_FIELDS) {
    const synonyms = field.synonyms.map(normalizeHeader)
    const index = normalized.findIndex((h, i) => !used.has(i) && h !== '' && synonyms.includes(h))
    mapping[field.key] = index >= 0 ? index : null
    if (index >= 0) used.add(index)
  }
  return mapping
}

/**
 * Picks the header row: among the first 20 rows, the one whose cells match
 * the most known column names (so title rows above the table are skipped).
 * Falls back to the first non-blank row. Returns -1 for an empty sheet.
 */
export function detectHeaderRow(rows: string[][]): number {
  let best = -1
  let bestScore = 1 // need at least 2 recognised headers
  rows.slice(0, 20).forEach((row, index) => {
    const score = Object.values(autoMapColumns(row)).filter((v) => v !== null).length
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  })
  return best >= 0 ? best : rows.findIndex((row) => row.some((cell) => cell !== ''))
}

/** Splits rows at the header; firstDataRowNumber is the spreadsheet row of data[0]. */
export function splitAtHeader(rows: string[][], headerIndex: number) {
  return {
    headers: rows[headerIndex] ?? [],
    data: rows.slice(headerIndex + 1),
    firstDataRowNumber: headerIndex + 2,
  }
}

/** Required columns for the chosen mode (updates only need SKU and one field to change). */
export function missingRequiredFields(mapping: ColumnMapping, mode: DuplicateMode = 'skip'): string[] {
  if (mode === 'update' && mapping.sku === null) return ['SKU (needed to find the products to update)']
  return IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === null).map((f) => f.label)
}

function parseBoolean(value: string): boolean | null | undefined {
  const v = value.trim().toLowerCase()
  if (v === '') return undefined
  if (['yes', 'y', 'true', '1'].includes(v)) return true
  if (['no', 'n', 'false', '0'].includes(v)) return false
  return null
}

const FIELD_LABELS: Partial<Record<ProductField, string>> = {
  sku: 'SKU',
  product_name: 'Product Name',
  description: 'Description',
  category_id: 'Category',
  brand: 'Manufacturer / Brand',
  model_number: 'Model Number',
  barcode: 'Barcode',
  ean: 'EAN',
  group_head: 'Group Head',
  minimum_cover_days: 'Minimum Stock Days',
  product_type: 'Product Type',
  default_source_type: 'Source Type',
  base_unit: 'Unit',
  hsn_code: 'HSN Code',
  gst_rate: 'GST Rate',
  selling_price: 'Selling Price',
  standard_cost: 'Standard Purchase Cost',
  standard_manufacturing_cost: 'Standard Manufacturing Cost',
  minimum_selling_price: 'Minimum Selling Price',
  mrp: 'MRP',
  minimum_level: 'Minimum Stock Level (earlier, quantity)',
  reorder_level: 'Reorder Level (earlier, quantity)',
  lead_time_days: 'Lead Time (Days)',
  reorder_level_days: 'Reorder Level (Days)',
  supplier_model_number: 'Supplier Model No.',
  supplier_product_name: 'Supplier Product Name',
  length_cm: 'Length (cm)',
  width_cm: 'Width (cm)',
  height_cm: 'Height (cm)',
  preferred_supplier_id: 'Preferred Supplier',
  remarks: 'Remarks',
  is_manufacturable: 'Manufacturable',
  track_expiry: 'Expiry',
  production_notes: 'Production Notes',
}

/** Import column -> form field it fills (text fields are copied as typed). */
const TEXT_FIELDS: [ImportFieldKey, ProductField][] = [
  ['product_name', 'product_name'], ['description', 'description'], ['brand', 'brand'], ['model_number', 'model_number'],
  ['barcode', 'barcode'], ['ean', 'ean'], ['group_head', 'group_head'], ['minimum_cover_days', 'minimum_cover_days'], ['hsn_code', 'hsn_code'], ['gst_rate', 'gst_rate'], ['selling_price', 'selling_price'],
  ['standard_cost', 'standard_cost'], ['standard_manufacturing_cost', 'standard_manufacturing_cost'],
  ['minimum_selling_price', 'minimum_selling_price'], ['mrp', 'mrp'], ['lead_time_days', 'lead_time_days'], ['reorder_level_days', 'reorder_level_days'],
  ['supplier_model_number', 'supplier_model_number'], ['supplier_product_name', 'supplier_product_name'],
  ['length_cm', 'length_cm'], ['width_cm', 'width_cm'], ['height_cm', 'height_cm'],
  ['remarks', 'remarks'],
]

const UPDATABLE: (keyof ProductInput)[] = [
  'product_name', 'description', 'category_id', 'brand', 'model_number', 'barcode', 'ean', 'group_head', 'minimum_cover_days', 'supplier_model_number', 'supplier_product_name',
  'product_type', 'default_source_type', 'base_unit', 'length_cm', 'width_cm', 'height_cm',
  'hsn_code', 'gst_rate', 'mrp', 'selling_price', 'standard_cost', 'standard_manufacturing_cost', 'minimum_selling_price',
  'lead_time_days', 'reorder_level_days', 'preferred_supplier_id', 'remarks', 'is_manufacturable',
]

/**
 * Columns of earlier templates that held quantity levels ("Reorder Level",
 * "Minimum Stock Level"). They are not imported: the product master now plans
 * in days, and a quantity is never read as a number of days.
 */
export function legacyQuantityColumns(headers: string[]): string[] {
  const legacy = ['reorder level', 'reorder', 'reorder qty', 'reorder quantity', 'reorder point', 'minimum stock level', 'minimum stock',
    'min stock', 'min stock level', 'safety stock'].map(normalizeHeader)
  return headers.filter((h) => legacy.includes(normalizeHeader(h)))
}

/**
 * Validates every non-blank data row. Never touches the database.
 * `firstDataRowNumber` is the spreadsheet row number of rows[0].
 */
export function validateImportRows(
  rows: string[][],
  mapping: ColumnMapping,
  ctx: ImportContext,
  firstDataRowNumber = 2,
): ImportRowResult[] {
  const cell = (row: string[], key: ImportFieldKey) => {
    const index = mapping[key]
    return index === null ? '' : String(row[index] ?? '').trim()
  }
  const mappedIndexes = Object.values(mapping).filter((i): i is number => i !== null)
  const categoryByKey = new Map<string, ImportCategory>()
  for (const c of ctx.categories) {
    categoryByKey.set(`name:${c.name.trim().toLowerCase()}`, c)
    categoryByKey.set(`code:${c.code.trim().toUpperCase()}`, c)
  }
  const supplierByKey = new Map<string, ImportSupplier>()
  for (const s of ctx.suppliers ?? []) {
    supplierByKey.set(s.supplier_code.trim().toLowerCase(), s)
    supplierByKey.set(s.legal_name.trim().toLowerCase(), s)
    if (s.display_name) supplierByKey.set(s.display_name.trim().toLowerCase(), s)
  }

  const firstSkuRow = new Map<string, number>()
  const firstBarcodeRow = new Map<string, number>()
  const firstEanRow = new Map<string, number>()
  const results: ImportRowResult[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + firstDataRowNumber
    if (mappedIndexes.every((i) => String(row[i] ?? '').trim() === '')) return

    const errors: string[] = []
    const warnings: string[] = []
    const sku = cell(row, 'sku')
    const key = sku ? skuKey(sku) : ''

    // Duplicate SKU inside the file.
    let firstSeen: number | undefined
    if (key) {
      firstSeen = firstSkuRow.get(key)
      if (firstSeen !== undefined) errors.push(`Duplicate SKU in this file (first seen on row ${firstSeen}).`)
      else firstSkuRow.set(key, rowNumber)
    }
    const exists = Boolean(key) && firstSeen === undefined && ctx.existingSkus.has(key)
    const existing = exists && ctx.duplicateMode === 'update' ? ctx.existingProducts?.get(key) : undefined
    const isUpdate = Boolean(existing)

    if (exists && ctx.duplicateMode === 'skip') {
      results.push({ rowNumber, sku, productName: cell(row, 'product_name'), status: 'skipped', errors: [],
        warnings: ['SKU already exists — row skipped (existing product not changed).'], input: null })
      return
    }
    if (exists && ctx.duplicateMode === 'error') errors.push('SKU already exists in the product master.')
    if (exists && ctx.duplicateMode === 'update' && !existing) errors.push('SKU exists but the stored product could not be loaded. Validate again.')

    // Start from the stored values (update) or a blank form (create); only cells with a value change anything.
    const values: ProductFormValues = existing ? { ...existing.values } : { ...EMPTY_PRODUCT_FORM, base_unit: '' }
    const provided = new Set<keyof ProductInput>()
    values.sku = existing ? existing.sku : sku

    for (const [col, field] of TEXT_FIELDS) {
      const v = cell(row, col)
      if (v !== '') {
        ;(values as unknown as Record<string, string>)[field] = v
        provided.add(field as keyof ProductInput)
      }
    }

    const rawType = cell(row, 'product_type')
    if (rawType) {
      const t = parseProductType(rawType)
      if (!t) errors.push(`Product Type "${rawType}" is not recognised. Use: ${Object.values(PRODUCT_TYPE_LABELS).join(', ')}.`)
      else { values.product_type = t; provided.add('product_type') }
    }

    const rawSource = cell(row, 'source_type')
    if (rawSource) {
      const s = parseSourceType(rawSource)
      if (!s) errors.push(`Source Type "${rawSource}" is not recognised. Use: ${Object.values(SOURCE_TYPE_LABELS).join(', ')}.`)
      else { values.default_source_type = s; provided.add('default_source_type') }
    }

    const rawUnit = cell(row, 'unit')
    if (rawUnit) {
      const u = findUnit(rawUnit)
      if (!u) errors.push(`Unit "${rawUnit}" is not recognised.`)
      else { values.base_unit = u; provided.add('base_unit') }
    }

    const rawCategory = cell(row, 'category')
    if (rawCategory) {
      const category = categoryByKey.get(`name:${rawCategory.toLowerCase()}`) ?? categoryByKey.get(`code:${rawCategory.toUpperCase()}`)
      if (!category) errors.push(`Category "${rawCategory}" does not exist. Create it first or correct the name.`)
      else if (!category.is_active) errors.push(`Category "${rawCategory}" is inactive.`)
      else { values.category_id = category.id; provided.add('category_id') }
    }

    const rawManufacturable = parseBoolean(cell(row, 'is_manufacturable'))
    if (rawManufacturable === null) errors.push('Manufacturable must be Yes or No.')
    else if (rawManufacturable !== undefined) { values.is_manufacturable = rawManufacturable; provided.add('is_manufacturable') }

    const rawSupplier = cell(row, 'preferred_supplier')
    if (rawSupplier) {
      const supplier = supplierByKey.get(rawSupplier.toLowerCase())
      if (!supplier) warnings.push(`Preferred Supplier "${rawSupplier}" was not found by code or name, so none is set. Add the supplier first or correct the name.`)
      else if (supplier.status !== 'ACTIVE') warnings.push(`Preferred Supplier "${rawSupplier}" is inactive, so it is not set.`)
      else { values.preferred_supplier_id = supplier.id; provided.add('preferred_supplier_id') }
    }

    // Defaults for incomplete new products (never errors).
    if (!existing) {
      if (!values.product_type && !rawType) errors.push('Product Type is required.')
      if (!sku && values.product_type) warnings.push(`No SKU: the next ${SKU_PREFIXES[values.product_type]}- code will be assigned automatically.`)
      if (!values.default_source_type && values.product_type && !rawSource) {
        warnings.push(`No Source Type: ${SOURCE_TYPE_LABELS[defaultSourceFor(values.product_type)]} will be used.`)
      }
      if (!values.base_unit && !rawUnit) {
        values.base_unit = 'PCS'
        warnings.push('No Unit: PCS will be used.')
      }
    }

    const validation = validateProduct(values)
    for (const [field, message] of Object.entries(validation.errors)) {
      // Type/source/unit problems were already reported with the raw value.
      if (field === 'product_type' && (rawType || !existing)) continue
      if (field === 'default_source_type' && rawSource) continue
      if (field === 'base_unit' && rawUnit) continue
      errors.push(`${FIELD_LABELS[field as ProductField] ?? field}: ${message}`)
    }
    warnings.push(...validation.warnings)

    const barcode = values.barcode.trim()
    if (barcode && (!existing || provided.has('barcode'))) {
      const first = firstBarcodeRow.get(barcode)
      if (first !== undefined) errors.push(`Duplicate barcode in this file (first seen on row ${first}).`)
      else firstBarcodeRow.set(barcode, rowNumber)
      const owner = ctx.barcodeOwners?.get(barcode)
      if (ctx.existingBarcodes.has(barcode) && !(existing && owner === existing.id)) errors.push('Barcode is already used by another product.')
    }

    // EAN: unique in the file and in the company. A blank cell never clears a stored EAN.
    const ean = validation.input?.ean ?? null
    if (ean && (!existing || provided.has('ean'))) {
      const first = firstEanRow.get(ean)
      if (first !== undefined) errors.push(`Duplicate EAN ${ean} in this file (first seen on row ${first}).`)
      else firstEanRow.set(ean, rowNumber)
      const owner = ctx.eanOwners?.get(ean)
      if (owner && !(existing && owner === existing.id)) errors.push(`EAN ${ean} is already used by another product.`)
    }
    if (existing && provided.has('ean') && existing.values.ean.trim() && ean && existing.values.ean.trim() !== ean) {
      warnings.push(`The stored EAN ${existing.values.ean.trim()} is replaced by ${ean}.`)
    }

    let changes: FieldChange[] | undefined
    let input: ProductInput | null = validation.input
    if (existing && validation.input) {
      const before = validateProduct(existing.values).input
      changes = []
      const update: Partial<ProductInput> = {}
      for (const field of UPDATABLE) {
        if (!provided.has(field)) continue
        const from = before?.[field] ?? null
        const to = validation.input[field] ?? null
        if (from !== to) {
          changes.push({ field, label: FIELD_LABELS[field as ProductField] ?? field, from: display(from), to: display(to) })
          ;(update as Record<string, unknown>)[field] = to
        }
      }
      if (provided.has('product_type') && before && before.product_type !== validation.input.product_type) {
        warnings.push('The product type changes. Check any BOMs and open orders that use this product.')
      }
      input = update as ProductInput
    }

    if (validation.input && !existing) {
      const gaps = productGaps(validation.input)
      if (gaps.length > 0) warnings.push(`Missing information (can be added later): ${gaps.map((g) => GAP_LABELS[g.key]).join(', ')}.`)
    }

    let status: ImportRowResult['status'] = errors.length > 0 ? 'error' : 'valid'
    if (status === 'valid' && isUpdate && changes && changes.length === 0) {
      status = 'skipped'
      warnings.unshift('No changes: the file matches the stored product.')
    }

    results.push({
      rowNumber,
      sku: existing ? existing.sku : sku,
      productName: values.product_name,
      status,
      action: status === 'valid' ? (isUpdate ? 'update' : 'create') : undefined,
      productId: existing?.id,
      changes,
      errors,
      warnings,
      input: status === 'valid' ? input : null,
    })
  })

  return results
}

const GAP_LABELS: Record<ProductGap['key'], string> = {
  hsn: 'HSN code', gst: 'GST rate', category: 'category', price: 'selling price', cost: 'standard cost', bom: 'BOM',
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

export function summarizeImport(results: ImportRowResult[]) {
  return {
    total: results.length,
    valid: results.filter((r) => r.status === 'valid').length,
    creates: results.filter((r) => r.status === 'valid' && r.action !== 'update').length,
    updates: results.filter((r) => r.status === 'valid' && r.action === 'update').length,
    withWarnings: results.filter((r) => r.status === 'valid' && r.warnings.length > 0).length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    errors: results.filter((r) => r.status === 'error').length,
  }
}

/** Rows for a downloadable report of every row that was not imported cleanly, plus every change made. */
export function buildErrorReport(
  results: (ImportRowResult & { saveError?: string })[],
): (string | number)[][] {
  const header = ['Row', 'SKU', 'Product Name', 'Status', 'Errors', 'Warnings', 'Changes']
  const rows = results
    .filter((r) => r.status !== 'valid' || r.saveError || r.warnings.length > 0 || (r.changes?.length ?? 0) > 0)
    .map((r) => [
      r.rowNumber,
      r.sku,
      r.productName,
      r.saveError ? 'failed' : r.status === 'valid' && r.action === 'update' ? 'update' : r.status,
      [...r.errors, ...(r.saveError ? [r.saveError] : [])].join(' | '),
      r.warnings.join(' | '),
      (r.changes ?? []).map((c) => `${c.label}: ${c.from} → ${c.to}`).join(' | '),
    ])
  return [header, ...rows]
}

/** Converts a stored product row into form values (used for update comparisons). */
export function productRowToFormValues(p: {
  sku: string; product_name: string; description: string | null; category_id: string | null; brand: string | null; model_number: string | null
  barcode: string | null; ean?: string | null; group_head?: string | null; minimum_cover_days?: number | null
  status: 'ACTIVE' | 'INACTIVE'; product_type: string; default_source_type: string; base_unit: string
  track_batches: boolean; track_expiry: boolean; hsn_code: string | null; gst_rate: number | null; selling_price: number | null
  standard_cost: number | null; minimum_selling_price: number | null; reorder_level: number | null
  standard_manufacturing_cost?: number | null; minimum_level?: number | null; preferred_supplier_id?: string | null; remarks?: string | null
  lead_time_days?: number | null; reorder_level_days?: number | null; mrp?: number | null
  length_cm?: number | null; width_cm?: number | null; height_cm?: number | null
  supplier_model_number?: string | null; supplier_product_name?: string | null
  inventory_tracked?: boolean
  is_manufacturable: boolean; has_bom: boolean; production_notes: string | null
}): ProductFormValues {
  const str = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v))
  return {
    sku: p.sku,
    product_name: p.product_name,
    description: p.description ?? '',
    category_id: p.category_id ?? '',
    brand: p.brand ?? '',
    model_number: p.model_number ?? '',
    barcode: p.barcode ?? '',
    ean: p.ean ?? '',
    group_head: p.group_head ?? '',
    minimum_cover_days: str(p.minimum_cover_days),
    supplier_model_number: p.supplier_model_number ?? '',
    supplier_product_name: p.supplier_product_name ?? '',
    status: p.status,
    product_type: p.product_type as ProductFormValues['product_type'],
    default_source_type: p.default_source_type as ProductFormValues['default_source_type'],
    base_unit: p.base_unit,
    track_batches: p.track_batches,
    track_expiry: p.track_expiry,
    // Not an import column: the stored classification is kept on update.
    inventory_tracked: p.inventory_tracked ?? true,
    length_cm: str(p.length_cm),
    width_cm: str(p.width_cm),
    height_cm: str(p.height_cm),
    hsn_code: p.hsn_code ?? '',
    gst_rate: str(p.gst_rate),
    mrp: str(p.mrp),
    selling_price: str(p.selling_price),
    standard_cost: str(p.standard_cost),
    minimum_selling_price: str(p.minimum_selling_price),
    reorder_level: str(p.reorder_level),
    standard_manufacturing_cost: str(p.standard_manufacturing_cost),
    minimum_level: str(p.minimum_level),
    lead_time_days: str(p.lead_time_days),
    reorder_level_days: str(p.reorder_level_days),
    preferred_supplier_id: p.preferred_supplier_id ?? '',
    remarks: p.remarks ?? '',
    is_manufacturable: p.is_manufacturable,
    has_bom: p.has_bom,
    production_notes: p.production_notes ?? '',
  }
}
