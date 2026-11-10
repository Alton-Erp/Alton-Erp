import { PRODUCT_TYPE_LABELS, SOURCE_TYPE_LABELS } from './product-model.ts'
import type { CellValue } from '@/features/products/spreadsheet'
import type { ProductCategoryRow, ProductRow } from '@/types/database'

import { masterCost, type ProductMasterCostFields } from './master-cost.ts'

type MasterRow = ProductRow & Partial<ProductMasterCostFields>

/**
 * Export columns. Every header except Status and Has BOM is recognised by the
 * import, so an exported file can be corrected and re-imported in
 * "update existing products" mode. Inventory planning is exported in days;
 * earlier quantity levels are not part of the template.
 * Cost = the Product Master Cost (second-most-recent purchase receipt, else the
 * standard cost); Last Purchase Cost / Date are for reading only (never imported).
 * Standard Manufacturing Cost is the entered fallback: on re-import it is the column
 * that is read, so a calculated Cost is never saved as the standard cost.
 */
export const EXPORT_COLUMNS = [
  'SKU',
  'Product Name',
  'Category',
  'Product Type',
  'Source Type',
  'Unit',
  'HSN Code',
  'GST Rate',
  'MRP',
  'Selling Price',
  'Cost',
  'Last Purchase Cost',
  'Last Purchase Date',
  'Standard Manufacturing Cost',
  'Minimum Selling Price',
  'Lead Time (Days)',
  'Reorder Level (Days)',
  'Minimum Stock Days',
  'Group Head',
  'Status',
  'Manufacturer / Brand',
  'Model Number',
  'Barcode',
  'EAN',
  'Supplier Model No.',
  'Supplier Product Name',
  'Length (cm)',
  'Width (cm)',
  'Height (cm)',
  'Manufacturable',
  'Has BOM',
  'Preferred Supplier',
  'Description',
  'Remarks',
  'Image Link',
] as const

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v))

/** Product rows as spreadsheet cells; column order matches EXPORT_COLUMNS (and the import template). */
export function productExportRows(
  products: ProductRow[],
  categories: ProductCategoryRow[],
  supplierCodes: Map<string, string> = new Map(),
): CellValue[][] {
  const categoryName = new Map(categories.map((c) => [c.id, c.name]))
  return [
    [...EXPORT_COLUMNS],
    ...products.map((p) => [
      p.sku,
      p.product_name,
      p.category_id ? (categoryName.get(p.category_id) ?? '') : '',
      PRODUCT_TYPE_LABELS[p.product_type],
      SOURCE_TYPE_LABELS[p.default_source_type],
      p.base_unit,
      p.hsn_code,
      num(p.gst_rate),
      num(p.mrp),
      num(p.selling_price),
      num(masterCost(p as MasterRow).cost),
      num((p as MasterRow).last_purchase_cost),
      (p as MasterRow).last_purchase_date ?? null,
      num(masterCost(p as MasterRow).fallback),
      num(p.minimum_selling_price),
      num(p.lead_time_days),
      num(p.reorder_level_days),
      num(p.minimum_cover_days),
      p.group_head,
      p.archived_at ? 'Archived' : p.status === 'ACTIVE' ? 'Active' : 'Inactive',
      p.brand,
      p.model_number,
      p.barcode,
      p.ean,
      p.supplier_model_number,
      p.supplier_product_name,
      num(p.length_cm),
      num(p.width_cm),
      num(p.height_cm),
      p.is_manufacturable ? 'Yes' : 'No',
      p.has_bom ? 'Yes' : 'No',
      p.preferred_supplier_id ? (supplierCodes.get(p.preferred_supplier_id) ?? '') : '',
      p.description,
      p.remarks,
      // The saved link (never a temporary signed link of an uploaded image), so it imports back unchanged.
      p.image_url ?? null,
    ]),
  ]
}
