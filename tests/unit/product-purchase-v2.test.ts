// Product Master, BOM and Purchase enhancements: MRP, day-based planning,
// dimensions, supplier details, category codes, import / export, BOM line
// calculations, supplier invoice / challan exports and report columns.
// No database (see supabase/tests/product_purchase_v2_verification.sql).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { bomRequirement } from '../../src/features/inventory/whole-units.ts'
import { REORDER_STATUS_LABELS, reorderPlanSheet } from '../../src/features/inventory/reorder-model.ts'
import { findReport } from '../../src/features/management/report-defs.ts'
import { EXPORT_COLUMNS, productExportRows } from '../../src/features/products/product-export.ts'
import { IMPORT_FIELDS, autoMapColumns, legacyQuantityColumns, productRowToFormValues, validateImportRows, type ExistingProduct } from '../../src/features/products/product-import.ts'
import { CATEGORY_CODE_RE, categoryCodeFor } from '../../src/features/products/product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'
import { grnExportRows, poExportRows, refsText } from '../../src/features/purchasing/po-model.ts'
import { validateBomLine } from '../../src/features/production/production-model.ts'

const base = { ...EMPTY_PRODUCT_FORM, product_name: 'Basin mixer', product_type: 'FINISHED_GOOD' as const }

describe('product: MRP (Tax & Pricing)', () => {
  it('accepts a decimal MRP and keeps it separate from the selling price', () => {
    const r = validateProduct({ ...base, mrp: '₹2,499.50', selling_price: '1800', gst_rate: '18' })
    assert.equal(r.input?.mrp, 2499.5)
    assert.equal(r.input?.selling_price, 1800)
  })
  it('refuses a negative MRP or more than 2 decimals', () => {
    assert.ok(validateProduct({ ...base, mrp: '-1' }).errors.mrp)
    assert.ok(validateProduct({ ...base, mrp: '10.555' }).errors.mrp)
  })
  it('warns (never blocks) when the selling price incl. GST is above the MRP; discounts are fine', () => {
    const above = validateProduct({ ...base, mrp: '1000', selling_price: '900', gst_rate: '18' })
    assert.ok(above.input, 'not blocked')
    assert.ok(above.warnings.some((w) => w.includes('above the MRP') && w.includes('incl. GST')))
    const discounted = validateProduct({ ...base, mrp: '1180', selling_price: '800', gst_rate: '18' })
    assert.ok(!discounted.warnings.some((w) => w.includes('MRP')), 'a discounted price raises no warning')
    const exact = validateProduct({ ...base, mrp: '1180', selling_price: '1000', gst_rate: '18' })
    assert.ok(!exact.warnings.some((w) => w.includes('above the MRP')), 'selling at exactly the MRP incl. GST is allowed')
  })
})

describe('product: inventory planning in days', () => {
  it('accepts whole and decimal days; refuses negatives and more than 10 years', () => {
    const r = validateProduct({ ...base, lead_time_days: '7.5', reorder_level_days: '10' })
    assert.equal(r.input?.lead_time_days, 7.5)
    assert.equal(r.input?.reorder_level_days, 10)
    assert.ok(validateProduct({ ...base, lead_time_days: '-1' }).errors.lead_time_days)
    assert.ok(validateProduct({ ...base, reorder_level_days: '-0.5' }).errors.reorder_level_days)
    assert.ok(validateProduct({ ...base, reorder_level_days: '4000' }).errors.reorder_level_days)
    assert.equal(validateProduct({ ...base, lead_time_days: '0' }).input?.lead_time_days, 0)
  })
  it('never reads days as quantities (or quantities as days)', () => {
    const r = validateProduct({ ...base, reorder_level_days: '15' })
    assert.equal(r.input?.reorder_level, null)
    assert.equal(r.input?.minimum_level, null)
  })
  it('warns when the reorder level is shorter than the lead time', () => {
    assert.ok(validateProduct({ ...base, lead_time_days: '20', reorder_level_days: '10' }).warnings.some((w) => w.includes('shorter than the lead time')))
    assert.ok(!validateProduct({ ...base, lead_time_days: '5', reorder_level_days: '10' }).warnings.some((w) => w.includes('lead time')))
  })
})

