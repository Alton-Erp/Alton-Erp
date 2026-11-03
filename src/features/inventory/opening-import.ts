// Opening-stock spreadsheet import: column mapping + row validation.
// Pure TypeScript (unit-tested). Previewing never writes to the database; the
// accepted rows are staged server-side for approval and re-validated there.

import { parseSheetDate, parseStockSource } from './inventory-model.ts'

export const OPENING_FIELDS = [
  { key: 'sku', label: 'SKU', required: true, synonyms: ['sku', 'product code', 'item code', 'sku code'] },
  { key: 'warehouse', label: 'Warehouse', required: true, synonyms: ['warehouse', 'warehouse code', 'store', 'godown'] },
  { key: 'location', label: 'Location', required: false, synonyms: ['location', 'location code', 'bin', 'rack', 'shelf'] },
  { key: 'source', label: 'Source', required: true, synonyms: ['source', 'source type', 'stock source'] },
  { key: 'quantity', label: 'Quantity', required: true, synonyms: ['quantity', 'qty', 'opening qty', 'opening quantity', 'stock', 'on hand'] },
  { key: 'unit', label: 'Unit', required: false, synonyms: ['unit', 'uom'] },
  { key: 'batch', label: 'Batch', required: false, synonyms: ['batch', 'batch number', 'batch no', 'lot', 'lot number'] },
  { key: 'mfg_date', label: 'Manufacturing Date', required: false, synonyms: ['manufacturing date', 'mfg date', 'mfg'] },
  { key: 'expiry_date', label: 'Expiry Date', required: false, synonyms: ['expiry date', 'expiry', 'exp date', 'best before'] },
  { key: 'unit_cost', label: 'Unit Cost', required: false, synonyms: ['unit cost', 'cost', 'rate', 'cost price'] },
  { key: 'effective_date', label: 'Effective Date', required: false, synonyms: ['effective date', 'date', 'as on', 'as of'] },
  { key: 'reference', label: 'Reference', required: false, synonyms: ['reference', 'ref'] },
  { key: 'notes', label: 'Notes', required: false, synonyms: ['notes', 'remarks', 'comment'] },
] as const

export type OpeningFieldKey = (typeof OPENING_FIELDS)[number]['key']
export type OpeningMapping = Record<OpeningFieldKey, number | null>

export interface OpeningProduct {
  id: string
  sku: string
  base_unit: string
  track_batches: boolean
  track_expiry: boolean
  status: string
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
}

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

    const rawSource = cell(row, 'source')
    const source = rawSource ? parseStockSource(rawSource) : null
    if (!rawSource) errors.push('Source is required (In-House, Outsourced, or Unknown for unverified legacy stock).')
    else if (!source) errors.push(`Source "${rawSource}" is not recognised. Use In-House, Outsourced or Unknown.`)
    else if (source === 'UNKNOWN') warnings.push('Unverified source: will be flagged for review after posting.')

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

    const cost = decimal(cell(row, 'unit_cost'), 4)
    if (cost === null) errors.push('Unit cost must be a number ≥ 0 (up to 4 decimals).')
    if (cost === undefined) warnings.push('No unit cost: valuation will show this stock as "cost unknown".')

    const effRaw = cell(row, 'effective_date')
    const eff = effRaw ? parseSheetDate(effRaw) : ctx.defaultEffectiveDate
    if (eff === null) errors.push('Effective date is not a valid date.')
    else if (eff && eff > ctx.today) errors.push('Effective date cannot be in the future.')

    if (product && location && source) {
      const key = `${product.id}|${location.id}|${batch.toLowerCase()}|${source}`
      const first = seen.get(key)
      if (first !== undefined) errors.push(`Duplicate of row ${first} (same product, location, batch and source).`)
      else seen.set(key, rowNumber)
    }

    out.push({
      rowNumber,
      sku,
      status: errors.length ? 'error' : 'valid',
      errors,
      warnings,
      payload: errors.length
        ? null
        : {
            line_no: rowNumber,
            product_id: product!.id,
            location_id: location!.id,
            source_type: source!,
            quantity: qty as number,
            unit: product!.base_unit,
            batch_number: batch || null,
            manufacturing_date: mfg ?? null,
            expiry_date: exp ?? null,
            unit_cost: cost ?? null,
            effective_date: eff as string,
            reference: cell(row, 'reference') || null,
            notes: cell(row, 'notes') || null,
          },
    })
  })
  return out
}
