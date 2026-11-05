import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { matchesConditions } from '../../src/features/drilldown/drill-conditions.ts'
import { DASHBOARDS, METRICS, MISSING_INFO } from '../../src/features/drilldown/drill-registry.ts'
import { ledgerSummary } from '../../src/features/ledger/ledger-model.ts'
import { missingInfo } from '../../src/features/products/product-missing-info.ts'

const product = (over: Record<string, unknown> = {}) => ({
  product_type: 'FINISHED_GOOD', status: 'ACTIVE', hsn_code: '6910', gst_rate: 18, category_id: 'c1', selling_price: 1000,
  standard_cost: null, standard_manufacturing_cost: null, archived_at: null, has_bom: true, ...over,
})

describe('Product Master: Missing Information', () => {
  const cases = [
    product(),
    product({ hsn_code: null }),
    product({ gst_rate: null, category_id: null }),
    product({ selling_price: null }),
    product({ product_type: 'RAW_MATERIAL', selling_price: null, standard_cost: 20 }),
    product({ product_type: 'RAW_MATERIAL', standard_cost: null }),
    product({ product_type: 'COMPONENT', standard_cost: null, standard_manufacturing_cost: 5 }),
    product({ product_type: 'SUBASSEMBLY', standard_cost: null, standard_manufacturing_cost: null, hsn_code: null, gst_rate: null, category_id: null }),
  ]
  it('the list column names a missing field exactly when the card\'s rule counts the product', () => {
    for (const p of cases) {
      assert.equal(missingInfo(p as never).missing.length > 0, matchesConditions(p, MISSING_INFO), JSON.stringify(p))
    }
  })
  it('field names and completion', () => {
    assert.deepEqual(missingInfo(product({ hsn_code: null, selling_price: null }) as never), { missing: ['HSN code', 'Selling price'], done: 2, total: 4, percent: 50 })
    assert.deepEqual(missingInfo(product({ product_type: 'RAW_MATERIAL', standard_cost: null }) as never).missing, ['Standard / manufacturing cost'])
    assert.deepEqual(missingInfo(product() as never), { missing: [], done: 4, total: 4, percent: 100 })
  })
  it('the card counts active products only (product_kpis.incomplete)', () => {
    const conds = METRICS['pm.incomplete'].conditions({ from: '', to: '', today: '', tz: 'UTC' })
    assert.ok(matchesConditions(product({ hsn_code: null }), conds))
    assert.ok(!matchesConditions(product({ hsn_code: null, status: 'INACTIVE' }), conds))
  })
})

describe('Ledger list cards equal the page summary', () => {
  const party = (party_type: string, status: string, receivable: number, payable: number) => ({ party_type, status, receivable, payable, overdue: 0 }) as never
  const rows = [party('CUSTOMER', 'ACTIVE', 100, 0), party('CUSTOMER', 'INACTIVE', 0, 0), party('SUPPLIER', 'ACTIVE', 0, 50), party('BOTH', 'ACTIVE', 10, -5),
    party('BOTH', 'INACTIVE', 0, 0), party('SUPPLIER', 'INACTIVE', 0, 7), party('CUSTOMER', 'ACTIVE', -20, 0)]
  const ctx = { from: '', to: '', today: '', tz: 'UTC' }
  const count = (key: string, segment: string | null = null) => rows.filter((r) => matchesConditions(r, METRICS[key].conditions({ ...ctx, segment }))).length
  it('customers, suppliers and both (active, by type)', () => {
    const s = ledgerSummary(rows)
    assert.equal(count('ledger.page_customer'), s.customers)
    assert.equal(count('ledger.page_supplier'), s.suppliers)
    assert.equal(count('ledger.page_both'), s.both)
  })
  it('parties with a balance, for each ledger scope', () => {
    for (const scope of [null, 'CUSTOMER', 'SUPPLIER'] as const) {
      const scoped = rows.filter((p) => !scope || (p as { party_type: string }).party_type === scope || (p as { party_type: string }).party_type === 'BOTH')
      assert.equal(rows.filter((r) => matchesConditions(r, METRICS['ledger.page_with_balance'].conditions({ ...ctx, segment: scope }))).length, ledgerSummary(scoped).withBalance, String(scope))
    }
  })
})

describe('List-page cards: destinations', () => {
  it('Product Master cards open the Product Master list; other list cards open the records page with their page as the way back', () => {
    for (const k of ['pm.active', 'pm.finished_goods', 'pm.raw_materials', 'pm.components', 'pm.without_bom', 'pm.incomplete', 'pm.inactive']) {
      assert.equal(METRICS[k].target, 'products', k)
      assert.equal(METRICS[k].dashboard, 'product_master')
    }
    assert.equal(METRICS['purchase.status'].dashboard, 'purchase_orders')
    assert.equal(METRICS['grn.reversed'].dashboard, 'goods_receipts')
    assert.equal(METRICS['stock.product_available'].dashboard, 'stock_card')
    assert.equal(DASHBOARDS.stock_card.path, '/inventory/stock/:segment')
  })
  it('the stock card figures are limited to the product of the page', () => {
    const conds = METRICS['stock.product_in_house'].conditions({ from: '', to: '', today: '', tz: 'UTC', segment: 'p1' })
    assert.ok(matchesConditions({ product_id: 'p1', source_type: 'IN_HOUSE', on_hand: 5 }, conds))
    assert.ok(!matchesConditions({ product_id: 'p2', source_type: 'IN_HOUSE', on_hand: 5 }, conds))
    assert.ok(!matchesConditions({ product_id: 'p1', source_type: 'OUTSOURCED', on_hand: 5 }, conds))
  })
})
