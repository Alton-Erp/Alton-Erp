import { FunctionsHttpError } from '@supabase/supabase-js'

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

/**
 * Invites a user through the `invite-user` Edge Function, which performs the
 * privileged Admin API call server-side. Returns a user-facing error message.
 */
export async function inviteUser(input: { email: string; fullName: string; roleCodes: string[] }): Promise<void> {
  const { error } = await requireSupabase().functions.invoke('invite-user', {
    body: { email: input.email, full_name: input.fullName, role_codes: input.roleCodes },
  })
  if (!error) return

  if (error instanceof FunctionsHttpError) {
    const status = error.context instanceof Response ? error.context.status : 0
    let message: string | undefined
    try {
      const body = (await (error.context as Response).json()) as { error?: unknown }
      if (typeof body.error === 'string') message = body.error
    } catch {
      // ignore unreadable body
    }
    if (status === 404) throw new Error(INVITE_NOT_DEPLOYED)
    throw new Error(message ?? describeDataError({ status }))
  }
  if (isNetworkError(error) || error.name === 'FunctionsRelayError') throw new Error(INVITE_NOT_DEPLOYED)
  throw new Error(describeDataError(error))
}

export const INVITE_NOT_DEPLOYED =
  'The invitation service is not reachable. Deploy the invite-user Edge Function (see docs/SUPABASE_SETUP.md). No invitation was sent.'
