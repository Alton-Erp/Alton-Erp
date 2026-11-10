// Stage 1 (V2): product types, incomplete products, update-by-SKU imports,
// missing-information checks and the BOM spreadsheet import. No database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { autoMapBomColumns, buildBomImportReport, missingBomFields, summarizeBomImport, validateBomRows, type BomImportProduct } from '../../src/features/production/bom-import.ts'
import { productGaps } from '../../src/features/products/product-completeness.ts'
import { autoMapColumns, buildErrorReport, productRowToFormValues, validateImportRows, type ExistingProduct } from '../../src/features/products/product-import.ts'
import { defaultBomSource, defaultSourceFor, parseBomSource, parseProductType, PRODUCT_TYPES, SKU_PREFIXES } from '../../src/features/products/product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'

describe('product types (V2)', () => {
  it('has the eight types of the spec, each with an automatic SKU prefix', () => {
    assert.deepEqual([...PRODUCT_TYPES].sort(), ['COMPONENT', 'CONSUMABLE', 'FINISHED_GOOD', 'OTHER', 'OUTSOURCED_COMPONENT', 'PACKAGING_MATERIAL', 'RAW_MATERIAL', 'SUBASSEMBLY'])
    for (const t of PRODUCT_TYPES) assert.match(SKU_PREFIXES[t], /^[A-Z]{2,3}$/)
  })

  it('reads the new types from spreadsheet wording', () => {
    assert.equal(parseProductType('Sub-assembly'), 'SUBASSEMBLY')
    assert.equal(parseProductType('Subassemblies'), 'SUBASSEMBLY')
    assert.equal(parseProductType('Outsourced Component'), 'OUTSOURCED_COMPONENT')
    assert.equal(parseProductType('Outsourced parts'), 'OUTSOURCED_COMPONENT')
    assert.equal(parseProductType('Packing Material'), 'PACKAGING_MATERIAL')
    assert.equal(parseProductType('Consumables'), 'CONSUMABLE')
  })

  it('defaults the source type by product type (same rule as the database)', () => {
    assert.equal(defaultSourceFor('FINISHED_GOOD'), 'IN_HOUSE')
    assert.equal(defaultSourceFor('SUBASSEMBLY'), 'IN_HOUSE')
    assert.equal(defaultSourceFor('RAW_MATERIAL'), 'OUTSOURCED')
    assert.equal(defaultSourceFor('OUTSOURCED_COMPONENT'), 'OUTSOURCED')
  })

  it('defaults a BOM line source from the component (same rule as the database)', () => {
    assert.equal(defaultBomSource({ product_type: 'RAW_MATERIAL', default_source_type: 'OUTSOURCED' }), 'PURCHASED')
    assert.equal(defaultBomSource({ product_type: 'RAW_MATERIAL', default_source_type: 'IN_HOUSE' }), 'IN_HOUSE')
    assert.equal(defaultBomSource({ product_type: 'OUTSOURCED_COMPONENT', default_source_type: 'OUTSOURCED' }), 'OUTSOURCED')
    assert.equal(defaultBomSource({ product_type: 'SUBASSEMBLY', default_source_type: 'HYBRID' }), 'IN_HOUSE')
    assert.equal(parseBomSource('bought out'), 'PURCHASED')
    assert.equal(parseBomSource('Job work'), 'OUTSOURCED')
    assert.equal(parseBomSource('borrowed'), null)
  })
})

