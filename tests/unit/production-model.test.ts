// Unit tests for the production planning / BOM helpers used by the UI.
// The authoritative calculations run in the database (production_verification.sql);
// these check the client mirrors them so the screens never mislead.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  OUTSOURCING_ACTION_FROM,
  PRODUCTION_ACTION_FROM,
  canDo,
  ceilQty,
  parseNonNegativeQty,
  requirement,
  validateBomLine,
} from '../../src/features/production/production-model.ts'

describe('material requirement', () => {
  it('scales quantity per output and adds wastage (0.2 KG x 10 + 10% = 2.2)', () => {
    assert.deepEqual(requirement(0.2, 1, 10, 10, 20), { base: 2, allowance: 0.2, total: 2.2, shortage: 0 })
  })

  it('uses the BOM output quantity (2.5 KG per 2 units, 7 units = 8.75 KG)', () => {
    assert.equal(requirement(2.5, 2, 7, 0, null).total, 8.75)
  })

  it('shortage = max(required - available, 0)', () => {
    assert.equal(requirement(2.5, 1, 60, 0, 100).shortage, 50)
    assert.equal(requirement(2.5, 1, 10, 0, 100).shortage, 0)
  })

  it('rounds requirements up to 3 decimals, never down', () => {
    assert.equal(ceilQty(1 / 3), 0.334)
    assert.equal(ceilQty(2.2), 2.2) // float noise (2.2000000000000002) does not round up
    assert.equal(ceilQty(0.1 + 0.2), 0.3)
  })

  it('reports no shortage when availability is unknown (unit mismatch)', () => {
    assert.equal(requirement(1, 1, 5, 0, null).shortage, null)
  })
})

describe('zero-or-more quantities (rejected / scrap)', () => {
  it('accepts blank and zero as 0, positives up to 3 decimals', () => {
    assert.equal(parseNonNegativeQty(''), 0)
    assert.equal(parseNonNegativeQty('0'), 0)
    assert.equal(parseNonNegativeQty('0.000'), 0)
    assert.equal(parseNonNegativeQty('1,250.5'), 1250.5)
  })
  it('rejects negatives, text and more than 3 decimals', () => {
    assert.equal(parseNonNegativeQty('-1'), null)
    assert.equal(parseNonNegativeQty('abc'), null)
    assert.equal(parseNonNegativeQty('1.2345'), null)
  })
})

describe('BOM line validation', () => {
  it('accepts positive quantities and wastage below 100%', () => {
    assert.equal(validateBomLine({ quantity: '2.5', wastage: '10' }), null)
    assert.equal(validateBomLine({ quantity: '0.000001', wastage: '' }), null)
  })

  it('rejects zero, negative or non-numeric quantities', () => {
    assert.match(validateBomLine({ quantity: '0', wastage: '0' }) ?? '', /greater than zero/)
    assert.match(validateBomLine({ quantity: '-1', wastage: '0' }) ?? '', /greater than zero/)
    assert.match(validateBomLine({ quantity: 'abc', wastage: '0' }) ?? '', /greater than zero/)
  })

  it('rejects more than 6 decimals', () => {
    assert.match(validateBomLine({ quantity: '0.0000001', wastage: '0' }) ?? '', /6 decimals/)
  })

  it('rejects negative or >= 100% wastage', () => {
    assert.match(validateBomLine({ quantity: '1', wastage: '-5' }) ?? '', /Wastage/)
    assert.match(validateBomLine({ quantity: '1', wastage: '100' }) ?? '', /below 100/)
  })
})

describe('workflow actions offered by status (mirror of server rules)', () => {
  it('only drafts can be submitted and only pending orders approved', () => {
    assert.ok(canDo(PRODUCTION_ACTION_FROM, 'SUBMIT', 'DRAFT'))
    assert.ok(!canDo(PRODUCTION_ACTION_FROM, 'SUBMIT', 'APPROVED'))
    assert.ok(canDo(PRODUCTION_ACTION_FROM, 'APPROVE', 'PENDING_APPROVAL'))
    assert.ok(!canDo(PRODUCTION_ACTION_FROM, 'APPROVE', 'DRAFT'))
  })

  it('materials are issued and output recorded only while in production', () => {
    for (const s of ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'MATERIALS_RESERVED', 'ON_HOLD', 'COMPLETED', 'CANCELLED']) {
      assert.ok(!canDo(PRODUCTION_ACTION_FROM, 'ISSUE', s), s)
      assert.ok(!canDo(PRODUCTION_ACTION_FROM, 'OUTPUT', s), s)
    }
    assert.ok(canDo(PRODUCTION_ACTION_FROM, 'ISSUE', 'IN_PROGRESS'))
    assert.ok(canDo(PRODUCTION_ACTION_FROM, 'OUTPUT', 'PARTIALLY_COMPLETED'))
  })

  it('completed or cancelled orders cannot be cancelled or completed again', () => {
    for (const s of ['COMPLETED', 'CANCELLED']) {
      assert.ok(!canDo(PRODUCTION_ACTION_FROM, 'CANCEL', s))
      assert.ok(!canDo(PRODUCTION_ACTION_FROM, 'COMPLETE', s))
      assert.ok(!canDo(OUTSOURCING_ACTION_FROM, 'RECEIVE', s))
    }
  })
})
