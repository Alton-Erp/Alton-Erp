import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { amountInWords, integerToIndianWords } from '../../src/features/billing/amount-in-words.ts'
import { financialYearRange, isAmount } from '../../src/features/billing/billing-model.ts'

describe('amount in words (Indian system)', () => {
  it('handles hundreds, thousands, lakhs and crores', () => {
    assert.equal(integerToIndianWords(0), 'Zero')
    assert.equal(integerToIndianWords(15), 'Fifteen')
    assert.equal(integerToIndianWords(110), 'One Hundred Ten')
    assert.equal(integerToIndianWords(6430), 'Six Thousand Four Hundred Thirty')
    assert.equal(integerToIndianWords(150000), 'One Lakh Fifty Thousand')
    assert.equal(integerToIndianWords(12345678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight')
    assert.equal(integerToIndianWords(1000000000), 'One Hundred Crore')
  })

  it('adds paise and works from decimal strings without floating point', () => {
    assert.equal(amountInWords('6430.00'), 'Rupees Six Thousand Four Hundred Thirty Only')
    assert.equal(amountInWords('5839.99'), 'Rupees Five Thousand Eight Hundred Thirty Nine and Ninety Nine Paise Only')
    assert.equal(amountInWords('0.5'), 'Rupees Zero and Fifty Paise Only')
    assert.equal(amountInWords(1120), 'Rupees One Thousand One Hundred Twenty Only')
  })

  it('rejects malformed amounts', () => {
    assert.throws(() => amountInWords('12.345'))
    assert.throws(() => amountInWords('abc'))
  })
})

describe('financial year', () => {
  it('uses 1 April to 31 March by default', () => {
    assert.deepEqual(financialYearRange(new Date(2027, 2, 31)), { label: '2026-27', from: '2026-04-01', to: '2027-03-31' })
    assert.deepEqual(financialYearRange(new Date(2027, 3, 1)), { label: '2027-28', from: '2027-04-01', to: '2028-03-31' })
  })
  it('supports a calendar year', () => {
    assert.deepEqual(financialYearRange(new Date(2027, 5, 15), 1), { label: '2027', from: '2027-01-01', to: '2027-12-31' })
  })
})

describe('amount input', () => {
  it('accepts at most two decimals', () => {
    assert.ok(isAmount('5000'))
    assert.ok(isAmount('5000.5'))
    assert.ok(!isAmount('5000.555'))
    assert.ok(!isAmount('-1'))
  })
})
