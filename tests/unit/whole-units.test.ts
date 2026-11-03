import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import { AUDIT_SCRIPT, MIGRATION, buildAuditScript, unitCodes } from '../../scripts/lib/whole-unit-audit.mjs'
import {
  WHOLE_UNIT_CODES,
  bomRequirement,
  isFractionalForUnit,
  isWholeUnit,
  parseUnitQty,
  planQty,
  quantityRule,
} from '../../src/features/inventory/whole-units.ts'
import { parseNonNegativeQty, requirement, validateBomLine } from '../../src/features/production/production-model.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const migration = await readFile(path.join(root, MIGRATION), 'utf8')

describe('whole-piece policy stays in sync with the database', () => {
  it('uses the same unit list as private.whole_unit_codes()', () => {
    assert.deepEqual([...WHOLE_UNIT_CODES], unitCodes(migration))
  })

  it('the standalone audit script is generated from the migration query (run node scripts/generate-whole-unit-audit.mjs)', async () => {
    const script = await readFile(path.join(root, AUDIT_SCRIPT), 'utf8')
    assert.equal(script.replace(/\r\n/g, '\n'), buildAuditScript(migration.replace(/\r\n/g, '\n')))
  })

  it('the standalone audit script only reads (no insert / update / delete / DDL)', async () => {
    const script = (await readFile(path.join(root, AUDIT_SCRIPT), 'utf8')).replace(/--.*$/gm, '')
    assert.doesNotMatch(script, /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/i)
  })
})

describe('units', () => {
  it('PCS, NOS, SET, PAIR and aliases are whole-piece units, in any case', () => {
    for (const u of ['PCS', 'pcs', ' Nos ', 'SET', 'PAIR', 'PC', 'EA']) assert.equal(isWholeUnit(u), true, u)
  })
  it('weights, lengths and volumes are not', () => {
    for (const u of ['KG', 'G', 'MT', 'L', 'ML', 'M', 'SQM', 'SQFT', '', null, undefined]) assert.equal(isWholeUnit(u), false, String(u))
  })
  it('explains the rule per unit', () => {
    assert.equal(quantityRule('pcs'), 'whole PCS')
    assert.equal(quantityRule('KG'), 'up to 3 decimals')
  })
})

describe('parseUnitQty (text based, no float comparison)', () => {
  it('accepts whole PCS, including "10.0" and thousands separators', () => {
    assert.equal(parseUnitQty('10', 'PCS'), 10)
    assert.equal(parseUnitQty('10.0', 'PCS'), 10)
    assert.equal(parseUnitQty('1,250', 'PCS'), 1250)
  })
  it('rejects fractional PCS, including values that are "almost" whole', () => {
    for (const v of ['0.286', '78.571', '312.141', '10.5', '9.999', '10.001', '0.5']) assert.equal(parseUnitQty(v, 'PCS'), null, v)
  })
  it('rejects zero, negatives and text unless zero is allowed', () => {
    assert.equal(parseUnitQty('0', 'PCS'), null)
    assert.equal(parseUnitQty('', 'PCS'), null)
    assert.equal(parseUnitQty('-1', 'PCS'), null)
    assert.equal(parseUnitQty('abc', 'PCS'), null)
    assert.equal(parseUnitQty('', 'PCS', { allowZero: true }), 0)
    assert.equal(parseUnitQty('0', 'PCS', { allowZero: true }), 0)
  })
  it('other units keep up to 3 decimals', () => {
    assert.equal(parseUnitQty('2.75', 'KG'), 2.75)
    assert.equal(parseUnitQty('0.125', 'M'), 0.125)
    assert.equal(parseUnitQty('0.1234', 'KG'), null)
  })
})

describe('isFractionalForUnit (flagging stored values)', () => {
  it('flags fractional PCS balances such as 312.141', () => {
    assert.equal(isFractionalForUnit(312.141, 'PCS'), true)
    assert.equal(isFractionalForUnit('78.571', 'PCS'), true)
  })
  it('does not flag whole PCS or other units', () => {
    assert.equal(isFractionalForUnit(312, 'PCS'), false)
    assert.equal(isFractionalForUnit('312.000', 'PCS'), false)
    assert.equal(isFractionalForUnit(2.75, 'KG'), false)
    assert.equal(isFractionalForUnit(null, 'PCS'), false)
  })
})

