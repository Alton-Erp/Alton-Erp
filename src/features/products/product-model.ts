// Product Master domain model. Pure TypeScript (no React, no path aliases) so it
// can be unit-tested with Node directly. Must stay in sync with
// supabase/migrations/20261011090000_product_master.sql.

export const PRODUCT_TYPES = [
  'FINISHED_GOOD', 'RAW_MATERIAL', 'COMPONENT', 'SUBASSEMBLY', 'OUTSOURCED_COMPONENT', 'PACKAGING_MATERIAL', 'CONSUMABLE', 'OTHER',
] as const
export type ProductType = (typeof PRODUCT_TYPES)[number]

export const PRODUCT_TYPE_LABELS: Record<ProductType, string> = {
  FINISHED_GOOD: 'Finished Good',
  RAW_MATERIAL: 'Raw Material',
  COMPONENT: 'Component',
  SUBASSEMBLY: 'Subassembly',
  OUTSOURCED_COMPONENT: 'Outsourced Component',
  PACKAGING_MATERIAL: 'Packing Material',
  CONSUMABLE: 'Consumable',
  OTHER: 'Other',
}

/** Prefix of automatic SKUs (matches private.product_sku_prefix in the database). */
export const SKU_PREFIXES: Record<ProductType, string> = {
  FINISHED_GOOD: 'FG',
  RAW_MATERIAL: 'RM',
  COMPONENT: 'CMP',
  SUBASSEMBLY: 'SUB',
  OUTSOURCED_COMPONENT: 'OSC',
  PACKAGING_MATERIAL: 'PKG',
  CONSUMABLE: 'CON',
  OTHER: 'ITM',
}

/** Types that are made from other items and normally have a BOM. */
export const BOM_EXPECTED_TYPES: ProductType[] = ['FINISHED_GOOD', 'SUBASSEMBLY']
/** Types that may have a BOM at all (matches private.bom_output_type_ok). */
export const BOM_OUTPUT_TYPES: ProductType[] = ['FINISHED_GOOD', 'SUBASSEMBLY', 'COMPONENT', 'OUTSOURCED_COMPONENT', 'OTHER']

/** Default source when none is given (matches private.product_default_source). */
export function defaultSourceFor(type: ProductType): 'IN_HOUSE' | 'OUTSOURCED' {
  return type === 'FINISHED_GOOD' || type === 'SUBASSEMBLY' || type === 'COMPONENT' ? 'IN_HOUSE' : 'OUTSOURCED'
}

/** How a BOM component is obtained. */
export const BOM_SOURCES = ['IN_HOUSE', 'OUTSOURCED', 'PURCHASED'] as const
export type BomSource = (typeof BOM_SOURCES)[number]
export const BOM_SOURCE_LABELS: Record<BomSource, string> = { IN_HOUSE: 'In-house', OUTSOURCED: 'Outsourced', PURCHASED: 'Purchased' }

/** Default BOM line source from the component (matches private.default_bom_source). */
export function defaultBomSource(p: { product_type: string; default_source_type: string }): BomSource {
  if (p.default_source_type === 'IN_HOUSE') return 'IN_HOUSE'
  if (['RAW_MATERIAL', 'PACKAGING_MATERIAL', 'CONSUMABLE', 'OTHER'].includes(p.product_type)) return 'PURCHASED'
  if (p.default_source_type === 'OUTSOURCED') return 'OUTSOURCED'
  return 'IN_HOUSE'
}

export function parseBomSource(value: string): BomSource | null {
  const key = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  const map: Record<string, BomSource> = {
    IN_HOUSE: 'IN_HOUSE', INHOUSE: 'IN_HOUSE', MADE: 'IN_HOUSE', MANUFACTURED: 'IN_HOUSE',
    OUTSOURCED: 'OUTSOURCED', OUT_SOURCED: 'OUTSOURCED', JOB_WORK: 'OUTSOURCED', JOBWORK: 'OUTSOURCED',
    PURCHASED: 'PURCHASED', PURCHASE: 'PURCHASED', BOUGHT: 'PURCHASED', BOUGHT_OUT: 'PURCHASED', BUY: 'PURCHASED',
  }
  return map[key] ?? null
}

export const SOURCE_TYPES = ['IN_HOUSE', 'OUTSOURCED', 'HYBRID'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** Sourcing method (stored codes unchanged: IN_HOUSE / OUTSOURCED / HYBRID). */
export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  IN_HOUSE: 'Manufacture',
  OUTSOURCED: 'Purchase-IN',
  HYBRID: 'Outsourced-IMP',
}