describe('incomplete products are accepted', () => {
  it('only name and type are required; SKU and source default, the unit starts as PCS (a blank unit is rejected)', () => {
    assert.equal(validateProduct({ ...EMPTY_PRODUCT_FORM, product_name: 'Wall-hung WC', product_type: 'FINISHED_GOOD', base_unit: '' }).errors.base_unit, 'Select a unit of measurement.')
    const r = validateProduct({ ...EMPTY_PRODUCT_FORM, product_name: 'Wall-hung WC', product_type: 'FINISHED_GOOD' })
    assert.deepEqual(r.errors, {})
    assert.equal(r.input?.sku, null)
    assert.equal(r.input?.default_source_type, 'IN_HOUSE')
    assert.equal(r.input?.base_unit, 'PCS')
    assert.ok(validateProduct({ ...EMPTY_PRODUCT_FORM, product_type: 'FINISHED_GOOD' }).errors.product_name)
    assert.ok(validateProduct({ ...EMPTY_PRODUCT_FORM, product_name: 'X' }).errors.product_type)
  })

  it('validates the new fields and keeps the earlier quantity levels as stored', () => {
    const base = { ...EMPTY_PRODUCT_FORM, product_name: 'Clay', product_type: 'RAW_MATERIAL' as const }
    assert.ok(validateProduct({ ...base, standard_cost: '-1' }).errors.standard_cost)
    assert.ok(validateProduct({ ...base, minimum_level: 'abc' }).errors.minimum_level)
    // Quantity levels are no longer edited on the form; stored values pass through unchanged (never turned into days).
    const r = validateProduct({ ...base, minimum_level: '100', reorder_level: '50', remarks: '  keep dry  ' })
    assert.equal(r.input?.minimum_level, 100)
    assert.equal(r.input?.reorder_level, 50)
    assert.equal(r.input?.reorder_level_days, null)
    assert.equal(r.input?.remarks, 'keep dry')
  })

  it('lists missing information without blocking', () => {
    const fg = { product_type: 'FINISHED_GOOD', hsn_code: null, gst_rate: null, category_id: null, selling_price: null, standard_cost: null, standard_manufacturing_cost: null }
    assert.deepEqual(productGaps(fg, false).map((g) => g.key), ['hsn', 'gst', 'category', 'price', 'bom'])
    assert.deepEqual(productGaps({ ...fg, hsn_code: '6910', gst_rate: 18, category_id: 'c', selling_price: 100 }, true), [])
    const rm = { ...fg, product_type: 'RAW_MATERIAL', hsn_code: '2508', gst_rate: 5, category_id: 'c' }
    assert.deepEqual(productGaps(rm, false).map((g) => g.key), ['cost'], 'raw materials need a cost, not a BOM')
    assert.deepEqual(productGaps({ ...rm, standard_manufacturing_cost: 4 }), [])
  })
})

