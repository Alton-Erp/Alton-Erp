import { FunctionsHttpError } from '@supabase/supabase-js'

import { isVerifiedSuccess, type ResetTableCount } from '@/features/admin/erp-reset-model'
import { describeDataError, isNetworkError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'

export { RESET_CONFIRMATION, groupDeletion, isVerifiedSuccess, type ResetTableCount } from '@/features/admin/erp-reset-model'

export interface ResetBlocker {
  kind: 'PROTECTED_RECORDS' | 'ATTACHED_DOCUMENTS' | 'UNCLASSIFIED_TABLE'
  table: string
  label: string
  category: string
  rows: number | null
  reason: string
}

export interface ResetRunSummary {
  id: string
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED'
  started_at: string
  requested_by: string
  deleted_total: number
  error_message: string | null
}

export interface ResetPreview {
  company_id: string
  can_reset: boolean
  blockers: ResetBlocker[]
  delete: ResetTableCount[]
  delete_total: number
  keep: ResetTableCount[]
  kept_suppliers: number
  generated_at: string
  recent_runs: ResetRunSummary[]
}

export type ResetStatus = 'COMPLETED' | 'BLOCKED' | 'FAILED' | 'DENIED' | 'IN_PROGRESS' | 'VERIFICATION_FAILED'

export interface ResetResult {
  status: ResetStatus
  run_id?: string
  request_id?: string
  replayed?: boolean
  deleted?: Record<string, number>
  deleted_total?: number
  preserved?: Record<string, number>
  kept_suppliers?: number
  blockers?: ResetBlocker[]
  verification?: Record<string, unknown>
  post_check?: { ok: boolean; remaining?: Record<string, number>; actor_access_valid?: boolean } | null
  error?: string | null
}

/** A reset that did not complete, with the server's explanation. */
export class ResetError extends Error {
  readonly code: string
  readonly result: ResetResult | null
  constructor(code: string, message: string, result: ResetResult | null = null) {
    super(message)
    this.code = code
    this.result = result
  }
}

export const RESET_NOT_DEPLOYED =
  'The reset service is not reachable. Deploy the reset-erp-data Edge Function (see docs/ERP_RESET.md). Nothing was deleted.'

/** Read-only impact report (Super Admin with system.reset_data only; enforced by the database). */
export async function fetchResetPreview(): Promise<ResetPreview> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string) => Promise<{ data: ResetPreview; error: unknown }>)('erp_reset_preview')
  if (error) throw error
  return data
}

/**
 * Runs the reset through the reset-erp-data Edge Function. The password goes
 * only to that function (over HTTPS) and is not kept anywhere in the browser
 * after the call. Resolves only for a verified completed reset; throws
 * ResetError otherwise.
 */
export async function runErpReset(input: { password: string; confirmation: string; requestId: string }): Promise<ResetResult> {
  const { data, error } = await requireSupabase().functions.invoke('reset-erp-data', {
    body: { password: input.password, confirmation: input.confirmation, request_id: input.requestId },
  })
  if (!error) {
    const result = data as ResetResult
    if (!isVerifiedSuccess(result)) throw new ResetError('UNVERIFIED', 'The reset could not be confirmed. Do not assume data was deleted; open the preview again.', result)
    return result
  }
  if (error instanceof FunctionsHttpError) {
    const status = error.context instanceof Response ? error.context.status : 0
    if (status === 404) throw new ResetError('NOT_DEPLOYED', RESET_NOT_DEPLOYED)
    let body: (ResetResult & { code?: string }) | null = null
    try {
      body = (await (error.context as Response).json()) as ResetResult & { code?: string }
    } catch {
      // unreadable body
    }
    throw new ResetError(body?.code ?? String(status), body?.error ?? describeDataError({ status }), body)
  }
  if (isNetworkError(error) || error.name === 'FunctionsRelayError') throw new ResetError('NOT_DEPLOYED', RESET_NOT_DEPLOYED)
  throw new ResetError('ERROR', describeDataError(error))
}

/** One random id per confirmation dialog: retries of the same submission are idempotent on the server. */
export const newResetRequestId = (): string => crypto.randomUUID()