export const SOURCE_TYPE_DESCRIPTIONS: Record<SourceType, string> = {
  IN_HOUSE: "Normally manufactured at the company's own plant (In-House). Product Master Cost follows the approved BOM.",
  OUTSOURCED: 'Purchased domestically from a supplier. Product Master Cost follows the latest valid posted GRN (GST excluded, after discount).',
  HYBRID: 'Externally sourced / imported, or made and bought. BOM and purchase costs are kept separately; the default cost source (BOM or GRN) decides the Product Master Cost.',
}

export const PRODUCT_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

export interface UnitDefinition { code: string; label: string; aliases: string[] }

/**
 * Standard units of measurement, in the order the Product Master offers them.
 * The code is what is stored in products.base_unit (the database only requires
 * 1-10 capital letters); the label is for display only and never validated.
 */
export const STANDARD_UNITS: UnitDefinition[] = [
  { code: 'PCS', label: 'Pieces', aliases: ['PC', 'PIECE', 'PIECES', 'NO', 'NUMBER'] },
  { code: 'NOS', label: 'Numbers', aliases: ['NUMBERS'] },
  { code: 'KGS', label: 'Kilograms', aliases: ['KILO', 'KILOS', 'KILOGRAM', 'KILOGRAMS'] },
  { code: 'GMS', label: 'Grams', aliases: ['GM', 'GRM', 'GRAM', 'GRAMS'] },
  { code: 'MTS', label: 'Metric Tonnes', aliases: ['TON', 'TONS', 'TONNE', 'TONNES', 'METRICTONNE', 'METRICTON', 'METRICTONS'] },
  { code: 'MTR', label: 'Metres', aliases: ['MTRS', 'METRE', 'METRES', 'METER', 'METERS'] },
  { code: 'LTR', label: 'Litres', aliases: ['LTRS', 'LITRE', 'LITRES', 'LITER', 'LITERS'] },
  { code: 'ROL', label: 'Rolls', aliases: ['RL', 'ROLLS'] },
  { code: 'BOX', label: 'Boxes', aliases: ['BOXES'] },
  { code: 'CTN', label: 'Cartons', aliases: ['CARTON', 'CARTONS'] },
  { code: 'SET', label: 'Sets', aliases: ['SETS'] },
  { code: 'PRS', label: 'Pairs', aliases: ['PR', 'PAIRS'] },
  { code: 'BDL', label: 'Bundles', aliases: ['BUNDLE', 'BUNDLES'] },
  { code: 'SQM', label: 'Square Metres', aliases: ['SQMT', 'M2', 'SQUAREMETRE', 'SQUAREMETER', 'SQUAREMETERS'] },
  { code: 'CBM', label: 'Cubic Metres', aliases: ['M3', 'CUM', 'CUBICMETRE', 'CUBICMETER', 'CUBICMETERS'] },
]

/** Other supported units, offered when the company's unit list (ERP Settings → Products) includes them. */
export const EXTRA_UNITS: UnitDefinition[] = [
  { code: 'BAG', label: 'Bags', aliases: ['BAGS'] },
  { code: 'ML', label: 'Millilitres', aliases: ['MILLILITRE', 'MILLILITRES'] },
  { code: 'SQFT', label: 'Square feet', aliases: ['SFT'] },
]

/** Every unit a new product can be given. */
export const UNITS: UnitDefinition[] = [...STANDARD_UNITS, ...EXTRA_UNITS]

/**
 * Earlier codes for the same units. Products saved with them keep them (no
 * conversion; stock and history stay as they are). They stay valid and are
 * shown in the dropdown only for a product that already uses one.
 */
export const LEGACY_UNITS: (UnitDefinition & { standard: string })[] = [
  { code: 'KG', label: 'Kilograms', aliases: [], standard: 'KGS' },
  { code: 'G', label: 'Grams', aliases: [], standard: 'GMS' },
  { code: 'MT', label: 'Metric Tonnes', aliases: [], standard: 'MTS' },
  { code: 'L', label: 'Litres', aliases: [], standard: 'LTR' },
  { code: 'M', label: 'Metres', aliases: [], standard: 'MTR' },
  { code: 'PAIR', label: 'Pairs', aliases: [], standard: 'PRS' },
  { code: 'ROLL', label: 'Rolls', aliases: [], standard: 'ROL' },
]

