// Stock register (by product): indicators, sorting and the Excel layouts. No database
// (formulas are verified in supabase/tests/stock_reliability_verification.sql).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { indicators, reconciliationSheet, sortPositions, stockPositionSheet, type PositionLike } from '../../src/features/inventory/stock-position-model.ts'

const row = (over: Partial<PositionLike>): PositionLike => ({
  sku: 'A', product_name: 'Alpha', category_name: null, unit: 'PCS', on_hand: 10, reserved: 2, available: 8, pending_po_quantity: 0, open_po_count: 0,
  pending_production_quantity: 0, expected_incoming_quantity: 0, bom_required_quantity: 0, bom_shortage_quantity: 0, ledger_on_hand: 10,
  discrepancy: false, low_stock: false, stock_status: 'HEALTHY', ...over,
})

describe('stock register indicators', () => {
  it('flags low stock, BOM shortage, pending PO and discrepancies independently', () => {
    assert.deepEqual(indicators(row({})), [])
    assert.deepEqual(indicators(row({ low_stock: true, bom_shortage_quantity: 5, pending_po_quantity: 3, discrepancy: true })), ['LOW', 'SHORTAGE', 'PENDING_PO', 'DISCREPANCY'])
    assert.deepEqual(indicators(row({ bom_required_quantity: 5, bom_shortage_quantity: 0 })), [], 'a requirement covered by available stock is not a shortage')
  })
})

describe('stock register sorting', () => {
  it('sorts numbers numerically and text alphabetically, ties by SKU', () => {
    const rows = [row({ sku: 'B', available: 10 }), row({ sku: 'A', available: 2 }), row({ sku: 'C', available: 10 })]
    assert.deepEqual(sortPositions(rows, 'available', true).map((r) => r.sku), ['A', 'B', 'C'])
    assert.deepEqual(sortPositions(rows, 'available', false).map((r) => r.sku), ['B', 'C', 'A'])
    assert.deepEqual(sortPositions(rows, 'sku', false).map((r) => r.sku), ['C', 'B', 'A'])
  })
})

describe('stock register Excel', () => {
  it('exports every quantity column as numbers', () => {
    const out = stockPositionSheet([row({ pending_po_quantity: 30, expected_incoming_quantity: 40, pending_production_quantity: 10, bom_required_quantity: 5.5, bom_shortage_quantity: 5.5, discrepancy: true })])
    const col = (h: string) => out[1][out[0].indexOf(h)]
    for (const h of ['On hand', 'Reserved', 'Available', 'Pending PO', 'Expected incoming', 'BOM required', 'BOM shortage']) assert.ok(out[0].includes(h), h)
    assert.deepEqual([col('Pending PO'), col('Expected incoming'), col('BOM shortage'), col('Discrepancy')], [30, 40, 5.5, 'Yes'])
  })
  it('reconciliation export names each problem in words', () => {
    const out = reconciliationSheet([{ sku: 'A', product_name: 'Alpha', unit: 'PCS', warehouse_code: 'W1', location_code: 'GENERAL', batch_number: null, on_hand: 11,
      ledger_on_hand: 10, difference: 1, reserved: 0, active_reservations: 0, problems: ['BALANCE_DIFFERS_FROM_LEDGER', 'OVER_RESERVED'] }])
    assert.equal(out[1][out[0].indexOf('Difference')], 1)
    assert.equal(out[1][out[0].indexOf('Problems')], 'Balance differs from the stock ledger; Reserved more than on hand')
  })
})
