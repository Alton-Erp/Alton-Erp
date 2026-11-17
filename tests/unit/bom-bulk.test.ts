// Bulk BOM management: Excel import parsing / validation, export rows, change descriptions,
// and static safety rules of migration 20261218090000.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applyResolvedSkus, changeText, cleanLine, importSkus, latestBomPerProduct, importTemplate, lineIdsOfFailingBoms, linesFromImport, parseImportSheet, quantityDelta, unusedAfterChange,
  validateImportRows, whereUsedExportRows,
} from '../../src/features/production/bom-bulk-model.ts'
import type { BatchDetail, BatchLine, ResolvedSku, WhereUsedRow } from '../../src/services/bom-bulk.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sku = (s: string, extra: Partial<ResolvedSku> = {}): ResolvedSku => ({ sku_key: s.toLowerCase(), product_id: `id-${s}`, sku: s, product_name: s, base_unit: 'PCS',
  product_type: 'FINISHED_GOOD', status: 'ACTIVE', current_bom_id: `bom-${s}`, current_bom_code: 'BOM-000001', current_version: 1, ...extra })
const line = (extra: Partial<BatchLine>): BatchLine => ({ id: 'l1', line_no: 1, action: 'REPLACE', source_bom_id: 'b1', bom_code: 'BOM-000001', source_version: 1,
  finished_product_id: 'f1', finished_sku: 'FG', finished_name: 'FG', component_product_id: 'c1', component_sku: 'C1', component_name: 'C1',
  new_component_product_id: null, new_component_sku: null, new_component_name: null, restore_from_bom_id: null, input: {}, old_quantity: 1.5, new_quantity: 3,
  old_unit: 'KG', new_unit: 'KG', old_wastage: 2, new_wastage: 2, old_notes: null, new_notes: null, validation_errors: [], warnings: [], result_bom_id: null,
  result_version: null, ...extra })

describe('Excel import: parsing', () => {
  it('finds the header row, maps headings and aliases, keeps spreadsheet row numbers, skips blank rows', () => {
    const r = parseImportSheet('ADD', [[], ['Bulk add'], ['finished sku', 'Component', 'QTY', 'UOM', 'Wastage', 'Notes'], ['FG-1', 'BOX', '2', 'pcs', '1%', 'carton'], [], ['FG-2', 'BOX', '3', '', '', '']])
    // The first non-empty row is the header: "Bulk add" alone is not a header → missing columns.
    assert.match(r.error ?? '', /Missing column/)
    const ok = parseImportSheet('ADD', [[], ['finished sku', 'Component', 'QTY', 'UOM', 'Wastage', 'Notes'], ['FG-1', 'BOX', '2', 'pcs', '1%', 'carton'], [], ['FG-2', 'BOX', '3', '', '', '']])
    assert.equal(ok.error, null)
    assert.deepEqual(ok.rows.map((x) => [x.rowNumber, x.finishedSku, x.componentSku, x.quantity, x.unit, x.wastage, x.notes]),
      [[3, 'FG-1', 'BOX', '2', 'PCS', '1', 'carton'], [5, 'FG-2', 'BOX', '3', '', '', '']])
  })
  it('template headings parse back for every operation', () => {
    for (const op of ['ADD', 'EDIT', 'DELETE', 'REPLACE'] as const) {
      const t = importTemplate(op).map((row) => row.map((c) => (c === null ? '' : String(c))))
      const r = parseImportSheet(op, t)
      assert.equal(r.error, null, op)
      assert.equal(r.rows.length, 1, op)
    }
  })
  it('missing required columns and empty files are reported', () => {
    assert.match(parseImportSheet('REPLACE', [['Finished Product SKU', 'Old Component SKU']]).error ?? '', /New Component SKU/)
    assert.match(parseImportSheet('ADD', []).error ?? '', /empty/)
    assert.match(parseImportSheet('DELETE', [['Finished Product SKU', 'Component SKU']]).error ?? '', /No data rows/)
  })
})

