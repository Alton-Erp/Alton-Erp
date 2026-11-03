import { requireSupabase } from '@/lib/supabase'
import type { AuditLogRow } from '@/types/database'

export const AUDIT_LOG_LIMIT = 500

export interface AuditLogData {
  entries: AuditLogRow[]
  /** Actor display names keyed by user id (profiles visible under RLS). */
  actors: Map<string, string>
  truncated: boolean
}

/** History of one record (requires audit_logs.read; RLS returns nothing otherwise). */
export async function fetchResourceAudit(resourceType: string, resourceId: string): Promise<AuditLogRow[]> {
  const { data, error } = await requireSupabase()
    .from('audit_logs')
    .select('*')
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .order('event_timestamp', { ascending: false })
    .limit(100)
  if (error) throw error
  return data ?? []
}

export async function fetchAuditLogs(params: {
  companyId: string
  from: Date
  to: Date
  resourceType?: string
}): Promise<AuditLogData> {
  const db = requireSupabase()
  let query = db
    .from('audit_logs')
    .select('*')
    .eq('company_id', params.companyId)
    .gte('event_timestamp', params.from.toISOString())
    .lte('event_timestamp', params.to.toISOString())
    .order('event_timestamp', { ascending: false })
    .limit(AUDIT_LOG_LIMIT + 1)
  if (params.resourceType) query = query.eq('resource_type', params.resourceType)

  const [logs, profiles] = await Promise.all([
    query,
    db.from('profiles').select('id, full_name, email').eq('company_id', params.companyId),
  ])
  if (logs.error) throw logs.error
  if (profiles.error) throw profiles.error

  const entries = logs.data ?? []
  return {
    entries: entries.slice(0, AUDIT_LOG_LIMIT),
    truncated: entries.length > AUDIT_LOG_LIMIT,
    actors: new Map((profiles.data ?? []).map((p) => [p.id, p.full_name || p.email])),
  }
}
