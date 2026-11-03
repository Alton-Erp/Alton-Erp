import type { DraftFormKey, ServerDraft } from '@/features/drafts/draft-model'
import { requireSupabase } from '@/lib/supabase'

/**
 * Form drafts (migration 20261117090000_form_drafts.sql). The company and user
 * come from the session; the database checks the form's permissions.
 */
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface DraftRef {
  formKey: DraftFormKey
  recordId: string | null
  scope: string
}

export const fetchFormDraft = (ref: DraftRef) =>
  rpc<ServerDraft | null>('erp_form_draft_get', { p_form_key: ref.formKey, p_record_id: ref.recordId, p_scope: ref.scope })

export const saveFormDraft = (ref: DraftRef, data: unknown, baseVersion: string | null, expectedVersion: number) =>
  rpc<{ status: 'SAVED' | 'CONFLICT'; draft: ServerDraft }>('erp_form_draft_save', {
    p_form_key: ref.formKey, p_record_id: ref.recordId, p_scope: ref.scope, p_data: data, p_base_version: baseVersion, p_expected_version: expectedVersion,
  })

export const closeFormDraft = (ref: DraftRef, status: 'submitted' | 'discarded') =>
  rpc<ServerDraft | { status: string; version: number }>('erp_form_draft_close', { p_form_key: ref.formKey, p_record_id: ref.recordId, p_scope: ref.scope, p_status: status })
