// Units of measurement: stored codes (MTR, LTR, ROL …), validation, dropdown options, Excel import and export (no database).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { productExportRows } from '../../src/features/products/product-export.ts'
import {
  autoMapColumns,
  identityMaps,
  productRowToFormValues,
  validateImportRows,
  type ExistingProduct,
  type ImportContext,
} from '../../src/features/products/product-import.ts'
import {
  LEGACY_UNITS,
  STANDARD_UNITS,
  findUnit,
  isKnownUnit,
  productUnitOptions,
  sameUnit,
  skuKey,
  unitLabel,
  unitOptionLabel,
} from '../../src/features/products/product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'

const form = (base_unit: string) => ({ ...EMPTY_PRODUCT_FORM, product_name: 'Hose pipe', product_type: 'RAW_MATERIAL' as const, base_unit })

describe('unit catalogue', () => {
  it('has the 15 standard units, with Rolls (ROL)', () => {
    assert.deepEqual(STANDARD_UNITS.map((u) => u.code),
      ['PCS', 'NOS', 'KGS', 'GMS', 'MTS', 'MTR', 'LTR', 'ROL', 'BOX', 'CTN', 'SET', 'PRS', 'BDL', 'SQM', 'CBM'])
    assert.equal(unitOptionLabel('ROL'), 'Rolls (ROL)')
    assert.equal(unitOptionLabel('MTR'), 'Metres (MTR)')
    assert.equal(unitOptionLabel('LTR'), 'Litres (LTR)')
    assert.equal(unitOptionLabel('ZZZ'), 'ZZZ', 'an unknown company unit shows its code')
  })

  it('earlier codes stay valid and are recognised as the same unit', () => {
    for (const u of LEGACY_UNITS) assert.ok(isKnownUnit(u.code), u.code)
    assert.equal(unitLabel('L'), 'Litres')
    assert.ok(sameUnit('L', 'LTR'))
    assert.ok(sameUnit('KG', 'KGS'))
    assert.ok(!sameUnit('LTR', 'MTR'))
    assert.ok(!sameUnit('', ''))
  })
})

describe('Product Master validation checks the stored code, not the label', () => {
  it('1–3. a product can be created with MTR, LTR or ROL', () => {
    for (const code of ['MTR', 'LTR', 'ROL']) {
      const r = validateProduct(form(code))
      assert.deepEqual(r.errors, {}, code)
      assert.equal(r.input?.base_unit, code)
    }
  })

  it('every standard and supported unit is accepted', () => {
    for (const u of STANDARD_UNITS) assert.equal(validateProduct(form(u.code)).errors.base_unit, undefined, u.code)
  })

  it('4–5. an MTR product can change to LTR, and an LTR product to ROL (the unit is sent as a change)', () => {
    for (const [from, to] of [['MTR', 'LTR'], ['LTR', 'ROL'], ['ROL', 'MTR']]) {
      const before = validateProduct(form(from), { units: [from] }).input
      const after = validateProduct(form(to), { units: [from] }).input
      assert.ok(before && after)
      assert.notEqual(before.base_unit, after.base_unit, `${from} → ${to}`)
      assert.equal(after.base_unit, to)
    }
  })

  it('7. an empty unit is rejected beside the field; a label or unknown code is rejected', () => {
    assert.equal(validateProduct(form('')).errors.base_unit, 'Select a unit of measurement.')
    assert.equal(validateProduct(form('  ')).errors.base_unit, 'Select a unit of measurement.')
    assert.match(validateProduct(form('Metres')).errors.base_unit!, /not a recognised unit/)
    assert.match(validateProduct(form('XYZ')).errors.base_unit!, /not a recognised unit/)
  })

  it('8. existing products keep their saved unit: older codes and company units stay valid when editing', () => {
    for (const code of ['KG', 'L', 'M', 'PAIR', 'ROLL']) assert.equal(validateProduct(form(code)).input?.base_unit, code)
    assert.equal(validateProduct(form('EA'), { units: ['EA'] }).input?.base_unit, 'EA', 'a unit from ERP Settings')
  })
})