describe('Excel import: row-level validation', () => {
  const rows = (op: 'ADD' | 'EDIT' | 'REPLACE' | 'DELETE', data: string[][]) => validateImportRows(op, parseImportSheet(op, data).rows)
  it('required values, numbers, ranges and decimals', () => {
    const r = rows('ADD', [['Finished Product SKU', 'Component SKU', 'Quantity', 'Unit', 'Wastage %'],
      ['FG-1', 'BOX', '', '', ''], ['FG-1', 'TAPE', '-1', '', ''], ['FG-2', 'BOX', '1.1234567', '', ''], ['FG-3', 'BOX', '1', '', '100'], ['', 'BOX', '1', '', ''], ['FG-4', 'BOX', '2', '', '5']])
    assert.match(r[0].errors.join(), /Quantity is missing/)
    assert.match(r[1].errors.join(), /greater than zero/)
    assert.match(r[2].errors.join(), /6 decimals/)
    assert.match(r[3].errors.join(), /between 0 and 99.99/)
    assert.match(r[4].errors.join(), /Finished Product SKU is missing/)
    assert.deepEqual(r[5].errors, [])
  })
  it('the same finished product and component twice: the second row names the first', () => {
    const r = rows('DELETE', [['Finished Product SKU', 'Component SKU'], ['FG-1', 'BOX'], ['fg-1', 'box']])
    assert.deepEqual(r[0].errors, [])
    assert.match(r[1].errors.join(), /Same finished product and component as row 2/)
  })
  it('edit needs something to change; replace needs two different components', () => {
    assert.match(rows('EDIT', [['Finished Product SKU', 'Component SKU', 'New Quantity'], ['FG-1', 'BOX', '']])[0].errors.join(), /Nothing to change/)
    assert.match(rows('REPLACE', [['Finished Product SKU', 'Old Component SKU', 'New Component SKU'], ['FG-1', 'BOX', 'box']])[0].errors.join(), /same/)
  })
  it('Product Master checks: unknown SKU, no approved BOM, inactive component, unit mismatch; ids filled for valid rows', () => {
    const base = rows('ADD', [['Finished Product SKU', 'Component SKU', 'Quantity', 'Unit'],
      ['FG-1', 'BOX', '1', 'PCS'], ['FG-X', 'BOX', '1', ''], ['FG-NB', 'BOX', '1', ''], ['FG-1', 'OLD', '1', ''], ['FG-2', 'BOX', '1', 'KG']])
    assert.deepEqual(importSkus(base).sort(), ['BOX', 'FG-1', 'FG-2', 'FG-NB', 'FG-X', 'OLD'])
    const resolved = applyResolvedSkus('ADD', base, [sku('FG-1'), sku('FG-2'), sku('FG-NB', { current_bom_id: null }), sku('BOX', { product_type: 'PACKAGING_MATERIAL' }), sku('OLD', { status: 'INACTIVE' })])
    assert.deepEqual(resolved[0].errors, [])
    assert.equal(resolved[0].finishedProductId, 'id-FG-1')
    assert.equal(resolved[0].componentId, 'id-BOX')
    assert.match(resolved[1].errors.join(), /FG-X is not in the Product Master/)
    assert.match(resolved[2].errors.join(), /no approved BOM/)
    assert.match(resolved[3].errors.join(), /inactive/)
    assert.match(resolved[4].errors.join(), /no unit conversion is configured/)
    const { lines, rowNumbers } = linesFromImport('ADD', resolved)
    assert.deepEqual(rowNumbers, [2])
    assert.deepEqual(lines, [{ finished_product_id: 'id-FG-1', component_product_id: 'id-BOX', new_component_product_id: undefined, quantity: '1', factor: null, unit: 'PCS', wastage_percentage: null }])
  })
  it('replace rows carry the replacement and the conversion factor', () => {
    const r = applyResolvedSkus('REPLACE', rows('REPLACE', [['Finished Product SKU', 'Old Component SKU', 'New Component SKU', 'Conversion Factor'], ['FG-1', 'OLD', 'NEW', '2']]),
      [sku('FG-1'), sku('OLD'), sku('NEW')])
    assert.deepEqual(linesFromImport('REPLACE', r).lines[0], { finished_product_id: 'id-FG-1', component_product_id: 'id-OLD', new_component_product_id: 'id-NEW', quantity: null, factor: '2', unit: null, wastage_percentage: null })
  })
})

