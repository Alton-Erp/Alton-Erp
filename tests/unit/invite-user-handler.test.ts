// invite-user Edge Function handler with fake Supabase clients: authorisation is
// delegated to the database (caller JWT), compensation on failures, idempotent
// retries, existing accounts, resend and revoke, and no false success.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { handle, mapRpcError, safeAuthError, type Deps } from '../../supabase/functions/invite-user/handler.ts'

const INV = '11111111-1111-4111-8111-111111111111'
const KEY = '22222222-2222-4222-8222-222222222222'
const ROLE = '33333333-3333-4333-8333-333333333333'
const prepared = (over: Record<string, unknown> = {}) => ({
  invitation_id: INV, mode: 'INVITE', email: 'new@example.com', full_name: 'New Person', company_name: 'Alton', support_email: 'help@alton.example',
  roles: ['Sales Executive'], expires_at: '2026-11-04T10:00:00Z', replace_auth_user_id: null, existing_account: false, needs_send: true, duplicate: false, ...over,
})

function fakes(opts: {
  user?: { id: string } | null
  prepare?: { data: unknown; error: unknown }
  revoke?: { data: unknown; error: unknown }
  invite?: { data: { user: { id: string } | null }; error: unknown }
  finalize?: { error: unknown }
  reset?: { error: unknown }
  lastSignIn?: string | null
  configured?: boolean
} = {}) {
  const calls: { fn: string; args?: unknown }[] = []
  const rpc = (who: string) => (fn: string, args?: Record<string, unknown>) => {
    calls.push({ fn: `${who}:${fn}`, args })
    if (fn === 'user_invitation_prepare') return Promise.resolve(opts.prepare ?? { data: prepared(), error: null })
    if (fn === 'user_invitation_revoke') return Promise.resolve(opts.revoke ?? { data: { status: 'REVOKED', auth_user_id: 'u-old', delete_auth_user: true }, error: null })
    if (fn === 'user_invitation_finalize') return Promise.resolve({ data: opts.finalize?.error ? null : { status: 'PENDING' }, error: opts.finalize?.error ?? null })
    return Promise.resolve({ data: { updated: true }, error: null })
  }
  const deps: Deps = {
    env: { redirectTo: 'https://erp.example/accept-invitation', expiresHours: 24, allowedOrigins: ['https://erp.example'], configured: opts.configured ?? true },
    caller: () => ({ auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: 'caller' } : opts.user }, error: null }) }, rpc: rpc('caller') }),
    admin: () => ({
      auth: { admin: {
        inviteUserByEmail: async (email, o) => { calls.push({ fn: 'admin:invite', args: { email, o } }); return (opts.invite ?? { data: { user: { id: 'u-new' } }, error: null }) as never },
        deleteUser: async (id) => { calls.push({ fn: 'admin:delete', args: id }); return { error: null } },
        getUserById: async (id) => ({ data: { user: { id, last_sign_in_at: opts.lastSignIn ?? null } }, error: null }),
      } },
      rpc: rpc('admin'),
    }),
    anon: () => ({ auth: { resetPasswordForEmail: async (email) => { calls.push({ fn: 'anon:reset', args: email }); return { error: (opts.reset?.error ?? null) as never } } } }),
  }
  return { deps, calls }
}
const post = (body: unknown, auth = 'Bearer jwt') => new Request('https://fn/invite-user', { method: 'POST', headers: { Authorization: auth, Origin: 'https://erp.example' }, body: JSON.stringify(body) })
const invite = (over: Record<string, unknown> = {}) => post({ action: 'invite', email: 'New@Example.com', full_name: 'New Person', role_ids: [ROLE], idempotency_key: KEY, ...over })
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> })

