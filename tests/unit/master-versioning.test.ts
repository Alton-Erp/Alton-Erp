import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { findReport, reportSheet, reportTotals } from '../../src/features/management/report-defs.ts'
import { bomUnitCost, CHANGE_LABELS, compareBomVersions, compareProductVersions, formatVersionValue, versionLabel, type BomVersion } from '../../src/features/versions/version-model.ts'

describe('product version comparison', () => {
  const v1 = { sku: 'MV-CA', product_name: 'Ceramic bowl', standard_cost: 10, hsn_code: '6910', base_unit: 'PCS', track_batches: false }
  const v2 = { sku: 'MV-CA', product_name: 'Ceramic bowl (new glaze)', standard_cost: 12, hsn_code: '6911', base_unit: 'PCS', track_batches: false }
  it('flags exactly the changed attributes, in a stable business order', () => {
    const d = compareProductVersions(v1, v2)
    assert.deepEqual(d.filter((x) => x.changed).map((x) => x.key), ['product_name', 'hsn_code', 'standard_cost'])
    assert.equal(d[0].key, 'sku')
    assert.equal(d.find((x) => x.key === 'standard_cost')?.label, 'Standard cost')
    assert.ok(!d.find((x) => x.key === 'sku')?.changed)
  })
  it('attributes present in only one version count as changed', () => {
    assert.ok(compareProductVersions({ a: 1 }, { a: 1, ean: '8901234567890' }).find((x) => x.key === 'ean')?.changed)
  })
  it('labels and values', () => {
    assert.equal(versionLabel({ version_no: 1, is_legacy: true }), 'v1 (legacy baseline)')
    assert.equal(formatVersionValue(null), '—')
    assert.equal(formatVersionValue(false), 'No')
    assert.equal(formatVersionValue('FINISHED_GOOD'), 'FINISHED GOOD')
  })
})

describe('BOM version comparison', () => {
  const item = (id: string, over: Partial<BomVersion['items'][number]> = {}) => ({ component_product_id: id, line_no: 1, sku: id.toUpperCase(), product_name: id,
    component_version: 'v1', quantity: 1, unit: 'PCS', wastage_percentage: 0, notes: null, ...over })
  const bom = (version: number, items: BomVersion['items'], over: Partial<BomVersion> = {}): BomVersion => ({ id: `b${version}`, bom_code: 'BOM-000001', version,
    status: 'APPROVED', lifecycle: 'ACTIVE', effective_from: '2026-11-01', effective_to: null, output_quantity: 1, output_unit: 'PCS', notes: null,
    change_reason: null, process_instructions: null, created_by: null, created_at: '', approved_by: null, approved_at: null, items, ...over })
  it('added, removed and changed components (quantity, UOM, wastage, component version) are reported; unchanged last', () => {
    const a = bom(1, [item('ca'), item('cb', { quantity: 2 }), item('old')], { lifecycle: 'SUPERSEDED', effective_to: '2026-11-03' })
    const b = bom(2, [item('ca', { quantity: '3' as unknown as number, component_version: 'v2' }), item('cb', { quantity: 2 }), item('new', { wastage_percentage: 2 })],
      { change_reason: 'Three-bowl design' })
    const { header, components } = compareBomVersions(a, b)
    assert.deepEqual(components.map((c) => [c.component_product_id, c.change]), [['new', 'ADDED'], ['old', 'REMOVED'], ['ca', 'CHANGED'], ['cb', 'UNCHANGED']])
    assert.deepEqual(components.find((c) => c.component_product_id === 'ca')?.fields, ['quantity', 'component version'])
    assert.ok(header.find((h) => h.key === 'change_reason')?.changed)
    assert.ok(header.find((h) => h.key === 'lifecycle')?.changed)
    assert.ok(!header.find((h) => h.key === 'output_quantity')?.changed)
  })
  it('cost changes: a component whose standard cost changed is Modified (cost); unit cost of a version; labels', () => {
    const a = bom(1, [item('ca', { standard_cost: 10, line_cost: 10 }), item('cb', { quantity: 2, standard_cost: 5, line_cost: 10 })])
    const b = bom(2, [item('ca', { standard_cost: 12, line_cost: 12, component_version: 'v2' }), item('cb', { quantity: 2, standard_cost: 5, line_cost: 10 })])
    const { components } = compareBomVersions(a, b)
    assert.deepEqual(components.find((c) => c.component_product_id === 'ca')?.fields, ['component version', 'cost'])
    assert.equal(bomUnitCost(a), 20)
    assert.equal(bomUnitCost(b), 22)
    assert.equal(bomUnitCost(bom(3, [item('x', { line_cost: null })])), null, 'unknown cost is never treated as zero')
    assert.equal(CHANGE_LABELS.CHANGED, 'Modified')
  })
  it('numeric quantities are compared as numbers (3 and "3.000" are equal)', () => {
    const { components } = compareBomVersions(bom(1, [item('ca', { quantity: 3 })]), bom(2, [item('ca', { quantity: '3.000' as unknown as number })]))
    assert.equal(components[0].change, 'UNCHANGED')
  })
})