describe('import: update existing products by SKU', () => {
  const stored = productRowToFormValues({
    sku: 'WC-100', product_name: 'Wall-hung WC', description: null, category_id: null, brand: 'Alton', model_number: null, barcode: '8901',
    status: 'ACTIVE', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false,
    hsn_code: null, gst_rate: null, selling_price: 8000, standard_cost: null, minimum_selling_price: null, reorder_level: 5,
    standard_manufacturing_cost: null, minimum_level: null, preferred_supplier_id: null, remarks: 'old', is_manufacturable: true, has_bom: true,
    production_notes: null,
  })
  const existing: ExistingProduct = { id: 'p-1', sku: 'WC-100', values: stored }
  const headers = ['SKU', 'Product Name', 'HSN Code', 'GST %', 'Selling Price', 'Reorder Level', 'Barcode', 'Remarks', 'Product Type', 'Preferred Supplier']
  const ctx = {
    categories: [], existingSkus: new Set(['wc-100']), existingBarcodes: new Set(['8901']), barcodeOwners: new Map([['8901', 'p-1']]),
    duplicateMode: 'update' as const, existingProducts: new Map([['wc-100', existing]]),
    suppliers: [{ id: 's-1', supplier_code: 'S-CLAY', legal_name: 'Clay Traders', status: 'ACTIVE' }],
  }

  it('changes only filled cells and lists every change (old → new)', () => {
    const rows = [['wc-100', '', '6910', '18', '8500', '', '8901', '', '', 'Clay Traders']]
    const [r] = validateImportRows(rows, autoMapColumns(headers), ctx)
    assert.equal(r.status, 'valid')
    assert.equal(r.action, 'update')
    assert.equal(r.productId, 'p-1')
    assert.equal(r.sku, 'WC-100', 'the stored SKU is kept')
    assert.deepEqual(r.changes?.map((c) => `${c.label}: ${c.from} → ${c.to}`), [
      'HSN Code: — → 6910', 'GST Rate: — → 18%', 'Selling Price: ₹8,000.00 → ₹8,500.00', 'Preferred Supplier: — → Clay Traders (S-CLAY)',
    ])
    assert.deepEqual(r.input, { hsn_code: '6910', gst_rate: 18, selling_price: 8500, preferred_supplier_id: 's-1' }, 'blank cells (name, reorder level, remarks) are not erased')
    assert.equal(r.warnings.some((w) => w.includes('Barcode')), false, 'its own barcode is not a duplicate')
  })

  it('reports a row with nothing to change as skipped', () => {
    const [r] = validateImportRows([['WC-100', 'Wall-hung WC', '', '', '8000', '5', '', '', 'Finished Good', '']], autoMapColumns(headers), ctx)
    assert.equal(r.status, 'skipped')
    assert.ok(r.warnings[0].includes('No changes'))
  })

  it('still validates updated values and warns when the type changes', () => {
    const [bad] = validateImportRows([['WC-100', '', '12', '', '', '', '', '', '', '']], autoMapColumns(headers), ctx)
    assert.equal(bad.status, 'error')
    assert.ok(bad.errors.some((e) => e.startsWith('HSN Code')))
    const [typed] = validateImportRows([['WC-100', '', '', '', '', '', '', '', 'Subassembly', '']], autoMapColumns(headers), ctx)
    assert.equal(typed.status, 'valid')
    assert.ok(typed.warnings.some((w) => w.includes('product type changes')))
  })

  it('creates new SKUs in the same file and puts every change in the report', () => {
    const results = validateImportRows([
      ['WC-100', '', '', '', '9000', '', '', 'Price revised', '', ''],
      ['WB-200', 'Counter basin', '', '', '', '', '', '', 'Finished Good', 'Unknown Co'],
    ], autoMapColumns(headers), ctx)
    assert.equal(results[0].action, 'update')
    assert.equal(results[1].action, 'create')
    assert.ok(results[1].warnings.some((w) => w.includes('Unknown Co') && w.includes('not found')), 'unknown supplier is reported, not silently dropped')
    const report = buildErrorReport(results)
    assert.ok(report.some((row) => String(row[6]).includes('Selling Price: ₹8,000.00 → ₹9,000.00') && String(row[6]).includes('Remarks: old → Price revised')))
  })
})

