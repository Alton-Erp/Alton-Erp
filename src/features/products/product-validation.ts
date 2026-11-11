// Validation shared by the product form and the spreadsheet import.
// The database enforces the same hard rules; this layer gives immediate,
// field-level feedback and non-blocking recommendations.

import {
  BARCODE_RE,
  HSN_RE,
  STANDARD_GST_RATES,
  defaultSourceFor,
  eanProblem,
  imageUrlProblem,
  normaliseImageUrl,
  isKnownUnit,
  normalizeEan,
  parseDecimal,
  type ProductInput,
  type ProductStatus,
  type ProductType,
  type SourceType,
} from './product-model.ts'
import type { ProductRow } from '../../types/database.ts'

/** Raw form values (strings for text inputs). */
export interface ProductFormValues {
  sku: string
  product_name: string
  description: string
  category_id: string
  brand: string
  model_number: string
  barcode: string
  ean: string
  /** External image link (http/https). */
  image_url: string
  supplier_model_number: string
  supplier_product_name: string
  status: ProductStatus
  product_type: ProductType | ''
  default_source_type: SourceType | ''
  base_unit: string
  track_batches: boolean
  track_expiry: boolean
  inventory_tracked: boolean
  length_cm: string
  width_cm: string
  height_cm: string
  hsn_code: string
  gst_rate: string
  mrp: string
  selling_price: string
  standard_cost: string
  minimum_selling_price: string
  /** Earlier quantity-based reorder level (not on the form; kept unless cleared). */
  reorder_level: string
  /** Earlier minimum stock quantity (not on the form; kept unless cleared). */
  minimum_level: string
  lead_time_days: string
  reorder_level_days: string
  group_head: string
  /** Minimum Stock Days (days of cover). */
  minimum_cover_days: string
  preferred_supplier_id: string
  remarks: string
  is_manufacturable: boolean
  has_bom: boolean
  production_notes: string
}

export type ProductField = keyof ProductFormValues

export interface ValidationResult {
  input: ProductInput | null
  errors: Partial<Record<ProductField, string>>
  /** Recommendations; never block saving. */
  warnings: string[]
}

export const EMPTY_PRODUCT_FORM: ProductFormValues = {
  sku: '',
  product_name: '',
  description: '',
  category_id: '',
  brand: '',
  model_number: '',
  barcode: '',
  ean: '',
  image_url: '',
  supplier_model_number: '',
  supplier_product_name: '',
  status: 'ACTIVE',
  product_type: '',
  default_source_type: '',
  base_unit: 'PCS',
  track_batches: false,
  track_expiry: false,
  inventory_tracked: true,
  length_cm: '',
  width_cm: '',
  height_cm: '',
  hsn_code: '',
  gst_rate: '',
  mrp: '',
  selling_price: '',
  standard_cost: '',
  minimum_selling_price: '',
  reorder_level: '',
  minimum_level: '',
  lead_time_days: '',
  reorder_level_days: '',
  group_head: '',
  minimum_cover_days: '',
  preferred_supplier_id: '',
  remarks: '',
  is_manufacturable: false,
  has_bom: false,
  production_notes: '',
}

const str = (v: number | string | null | undefined) => (v === null || v === undefined ? '' : String(v))

