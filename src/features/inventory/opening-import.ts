// Opening-stock spreadsheet import: column mapping + row validation.
// Pure TypeScript (unit-tested). Previewing never writes to the database; the
// accepted rows are staged server-side for approval and re-validated there.
//
// Users never choose a stock source for opening stock. The database still stores
// one per line, so it is derived from the product master (openingStockSource),
// the same way production records IN_HOUSE and purchase receipts OUTSOURCED.
// A Source column in an older spreadsheet is simply not mapped.
//
// Unit cost (migration 20261129090000): never read from the file. Every row gets the Product
// Master Cost of its product, fetched from the database (opening_stock_product_costs); the
// server sets it again when the lines are submitted. The cost is optional (migration
// 20261204090000): a row whose product has no valid cost (missing or zero) is accepted with a
// pending cost and is not valued; no cost is assumed and it is never imported at zero.
//
// Existing records (migration 20261206090000): with an additive context (the Excel import), a row whose
// product + location + batch already has a posted opening stock record is matched to it and its quantity is
// ADDED (never replaced) as a separate ledger entry. Without that context (manual entry, older databases) such a
// row is rejected as before. The cost of added quantity is the existing stock's cost; an Excel cost is read only
// for matched rows and only when "Unit Cost" is selected, and blank cells never change anything.

import { parseSheetDate, type StockSourceCode } from './inventory-model.ts'

export const OPENING_FIELDS = [
  { key: 'sku', label: 'SKU', required: true, synonyms: ['sku', 'product code', 'item code', 'sku code'] },
  { key: 'warehouse', label: 'Warehouse', required: true, synonyms: ['warehouse', 'warehouse code', 'store', 'godown'] },
  { key: 'location', label: 'Location', required: false, synonyms: ['location', 'location code', 'bin', 'rack', 'shelf'] },
  { key: 'quantity', label: 'Quantity', required: true, synonyms: ['quantity', 'qty', 'opening qty', 'opening quantity', 'stock', 'on hand'] },
  { key: 'unit', label: 'Unit', required: false, synonyms: ['unit', 'uom'] },
  { key: 'batch', label: 'Batch', required: false, synonyms: ['batch', 'batch number', 'batch no', 'lot', 'lot number'] },
  { key: 'mfg_date', label: 'Manufacturing Date', required: false, synonyms: ['manufacturing date', 'mfg date', 'mfg'] },
  { key: 'expiry_date', label: 'Expiry Date', required: false, synonyms: ['expiry date', 'expiry', 'exp date', 'best before'] },
  { key: 'effective_date', label: 'Effective Date', required: false, synonyms: ['effective date', 'date', 'as on', 'as of'] },
  { key: 'reference', label: 'Reference', required: false, synonyms: ['reference', 'ref'] },
  { key: 'notes', label: 'Notes', required: false, synonyms: ['notes', 'remarks', 'comment'] },
] as const

export type OpeningFieldKey = (typeof OPENING_FIELDS)[number]['key']

/** Cost / value columns of a file: shown as ignored (the cost always comes from the Product Master). */
export function ignoredCostColumns(headers: string[]): string[] {
  const names = ['unit cost', 'cost', 'rate', 'cost price', 'unit rate', 'price', 'value', 'opening value', 'amount', 'total value']
  return headers.filter((h) => names.includes(String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s*(rs|inr)$/, '').trim()))
}
export type OpeningMapping = Record<OpeningFieldKey, number | null>

export interface OpeningProduct {
  id: string
  sku: string
  base_unit: string
  track_batches: boolean
  track_expiry: boolean
  status: string
  product_name?: string
  /** Product master sourcing strategy (IN_HOUSE / OUTSOURCED / HYBRID). */
  default_source_type?: string | null
  product_type?: string | null
}

/** Types the product master makes in-house by default (private.product_default_source). */
const MADE_IN_HOUSE_TYPES = new Set(['FINISHED_GOOD', 'SUBASSEMBLY', 'COMPONENT'])

/**
 * The stock source stored for an opening stock line. Opening stock has no
 * user-chosen source: IN_HOUSE products are recorded as IN_HOUSE, OUTSOURCED
 * products as OUTSOURCED, and HYBRID (or missing) follows the product type the
 * same way the product master defaults it. Never UNKNOWN, so opening stock is
 * not flagged as "unverified source".
 */
