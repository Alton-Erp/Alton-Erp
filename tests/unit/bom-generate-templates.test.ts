// Generate Multiple BOMs — "Add Components from Existing BOM": the template's components are copied into each product's own list,
// edits never reach the template, several products use templates independently, costs follow the edited copy; page / service wiring.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  applyTemplateLines, bomCost, clearLineComponent, componentProblem, itemsFromLines, linesFromItems, newLine, type EditorLine,
} from '../../src/features/production/bom-tools-model.ts'

// A saved template BOM's component rows, as the bom_item_list view returns them.
const templateItems = [
  { component_product_id: 'c1', sku: 'RM-CLAY', product_name: 'Ball clay', inventory_unit: 'KG', unit: 'KG', quantity_required: 3, wastage_percentage: 5, notes: 'Two coats',
    source_type: 'PURCHASED', preferred_supplier_id: 's1' },
  { component_product_id: 'c2', sku: 'CMP-TAP', product_name: 'Brass tap', inventory_unit: 'PCS', unit: 'PCS', quantity_required: 2, wastage_percentage: 0, notes: null,
    source_type: null, preferred_supplier_id: null },
  { component_product_id: 'c3', sku: 'PK-BOX', product_name: 'Carton', inventory_unit: 'PCS', unit: 'PCS', quantity_required: 1, wastage_percentage: 0, notes: 'Printed',
    source_type: null, preferred_supplier_id: null },
]
const frozen = JSON.stringify(templateItems)
const cost = (lines: EditorLine[], output: number, prices: Record<string, number>) =>
  bomCost(lines.filter((l) => l.product).map((l) => ({ quantity: l.quantity, wastage: l.wastage || 0, unitCost: prices[l.product!.product_id] ?? null })), output)
/** Costs are rounded to 2 decimals (bomCost, as the BOM version history). */
const r2 = (v: number) => Math.round(v * 100) / 100
const prices = { c1: 12.5, c2: 450, c3: 35, c4: 80 }

describe('copying a template BOM into a product', () => {
  const source = linesFromItems(templateItems)
  it('keeps quantities, units, wastage, remarks, source and supplier', () => {
    const { lines } = applyTemplateLines([], source, 'replace')
    assert.deepEqual(itemsFromLines(lines), [
      { component_product_id: 'c1', quantity_required: 3, unit: 'KG', wastage_percentage: 5, notes: 'Two coats', source_type: 'PURCHASED', preferred_supplier_id: 's1' },
      { component_product_id: 'c2', quantity_required: 2, unit: 'PCS', wastage_percentage: 0, notes: null, source_type: null, preferred_supplier_id: null },
      { component_product_id: 'c3', quantity_required: 1, unit: 'PCS', wastage_percentage: 0, notes: 'Printed', source_type: null, preferred_supplier_id: null },
    ])
  })
  it('the copies are independent objects with new keys (nothing shared with the template lines)', () => {
    const { lines } = applyTemplateLines([], source, 'replace')
    lines.forEach((l, i) => {
      assert.notEqual(l, source[i])
      assert.notEqual(l.key, source[i].key)
      assert.notEqual(l.product, source[i].product)
      assert.deepEqual(l.product, source[i].product)
    })
  })
  it('editing the copy (quantity, wastage, remarks, replace, remove, add) never changes the template', () => {
    const before = JSON.stringify(source)
    const { lines } = applyTemplateLines([], source, 'replace')
    lines[0].quantity = '4'
    lines[0].wastage = '7'
    lines[0].notes = 'Three coats'
    lines[0].product!.sku = 'CHANGED'
    const replaced = lines.map((l) => (l.product?.product_id === 'c2' ? { ...l, product: { product_id: 'c4', sku: 'CMP-TAP2', product_name: 'Steel tap', base_unit: 'PCS' } } : l))
    const removed = replaced.filter((l) => l.product?.product_id !== 'c3')
    const added = [...removed, { ...newLine(), product: { product_id: 'c5', sku: 'X', product_name: 'X', base_unit: 'PCS' }, quantity: '1' }]
    const cleared = added.map((l, i) => (i === 0 ? clearLineComponent(l) : l))
    assert.ok(cleared.length === 3)
    assert.equal(JSON.stringify(source), before, 'template lines changed')
    assert.equal(JSON.stringify(templateItems), frozen, 'template rows changed')
    // Copying again gives the original values.
    assert.equal(itemsFromLines(applyTemplateLines([], source, 'replace').lines)[0].quantity_required, 3)
  })
  it('replace: the template components only; add: appended, components already in the list are skipped and named', () => {
    const current = linesFromItems([{ ...templateItems[1], quantity_required: 9 }, { ...templateItems[0], component_product_id: 'c9', sku: 'OWN' }])
    const r = applyTemplateLines(current, source, 'replace')
    assert.deepEqual(r.lines.map((l) => l.product!.product_id), ['c1', 'c2', 'c3'])
    const a = applyTemplateLines(current, source, 'add')
    assert.deepEqual(a.lines.map((l) => l.product!.product_id), ['c2', 'c9', 'c1', 'c3'])
    assert.equal(a.lines[0].quantity, '9', 'the existing line keeps its quantity')
    assert.deepEqual(a.skipped, ['CMP-TAP'])
    assert.equal(componentProblem(a.lines), null, 'no component twice after adding')
  })
  it('empty lines in the current list are dropped when adding; a template without components copies nothing', () => {
    const a = applyTemplateLines([newLine(), newLine()], source, 'add')
    assert.equal(a.lines.length, 3)
    assert.deepEqual(applyTemplateLines([newLine()], [], 'replace').lines, [])
  })
})

