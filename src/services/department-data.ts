import type { BackupRecord, CategorySummary, DepartmentKey, Operation, PreviewResult } from '@/features/admin/department-data-model'
import { requireSupabase } from '@/lib/supabase'

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface DepartmentRun {
  id: string
  department: DepartmentKey
  operation: Operation
  categories: string[]
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED'
  started_at: string
  finished_at: string
  deleted_counts?: Record<string, number>
  deleted_total: number
  error_message: string | null
  requested_by?: string | null
  blockers?: PreviewResult['blocked']
}

export interface DepartmentOverview {
  departments: { department: DepartmentKey; categories: CategorySummary[] }[]
  generated_at: string
  backup: BackupRecord | null
  last_runs: DepartmentRun[]
}

/** Every department with its categories and current counts (Super Admin only; enforced by the database). */
export const fetchDepartmentOverview = () => rpc<DepartmentOverview>('department_data_overview', {})

/**
 * What an operation would change; nothing is changed. With `keys`, only those records (migration
 * 20261126090000); without, every candidate through the original function.
 */
export const previewDepartmentData = (department: DepartmentKey, operation: Operation, categories: string[], keys: string[] | null = null) =>
  keys
    ? rpc<PreviewResult>('department_data_preview_records', { p_department: department, p_operation: operation, p_categories: categories, p_keys: keys })
    : rpc<PreviewResult>('department_data_preview', { p_department: department, p_operation: operation, p_categories: categories })

export type ExecuteResult = DepartmentRun & { replayed?: boolean } | { status: 'DENIED' | 'IN_PROGRESS'; error: string }

/**
 * Runs the operation in one database transaction. The plan hash comes from the preview of the same
 * selection: a changed plan stops the run. `keys` = the selected records (null = every candidate).
 */
export const executeDepartmentData = (input: {
  department: DepartmentKey; operation: Operation; categories: string[]; planHash: string; confirmation: string; backupId: string | null; requestId: string
  keys?: string[] | null
}) => {
  const args = {
    p_department: input.department, p_operation: input.operation, p_categories: input.categories, p_plan_hash: input.planHash,
    p_confirmation: input.confirmation, p_backup_id: input.backupId, p_request_id: input.requestId,
  }
  return input.keys ? rpc<ExecuteResult>('department_data_execute_records', { ...args, p_keys: input.keys }) : rpc<ExecuteResult>('department_data_execute', args)
}

export const fetchDepartmentHistory = (limit = 50) => rpc<DepartmentRun[]>('department_data_history', { p_limit: limit })

/** Records the backup taken before a permanent delete (shared with the ERP reset; valid 24 h, single use). */
export const recordDataBackup = (input: { companyId: string; method: string; reference: string; takenAt: string; restoreTested: boolean; external: boolean }) =>
  rpc<BackupRecord>('erp_force_reset_record_backup', {
    p_company_id: input.companyId, p_backup_method: input.method, p_backup_reference: input.reference, p_backup_taken_at: input.takenAt,
    p_restore_tested: input.restoreTested, p_external_acknowledged: input.external, p_notes: null,
  })

/**
 * Confirms the signed-in user's password with Supabase Auth. The new session token records a password
 * sign-in with its time, which the database requires (at most 5 minutes old) for a permanent delete.
 */
export async function confirmPassword(email: string, password: string): Promise<void> {
  const { error } = await requireSupabase().auth.signInWithPassword({ email, password })
  if (error) throw Object.assign(new Error('The password is incorrect.'), { code: 'WRONG_PASSWORD' })
}