export function openingStockSource(product: { default_source_type?: string | null; product_type?: string | null }): Exclude<StockSourceCode, 'UNKNOWN'> {
  if (product.default_source_type === 'IN_HOUSE') return 'IN_HOUSE'
  if (product.default_source_type === 'OUTSOURCED') return 'OUTSOURCED'
  return MADE_IN_HOUSE_TYPES.has(product.product_type ?? '') ? 'IN_HOUSE' : 'OUTSOURCED'
}

/** One opening balance per product + location + batch (whatever source it was stored with). */
export const openingBalanceKey = (productId: string, locationId: string, batch: string | null | undefined) =>
  `${productId}|${locationId}|${(batch ?? '').trim().toLowerCase()}`

export interface ExistingOpening {
  product_id: string
  location_id: string
  batch_number: string | null
  document_number: string | null
}

/** Existing pending/posted opening balances keyed by openingBalanceKey, valued by document number. */
export function existingOpeningIndex(rows: ExistingOpening[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of rows) map.set(openingBalanceKey(r.product_id, r.location_id, r.batch_number), r.document_number ?? 'an earlier document')
  return map
}

export interface OpeningLocation {
  id: string
  warehouseCode: string
  locationCode: string
  active: boolean
  isDefault: boolean
}

export interface OpeningContext {
  /** Keyed by lower-case SKU. */
  products: Map<string, OpeningProduct>
  locations: OpeningLocation[]
  /** yyyy-mm-dd used when the Effective Date column is absent/blank. */
  defaultEffectiveDate: string
  /** Company "today" (yyyy-mm-dd); future dates are rejected. */
  today: string
  /** Opening balances already pending or posted (existingOpeningIndex). */
  existing?: Map<string, string>
  /** Product Master Cost by product id (from the database). A product without an entry has no cost. */
  costs?: Map<string, { cost: number | null; valid: boolean }>
  /** Excel import: match existing records and add to them instead of rejecting them. */
  additive?: OpeningAdditiveContext
}

/** Fields of an existing opening stock record the import may change. Product, location and batch only identify it. */
export interface OpeningImportFieldSelection {
  /** Add the imported quantity to the existing quantity (never replace it). */
  quantity: boolean
  /** Use a valid Excel unit cost for the added quantity (existing cost rules apply). */
  unit_cost: boolean
  /** Put the Excel remark on the addition entry. */
  remarks: boolean
}

export const DEFAULT_IMPORT_FIELDS: OpeningImportFieldSelection = { quantity: true, unit_cost: false, remarks: false }

export const IMPORT_FIELD_OPTIONS: { key: keyof OpeningImportFieldSelection; label: string; hint: string }[] = [
  { key: 'quantity', label: 'Quantity (Add to Existing Quantity)', hint: 'The imported quantity is added to the existing quantity (100 + 25 = 125), never replaces it.' },
  { key: 'unit_cost', label: 'Unit Cost', hint: 'A valid Excel unit cost for the added quantity. It must equal the cost of the existing stock (posted stock is never re-valued); stock without a cost needs the opening cost override.' },
  { key: 'remarks', label: 'Remarks', hint: 'The Excel Notes / Remarks text is recorded on the addition entry.' },
]

/** An opening stock record as matched by the import (from opening_stock_import_matches). */
export interface OpeningMatchRecord {
  document_number: string
  status: 'PENDING_APPROVAL' | 'POSTED'
  product_id: string
  location_id: string
  batch_number: string | null
  quantity: number
  added_quantity: number
  lot_cost: number | null
}

export interface OpeningAdditiveContext {
  /** Records keyed by openingBalanceKey (openingMatchIndex). */
  matches: Map<string, OpeningMatchRecord[]>
  fields: OpeningImportFieldSelection
  /** Index of the Excel unit cost column, if the file has one (read only for matched rows with Unit Cost selected). */
  costColumn: number | null
  /** The opening cost override is enabled for this user (needed to give stock without a cost a cost). */
  overrideAllowed: boolean
}

export function openingMatchIndex(records: OpeningMatchRecord[]): Map<string, OpeningMatchRecord[]> {
  const map = new Map<string, OpeningMatchRecord[]>()
  for (const r of records) {
    const key = openingBalanceKey(r.product_id, r.location_id, r.batch_number)
    map.set(key, [...(map.get(key) ?? []), r])
  }
  return map
}