const unitCode = (value: string | null | undefined) => (value ?? '').trim().toUpperCase()
const definitionOf = (code: string) => UNITS.find((u) => u.code === code) ?? LEGACY_UNITS.find((u) => u.code === code)

/** True for a standard, extra or legacy unit code. */
export const isKnownUnit = (value: string | null | undefined): boolean => definitionOf(unitCode(value)) !== undefined

/** "Litres" for LTR (and for the older L); the code itself when unknown. */
export const unitLabel = (value: string | null | undefined): string => definitionOf(unitCode(value))?.label ?? unitCode(value)

/** "Litres (LTR)": the dropdown label. */
export function unitOptionLabel(value: string): string {
  const code = unitCode(value)
  const def = definitionOf(code)
  return def ? `${def.label} (${code})` : code
}

/** The same unit under its current or an older code (KG and KGS, L and LTR). */
export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const family = (v: string | null | undefined) => {
    const code = unitCode(v)
    return LEGACY_UNITS.find((u) => u.code === code)?.standard ?? code
  }
  return unitCode(a) !== '' && family(a) === family(b)
}

/**
 * Unit codes offered in the Product Master: the standard units, then the
 * company's other units from ERP Settings (all supported units when none are
 * set; older duplicate codes such as KG or LTR's L are left out), then the
 * product's own current unit so it always shows.
 */
export function productUnitOptions(settingsUnits: readonly string[] | null | undefined, current: readonly (string | null | undefined)[] = []): string[] {
  const out = STANDARD_UNITS.map((u) => u.code)
  const configured = settingsUnits?.length ? settingsUnits : EXTRA_UNITS.map((u) => u.code)
  for (const raw of configured) {
    const code = unitCode(raw)
    if (code && /^[A-Z]{1,10}$/.test(code) && !out.includes(code) && !LEGACY_UNITS.some((u) => u.code === code)) out.push(code)
  }
  for (const raw of current) {
    const code = unitCode(raw)
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

/**
 * GST rates in common use. A rate outside this list is allowed (rates change
 * by notification) but produces a warning so it can be double-checked.
 */
export const STANDARD_GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28, 40]

export const BARCODE_RE = /^[A-Za-z0-9-]{4,64}$/
export const HSN_RE = /^(\d{4}|\d{6}|\d{8})$/
export const CATEGORY_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,29}$/

/** EAN as typed: spaces and hyphens are ignored ("4006 3813 3393 1" = "4006381333931"). */
export const normalizeEan = (value: string): string => value.replace(/[\s-]/g, '')

/**
 * EAN-8 / EAN-13 problem, or null when valid. Same rule as the database
 * (private.ean_valid): digits only, 8 or 13 long, GS1 check digit (weights 3,1,3,…
 * from the digit left of the check digit).
 */
export function eanProblem(value: string): string | null {
  const ean = normalizeEan(value)
  if (!/^\d+$/.test(ean)) return 'EAN must contain digits only.'
  if (ean.length !== 8 && ean.length !== 13) return `EAN must have 8 (EAN-8) or 13 (EAN-13) digits; this one has ${ean.length}.`
  let sum = 0
  for (let i = 1; i < ean.length; i++) sum += Number(ean[ean.length - 1 - i]) * (i % 2 === 1 ? 3 : 1)
  const check = (10 - (sum % 10)) % 10
  if (check !== Number(ean[ean.length - 1])) return `EAN check digit is wrong: the last digit should be ${check}. Check the number for a typing error.`
  return null
}

/**
 * Values written to the products table (company_id is added by the service).
 * A null SKU gets the next automatic code for the type (FG-000001 …) from the database.
 */