describe('preview helpers', () => {
  it('change descriptions and quantity differences', () => {
    assert.equal(changeText(line({})), '1.5 KG → 3 KG')
    assert.equal(changeText(line({ new_unit: 'PCS', new_wastage: 5 })), '1.5 KG → 3 PCS; wastage 2% → 5%')
    assert.equal(changeText(line({ action: 'DELETE', new_quantity: null })), 'Remove 1.5 KG')
    assert.equal(changeText(line({ action: 'ADD', old_quantity: null, new_quantity: 2, new_unit: 'PCS' })), 'Add 2 PCS')
    assert.equal(quantityDelta(line({})), 1.5)
    assert.equal(quantityDelta(line({ action: 'DELETE' })), -1.5)
    assert.equal(quantityDelta(line({ new_unit: 'PCS' })), null)
  })
  it('removing BOMs with errors takes every line of those BOMs', () => {
    const ls = [line({ id: 'a', source_bom_id: 'b1', validation_errors: ['x'] }), line({ id: 'b', source_bom_id: 'b1' }), line({ id: 'c', source_bom_id: 'b2' })]
    assert.deepEqual(lineIdsOfFailingBoms(ls), ['a', 'b'])
  })
  it('components left with stock or open POs and no current BOM are flagged', () => {
    const d = { impact: { components: [
      { product_id: 'p', sku: 'OLD', product_name: 'Old', unit: 'KG', roles: 'REMOVED', boms_in_batch: 3, current_boms: 3, current_boms_after: 0, on_hand: 10, reserved: 0, available: 10, open_po_quantity: 5, open_po_count: 1, consumed_90_days: 0, open_order_requirement: 0 },
      { product_id: 'q', sku: 'NEW', product_name: 'New', unit: 'KG', roles: 'ADDED', boms_in_batch: 3, current_boms: 0, current_boms_after: 0, on_hand: 0, reserved: 0, available: 0, open_po_quantity: 0, open_po_count: 0, consumed_90_days: 0, open_order_requirement: 0 },
    ] } } as unknown as BatchDetail
    assert.deepEqual(unusedAfterChange(d), ['OLD: 10 KG available, 5 KG on open purchase orders — no current BOM will use it.'])
  })
  it('requests drop blank optional values (server keeps the existing value) but keep notes', () => {
    assert.deepEqual(cleanLine({ bom_id: 'b', component_product_id: 'c', quantity: '', factor: null, wastage_percentage: 2, notes: '' }),
      { bom_id: 'b', component_product_id: 'c', wastage_percentage: '2', notes: '' })
  })
  it('where-used export has the required columns', () => {
    const r = whereUsedExportRows([{ sku: 'FG', product_name: 'Basin', bom_code: 'BOM-000001', version: 2, lifecycle: 'ACTIVE', is_current: true, effective_from: '2026-11-17',
      effective_to: null, component_sku: 'C', component_name: 'Glaze', quantity: 1.5, unit: 'KG', inventory_unit: 'KG', wastage_percentage: 2, output_quantity: 1, quantity_per_unit: 1.5, notes: null } as unknown as WhereUsedRow], (d) => d)
    for (const h of ['Finished Product SKU', 'Finished Product', 'BOM Number', 'Revision', 'Component SKU', 'Quantity', 'UOM', 'Wastage %', 'Status', 'Effective From']) assert.ok(r[0].includes(h), h)
    assert.deepEqual(r[1].slice(0, 6), ['FG', 'Basin', 'BOM-000001', 2, 'Active', 'Yes'])
  })
})