/** Index of the first unit cost column of a file (the import reads it only for matched rows, when selected). */
export function excelCostColumn(headers: string[]): number | null {
  const names = ['unit cost', 'cost', 'rate', 'cost price', 'unit rate']
  const i = headers.findIndex((h) => names.includes(String(h ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s*(rs|inr)$/, '').trim()))
  return i >= 0 ? i : null
}

export interface OpeningPayload {
  line_no: number
  product_id: string
  location_id: string
  source_type: string
  quantity: number
  unit: string
  batch_number: string | null
  manufacturing_date: string | null
  expiry_date: string | null
  unit_cost: number | null
  effective_date: string
  reference: string | null
  notes: string | null
}

export interface OpeningRowResult {
  rowNumber: number
  sku: string
  status: 'valid' | 'error'
  errors: string[]
  warnings: string[]
  payload: OpeningPayload | null
  productName?: string
  quantity?: number
  /** Product Master Cost (null = none: pending cost, not valued). */
  cost?: number | null
  /** Quantity × Product Master Cost. */
  value?: number | null
  /** Excel import only: a new record, quantity added to an existing one, or an existing one left unchanged. */
  action?: 'new' | 'add' | 'keep'
  /** The record the row is matched to (action add / keep). */
  match?: {
    document_number: string | null
    /** Existing quantity before this row (record + earlier additions, + earlier rows of the file). */
    existing: number
    /** Existing + this row (add); the existing quantity (keep). */
    newQuantity: number
    unit: string
    /** Cost of the existing stock (null = not valued). */
    lotCost: number | null
    /** Matched to a new record created by an earlier row of the same file. */
    fromFile: boolean
  }
  /** Valid Excel unit cost read for a matched row (Unit Cost selected); undefined = blank / not read. */
  excelCost?: number
}

/** Opening stock value = quantity × Product Master Cost (rupees, 2 decimals). */
export const openingValue = (quantity: number | null | undefined, cost: number | null | undefined): number | null =>
  quantity === null || quantity === undefined || cost === null || cost === undefined ? null : Math.round(quantity * cost * 100) / 100

const norm = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function autoMapOpening(headers: string[]): OpeningMapping {
  const normalized = headers.map(norm)
  const used = new Set<number>()
  const mapping = {} as OpeningMapping
  for (const f of OPENING_FIELDS) {
    const idx = normalized.findIndex((h, i) => !used.has(i) && h !== '' && f.synonyms.map(norm).includes(h))
    mapping[f.key] = idx >= 0 ? idx : null
    if (idx >= 0) used.add(idx)
  }
  return mapping
}

export function missingOpeningFields(mapping: OpeningMapping): string[] {
  return OPENING_FIELDS.filter((f) => f.required && mapping[f.key] === null).map((f) => f.label)
}

/** Row with the most recognised headers among the first 20 (skips title rows). */
export function detectOpeningHeader(rows: string[][]): number {
  let best = -1
  let bestScore = 1
  rows.slice(0, 20).forEach((row, i) => {
    const score = Object.values(autoMapOpening(row)).filter((v) => v !== null).length
    if (score > bestScore) {
      best = i
      bestScore = score
    }
  })
  return best >= 0 ? best : rows.findIndex((r) => r.some((c) => c !== ''))
}

function decimal(value: string, maxDecimals: number): number | null | undefined {
  const v = value.trim().replace(/^₹\s*/, '').replace(/,/g, '')
  if (v === '') return undefined
  if (!/^\d+(\.\d+)?$/.test(v) || (v.split('.')[1]?.length ?? 0) > maxDecimals) return null
  return Number(v)
}

