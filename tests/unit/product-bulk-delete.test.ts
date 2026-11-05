// Bulk delete of never-used products: wording and the failed-record report (no database).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CONFIRM_PHRASE,
  blockerText,
  confirmMessage,
  duplicateText,
  failedRecordReport,
  type BulkDeleteResult,
} from '../../src/features/products/product-bulk-delete.ts'

const blocked = (sku: string, over: Partial<BulkDeleteResult['blocked'][number]> = {}): BulkDeleteResult['blocked'][number] => ({
  id: `id-${sku}`, sku, product_name: `Name ${sku}`, category: null, standard_manufacturing_cost: null, mrp: null, hsn_code: null, gst_rate: null,
  status: 'ACTIVE', archived: false, deletable: false, has_stock: false, can_archive: true, archived_now: false, archive_error: null,
  blockers: [{ label: 'Sales invoices', table: 'sales_invoice_lines', count: 2 }], ...over,
})

describe('bulk delete wording', () => {
  it('uses the exact confirmation phrase and message', () => {
    assert.equal(CONFIRM_PHRASE, 'DELETE PRODUCTS')
    assert.equal(confirmMessage(12),
      'You are about to permanently delete 12 selected products. Products linked to transactions will be protected. This operation cannot be undone.')
    assert.ok(confirmMessage(1).includes('1 selected product.'))
  })

  it('explains exactly why a product is protected', () => {
    assert.equal(blockerText([]), '')
    assert.equal(blockerText([{ label: 'Sales invoices', table: 'sales_invoice_lines', count: 2 }]),
      'Linked to Sales invoices (2). Products with transactions or history are never deleted.')
    assert.ok(blockerText([
      { label: 'Stock ledger entries', table: 'inventory_transactions', count: 4 },
      { label: 'Stock balances', table: 'inventory_balances', count: 1 },
      { label: 'Sales orders', table: 'sales_order_lines', count: 3 },
    ]).startsWith('Linked to Stock ledger entries (4), Stock balances (1) and Sales orders (3).'))
  })

  it('names the matching products of a duplicate indicator', () => {
    assert.equal(duplicateText({ product_id: 'a', kind: 'name', matches: 1, match_skus: ['PB-2'] }), 'Same name as PB-2')
    assert.equal(duplicateText({ product_id: 'a', kind: 'model', matches: 6, match_skus: ['A', 'B', 'C', 'D', 'E'] }), 'Same model no. as A, B, C (+3)')
    assert.equal(duplicateText({ product_id: 'a', kind: 'description', matches: 2, match_skus: ['X', 'Y'] }), 'Similar description as X, Y')
  })
})

describe('failed-record report', () => {
  it('lists every selected product that was not deleted, with its reason', () => {
    const result: BulkDeleteResult = {
      status: 'COMPLETED', error: null,
      deleted: [{ id: 'd1', sku: 'OK-1', product_name: 'Deleted' }],
      blocked: [blocked('INV-1'), blocked('ARC-1', { archived_now: true }), blocked('STK-1', { archive_error: 'A product that still has stock cannot be archived.' })],
      failed: [],
      not_found: ['other-co-id'],
    }
    const rows = failedRecordReport(result, new Map([['other-co-id', { sku: 'B-1', product_name: 'Theirs' }]]))
    assert.deepEqual(rows[0], ['SKU', 'Product Name', 'Outcome', 'Reason'])
    assert.equal(rows.length, 5, 'the deleted product is not in the report')
    assert.deepEqual(rows[1].slice(0, 3), ['INV-1', 'Name INV-1', 'Protected (not deleted)'])
    assert.ok(rows[1][3].includes('Sales invoices (2)'))
    assert.equal(rows[2][2], 'Archived instead (not deleted)')
    assert.ok(rows[3][3].includes('Not archived: A product that still has stock'))
    assert.deepEqual(rows[4].slice(0, 3), ['B-1', 'Theirs', 'Failed'])
  })

  it('a rolled-back attempt lists every product as failed', () => {
    const rows = failedRecordReport({ status: 'FAILED', error: 'boom', deleted: [], blocked: [], not_found: [],
      failed: [{ id: '1', sku: 'A', product_name: 'a', reason: 'Not deleted: the operation failed and was rolled back (boom).' }] }, new Map())
    assert.deepEqual(rows[1], ['A', 'a', 'Failed', 'Not deleted: the operation failed and was rolled back (boom).'])
  })
})
