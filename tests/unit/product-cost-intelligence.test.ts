// Product Cost Intelligence and the BOM cost columns (migration 20261208090000): presentation model + wiring.
// The cost rules run in the database (tests/db/product-cost-intelligence-check.mjs); nothing here calculates a cost.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BOM_COST_EXPORT_HEADERS, BOM_COST_TOOLTIPS, bomCostDifference, bomCostExportRows, bomCostMissingNote, bomCostText, bomUnitCost, costSortValue, signedCostText,
  type BomCostRow,
} from '../../src/features/production/bom-cost-columns.ts'
import { COST_SOURCE_LABELS, costIntelligence, historyChange, historyReference } from '../../src/features/products/cost-intelligence.ts'
import { masterCost, masterCostNote } from '../../src/features/products/master-cost.ts'
import { SOURCE_TYPE_LABELS, parseSourceType } from '../../src/features/products/product-model.ts'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const read = (p: string) => readFileSync(path.join(src, p), 'utf8')
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = path.join(dir, f)
  return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : []
})
const cost = (over: Partial<BomCostRow>): BomCostRow => ({
  bom_id: 'b1', status: 'APPROVED', bom_unit_cost: '48.9000', bom_cost_status: 'COMPLETE', missing_count: 0, line_count: 2,
  cost_calculated_at: '2026-11-12T10:00:00Z', product_master_cost: '45.5', product_master_cost_source: 'GRN', cost_difference: '3.4000', ...over,
})

describe('Sourcing method (the existing default_source_type, relabelled)', () => {
  it('Manufacture / Purchase / Both (Make & Buy); stored codes unchanged', () => {
    assert.deepEqual(SOURCE_TYPE_LABELS, { IN_HOUSE: 'Manufacture', OUTSOURCED: 'Purchase', HYBRID: 'Both (Make & Buy)' })
  })
  it('imports accept the new labels and the earlier ones', () => {
    for (const [v, code] of [['Manufacture', 'IN_HOUSE'], ['Purchase', 'OUTSOURCED'], ['Both (Make & Buy)', 'HYBRID'], ['Make & Buy', 'HYBRID'],
      ['In-House', 'IN_HOUSE'], ['Outsourced', 'OUTSOURCED'], ['Hybrid', 'HYBRID'], ['both', 'HYBRID']] as const) {
      assert.equal(parseSourceType(v), code, v)
    }
    assert.equal(parseSourceType('Sometimes'), null)
  })
})

