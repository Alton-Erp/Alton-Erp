// BOM Product Planning & Classification, BOM Excel export / import and the
// Product Master EAN (migration 20261114090000). No database.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BOM_IMPORT_FIELDS, autoMapBomColumns, bomTemplateRows, buildBomImportReport, sameComponents, summarizeBomImport, validateBomRows, type BomImportProduct, type ExistingBom } from '../../src/features/production/bom-import.ts'
import { bomExportRows, planningChanges, validatePlanning } from '../../src/features/production/bom-planning-model.ts'
import { EXPORT_COLUMNS, productExportRows } from '../../src/features/products/product-export.ts'
import { autoMapColumns, productRowToFormValues, validateImportRows, type ExistingProduct } from '../../src/features/products/product-import.ts'
import { eanProblem, normalizeEan } from '../../src/features/products/product-model.ts'
import { EMPTY_PRODUCT_FORM, validateProduct } from '../../src/features/products/product-validation.ts'

describe('EAN (EAN-8 / EAN-13 with check digit)', () => {
  it('accepts valid EAN-13 and EAN-8 numbers, ignoring spaces and hyphens', () => {
    assert.equal(eanProblem('4006381333931'), null)
    assert.equal(eanProblem('96385074'), null)
    assert.equal(eanProblem('8901030865275'), null)
    assert.equal(normalizeEan('4006 3813-3393 1'), '4006381333931')
    assert.equal(eanProblem('4006 3813 3393 1'), null)
  })
  it('rejects letters, wrong lengths and wrong check digits with a clear reason', () => {
    assert.match(eanProblem('40063813339A1')!, /digits only/)
    assert.match(eanProblem('123456789012')!, /8 \(EAN-8\) or 13 \(EAN-13\).*12/)
    assert.match(eanProblem('4006381333932')!, /check digit.*should be 1/)
    assert.match(eanProblem('96385075')!, /should be 4/)
  })
  it('is optional on the product form; the stored value is normalised', () => {
    const base = { ...EMPTY_PRODUCT_FORM, product_name: 'Basin', product_type: 'FINISHED_GOOD' as const }
    assert.equal(validateProduct(base).input?.ean, null)
    assert.equal(validateProduct({ ...base, ean: ' 4006-3813-3393-1 ' }).input?.ean, '4006381333931')
    assert.match(validateProduct({ ...base, ean: '4006381333932' }).errors.ean!, /check digit/)
  })
})

