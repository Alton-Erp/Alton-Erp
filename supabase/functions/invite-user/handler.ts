// invite-user request handling (no Deno / npm imports, so it is unit-tested in
// tests/unit/invite-user-handler.test.ts with fake Supabase clients).
//
// Actions (POST JSON):
//   { action: 'invite', email, full_name, role_ids[], idempotency_key, details? }
//   { action: 'resend', invitation_id, idempotency_key }
//   { action: 'revoke', invitation_id, reason }
//
// Security model
//   * The caller is the verified owner of the JWT (auth.getUser). Every rule —
//     company membership, users.manage, which roles the caller may assign (Super
//     Admin / administrative roles), duplicates, existing users, rate limiting —
//     is enforced by public.user_invitation_prepare / _revoke, called WITH THE
//     CALLER'S JWT, so the database sees the real auth.uid(). The company is the
//     caller's; nothing in the body chooses it.
//   * Only the Supabase Auth admin calls (invite, delete never-used user) and the
//     two service-role steps (finalize / fail) use the service-role key, which
//     stays in the function's environment.
//   * Compensation: if the e-mail cannot be sent the invitation is marked FAILED;
//     if provisioning fails after the Auth user was created, that user is deleted
//     and the invitation marked FAILED. Nothing is left half-assigned.
//   * Idempotent: the same idempotency_key returns the stored invitation.
//   * Never logs or returns invitation links, tokens or keys.

export interface RpcError { code?: string; message?: string }
export interface RpcResult<T> { data: T | null; error: RpcError | null }
export interface CallerClient {
  auth: { getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }> }
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>>
}
export interface AdminClient {
  auth: {
    admin: {
      inviteUserByEmail(email: string, options: { redirectTo?: string; data?: Record<string, unknown> }): Promise<{ data: { user: { id: string } | null }; error: { message?: string; status?: number } | null }>
      deleteUser(id: string): Promise<{ error: unknown }>
      getUserById(id: string): Promise<{ data: { user: { id: string; last_sign_in_at?: string | null } | null }; error: unknown }>
    }
  }
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>>
}
export interface AnonClient {
  auth: { resetPasswordForEmail(email: string, options: { redirectTo?: string }): Promise<{ error: { message?: string; status?: number } | null }> }
}
export interface Deps {
  env: { redirectTo?: string; expiresHours: number; allowedOrigins: string[]; configured: boolean }
  caller(authHeader: string): CallerClient
  admin(): AdminClient
  anon(): AnonClient
}

interface Prepared {
  invitation_id: string
  mode: 'INVITE' | 'RESEND'
  email: string
  full_name: string
  company_name: string
  support_email: string | null
  roles: string[] | null
  expires_at: string
  replace_auth_user_id: string | null
  existing_account: boolean
  existing_auth_user_id?: string | null
  needs_send: boolean
  duplicate: boolean
  status?: string
  email_status?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }
}

/** Database error -> HTTP status and stable error code for the frontend. */
export function mapRpcError(e: RpcError | null | undefined): { status: number; code: string; error: string } {
  const message = e?.message ?? 'The request could not be completed.'
  if (e?.code === '42501') return { status: 403, code: 'FORBIDDEN', error: message }
  if (e?.code === '23505') return { status: 409, code: 'DUPLICATE', error: message }
  if (/too many/i.test(message)) return { status: 429, code: 'RATE_LIMITED', error: message }
  if (e?.code === 'P0001' || e?.code === '22023' || e?.code === '22P02') return { status: 400, code: 'VALIDATION', error: message }
  return { status: 500, code: 'SERVER_ERROR', error: 'The invitation could not be processed. Nothing was sent.' }
}

/** Auth error text without addresses or links (stored on the invitation for the administrator). */
export const safeAuthError = (e: { message?: string; status?: number } | null | undefined) =>
  `Supabase Auth refused the e-mail${e?.status ? ` (HTTP ${e.status})` : ''}${/rate limit/i.test(e?.message ?? '') ? ': e-mail rate limit reached' : /smtp|mail/i.test(e?.message ?? '') ? ': e-mail provider error' : ''}.`