export interface ProductInput {
  sku: string | null
  product_name: string
  description: string | null
  category_id: string | null
  brand: string | null
  model_number: string | null
  barcode: string | null
  status: ProductStatus
  product_type: ProductType
  default_source_type: SourceType
  base_unit: string
  track_batches: boolean
  track_expiry: boolean
  /**
   * true = physical stock item: an invoice can be posted only after it is dispatched.
   * false = service / non-stock item. Optional so spreadsheet imports keep the stored value.
   */
  inventory_tracked?: boolean
  /** EAN-8 / EAN-13 (check digit verified); unique within the company. */
  ean?: string | null
  /** External image link (http/https), shown when no image is uploaded. */
  image_url?: string | null
  /** Group Head (product group classification). */
  group_head?: string | null
  /** Minimum Stock Days: minimum inventory coverage in days (informational). */
  minimum_cover_days?: number | null
  hsn_code: string | null
  gst_rate: number | null
  selling_price: number | null
  /** Cost per base unit (Product Master "Cost"). The database keeps standard_manufacturing_cost equal to it (migration 20261127090000). */
  standard_cost: number | null
  minimum_selling_price: number | null
  /** Earlier quantity-based reorder level (kept as stored; never converted to days). */
  reorder_level: number | null
  /** Earlier quantity-based minimum stock (kept as stored; no longer edited on the form). */
  minimum_level: number | null
  /** Days needed to procure or manufacture the product. */
  lead_time_days: number | null
  /** Reorder when days of stock cover fall to this many days or fewer. */
  reorder_level_days: number | null
  /** Maximum retail price (INR, incl. taxes). Never used as the invoice price. */
  mrp: number | null
  length_cm: number | null
  width_cm: number | null
  height_cm: number | null
  supplier_model_number: string | null
  supplier_product_name: string | null
  preferred_supplier_id: string | null
  remarks: string | null
  is_manufacturable: boolean
  has_bom: boolean
  production_notes: string | null
}

/**
 * Category code derived from a name (upper-case letters and digits joined by
 * "-", at most 24 characters + a number suffix), unique against `taken`.
 * Matches CATEGORY_CODE_RE.
 */
