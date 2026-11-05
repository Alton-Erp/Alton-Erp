import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatCost, gstText, hsnText } from '../../src/features/products/product-list-format.ts'

describe('Product Master columns: COST, HSN, GST', () => {
  it('COST is the standard manufacturing cost in rupees with two decimals; "—" when not entered', () => {
    assert.equal(formatCost(1250), '₹1,250.00')
    assert.equal(formatCost('99.5'), '₹99.50')
    assert.equal(formatCost(123456.789), '₹1,23,456.79')
    assert.equal(formatCost(0), '₹0.00')
    assert.equal(formatCost(null), '—')
    assert.equal(formatCost(undefined), '—')
    assert.equal(formatCost(''), '—')
  })
  it('HSN is shown exactly as stored (leading zeros kept); null = missing', () => {
    assert.equal(hsnText('0402'), '0402')
    assert.equal(hsnText('69101000'), '69101000')
    assert.equal(hsnText(null), null)
    assert.equal(hsnText(''), null)
  })
  it('GST is the stored rate as a percentage; 0% is a rate; null = missing', () => {
    for (const [v, s] of [[5, '5%'], [12, '12%'], ['18', '18%'], [28, '28%'], [0, '0%'], [0.25, '0.25%']] as const) assert.equal(gstText(v), s)
    assert.equal(gstText(null), null)
    assert.equal(gstText(undefined), null)
  })
})