describe('Product Master Excel: EAN', () => {
  const headers = ['SKU', 'Product Name', 'Product Type', 'Barcode', 'EAN', 'Group Head', 'Minimum Stock Days']
  const stored = (id: string, sku: string, ean: string | null): ExistingProduct => ({ id, sku, values: productRowToFormValues({
    sku, product_name: `Product ${sku}`, description: null, category_id: null, brand: null, model_number: null, barcode: null, ean,
    status: 'ACTIVE', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', base_unit: 'PCS', track_batches: false, track_expiry: false,
    hsn_code: null, gst_rate: null, selling_price: null, standard_cost: null, minimum_selling_price: null, reorder_level: null,
    is_manufacturable: true, has_bom: false, production_notes: null,
  }) })
  const ctx = (mode: 'update' | 'skip' = 'update') => ({
    categories: [], existingSkus: new Set(['fg-1', 'fg-2']), existingBarcodes: new Set<string>(), duplicateMode: mode,
    existingProducts: new Map([['fg-1', stored('p1', 'FG-1', '4006381333931')], ['fg-2', stored('p2', 'FG-2', null)]]),
    eanOwners: new Map([['4006381333931', 'p1']]),
  })

  it('maps an "EAN" column to the EAN field (not the barcode)', () => {
    const m = autoMapColumns(headers)
    assert.equal(m.ean, 4)
    assert.equal(m.barcode, 3)
    assert.equal(m.group_head, 5)
    assert.equal(m.minimum_cover_days, 6)
  })
  it('creates a product with a valid EAN; rejects invalid and duplicate EANs with the row number', () => {
    const rows = validateImportRows([
      ['NEW-1', 'Basin', 'Finished Good', '', '96385074', 'Sanitaryware', '15'],
      ['NEW-2', 'Tap', 'Finished Good', '', '96385075', '', ''],
      ['NEW-3', 'Seat', 'Finished Good', '', '96385074', '', ''],
      ['NEW-4', 'Tank', 'Finished Good', '', '4006381333931', '', ''],
      ['NEW-5', 'Pan', 'Finished Good', '', '', '', 'abc'],
    ], autoMapColumns(headers), ctx(), 2)
    assert.equal(rows[0].status, 'valid')
    assert.equal(rows[0].input?.ean, '96385074')
    assert.equal(rows[0].input?.group_head, 'Sanitaryware')
    assert.equal(rows[0].input?.minimum_cover_days, 15)
    assert.ok(rows[1].errors.some((e) => e.startsWith('EAN:') && e.includes('check digit')), rows[1].errors.join())
    assert.ok(rows[2].errors.some((e) => e.includes('Duplicate EAN 96385074 in this file (first seen on row 2)')))
    assert.ok(rows[3].errors.some((e) => e.includes('already used by another product')))
    assert.ok(rows[4].errors.some((e) => e.startsWith('Minimum Stock Days:')))
  })
  it('updates by SKU: keeps its own EAN, a blank EAN never erases the stored one, a new EAN is reported', () => {
    const rows = validateImportRows([
      ['FG-1', '', '', '', '4006381333931', 'Faucets', ''],
      ['FG-1', '', '', '', '', '', ''].map((c, i) => (i === 0 ? 'fg-1' : c)),
      ['FG-2', '', '', '', '96385074', '', ''],
    ], autoMapColumns(headers), { ...ctx(), existingSkus: new Set(['fg-1', 'fg-2']) }, 2)
    // FG-1 twice in the file: both rows are invalid.
    assert.equal(rows[0].errors[0], 'Duplicate SKU in this file: rows 2, 3 have SKU FG-1. Keep one row per SKU.')
    assert.equal(rows[1].errors[0], 'Duplicate SKU in this file: rows 2, 3 have SKU fg-1. Keep one row per SKU.')
    assert.equal(rows[2].status, 'valid')
    assert.deepEqual(rows[2].input, { ean: '96385074' })
    const [own] = validateImportRows([['FG-1', '', '', '', '4006381333931', 'Faucets', '']], autoMapColumns(headers), ctx(), 2)
    assert.equal(own.status, 'valid', own.errors.join())
    assert.deepEqual(own.changes?.map((c) => c.label), ['Group Head'], 'its own EAN is not a duplicate and not a change')
  })
  it('a blank EAN cell in an update file leaves the stored EAN untouched', () => {
    const [r] = validateImportRows([['FG-1', 'Renamed', '', '', '', '', '']], autoMapColumns(headers), ctx(), 2)
    assert.equal(r.status, 'valid')
    assert.ok(!('ean' in (r.input ?? {})), JSON.stringify(r.input))
  })
  it('exports EAN, Group Head and Minimum Stock Days in columns the import recognises', () => {
    for (const c of ['EAN', 'Group Head', 'Minimum Stock Days']) assert.ok(EXPORT_COLUMNS.includes(c as never), c)
    const m = autoMapColumns([...EXPORT_COLUMNS])
    assert.equal(EXPORT_COLUMNS[m.ean!], 'EAN')
    assert.equal(EXPORT_COLUMNS[m.barcode!], 'Barcode')
    const out = productExportRows([{ sku: 'FG-1', product_name: 'Basin', product_type: 'FINISHED_GOOD', default_source_type: 'IN_HOUSE', ean: '4006381333931',
      group_head: 'Sanitaryware', minimum_cover_days: 15, status: 'ACTIVE' } as never], [])
    assert.equal(out[1][out[0].indexOf('EAN')], '4006381333931')
    assert.equal(out[1][out[0].indexOf('Group Head')], 'Sanitaryware')
    assert.equal(out[1][out[0].indexOf('Minimum Stock Days')], 15)
  })
})