describe('BOM import', () => {
  const p = (id: string, sku: string, type: string, unit = 'PCS', status = 'ACTIVE'): BomImportProduct =>
    ({ id, sku, product_name: sku, product_type: type, base_unit: unit, status })
  const products = new Map([
    ['fg-1', p('fg1', 'FG-1', 'FINISHED_GOOD')], ['fg-2', p('fg2', 'FG-2', 'FINISHED_GOOD')], ['fg-3', p('fg3', 'FG-3', 'FINISHED_GOOD')],
    ['sub-1', p('sub1', 'SUB-1', 'SUBASSEMBLY')], ['rm-1', p('rm1', 'RM-1', 'RAW_MATERIAL', 'KG')], ['pkg-1', p('pkg1', 'PKG-1', 'PACKAGING_MATERIAL')],
    ['osc-1', p('osc1', 'OSC-1', 'OUTSOURCED_COMPONENT')], ['old-1', p('old1', 'OLD-1', 'COMPONENT', 'PCS', 'INACTIVE')],
  ])
  const ctx = { products, suppliers: [{ id: 's1', supplier_code: 'S-FIT', legal_name: 'Fittings Works', status: 'ACTIVE' }], activeVersions: new Map([['fg1', 2]]) }
  const headers = ['Finished Product SKU', 'Component SKU', 'Qty', 'UOM', 'Source', 'Wastage %', 'Supplier', 'Remarks', 'Output Quantity']

  it('maps the template headers and requires the three key columns', () => {
    const m = autoMapBomColumns(headers)
    assert.deepEqual(missingBomFields(m), [])
    assert.equal(m.quantity, 2)
    assert.deepEqual(missingBomFields(autoMapBomColumns(['Finished SKU', 'Qty'])), ['Component SKU'])
  })

  it('groups rows into one BOM per finished product with source, supplier, wastage and output', () => {
    const groups = validateBomRows([
      ['FG-1', 'SUB-1', '1', 'pcs', 'In-house', '', '', 'Tank', '1'],
      ['FG-1', 'RM-1', '18.5', 'kg', 'bought', '3%', '', '', ''],
      ['FG-1', 'OSC-1', '1', '', 'Outsourced', '', 'S-FIT', 'Flush plate', '1'],
      ['FG-1', 'PKG-1', '1', '', '', '', 'Nobody', '', ''],
    ], autoMapBomColumns(headers), ctx)
    assert.equal(groups.length, 1)
    const g = groups[0]
    assert.equal(g.status, 'valid', JSON.stringify(g.errors))
    assert.equal(g.lines.length, 4)
    assert.equal(g.outputQuantity, 1)
    assert.deepEqual(g.lines.map((l) => l.source), ['IN_HOUSE', 'PURCHASED', 'OUTSOURCED', null])
    assert.equal(g.lines[1].wastage, 3)
    assert.equal(g.lines[2].supplierId, 's1')
    assert.ok(g.warnings.some((w) => w.includes('active BOM version 2')), 'replacing an active version is announced')
    assert.ok(g.rows[3].warnings.some((w) => w.includes('Nobody')), 'unknown supplier is reported and the product default is used')
  })

  it('holds back a whole BOM when one row is wrong, and explains every row', () => {
    const groups = validateBomRows([
      ['FG-2', 'RM-1', '2', 'PCS', '', '', '', '', ''],      // unit mismatch
      ['FG-2', 'SUB-1', '1.5', '', '', '', '', '', ''],      // fractional PCS
      ['FG-2', 'PKG-1', '1', '', '', '', '', '', ''],        // fine, but held back
      ['FG-3', 'OLD-1', '1', '', '', '', '', '', ''],        // inactive component
      ['FG-3', 'FG-3', '1', '', '', '', '', '', ''],         // itself
      ['RM-1', 'PKG-1', '1', '', '', '', '', '', ''],        // raw material cannot have a BOM
      ['NEW-9', 'RM-1', '1', '', '', '', '', '', ''],        // unknown finished product
      ['FG-1', 'RM-1', '1', '', '', '', '', '', '2'],
      ['FG-1', 'RM-1', '1', '', 'Borrowed', '', '', '', '3'], // duplicate + bad source + other output
    ], autoMapBomColumns(headers), ctx, 5)
    const by = new Map(groups.map((g) => [g.finishedSku, g]))
    assert.equal(by.get('FG-2')?.status, 'error')
    assert.ok(by.get('FG-2')?.rows[0].errors.some((e) => e.includes('does not match the inventory unit')))
    assert.ok(by.get('FG-2')?.rows[1].errors.some((e) => e.includes('whole')))
    assert.ok(by.get('FG-2')?.rows[2].warnings.some((w) => w.includes('Held back')))
    assert.ok(by.get('FG-3')?.rows[0].errors.some((e) => e.includes('inactive')))
    assert.ok(by.get('FG-3')?.rows[1].errors.some((e) => e.includes('component of itself')))
    assert.ok(by.get('RM-1')?.errors.some((e) => e.includes('cannot have a BOM')))
    assert.ok(by.get('NEW-9')?.errors.some((e) => e.includes('not in the Product Master')))
    const dup = by.get('FG-1')!.rows[1]
    assert.ok(dup.errors.some((e) => e.includes('listed twice') && e.includes('row 12')))
    assert.ok(dup.errors.some((e) => e.includes('Source "Borrowed"')))
    assert.ok(dup.errors.some((e) => e.includes('differs from 2 on row 12')))
    assert.deepEqual(summarizeBomImport(groups), { boms: 5, valid: 0, errors: 5, rows: 9, components: 0, newVersions: 0, draftUpdates: 0, unchanged: 0, planningUpdates: 0 })
    const report = buildBomImportReport(groups)
    assert.equal(report.length, 10, 'one report line per spreadsheet row')
    assert.deepEqual(report.slice(1).map((r) => r[0]), [5, 6, 7, 8, 9, 10, 11, 12, 13])
  })
})