describe('material requirement (mirror of private.bom_requirement_lines)', () => {
  it('ALD x 10 with 2 / 1 / 1 PCS per 70: A1 planned 1 (theoretical 0.286), A2 / A3 planned 1 (0.143)', () => {
    assert.deepEqual(bomRequirement(2, 70, 10, 0, 'PCS'), { theoretical: 0.286, wastage: 0, planned: 1, shortage: null })
    assert.deepEqual(bomRequirement(1, 70, 10, 0, 'PCS'), { theoretical: 0.143, wastage: 0, planned: 1, shortage: null })
  })
  it('multiple finished quantities', () => {
    assert.equal(bomRequirement(2, 70, 35, 0, 'PCS').planned, 1)
    assert.equal(bomRequirement(2, 70, 70, 0, 'PCS').planned, 2)
    assert.equal(bomRequirement(2, 70, 71, 0, 'PCS').planned, 3)
    assert.equal(bomRequirement(1, 70, 71, 0, 'PCS').planned, 2)
    assert.equal(bomRequirement(2, 70, 140, 0, 'PCS').planned, 4)
  })
  it('wastage is applied before rounding (0.9 x 1.10 = 0.99 -> 1, not ceil(0.9) x 1.1 -> 2)', () => {
    assert.deepEqual(bomRequirement(9, 10, 1, 10, 'PCS'), { theoretical: 0.9, wastage: 0.09, planned: 1, shortage: null })
    assert.equal(bomRequirement(10, 10, 1, 5, 'PCS').planned, 2)
    assert.equal(bomRequirement(10, 10, 10, 5, 'PCS').planned, 11)
    assert.equal(bomRequirement(10, 10, 20, 5, 'PCS').planned, 21)
  })
  it('exact arithmetic: 2 per 3 units -> 3 units need exactly 2 pieces', () => {
    assert.equal(bomRequirement(2, 3, 3, 0, 'PCS').planned, 2)
    assert.equal(bomRequirement(2, 3, 4, 0, 'PCS').planned, 3)
  })
  it('shortage uses the whole planned quantity', () => {
    assert.equal(bomRequirement(2, 70, 7000, 0, 'PCS', 100).shortage, 100)
    assert.equal(bomRequirement(2, 70, 10, 0, 'PCS', 5).shortage, 0)
  })
  it('other units keep 3 decimals (clay 0.25 KG per kit + 10%)', () => {
    assert.equal(bomRequirement(2.5, 10, 1, 10, 'KG').planned, 0.275)
    assert.equal(bomRequirement(2.5, 10, 10, 10, 'KG').planned, 2.75)
  })
  it('planQty', () => {
    assert.equal(planQty(0.2857, 'PCS'), 1)
    assert.equal(planQty(3.0000000000000004, 'PCS'), 3)
    assert.equal(planQty(0.2857, 'KG'), 0.286)
  })
  it('production-model requirement() passes the unit through', () => {
    assert.deepEqual(requirement(2, 70, 10, 0, null, 'PCS'), { base: 0.286, allowance: 0, total: 1, shortage: null })
    assert.deepEqual(requirement(0.2, 1, 10, 10, 20), { base: 2, allowance: 0.2, total: 2.2, shortage: 0 })
  })
})

describe('production form helpers', () => {
  it('parseNonNegativeQty enforces whole pieces when the unit is known', () => {
    assert.equal(parseNonNegativeQty('2', 'PCS'), 2)
    assert.equal(parseNonNegativeQty('', 'PCS'), 0)
    assert.equal(parseNonNegativeQty('1.5', 'PCS'), null)
    assert.equal(parseNonNegativeQty('1.5', 'KG'), 1.5)
  })
  it('validateBomLine requires whole pieces per batch for PCS components, with guidance', () => {
    assert.match(validateBomLine({ quantity: '0.5', wastage: '0', unit: 'PCS' }) ?? '', /whole PCS per BOM batch/)
    assert.equal(validateBomLine({ quantity: '2', wastage: '0', unit: 'PCS' }), null)
    assert.equal(validateBomLine({ quantity: '0.25', wastage: '10', unit: 'KG' }), null)
  })
})