describe('BOM Product Planning & Classification', () => {
  it('validates tax rate (0–100 %) and days (0–3650), and returns the product columns', () => {
    const ok = validatePlanning({ taxRate: '18', leadTimeDays: '12.5', groupHead: '  Sanitary   ware ', minimumCoverDays: '30' })
    assert.deepEqual(ok.errors, {})
    assert.deepEqual(ok.patch, { gst_rate: 18, lead_time_days: 12.5, minimum_cover_days: 30, group_head: 'Sanitary ware' })
    const bad = validatePlanning({ taxRate: '118', leadTimeDays: '-1', minimumCoverDays: 'ten', groupHead: 'x'.repeat(101) })
    assert.match(bad.errors.taxRate!, /0 to 100/)
    assert.match(bad.errors.leadTimeDays!, /0 to 3650/)
    assert.match(bad.errors.minimumCoverDays!, /0 to 3650/)
    assert.match(bad.errors.groupHead!, /100 characters/)
    assert.deepEqual(validatePlanning({ taxRate: '' }).patch, { gst_rate: null }, 'a cleared form field clears the value')
  })
  it('only fields that differ from the Product Master are written', () => {
    const r = planningChanges({ gst_rate: '18.00', lead_time_days: 10, group_head: 'Sanitaryware', minimum_cover_days: null },
      { gst_rate: 18, lead_time_days: 12, group_head: 'Sanitaryware', minimum_cover_days: 15 })
    assert.deepEqual(r.patch, { lead_time_days: 12, minimum_cover_days: 15 })
    assert.deepEqual(r.changes.map((c) => c.label), ['Lead Time (Days)', 'Minimum Stock Days'])
  })
})

