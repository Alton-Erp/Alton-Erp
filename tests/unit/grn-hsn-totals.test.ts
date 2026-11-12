// GRN totals (quantity per unit, taxable, CGST / SGST / IGST, total incl. GST) and the HSN field.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { directLineAmounts, grnTotals, HSN_PATTERN, isInterState, receiptPayable, type LineAmounts, type PricedLine } from '../../src/features/purchasing/grn-price.ts'

const r2 = (v: number) => Math.round(v * 100) / 100
const poLine = (qty: number, price: number, gst: number, inter = false): PricedLine => {
  const taxable = r2(qty * price)
  const half = inter ? 0 : gst / 2
  const full = inter ? gst : 0
  return { line_type: 'GOODS', ordered_quantity: qty, unit_price: price, discount_percent: null, discount_amount: 0, taxable_value: taxable,
    line_total: r2(taxable + 2 * r2((taxable * half) / 100) + r2((taxable * full) / 100)), cgst_rate: half, sgst_rate: half, igst_rate: full }
}
const fromPayable = (p: ReturnType<typeof receiptPayable>): LineAmounts => ({ taxable: p.taxable, cgst: p.cgst, sgst: p.sgst, igst: p.igst, total: p.payable })

describe('Receipt without a PO: amounts = the existing payable method', () => {
  it('payable = round(accepted × cost × (1 + GST %), 2); GST split for display only', () => {
    assert.deepEqual(directLineAmounts(40, 12, 2.5, false), { taxable: 100, cgst: 6, sgst: 6, igst: 0, total: 112 })
    assert.deepEqual(directLineAmounts(40, 12, 2.5, true), { taxable: 100, cgst: 0, sgst: 0, igst: 12, total: 112 })
  })
  it('odd amounts: the split always adds up to the stored payable', () => {
    const a = directLineAmounts('10.07', 18, 7, false)!
    assert.equal(a.total, r2(7 * 10.07 * 1.18))
    assert.equal(r2(a.taxable + a.cgst + a.sgst), a.total)
    assert.equal(a.taxable, 70.49)
  })
  it('no cost: no amounts (the line is not valued)', () => {
    assert.equal(directLineAmounts(null, 18, 1, false), null)
  })
})

describe('GRN totals', () => {
  it('multiple lines with different GST rates; CGST + SGST and IGST', () => {
    const a = fromPayable(receiptPayable(poLine(10, 100, 18), 100, 10)) // 1000 + 90 + 90
    const b = fromPayable(receiptPayable(poLine(4, 50, 12), 50, 4)) // 200 + 12 + 12
    const c = fromPayable(receiptPayable(poLine(2, 25, 5, true), 25, 2)) // 50 + 2.50 IGST
    const t = grnTotals([{ amounts: a, unit: 'PCS', accepted: 10, goods: true }, { amounts: b, unit: 'PCS', accepted: 4, goods: true }, { amounts: c, unit: 'KG', accepted: 2, goods: true }])
    assert.deepEqual([t.taxable, t.cgst, t.sgst, t.igst, t.gst, t.total], [1250, 102, 102, 2.5, 206.5, 1456.5])
  })
  it('quantities per unit, never added together; services and empty lines excluded', () => {
    const t = grnTotals([
      { amounts: null, unit: 'PCS', accepted: 10, goods: true }, { amounts: null, unit: 'PCS', accepted: '2.5', goods: true },
      { amounts: null, unit: 'KG', accepted: '1.25', goods: true }, { amounts: null, unit: 'NOS', accepted: 3, goods: false },
      { amounts: null, unit: 'BOX', accepted: 0, goods: true },
    ])
    assert.deepEqual(t.quantities, [{ unit: 'KG', quantity: 1.25 }, { unit: 'PCS', quantity: 12.5 }])
    assert.equal(t.unvalued, 3)
  })
  it('a changed actual price: the totals use the actual cost (₹15 × 10 + 18 % = ₹177)', () => {
    const t = grnTotals([{ amounts: fromPayable(receiptPayable(poLine(10, 10, 18), 15, 10)), unit: 'PCS', accepted: 10, goods: true }])
    assert.deepEqual([t.taxable, t.cgst, t.sgst, t.total], [150, 13.5, 13.5, 177])
  })
})

describe('HSN and tax state', () => {
  it('HSN: 4, 6 or 8 digits (the Product Master rule)', () => {
    for (const ok of ['6910', '691000', '69100000']) assert.ok(HSN_PATTERN.test(ok), ok)
    for (const bad of ['691', '69100', '6910000', '691000000', '69A0', '']) assert.ok(!HSN_PATTERN.test(bad), bad)
  })
  it('inter-state only when both states are known and differ', () => {
    assert.equal(isInterState('27AABCU9603R1ZX', { gstin: '29AABCB1234B1Z5' }), true)
    assert.equal(isInterState('27AABCU9603R1ZX', { gstin: '27AABCA1234A1Z5' }), false)
    assert.equal(isInterState('27AABCU9603R1ZX', { state_code: '29' }), true)
    assert.equal(isInterState('27AABCU9603R1ZX', null), false)
    assert.equal(isInterState(null, { gstin: '29AABCB1234B1Z5' }), false)
  })
})

describe('Wiring', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const read = (p: string) => readFileSync(path.join(src, p), 'utf8')
  it('both receipt screens show the live totals and send the HSN only when changed', () => {
    for (const f of ['features/purchasing/receipt-dialog.tsx', 'features/purchasing/direct-receipt-dialog.tsx']) {
      const s = read(f)
      assert.match(s, /<GrnSummary totals=\{totals\}/, f)
      assert.match(s, /hsn_code: sentHsn\(r\)/, f)
      assert.match(s, /HSN_PATTERN\.test\(hsn\)/, f)
      assert.match(s, /has\('products\.update'\)/, f)
    }
  })
  it('the GRN detail and print show the HSN snapshot of each line', () => {
    assert.match(read('pages/purchasing/goods-receipt-detail-page.tsx'), /l\.hsn_code/)
    assert.match(read('pages/purchasing/grn-print-page.tsx'), /l\.hsn_code/)
  })
})
