// Supabase Edge Function: force-reset-erp-data
//
// Force reset ("delete everything") of the caller's company: business data
// INCLUDING protected history, for an approved DEVELOPMENT / DEMO / TEST
// company only. See supabase/migrations/20261031090000_erp_force_reset.sql and
// docs/ERP_RESET.md.
//
// Flow
//   1. Caller from their own JWT (auth.getUser); must be an active Super Admin
//      with system.reset_data of the company named in the request.
//   2. Password re-entry, verified against Supabase Auth with the VERIFIED
//      user's email; the extra session is signed out at once. At most 5 wrong
//      passwords per 15 minutes (shared with the standard reset). The password
//      is never logged, stored or sent to the database.
//   3. A one-time ticket (2 minutes, stored hashed) is issued with the service
//      role, then erp_force_reset_execute is called WITH THE USER'S OWN JWT, so
//      the database identifies the user with auth.uid() and re-checks every
//      requirement (approval, backup, plan, confirmations) under lock.
//      Browsers never receive a ticket, so they cannot call execute usefully.
//   4. If the call fails (e.g. statement timeout: everything rolled back), the
//      failure is recorded; a request that did commit is never overwritten.
//   5. After a COMPLETED reset: the company's files are removed from Storage,
//      then erp_force_reset_verify checks database and Storage. HTTP 200 only
//      when that check passes.
//
// Deploy:  supabase functions deploy force-reset-erp-data
// Secrets: ALLOWED_ORIGINS (comma-separated, e.g. https://erp.example.com)

import { createClient } from 'npm:@supabase/supabase-js@2'

const CONFIRMATION = 'DELETE ALL COMPANY DATA'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STORAGE_BATCH = 100

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

