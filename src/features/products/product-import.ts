// Spreadsheet import: column mapping and row validation. Pure TypeScript (no
// React/Supabase) so the rules are unit-tested in tests/unit. Previewing and
// validating never touches the database; saving is a separate explicit step.
//
// V2 rules:
//   * Only Product Name and Product Type are needed. A blank SKU gets the next
//     automatic code, a blank source type / unit gets its default; each is a
//     warning, never an error.
//   * Smart import (mode "update", the default): each row is matched to the
//     product master by SKU (trimmed, case-insensitive, within the company) and
//     classified as New, Modified, Unchanged (skipped) or Invalid. A modified
//     product gets only the fields whose value differs (a blank cell never
//     erases data, the SKU is never changed); every compared field is listed
//     (existing value / Excel value) for review before anything is saved.
//   * Fields to modify: for existing products only the fields ticked on the
//     mapping screen are read and compared; every other column is ignored and
//     the stored value is kept. New products use every mapped column.
//   * Never a duplicate: a SKU used on more than one row, a new SKU that differs
//     from a stored SKU only by separators ("FG0001" / "FG-0001"), and a new
//     product whose name is already in the ERP are "Duplicate / Ambiguous" and
//     are not saved (a new SKU with a known name can be allowed explicitly).
//     A row is never matched to a product by guessing.

import { productGaps, type ProductGap } from './product-completeness.ts'
import { formatCost } from './product-list-format.ts'
import {
  PRODUCT_TYPE_LABELS,
  SKU_PREFIXES,
  SOURCE_TYPE_LABELS,
  cleanSku,
  imageUrlProblem,
  normaliseImageUrl,
  defaultSourceFor,
  findUnit,
  sameUnit,
  looseSkuKey,
  normalizeEan,
  parseProductType,
  parseSourceType,
  skuKey,
  type ProductInput,
} from './product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct, type ProductField, type ProductFormValues } from './product-validation.ts'

export const MAX_IMPORT_ROWS = 5000
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024

export const IMPORT_FIELDS = [
  { key: 'sku', label: 'SKU', required: false, synonyms: ['sku', 'sku code', 'sku no', 'sku number', 'sku id', 'item sku', 'product sku', 'product code', 'item code', 'code'] },
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
  { key: 'image_url', label: 'Image Link', required: false, synonyms: ['image link', 'image url', 'product image', 'product image url', 'product image link', 'image', 'photo url', 'picture url', 'image links', 'photo', 'picture'] },
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
  /** Stored updated_at: the update is refused if the product changed after the file was checked. */
  updatedAt?: string
  /** Uploaded image (storage path): shown instead of the image link while it exists. */
  imagePath?: string | null
}

/** What the file does to a product's image link. */
export type ImageImportStatus = 'new' | 'changed' | 'unchanged' | 'invalid' | 'blank' | 'not-selected'

export const IMAGE_STATUS_LABELS: Record<ImageImportStatus, string> = {
  new: 'New Image', changed: 'Image Changed', unchanged: 'Unchanged', invalid: 'Invalid URL', blank: 'Blank', 'not-selected': 'Not selected',
}

export interface ImageImport {
  status: ImageImportStatus
  /** Saved link of the existing product (null for a new product or none saved). */
  current: string | null
  /** Link in the file (trimmed), null when blank. */
  incoming: string | null
  /** Image Link is selected under Fields to Modify (always true for a new product). */
  selected: boolean
  /** The existing product has an uploaded image, which stays shown instead of the link. */
  uploaded: boolean
  problem?: string
}

export interface FieldChange {
  field: keyof ProductInput
  label: string
  /** Existing ERP value, formatted for display. */
  from: string
  /** Excel value, formatted for display. */
  to: string
}