describe('dropdown options', () => {
  it('standard units first, then the company units; older duplicates hidden unless the product uses one', () => {
    const settings = ['PCS', 'NOS', 'SET', 'PAIR', 'BOX', 'KG', 'G', 'LTR', 'ML', 'MTR', 'SQM'] // the database default list
    const options = productUnitOptions(settings)
    assert.deepEqual(options.slice(0, 15), STANDARD_UNITS.map((u) => u.code))
    assert.deepEqual(options.slice(15), ['ML'])
    assert.ok(options.includes('MTR') && options.includes('LTR') && options.includes('ROL'))
    assert.ok(productUnitOptions(settings, ['KG']).includes('KG'), 'a product saved with KG still shows KG')
    assert.deepEqual(productUnitOptions([]).slice(15), ['BAG', 'ML', 'SQFT'], 'all supported units when none are configured')
    assert.equal(new Set(productUnitOptions(settings, ['MTR', 'MTR'])).size, productUnitOptions(settings, ['MTR', 'MTR']).length, 'no duplicates')
  })
})

describe('9. Excel import and export', () => {
  const stored = (id: string, sku: string, base_unit: string): ExistingProduct => ({
    id, sku, updatedAt: '2026-11-01T10:00:00.123456+00:00',
    values: productRowToFormValues({
      sku, product_name: `Product ${sku}`, description: null, category_id: null, brand: null, model_number: null, barcode: null,
      status: 'ACTIVE', product_type: 'RAW_MATERIAL', default_source_type: 'OUTSOURCED', base_unit, track_batches: false, track_expiry: false,
      hsn_code: null, gst_rate: null, selling_price: null, standard_cost: null, minimum_selling_price: null, reorder_level: null,
      standard_manufacturing_cost: null, mrp: null, is_manufacturable: false, has_bom: false, production_notes: null, remarks: null,
    } as Parameters<typeof productRowToFormValues>[0]),
  })
  const headers = ['SKU', 'Product Name', 'Product Type', 'Unit']
  const ctx = (products: ExistingProduct[]): ImportContext => {
    const maps = identityMaps(products.map((p) => ({ id: p.id, sku: p.sku, product_name: p.values.product_name })))
    return {
      categories: [], existingSkus: maps.existingSkus, existingBarcodes: new Set(), duplicateMode: 'update',
      existingProducts: new Map(products.map((p) => [skuKey(p.sku), p])), existingNames: maps.existingNames, looseSkus: maps.looseSkus,
    }
  }

  it('new products: codes and names give the standard code', () => {
    const rows = [['RM-1', 'Hose', 'Raw Material', 'MTR'], ['RM-2', 'Oil', 'Raw Material', 'Litres'], ['RM-3', 'Tape', 'Raw Material', 'rolls'], ['RM-4', 'Wire', 'Raw Material', 'ROL']]
    const r = validateImportRows(rows, autoMapColumns(headers), ctx([]))
    assert.deepEqual(r.map((x) => [x.status, x.input?.base_unit]), [['valid', 'MTR'], ['valid', 'LTR'], ['valid', 'ROL'], ['valid', 'ROL']])
  })

  it('an existing product keeps its code when the file names the same unit, and changes when it names another', () => {
    const products = [stored('p1', 'RM-L', 'L'), stored('p2', 'RM-M', 'MTR')]
    const [same, other] = validateImportRows([['RM-L', 'Product RM-L', 'Raw Material', 'LTR'], ['RM-M', 'Product RM-M', 'Raw Material', 'LTR']],
      autoMapColumns(headers), ctx(products))
    assert.equal(same.compared?.find((c) => c.field === 'base_unit')?.action, 'unchanged', 'L and LTR are the same unit: no change')
    assert.equal((same.input as Record<string, unknown> | null)?.base_unit, undefined)
    assert.equal((other.input as Record<string, unknown> | null)?.base_unit, 'LTR', 'MTR → LTR is updated')
  })

  it('export writes the stored code, which imports back unchanged', () => {
    const p = { sku: 'RM-3', product_name: 'Tape', category_id: null, product_type: 'RAW_MATERIAL', default_source_type: 'OUTSOURCED', base_unit: 'ROL', status: 'ACTIVE', archived_at: null }
    const [header, row] = productExportRows([p as never], [])
    const unit = row[header.indexOf('Unit')]
    assert.equal(unit, 'ROL')
    assert.equal(findUnit(String(unit)), 'ROL')
    for (const code of ['MTR', 'LTR', 'KG', 'L']) assert.equal(findUnit(code), code, 'codes are kept exactly')
  })
})