describe('invite-user: authentication and validation', () => {
  it('requires a bearer token, a valid session and the server configuration', async () => {
    assert.equal((await json(await handle(invite(), fakes().deps).then((r) => r))).status, 200)
    assert.deepEqual((await json(await handle(post({}, ''), fakes().deps))).body.code, 'NOT_SIGNED_IN')
    assert.equal((await json(await handle(invite(), fakes({ user: null }).deps))).body.code, 'SESSION_INVALID')
    assert.equal((await json(await handle(invite(), fakes({ configured: false }).deps))).body.code, 'NOT_CONFIGURED')
  })
  it('validates e-mail, name, roles and request id before calling anything', async () => {
    const f = fakes()
    assert.equal((await json(await handle(invite({ email: 'nope' }), f.deps))).body.code, 'VALIDATION')
    assert.equal((await json(await handle(invite({ role_ids: [] }), f.deps))).body.code, 'VALIDATION')
    assert.equal((await json(await handle(invite({ idempotency_key: 'x' }), f.deps))).body.code, 'BAD_REQUEST')
    assert.equal(f.calls.length, 0)
  })
  it('CORS is limited to the configured origins', async () => {
    const r = await handle(invite(), fakes().deps)
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://erp.example')
  })
})

describe('invite-user: invite', () => {
  it('prepares with the caller JWT (company and permissions decided by the database), invites, then finalizes', async () => {
    const f = fakes()
    const r = await json(await handle(invite({ details: { department: 'Sales', employee_id: ' E-1 ', ignored: 'x' } }), f.deps))
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
    assert.equal(r.body.email_status, 'SENT')
    assert.deepEqual(f.calls.map((c) => c.fn), ['caller:user_invitation_prepare', 'admin:invite', 'admin:user_invitation_finalize'])
    const prep = f.calls[0].args as Record<string, unknown>
    assert.equal(prep.p_email, 'new@example.com')
    assert.deepEqual(prep.p_details, { department: 'Sales', employee_id: 'E-1' })
    assert.ok(!('company_id' in prep) && !('p_company_id' in prep), 'the browser never chooses the company')
    const inv = f.calls[1].args as { o: { redirectTo: string; data: Record<string, string> } }
    assert.equal(inv.o.redirectTo, 'https://erp.example/accept-invitation')
    assert.equal(inv.o.data.company_name, 'Alton')
    assert.equal(inv.o.data.roles, 'Sales Executive')
    assert.equal(inv.o.data.expires_at, '4 Nov 2026, 10:00 UTC')
  })
  it('database refusals become clear errors: forbidden, duplicate, validation, rate limit', async () => {
    for (const [code, message, expected, status] of [
      ['42501', 'Only a Super Admin can assign administrative roles (Administrator).', 'FORBIDDEN', 403],
      ['23505', 'A pending invitation for x already exists. Resend it instead of inviting again.', 'DUPLICATE', 409],
      ['P0001', 'This e-mail belongs to a user of another company.', 'VALIDATION', 400],
      ['P0001', 'Too many invitations sent in the last hour.', 'RATE_LIMITED', 429],
    ] as const) {
      const f = fakes({ prepare: { data: null, error: { code, message } } })
      const r = await json(await handle(invite(), f.deps))
      assert.equal(r.status, status)
      assert.equal(r.body.code, expected)
      assert.equal(r.body.error, message)
      assert.ok(!f.calls.some((c) => c.fn.startsWith('admin:')), 'nothing privileged runs after a refusal')
    }
  })
  it('a retried request returns the stored invitation without sending again', async () => {
    const f = fakes({ prepare: { data: prepared({ duplicate: true, needs_send: false, status: 'PENDING', email_status: 'SENT' }), error: null } })
    const r = await json(await handle(invite(), f.deps))
    assert.equal(r.body.duplicate, true)
    assert.deepEqual(f.calls.map((c) => c.fn), ['caller:user_invitation_prepare'])
  })
  it('e-mail failure: invitation marked FAILED, error shown (no false success), no link or address in the stored reason', async () => {
    const f = fakes({ invite: { data: { user: null }, error: { message: 'Error sending invite email to new@example.com via SMTP', status: 500 } } })
    const r = await json(await handle(invite(), f.deps))
    assert.equal(r.status, 502)
    assert.equal(r.body.ok, false)
    assert.equal(r.body.code, 'EMAIL_FAILED')
    const failCall = f.calls.find((c) => c.fn === 'admin:user_invitation_fail')!
    assert.ok(!String((failCall.args as Record<string, unknown>).p_error).includes('@'))
  })
  it('provisioning failure after the Auth user exists: the user is deleted and the invitation marked FAILED', async () => {
    const f = fakes({ finalize: { error: { code: '42501', message: 'Only a Super Admin can assign administrative roles.' } } })
    const r = await json(await handle(invite(), f.deps))
    assert.equal(r.status, 500)
    assert.equal(r.body.code, 'PROVISIONING_FAILED')
    assert.deepEqual(f.calls.map((c) => c.fn).slice(-2), ['admin:delete', 'admin:user_invitation_fail'])
    assert.equal(f.calls.find((c) => c.fn === 'admin:delete')!.args, 'u-new')
  })
  it('an earlier never-used Auth user is replaced first, so one account remains', async () => {
    const f = fakes({ prepare: { data: prepared({ replace_auth_user_id: 'u-old' }), error: null } })
    await handle(invite(), f.deps)
    assert.deepEqual(f.calls.map((c) => c.fn), ['caller:user_invitation_prepare', 'admin:delete', 'admin:invite', 'admin:user_invitation_finalize'])
  })
  it('an existing account (signed in before) gets a password link and is attached; no second account', async () => {
    const f = fakes({ prepare: { data: prepared({ existing_account: true, existing_auth_user_id: 'u-existing' }), error: null } })
    const r = await json(await handle(invite(), f.deps))
    assert.equal(r.body.delivery, 'PASSWORD_LINK')
    assert.deepEqual(f.calls.map((c) => c.fn), ['caller:user_invitation_prepare', 'anon:reset', 'admin:user_invitation_finalize'])
    assert.ok(!f.calls.some((c) => c.fn === 'admin:invite'))
  })
  it('Auth reports the address as registered: 409, marked failed', async () => {
    const f = fakes({ invite: { data: { user: null }, error: { message: 'A user with this email address has already been registered', status: 422 } } })
    assert.equal((await json(await handle(invite(), f.deps))).body.code, 'ALREADY_REGISTERED')
  })
})