describe('BOM Excel import: planning columns and no duplicate BOMs', () => {
  const p = (id: string, sku: string, type: string, unit = 'PCS', extra: Partial<BomImportProduct> = {}): BomImportProduct =>
    ({ id, sku, product_name: `Name ${sku}`, product_type: type, base_unit: unit, status: 'ACTIVE', ...extra })
  const products = new Map([
    ['fg-1', p('fg1', 'FG-1', 'FINISHED_GOOD', 'PCS', { gst_rate: 18, lead_time_days: 10, group_head: 'Sanitaryware', minimum_cover_days: null })],
    ['fg-2', p('fg2', 'FG-2', 'FINISHED_GOOD')], ['fg-3', p('fg3', 'FG-3', 'SUBASSEMBLY')],
    ['rm-1', p('rm1', 'RM-1', 'RAW_MATERIAL', 'KG')], ['pkg-1', p('pkg1', 'PKG-1', 'PACKAGING_MATERIAL')],
  ])
  const approved: ExistingBom = { id: 'b1', bom_code: 'BOM-000001', version: 2, status: 'APPROVED', output_quantity: 1, items: [
    { component_product_id: 'rm1', quantity_required: 18.5, unit: 'KG', wastage_percentage: 3, source_type: null, preferred_supplier_id: null, notes: null },
    { component_product_id: 'pkg1', quantity_required: 1, unit: 'PCS', wastage_percentage: 0, source_type: null, preferred_supplier_id: null, notes: 'Carton' },
  ] }
  const draft: ExistingBom = { id: 'b2', bom_code: 'BOM-000002', version: 1, status: 'DRAFT', output_quantity: 1, items: [] }
  const ctx = { products, suppliers: [], activeVersions: new Map([['fg1', 2]]), latestBoms: new Map([['fg1', approved], ['fg2', draft]]), canUpdateProducts: true }
  const headers = BOM_IMPORT_FIELDS.map((f) => f.label)
  const row = (v: Partial<Record<(typeof BOM_IMPORT_FIELDS)[number]['key'], string>>) => BOM_IMPORT_FIELDS.map((f) => v[f.key] ?? '')

  it('the template has all six planning columns, recognised by the import, aligned with the example rows', () => {
    const t = bomTemplateRows()
    for (const c of ['Product Name', 'Product Type', 'Tax Rate (%)', 'Lead Time (Days)', 'Group Head', 'Minimum Stock Days']) assert.ok(t[0].includes(c), c)
    const m = autoMapBomColumns(t[0].map(String))
    assert.equal(t[1][m.tax_rate!], 18)
    assert.equal(t[1][m.component_sku!], 'SUB-000001')
    assert.equal(t[1][m.group_head!], 'Sanitaryware')
  })
  it('same components as the active version: no new version, only planning changes', () => {
    const [g] = validateBomRows([
      row({ finished_sku: 'FG-1', product_name: 'name fg-1', product_type: 'Finished Good', tax_rate: '18', lead_time_days: '12', group_head: 'Sanitaryware', minimum_cover_days: '15', component_sku: 'RM-1', quantity: '18.5', unit: 'KG', wastage: '3' }),
      row({ finished_sku: 'FG-1', component_sku: 'PKG-1', quantity: '1', remarks: 'Carton', lead_time_days: '12' }),
    ], autoMapBomColumns(headers), ctx, 2)
    assert.equal(g.status, 'valid', [...g.errors, ...g.rows.flatMap((r) => r.errors)].join(' | '))
    assert.equal(g.saveMode, 'unchanged')
    assert.deepEqual(g.planningPatch, { lead_time_days: 12, minimum_cover_days: 15 })
    assert.ok(g.warnings.some((w) => w.includes('no new BOM version')))
    assert.ok(!g.warnings.some((w) => w.includes('already has active')))
    const s = summarizeBomImport([g])
    assert.deepEqual([s.newVersions, s.draftUpdates, s.unchanged, s.planningUpdates], [0, 0, 1, 1])
    assert.equal(buildBomImportReport([g])[1][6], 'Lead Time (Days): 10 → 12 | Minimum Stock Days: — → 15')
  })
  it('changed components: a new version for an active BOM, the draft updated in place otherwise', () => {
    const groups = validateBomRows([
      row({ finished_sku: 'FG-1', component_sku: 'RM-1', quantity: '20', unit: 'KG' }),
      row({ finished_sku: 'FG-2', component_sku: 'RM-1', quantity: '2', unit: 'KG' }),
      row({ finished_sku: 'FG-3', component_sku: 'RM-1', quantity: '2', unit: 'KG' }),
    ], autoMapBomColumns(headers), ctx, 2)
    assert.deepEqual(groups.map((g) => g.saveMode), ['new-version', 'update-draft', 'new-version'])
    assert.equal(groups[1].existingBom?.id, 'b2')
    assert.ok(groups[0].warnings.some((w) => w.includes('already has active BOM version 2')))
  })
  it('rejects a product name or type that does not match the Product Master, bad tax / days, and differing values per BOM', () => {
    const groups = validateBomRows([
      row({ finished_sku: 'FG-1', product_name: 'Some other product', component_sku: 'RM-1', quantity: '1', unit: 'KG' }),
      row({ finished_sku: 'FG-2', product_type: 'Raw Material', component_sku: 'RM-1', quantity: '1', unit: 'KG' }),
      row({ finished_sku: 'FG-3', tax_rate: '150', lead_time_days: 'abc', minimum_cover_days: '-2', component_sku: 'RM-1', quantity: '1', unit: 'KG' }),
      row({ finished_sku: 'PKG-1', product_type: 'Gadget', component_sku: 'RM-1', quantity: '1', unit: 'KG' }),
    ].concat([row({ finished_sku: 'FG-2', group_head: 'A', component_sku: 'PKG-1', quantity: '1' }), row({ finished_sku: 'FG-2', group_head: 'B', component_sku: 'FG-3', quantity: '1' })]),
    autoMapBomColumns(headers), ctx, 2)
    const by = new Map(groups.map((g) => [g.finishedSku, g]))
    assert.ok(by.get('FG-1')!.rows[0].errors.some((e) => e.includes('does not match FG-1 in the Product Master')))
    assert.ok(by.get('FG-2')!.rows[0].errors.some((e) => e.includes('differs from the Product Master')))
    const fg3 = by.get('FG-3')!.rows[0].errors.join(' | ')
    assert.match(fg3, /Tax Rate "150" must be a percentage from 0 to 100/)
    assert.match(fg3, /Lead Time "abc"/)
    assert.match(fg3, /Minimum Stock Days "-2"/)
    assert.ok(by.get('PKG-1')!.rows[0].errors.some((e) => e.includes('Product Type "Gadget" is not recognised')))
    assert.ok(by.get('FG-2')!.rows[2].errors.some((e) => e.includes('Group Head B differs from A on row 6')))
    assert.ok(groups.every((g) => g.status === 'error'))
  })
  it('without permission to edit the Product Master, planning changes are skipped with a warning', () => {
    const [g] = validateBomRows([row({ finished_sku: 'FG-2', tax_rate: '12', component_sku: 'RM-1', quantity: '1', unit: 'KG' })],
      autoMapBomColumns(headers), { ...ctx, canUpdateProducts: false }, 2)
    assert.equal(g.status, 'valid')
    assert.deepEqual(g.planningPatch, {})
    assert.ok(g.warnings.some((w) => w.includes('products.update')))
  })
  it('component comparison checks quantity, unit, wastage, source, supplier and remarks', () => {
    const lines = [{ rowNumber: 2, component: products.get('rm-1')!, quantity: 18.5, unit: 'KG', source: null, wastage: 3, supplierId: null, remarks: null },
      { rowNumber: 3, component: products.get('pkg-1')!, quantity: 1, unit: 'PCS', source: null, wastage: 0, supplierId: null, remarks: 'Carton' }]
    assert.equal(sameComponents(approved, { outputQuantity: 1, lines }), true)
    assert.equal(sameComponents(approved, { outputQuantity: 2, lines }), false)
    assert.equal(sameComponents(approved, { outputQuantity: 1, lines: [{ ...lines[0], wastage: 4 }, lines[1]] }), false)
    assert.equal(sameComponents(approved, { outputQuantity: 1, lines: [lines[0]] }), false)
  })
})

