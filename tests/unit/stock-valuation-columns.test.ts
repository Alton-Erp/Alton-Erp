// Total Stock drill-down: valuation columns, "Not Valued" text and the metric's source.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { COLUMNS } from '../../src/features/drilldown/drill-columns.ts'
import { METRICS, SOURCES } from '../../src/features/drilldown/drill-registry.ts'

describe('Total Stock valuation columns', () => {
  const cols = COLUMNS.product_stock_value
  const col = (k: string) => cols.find((c) => c.key === k)!

  it('lists the requested columns in order, with both value columns sortable and in the Columns selector', () => {
    assert.deepEqual(cols.filter((c) => c.visible !== false).map((c) => c.label),
      ['SKU', 'Product', 'Category', 'Unit', 'On hand', 'Reserved', 'Available', 'Unit Cost (₹)', 'Total Stock Value (₹)', 'Stock status'])
    for (const k of ['unit_cost', 'stock_value', 'sku']) assert.ok(col(k).sortable !== false && !col(k).get, `${k} not sortable on the server`)
    assert.equal(col('unit_cost').kind, 'money')
    assert.equal(col('stock_value').kind, 'money')
  })

  it('shows "Not Valued" for stock without a cost, never ₹0, and nothing for no stock', () => {
    assert.equal(col('unit_cost').empty!({ on_hand: 7, unit_cost: null }), 'Not Valued')
    assert.equal(col('stock_value').empty!({ on_hand: 7, stock_value: null }), 'Not Valued')
    assert.equal(col('stock_value').empty!({ on_hand: 0, stock_value: null }), null)
    assert.equal(col('stock_value').note!({ valuation_status: 'PARTIAL' }), 'part valued')
    assert.equal(col('stock_value').note!({ valuation_status: 'VALUED' }), null)
  })

  it('the Total Stock figure reads the valued view with the same rule and shows the summary cards', () => {
    const m = METRICS['inventory.on_hand']
    assert.equal(m.source, 'product_stock_value')
    assert.equal(m.summary, 'stock_value')
    const src = SOURCES.product_stock_value
    assert.ok(src.kind === 'view' && src.relation === 'inventory_product_stock_value')
    assert.deepEqual(src.search, SOURCES.product_stock.search)
    // Other stock figures keep the plain view (no valuation cost for them).
    assert.equal(METRICS['inventory.in_house'].source, 'product_stock')
  })
})