describe('Cost Intelligence view', () => {
  const base = { cost_status: 'CURRENT', cost_status_note: null, default_cost_source: 'BOM' as const, updated_at: '2026-11-01T00:00:00Z' }
  it('Manufacture: BOM source, the BOM version as reference, up to date', () => {
    const v = costIntelligence({ ...base, default_source_type: 'IN_HOUSE', master_cost: '48.9', master_cost_source: 'BOM', master_cost_reference: 'BOM-000001 v2',
      bom_manufacturing_cost: '48.9', bom_cost_bom_code: 'BOM-000001', bom_cost_version: 2, bom_cost_status: 'COMPLETE', cost_updated_at: '2026-11-12T10:00:00Z' })
    assert.equal(v.available, true)
    assert.equal(v.currentCost, 48.9)
    assert.equal(v.bomCost, 48.9)
    assert.equal(v.sourceLabel, 'BOM')
    assert.equal(v.reference, 'BOM-000001 v2')
    assert.equal(v.lastUpdated, '2026-11-12T10:00:00Z')
    assert.deepEqual(v.status, { tone: 'ok', text: 'Up to date' })
    assert.equal(v.defaultCostSource, null)
    assert.match(v.rule, /active approved BOM/)
  })
  it('Purchase: GRN source with its receipt number; manual override shown as Manual', () => {
    const g = costIntelligence({ ...base, default_source_type: 'OUTSOURCED', master_cost: 120, master_cost_source: 'GRN', master_cost_reference: 'GRN-000004', last_purchase_cost: 120 })
    assert.equal(g.sourceLabel, 'GRN')
    assert.equal(g.reference, 'GRN-000004')
    assert.equal(g.lastPurchaseCost, 120)
    const m = costIntelligence({ ...base, default_source_type: 'OUTSOURCED', master_cost: 175, master_cost_source: 'MANUAL' })
    assert.equal(m.sourceLabel, COST_SOURCE_LABELS.MANUAL)
    assert.match(m.sourceLabel, /^Manual/)
  })
  it('Both: BOM and purchase cost kept apart; the default source is shown (BOM unless set)', () => {
    const v = costIntelligence({ ...base, default_source_type: 'HYBRID', default_cost_source: 'GRN', master_cost: 140, master_cost_source: 'GRN',
      bom_manufacturing_cost: 90, last_purchase_cost: 140 })
    assert.equal(v.bomCost, 90)
    assert.equal(v.lastPurchaseCost, 140)
    assert.equal(v.currentCost, 140)
    assert.equal(v.defaultCostSource, 'GRN')
    assert.match(v.rule, /kept separately/)
    assert.equal(costIntelligence({ ...base, default_source_type: 'HYBRID', default_cost_source: null }).defaultCostSource, 'BOM')
  })
  it('no valid new cost: the kept cost, its earlier source and the status explaining why', () => {
    const v = costIntelligence({ ...base, default_source_type: 'IN_HOUSE', master_cost: 400, master_cost_source: 'STANDARD', cost_status: 'BOM_INCOMPLETE',
      cost_status_note: 'No new cost available: 1 component(s) of BOM-000003 v1 have no cost.', bom_cost_status: 'MISSING_COSTS' })
    assert.equal(v.currentCost, 400)
    assert.equal(v.sourceLabel, 'Manual (entered standard cost)')
    assert.equal(v.status.tone, 'warning')
    assert.match(v.status.text, /1 component/)
    assert.equal(v.bomCost, null)
    assert.equal(v.bomNote, 'Active BOM: some components have no cost')
    assert.equal(v.lastUpdated, '2026-11-01T00:00:00Z', 'standard cost: the product\'s last update')
    const n = costIntelligence({ ...base, default_source_type: 'OUTSOURCED', master_cost: 100, master_cost_source: 'GRN', cost_status: 'NO_NEW_COST', cost_status_note: null })
    assert.deepEqual(n.status, { tone: 'info', text: 'No new cost available' })
  })
  it('before the migration (no cost columns): marked unavailable, nothing invented', () => {
    const v = costIntelligence({ default_source_type: 'IN_HOUSE', master_cost: 10, master_cost_source: 'STANDARD' })
    assert.equal(v.available, false)
    assert.match(v.status.text, /not installed/)
  })
  it('history rows: "previous → new" and the related BOM version or GRN', () => {
    const money = (n: number) => `₹${n.toFixed(2)}`
    assert.equal(historyChange('999', '48.9', money), '₹999.00 → ₹48.90')
    assert.equal(historyChange(null, 48.9, money), '₹48.90')
    assert.equal(historyReference({ new_source: 'BOM', bom_code: 'BOM-000001', bom_version: 2, receipt_number: null }), 'BOM-000001 v2')
    assert.equal(historyReference({ new_source: 'GRN', bom_code: null, bom_version: null, receipt_number: 'GRN-000004' }), 'GRN-000004')
    assert.equal(historyReference({ new_source: 'MANUAL', bom_code: null, bom_version: null, receipt_number: null }), 'Manual override')
  })
  it('Product Master Cost notes name the new sources', () => {
    const d = (x: string) => x
    assert.match(masterCostNote({ ...masterCost({ standard_cost: 1, master_cost: 5, master_cost_source: 'BOM' } as never) }, d), /BOM Manufacturing Cost/)
    assert.match(masterCostNote({ cost: 5, source: 'GRN', receiptNumber: 'GRN-000009', receiptDate: null, fallback: 1 }, d), /Latest valid purchase receipt GRN-000009/)
    assert.match(masterCostNote({ cost: 5, source: 'MANUAL', receiptNumber: null, receiptDate: null, fallback: 1 }, d), /override/)
  })
})

