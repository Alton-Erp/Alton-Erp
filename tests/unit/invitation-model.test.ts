import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canResend,
  canRevoke,
  describeInviteFailure,
  EMPTY_INVITE,
  filterRoles,
  groupRoles,
  INVITE_NETWORK,
  INVITE_NOT_DEPLOYED,
  inviteRequestBody,
  keyPermissions,
  parseInvitationLink,
  validateInvite,
  type CatalogRole,
  type InvitationRow,
} from '../../src/features/users/invitation-model.ts'

const role = (over: Partial<CatalogRole>): CatalogRole => ({
  id: crypto.randomUUID(), code: 'X', name: 'X', description: null, category: 'Other', is_admin: false, assignable: true, modules: [], permissions: [], ...over,
})
const admin = role({ code: 'ADMIN', name: 'Administrator', category: 'Administration', is_admin: true, assignable: false, modules: ['users'] })
const sales = role({ code: 'SALES_EXECUTIVE', name: 'Sales Executive', category: 'Sales & Commercial', modules: ['sales_orders', 'customers'],
  permissions: [{ code: 'customers.read', description: 'View customers' }, { code: 'sales_orders.create', description: 'Create sales orders' }] })
const odd = role({ code: 'NEW_ROLE', name: 'New Role', category: 'Something new' })
const catalog = [admin, sales, odd]

describe('role catalogue', () => {
  it('groups roles in the fixed category order; unknown categories go to Other', () => {
    assert.deepEqual(groupRoles(catalog).map((g) => g.category), ['Administration', 'Sales & Commercial', 'Other'])
  })
  it('search matches name, code, description, category and module labels', () => {
    assert.deepEqual(filterRoles(catalog, 'sales orders').map((r) => r.code), ['SALES_EXECUTIVE'])
    assert.deepEqual(filterRoles(catalog, 'admin').map((r) => r.code), ['ADMIN'])
    assert.equal(filterRoles(catalog, '  ').length, 3)
  })
  it('key permissions show write permissions first', () => {
    assert.deepEqual(keyPermissions(sales), ['Create sales orders'])
  })
})

describe('invite form', () => {
  const ok = { ...EMPTY_INVITE, fullName: 'Asha Rao', email: 'asha@example.com', roleIds: [sales.id] }
  it('requires name, valid e-mail and at least one role', () => {
    const e = validateInvite(EMPTY_INVITE, catalog)
    assert.ok(e.fullName && e.email && e.roleIds)
    assert.ok(validateInvite({ ...ok, email: 'asha@' }, catalog).email)
    assert.deepEqual(validateInvite(ok, catalog), {})
  })
  it('refuses roles the catalogue marks as not assignable (e.g. admin roles for a regular Admin)', () => {
    assert.match(validateInvite({ ...ok, roleIds: [admin.id] }, catalog).roleIds ?? '', /cannot assign: Administrator/)
  })
  it('request body: normalised e-mail and name, unique roles, only filled details, no company or inviter', () => {
    const body = inviteRequestBody({ ...ok, email: ' Asha@Example.COM ', fullName: ' Asha   Rao ', roleIds: [sales.id, sales.id], department: ' Sales ' }, 'k')
    assert.equal(body.email, 'asha@example.com')
    assert.equal(body.full_name, 'Asha Rao')
    assert.deepEqual(body.role_ids, [sales.id])
    assert.deepEqual(body.details, { department: 'Sales' })
    assert.ok(!('company_id' in body) && !('invited_by' in body))
  })
})

describe('Edge Function failures never look like success', () => {
  it('maps each failure to a clear message', () => {
    assert.equal(describeInviteFailure(0, null).message, INVITE_NETWORK)
    assert.equal(describeInviteFailure(404, null).message, INVITE_NOT_DEPLOYED)
    assert.equal(describeInviteFailure(401, { code: 'SESSION_INVALID' }).code, 'SESSION_INVALID')
    assert.equal(describeInviteFailure(403, { code: 'FORBIDDEN', error: 'Only a Super Admin can assign administrative roles.' }).message, 'Only a Super Admin can assign administrative roles.')
    assert.equal(describeInviteFailure(409, { code: 'DUPLICATE', error: 'A pending invitation exists.' }).code, 'DUPLICATE')
    assert.equal(describeInviteFailure(429, {}).code, 'RATE_LIMITED')
    assert.equal(describeInviteFailure(502, { code: 'EMAIL_FAILED', error: 'Could not send.' }).code, 'EMAIL_FAILED')
    assert.equal(describeInviteFailure(500, { code: 'NOT_CONFIGURED' }).code, 'NOT_CONFIGURED')
    assert.match(describeInviteFailure(500, null).message, /No invitation was confirmed/)
  })
  it('a 404 from the function itself (with a code) is not reported as "not deployed"', () => {
    assert.notEqual(describeInviteFailure(404, { code: 'NOT_FOUND', error: 'Invitation not found.' }).message, INVITE_NOT_DEPLOYED)
  })
})

describe('invitation links', () => {
  it('token_hash links (recommended template) are verified with verifyOtp', () => {
    assert.deepEqual(parseInvitationLink('?token_hash=abc123def&type=invite', ''), { kind: 'token_hash', tokenHash: 'abc123def', type: 'invite' })
    assert.deepEqual(parseInvitationLink('?token_hash=pkce_abc123&type=recovery', '').kind, 'token_hash')
    assert.equal(parseInvitationLink('?token_hash=abc123def&type=signup_admin', '').kind, 'none')
  })
  it('default ConfirmationURL redirects (implicit hash tokens) are picked up', () => {
    assert.deepEqual(parseInvitationLink('', '#access_token=a.b.c&refresh_token=r1&type=invite'), { kind: 'tokens', accessToken: 'a.b.c', refreshToken: 'r1' })
  })
  it('errors from Supabase Auth are shown, nothing else is guessed', () => {
    assert.deepEqual(parseInvitationLink('', '#error=access_denied&error_description=Email+link+is+invalid+or+has+expired'),
      { kind: 'error', message: 'Email link is invalid or has expired' })
    assert.equal(parseInvitationLink('', '').kind, 'none')
  })
})

describe('invitation actions', () => {
  const row = (status: InvitationRow['status']) => ({ status }) as InvitationRow
  it('accepted and revoked invitations cannot be resent or revoked', () => {
    for (const s of ['ACCEPTED', 'REVOKED'] as const) assert.ok(!canResend(row(s)) && !canRevoke(row(s)))
    for (const s of ['PENDING', 'EXPIRED', 'FAILED'] as const) assert.ok(canResend(row(s)) && canRevoke(row(s)))
  })
})
