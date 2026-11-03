import { FunctionsHttpError } from '@supabase/supabase-js'

import {
  describeInviteFailure,
  inviteRequestBody,
  type InvitationLink,
  type InvitationRow,
  type InviteForm,
  type MyInvitation,
  type RoleCatalog,
} from '@/features/users/invitation-model'
import { describeDataError, isNetworkError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import type { ProfileRow, RoleRow } from '@/types/database'

export interface CompanyUser extends Pick<ProfileRow, 'id' | 'full_name' | 'email' | 'is_active' | 'created_at'> {
  roles: { assignmentId: string; roleId: string; code: string; name: string }[]
}

export interface UsersData {
  users: CompanyUser[]
  roles: RoleRow[]
}

/** Users of the company with their roles. RLS returns rows only to users.manage holders. */
export async function fetchCompanyUsers(companyId: string): Promise<UsersData> {
  const db = requireSupabase()
  const [profiles, assignments, roles] = await Promise.all([
    db.from('profiles').select('id, full_name, email, is_active, created_at').eq('company_id', companyId).order('full_name'),
    db.from('user_roles').select('id, user_id, role_id').eq('company_id', companyId),
    db.from('roles').select('*').order('name'),
  ])
  for (const result of [profiles, assignments, roles]) if (result.error) throw result.error

  const roleById = new Map((roles.data ?? []).map((r) => [r.id, r]))
  const users = (profiles.data ?? []).map((p) => ({
    ...p,
    roles: (assignments.data ?? [])
      .filter((a) => a.user_id === p.id)
      .map((a) => {
        const role = roleById.get(a.role_id)
        return { assignmentId: a.id, roleId: a.role_id, code: role?.code ?? '?', name: role?.name ?? 'Unknown role' }
      }),
  }))
  return { users, roles: roles.data ?? [] }
}

export async function setUserActive(userId: string, active: boolean): Promise<void> {
  const { error, count } = await requireSupabase()
    .from('profiles')
    .update({ is_active: active }, { count: 'exact' })
    .eq('id', userId)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

/** Applies role changes for one user as a set of grants and revokes. */
export async function updateUserRoles(params: {
  userId: string
  companyId: string
  actorId: string
  grantRoleIds: string[]
  revokeAssignmentIds: string[]
}): Promise<void> {
  const db = requireSupabase()
  if (params.grantRoleIds.length > 0) {
    const { error } = await db.from('user_roles').insert(
      params.grantRoleIds.map((roleId) => ({
        user_id: params.userId,
        company_id: params.companyId,
        role_id: roleId,
        assigned_by: params.actorId,
      })),
    )
    if (error) throw error
  }
  if (params.revokeAssignmentIds.length > 0) {
    const { error, count } = await db
      .from('user_roles')
      .delete({ count: 'exact' })
      .in('id', params.revokeAssignmentIds)
    if (error) throw error
    if (count !== params.revokeAssignmentIds.length) {
      throw Object.assign(new Error('not permitted'), { code: '42501' })
    }
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

/** Roles the signed-in admin can see for invitations, with modules, permissions and whether they may assign each. */
export const fetchRoleCatalog = () => rpc<RoleCatalog>('invite_role_catalog')
export const fetchInvitations = async () => (await rpc<InvitationRow[] | null>('user_invitations_list')) ?? []
/** The signed-in invitee's own invitation (null when there is none). */
export const fetchMyInvitation = () => rpc<MyInvitation | null>('my_invitation')
export const acceptMyInvitation = () => rpc<{ status: string; error?: string; already_accepted?: boolean }>('user_invitation_accept')

/**
 * Turns an invitation link into a Supabase session (see parseInvitationLink).
 * Tokens are removed from the address bar afterwards. Returns an error message or null.
 */
export async function establishInvitationSession(link: InvitationLink): Promise<string | null> {
  const db = requireSupabase()
  let error: { message: string } | null = null
  if (link.kind === 'token_hash') ({ error } = await db.auth.verifyOtp({ token_hash: link.tokenHash, type: link.type }))
  else if (link.kind === 'tokens') ({ error } = await db.auth.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken }))
  else return link.kind === 'error' ? link.message : null
  window.history.replaceState(null, '', window.location.pathname)
  return error ? 'This invitation link is invalid, has expired, or was already used.' : null
}

/** An error from the invite-user service; `message` is safe to show. */
export class InviteServiceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'InviteServiceError'
  }
}

export interface InviteResult {
  ok: true
  duplicate?: boolean
  resent?: boolean
  invitation_id: string
  email: string
  roles: string[]
  expires_at: string
  email_status?: string
  delivery?: 'AUTH_INVITE' | 'PASSWORD_LINK'
  auth_user_deleted?: boolean
}

/**
 * Calls the `invite-user` Edge Function, which does the privileged Supabase Auth
 * work server-side. Resolves only on a confirmed success; every failure throws
 * an InviteServiceError with a clear message (never a false success).
 */
async function callInviteService(body: Record<string, unknown>): Promise<InviteResult> {
  let data: unknown
  let error: unknown
  try {
    ;({ data, error } = await requireSupabase().functions.invoke('invite-user', { body }))
  } catch (e) {
    error = e
  }
  if (!error) {
    const result = data as Partial<InviteResult> | null
    if (result && result.ok === true) return result as InviteResult
    throw new InviteServiceError('SERVER_ERROR', describeInviteFailure(500, null).message)
  }
  if (error instanceof FunctionsHttpError) {
    const response = error.context instanceof Response ? error.context : null
    let parsed: { code?: unknown; error?: unknown } | null = null
    try {
      parsed = response ? ((await response.json()) as typeof parsed) : null
    } catch {
      // unreadable body
    }
    const f = describeInviteFailure(response?.status ?? 500, parsed)
    throw new InviteServiceError(f.code, f.message)
  }
  // FunctionsFetchError / FunctionsRelayError: the request never got a reply.
  const name = (error as { name?: string })?.name
  if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError' || isNetworkError(error)) {
    const f = describeInviteFailure(0, null)
    throw new InviteServiceError(f.code, f.message)
  }
  throw new InviteServiceError('SERVER_ERROR', describeDataError(error))
}

/** Sends a new invitation. Reuse the same idempotency key when retrying the same form. */
export const inviteUser = (form: InviteForm, idempotencyKey: string) => callInviteService(inviteRequestBody(form, idempotencyKey))

export const resendInvitation = (invitationId: string, idempotencyKey: string = crypto.randomUUID()) =>
  callInviteService({ action: 'resend', invitation_id: invitationId, idempotency_key: idempotencyKey })

export const revokeInvitation = (invitationId: string, reason: string) =>
  callInviteService({ action: 'revoke', invitation_id: invitationId, reason: reason.trim() })
