// BOM templates, clone, similar products and comparison: pure model + wiring (no browser, no database).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  bomCost, compareBoms, componentProblem, costDifference, itemsFromLines, lineChanges, linesFromItems, newLine, productPayload, roundTo, similarProductValues,
  type EditorLine,
} from '../../src/features/production/bom-tools-model.ts'
import { EMPTY_PRODUCT_FORM } from '../../src/features/products/product-validation.ts'
import { NAV_ITEMS, NAV_PERMISSIONS } from '../../src/config/navigation.ts'

const line = (id: string, sku: string, quantity: string, wastage = '0', unit = 'PCS'): EditorLine =>
  ({ ...newLine(), product: { product_id: id, sku, product_name: sku, base_unit: unit }, quantity, wastage })

describe('BOM material cost (same method as the BOM version history)', () => {
  it('component cost = quantity × (1 + wastage %) × unit cost; per finished unit = ÷ output quantity', () => {
    const c = bomCost([{ quantity: 3, wastage: 5, unitCost: 12.5 }, { quantity: 2, wastage: 0, unitCost: 450 }, { quantity: 2, wastage: 2, unitCost: 800 }, { quantity: 2, wastage: 0, unitCost: 35 }], 2)
    assert.equal(c.total, 2641.38)
    assert.equal(c.perUnit, 1320.69)
    assert.deepEqual(c.lines.map((l) => l.perUnit), [19.6875, 450, 816, 35])
    assert.equal(c.complete, true)
  })
  it('components without a cost are left out and flagged', () => {
    const c = bomCost([{ quantity: 1, wastage: 0, unitCost: 10 }, { quantity: 1, wastage: 0, unitCost: null }], 1)
    assert.deepEqual([c.total, c.complete, c.missing, c.none], [10, false, 1, false])
    assert.equal(bomCost([{ quantity: 1, wastage: 0, unitCost: null }], 1).none, true)
  })
  it('difference from the source BOM in ₹ and %', () => {
    assert.deepEqual(costDifference(110, 100), { amount: 10, percent: 10 })
    assert.deepEqual(costDifference(95.5, 100), { amount: -4.5, percent: -4.5 })
    assert.deepEqual(costDifference(10, 0), { amount: 10, percent: null })
    assert.deepEqual(costDifference(null, 100), { amount: null, percent: null })
  })
  it('rounds half away from zero without floating-point drift', () => {
    assert.equal(roundTo(2.675, 2), 2.68)
    assert.equal(roundTo(1.005, 2), 1.01)
    assert.equal(roundTo(-2.675, 2), -2.68)
    assert.equal(roundTo(1320.6875, 2), 1320.69)
  })
})

describe('Component editor rules (same as the BOM editor and the database)', () => {
  it('a component on one line only; not the output product; quantity > 0; whole pieces for PCS', () => {
    assert.equal(componentProblem([newLine()]), 'Add at least one component.')
    assert.match(componentProblem([line('a', 'A', '1'), line('a', 'A', '2')]) ?? '', /already on line 1/)
    assert.match(componentProblem([line('fg', 'FG', '1')], 'fg') ?? '', /component of itself/)
    assert.match(componentProblem([line('a', 'A', '0')]) ?? '', /greater than zero/)
    assert.match(componentProblem([line('a', 'A', '1.5')]) ?? '', /whole PCS/)
    assert.equal(componentProblem([line('a', 'A', '1.5', '0', 'KG')]), null)
    assert.match(componentProblem([line('a', 'A', '1', '100')]) ?? '', /below 100/)
    assert.match(componentProblem([{ ...newLine(), quantity: '2' }]) ?? '', /select the component/)
  })
  it('lines become BOM / template items in the inventory unit', () => {
    const items = itemsFromLines([line('a', 'A', '2', '1.5', 'KG'), newLine()])
    assert.deepEqual(items, [{ component_product_id: 'a', quantity_required: 2, unit: 'KG', wastage_percentage: 1.5, notes: null, source_type: null, preferred_supplier_id: null }])
  })
  it('stored items become editable lines (round trip)', () => {
    const ls = linesFromItems([{ component_product_id: 'a', sku: 'A', product_name: 'Alpha', inventory_unit: 'KG', quantity_required: 2.5, wastage_percentage: 3, notes: 'x', source_type: 'PURCHASED', preferred_supplier_id: 's' }])
    assert.equal(ls[0].quantity, '2.5')
    assert.equal(ls[0].product?.base_unit, 'KG')
    assert.deepEqual(itemsFromLines(ls)[0], { component_product_id: 'a', quantity_required: 2.5, unit: 'KG', wastage_percentage: 3, notes: 'x', source_type: 'PURCHASED', preferred_supplier_id: 's' })
  })
  it('changes from the source: added, removed, quantity / wastage changed (replace = removed + added)', () => {
    const src = [line('a', 'A', '1'), line('b', 'B', '2'), line('c', 'C', '1')]
    const cur = [line('a', 'A', '2'), line('d', 'D', '1'), line('c', 'C', '1', '5')]
    assert.deepEqual(lineChanges(src, cur), { added: ['D'], removed: ['B'], changed: ['A', 'C'] })
  })
})