export function validateOpeningRows(rows: string[][], mapping: OpeningMapping, ctx: OpeningContext, firstDataRowNumber = 2): OpeningRowResult[] {
  const cell = (row: string[], key: OpeningFieldKey) => (mapping[key] === null ? '' : String(row[mapping[key]!] ?? '').trim())
  const mapped = Object.values(mapping).filter((i): i is number => i !== null)
  const seen = new Map<string, number>()
  // Excel import: quantity per record so far (existing + earlier rows of the file).
  const running = new Map<string, number>()
  const out: OpeningRowResult[] = []

  rows.forEach((row, index) => {
    const rowNumber = index + firstDataRowNumber
    if (mapped.every((i) => String(row[i] ?? '').trim() === '')) return
    const errors: string[] = []
    const warnings: string[] = []
    const sku = cell(row, 'sku')
    const product = sku ? ctx.products.get(sku.toLowerCase()) : undefined
    if (!sku) errors.push('SKU is required.')
    else if (!product) errors.push(`SKU "${sku}" was not found in the product master.`)
    else if (product.status !== 'ACTIVE') errors.push(`Product ${product.sku} is inactive.`)

    const whCode = cell(row, 'warehouse').toUpperCase()
    const locCode = cell(row, 'location').toUpperCase()
    let location: OpeningLocation | undefined
    if (!whCode) errors.push('Warehouse code is required.')
    else {
      const inWarehouse = ctx.locations.filter((l) => l.warehouseCode === whCode)
      if (inWarehouse.length === 0) errors.push(`Warehouse "${whCode}" does not exist.`)
      else {
        location = locCode ? inWarehouse.find((l) => l.locationCode === locCode) : inWarehouse.find((l) => l.isDefault)
        if (!location) errors.push(locCode ? `Location "${locCode}" does not exist in warehouse ${whCode}.` : `Warehouse ${whCode} has no default location.`)
        else if (!location.active) errors.push(`Location ${whCode}/${location.locationCode} is inactive.`)
        if (!locCode && location) warnings.push(`No location given: using ${whCode}/${location.locationCode}.`)
      }
    }

    const qty = decimal(cell(row, 'quantity'), 3)
    if (qty === undefined) errors.push('Quantity is required.')
    else if (qty === null || qty <= 0) errors.push('Quantity must be a number greater than zero (up to 3 decimals).')

    const unit = cell(row, 'unit').toUpperCase()
    if (unit && product && unit !== product.base_unit) errors.push(`Unit ${unit} does not match the product unit ${product.base_unit}.`)

    const batch = cell(row, 'batch')
    if (product?.track_batches && !batch) errors.push(`Batch number is required for ${product.sku}.`)
    if (product && !product.track_batches && batch) errors.push(`${product.sku} does not use batch tracking; leave the batch blank.`)
    if (batch && !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,49}$/.test(batch)) errors.push('Batch numbers may contain letters, digits and . _ / - only.')

    const mfg = parseSheetDate(cell(row, 'mfg_date'))
    const exp = parseSheetDate(cell(row, 'expiry_date'))
    if (mfg === null) errors.push('Manufacturing date is not a valid date (use YYYY-MM-DD or DD-MM-YYYY).')
    if (exp === null) errors.push('Expiry date is not a valid date (use YYYY-MM-DD or DD-MM-YYYY).')
    if (exp && product && !product.track_batches) errors.push('Expiry dates require batch tracking on the product.')
    if (!exp && product?.track_expiry) errors.push(`Expiry date is required for ${product.sku}.`)
    if (mfg && exp && mfg > exp) errors.push('Manufacturing date is after the expiry date.')
    if (exp && exp < ctx.today) warnings.push('Batch is already expired.')

    // The Product Master Cost when it is valid; never a cost from the file. Without one the row is
    // still accepted: its quantity is recorded with a pending cost and is not valued.
    const master = product ? ctx.costs?.get(product.id) : undefined
    const cost = master?.valid && master.cost !== null && master.cost > 0 ? master.cost : null

    const effRaw = cell(row, 'effective_date')
    const eff = effRaw ? parseSheetDate(effRaw) : ctx.defaultEffectiveDate
    if (eff === null) errors.push('Effective date is not a valid date.')
    else if (eff && eff > ctx.today) errors.push('Effective date cannot be in the future.')

    const add = ctx.additive
    let action: OpeningRowResult['action'] = add ? 'new' : undefined
    let match: OpeningRowResult['match']
    let excelCost: number | undefined
    if (product && location && !add) {
      const key = openingBalanceKey(product.id, location.id, batch)
      const first = seen.get(key)
      if (first !== undefined) errors.push(`Duplicate of row ${first} (same product, location and batch).`)
      else seen.set(key, rowNumber)
      const recorded = ctx.existing?.get(key)
      if (recorded) errors.push(`Opening stock for this product, location and batch already exists (${recorded}).`)
    } else if (product && location && add) {
      const key = openingBalanceKey(product.id, location.id, batch)
      const records = add.matches.get(key) ?? []
      const fileRow = seen.get(key)
      const quantity = typeof qty === 'number' ? qty : 0
      if (records.length > 1) {
        errors.push('This product, location and batch has more than one opening stock record (different sources); add to it by manual stock adjustment instead.')
      } else if (records[0]?.status === 'PENDING_APPROVAL') {
        errors.push(`Opening stock for this product, location and batch is awaiting approval (${records[0].document_number}). Approve or reject it before adding to it.`)
      } else if (records.length === 1 || fileRow !== undefined) {
        const rec = records[0] as OpeningMatchRecord | undefined
        const lotCost = rec ? rec.lot_cost : cost
        const existing = running.get(key) ?? (rec ? rec.quantity + rec.added_quantity : 0)
        if (!rec && !add.fields.quantity) errors.push(`Same product, location and batch as row ${fileRow}; select "Quantity" to add the rows together.`)
        action = add.fields.quantity ? 'add' : 'keep'
        // Excel cost: read only when Unit Cost is selected; blank keeps the existing cost.
        if (action === 'add' && add.fields.unit_cost && add.costColumn !== null) {
          const parsed = decimal(String(row[add.costColumn] ?? ''), 4)
          if (parsed === null || parsed === 0) errors.push('Unit cost must be greater than zero (up to 4 decimals), or left blank to keep the existing cost.')
          else if (parsed !== undefined) {
            excelCost = parsed
            if (lotCost !== null && Math.round(parsed * 10000) !== Math.round(lotCost * 10000)) {
              errors.push(`Unit cost ${parsed} differs from the cost of the existing stock${rec ? ` in ${rec.document_number}` : ''} (${lotCost}). Adding it would re-value that stock: keep the existing cost, or import it under a new batch number to keep a separate cost.`)
            } else if (lotCost === null && !add.overrideAllowed) {
              errors.push(`The existing stock${rec ? ` in ${rec.document_number}` : ''} has no cost; giving the added quantity a cost needs the opening stock cost override. Leave the cost blank to keep it pending.`)
            }
          }
        }
        const newQuantity = action === 'add' ? Math.round((existing + quantity) * 1000) / 1000 : existing
        match = { document_number: rec?.document_number ?? null, existing, newQuantity, unit: product.base_unit, lotCost, fromFile: !rec }
        if (errors.length === 0 && action === 'add') running.set(key, newQuantity)
        if (errors.length === 0 && action === 'add' && (excelCost ?? lotCost) === null) {
          warnings.push('The existing stock has no cost: the added quantity is recorded with a pending cost (not valued).')
        }
      } else if (errors.length === 0) {
        seen.set(key, rowNumber)
        running.set(key, quantity)
      }
    }
    if (product && cost === null && action !== 'add' && action !== 'keep') {
      warnings.push(`${product.sku} has no Product Master Cost: recorded with a pending cost (not valued until a cost is set).`)
    }
    const rowCost = action === 'add' ? excelCost ?? match?.lotCost ?? null : action === 'keep' ? null : cost

    out.push({
      rowNumber,
      sku,
      status: errors.length ? 'error' : 'valid',
      errors,
      warnings,
      productName: product?.product_name,
      quantity: typeof qty === 'number' ? qty : undefined,
      cost: product ? rowCost : undefined,
      value: typeof qty === 'number' && action !== 'keep' ? openingValue(qty, rowCost) : null,
      ...(action ? { action } : {}),
      ...(match ? { match } : {}),
      ...(excelCost !== undefined ? { excelCost } : {}),
      payload: errors.length
        ? null
        : {
            line_no: rowNumber,
            product_id: product!.id,
            location_id: location!.id,
            source_type: openingStockSource(product!),
            quantity: qty as number,
            unit: product!.base_unit,
            batch_number: batch || null,
            manufacturing_date: mfg ?? null,
            expiry_date: exp ?? null,
            unit_cost: action === 'add' ? excelCost ?? null : cost,
            effective_date: eff as string,
            reference: cell(row, 'reference') || null,
            notes: cell(row, 'notes') || null,
          },
    })
  })
  return out
}