/** One field supplied in the file for an existing product: changed or the same as stored. */
export interface FieldComparison extends FieldChange {
  changed: boolean
  /** update: the Excel value replaces the stored one; unchanged: same value; blank: empty cell, the stored value is kept. */
  action: 'update' | 'unchanged' | 'blank'
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
  /** updated_at of the stored product when the file was checked. */
  productUpdatedAt?: string
  changes?: FieldChange[]
  /** Existing products: every field supplied in the file, changed or not. */
  compared?: FieldComparison[]
  /** Why a row is skipped: nothing differs, existing products are left alone ("add new only"), or no field is selected to modify. */
  skipReason?: 'unchanged' | 'exists' | 'no-fields'
  /** An error row that is a duplicate or an ambiguous match (needs a decision, not a correction of a value). */
  issue?: 'ambiguous'
  errors: string[]
  warnings: string[]
  /** Full insert payload (create) or only the changed fields (update). */
  input: ProductInput | null
  /** The row's image link, when an Image Link column is mapped. */
  image?: ImageImport
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
  /** Stored SKU(s) of the existing products with each nameKey() (comma-separated): a new product must not repeat one. */
  existingNames?: Map<string, string>
  /** Stored SKU(s) by looseSkuKey(): a new SKU that differs only by separators is reported, never matched. */
  looseSkus?: Map<string, string>
  /** Columns whose values may change existing products (undefined: every mapped column). SKU is never changed. */
  modifyFields?: ReadonlySet<ImportFieldKey>
  /** A new SKU whose product name is already in the ERP is added as a separate product (otherwise ambiguous). */
  allowSameName?: boolean
  /** Field that finds existing products (ERP Settings → Products; default SKU). NONE: existing products are never changed. */
  matchKey?: MatchKey
  /** For match keys other than SKU / NONE: stored products by matchValue(). More than one = ambiguous. */
  matchIndex?: Map<string, ExistingProduct[]>
  /** Product id of each stored SKU by skuKey(): a SKU change must not take another product's SKU. */
  skuOwners?: Map<string, string>
}

/** Which field the import uses to find existing products (ERP Settings → Products → product.import_match_key). */
export type MatchKey = 'SKU' | 'BARCODE' | 'EAN' | 'MODEL_NUMBER' | 'PRODUCT_NAME' | 'NONE'

export const MATCH_KEYS: { key: MatchKey; label: string; column: ImportFieldKey | null; hint: string }[] = [
  { key: 'SKU', label: 'SKU', column: 'sku', hint: 'Recommended: unique per company, case and spaces ignored.' },
  { key: 'BARCODE', label: 'Barcode', column: 'barcode', hint: 'Unique per company. Rows without a barcode are treated as new products.' },
  { key: 'EAN', label: 'EAN', column: 'ean', hint: 'Unique per company. Rows without an EAN are treated as new products.' },
  { key: 'MODEL_NUMBER', label: 'Model Number', column: 'model_number', hint: 'Not unique: a model number used by several products is reported, never guessed.' },
  { key: 'PRODUCT_NAME', label: 'Product Name', column: 'product_name', hint: 'Not unique: case and spaces ignored; a name used by several products is reported, never guessed.' },
  { key: 'NONE', label: 'None (N/A)', column: null, hint: 'No matching: the import only adds new products and never changes existing ones.' },
]

export const matchKeyLabel = (key: MatchKey) => MATCH_KEYS.find((m) => m.key === key)?.label ?? key
export const matchColumn = (key: MatchKey): ImportFieldKey | null => MATCH_KEYS.find((m) => m.key === key)?.column ?? null
export const isMatchKey = (v: unknown): v is MatchKey => MATCH_KEYS.some((m) => m.key === v)

/** A match-key value as compared: SKU / barcode trimmed and case-insensitive, EAN digits only, model number and name like nameKey(). */
export function matchValue(key: MatchKey, raw: string | null | undefined): string {
  const v = raw ?? ''
  switch (key) {
    case 'SKU': return skuKey(v)
    case 'BARCODE': return cleanSku(v).toLowerCase()
    case 'EAN': return normalizeEan(v)
    case 'MODEL_NUMBER':
    case 'PRODUCT_NAME': return nameKey(v)
    default: return ''
  }
}