/** "4 Nov 2026, 10:00 UTC" for the e-mail; the raw value if it cannot be read. */
export function formatExpiry(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.env.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => reply(status, { ok: false, code, error, ...extra })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.env.allowedOrigins) })
  if (req.method !== 'POST') return fail(405, 'METHOD', 'Method not allowed')
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return fail(401, 'NOT_SIGNED_IN', 'You are not signed in.')
  if (!deps.env.configured) return fail(500, 'NOT_CONFIGURED', 'The invitation service is not configured on the server (missing Supabase environment). Nothing was sent.')

  const caller = deps.caller(authHeader)
  const { data: who, error: whoError } = await caller.auth.getUser()
  if (whoError || !who.user) return fail(401, 'SESSION_INVALID', 'Your session is invalid or has expired. Sign in again.')

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return fail(400, 'BAD_REQUEST', 'Invalid request body.')
  }
  const action = typeof body.action === 'string' ? body.action : 'invite'
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '')

  // ---- revoke --------------------------------------------------------------
  if (action === 'revoke') {
    const invitationId = str('invitation_id')
    if (!UUID_RE.test(invitationId)) return fail(400, 'BAD_REQUEST', 'Invitation id is required.')
    const { data, error } = await caller.rpc<{ status: string; auth_user_id: string | null; delete_auth_user: boolean }>('user_invitation_revoke',
      { p_invitation_id: invitationId, p_reason: str('reason') })
    if (error || !data) { const m = mapRpcError(error); return fail(m.status, m.code, m.error) }
    let authUserDeleted = false
    if (data.delete_auth_user && data.auth_user_id) {
      // Only an account that never signed in is removed, so the invitation link stops working.
      const admin = deps.admin()
      const { data: u } = await admin.auth.admin.getUserById(data.auth_user_id)
      if (u.user && !u.user.last_sign_in_at) authUserDeleted = !(await admin.auth.admin.deleteUser(data.auth_user_id)).error
    }
    return reply(200, { ok: true, invitation_id: invitationId, status: data.status, auth_user_deleted: authUserDeleted })
  }

  // ---- invite / resend: prepare with the caller's JWT ------------------------
  const key = str('idempotency_key')
  if (!UUID_RE.test(key)) return fail(400, 'BAD_REQUEST', 'A request id (idempotency key) is required.')
  let prepArgs: Record<string, unknown>
  if (action === 'resend') {
    const invitationId = str('invitation_id')
    if (!UUID_RE.test(invitationId)) return fail(400, 'BAD_REQUEST', 'Invitation id is required.')
    prepArgs = { p_email: null, p_full_name: null, p_details: null, p_role_ids: null, p_idempotency_key: key, p_mode: 'RESEND',
      p_invitation_id: invitationId, p_expires_hours: deps.env.expiresHours }
  } else if (action === 'invite') {
    const email = str('email').toLowerCase()
    const fullName = str('full_name')
    const roleIds = Array.isArray(body.role_ids) ? [...new Set(body.role_ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)))] : []
    if (!EMAIL_RE.test(email) || email.length > 320) return fail(400, 'VALIDATION', 'Enter a valid work e-mail address.')
    if (!fullName || fullName.length > 120) return fail(400, 'VALIDATION', 'Enter the full name (1 to 120 characters).')
    if (roleIds.length === 0) return fail(400, 'VALIDATION', 'Select at least one role.')
    const d = (typeof body.details === 'object' && body.details) ? body.details as Record<string, unknown> : {}
    const details: Record<string, string> = {}
    for (const k of ['employee_id', 'department', 'designation', 'reporting_manager_id']) if (typeof d[k] === 'string' && (d[k] as string).trim()) details[k] = (d[k] as string).trim()
    prepArgs = { p_email: email, p_full_name: fullName, p_details: details, p_role_ids: roleIds, p_idempotency_key: key, p_mode: 'INVITE',
      p_invitation_id: null, p_expires_hours: deps.env.expiresHours }
  } else {
    return fail(400, 'BAD_REQUEST', 'Unknown action.')
  }

  const { data: prep, error: prepError } = await caller.rpc<Prepared>('user_invitation_prepare', prepArgs)
  if (prepError || !prep) { const m = mapRpcError(prepError); return fail(m.status, m.code, m.error) }
  const summary = { invitation_id: prep.invitation_id, email: prep.email, roles: prep.roles ?? [], expires_at: prep.expires_at }
  if (prep.duplicate && !prep.needs_send) {
    return reply(200, { ok: true, duplicate: true, status: prep.status, email_status: prep.email_status, ...summary })
  }

  const admin = deps.admin()
  const markFailed = async (reason: string) => { await admin.rpc('user_invitation_fail', { p_invitation_id: prep.invitation_id, p_error: reason }) }

  // An account that has signed in before (no company yet): no second account; it gets a password link.
  if (prep.existing_account && prep.existing_auth_user_id) {
    const { error: mailError } = await deps.anon().auth.resetPasswordForEmail(prep.email, { redirectTo: deps.env.redirectTo })
    if (mailError) {
      await markFailed(safeAuthError(mailError))
      return fail(502, 'EMAIL_FAILED', 'The activation e-mail could not be sent. The invitation was recorded as failed; try Resend later.', summary)
    }
    const { error: finError } = await admin.rpc('user_invitation_finalize', { p_invitation_id: prep.invitation_id, p_auth_user_id: prep.existing_auth_user_id, p_delivery_method: 'PASSWORD_LINK' })
    if (finError) {
      await markFailed('Provisioning failed after the e-mail was sent.')
      const m = mapRpcError(finError)
      return fail(m.status === 500 ? 500 : m.status, 'PROVISIONING_FAILED', `The account could not be set up: ${m.error}`, summary)
    }
    return reply(200, { ok: true, duplicate: false, status: 'PENDING', email_status: 'SENT', delivery: 'PASSWORD_LINK', ...summary })
  }

  // An earlier Auth user for this e-mail that never signed in is replaced, so exactly one account remains.
  if (prep.replace_auth_user_id) {
    const { error } = await admin.auth.admin.deleteUser(prep.replace_auth_user_id)
    if (error) {
      await markFailed('The earlier unused account could not be replaced.')
      return fail(500, 'PROVISIONING_FAILED', 'The earlier unused account for this e-mail could not be replaced. Nothing was sent.', summary)
    }
  }

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(prep.email, {
    redirectTo: deps.env.redirectTo,
    // Used only by the e-mail template; the database never trusts user metadata.
    data: { full_name: prep.full_name, company_name: prep.company_name, roles: (prep.roles ?? []).join(', '), expires_at: formatExpiry(prep.expires_at),
      support_email: prep.support_email ?? '' },
  })
  if (inviteError || !invited.user) {
    await markFailed(safeAuthError(inviteError))
    const exists = /already|registered|exists/i.test(inviteError?.message ?? '')
    return exists
      ? fail(409, 'ALREADY_REGISTERED', 'An account with this e-mail already exists in Supabase Auth. Nothing was sent.', summary)
      : fail(502, 'EMAIL_FAILED', 'The invitation e-mail could not be sent. The invitation was recorded as failed; check the e-mail settings and use Resend.', summary)
  }
  const { error: finError } = await admin.rpc('user_invitation_finalize', { p_invitation_id: prep.invitation_id, p_auth_user_id: invited.user.id, p_delivery_method: 'AUTH_INVITE' })
  if (finError) {
    await admin.auth.admin.deleteUser(invited.user.id)
    await markFailed('Provisioning failed; the new account was removed.')
    const m = mapRpcError(finError)
    return fail(500, 'PROVISIONING_FAILED', `The user could not be set up and the invitation was withdrawn: ${m.error}`, summary)
  }
  return reply(200, { ok: true, duplicate: false, status: 'PENDING', email_status: 'SENT', delivery: 'AUTH_INVITE', resent: prep.mode === 'RESEND', ...summary })
}