interface StorageObject { bucket: string; name: string }
interface Verification { ok?: boolean; storage_objects?: StorageObject[]; storage_remaining?: number; [key: string]: unknown }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, 405, { code: 'METHOD', error: 'Method not allowed' })

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json(req, 401, { code: 'NOT_SIGNED_IN', error: 'Not signed in' })

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json(req, 500, { code: 'NOT_CONFIGURED', error: 'The force reset function is not configured.' })

  // 1. Verified identity and access (this client acts as the user; RLS applies).
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await caller.auth.getUser()
  const user = userData?.user
  if (userError || !user) return json(req, 401, { code: 'SESSION_INVALID', error: 'Your session is invalid or has expired. Sign in again.' })

  let body: { password?: unknown; confirmation?: unknown; company_id?: unknown; company_code?: unknown; backup_id?: unknown; request_id?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(req, 400, { code: 'BAD_REQUEST', error: 'Invalid request body' })
  }
  const password = typeof body.password === 'string' ? body.password : ''
  const companyId = typeof body.company_id === 'string' ? body.company_id : ''
  const companyCode = typeof body.company_code === 'string' ? body.company_code.trim() : ''
  const backupId = typeof body.backup_id === 'string' ? body.backup_id : ''
  const requestId = typeof body.request_id === 'string' ? body.request_id : ''
  if (body.confirmation !== CONFIRMATION) return json(req, 400, { code: 'CONFIRMATION', error: `Type ${CONFIRMATION} to confirm.` })
  if (!UUID_RE.test(requestId) || !UUID_RE.test(companyId) || !UUID_RE.test(backupId)) {
    return json(req, 400, { code: 'BAD_REQUEST', error: 'Company, backup and request id are required.' })
  }
  if (companyCode.length < 1 || companyCode.length > 40) return json(req, 400, { code: 'COMPANY_CODE', error: 'Type the company code to confirm.' })
  if (password.length < 1 || password.length > 256) return json(req, 400, { code: 'PASSWORD_REQUIRED', error: 'Enter your password.' })

  const { data: access, error: accessError } = await caller.rpc('get_my_access')
  const roles: string[] = access?.roles ?? []
  const permissions: string[] = access?.permissions ?? []
  if (accessError || !access?.company?.id || !access.profile?.is_active || !access.company.is_active
      || !roles.includes('SUPER_ADMIN') || !permissions.includes('system.reset_data')) {
    return json(req, 403, { code: 'FORBIDDEN', error: 'Only an active Super Admin can reset ERP data.' })
  }
  if (access.company.id !== companyId) {
    return json(req, 403, { code: 'FORBIDDEN', error: 'You can only reset the company your account belongs to.' })
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  // 2. Re-authentication: this ERP signs in with email + password only.
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
  await verifier.auth.signOut({ scope: 'local' })

  // 3. One-time ticket, then the reset as the user (auth.uid() in the database).
  const { data: issued, error: ticketError } = await admin.rpc('erp_force_reset_issue_ticket', { p_actor: user.id, p_company: companyId })
  if (ticketError || typeof issued?.ticket !== 'string') {
    return json(req, 403, { code: 'FORBIDDEN', error: 'The database refused to start a force reset for this account. Nothing was deleted.' })
  }
  const executed = await caller.rpc('erp_force_reset_execute', {
    p_company_id: companyId,
    p_request_id: requestId,
    p_confirmation: CONFIRMATION,
    p_company_code: companyCode,
    p_backup_id: backupId,
    p_reauth_ticket: issued.ticket,
  })

  // 4. The call failed: record it, unless this request has a stored run.
  let result = executed.data
  if (executed.error || !result) {
    const reason = executed.error?.message ?? 'no result'
    const { data: recorded } = await admin.rpc('erp_force_reset_record_failure', {
      p_actor: user.id, p_company: companyId, p_request_id: requestId, p_reason: reason,
    })
    if (recorded?.status !== 'COMPLETED') {
      return json(req, 500, {
        code: 'RESET_ERROR',
        ...(recorded ?? {}),
        status: 'FAILED',
        error: `The force reset did not complete and the database rolled it back: ${reason}`,
      })
    }
    result = recorded
  }
  if (result.status !== 'COMPLETED') {
    const httpStatus = result.status === 'BLOCKED' || result.status === 'IN_PROGRESS' ? 409 : result.status === 'DENIED' ? 403 : 500
    return json(req, httpStatus, { code: result.code ?? result.status, ...result })
  }

  // 5. Storage clean-up and independent verification (also on a replay, so a
  //    clean-up interrupted earlier is finished now).
  const verify = async (): Promise<Verification | null> => {
    const { data, error } = await admin.rpc('erp_force_reset_verify', { p_actor: user.id, p_run_id: result.run_id })
    return error ? null : (data as Verification)
  }
  const first = await verify()
  let removed = 0
  let failedFiles = 0
  let storageError: string | null = null
  const files = first?.storage_objects ?? []
  for (const bucket of [...new Set(files.map((f) => f.bucket))]) {
    const names = files.filter((f) => f.bucket === bucket).map((f) => f.name)
    for (let i = 0; i < names.length; i += STORAGE_BATCH) {
      const batch = names.slice(i, i + STORAGE_BATCH)
      const { data, error } = await admin.storage.from(bucket).remove(batch)
      if (error) {
        failedFiles += batch.length
        storageError = error.message
      } else {
        removed += data?.length ?? 0
      }
    }
  }
  if (files.length > 0) {
    await admin.rpc('erp_force_reset_record_storage_cleanup', {
      p_actor: user.id, p_run_id: result.run_id, p_removed: removed, p_failed: failedFiles, p_error: storageError,
    })
  }
  const postCheck = files.length > 0 ? await verify() : first
  const storageCleanup = { listed: files.length, removed, failed: failedFiles, error: storageError }
  if (!postCheck?.ok) {
    return json(req, 500, {
      code: 'VERIFICATION_FAILED',
      ...result,
      status: 'VERIFICATION_FAILED',
      post_check: postCheck ? { ...postCheck, storage_objects: undefined } : null,
      storage_cleanup: storageCleanup,
      error: 'The database reset committed, but the follow-up check did not confirm it (records or Storage files remain; see post_check). Open the preview, then retry the same request to finish the clean-up.',
    })
  }
  return json(req, 200, { ...result, post_check: { ...postCheck, storage_objects: undefined }, storage_cleanup: storageCleanup })
})