describe('BOM Excel export', () => {
  it('exports one row per component with the six planning columns and re-imports as "unchanged"', () => {
    const headers = BOM_IMPORT_FIELDS.map((f) => f.label)
    const sheet = bomExportRows(headers, [{ id: 'b1', bom_code: 'BOM-000001', version: 2, status: 'APPROVED', sku: 'FG-1', product_name: 'Name FG-1', product_type: 'FINISHED_GOOD',
      output_quantity: '1.000', tax_rate: '18.00', lead_time_days: 10, group_head: 'Sanitaryware', minimum_cover_days: null }],
      [{ bom_id: 'b1', line_no: 2, sku: 'PKG-1', quantity_required: '1.000000', unit: 'PCS', wastage_percentage: '0.00', notes: 'Carton' },
        { bom_id: 'b1', line_no: 1, sku: 'RM-1', quantity_required: '18.500000', unit: 'KG', wastage_percentage: '3.00', source_type: null }],
      { typeLabel: () => 'Finished Good', sourceLabel: (s) => s, supplierCode: () => '' })
    assert.deepEqual(sheet[0].slice(-3), ['BOM Code', 'Version', 'Status'])
    const col = (h: string, r = 1) => sheet[r][sheet[0].indexOf(h)]
    assert.deepEqual([col('Component SKU'), col('Quantity per Output'), col('Tax Rate (%)'), col('Lead Time (Days)'), col('Group Head'), col('Minimum Stock Days'), col('Product Type')],
      ['RM-1', 18.5, 18, 10, 'Sanitaryware', '', 'Finished Good'])
    assert.equal(col('Component SKU', 2), 'PKG-1')
    const p = (id: string, sku: string, type: string, unit: string, extra = {}): BomImportProduct => ({ id, sku, product_name: `Name ${sku}`, product_type: type, base_unit: unit, status: 'ACTIVE', ...extra })
    const products = new Map([['fg-1', p('fg1', 'FG-1', 'FINISHED_GOOD', 'PCS', { gst_rate: 18, lead_time_days: 10, group_head: 'Sanitaryware' })],
      ['rm-1', p('rm1', 'RM-1', 'RAW_MATERIAL', 'KG')], ['pkg-1', p('pkg1', 'PKG-1', 'PACKAGING_MATERIAL', 'PCS')]])
    const latest: ExistingBom = { id: 'b1', bom_code: 'BOM-000001', version: 2, status: 'APPROVED', output_quantity: 1, items: [
      { component_product_id: 'rm1', quantity_required: 18.5, unit: 'KG', wastage_percentage: 3, source_type: null, preferred_supplier_id: null, notes: null },
      { component_product_id: 'pkg1', quantity_required: 1, unit: 'PCS', wastage_percentage: 0, source_type: null, preferred_supplier_id: null, notes: 'Carton' }] }
    const [g] = validateBomRows(sheet.slice(1).map((r) => r.map(String)), autoMapBomColumns(sheet[0].map(String)), { products, suppliers: [], latestBoms: new Map([['fg1', latest]]), canUpdateProducts: true }, 2)
    assert.equal(g.status, 'valid', [...g.errors, ...g.rows.flatMap((r) => r.errors)].join(' | '))
    assert.equal(g.saveMode, 'unchanged')
    assert.equal(g.planningChanges.length, 0)
  })
})
