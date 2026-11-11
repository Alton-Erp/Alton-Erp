// Actual purchase unit cost at GRN level: variance, cost and payable (exactly as the server stores them),
// validation, the server-support confirmation and the report summaries.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  actualCostConfirmed, PRICE_REASONS, priceProblem, priceReasonText, priceVariance, productTrends, receiptPayable, splitPriceReason, summariseVariance,
  taxLabel, toScaled, varianceBySupplier, type PricedLine, type VarianceRow,
} from '../../src/features/purchasing/grn-price.ts'

type Treatment = 'INTRA_STATE' | 'INTER_STATE' | 'NO_GST' | 'IMPORT'
const r2 = (v: number) => Math.round(v * 100) / 100
/**
 * An order line as purchase_order_save stores it: gross = round(qty × price, 2), discount, taxable, and the
 * tax components from the order's tax treatment (CGST/SGST = half the rate each, IGST = the rate, else 0).
 */
function poLine({ qty = 10, price = 10, pct = 0, fixed = 0, gst = 18, treatment = 'INTRA_STATE' as Treatment, type = 'GOODS' } = {}): PricedLine {
  const gross = r2(qty * price)
  const discount = pct > 0 ? r2((gross * pct) / 100) : fixed
  const taxable = r2(gross - discount)
  const half = treatment === 'INTRA_STATE' ? gst / 2 : 0
  const full = treatment === 'INTER_STATE' ? gst : 0
  const total = r2(taxable + 2 * r2((taxable * half) / 100) + r2((taxable * full) / 100))
  return { line_type: type, ordered_quantity: qty, unit_price: price, discount_percent: pct || null, discount_amount: discount, taxable_value: taxable, line_total: total,
    cgst_rate: half, sgst_rate: half, igst_rate: full }
}

describe('GRN price variance', () => {
  it('difference = actual − PO and variance % = difference / PO × 100', () => {
    const v = priceVariance(12, '15')
    assert.deepEqual([v.difference, v.percent, v.direction, v.changed], [3, 25, 'INCREASE', true])
    assert.equal(priceVariance(15, '17').percent, 13.33)
    assert.equal(priceVariance(20, '18').direction, 'DECREASE')
  })
  it('blank or equal to the PO price is "no change" (no reason needed)', () => {
    for (const x of ['', '12', '12.0000']) {
      const v = priceVariance(12, x)
      assert.equal(v.changed, false, x)
      assert.equal(priceProblem(12, x, '', ''), null)
    }
  })
  it('only non-negative numbers with up to 4 decimals, at most 999,999,999,999; zero refused when the PO price is above zero', () => {
    for (const bad of ['-1', 'abc', '1.23456', '1,5', '1e5']) assert.ok(priceVariance(12, bad).error, bad)
    assert.match(priceVariance(12, '1000000000000').error ?? '', /too large/)
    assert.equal(priceVariance(12, '999999999999').error, null)
    assert.ok(priceVariance(12, '0').error)
    assert.equal(priceVariance(0, '0').error, null)
  })
  it('a changed price needs a reason; Other needs a description; services keep the PO price', () => {
    assert.match(priceProblem(12, '15', '', '') ?? '', /reason/)
    assert.match(priceProblem(12, '15', 'Other', '') ?? '', /Other/)
    assert.equal(priceProblem(12, '15', 'Supplier price revision', ''), null)
    assert.equal(priceProblem(12, '15', 'Other', 'freight surcharge'), null)
    assert.match(priceProblem(500, '600', 'Other', 'extra visit', poLine({ type: 'SERVICE', price: 500, qty: 1 }), '1') ?? '', /goods lines/)
    assert.deepEqual([...PRICE_REASONS], ['Supplier price revision', 'Market price increase', 'Negotiated price change', 'PO price entered incorrectly', 'Other'])
  })
  it('large changes (≥ 20% either way, or from a zero PO price) are flagged', () => {
    assert.equal(priceVariance(100, '119').large, false)
    assert.equal(priceVariance(100, '120').large, true)
    assert.equal(priceVariance(100, '75').large, true)
    assert.equal(priceVariance(0, '5').large, true)
  })
  it('reason text round-trips for corrections', () => {
    for (const [r, m] of [['Market price increase', ''], ['Negotiated price change', 'call with supplier'], ['Other', 'freight']]) {
      assert.deepEqual(splitPriceReason(priceReasonText(r, m)), { reason: r, remark: m })
    }
    assert.equal(priceReasonText('Other', ''), null)
    assert.deepEqual(splitPriceReason('free text'), { reason: 'Other', remark: 'free text' })
  })
})

