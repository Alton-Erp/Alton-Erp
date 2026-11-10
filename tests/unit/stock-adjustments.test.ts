// Stock Adjustments (restored): screen rules and navigation (no database).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { adjustmentDifference, adjustmentTotals, EMPTY_ADJUSTMENT_FILTERS, reasonCategory } from '../../src/features/inventory/adjustments-model.ts'

describe('Stock adjustments: rules', () => {
  it('adjustment = physical count − system stock', () => {
    assert.equal(adjustmentDifference(50, 45), -5)
    assert.equal(adjustmentDifference(50, 60), 10)
    assert.equal(adjustmentDifference(2.5, 2.125), -0.375)
    assert.equal(adjustmentDifference(null, 4), null)
    assert.equal(adjustmentDifference(4, null), null)
  })
  it('configured reasons pre-select a category (default ERP Settings reasons)', () => {
    assert.equal(reasonCategory('Damaged'), 'DAMAGE')
    assert.equal(reasonCategory('Count correction'), 'COUNT_VARIANCE')
    assert.equal(reasonCategory('Expired'), 'EXPIRED')
    assert.equal(reasonCategory('Sample issued'), 'OTHER')
    assert.equal(reasonCategory('Found in stock'), 'FOUND')
    assert.equal(reasonCategory('Other'), 'OTHER')
    assert.equal(reasonCategory('Lost in transit'), 'LOSS')
    assert.equal(reasonCategory('Stolen'), 'THEFT')
    assert.equal(reasonCategory('Data entry mistake'), 'DATA_CORRECTION')
    assert.equal(reasonCategory(null), 'OTHER')
  })
  it('report totals: posted increases / decreases, pending approvals and completed', () => {
    const rows = [
      { status: 'POSTED', adjustment_type: 'QUANTITY', difference: -5 },
      { status: 'POSTED', adjustment_type: 'QUANTITY', difference: '15' },
      { status: 'POSTED', adjustment_type: 'QUANTITY', difference: 3 },
      { status: 'POSTED', adjustment_type: 'SOURCE_CORRECTION', difference: null },
      { status: 'PENDING_APPROVAL', adjustment_type: 'QUANTITY', difference: -2 },
      { status: 'REJECTED', adjustment_type: 'QUANTITY', difference: -9 },
      { status: 'DRAFT', adjustment_type: 'QUANTITY', difference: 4 },
    ]
    assert.deepEqual(adjustmentTotals(rows), { positive: 2, negative: 1, pending: 1, completed: 4 })
    assert.deepEqual(adjustmentTotals([]), { positive: 0, negative: 0, pending: 0, completed: 0 })
    assert.deepEqual(Object.keys(EMPTY_ADJUSTMENT_FILTERS).sort(), ['from', 'productId', 'reason', 'status', 'to', 'type', 'warehouseId'])
  })
})

describe('Stock adjustments: navigation and wiring', () => {
  const nav = readFileSync(new URL('../../src/config/navigation.ts', import.meta.url), 'utf8')
  const routes = readFileSync(new URL('../../src/routes.ts', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../../src/pages/inventory/adjustments-page.tsx', import.meta.url), 'utf8')
  const service = readFileSync(new URL('../../src/services/inventory.ts', import.meta.url), 'utf8')
  it('Stock Adjustments is in the Inventory group of the sidebar, readable with inventory.read', () => {
    assert.match(nav, /key: 'inventory-adjustments',\s+title: 'Stock Adjustments',\s+path: '\/inventory\/adjustments',[\s\S]{0,80}group: 'inventory'/)
    assert.match(nav, /'inventory-adjustments': 'inventory\.read'/)
    assert.match(routes, /'inventory-adjustments': lazy\(\(\) => import\('@\/pages\/inventory\/adjustments-page'\)\)/)
  })
  it('the page never writes balances itself: it records, submits and reviews through the database functions', () => {
    assert.ok(!/from\('inventory_balances'\)\.(update|insert|upsert|delete)|from\('inventory_adjustments'\)\.(update|insert|upsert|delete)/.test(page + service))
    assert.match(service, /'inventory_create_adjustment_v2'/)
    assert.match(service, /'inventory_post_adjustment_v2'/)
    assert.match(service, /'inventory_review_adjustment'/)
    assert.match(page, /RecordDocuments entityType="STOCK_ADJUSTMENT"/)
  })
})