describe('invite-user: resend and revoke', () => {
  it('resend: prepare in RESEND mode, replace the unused account, invite again', async () => {
    const f = fakes({ prepare: { data: prepared({ mode: 'RESEND', replace_auth_user_id: 'u-old' }), error: null } })
    const r = await json(await handle(post({ action: 'resend', invitation_id: INV, idempotency_key: KEY }), f.deps))
    assert.equal(r.body.resent, true)
    const prep = f.calls[0].args as Record<string, unknown>
    assert.equal(prep.p_mode, 'RESEND')
    assert.equal(prep.p_invitation_id, INV)
    assert.deepEqual(f.calls.map((c) => c.fn).slice(1), ['admin:delete', 'admin:invite', 'admin:user_invitation_finalize'])
  })
  it('revoke: database decides; the never-signed-in Auth user is deleted so the link stops working', async () => {
    const f = fakes()
    const r = await json(await handle(post({ action: 'revoke', invitation_id: INV, reason: 'Hired elsewhere' }), f.deps))
    assert.equal(r.body.auth_user_deleted, true)
    assert.deepEqual(f.calls.map((c) => c.fn), ['caller:user_invitation_revoke', 'admin:delete'])
  })
  it('revoke never deletes an account that has signed in', async () => {
    const f = fakes({ lastSignIn: '2026-11-01T10:00:00Z' })
    const r = await json(await handle(post({ action: 'revoke', invitation_id: INV, reason: 'x' }), f.deps))
    assert.equal(r.body.auth_user_deleted, false)
    assert.ok(!f.calls.some((c) => c.fn === 'admin:delete'))
  })
})

describe('invite-user: helpers', () => {
  it('unknown database errors never leak details', () => {
    assert.equal(mapRpcError({ code: 'XX000', message: 'internal: relation x' }).error, 'The invitation could not be processed. Nothing was sent.')
    assert.equal(safeAuthError({ message: 'Email rate limit exceeded', status: 429 }), 'Supabase Auth refused the e-mail (HTTP 429): e-mail rate limit reached.')
  })
})