describe('product: dimensions and supplier details', () => {
  it('dimensions are optional, positive, in cm', () => {
    const none = validateProduct(base)
    assert.equal(none.input?.length_cm, null)
    const r = validateProduct({ ...base, length_cm: '32.5', width_cm: '18', height_cm: '9.25' })
    assert.deepEqual([r.input?.length_cm, r.input?.width_cm, r.input?.height_cm], [32.5, 18, 9.25])
    assert.ok(validateProduct({ ...base, height_cm: '0' }).errors.height_cm)
    assert.ok(validateProduct({ ...base, width_cm: '-3' }).errors.width_cm)
  })
  it('supplier model number and name are optional, trimmed and do not replace the SKU or name', () => {
    const r = validateProduct({ ...base, sku: 'FG-1', supplier_model_number: '  SM-100 ', supplier_product_name: ' Vendor Mixer ' })
    assert.equal(r.input?.supplier_model_number, 'SM-100')
    assert.equal(r.input?.supplier_product_name, 'Vendor Mixer')
    assert.equal(r.input?.sku, 'FG-1')
    assert.equal(r.input?.product_name, 'Basin mixer')
    assert.equal(validateProduct(base).input?.supplier_model_number, null)
    assert.ok(validateProduct({ ...base, supplier_model_number: 'x'.repeat(101) }).errors.supplier_model_number)
  })
})

describe('category added from the product form', () => {
  it('derives a valid, unique code from the name', () => {
    assert.equal(categoryCodeFor('Bathroom Taps', new Set()), 'BATHROOM-TAPS')
    assert.equal(categoryCodeFor('Bathroom Taps', new Set(['BATHROOM-TAPS'])), 'BATHROOM-TAPS-2')
    assert.equal(categoryCodeFor('Bathroom Taps', new Set(['BATHROOM-TAPS', 'BATHROOM-TAPS-2'])), 'BATHROOM-TAPS-3')
    assert.equal(categoryCodeFor('  !!  ', new Set()), 'CAT')
    for (const name of ['Bathroom Taps', 'Fittings & Accessories (Brass)', 'Very long category name that keeps going and going', 'टोंटी']) {
      assert.match(categoryCodeFor(name, new Set()), CATEGORY_CODE_RE, name)
    }
  })
})