describe('several products, each with its own template and edits', () => {
  const t1 = linesFromItems(templateItems)
  const t2 = linesFromItems([{ ...templateItems[2], component_product_id: 'c4', sku: 'CMP-T2', quantity_required: 4 }])
  it('product A and product B are independent of each other and of both templates', () => {
    const a = applyTemplateLines([], t1, 'replace').lines
    const b = applyTemplateLines([], t2, 'replace').lines
    const c = applyTemplateLines([], t1, 'replace').lines // the same template for a third product
    a[0].quantity = '10'
    assert.equal(c[0].quantity, '3', 'two products from the same template share nothing')
    assert.equal(t1[0].quantity, '3')
    assert.deepEqual(b.map((l) => l.product!.product_id), ['c4'])
    assert.ok(a.every((x) => !c.some((y) => y.key === x.key)))
  })
  it('costs are recalculated from each product\'s edited copy', () => {
    const a = applyTemplateLines([], t1, 'replace').lines
    const original = cost(a, 2, prices)
    assert.equal(original.total, r2(3 * 1.05 * 12.5 + 2 * 450 + 35))
    assert.equal(original.perUnit, r2((3 * 1.05 * 12.5 + 2 * 450 + 35) / 2))
    // Replace the tap by a cheaper one and remove the carton.
    const edited = a.filter((l) => l.product!.product_id !== 'c3')
      .map((l) => (l.product!.product_id === 'c2' ? { ...l, product: { product_id: 'c4', sku: 'T', product_name: 'T', base_unit: 'PCS' } } : l))
    const e = cost(edited, 2, prices)
    assert.equal(e.total, r2(3 * 1.05 * 12.5 + 2 * 80))
    assert.ok(e.total < original.total)
    assert.equal(cost(t1, 2, prices).total, original.total, 'the template cost is unchanged')
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8')
  const page = read('pages/production/bom-generate-page.tsx')
  const picker = read('features/production/bom-template-picker.tsx')
  const svc = read('services/production.ts')
  it('every product row has its own "Add Components from Existing BOM" section after the component editor', () => {
    assert.match(picker, /Add Components from Existing BOM/)
    assert.ok(page.indexOf('<BomComponentEditor') < page.indexOf('<BomTemplateSection'), 'section after the editor')
    assert.match(page, /onApply=\{\(lines, template\) => update\(r\.key, \{ lines, template \}\)\}/)
    assert.match(page, /onClearReference=\{\(\) => update\(r\.key, \{ template: null \}\)\}/, 'clearing the reference keeps the lines')
  })
  it('the template id is sent only as provenance with the row\'s own items', () => {
    assert.match(page, /items: itemsFromLines\(row\.lines\),\s*\.\.\.\(row\.template \? \{ template_bom_id: row\.template\.bom_id \} : \{\}\)/)
    assert.match(page, /rows\.every\(\(row\) => !row\.product && !row\.template\)/, 'templated rows use bom_generate_multiple (records provenance)')
  })
  it('the template search offers saved, non-archived BOM records only, and the picker only reads', () => {
    assert.match(svc, /searchRpc<BomListRow>\('bom_search', q, 'ACTIVE', limit\)/)
    assert.match(picker, /searchBomTemplates\(term, 20\)/)
    assert.match(picker, /fetchBom\(bom\.id\)/)
    assert.doesNotMatch(picker, /production_save_bom|saveBom|archiveBom|deleteBom|bom_change|\.update\(|\.delete\(|\.insert\(|rpc\(/)
  })
  it('loading, error (with retry), empty and no-results states are shown', () => {
    for (const s of ['Searching saved BOMs', 'BOMs could not be loaded', 'Retry', 'No saved BOM matches', 'Reading the BOM’s components', 'could not be read', 'has no components to copy']) {
      assert.ok(picker.includes(s), s)
    }
  })
})