/** A stored product as form values (the Product Master edit form and "Create similar product"). */
export function productToFormValues(p: ProductRow): ProductFormValues {
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
    product_type: p.product_type,
    default_source_type: p.default_source_type,
    base_unit: p.base_unit,
    track_batches: p.track_batches,
    track_expiry: p.track_expiry,
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

/** Upper limit for lead time and reorder level in days (10 years). */
export const MAX_PLANNING_DAYS = 3650
/** Upper limit for a dimension in centimetres (1 km). */
export const MAX_DIMENSION_CM = 100000

const text = (v: string) => (v.trim() === '' ? null : v.trim())
const rupees = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface ProductValidationOptions {
  /** Further unit codes accepted besides the known ones: the company list from ERP Settings and the product's saved unit. */
  units?: readonly (string | null | undefined)[]
}

export function validateProduct(values: ProductFormValues, options: ProductValidationOptions = {}): ValidationResult {
  const errors: ValidationResult['errors'] = {}
  const warnings: string[] = []

  // Any SKU is accepted (spaces and symbols included); it is saved without leading or trailing spaces.
  // A blank SKU is allowed: the database assigns the next code for the type.
  const sku = values.sku.trim()

  const name = values.product_name.trim()
  if (!name) errors.product_name = 'Product name is required.'
  else if (name.length > 200) errors.product_name = 'Keep the name under 200 characters.'

  if (values.description.trim().length > 2000) errors.description = 'Keep the description under 2000 characters.'
  if (values.brand.trim().length > 100) errors.brand = 'Keep the brand under 100 characters.'
  if (values.model_number.trim().length > 100) errors.model_number = 'Keep the model number under 100 characters.'
  if (values.supplier_model_number.trim().length > 100) errors.supplier_model_number = 'Keep the supplier model number under 100 characters.'
  if (values.supplier_product_name.trim().length > 200) errors.supplier_product_name = 'Keep the supplier product name under 200 characters.'

  const barcode = values.barcode.trim()
  if (barcode && !BARCODE_RE.test(barcode)) errors.barcode = 'Use 4–64 letters, digits or hyphens.'

  // EAN: optional; EAN-8 or EAN-13 with a valid check digit.
  // Image link: optional; http/https only (never fetched by the server).
  const imageProblem = imageUrlProblem(values.image_url ?? '')
  if (imageProblem) errors.image_url = imageProblem

  const ean = normalizeEan(values.ean.trim())
  if (ean) {
    const problem = eanProblem(ean)
    if (problem) errors.ean = problem
  }

  const groupHead = values.group_head.trim().replace(/\s+/g, ' ')
  if (groupHead.length > 100) errors.group_head = 'Keep the group head under 100 characters.'

  if (!values.product_type) errors.product_type = 'Select a product type.'
  // Source type is optional: it defaults from the product type.
  const sourceType: SourceType | '' = values.default_source_type || (values.product_type ? defaultSourceFor(values.product_type) : '')
  // Unit: the stored code (PCS, MTR, LTR, ROL …), never the display label. Required; new products start with PCS.
  const unit = values.base_unit.trim().toUpperCase()
  if (!unit) errors.base_unit = 'Select a unit of measurement.'
  else if (!isKnownUnit(unit) && !options.units?.some((u) => (u ?? '').trim().toUpperCase() === unit)) {
    errors.base_unit = `${unit} is not a recognised unit of measurement. Choose one from the list.`
  } else if (!/^[A-Z]{1,10}$/.test(unit)) errors.base_unit = 'A unit code has 1 to 10 letters (A–Z).'

  if (values.track_expiry && !values.track_batches) errors.track_expiry = 'Expiry tracking requires batch tracking.'

  // Dimensions: optional, positive, centimetres.
  const dimension = (field: 'length_cm' | 'width_cm' | 'height_cm') => {
    const n = parseDecimal(values[field], 2)
    if (Number.isNaN(n) || (n !== undefined && (n <= 0 || n > MAX_DIMENSION_CM))) {
      errors[field] = 'Enter a positive size in cm (up to 2 decimals), or leave it blank.'
      return undefined
    }
    return n
  }
  const length = dimension('length_cm')
  const width = dimension('width_cm')
  const height = dimension('height_cm')

  const hsn = values.hsn_code.trim()
  if (hsn && !HSN_RE.test(hsn)) errors.hsn_code = 'HSN must be 4, 6 or 8 digits.'

  const gst = parseDecimal(values.gst_rate, 2)
  if (Number.isNaN(gst) || (gst !== undefined && (gst < 0 || gst > 100))) {
    errors.gst_rate = 'Enter a GST rate between 0 and 100.'
  } else if (gst !== undefined && !STANDARD_GST_RATES.includes(gst)) {
    warnings.push(`GST rate ${gst}% is not a commonly used rate. Please double-check it.`)
  }

  const money = (field: 'selling_price' | 'standard_cost' | 'minimum_selling_price' | 'mrp') => {
    const n = parseDecimal(values[field], 2)
    if (Number.isNaN(n) || (n !== undefined && n < 0)) {
      errors[field] = 'Enter a non-negative amount with up to 2 decimals.'
      return undefined
    }
    return n
  }
  const selling = money('selling_price')
  const cost = money('standard_cost')
  const minimum = money('minimum_selling_price')
  const mrp = money('mrp')
  if (selling !== undefined && minimum !== undefined && minimum > selling) {
    errors.minimum_selling_price = 'Minimum selling price cannot exceed the selling price.'
  }
  if (selling !== undefined && cost !== undefined && selling < cost) {
    warnings.push('Selling price is below the cost.')
  }
  // MRP includes all taxes; the selling price is before GST. Selling below the
  // MRP (discounts, negotiated prices) is normal and never flagged.
  if (mrp !== undefined && mrp > 0) {
    const gstFactor = 1 + (gst !== undefined && !Number.isNaN(gst) ? gst : 0) / 100
    if (selling !== undefined && selling * gstFactor > mrp + 0.005) {
      warnings.push(`Selling price${gst !== undefined ? ' incl. GST' : ''} (${rupees(selling * gstFactor)}) is above the MRP (${rupees(mrp)}). Goods cannot be sold to consumers above the MRP.`)
    }
    if (cost !== undefined && cost > mrp) {
      warnings.push('The MRP is below the cost.')
    }
  }

  // Earlier quantity levels: kept as stored (not shown on the form).
  const quantity = (field: 'reorder_level' | 'minimum_level') => {
    const n = parseDecimal(values[field], 3)
    if (Number.isNaN(n) || (n !== undefined && n < 0)) {
      errors[field] = 'Enter a non-negative quantity with up to 3 decimals.'
      return undefined
    }
    return n
  }
  const reorder = quantity('reorder_level')
  const minLevel = quantity('minimum_level')

  // Day-based planning.
  const days = (field: 'lead_time_days' | 'reorder_level_days' | 'minimum_cover_days') => {
    const n = parseDecimal(values[field], 2)
    if (Number.isNaN(n) || (n !== undefined && (n < 0 || n > MAX_PLANNING_DAYS))) {
      errors[field] = `Enter a number of days from 0 to ${MAX_PLANNING_DAYS} (up to 2 decimals).`
      return undefined
    }
    return n
  }
  const leadTime = days('lead_time_days')
  const reorderDays = days('reorder_level_days')
  const minimumCoverDays = days('minimum_cover_days')
  if (leadTime !== undefined && reorderDays !== undefined && reorderDays < leadTime) {
    warnings.push(`The reorder level (${reorderDays} days) is shorter than the lead time (${leadTime} days), so stock may run out before a new order arrives.`)
  }

  if (values.production_notes.trim().length > 2000) errors.production_notes = 'Keep notes under 2000 characters.'
  if (values.remarks.trim().length > 2000) errors.remarks = 'Keep remarks under 2000 characters.'

  // Recommendations (not enforced).
  if (sourceType === 'IN_HOUSE' && !values.is_manufacturable && (values.product_type === 'FINISHED_GOOD' || values.product_type === 'SUBASSEMBLY')) {
    warnings.push('In-house products are usually marked as manufacturable.')
  }
  if (sourceType === 'OUTSOURCED' && values.is_manufacturable) {
    warnings.push('This outsourced product is marked as manufacturable. Consider the Hybrid source type if it is also made in-house.')
  }
  if (values.has_bom && !values.is_manufacturable) {
    warnings.push('A product with a bill of materials is normally manufacturable.')
  }

  if (Object.keys(errors).length > 0) return { input: null, errors, warnings }

  return {
    errors,
    warnings,
    input: {
      sku: sku || null,
      product_name: name,
      description: text(values.description),
      category_id: values.category_id || null,
      brand: text(values.brand),
      model_number: text(values.model_number),
      barcode: barcode || null,
      ean: ean || null,
      image_url: normaliseImageUrl(values.image_url),
      group_head: groupHead || null,
      minimum_cover_days: minimumCoverDays ?? null,
      status: values.status,
      product_type: values.product_type as ProductType,
      default_source_type: sourceType as SourceType,
      base_unit: unit,
      track_batches: values.track_batches,
      track_expiry: values.track_expiry,
      inventory_tracked: values.inventory_tracked,
      hsn_code: hsn || null,
      gst_rate: gst ?? null,
      selling_price: selling ?? null,
      standard_cost: cost ?? null,
      minimum_selling_price: minimum ?? null,
      reorder_level: reorder ?? null,
      minimum_level: minLevel ?? null,
      lead_time_days: leadTime ?? null,
      reorder_level_days: reorderDays ?? null,
      mrp: mrp ?? null,
      length_cm: length ?? null,
      width_cm: width ?? null,
      height_cm: height ?? null,
      supplier_model_number: text(values.supplier_model_number),
      supplier_product_name: text(values.supplier_product_name),
      preferred_supplier_id: values.preferred_supplier_id || null,
      remarks: text(values.remarks),
      is_manufacturable: values.is_manufacturable,
      has_bom: values.has_bom,
      production_notes: text(values.production_notes),
    },
  }
}