describe('product import / export templates', () => {
  it('MRP is its own column, never mapped to the selling price', () => {
    const m = autoMapColumns(['Product Name', 'Product Type', 'MRP', 'Selling Price'])
    assert.equal(m.mrp, 2)
    assert.equal(m.selling_price, 3)
    assert.equal(autoMapColumns(['Product Name', 'MRP']).selling_price, null)
  })
  it('imports lead time and reorder level in days, supplier details and dimensions', () => {
    const headers = ['Product Name', 'Product Type', 'MRP', 'Lead Time (Days)', 'Reorder Level (Days)', 'Supplier Model No.', 'Supplier Product Name', 'Length (cm)', 'Width (cm)', 'Height (cm)']
    const mapping = autoMapColumns(headers)
    const [row] = validateImportRows([['Mixer', 'Finished Good', '2499', '7', '14', 'SM-9', 'Vendor mixer', '30', '20', '10']], mapping,
      { categories: [], existingSkus: new Set(), existingBarcodes: new Set(), duplicateMode: 'skip' })
    assert.equal(row.status, 'valid', row.errors.join(' '))
    assert.equal(row.input?.mrp, 2499)
    assert.equal(row.input?.lead_time_days, 7)
    assert.equal(row.input?.reorder_level_days, 14)
    assert.equal(row.input?.supplier_model_number, 'SM-9')
    assert.equal(row.input?.length_cm, 30)
    assert.equal(row.input?.reorder_level, null, 'days are not stored as a quantity')
  })
  it('earlier quantity columns are reported, not imported as days', () => {
    const headers = ['Product Name', 'Product Type', 'Reorder Level', 'Minimum Stock Level', 'Reorder Level (Days)']
    const mapping = autoMapColumns(headers)
    assert.equal(mapping.reorder_level_days, 4, 'only the days column maps to the days field')
    assert.deepEqual(legacyQuantityColumns(headers), ['Reorder Level', 'Minimum Stock Level'])
    assert.ok(!IMPORT_FIELDS.some((f) => f.key === ('reorder_level' as string) || f.key === ('minimum_level' as string)))
  })
  it('update mode changes only the new fields that have a value', () => {
    const stored = productRowToFormValues({
      sku: 'FG-1', product_name: 'Mixer', description: null, category_id: null, brand: null, model_number: null, barcode: null, status: 'ACTIVE',
      product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false, hsn_code: null, gst_rate: null,
      selling_price: 1000, standard_cost: null, minimum_selling_price: null, reorder_level: 12, mrp: 1500, lead_time_days: 5,
      is_manufacturable: true, has_bom: false, production_notes: null,
    })
    const existing: ExistingProduct = { id: 'p1', sku: 'FG-1', values: stored }
    const mapping = autoMapColumns(['SKU', 'MRP', 'Reorder Level (Days)'])
    const [row] = validateImportRows([['FG-1', '1600', '']], mapping, {
      categories: [], existingSkus: new Set(['fg-1']), existingBarcodes: new Set(), duplicateMode: 'update', existingProducts: new Map([['fg-1', existing]]),
    })
    assert.equal(row.action, 'update', row.errors.join(' '))
    assert.deepEqual(row.changes?.map((c) => [c.field, c.from, c.to]), [['mrp', '1500', '1600']])
    assert.deepEqual(row.input, { mrp: 1600 })
  })
  it('every export column except Status and Has BOM is read back by the import', () => {
    const mapping = autoMapColumns([...EXPORT_COLUMNS])
    const mapped = new Set(Object.values(mapping).filter((i): i is number => i !== null))
    const unmapped = EXPORT_COLUMNS.filter((_, i) => !mapped.has(i))
    assert.deepEqual(unmapped, ['Status', 'Has BOM'])
    for (const c of ['MRP', 'Lead Time (Days)', 'Reorder Level (Days)', 'Supplier Model No.', 'Supplier Product Name', 'Length (cm)']) assert.ok(EXPORT_COLUMNS.includes(c as never), c)
    assert.ok(!EXPORT_COLUMNS.includes('Minimum Stock Level' as never))
  })
  it('exports the new values as numbers / text', () => {
    const rows = productExportRows([{
      id: 'p1', company_id: 'c', sku: 'FG-1', product_name: 'Mixer', description: null, category_id: null, brand: null, model_number: null, barcode: null,
      product_image_path: null, status: 'ACTIVE', archived_at: null, archived_by: null, product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS',
      track_batches: false, track_expiry: false, hsn_code: null, gst_rate: 18, selling_price: 1000, standard_cost: null, minimum_selling_price: null, reorder_level: null,
      preferred_supplier_id: null, standard_manufacturing_cost: null, minimum_level: null, lead_time_days: 7.5, reorder_level_days: 14, mrp: 1499, length_cm: 30,
      width_cm: null, height_cm: 10, supplier_model_number: 'SM-9', supplier_product_name: 'Vendor mixer', remarks: null, is_manufacturable: true, has_bom: false,
      production_notes: null, created_by: null, updated_by: null, created_at: '', updated_at: '',
    }], [])
    const at = (h: string) => rows[1][EXPORT_COLUMNS.indexOf(h as never)]
    assert.equal(at('MRP'), 1499)
    assert.equal(at('Lead Time (Days)'), 7.5)
    assert.equal(at('Reorder Level (Days)'), 14)
    assert.equal(at('Supplier Model No.'), 'SM-9')
    assert.equal(at('Width (cm)'), null)
  })
})

describe('BOM component lines', () => {
  it('validates positive quantities and keeps whole pieces for PCS, NOS, SET and PAIR', () => {
    assert.ok(validateBomLine({ quantity: '0', wastage: '0', unit: 'KG' }))
    assert.ok(validateBomLine({ quantity: '-1', wastage: '0', unit: 'KG' }))
    assert.equal(validateBomLine({ quantity: '0.25', wastage: '2', unit: 'KG' }), null)
    for (const u of ['PCS', 'NOS', 'SET', 'PAIR']) assert.ok(validateBomLine({ quantity: '1.5', wastage: '0', unit: u }), u)
    assert.equal(validateBomLine({ quantity: '2', wastage: '5', unit: 'PCS' }), null)
    assert.ok(validateBomLine({ quantity: '1', wastage: '100', unit: 'PCS' }), 'wastage below 100%')
  })
  it('adds wastage on top and rounds whole-piece requirements up', () => {
    const kg = bomRequirement(2, 1, 1, 5, 'KG')
    assert.deepEqual([kg.theoretical, kg.wastage, kg.planned], [2, 0.1, 2.1])
    const pcs = bomRequirement(2, 1, 1, 5, 'PCS')
    assert.deepEqual([pcs.theoretical, pcs.planned], [2, 3], '2 PCS + 5% = 2.1 -> 3 whole pieces')
    const shared = bomRequirement(1, 2, 10, 0, 'PCS')
    assert.equal(shared.planned, 5, '1 washer per 2 units -> 5 for 10 units')
  })
})

