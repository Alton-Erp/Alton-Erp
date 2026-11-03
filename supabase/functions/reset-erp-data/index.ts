// Supabase Edge Function: reset-erp-data
//
// Permanently deletes the business data of the caller's company (see
// supabase/migrations/20261030090000_erp_reset.sql for exactly what is deleted
// and kept, and docs/ERP_RESET.md).
//
// Security model
//   * The caller is identified from their own JWT (auth.getUser); a user id in
//     the request body is never used.
//   * Must be an active Super Admin with system.reset_data (checked here from
//     get_my_access, and again inside the database under lock).
//   * Password re-entry: verified against Supabase Auth with the email of the
//     VERIFIED user. The extra session this creates is signed out at once.
//     The password is never logged, stored or forwarded to the database.
//     Accounts without an email/password identity are refused with guidance
//     (this ERP signs in with email + password only).
//   * At most 5 wrong passwords per user in 15 minutes (audited).
//   * public.erp_reset_execute is executable by service_role only, so a
//     browser cannot skip this function. The service-role key is read from the
//     function environment and never leaves the server.
//   * request_id makes retries idempotent; a database advisory lock prevents
//     concurrent resets of the same company.
//   * Success is reported only when the reset transaction verified itself AND
//     an independent post-commit check finds the allowlist empty and the
//     caller's Super Admin access intact.
//
// Deploy:  supabase functions deploy reset-erp-data
// Secrets: ALLOWED_ORIGINS (comma-separated, e.g. https://erp.example.com)

import { createClient } from 'npm:@supabase/supabase-js@2'

const CONFIRMATION = 'RESET ERP'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean)
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  }
}

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, 405, { code: 'METHOD', error: 'Method not allowed' })

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json(req, 401, { code: 'NOT_SIGNED_IN', error: 'Not signed in' })

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json(req, 500, { code: 'NOT_CONFIGURED', error: 'The reset function is not configured.' })

  // 1. Verified identity and access (RLS applies to this client).
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await caller.auth.getUser()
  const user = userData?.user
  if (userError || !user) return json(req, 401, { code: 'SESSION_INVALID', error: 'Your session is invalid or has expired. Sign in again.' })

  const { data: access, error: accessError } = await caller.rpc('get_my_access')
  const roles: string[] = access?.roles ?? []
  const permissions: string[] = access?.permissions ?? []
  if (accessError || !access?.company?.id || !access.profile?.is_active || !access.company.is_active
      || !roles.includes('SUPER_ADMIN') || !permissions.includes('system.reset_data')) {
    return json(req, 403, { code: 'FORBIDDEN', error: 'Only an active Super Admin can reset ERP data.' })
  }

  // 2. Input.
  let body: { password?: unknown; confirmation?: unknown; request_id?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(req, 400, { code: 'BAD_REQUEST', error: 'Invalid request body' })
  }
  const password = typeof body.password === 'string' ? body.password : ''
  const requestId = typeof body.request_id === 'string' ? body.request_id : ''
  if (body.confirmation !== CONFIRMATION) return json(req, 400, { code: 'CONFIRMATION', error: `Type ${CONFIRMATION} to confirm.` })
  if (!UUID_RE.test(requestId)) return json(req, 400, { code: 'BAD_REQUEST', error: 'A request id is required.' })
  if (password.length < 1 || password.length > 256) return json(req, 400, { code: 'PASSWORD_REQUIRED', error: 'Enter your password.' })

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  // 3. Re-authentication method: this ERP uses email + password sign-in.
  const providers: string[] = Array.isArray(user.app_metadata?.providers)
    ? user.app_metadata.providers
    : [user.app_metadata?.provider].filter((p): p is string => typeof p === 'string')
  if (!user.email || !providers.includes('email')) {
    await admin.rpc('erp_reset_record_attempt', { p_actor: user.id, p_outcome: 'REAUTH_UNSUPPORTED' })
    return json(req, 409, {
      code: 'REAUTH_UNSUPPORTED',
      error: 'Your account has no password sign-in, so it cannot be re-verified. Set a password with "Forgot password" on the sign-in page, then try again.',
    })
  }

  // 4. Rate limit, then verify the password with a throw-away client.
  const { data: allowed, error: allowedError } = await admin.rpc('erp_reset_attempt_allowed', { p_actor: user.id })
  if (allowedError) return json(req, 500, { code: 'CHECK_FAILED', error: 'Could not check recent attempts. Nothing was deleted.' })
  if (!allowed?.allowed) {
    return json(req, 429, { code: 'TOO_MANY_ATTEMPTS', error: 'Too many wrong passwords. Wait 15 minutes and try again. Nothing was deleted.' })
  }

  const verifier = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: signIn, error: signInError } = await verifier.auth.signInWithPassword({ email: user.email, password })
  if (signInError || !signIn.session || signIn.user?.id !== user.id) {
    if (signIn?.session) await verifier.auth.signOut({ scope: 'local' })
    await admin.rpc('erp_reset_record_attempt', { p_actor: user.id, p_outcome: 'REAUTH_FAILED' })
    return json(req, 401, { code: 'WRONG_PASSWORD', error: 'The password is incorrect. Nothing was deleted.' })
  }
  // Revoke only the extra session created for the check; the user's own session stays signed in.
  await verifier.auth.signOut({ scope: 'local' })

  // 5. Reset (authorization re-checked in the database under lock).
  const { data: result, error: resetError } = await admin.rpc('erp_reset_execute', {
    p_actor: user.id,
    p_request_id: requestId,
    p_confirmation: CONFIRMATION,
  })
  if (resetError || !result) {
    return json(req, 500, {
      code: 'RESET_ERROR',
      status: 'FAILED',
      error: `The reset did not complete: ${resetError?.message ?? 'no result'}. The database rolls back a failed reset; check the preview before trying again.`,
    })
  }
  if (result.status !== 'COMPLETED') {
    const httpStatus = result.status === 'BLOCKED' ? 409 : result.status === 'DENIED' ? 403 : result.status === 'IN_PROGRESS' ? 409 : 500
    return json(req, httpStatus, { code: result.status, ...result })
  }

  // 6. Independent check after commit.
  const { data: verification, error: verifyError } = await admin.rpc('erp_reset_verify', { p_actor: user.id })
  if (verifyError || !verification?.ok) {
    return json(req, 500, {
      code: 'VERIFICATION_FAILED',
      ...result,
      status: 'VERIFICATION_FAILED',
      post_check: verification ?? null,
      error: 'The reset committed, but the follow-up check did not confirm it. Records may have been created after the reset, or some remain; see post_check.remaining.',
    })
  }

  return json(req, 200, { ...result, post_check: verification })
})
