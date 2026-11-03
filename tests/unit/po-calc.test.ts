import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { calcLine, calcTotals, roundDiv, taxTreatmentFor, toScaled } from '../../src/features/purchasing/po-calc.ts'

// The figures below are the same ones asserted against the database in
// supabase/tests/purchase_orders_verification.sql, so the browser preview and
// the stored order are known to agree.
describe('decimal helpers', () => {
  it('parses decimals exactly and rounds half away from zero', () => {
    assert.equal(toScaled('333.3333', 4), 3333333n)
    assert.equal(toScaled(2.5, 3), 2500n)
    assert.equal(toScaled('0.125', 2), 13n)
    assert.equal(toScaled('abc', 2), null)
    assert.equal(roundDiv(5n, 10n), 1n)
    assert.equal(roundDiv(-5n, 10n), -1n)
    assert.equal(roundDiv(4n, 10n), 0n)
  })
})

describe('purchase order GST calculation (same results as the database)', () => {
  const lines = [
    { line_type: 'GOODS' as const, quantity: 10, unit_price: 1000, discount_percent: 10, gst_rate: 18 },
    { line_type: 'GOODS' as const, quantity: '2.5', unit_price: '333.3333', discount_amount: 10.5, gst_rate: 5 },
    { line_type: 'CHARGE' as const, quantity: 1, unit_price: 500, gst_rate: 18 },
  ]

  it('intra-state: CGST + SGST, never IGST', () => {
    const basin = calcLine(lines[0], 'INTRA_STATE')
    assert.deepEqual([basin.gross, basin.discount, basin.taxable, basin.cgst, basin.sgst, basin.igst, basin.total], [10000, 1000, 9000, 810, 810, 0, 10620])
    const clay = calcLine(lines[1], 'INTRA_STATE')
    assert.deepEqual([clay.gross, clay.taxable, clay.cgst, clay.total], [833.33, 822.83, 20.57, 863.97])
    const { totals } = calcTotals(lines, 'INTRA_STATE')
    assert.deepEqual(totals, { gross: 11333.33, discount: 1010.5, taxable: 10322.83, otherCharges: 500, cgst: 875.57, sgst: 875.57, igst: 0, roundOff: 0, grand: 12073.97 })
  })

  it('inter-state: IGST only, with optional round-off', () => {
    const l = [{ line_type: 'GOODS' as const, quantity: 3, unit_price: 999.99, gst_rate: 12 }]
    const { lines: c, totals } = calcTotals(l, 'INTER_STATE', true)
    assert.deepEqual([c[0].gross, c[0].igst, c[0].cgst], [2999.97, 360, 0])
    assert.equal(totals.roundOff, 0.03)
    assert.equal(totals.grand, 3360)
  })

  it('0.25% splits into 0.125% CGST and SGST', () => {
    const c = calcLine({ line_type: 'GOODS', quantity: 1, unit_price: 1000, gst_rate: 0.25 }, 'INTRA_STATE')
    assert.equal(c.cgstRate, 0.125)
    assert.deepEqual([c.cgst, c.sgst, c.total], [1.25, 1.25, 1002.5])
  })

  it('no tax for unregistered / overseas suppliers or an unresolved treatment; missing rate is not invented', () => {
    for (const t of ['NO_GST', 'IMPORT', 'UNRESOLVED'] as const) assert.equal(calcLine(lines[0], t).total, 9000)
    assert.equal(calcLine({ ...lines[0], gst_rate: null }, 'INTRA_STATE').cgst, 0)
  })

  it('caps the discount at the line amount and treats a missing price as zero', () => {
    assert.equal(calcLine({ line_type: 'GOODS', quantity: 1, unit_price: 100, discount_amount: 500, gst_rate: 18 }, 'INTER_STATE').taxable, 0)
    assert.equal(calcLine({ line_type: 'SERVICE', quantity: 1, unit_price: null, gst_rate: 18 }, 'INTRA_STATE').total, 0)
  })

  it('derives the tax treatment from GSTIN states', () => {
    const company = '27AAACA1234A1Z5'
    assert.equal(taxTreatmentFor({ gstin: '27AAPFU0939F1ZV', country: 'India' }, company), 'INTRA_STATE')
    assert.equal(taxTreatmentFor({ gstin: '24ABCDE1234F1Z5', country: 'India' }, company), 'INTER_STATE')
    assert.equal(taxTreatmentFor({ gstin: null, country: 'India' }, company), 'NO_GST')
    assert.equal(taxTreatmentFor({ gstin: null, country: 'Germany' }, company), 'IMPORT')
    assert.equal(taxTreatmentFor({ gstin: '24ABCDE1234F1Z5', country: 'India' }, null), 'UNRESOLVED')
  })
})
