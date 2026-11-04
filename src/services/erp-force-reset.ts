import { isVerifiedForceSuccess } from '@/features/admin/erp-force-reset-model'
import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'

export {
  FORCE_SUCCESS_MESSAGE,
  canStartForceReset,
  forceGates,
  isVerifiedForceSuccess,
} from '@/features/admin/erp-force-reset-model'

export interface ForceTable {
  table: string
  category: string
  label: string
  rows: number
  order: number
  protected: boolean
  protection: string | null
}

export interface ForceBlocker {
  kind: string
  table: string | null
  label: string
  rows: number | null
  reason: string
}

export interface ForcePreview {
  company: { id: string; code: string; name: string }
  tables: ForceTable[]
  delete_total: number
  protected_total: number
  retained: { table: string; label: string; reason: string; rows: number }[]
  blockers: ForceBlocker[]
  unaffected_tables: string[]
  discovered_tables: number
  demo_presentation_data: 'NOT_PRESENT' | 'RESETTABLE' | 'NOT_COMPANY_SCOPED'
  storage: { product_images: number; documents: number }
  gates: { authorized: boolean; plan_reviewed: boolean }
  can_execute: boolean
  generated_at: string
}

export type ForceStatus = 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'DENIED' | 'IN_PROGRESS'

export interface ForceResult {
  status: ForceStatus
  mode?: 'FORCE'
  run_id?: string
  request_id?: string
  replayed?: boolean
  deleted?: Record<string, number>
  deleted_total?: number
  blockers?: ForceBlocker[]
  verification?: Record<string, unknown>
  storage_files?: { bucket: string; name: string }[]
  storage_cleanup?: { listed: number; removed: number; failed: number }
  error?: string | null
}

export interface ResetRun {
  id: string
  mode: 'STANDARD' | 'FORCE'
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED'
  started_at: string
  finished_at: string
  requested_by: string
  deleted_total: number
  deleted_counts: Record<string, number>
  blockers: ForceBlocker[]
  error_message: string | null
  backup_id: string | null
  approval_id: string | null
}

/** A force reset that did not complete, with the server's explanation. Nothing was deleted. */
export class ForceResetError extends Error {
  readonly code: string
  readonly result: ForceResult | null
  constructor(code: string, message: string, result: ForceResult | null = null) {
    super(message)
    this.code = code
    this.result = result
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

/** Read-only inventory of what a force reset would delete and keep (Super Admin with system.reset_data; enforced by the database). */
export const fetchForcePreview = (companyId: string) => rpc<ForcePreview>('erp_force_reset_preview', { p_company_id: companyId })

/** Standard and force reset attempts of the company, newest first (RLS: system.reset_data holders only). */
export async function fetchResetHistory(): Promise<ResetRun[]> {
  type Q = PromiseLike<{ data: ResetRun[] | null; error: unknown }> & { order(c: string, o: { ascending: boolean }): Q; limit(n: number): Q; in(c: string, v: string[]): Q }
  const q = (requireSupabase().from('erp_reset_runs' as 'profiles') as unknown as { select(c: string): Q })
    .select('id, mode, status, started_at, finished_at, requested_by, deleted_total, deleted_counts, blockers, error_message, backup_id, approval_id')
    // Department data operations have their own history (Data Management).
    .in('mode', ['STANDARD', 'FORCE'])
    .order('started_at', { ascending: false })
    .limit(50)
  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

/**
 * Deletes all business data of the company directly (erp_force_reset_now:
 * Super Admin with system.reset_data; one database transaction, verified
 * before commit). Then removes the company's stored files that the browser may
 * delete. Throws ForceResetError when the reset did not complete.
 */
export async function runForceReset(input: { companyId: string; requestId: string }): Promise<ForceResult> {
  let result: ForceResult
  try {
    result = await rpc<ForceResult>('erp_force_reset_now', { p_company_id: input.companyId, p_request_id: input.requestId })
  } catch (e) {
    throw new ForceResetError('ERROR', describeDataError(e))
  }
  if (!isVerifiedForceSuccess(result)) {
    throw new ForceResetError(result?.status ?? 'ERROR', result?.error ?? 'The force reset did not complete. Nothing was deleted.', result)
  }

  // Stored files of the deleted records (best effort: the database rows are already gone).
  const files = result.storage_files ?? []
  let removed = 0
  let failed = 0
  for (const bucket of [...new Set(files.map((f) => f.bucket))]) {
    const names = files.filter((f) => f.bucket === bucket).map((f) => f.name)
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100)
      try {
        const { data, error } = await requireSupabase().storage.from(bucket).remove(batch)
        const n = error ? 0 : (data?.length ?? 0)
        removed += n
        failed += batch.length - n
      } catch {
        failed += batch.length
      }
    }
  }
  return { ...result, storage_cleanup: { listed: files.length, removed, failed } }
}
