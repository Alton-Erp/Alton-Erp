// Generate Multiple BOMs — "Add Components from Existing BOM": the template's components are copied into each product's own list,
// edits never reach the template, several products use templates independently, costs follow the edited copy; page / service wiring.
// Run: npm run test:unit
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  addQuantities, applyTemplateLines, bomCost, clearLineComponent, componentProblem, itemsFromLines, linesFromItems, newLine, type EditorLine,
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
  it('replace: the template components only (unchanged behaviour)', () => {
    const current = linesFromItems([{ ...templateItems[1], quantity_required: 9 }, { ...templateItems[0], component_product_id: 'c9', sku: 'OWN' }])
    const r = applyTemplateLines(current, source, 'replace')
    assert.deepEqual(r.lines.map((l) => [l.product!.product_id, l.quantity]), [['c1', '3'], ['c2', '2'], ['c3', '1']])
    assert.equal(r.error, null)
    assert.ok(r.lines.every((l) => !current.some((c) => c.key === l.key)))
  })
  it('empty lines in the current list are dropped when adding; a template without components copies nothing', () => {
    const a = applyTemplateLines([newLine(), newLine()], source, 'add')
    assert.equal(a.lines.length, 3)
    assert.deepEqual(applyTemplateLines([newLine()], [], 'replace').lines, [])
  })
})