describe('supplier invoice and challan references', () => {
  it('formats the references and keeps them apart from the Alton numbers', () => {
    assert.equal(refsText('INV-1', 'DC-9'), 'Invoice INV-1 · Challan DC-9')
    assert.equal(refsText(null, 'DC-9'), 'Challan DC-9')
    assert.equal(refsText(null, undefined), null)
  })
  it('purchase order export has the PO number and the supplier references in separate columns', () => {
    const out = poExportRows([{ po_number: 'PO-000012', revision: 0, po_date: '2026-11-01', expected_delivery_date: null, status: 'PARTIALLY_RECEIVED',
      supplier_code: 'S1', supplier_name: 'Pune Brass', reference_number: 'Q-7', supplier_invoice_number: 'INV-1', supplier_challan_number: 'DC-1',
      receipt_invoice_numbers: 'INV-1, INV-2', receipt_challan_numbers: 'DC-10, DC-9', warehouse_code: 'W1', taxable_total: 100, grand_total: 118, pending_value: 50, receipt_count: 2 }])
    const col = (h: string) => out[1][out[0].indexOf(h)]
    assert.equal(col('PO No.'), 'PO-000012')
    assert.equal(col('Supplier invoice no.'), 'INV-1')
    assert.equal(col('Supplier challan no.'), 'DC-1')
    assert.equal(col('GRN invoice nos.'), 'INV-1, INV-2')
    assert.equal(col('Status'), 'Partially received')
  })
  it('GRN export keeps each receipt\'s own references', () => {
    const r = (n: string, inv: string | null, dc: string | null) => ({ receipt_number: n, receipt_date: '2026-11-01', receipt_type: 'PURCHASE_ORDER', po_number: 'PO-000012',
      supplier_code: 'S1', supplier_name: 'Pune Brass', warehouse_code: 'W1', supplier_invoice_number: inv, supplier_challan_number: dc, supplier_document_number: null,
      supporting_document_ref: null, total_received: 5, total_accepted: 5, total_rejected: 0, status: 'POSTED' })
    const out = grnExportRows([r('GRN-000001', 'INV-1', 'DC-9'), r('GRN-000002', 'INV-2', 'DC-10')])
    const inv = out[0].indexOf('Supplier invoice no.')
    const dc = out[0].indexOf('Supplier challan no.')
    assert.deepEqual(out.slice(1).map((x) => [x[0], x[inv], x[dc]]), [['GRN-000001', 'INV-1', 'DC-9'], ['GRN-000002', 'INV-2', 'DC-10']])
  })
  it('purchase and GRN registers show the references; the product report shows MRP and planning days', () => {
    const keys = (k: string) => findReport(k)!.columns.map((c) => c.key)
    for (const k of ['supplier_invoice_number', 'supplier_challan_number']) {
      assert.ok(keys('PURCHASE_REGISTER').includes(k), `purchase register ${k}`)
      assert.ok(keys('GRN_REGISTER').includes(k), `GRN register ${k}`)
    }
    for (const k of ['mrp', 'lead_time_days', 'reorder_level_days', 'supplier_model_number', 'length_cm']) assert.ok(keys('PRODUCTS').includes(k), k)
    assert.ok(keys('LOW_STOCK').includes('reorder_level_days'))
  })
})

describe('reorder planning export', () => {
  it('shows available, reserved and incoming separately and leaves unknown cover empty', () => {
    const out = reorderPlanSheet([{ sku: 'C1', product_name: 'Spindle', unit: 'PCS', status: 'NO_CONSUMPTION', on_hand: 5, reserved: 1, available: 4, incoming: 10,
      consumed: 0, observed_days: 30, avg_daily: null, coverage_days: null, coverage_with_incoming_days: null, reorder_level_days: 10, lead_time_days: 3,
      suggested_quantity: null, legacy_reorder_quantity: null }])
    const col = (h: string) => out[1][out[0].indexOf(h)]
    assert.equal(col('Status'), REORDER_STATUS_LABELS.NO_CONSUMPTION)
    assert.deepEqual([col('Available'), col('Reserved'), col('Incoming (open POs)')], [4, 1, 10])
    assert.equal(col('Days of cover'), null)
    assert.equal(col('Lead time (days)'), 3)
  })
})