/** Product names compared for duplicates: trimmed, case-insensitive, inner spaces collapsed. */
export const nameKey = (name: string) => name.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim().replace(/\s+/g, ' ').toLowerCase()

export type RowKind = 'new' | 'modified' | 'skipped' | 'ambiguous' | 'invalid'

/** New / Modified / Skipped (unchanged or left alone) / Duplicate-ambiguous / Invalid, as shown on the import preview. */
export function rowKind(r: Pick<ImportRowResult, 'status' | 'action' | 'issue'>): RowKind {
  if (r.status === 'error') return r.issue === 'ambiguous' ? 'ambiguous' : 'invalid'
  if (r.status === 'skipped') return 'skipped'
  return r.action === 'update' ? 'modified' : 'new'
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

/**
 * Columns that must be mapped. With a SKU column in smart import, existing products need only
 * the SKU and the fields to change; a new product missing its name or type is reported on its row.
 */
export function missingRequiredFields(mapping: ColumnMapping, mode: DuplicateMode = 'skip', matchKey: MatchKey = 'SKU'): string[] {
  const col = matchColumn(matchKey)
  if (mode === 'update' && col && mapping[col] !== null) return []
  return IMPORT_FIELDS.filter((f) => f.required && mapping[f.key] === null).map((f) => f.label)
}

/** The product field(s) each import column fills. */
export const IMPORT_FIELD_TARGET: Record<ImportFieldKey, keyof ProductInput> = {
  sku: 'sku', product_name: 'product_name', description: 'description', category: 'category_id', brand: 'brand', model_number: 'model_number',
  barcode: 'barcode', ean: 'ean', supplier_model_number: 'supplier_model_number', supplier_product_name: 'supplier_product_name',
  product_type: 'product_type', source_type: 'default_source_type', unit: 'base_unit', length_cm: 'length_cm', width_cm: 'width_cm', height_cm: 'height_cm',
  hsn_code: 'hsn_code', gst_rate: 'gst_rate', selling_price: 'selling_price', mrp: 'mrp', standard_cost: 'standard_cost',
  standard_manufacturing_cost: 'standard_manufacturing_cost', minimum_selling_price: 'minimum_selling_price', lead_time_days: 'lead_time_days',
  reorder_level_days: 'reorder_level_days', minimum_cover_days: 'minimum_cover_days', group_head: 'group_head', is_manufacturable: 'is_manufacturable',
  preferred_supplier: 'preferred_supplier_id', remarks: 'remarks', image_url: 'image_url',
}

/**
 * Mapped columns that can modify existing products: every mapped column except the match key (which finds the
 * product and is never changed). The SKU can be modified only when another field is the match key. NONE: no column.
 */
export function modifiableFields(mapping: ColumnMapping, matchKey: MatchKey = 'SKU'): { key: ImportFieldKey; label: string }[] {
  if (matchKey === 'NONE') return []
  const locked = matchColumn(matchKey)
  return IMPORT_FIELDS.filter((f) => f.key !== locked && mapping[f.key] !== null).map((f) => ({ key: f.key, label: f.label }))
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
  image_url: 'Image Link',
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
  'lead_time_days', 'reorder_level_days', 'preferred_supplier_id', 'remarks', 'is_manufacturable', 'image_url',
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

  const isBlank = (row: string[]) => mappedIndexes.every((i) => String(row[i] ?? '').trim() === '')
  // Match key (ERP Settings): NONE behaves like the SKU key with existing products left alone.
  const matchKey: MatchKey = ctx.matchKey ?? 'SKU'
  const byOther = matchKey !== 'SKU' && matchKey !== 'NONE'
  const matchCol = matchColumn(matchKey)
  const keyLabel = matchKeyLabel(matchKey)
  const mode: DuplicateMode = matchKey === 'NONE' ? 'skip' : ctx.duplicateMode
  // Rows of each SKU (and of each product name without a SKU, and of each match value) in the file.
  const skuRows = new Map<string, number[]>()
  const nameRows = new Map<string, number[]>()
  const valueRows = new Map<string, number[]>()
  rows.forEach((row, index) => {
    if (isBlank(row)) return
    const k = skuKey(cell(row, 'sku'))
    const n = nameKey(cell(row, 'product_name'))
    if (k) skuRows.set(k, [...(skuRows.get(k) ?? []), index + firstDataRowNumber])
    else if (n) nameRows.set(n, [...(nameRows.get(n) ?? []), index + firstDataRowNumber])
    const mv = byOther && matchCol ? matchValue(matchKey, cell(row, matchCol)) : ''
    if (mv) valueRows.set(mv, [...(valueRows.get(mv) ?? []), index + firstDataRowNumber])
  })
  const categoryName = new Map(ctx.categories.map((c) => [c.id, c.name]))
  const supplierName = new Map((ctx.suppliers ?? []).map((s) => [s.id, `${s.display_name || s.legal_name} (${s.supplier_code})`]))
  const show = (field: keyof ProductInput, value: unknown): string => {
    if (value === null || value === undefined || value === '') return '—'
    if (field === 'category_id') return categoryName.get(String(value)) ?? 'Another category'
    if (field === 'preferred_supplier_id') return supplierName.get(String(value)) ?? 'Another supplier'
    if (field === 'product_type') return PRODUCT_TYPE_LABELS[value as keyof typeof PRODUCT_TYPE_LABELS] ?? String(value)
    if (field === 'default_source_type') return SOURCE_TYPE_LABELS[value as keyof typeof SOURCE_TYPE_LABELS] ?? String(value)
    if (MONEY_FIELDS.has(field)) return formatCost(value as number)
    if (field === 'gst_rate') return `${Number(value)}%`
    return display(value)
  }

  const firstBarcodeRow = new Map<string, number>()
  const firstEanRow = new Map<string, number>()
  const results: ImportRowResult[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + firstDataRowNumber
    if (isBlank(row)) return

    const errors: string[] = []
    const warnings: string[] = []
    const sku = cleanSku(cell(row, 'sku'))
    const key = sku ? skuKey(sku) : ''
    const name = cell(row, 'product_name')
    // Duplicates and ambiguous matches: reported for a decision, never saved and never matched by guessing.
    const ambiguous: string[] = []

    // A SKU used on more than one row: every such row is rejected (which values are meant is unclear).
    const sameSku = key ? (skuRows.get(key) ?? []) : []
    if (sameSku.length > 1) {
      results.push({ rowNumber, sku, productName: name, status: 'error', issue: 'ambiguous', warnings: [], input: null,
        errors: [`Duplicate SKU in this file: rows ${sameSku.join(', ')} have SKU ${sku}. Keep one row per SKU.`] })
      return
    }
    // Find the existing product: by SKU, or by the match key chosen in ERP Settings.
    let exists = Boolean(key) && ctx.existingSkus.has(key)
    let found: ExistingProduct | undefined
    if (byOther) {
      exists = false
      const mv = matchCol ? matchValue(matchKey, cell(row, matchCol)) : ''
      const sameValue = mv ? (valueRows.get(mv) ?? []) : []
      const candidates = mv ? (ctx.matchIndex?.get(mv) ?? []) : []
      if (sameValue.length > 1) {
        ambiguous.push(`Duplicate ${keyLabel} in this file: rows ${sameValue.join(', ')} have the same ${keyLabel}. Keep one row per product.`)
      } else if (candidates.length > 1) {
        ambiguous.push(`${candidates.length} products have this ${keyLabel} (SKUs ${candidates.map((c) => c.sku).sort().join(', ')}). `
          + `The row is not matched to any of them; make the ${keyLabel} unique or change the match key in ERP Settings.`)
      } else if (candidates.length === 1) {
        exists = true
        found = candidates[0]
      } else if (key && ctx.existingSkus.has(key)) {
        // Not found by the match key, but the SKU is taken: never a second product with the same SKU.
        ambiguous.push(`SKU ${sku} already belongs to a product whose ${keyLabel} does not match this row. Not created: a SKU is never used twice. `
          + `Correct the ${keyLabel} or the SKU.`)
      }
      // A SKU change must not take another product's SKU.
      if (found && key && key !== skuKey(found.sku) && (!ctx.modifyFields || ctx.modifyFields.has('sku'))) {
        const owner = ctx.skuOwners?.get(key)
        if (owner && owner !== found.id) ambiguous.push(`SKU ${sku} is already used by another product; ${found.sku} cannot be renamed to it.`)
      }
    }
    const n = nameKey(name)
    const storedForName = n ? ctx.existingNames?.get(n) : undefined
    // A row without a SKU is a new product: it must not repeat another row or an existing product.
    if (exists || ambiguous.length > 0) {
      // Matched (or already reported): no new-product checks.
    } else if (!key) {
      const sameName = n ? (nameRows.get(n) ?? []) : []
      if (sameName.length > 1) ambiguous.push(`Duplicate product in this file: rows ${sameName.join(', ')} have the same name and no SKU.`)
      if (storedForName) ambiguous.push(`A product with this name already exists (SKU ${storedForName}). Enter its SKU on this row to update it, or use a different name for a new product.`)
    } else {
      // A new SKU: not a near-miss of a stored SKU, and not the name of a stored product.
      const near = ctx.looseSkus?.get(looseSkuKey(sku))
      if (near) {
        ambiguous.push(`SKU ${sku} is not in the Product Master, but ${near} is almost the same (only spaces or separators differ). `
          + `Write the SKU exactly as stored to update that product, or use a clearly different SKU for a new product.`)
      } else if (storedForName && !ctx.allowSameName) {
        ambiguous.push(`SKU ${sku} is new, but a product named "${name}" already exists (SKU ${storedForName}). `
          + `Use SKU ${storedForName} to update it, or allow separate products with the same name if this is a different product.`)
      } else if (storedForName) {
        warnings.push(`Added as a separate product: a product with the same name already exists (SKU ${storedForName}).`)
      }
    }
    const existing = exists && mode === 'update' ? (byOther ? found : ctx.existingProducts?.get(key)) : undefined
    const isUpdate = Boolean(existing)
    if (ambiguous.length > 0) {
      results.push({ rowNumber, sku, productName: name, status: 'error', issue: 'ambiguous', errors: ambiguous, warnings: [], input: null })
      return
    }

    if (exists && mode === 'skip') {
      results.push({ rowNumber, sku: found?.sku ?? sku, productName: cell(row, 'product_name'), status: 'skipped', skipReason: 'exists', errors: [],
        warnings: [`${byOther ? `Already in the Product Master (matched by ${keyLabel})` : 'SKU already exists'} — row skipped (existing product not changed).`], input: null })
      return
    }
    if (exists && mode === 'error') errors.push('SKU already exists in the product master.')
    if (exists && mode === 'update' && !existing) errors.push(`${byOther ? keyLabel : 'SKU'} exists but the stored product could not be loaded. Validate again.`)

    // Existing products: only the columns selected to modify are read; every other column keeps the stored value.
    // The match key column finds the product and is never modified.
    const selected = (col: ImportFieldKey) => !existing || (col !== matchCol && (!ctx.modifyFields || ctx.modifyFields.has(col)))
    const val = (col: ImportFieldKey) => (selected(col) ? cell(row, col) : '')

    // Start from the stored values (update) or a blank form (create); only cells with a value change anything.
    const values: ProductFormValues = existing ? { ...existing.values } : { ...EMPTY_PRODUCT_FORM, base_unit: '' }
    const provided = new Set<keyof ProductInput>()
    values.sku = existing ? existing.sku : sku
    // Matched by another field: the SKU may change when it is selected; otherwise a different SKU in the file is only noted.
    if (existing && byOther && sku && sku !== existing.sku) {
      if (selected('sku')) { values.sku = sku; provided.add('sku') }
      else warnings.push(`The file's SKU ${sku} differs from the stored SKU ${existing.sku}; the SKU is not changed (not selected).`)
    }

    for (const [col, field] of TEXT_FIELDS) {
      const v = val(col)
      if (v !== '') {
        ;(values as unknown as Record<string, string>)[field] = v
        provided.add(field as keyof ProductInput)
      }
    }

    // Image link: never used to match. An invalid link is reported and not saved; the rest of the row still imports.
    // A blank cell never removes a saved link; the same link is unchanged.
    let image: ImageImport | undefined
    if (mapping.image_url !== null) {
      const raw = cell(row, 'image_url')
      const incoming = normaliseImageUrl(raw)
      const current = existing ? normaliseImageUrl(existing.values.image_url) : null
      const isSelected = selected('image_url')
      const problem = incoming ? imageUrlProblem(incoming) : null
      let status: ImageImportStatus
      if (!isSelected) status = 'not-selected'
      else if (!incoming) status = 'blank'
      else if (problem) {
        status = 'invalid'
        warnings.push(`Image Link not imported: ${problem}`)
      } else {
        values.image_url = incoming
        provided.add('image_url')
        status = !current ? 'new' : current === incoming ? 'unchanged' : 'changed'
        if (existing?.imagePath && status !== 'unchanged') warnings.push('This product has an uploaded image, which stays shown; the new link is saved as its source.')
      }
      image = { status, current, incoming, selected: isSelected, uploaded: Boolean(existing?.imagePath), ...(problem ? { problem } : {}) }
    }

    const rawType = val('product_type')
    if (rawType) {
      const t = parseProductType(rawType)
      if (!t) errors.push(`Product Type "${rawType}" is not recognised. Use: ${Object.values(PRODUCT_TYPE_LABELS).join(', ')}.`)
      else { values.product_type = t; provided.add('product_type') }
    }

    const rawSource = val('source_type')
    if (rawSource) {
      const s = parseSourceType(rawSource)
      if (!s) errors.push(`Source Type "${rawSource}" is not recognised. Use: ${Object.values(SOURCE_TYPE_LABELS).join(', ')}.`)
      else { values.default_source_type = s; provided.add('default_source_type') }
    }

    const rawUnit = val('unit')
    if (rawUnit) {
      // The stored code is kept when the file names the same unit (KG and Kilograms, L and LTR): no conversion, no change.
      const saved = existing?.values.base_unit ?? ''
      const u = findUnit(rawUnit) ?? (saved && rawUnit.trim().toUpperCase() === saved ? saved : null)
      if (!u) errors.push(`Unit "${rawUnit}" is not recognised.`)
      else { values.base_unit = existing && sameUnit(u, saved) ? saved : u; provided.add('base_unit') }
    }

    const rawCategory = val('category')
    if (rawCategory) {
      const category = categoryByKey.get(`name:${rawCategory.toLowerCase()}`) ?? categoryByKey.get(`code:${rawCategory.toUpperCase()}`)
      if (!category) errors.push(`Category "${rawCategory}" does not exist. Create it first or correct the name.`)
      else if (!category.is_active) errors.push(`Category "${rawCategory}" is inactive.`)
      else { values.category_id = category.id; provided.add('category_id') }
    }

    const rawManufacturable = parseBoolean(val('is_manufacturable'))
    if (rawManufacturable === null) errors.push('Manufacturable must be Yes or No.')
    else if (rawManufacturable !== undefined) { values.is_manufacturable = rawManufacturable; provided.add('is_manufacturable') }

    const rawSupplier = val('preferred_supplier')
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

    const validation = validateProduct(values, { units: [existing?.values.base_unit] })
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
    let compared: FieldComparison[] | undefined
    let input: ProductInput | null = validation.input
    if (existing && validation.input) {
      const before = validateProduct(existing.values, { units: [existing.values.base_unit] }).input
      compared = []
      const update: Partial<ProductInput> = {}
      for (const field of (byOther ? ['sku', ...UPDATABLE] : UPDATABLE) as (keyof ProductInput)[]) {
        const label = FIELD_LABELS[field as ProductField] ?? field
        const from = before?.[field] ?? null
        if (!provided.has(field)) {
          // A selected column left blank in the file: shown, and the stored value is kept.
          const col = COLUMN_OF.get(field)
          if (col && mapping[col] !== null && selected(col) && cell(row, col) === '') {
            compared.push({ field, label, from: show(field, from), to: 'Blank', changed: false, action: 'blank' })
          }
          continue
        }
        const to = validation.input[field] ?? null
        const changed = from !== to
        compared.push({ field, label, from: show(field, from), to: show(field, to), changed, action: changed ? 'update' : 'unchanged' })
        if (changed) (update as Record<string, unknown>)[field] = to
      }
      changes = compared.filter((c) => c.changed).map((c) => ({ field: c.field, label: c.label, from: c.from, to: c.to }))
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
    const noFields = isUpdate && ctx.modifyFields !== undefined && ctx.modifyFields.size === 0
    if (status === 'valid' && isUpdate && changes && changes.length === 0) {
      status = 'skipped'
      warnings.unshift(noFields ? 'No fields are selected to modify: the existing product is not changed.' : 'No changes in the selected fields: the file matches the stored product.')
    }
    const skipReason = status === 'skipped' ? (noFields ? ('no-fields' as const) : ('unchanged' as const)) : undefined

    results.push({
      rowNumber,
      sku: existing ? existing.sku : sku,
      productName: values.product_name,
      status,
      action: status === 'valid' ? (isUpdate ? 'update' : 'create') : undefined,
      productId: existing?.id,
      productUpdatedAt: existing?.updatedAt,
      changes,
      compared,
      skipReason,
      errors,
      warnings,
      input: status === 'valid' ? input : null,
      ...(image ? { image } : {}),
    })
  })

  return results
}

const GAP_LABELS: Record<ProductGap['key'], string> = {
  hsn: 'HSN code', gst: 'GST rate', category: 'category', price: 'selling price', cost: 'standard cost', bom: 'BOM',
}

/** The import column that fills each product field. */
const COLUMN_OF = new Map(Object.entries(IMPORT_FIELD_TARGET).map(([col, field]) => [field, col as ImportFieldKey]))

const MONEY_FIELDS = new Set<keyof ProductInput>(['selling_price', 'mrp', 'standard_cost', 'standard_manufacturing_cost', 'minimum_selling_price'])

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

/** Image links of the rows that are imported or left unchanged (rows with errors are not counted). */
export function summarizeImages(results: ImportRowResult[]) {
  const rows = results.filter((r) => r.image && r.status !== 'error')
  const count = (s: ImageImportStatus, valid = false) => rows.filter((r) => r.image!.status === s && (!valid || r.status === 'valid')).length
  return {
    mapped: results.some((r) => r.image),
    add: count('new', true),
    update: count('changed', true),
    unchanged: count('unchanged'),
    invalid: results.filter((r) => r.image?.status === 'invalid').length,
    blank: count('blank'),
    notSelected: count('not-selected'),
  }
}

export function summarizeImport(results: ImportRowResult[]) {
  return {
    total: results.length,
    valid: results.filter((r) => r.status === 'valid').length,
    creates: results.filter((r) => r.status === 'valid' && r.action !== 'update').length,
    updates: results.filter((r) => r.status === 'valid' && r.action === 'update').length,
    withWarnings: results.filter((r) => r.status === 'valid' && r.warnings.length > 0).length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    ambiguous: results.filter((r) => r.status === 'error' && r.issue === 'ambiguous').length,
    errors: results.filter((r) => r.status === 'error' && r.issue !== 'ambiguous').length,
  }
}

/** One stored product of the company, as used for duplicate checks. */
export interface ProductIdentity {
  id: string
  sku: string
  product_name: string
  barcode?: string | null
  ean?: string | null
  model_number?: string | null
}

/** Ids of the stored products for each match value (match keys other than SKU / NONE). */
export function matchIds(products: ProductIdentity[], key: MatchKey): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const raw = (p: ProductIdentity) =>
    key === 'BARCODE' ? p.barcode : key === 'EAN' ? p.ean : key === 'MODEL_NUMBER' ? p.model_number : key === 'PRODUCT_NAME' ? p.product_name : null
  if (key === 'SKU' || key === 'NONE') return out
  for (const p of products) {
    const v = matchValue(key, raw(p))
    if (v) out.set(v, [...(out.get(v) ?? []), p.id])
  }
  return out
}