describe('Add to the components: merge by increasing Required Qty', () => {
  const tpl = (rows: { id: string; sku: string; qty: number | string; unit?: string; wastage?: number; notes?: string | null }[]) =>
    linesFromItems(rows.map((r) => ({ component_product_id: r.id, sku: r.sku, product_name: r.sku, inventory_unit: r.unit ?? 'PCS', unit: r.unit ?? 'PCS',
      quantity_required: r.qty, wastage_percentage: r.wastage ?? 0, notes: r.notes ?? null })))
  const qty = (lines: EditorLine[]) => lines.map((l) => [l.product!.sku, l.quantity])

  it('existing component: Required Qty 2 + template 1 = 3, no new row, its own settings kept', () => {
    const current = tpl([{ id: 'c1', sku: 'A', qty: 2, wastage: 4, notes: 'Keep me' }])
    current[0].source = 'PURCHASED'
    current[0].supplierId = 's9'
    const r = applyTemplateLines(current, tpl([{ id: 'c1', sku: 'A', qty: 1, wastage: 9, notes: 'template note' }]), 'add')
    assert.equal(r.error, null)
    assert.deepEqual(qty(r.lines), [['A', '3']])
    assert.deepEqual([r.lines[0].wastage, r.lines[0].notes, r.lines[0].source, r.lines[0].supplierId, r.lines[0].key], ['4', 'Keep me', 'PURCHASED', 's9', current[0].key])
    assert.deepEqual([r.merged, r.added], [['A'], []])
    assert.equal(current[0].quantity, '2', 'the current list object is not mutated (a new list is returned)')
  })
  it('several matching components all increase', () => {
    const r = applyTemplateLines(tpl([{ id: 'c1', sku: 'A', qty: 2 }, { id: 'c2', sku: 'B', qty: 5 }, { id: 'c3', sku: 'C', qty: 1 }]),
      tpl([{ id: 'c1', sku: 'A', qty: 1 }, { id: 'c3', sku: 'C', qty: 4 }]), 'add')
    assert.deepEqual(qty(r.lines), [['A', '3'], ['B', '5'], ['C', '5']])
    assert.deepEqual(r.merged, ['A', 'C'])
  })
  it('missing component: appended with the template quantity and details', () => {
    const r = applyTemplateLines(tpl([{ id: 'c1', sku: 'A', qty: 2 }]), tpl([{ id: 'c7', sku: 'G', qty: 1.25, unit: 'KG', wastage: 3, notes: 'Glaze' }]), 'add')
    assert.deepEqual(qty(r.lines), [['A', '2'], ['G', '1.25']])
    assert.deepEqual([r.lines[1].wastage, r.lines[1].notes, r.lines[1].product!.base_unit], ['3', 'Glaze', 'KG'])
    assert.deepEqual([r.merged, r.added], [[], ['G']])
  })
  it('mixed: existing increased and missing added in one click', () => {
    const r = applyTemplateLines(tpl([{ id: 'c1', sku: 'A', qty: 2 }, { id: 'c2', sku: 'B', qty: 1 }]),
      tpl([{ id: 'c2', sku: 'B', qty: 2 }, { id: 'c5', sku: 'E', qty: 6 }]), 'add')
    assert.deepEqual(qty(r.lines), [['A', '2'], ['B', '3'], ['E', '6']])
    assert.deepEqual([r.merged, r.added], [['B'], ['E']])
    assert.equal(componentProblem(r.lines), null, 'no component twice')
  })
  it('matches on the SKU too (case-insensitive) when the id differs', () => {
    const r = applyTemplateLines(tpl([{ id: 'c1', sku: 'Rm-Clay', qty: 2 }]), tpl([{ id: 'other-id', sku: 'RM-CLAY', qty: 1 }]), 'add')
    assert.deepEqual(qty(r.lines), [['Rm-Clay', '3']])
  })
  it('different inventory units: nothing changes and a clear error is returned', () => {
    const current = tpl([{ id: 'c1', sku: 'A', qty: 2, unit: 'KG' }, { id: 'c2', sku: 'B', qty: 1 }])
    const r = applyTemplateLines(current, tpl([{ id: 'c2', sku: 'B', qty: 1 }, { id: 'c1', sku: 'A', qty: 500, unit: 'G' }]), 'add')
    assert.match(r.error ?? '', /A: the list has it in KG but the template in G. Quantities in different units cannot be added/)
    assert.equal(r.lines, current, 'all or nothing: B was not increased either')
    assert.deepEqual([r.merged, r.added], [[], []])
    // Unit case / spacing alone is not a difference.
    assert.equal(applyTemplateLines(tpl([{ id: 'c1', sku: 'A', qty: 2, unit: 'kg' }]), tpl([{ id: 'c1', sku: 'A', qty: 1, unit: 'KG ' }]), 'add').error, null)
  })
  it('an invalid quantity on the existing line is refused; a blank one counts as 0', () => {
    const bad = tpl([{ id: 'c1', sku: 'A', qty: 2 }])
    bad[0].quantity = 'abc'
    assert.match(applyTemplateLines(bad, tpl([{ id: 'c1', sku: 'A', qty: 1 }]), 'add').error ?? '', /A: enter a valid Required Qty/)
    const blank = tpl([{ id: 'c1', sku: 'A', qty: 2 }])
    blank[0].quantity = ''
    assert.deepEqual(qty(applyTemplateLines(blank, tpl([{ id: 'c1', sku: 'A', qty: 1.5 }]), 'add').lines), [['A', '1.5']])
  })
  it('decimal quantities are exact (no floating-point error)', () => {
    assert.equal(0.1 + 0.2 === 0.3, false, 'plain number addition would be wrong')
    assert.equal(addQuantities('0.1', '0.2'), '0.3')
    assert.equal(addQuantities('2.5', '0.5'), '3')
    assert.equal(addQuantities('1.005', '2.0049'), '3.0099')
    assert.equal(addQuantities('0.000001', '0.000002'), '0.000003')
    assert.equal(addQuantities('123456789.123456', '0.876544'), '123456790')
    assert.equal(addQuantities('.5', '1'), '1.5')
    assert.equal(addQuantities('', '2'), '2')
    assert.equal(addQuantities('1e-7', '1'), '1')
    assert.equal(addQuantities('-1', '2'), null)
    assert.equal(addQuantities('1,5', '2'), null)
    const r = applyTemplateLines(tpl([{ id: 'g', sku: 'GLZ', qty: 0.1, unit: 'KG' }]), tpl([{ id: 'g', sku: 'GLZ', qty: 0.2, unit: 'KG' }]), 'add')
    assert.deepEqual(qty(r.lines), [['GLZ', '0.3']])
  })
  it('repeated clicks add the quantities again', () => {
    const t = tpl([{ id: 'c1', sku: 'A', qty: 1 }, { id: 'g', sku: 'GLZ', qty: 0.2, unit: 'KG' }])
    let lines = tpl([{ id: 'c1', sku: 'A', qty: 2 }])
    for (let i = 0; i < 3; i++) lines = applyTemplateLines(lines, t, 'add').lines
    assert.deepEqual(qty(lines), [['A', '5'], ['GLZ', '0.6']])
  })
  it('the template and other products are never changed; costs follow the merged quantities', () => {
    const t = tpl([{ id: 'c1', sku: 'A', qty: 1 }])
    const before = JSON.stringify(t)
    const productA = tpl([{ id: 'c1', sku: 'A', qty: 2 }])
    const productB = tpl([{ id: 'c1', sku: 'A', qty: 2 }])
    const r = applyTemplateLines(productA, t, 'add')
    assert.equal(JSON.stringify(t), before)
    assert.deepEqual(qty(productB), [['A', '2']])
    assert.equal(bomCost(r.lines.map((l) => ({ quantity: l.quantity, wastage: 0, unitCost: 10 })), 1).total, 30)
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