describe('BOM comparison', () => {
  const bom = (id: string, output: number, items: [string, number, number?][]) => ({
    id, label: id, output_quantity: output,
    items: items.map(([c, q, w = 0]) => ({ component_product_id: c, sku: c.toUpperCase(), product_name: c, unit: 'PCS', quantity_required: q, wastage_percentage: w })),
  })
  const costs: Record<string, number> = { tap: 450, bowl: 800, box: 35, seat: 600 }
  it('compares per finished unit, flags added / removed / changed against the baseline and totals the cost difference', () => {
    const r = compareBoms([bom('std', 2, [['tap', 2], ['bowl', 2], ['box', 2]]), bom('dlx', 1, [['tap', 1], ['bowl', 1, 5], ['seat', 1]])], (id) => costs[id] ?? null)
    const row = (id: string) => r.rows.find((x) => x.component_product_id === id)!
    assert.deepEqual(row('tap').cells.map((c) => [c.perUnit, c.state]), [[1, 'BASE'], [1, 'SAME']])
    assert.equal(row('tap').differs, false)
    assert.deepEqual(row('bowl').cells.map((c) => c.state), ['BASE', 'CHANGED'])
    assert.deepEqual(row('box').cells.map((c) => c.state), ['BASE', 'REMOVED'])
    assert.deepEqual(row('seat').cells.map((c) => c.state), ['ABSENT', 'ADDED'])
    // std: 450 + 800 + 35 = 1285; dlx: 450 + 840 + 600 = 1890 → +605 (+47.08 %)
    assert.deepEqual(r.totals.map((t) => t.perUnit), [1285, 1890])
    assert.deepEqual([r.totals[1].difference, r.totals[1].percent], [605, 47.08])
    assert.equal(r.totals[0].difference, null)
  })
  it('no cost difference against an incomplete total', () => {
    const r = compareBoms([bom('a', 1, [['tap', 1], ['clay', 1]]), bom('b', 1, [['tap', 2]])], (id) => costs[id] ?? null)
    assert.deepEqual([r.totals[0].complete, r.totals[1].complete, r.totals[1].difference], [false, true, null])
  })
  it('more than two BOMs', () => {
    const r = compareBoms([bom('a', 1, [['tap', 1]]), bom('b', 1, [['tap', 2]]), bom('c', 1, [['box', 1]])], (id) => costs[id] ?? null)
    assert.deepEqual(r.rows.find((x) => x.component_product_id === 'tap')!.cells.map((c) => c.state), ['BASE', 'CHANGED', 'REMOVED'])
    assert.equal(r.totals.length, 3)
  })
})