/** Lookups for duplicate checks: SKUs (exact and without separators) and names, all case-insensitive. */
export function identityMaps(products: ProductIdentity[]) {
  const existingSkus = new Set<string>()
  const skuIds = new Map<string, string>()
  const existingNames = new Map<string, string>()
  const looseSkus = new Map<string, string>()
  const add = (m: Map<string, string>, k: string, sku: string) => {
    if (!k) return
    const prev = m.get(k)
    if (!prev) m.set(k, sku)
    else if (!prev.split(', ').includes(sku)) m.set(k, `${prev}, ${sku}`)
  }
  for (const p of products) {
    existingSkus.add(skuKey(p.sku))
    skuIds.set(skuKey(p.sku), p.id)
    add(existingNames, nameKey(p.product_name), p.sku)
    add(looseSkus, looseSkuKey(p.sku), p.sku)
  }
  return { existingSkus, skuIds, existingNames, looseSkus }
}

/**
 * The second duplicate check, against the Product Master as it is just before saving: why a new product
 * must not be created now (its SKU, a near-identical SKU or its name was added meanwhile), or null.
 */
export function newProductConflict(
  input: { sku?: string | null; product_name: string },
  now: ReturnType<typeof identityMaps>,
  allowSameName = false,
): string | null {
  const sku = cleanSku(input.sku ?? '')
  const stored = now.existingNames.get(nameKey(input.product_name))
  if (sku) {
    if (now.existingSkus.has(skuKey(sku))) return `Not created: a product with SKU ${sku} now exists (added after the file was checked). Validate the file again to update it.`
    const near = now.looseSkus.get(looseSkuKey(sku))
    if (near) return `Not created: SKU ${near} is almost the same as ${sku} and now exists. Validate the file again.`
    if (stored && !allowSameName) return `Not created: a product with this name now exists (SKU ${stored}). Validate the file again.`
    return null
  }
  return stored ? `Not created: a product with this name was added meanwhile (SKU ${stored}).` : null
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
      r.saveError ? 'failed' : r.status === 'valid' && r.action === 'update' ? 'update' : r.issue === 'ambiguous' ? 'duplicate / ambiguous' : r.status,
      [...r.errors, ...(r.saveError ? [r.saveError] : [])].join(' | '),
      r.warnings.join(' | '),
      (r.changes ?? []).map((c) => `${c.label}: ${c.from} → ${c.to}`).join(' | '),
    ])
  return [header, ...rows]
}

/**
 * The failed-row report: every row that was not saved (invalid, or refused when saving), with the
 * reasons first and then the row's original cells, so it can be corrected and uploaded again.
 */
export function buildFailedRowsReport(
  results: (ImportRowResult & { saveError?: string })[],
  headers: string[],
  data: string[][],
  firstDataRowNumber: number,
): string[][] {
  const columns = headers.map((h, i) => h.trim() || `Column ${i + 1}`)
  const failed = results.filter((r) => r.status === 'error' || r.saveError)
  return [
    ['Row', 'Error reasons', ...columns],
    ...failed.map((r) => {
      const cells = data[r.rowNumber - firstDataRowNumber] ?? []
      return [String(r.rowNumber), [...r.errors, ...(r.saveError ? [r.saveError] : [])].join(' | '), ...columns.map((_, i) => String(cells[i] ?? ''))]
    }),
  ]
}

/** Converts a stored product row into form values (used for update comparisons). */
export function productRowToFormValues(p: {
  sku: string; product_name: string; description: string | null; category_id: string | null; brand: string | null; model_number: string | null
  barcode: string | null; ean?: string | null; image_url?: string | null; group_head?: string | null; minimum_cover_days?: number | null
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
    image_url: p.image_url ?? '',
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
