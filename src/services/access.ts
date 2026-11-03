import { requireSupabase } from '@/lib/supabase'

export interface AccessProfile {
  id: string
  email: string
  full_name: string | null
  company_id: string | null
  is_active: boolean
}

export interface AccessCompany {
  id: string
  legal_name: string
  display_name: string
  company_code: string
  currency_code: string
  timezone: string
  is_active: boolean
}

export interface MyAccess {
  profile: AccessProfile | null
  company: AccessCompany | null
  roles: string[]
  permissions: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Calls get_my_access() and validates the shape of the response. */
export async function fetchMyAccess(): Promise<MyAccess> {
  const { data, error } = await requireSupabase().rpc('get_my_access')
  if (error) throw error
  if (!isObject(data)) throw new Error('Unexpected access response')

  const profile = isObject(data.profile) ? (data.profile as unknown as AccessProfile) : null
  const company = isObject(data.company) ? (data.company as unknown as AccessCompany) : null
  return {
    profile,
    company,
    roles: stringArray(data.roles),
    permissions: stringArray(data.permissions),
  }
}

/** Fire-and-forget audit event. Failures are ignored (never block the user flow). */
export function logSecurityEvent(
  action: 'auth.sign_in' | 'auth.sign_out' | 'auth.access_denied' | 'auth.password_changed',
  metadata: { path?: string; reason?: string } = {},
): Promise<void> {
  return Promise.resolve(requireSupabase().rpc('log_security_event', { p_action: action, p_metadata: metadata }))
    .then(() => undefined)
    .catch(() => undefined)
}