describe('New product details', () => {
  const source = { ...EMPTY_PRODUCT_FORM, sku: 'BAS-STD', product_name: 'Basin', barcode: '890123', ean: '8901234567890', image_url: 'https://x/y.png', model_number: 'M1',
    supplier_model_number: 'S1', supplier_product_name: 'SP', standard_cost: '1200', hsn_code: '6910', gst_rate: '18', category_id: 'cat', base_unit: 'PCS',
    product_type: 'FINISHED_GOOD' as const, default_source_type: 'IN_HOUSE' as const, lead_time_days: '7', mrp: '2500', track_batches: true }
  it('identity fields and the Cost are not copied; the other Product Master fields are', () => {
    const v = similarProductValues(source, { product_name: 'Basin Deluxe' })
    for (const k of ['sku', 'barcode', 'ean', 'image_url', 'model_number', 'supplier_model_number', 'supplier_product_name', 'standard_cost'] as const) assert.equal(v[k], '', k)
    assert.equal(v.product_name, 'Basin Deluxe')
    assert.deepEqual([v.hsn_code, v.gst_rate, v.category_id, v.base_unit, v.product_type, v.lead_time_days, v.mrp, v.track_batches], ['6910', '18', 'cat', 'PCS', 'FINISHED_GOOD', '7', '2500', true])
    assert.equal(v.status, 'ACTIVE')
  })
  it('the payload leaves the status to the database', () => {
    assert.equal('status' in productPayload({ sku: 'X', product_name: 'X', status: 'INACTIVE' } as never), false)
  })
})

describe('Wiring', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const src = path.join(root, 'src')
  const read = (p: string) => readFileSync(path.join(src, p), 'utf8')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [] })
  it('routes: create pages need production_bom.create, compare / templates need production_bom.read', () => {
    const routes = read('routes.ts')
    for (const [p, perm] of [['/production/boms/similar', 'production_bom.create'], ['/production/boms/generate', 'production_bom.create'], ['/production/boms/compare', 'production_bom.read'],
      ['/production/bom-templates/new', 'production_bom.create'], ['/production/bom-templates/:templateId', 'production_bom.read']]) {
      assert.match(routes, new RegExp(`path: '${p.replace(/[/:]/g, (c) => `\\${c}`)}', permission: '${perm}'`), p)
    }
    assert.ok(routes.indexOf("'/production/boms/similar'") < routes.indexOf("'/production/boms/:bomId'"))
  })
  it('the BOM Templates sidebar entry sits in Product Master & BOM, behind production_bom.read', () => {
    const item = NAV_ITEMS.find((i) => i.key === 'production-bom-templates')
    assert.equal(item?.group, 'products')
    assert.equal(item?.path, '/production/bom-templates')
    assert.equal(NAV_PERMISSIONS['production-bom-templates'], 'production_bom.read')
  })
  it('the BOM pages offer every action: create, clone, similar, template, from template, compare', () => {
    const list = read('pages/production/boms-page.tsx')
    for (const t of ['Create New BOM', 'Create similar product', 'Generate multiple', 'Compare BOMs', 'BOM templates']) assert.ok(list.includes(t), t)
    const detail = read('pages/production/bom-editor-page.tsx')
    for (const t of ['Clone BOM', 'Create similar product', 'Save as BOM template', 'Compare with other BOMs', '?clone=']) assert.ok(detail.includes(t), t)
    assert.ok(read('pages/production/bom-template-page.tsx').includes('Create product from template'))
  })
  it('templates and similar products are only written through the database functions (no direct table writes)', () => {
    for (const f of files(src)) {
      const s = readFileSync(f, 'utf8')
      assert.doesNotMatch(s, /from\('bom_templates'[^)]*\)\s*\.(insert|update|upsert|delete)|from\('bom_template_items'[^)]*\)\s*\.(insert|update|upsert|delete)/, f)
    }
    const svc = read('services/bom-tools.ts')
    for (const fn of ['bom_template_save', 'bom_template_set_status', 'bom_create_similar_products']) assert.ok(svc.includes(`'${fn}'`), fn)
  })
  it('generated BOMs are never activated by the generators (activation stays a separate, authorised action)', () => {
    assert.doesNotMatch(read('pages/production/bom-generate-page.tsx'), /activateBom|saveAndActivateBom|production_bom_activate/)
    const similar = read('pages/production/bom-similar-product-page.tsx')
    assert.match(similar, /has\('production_bom\.approve'\) && \(\s*<Button onClick=\{\(\) => setAction/)
  })
})
