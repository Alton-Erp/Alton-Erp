import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { availablePoActions, PO_STATUS_LABELS } from '../../src/features/purchasing/po-model.ts'

// V2 single-operator mode: one person creates and opens purchase orders.
// The database applies the same rules (supabase/tests/single_operator_verification.sql).
const ME = 'user-1'
const draft = { status: 'DRAFT' as const, created_by: ME, submitted_by: null, revision: 0 }
const all = () => true
const noApprove = (p: string) => p !== 'purchase_order.approve'

describe('single-operator purchase orders', () => {
  it('a user who may approve gets one-step OPEN on their own draft (segregation off by default)', () => {
    const actions = availablePoActions(draft, all, ME, { hasReceipts: false })
    assert.ok(actions.includes('OPEN'))
    assert.ok(!actions.includes('SUBMIT'))
  })

  it('falls back to SUBMIT when the user cannot approve', () => {
    const actions = availablePoActions(draft, noApprove, ME, { hasReceipts: false })
    assert.ok(actions.includes('SUBMIT'))
    assert.ok(!actions.includes('OPEN'))
  })

  it('falls back to SUBMIT for your own draft when the company turns segregation of duties on', () => {
    const actions = availablePoActions(draft, all, ME, { hasReceipts: false, segregationOfDuties: true })
    assert.ok(actions.includes('SUBMIT'))
    assert.ok(!actions.includes('OPEN'))
  })

  it('with segregation on, another user can still open a draft they did not create', () => {
    const actions = availablePoActions(draft, all, 'user-2', { hasReceipts: false, segregationOfDuties: true })
    assert.ok(actions.includes('OPEN'))
  })

  it('an approved order is shown as Open and can be received', () => {
    assert.equal(PO_STATUS_LABELS.APPROVED, 'Open')
    const actions = availablePoActions({ ...draft, status: 'APPROVED' }, all, ME, { hasReceipts: false })
    assert.ok(actions.includes('RECEIVE'))
  })
})
