// Supabase Edge Function: invite-user
//
// Invites a staff member by email, assigns them to the CALLER's company,
// activates the profile and grants the requested roles.
//
// Security model
//   * Runs server-side; the service-role key is read from the function's
//     environment (injected by Supabase) and never reaches the browser.
//   * The caller is identified from their own JWT; their permissions are read
//     from the database (get_my_access), never from the request body.
//   * Requires users.manage. SUPER_ADMIN can only be granted by a Super Admin.
//   * The company is always the caller's company; a client cannot choose it.
//   * If any step after the invitation fails, the new auth user is deleted so
//     no half-provisioned account is left behind.
//
// Deploy:  supabase functions deploy invite-user
// Secrets: INVITE_REDIRECT_URL (e.g. https://erp.example.com/reset-password)
//          ALLOWED_ORIGINS     (comma-separated, e.g. https://erp.example.com)

import { createClient } from 'npm:@supabase/supabase-js@2'

const ROLE_CODES = new Set([
  'SUPER_ADMIN',
  'ADMIN',
  'INVENTORY_MANAGER',
  'PRODUCTION_MANAGER',
  'PURCHASE_MANAGER',
  'SALES_MANAGER',
  'ACCOUNTS_MANAGER',
  'MANAGEMENT_VIEWER',
])
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const origin = req.headers.get('Origin') ?? ''
  const allowOrigin = allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0]
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, 405, { error: 'Method not allowed' })

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json(req, 401, { error: 'Not signed in' })

  const url = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json(req, 500, { error: 'Function is not configured' })

  // 1. Identify the caller with their own token (RLS applies).
  const caller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data: userData, error: userError } = await caller.auth.getUser()
  if (userError || !userData.user) return json(req, 401, { error: 'Session is invalid or expired' })
  const callerId = userData.user.id

  const { data: access, error: accessError } = await caller.rpc('get_my_access')
  if (accessError || !access) return json(req, 403, { error: 'Could not verify your access' })
  const permissions: string[] = access.permissions ?? []
  const callerRoles: string[] = access.roles ?? []
  const companyId: string | undefined = access.company?.id
  if (!companyId || !access.profile?.is_active || !access.company?.is_active || !permissions.includes('users.manage')) {
    return json(req, 403, { error: 'You are not allowed to invite users' })
  }

  // 2. Validate input.
  let body: { email?: unknown; full_name?: unknown; role_codes?: unknown }
  try {
    body = await req.json()
  } catch {
    return json(req, 400, { error: 'Invalid request body' })
  }
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const fullName = typeof body.full_name === 'string' ? body.full_name.trim().slice(0, 120) : ''
  const roleCodes = Array.isArray(body.role_codes) ? [...new Set(body.role_codes.filter((c): c is string => typeof c === 'string'))] : []

  if (!EMAIL_RE.test(email) || email.length > 320) return json(req, 400, { error: 'Enter a valid email address' })
  if (roleCodes.length === 0) return json(req, 400, { error: 'Select at least one role' })
  if (roleCodes.some((c) => !ROLE_CODES.has(c))) return json(req, 400, { error: 'Unknown role' })
  if (roleCodes.includes('SUPER_ADMIN') && !callerRoles.includes('SUPER_ADMIN')) {
    return json(req, 403, { error: 'Only a Super Admin can grant the Super Admin role' })
  }

  // 3. Privileged steps with the service role.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data: roles, error: rolesError } = await admin.from('roles').select('id, code').in('code', roleCodes)
  if (rolesError || !roles || roles.length !== roleCodes.length) return json(req, 500, { error: 'Could not load roles' })

  const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: Deno.env.get('INVITE_REDIRECT_URL') ?? undefined,
    data: fullName ? { full_name: fullName } : undefined,
  })
  if (inviteError || !invited.user) {
    const exists = /already|registered|exists/i.test(inviteError?.message ?? '')
    return json(req, exists ? 409 : 502, {
      error: exists ? 'A user with this email already exists' : 'The invitation email could not be sent',
    })
  }
  const newUserId = invited.user.id

  try {
    // Profile row is created by the on_auth_user_created trigger.
    const { error: profileError, count } = await admin
      .from('profiles')
      .update({ company_id: companyId, is_active: true, ...(fullName ? { full_name: fullName } : {}) }, { count: 'exact' })
      .eq('id', newUserId)
      .is('company_id', null)
    if (profileError || count !== 1) throw new Error('profile')

    const { error: grantError } = await admin
      .from('user_roles')
      .insert(roles.map((r) => ({ user_id: newUserId, company_id: companyId, role_id: r.id, assigned_by: callerId })))
    if (grantError) throw new Error('roles')

    await admin.from('audit_logs').insert({
      company_id: companyId,
      actor_user_id: callerId,
      action: 'user.invited',
      resource_type: 'profile',
      resource_id: newUserId,
      metadata: { roles: roleCodes },
    })
  } catch {
    await admin.auth.admin.deleteUser(newUserId)
    return json(req, 500, { error: 'The user could not be provisioned; the invitation was withdrawn' })
  }

  return json(req, 200, { user_id: newUserId })
})