describe('Supplier payable preview = server (purchase_receipt_post, numeric rounding)', () => {
  it('spec case: PO ₹10, actual ₹15, 10 accepted, 18% → taxable ₹150, GST ₹27, payable ₹177', () => {
    const p = receiptPayable(poLine(), 15, 10)
    assert.deepEqual([p.cost, p.taxable, p.cgst, p.sgst, p.igst, p.payable], [15, 150, 13.5, 13.5, 0, 177])
  })
  it('every tax treatment (the database results of tests/db/grn-actual-cost-check.mjs)', () => {
    const cases: [Treatment, number, number, number, number][] = [
      ['INTRA_STATE', 7, 10.07, 10.09, 83.35], ['INTER_STATE', 7, 10.07, 10.09, 83.34], ['NO_GST', 10, 10, 15, 150], ['IMPORT', 10, 10, 15, 150],
      ['INTRA_STATE', 3, 10, 10.05, 35.57], ['INTRA_STATE', 1, 1, 1.07, 1.27], ['INTRA_STATE', 11, 12.5, 12.55, 162.89], ['INTRA_STATE', 3, 33.33, 33.35, 118.05],
    ]
    for (const [treatment, qty, price, actual, payable] of cases) {
      assert.equal(receiptPayable(poLine({ qty, price, treatment }), actual, qty).payable, payable, `${treatment} ${qty} × ${price} → ${actual}`)
    }
  })
  it('CGST and SGST are rounded separately (₹0.01 more than rounding the total once)', () => {
    const p = receiptPayable(poLine({ qty: 7, price: 10.07 }), 10.09, 7)
    assert.deepEqual([p.taxable, p.cgst, p.sgst, p.payable], [70.63, 6.36, 6.36, 83.35])
    assert.equal(r2(70.63 * 1.18), 83.34)
  })
  it('halves round away from zero like PostgreSQL (no binary floating-point drift)', () => {
    // taxable 11.50 × 9% = 1.035 → 1.04 in PostgreSQL (checked in tests/db/grn-actual-cost-check.mjs);
    // naive floating point gives 1.03 because 1.035 × 100 = 103.49999999999999.
    const p = receiptPayable(poLine({ qty: 1, price: 11 }), 11.5, 1)
    assert.deepEqual([p.taxable, p.cgst, p.sgst, p.payable], [11.5, 1.04, 1.04, 13.58])
    assert.equal(Math.round(((11.5 * 9) / 100) * 100) / 100, 1.03)
    const half = receiptPayable(poLine({ qty: 1, price: 0.4 }), 0.5, 1)
    assert.deepEqual([half.cgst, half.payable], [0.05, 0.6])
  })
  it('NO_GST and IMPORT orders get no GST even though the product has an 18% rate', () => {
    for (const treatment of ['NO_GST', 'IMPORT'] as const) {
      const p = receiptPayable(poLine({ treatment }), 15, 10)
      assert.deepEqual([p.cgst, p.sgst, p.igst, p.payable], [0, 0, 0, 150])
      assert.equal(taxLabel(poLine({ treatment })), 'No GST')
    }
    assert.equal(taxLabel(poLine({ treatment: 'INTER_STATE' })), 'IGST 18%')
    assert.equal(taxLabel(poLine()), 'CGST 9% + SGST 9%')
  })
  it('lower price, percentage and fixed discounts, partial acceptance', () => {
    assert.equal(receiptPayable(poLine(), 8, 10).payable, 94.4)
    const pct = receiptPayable(poLine({ price: 100, pct: 10 }), 120, 10)
    assert.deepEqual([pct.cost, pct.poCost, pct.payable], [108, 90, 1274.4])
    const fixed = receiptPayable(poLine({ price: 100, fixed: 50 }), 110, 10)
    assert.deepEqual([fixed.cost, fixed.poCost, fixed.payable], [105, 95, 1239])
    assert.equal(receiptPayable(poLine(), 15, 8).payable, 141.6)
  })
  it('unchanged price: the accepted share of the order line total (the existing calculation)', () => {
    const line = poLine({ qty: 7, price: 10.07 })
    assert.equal(line.line_total, 83.17)
    const p = receiptPayable(line, 10.07, 3)
    assert.equal(p.changed, false)
    assert.equal(p.payable, 35.64) // round(3 × 83.17 / 7, 2)
    assert.equal(receiptPayable(poLine(), 10, 10).payable, 118)
  })
  it('limits: cost below zero, above what stock can be valued at, or a line value too large', () => {
    assert.match(receiptPayable(poLine({ price: 100, fixed: 50 }), 4, 1).error ?? '', /lower than the discount/)
    assert.match(receiptPayable(poLine(), 10000000000, 1).error ?? '', /stock can be valued/)
    assert.match(receiptPayable(poLine({ qty: 1000000 }), 999999999, 1000000).error ?? '', /too large/)
    assert.match(priceProblem(10, '10000000000', 'Other', 'test', poLine(), '1') ?? '', /stock can be valued/)
  })
  it('exact decimal parsing', () => {
    assert.equal(toScaled('10.09', 4), 100900n)
    assert.equal(toScaled(1.005, 3), 1005n)
    assert.equal(toScaled('1.23456', 4), 12346n)
    assert.equal(toScaled('abc', 2), null)
  })
})