describe('migration safety rules', () => {
  const sql = readFileSync(path.join(root, 'supabase/migrations/20261218090000_bom_bulk_changes.sql'), 'utf8')
  it('never deletes or rewrites BOMs, production orders, stock or purchase orders', () => {
    assert.ok(!/delete\s+from\s+public\.(boms|bom_items|production_orders|production_order_materials|inventory_transactions|purchase_order_lines|production_material_consumption)\b/i.test(sql))
    assert.ok(!/update\s+public\.(production_orders|production_order_materials|inventory_[a-z_]+|purchase_order[a-z_]*|production_material_consumption)\b/i.test(sql))
    assert.ok(!/update\s+public\.bom_items\b/i.test(sql))
  })
  it('publishing creates new versions through the existing functions and is atomic', () => {
    const pub = sql.slice(sql.indexOf('function public.bom_change_batch_publish'), sql.indexOf('function public.bom_change_batch_create_reversal'))
    assert.match(pub, /production_new_bom_version/)
    assert.match(pub, /production_save_bom/)
    assert.match(pub, /exception when others then/)
    assert.match(pub, /require_permission\('production_bom.approve'\)/)
    assert.match(pub, /status <> 'APPROVED'/)
  })
  it('read functions are STABLE and write nothing (they run read-only in PostgREST)', () => {
    for (const fn of ['bom_where_used', 'bom_component_search', 'bom_change_batch_get', 'bom_revision_log', 'bom_change_batches_list']) {
      const body = sql.slice(sql.indexOf(`function public.${fn}(`))
      const head = body.slice(0, body.indexOf('$$'))
      assert.match(head, /\bstable\b/, fn)
      const def = body.slice(0, body.indexOf('\n$$;'))
      assert.ok(!/\b(insert into|create temporary|truncate)\b/i.test(def), fn)
    }
  })
  it('the BOM page offers the six tabs', () => {
    const page = readFileSync(path.join(root, 'src/pages/production/boms-page.tsx'), 'utf8')
    for (const t of ['BOM Master', 'Where-Used Analysis', 'Bulk BOM Editor', 'Revision History', 'Change Approvals', 'Excel Import/Export']) assert.ok(page.includes(`'${t}'`), t)
  })
})

describe('BOM Master: one row per finished product', () => {
  const b = (id: string, product: string, version: number, status: string) => ({ id, finished_product_id: product, version, status })
  it('keeps the latest approved version; else the latest version; one row per product', () => {
    const rows = [b('a2', 'A', 2, 'APPROVED'), b('a5', 'A', 5, 'APPROVED'), b('a6', 'A', 6, 'DRAFT'), b('c1', 'C', 1, 'DRAFT'), b('c3', 'C', 3, 'PENDING_APPROVAL'), b('d1', 'D', 1, 'APPROVED')]
    assert.deepEqual(latestBomPerProduct(rows).map((r) => r.id), ['a5', 'c3', 'd1'])
  })
  it('the page uses it unless all versions are asked for', () => {
    const page = readFileSync(path.join(root, 'src/pages/production/boms-page.tsx'), 'utf8')
    assert.match(page, /showAll \? all : latestBomPerProduct\(all\)/)
    assert.match(page, /Show all versions/)
  })
  it('the Bulk BOM Editor no longer offers bulk edit', () => {
    const editor = readFileSync(path.join(root, 'src/features/production/bom-bulk/bulk-editor-tab.tsx'), 'utf8')
    assert.match(editor, /const OPS: ImportOperation\[\] = \['REPLACE', 'DELETE', 'ADD'\]/)
    assert.ok(!/op === 'EDIT'/.test(editor))
  })
})