describe('9. Excel exports match the ERP report (historical values and versions)', () => {
  const rows = [
    { date: '2026-11-04', number: 'TXN-1', type: 'RECEIPT', sku: 'MV-CA', product_name: 'Ceramic bowl', product_version: 'v1', quantity: 100, unit: 'PCS', warehouse: 'W1', location: 'GENERAL', reference: 'GRN-1', reason: 'Received' },
    { date: '2026-11-04', number: 'TXN-2', type: 'RECEIPT', sku: 'MV-CA', product_name: 'Ceramic bowl (new glaze)', product_version: 'v2', quantity: 5, unit: 'PCS', warehouse: 'W1', location: 'GENERAL', reference: 'GRN-2', reason: 'Received' },
    { date: '2026-10-01', number: 'TXN-0', type: 'RECEIPT', sku: 'MV-OLD', product_name: 'Old washer', product_version: 'Legacy / Unversioned', quantity: 50, unit: 'PCS', warehouse: 'W1', location: 'GENERAL', reference: null, reason: 'Opening' },
  ]
  it('stock movements: every cell, including the version column and the transaction-time names, comes straight from the report rows', () => {
    const def = findReport('stock_movements')!
    const sheet = reportSheet(def, rows)
    const col = (label: string) => sheet[0].indexOf(label)
    assert.ok(col('Version') > 0, 'version column missing from the export')
    assert.deepEqual(sheet.slice(1).map((r) => [r[col('Product')], r[col('Version')], r[col('Quantity')]]),
      [['Ceramic bowl', 'v1', 100], ['Ceramic bowl (new glaze)', 'v2', 5], ['Old washer', 'Legacy / Unversioned', 50]])
    assert.equal(sheet.length, rows.length + 1, 'no total row for a report without totals')
  })
  it('material consumption and production register export the BOM and component versions', () => {
    const cons = findReport('material_consumption')!
    const sheet = reportSheet(cons, [{ date: '2026-11-04', order_number: 'PRD-1', bom: 'BOM-000001 v1', finished_sku: 'MV-FG', sku: 'MV-CA', product_name: 'Ceramic bowl',
      component_version: 'v1', unit: 'PCS', planned: 10, actual: 10, difference: 0, status: 'POSTED' }])
    assert.ok(sheet[0].includes('BOM version') && sheet[0].includes('Material version'))
    assert.ok(sheet[1].includes('BOM-000001 v1') && sheet[1].includes('v1') && sheet[1].includes('Ceramic bowl'))
    assert.ok(findReport('production_register')!.columns.some((c) => c.key === 'product_version'))
  })
  it('totals in the export equal the report totals (GRN register value), and cancelled / reversed rows are left out of both', () => {
    const def = findReport('grn_register')!
    const grn = [{ receipt_number: 'GRN-1', value: 1000.5, status: 'POSTED', product_version: 'v1' }, { receipt_number: 'GRN-2', value: 250.25, status: 'POSTED' },
      { receipt_number: 'GRN-3', value: 99, status: 'REVERSED' }]
    const totals = reportTotals(def, grn)
    const sheet = reportSheet(def, grn)
    const last = sheet[sheet.length - 1]
    assert.equal(last[0], 'Total')
    assert.equal(last[sheet[0].indexOf('Value')], totals.value)
    assert.equal(totals.value, 1250.75)
  })
})