export function categoryCodeFor(name: string, taken: Set<string>): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'CAT'
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-X`
}

/**
 * A SKU as typed or pasted, cleaned: invisible characters (zero-width spaces, byte-order marks) removed,
 * look-alike characters folded (non-breaking or full-width spaces, full-width letters), ends trimmed.
 */
export function cleanSku(sku: string): string {
  return sku.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim()
}

/** SKU uniqueness is case-insensitive (matches the database unique index). */
export function skuKey(sku: string): string {
  return cleanSku(sku).toLowerCase()
}

/** SKU without separators ("FG-0001", "fg 0001" and "FG0001" are the same): flags near-misses, never used to match. */
export function looseSkuKey(sku: string): string {
  return skuKey(sku).replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Unit code for a typed unit (Excel import). An exact code is kept as it is,
 * older codes included (KG stays KG); a name or alias gives the standard code
 * ("Litres" and "ltrs" give LTR, "Rolls" gives ROL). Null when unrecognised.
 */
export function findUnit(value: string): string | null {
  const key = value.trim().toUpperCase().replace(/[.\s]/g, '')
  if (!key) return null
  if (isKnownUnit(key)) return key
  const unit = UNITS.find((u) => u.label.toUpperCase().replace(/\s/g, '') === key || u.aliases.includes(key))
  return unit?.code ?? null
}

function enumKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
}

const SOURCE_ALIASES: Record<string, SourceType> = {
  IN_HOUSE: 'IN_HOUSE',
  INHOUSE: 'IN_HOUSE',
  MANUFACTURED: 'IN_HOUSE',
  OWN_MANUFACTURING: 'IN_HOUSE',
  OUTSOURCED: 'OUTSOURCED',
  OUT_SOURCED: 'OUTSOURCED',
  PURCHASED: 'OUTSOURCED',
  BOUGHT_OUT: 'OUTSOURCED',
  TRADED: 'OUTSOURCED',
  TRADING: 'OUTSOURCED',
  HYBRID: 'HYBRID',
  BOTH: 'HYBRID',
  MANUFACTURE: 'IN_HOUSE',
  MAKE: 'IN_HOUSE',
  PURCHASE: 'OUTSOURCED',
  BUY: 'OUTSOURCED',
  BOTH_MAKE_BUY: 'HYBRID',
  MAKE_BUY: 'HYBRID',
  MAKE_AND_BUY: 'HYBRID',
  // Labels from 2026-12: Purchase-IN (stored OUTSOURCED) and Outsourced-IMP (stored HYBRID).
  // The older code OUTSOURCED keeps its meaning (Purchase-IN); only the full new label means HYBRID.
  PURCHASE_IN: 'OUTSOURCED',
  PURCHASEIN: 'OUTSOURCED',
  OUTSOURCED_IMP: 'HYBRID',
  OUTSOURCEDIMP: 'HYBRID',
  OUTSOURCED_IMPORT: 'HYBRID',
}

export function parseSourceType(value: string): SourceType | null {
  return SOURCE_ALIASES[enumKey(value)] ?? null
}

const PRODUCT_TYPE_ALIASES: Record<string, ProductType> = {
  FINISHED_GOOD: 'FINISHED_GOOD',
  FINISHED_GOODS: 'FINISHED_GOOD',
  FG: 'FINISHED_GOOD',
  RAW_MATERIAL: 'RAW_MATERIAL',
  RAW_MATERIALS: 'RAW_MATERIAL',
  RM: 'RAW_MATERIAL',
  COMPONENT: 'COMPONENT',
  COMPONENTS: 'COMPONENT',
  SUBASSEMBLY: 'SUBASSEMBLY',
  SUBASSEMBLIES: 'SUBASSEMBLY',
  SUB_ASSEMBLY: 'SUBASSEMBLY',
  SUB_ASSEMBLIES: 'SUBASSEMBLY',
  SA: 'SUBASSEMBLY',
  OUTSOURCED_COMPONENT: 'OUTSOURCED_COMPONENT',
  OUTSOURCED_COMPONENTS: 'OUTSOURCED_COMPONENT',
  OUTSOURCED_PART: 'OUTSOURCED_COMPONENT',
  OUTSOURCED_PARTS: 'OUTSOURCED_COMPONENT',
  BOUGHT_OUT_COMPONENT: 'OUTSOURCED_COMPONENT',
  PACKAGING_MATERIAL: 'PACKAGING_MATERIAL',
  PACKAGING_MATERIALS: 'PACKAGING_MATERIAL',
  PACKING_MATERIAL: 'PACKAGING_MATERIAL',
  PACKING_MATERIALS: 'PACKAGING_MATERIAL',
  PACKAGING: 'PACKAGING_MATERIAL',
  PACKING: 'PACKAGING_MATERIAL',
  PM: 'PACKAGING_MATERIAL',
  CONSUMABLE: 'CONSUMABLE',
  CONSUMABLES: 'CONSUMABLE',
  OTHER: 'OTHER',
  OTHERS: 'OTHER',
  OTHER_ITEM: 'OTHER',
  OTHER_ITEMS: 'OTHER',
}

export function parseProductType(value: string): ProductType | null {
  return PRODUCT_TYPE_ALIASES[enumKey(value)] ?? null
}

/**
 * Parses a non-negative decimal entered by a user or read from a spreadsheet.
 * Accepts thousands separators, a currency symbol and a trailing %.
 * Returns undefined for blank input and NaN for invalid input.
 */
export function parseDecimal(value: string, maxDecimals: number): number | undefined {
  const cleaned = value.trim().replace(/^₹\s*/, '').replace(/,/g, '').replace(/%$/, '').trim()
  if (cleaned === '') return undefined
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return Number.NaN
  const decimals = cleaned.split('.')[1]?.length ?? 0
  if (decimals > maxDecimals) return Number.NaN
  return Number(cleaned)
}

// --- Image links -------------------------------------------------------------

export const IMAGE_URL_MAX_LENGTH = 2048

/**
 * Problem with an image link, or null when it can be saved. Same rule as the
 * database (private.product_image_url_valid): http or https, a host name, no
 * spaces, no user name / password, no localhost or private network address.
 * The ERP never downloads the link on a server; browsers load it to show it.
 */
export function imageUrlProblem(value: string): string | null {
  const url = value.trim()
  if (!url) return null
  if (url.length > IMAGE_URL_MAX_LENGTH) return `The image link is too long (at most ${IMAGE_URL_MAX_LENGTH} characters).`
  if (/\s/.test(url)) return 'The image link contains spaces. Copy the full link from the browser address bar.'
  if (!/^https?:\/\//i.test(url)) return 'Use an image link that starts with http:// or https://.'
  if (!/^https?:\/\/[^/?#@]+([/?#].*)?$/i.test(url)) return url.slice(url.indexOf('//') + 2).split(/[/?#]/)[0].includes('@')
    ? 'Image links with a user name or password are not allowed.'
    : 'This is not a valid image link.'
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return 'This is not a valid image link.'
  }
  if (!host || host.startsWith('[')) return 'This is not a valid image link.'
  if (host === 'localhost' || host === '0.0.0.0' || /\.(localhost|local|internal|lan|home)$/.test(host)
    || /^(127|10|0)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return 'Links to local or private network addresses are not allowed.'
  }
  return null
}

/** Link as saved: trimmed, null when blank. */
export const normaliseImageUrl = (value: string | null | undefined): string | null => (value ?? '').trim() || null