describe('Server support confirmation', () => {
  it('only an explicit actual_cost_supported = true confirms the actual price was recorded', () => {
    assert.equal(actualCostConfirmed({ actual_cost_supported: true }), true)
    for (const r of [{}, { actual_cost_supported: 'true' }, { actual_cost_supported: false }, null, undefined]) assert.equal(actualCostConfirmed(r as never), false)
  })
})

describe('Variance report summaries', () => {
  const row = (o: Partial<VarianceRow>): VarianceRow => ({ receipt_status: 'POSTED', receipt_date: '2026-11-01', supplier_id: 's1', supplier_name: 'Clay Co', product_id: 'p1', sku: 'X',
    description: 'Clay', accepted_quantity: 10, price_recorded: true, po_unit_price: 10, actual_unit_price: 10, price_difference: 0, accepted_value: 100, accepted_value_at_po: 100, ...o })
  const rows = [
    row({ receipt_date: '2026-11-01' }),
    row({ receipt_date: '2026-11-02', po_unit_price: 12, actual_unit_price: 15, price_difference: 3, accepted_value: 150, accepted_value_at_po: 120 }),
    row({ receipt_date: '2026-11-03', po_unit_price: 15, actual_unit_price: 17, price_difference: 2, accepted_value: 170, accepted_value_at_po: 150 }),
    row({ receipt_date: '2026-11-04', supplier_id: 's2', supplier_name: 'Glaze Ltd', product_id: 'p2', sku: 'Y', po_unit_price: 20, actual_unit_price: 18, price_difference: -2, accepted_value: 90, accepted_value_at_po: 100, accepted_quantity: 5 }),
    row({ receipt_status: 'REVERSED', receipt_date: '2026-11-05', po_unit_price: 10, actual_unit_price: 99, price_difference: 89, accepted_value: 990, accepted_value_at_po: 100 }),
    // Posted before prices were recorded: no snapshot, never counted as a price (change).
    row({ receipt_date: '2026-10-01', price_recorded: false, po_unit_price: null, actual_unit_price: null, price_difference: null, accepted_value: null, accepted_value_at_po: null }),
  ]
  it('totals exclude reversed GRNs and lines without recorded prices', () => {
    assert.deepEqual(summariseVariance(rows), { lines: 4, notRecorded: 1, changed: 3, increases: 2, decreases: 1, totalVariance: 40, valueAtPo: 470, valueActual: 510 })
  })
  it('supplier-wise increases, largest first', () => {
    assert.deepEqual(varianceBySupplier(rows).map((x) => [x.supplier, x.lines, x.increases, x.decreases, x.variance]), [['Clay Co', 3, 2, 0, 50], ['Glaze Ltd', 1, 0, 1, -10]])
  })
  it('product-wise trend: first → latest recorded actual price', () => {
    const t = productTrends(rows).find((x) => x.productId === 'p1')!
    assert.deepEqual([t.firstPrice, t.lastPrice, t.change, t.percent, t.receipts], [10, 17, 7, 70, 3])
  })
})

describe('Screen wiring', () => {
  const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
  const dialog = readFileSync(path.join(src, 'features', 'purchasing', 'receipt-dialog.tsx'), 'utf8')
  const detail = readFileSync(path.join(src, 'pages', 'purchasing', 'goods-receipt-detail-page.tsx'), 'utf8')
  it('the dialog sends the actual price and reason through the existing receipt functions', () => {
    assert.match(dialog, /actual_unit_price: r\.actual\.trim\(\) \|\| null/)
    assert.match(dialog, /price_variance_reason: priceVariance\(r\.line\.unit_price, r\.actual\)\.changed \? priceReasonText/)
    assert.match(dialog, /postGoodsReceipt\(po\.id, head, payload, request\.key\)/)
    assert.match(dialog, /Actual Purchase Unit Cost \(₹\)/)
  })
  it('a changed price is posted only after the server support check, and success needs actual_cost_supported', () => {
    const post = dialog.slice(dialog.indexOf('const submit = async'))
    assert.ok(post.indexOf('checkActualCostSupport()') < post.indexOf('postGoodsReceipt('), 'support is checked before posting')
    assert.match(post, /if \(priceChanged && !actualCostConfirmed\(res\)\) \{ notConfirmed\(res\.receipt_number\); return \}\n\s+request\.renew\(\)\n\s+onPosted\(/)
    assert.equal((post.match(/actualCostConfirmed\(res\)/g) ?? []).length, 2, 'both new receipts and corrections are confirmed')
  })
  it('the payable preview uses the exact server calculation', () => {
    assert.match(dialog, /receiptPayable\(r\.line,/)
    assert.doesNotMatch(dialog, /gst_rate/)
  })
  it('a correction starts from the original GRN\'s actual price', () => {
    assert.match(dialog, /g\?\.actual_unit_price \?\? l\.unit_price \?\? 0/)
  })
  it('the GRN detail never shows the current (amended) PO price as the price at receipt', () => {
    assert.doesNotMatch(detail, /po_unit_price \?\? poPrice|pl\?\.unit_price/)
    assert.match(detail, /Not recorded/)
  })
})