describe('BOM list cost columns', () => {
  it('BOM Cost / Unit, Product Master Cost and difference in INR with two decimals', () => {
    assert.equal(bomUnitCost(cost({})), 48.9)
    assert.equal(bomCostText(48.9), '₹48.90')
    assert.equal(bomCostDifference(cost({ cost_difference: '3.4049' })), 3.4)
    assert.equal(signedCostText(3.4), '+₹3.40')
    assert.equal(signedCostText(-3.4), '-₹3.40')
    assert.equal(signedCostText(null), '—')
    assert.equal(bomCostText(null), '—')
  })
  it('a dash with the reason when there is no valid BOM cost (drafts never shown as approved costs)', () => {
    assert.equal(bomUnitCost(cost({ bom_unit_cost: null, bom_cost_status: 'NOT_APPROVED', status: 'DRAFT' })), null)
    assert.match(bomCostMissingNote(cost({ bom_cost_status: 'NOT_APPROVED' })), /never used as the manufacturing cost/)
    assert.match(bomCostMissingNote(cost({ bom_cost_status: 'MISSING_COSTS', missing_count: 2 })), /2 component/)
    assert.match(bomCostMissingNote(cost({ bom_cost_status: 'NOT_CALCULATED' })), /Recalculate/)
    assert.match(bomCostMissingNote(undefined), /not installed/)
  })
  it('sorting puts rows without a cost last (ascending)', () => {
    const v = [null, 5, 1].map(costSortValue).sort((a, b) => a - b)
    assert.deepEqual(v, [1, 5, Number.POSITIVE_INFINITY])
  })
  it('tooltips explain each calculation', () => {
    assert.match(BOM_COST_TOOLTIPS.unit, /quantity × \(1 \+ wastage %\) × component Product Master Cost ÷ output quantity/)
    assert.match(BOM_COST_TOOLTIPS.difference, /BOM Cost \/ Unit − Product Master Cost/)
  })
  it('export sheet: one row per BOM, the same values as the list, blank where the list shows a dash', () => {
    const boms = [{ id: 'b1', bom_code: 'BOM-000001', version: 2, sku: 'FG-1', product_name: 'Basin', status: 'APPROVED' },
      { id: 'b2', bom_code: 'BOM-000001', version: 1, sku: 'FG-1', product_name: 'Basin', status: 'ARCHIVED' }]
    const rows = bomCostExportRows(boms, new Map([['b1', cost({})], ['b2', cost({ bom_id: 'b2', status: 'ARCHIVED', bom_unit_cost: null, bom_cost_status: 'NOT_APPROVED', cost_difference: null })]]), () => '12 Nov 2026')
    assert.deepEqual(rows[0], [...BOM_COST_EXPORT_HEADERS])
    assert.deepEqual(rows[1], ['BOM-000001', 2, 'FG-1', 'Basin', 'APPROVED', 48.9, 45.5, 3.4, '12 Nov 2026', ''])
    assert.equal(rows[2][5], '')
    assert.equal(rows[2][6], 45.5)
    assert.equal(rows[2][7], '')
    assert.match(String(rows[2][9]), /never used/)
  })
})

describe('Wiring', () => {
  it('the BOM list has the four sortable cost columns with tooltips, Recalculate (products.update) and the cost export sheet', () => {
    const page = read('pages/production/boms-page.tsx')
    for (const h of ["header: 'BOM Cost / Unit'", "header: 'Product Master Cost'", "header: 'Cost Difference'", "header: 'Cost Updated'"]) assert.ok(page.includes(h), h)
    assert.equal((page.match(/headerTitle: BOM_COST_TOOLTIPS\./g) ?? []).length, 4)
    assert.equal((page.match(/sortValue: \(b\) => costSortValue/g) ?? []).length, 3)
    assert.match(page, /name: 'BOM Costs', rows: costSheet/)
    assert.match(page, /<PermissionGate permission="products\.update">\s*<Button type="button" variant="outline" disabled=\{recalc !== null\}/)
    // Existing filters and export kept.
    for (const t of ['FilterTabs<Filter>', 'Product type filter', 'Group head filter', "name: 'BOM', rows: sheet", 'pageSize={20}']) assert.ok(page.includes(t), t)
  })
  it('Product Master shows Cost Intelligence and a Cost History tab', () => {
    const page = read('pages/products/product-detail-page.tsx')
    assert.match(page, /<CostIntelligenceCard /)
    assert.match(page, /\['cost-history', 'Cost History'\]/)
    assert.match(page, /<ProductCostHistoryTab /)
    assert.match(page, /canEdit=\{has\('products\.update'\) && !archived\}/)
  })
  it('cost tables and views are never written by the app (database functions only)', () => {
    for (const f of files(src)) {
      assert.doesNotMatch(readFileSync(f, 'utf8'), /from\('(product_cost_profiles|product_cost_history|bom_cost_snapshots)'[^)]*\)\s*\.(insert|update|upsert|delete)/, f)
    }
    const svc = read('services/product-cost.ts')
    for (const fn of ['product_cost_recalculate', 'product_cost_set_default_source', 'product_sourcing_proposals', 'product_sourcing_apply']) assert.ok(svc.includes(`'${fn}'`), fn)
  })
})
