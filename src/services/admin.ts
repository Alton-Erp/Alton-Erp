import { requireSupabase } from '@/lib/supabase'

/**
 * Phase 10 data access: notifications, approvals, barcodes, documents, import
 * history, user activity, system health, audit viewer. All rules are enforced
 * by the database functions in supabase/migrations/20261018*; the browser only
 * calls them and displays the results.
 */
const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

interface LooseQuery extends PromiseLike<{ data: unknown[] | null; error: unknown; count: number | null }> {
  eq(c: string, v: unknown): LooseQuery
  neq(c: string, v: unknown): LooseQuery
  in(c: string, v: unknown[]): LooseQuery
  is(c: string, v: null): LooseQuery
  not(c: string, op: string, v: unknown): LooseQuery
  gte(c: string, v: unknown): LooseQuery
  lte(c: string, v: unknown): LooseQuery
  lt(c: string, v: unknown): LooseQuery
  like(c: string, v: string): LooseQuery
  ilike(c: string, v: string): LooseQuery
  or(f: string): LooseQuery
  order(c: string, o?: { ascending: boolean }): LooseQuery
  range(a: number, b: number): LooseQuery
  limit(n: number): LooseQuery
}
const from = (table: string, count = false) =>
  (db().from(table as 'profiles') as unknown as { select: (c: string, o?: { count: 'exact' }) => LooseQuery }).select('*', count ? { count: 'exact' } : undefined)

async function page<T>(q: LooseQuery, p: number, size: number): Promise<{ rows: T[]; total: number }> {
  const { data, error, count } = await q.range(p * size, p * size + size - 1)
  if (error) throw error
  return { rows: (data ?? []) as T[], total: count ?? 0 }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export interface NotificationRow {
  id: string; notification_type: string; title: string; message: string; severity: Severity; related_entity_type: string | null
  related_entity_id: string | null; link: string | null; created_at: string; read_at: string | null; dismissed_at: string | null
}
export interface NotificationFilter { unreadOnly: boolean; type: string | null; severity: Severity | null; from: string | null; to: string | null }

export function fetchNotifications(f: NotificationFilter, p: number, size: number) {
  let q = from('notifications', true).is('dismissed_at', null)
  if (f.unreadOnly) q = q.is('read_at', null)
  if (f.type) q = f.type.endsWith('*') ? q.like('notification_type', f.type.replace('*', '%')) : q.eq('notification_type', f.type)
  if (f.severity) q = q.eq('severity', f.severity)
  if (f.from) q = q.gte('created_at', f.from)
  if (f.to) q = q.lt('created_at', f.to)
  return page<NotificationRow>(q.order('created_at', { ascending: false }), p, size)
}
export async function fetchUnreadCount(): Promise<number> {
  const { error, count } = await from('notifications', true).is('read_at', null).is('dismissed_at', null).limit(1)
  if (error) throw error
  return count ?? 0
}
export const markNotificationsRead = (ids: string[] | null) => rpc<number>('notifications_mark_read', { p_ids: ids })
export const dismissNotifications = (ids: string[]) => rpc<number>('notifications_dismiss', { p_ids: ids })
export const syncNotifications = (force = false) => rpc<{ created: number; skipped: boolean; last_synced_at: string }>('notifications_sync', { p_force: force })
export const setNotificationPreference = (type: string, inApp: boolean) => rpc<void>('notification_preference_set', { p_type: type, p_in_app: inApp })
export async function fetchNotificationPreferences(): Promise<Record<string, boolean>> {
  const { data, error } = await from('notification_preferences')
  if (error) throw error
  return Object.fromEntries(((data ?? []) as { notification_type: string; in_app: boolean }[]).map((r) => [r.notification_type, r.in_app]))
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
export type ApprovalDocType = 'STOCK_ADJUSTMENT' | 'STOCK_COUNT' | 'OPENING_STOCK' | 'PRODUCTION_ORDER' | 'OUTSOURCING_ORDER' | 'SALES_ORDER' | 'INVOICE'
  | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'PAYMENT_REVERSAL'
export interface ApprovalRequestItem {
  id: string; document_type: ApprovalDocType; document_id: string; reference: string; amount: number | null; status: string; workflow: string
  workflow_version: number; stage: number; stages: number; stage_name: string; required_approvals: number; stage_approvals: number
  requested_by: string | null; requested_by_name: string | null; requested_at: string; comment: string | null; decided_at: string | null
  cancel_reason: string | null; consumed_at: string | null; can_decide: boolean; mine: boolean; link: string | null; stale: boolean
  require_rejection_reason: boolean; decisions: { stage: number; decision: 'APPROVE' | 'REJECT'; comment: string | null; decided_at: string; approver: string }[]
}
export interface ModuleApprovalItem { document_type: string; reference: string; link: string; submitted_at: string | null; mine: boolean; summary: string }
export const fetchApprovalInbox = (scope: 'TO_DECIDE' | 'MINE' | 'ALL') =>
  rpc<{ requests: ApprovalRequestItem[]; module_items: ModuleApprovalItem[]; generated_at: string }>('approval_inbox', { p_scope: scope, p_limit: 200 })
export const decideApproval = (id: string, decision: 'APPROVE' | 'REJECT', comment: string | null) =>
  rpc<{ status: string; stage?: number; approvals?: number; required?: number; stale?: boolean; message?: string }>('approval_decide', { p_request_id: id, p_decision: decision, p_comment: comment })
export const submitForApproval = (type: ApprovalDocType, id: string, comment: string | null) =>
  rpc<{ status: string; request_id?: string; reference: string }>('approval_request_submit', { p_document_type: type, p_document_id: id, p_comment: comment })
export const cancelApprovalRequest = (id: string, reason: string) => rpc<{ status: string }>('approval_request_cancel', { p_request_id: id, p_reason: reason })
export const searchApprovalDocuments = (type: ApprovalDocType, term: string) =>
  rpc<{ id: string; reference: string; detail: string }[]>('approval_document_search', { p_document_type: type, p_term: term })
export const fetchApprovalStatus = (type: ApprovalDocType, id: string) =>
  rpc<{ status: string; workflow: { id: string; name: string } | null; request_id: string | null; consumed: boolean; document_state: string }>('approval_document_status',
    { p_document_type: type, p_document_id: id })

export interface WorkflowStage { id?: string; stage_no?: number; name: string; approver_roles: string[]; approver_user_ids: string[]; required_approvals: number }
export interface Workflow {
  id: string; name: string; description: string | null; document_type: ApprovalDocType; min_amount: number | null; max_amount: number | null
  allow_self_approval: boolean; distinct_stage_approvers: boolean; require_rejection_reason: boolean; escalate_after_hours: number | null
  escalate_to_role: string | null; is_active: boolean; version: number; updated_at: string; stages: WorkflowStage[]
}
export async function fetchWorkflows(): Promise<Workflow[]> {
  const [w, s] = await Promise.all([from('approval_workflows').order('name'), from('approval_workflow_stages').order('stage_no')])
  if (w.error) throw w.error
  if (s.error) throw s.error
  const stages = (s.data ?? []) as (WorkflowStage & { workflow_id: string })[]
  return ((w.data ?? []) as Omit<Workflow, 'stages'>[]).map((x) => ({ ...x, stages: stages.filter((st) => st.workflow_id === x.id) }))
}
export const saveWorkflow = (workflow: Partial<Workflow>, stages: WorkflowStage[]) =>
  rpc<{ workflow_id: string; version: number }>('approval_workflow_save', { p_workflow: workflow, p_stages: stages })
export const setWorkflowActive = (id: string, active: boolean) => rpc<{ is_active: boolean }>('approval_workflow_set_active', { p_workflow_id: id, p_active: active })

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------
export interface ScanMatch {
  kind: 'PRODUCT' | 'BATCH' | 'LOCATION' | 'WAREHOUSE' | 'DISPATCH'; id: string; label: string; detail: string; matched_on: string; link: string
  barcode?: string | null; unit?: string; status?: string; on_hand?: number | null; available?: number | null; track_batches?: boolean
  product_id?: string; source_type?: string; expiry_date?: string | null; warehouse_id?: string; usage?: string
  locations?: { location_id: string; warehouse: string; location: string; on_hand: number; reserved: number; usage: string }[]
}
export const lookupCode = (code: string) => rpc<{ code: string; internal_qr: boolean; matches: ScanMatch[] }>('barcode_lookup', { p_code: code })
export const assignBarcode = (productId: string, barcode: string | null, expectedCurrent: string | null, confirmReplace: boolean) =>
  rpc<{ product_id: string; barcode: string | null; changed: boolean }>('product_assign_barcode', {
    p_product_id: productId, p_barcode: barcode, p_expected_current: expectedCurrent, p_confirm_replace: confirmReplace,
  })
export async function fetchLabelProducts(term: string, onlyWithBarcode: boolean): Promise<{ id: string; sku: string; product_name: string; barcode: string | null; base_unit: string }[]> {
  let q = (db().from('products') as unknown as { select: (c: string) => LooseQuery }).select('id, sku, product_name, barcode, base_unit').is('archived_at', null)
  const t = term.replace(/[%,()*]/g, ' ').trim()
  if (t) q = q.or(`sku.ilike.%${t}%,product_name.ilike.%${t}%,barcode.ilike.%${t}%`)
  if (onlyWithBarcode) q = q.not('barcode', 'is', null)
  const { data, error } = await q.order('sku').limit(200)
  if (error) throw error
  return (data ?? []) as { id: string; sku: string; product_name: string; barcode: string | null; base_unit: string }[]
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export type DocEntityType = 'PRODUCT' | 'BATCH' | 'WAREHOUSE' | 'PRODUCTION_ORDER' | 'OUTSOURCING_ORDER' | 'CUSTOMER_PO' | 'SALES_ORDER' | 'DISPATCH' | 'INVOICE'
  | 'ADJUSTMENT_NOTE' | 'CUSTOMER' | 'COMPANY' | 'SUPPLIER_PO' | 'GOODS_RECEIPT' | 'STOCK_ADJUSTMENT'
export interface DocumentRow {
  id: string; company_id: string; document_type: string; title: string; description: string | null; related_entity_type: DocEntityType
  related_entity_id: string; related_reference: string; status: 'ACTIVE' | 'ARCHIVED'; current_version: number; created_by: string | null
  created_at: string; updated_at: string; archived_at: string | null; archive_reason: string | null; current_version_id: string | null
  original_filename: string | null; file_size: number | null; mime_type: string | null; extension: string | null; uploaded_at: string | null
  uploaded_by: string | null; version_count: number
}
export interface DocumentVersion {
  id: string; version: number; original_filename: string; file_size: number; mime_type: string; status: string; uploaded_by: string
  uploaded_at: string | null; change_note: string | null; checksum_sha256: string | null
}
export interface DocumentFilter { search: string; entityType: DocEntityType | null; entityId: string | null; documentType: string | null; includeArchived: boolean }
export function fetchDocuments(f: DocumentFilter, p: number, size: number) {
  let q = from('document_list', true)
  if (!f.includeArchived) q = q.eq('status', 'ACTIVE')
  if (f.entityType) q = q.eq('related_entity_type', f.entityType)
  if (f.entityId) q = q.eq('related_entity_id', f.entityId)
  if (f.documentType) q = q.eq('document_type', f.documentType)
  const t = f.search.replace(/[%,()*]/g, ' ').trim()
  if (t) q = q.or(`title.ilike.%${t}%,related_reference.ilike.%${t}%,original_filename.ilike.%${t}%,description.ilike.%${t}%`)
  return page<DocumentRow>(q.order('updated_at', { ascending: false }), p, size)
}
export async function fetchDocumentVersions(documentId: string): Promise<DocumentVersion[]> {
  const { data, error } = await from('document_versions').eq('document_id', documentId).eq('status', 'AVAILABLE').order('version', { ascending: false })
  if (error) throw error
  return (data ?? []) as DocumentVersion[]
}
export const fetchUploadRules = () => rpc<{ max_bytes: number; extensions: string[] }>('document_upload_rules')
export const searchDocumentEntities = (type: DocEntityType, term: string) => rpc<{ id: string; reference: string }[]>('document_entity_search', { p_entity_type: type, p_term: term })
export const archiveDocument = (id: string, reason: string) => rpc<{ status: string }>('document_archive', { p_document_id: id, p_reason: reason })

async function sha256Hex(file: File): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  } catch { return null }
}

/** Prepare (server validates and reserves the path) -> upload to private storage -> complete (server verifies). */
export async function uploadDocument(input: {
  entityType: DocEntityType; entityId: string; documentType: string; title: string; description: string | null; file: File; mime: string
  documentId?: string | null; changeNote?: string | null
}): Promise<{ document_id: string; version: number }> {
  const prep = await rpc<{ document_id: string; version_id: string; version: number; bucket: string; storage_path: string }>('document_upload_prepare', {
    p_entity_type: input.entityType, p_entity_id: input.entityId, p_document_type: input.documentType, p_title: input.title, p_filename: input.file.name,
    p_size: input.file.size, p_mime: input.mime, p_description: input.description, p_document_id: input.documentId ?? null, p_change_note: input.changeNote ?? null,
  })
  const { error } = await db().storage.from(prep.bucket).upload(prep.storage_path, input.file, { contentType: input.mime, upsert: false })
  if (error) {
    await rpc('document_upload_abort', { p_version_id: prep.version_id }).catch(() => undefined)
    throw error
  }
  await rpc('document_upload_complete', { p_version_id: prep.version_id, p_checksum: await sha256Hex(input.file) })
  return { document_id: prep.document_id, version: prep.version }
}

/** Authorises (and audits) the download, then asks Storage for a 60-second signed URL. */
export async function documentSignedUrl(versionId: string, download: boolean): Promise<{ url: string; fileName: string; mime: string }> {
  const d = await rpc<{ bucket: string; storage_path: string; file_name: string; mime_type: string; expires_in: number }>('document_download', { p_version_id: versionId })
  const { data, error } = await db().storage.from(d.bucket).createSignedUrl(d.storage_path, d.expires_in, download ? { download: d.file_name } : undefined)
  if (error || !data?.signedUrl) throw error ?? new Error('Could not create a download link.')
  return { url: data.signedUrl, fileName: d.file_name, mime: d.mime_type }
}

// ---------------------------------------------------------------------------
// Import history
// ---------------------------------------------------------------------------
export interface ImportJob {
  id: string; import_type: 'PRODUCTS' | 'OPENING_STOCK' | 'CUSTOMER_PO' | 'SUPPLIER_PO' | 'BOMS' | 'PRODUCTION' | 'SALES_ORDER' | 'INVOICE'; source_id: string | null; source_reference: string | null; file_name: string | null
  status: string; total_rows: number; success_rows: number; failed_rows: number; duplicate_rows: number; skipped_rows: number; retry_of_job_id: string | null
  started_by: string | null; started_at: string; completed_at: string; notes: string | null
}
export interface ImportJobRow { id: string; row_number: number; outcome: string; reference: string | null; messages: string[]; row_data: Record<string, unknown> }
export function fetchImportJobs(type: string | null, status: string | null, p: number, size: number) {
  let q = from('import_jobs', true)
  if (type) q = q.eq('import_type', type)
  if (status) q = q.eq('status', status)
  return page<ImportJob>(q.order('started_at', { ascending: false }), p, size)
}
export async function fetchImportJob(id: string): Promise<ImportJob> {
  const { data, error } = await from('import_jobs').eq('id', id).limit(1)
  if (error) throw error
  if (!data?.length) throw new Error('Import not found.')
  return data[0] as ImportJob
}
export async function fetchImportJobRows(jobId: string): Promise<ImportJobRow[]> {
  const { data, error } = await from('import_job_rows').eq('job_id', jobId).order('row_number').limit(5000)
  if (error) throw error
  return (data ?? []) as ImportJobRow[]
}
export interface ImportJobInput {
  import_type: 'PRODUCTS' | 'OPENING_STOCK' | 'BOMS'; client_job_key: string; file_name: string | null; source_id?: string | null; source_reference?: string | null
  total_rows: number; success_rows: number; failed_rows: number; duplicate_rows: number; skipped_rows: number; retry_of_job_id?: string | null; started_at?: string; status?: 'FAILED' | 'REJECTED'
}
export interface ImportJobRowInput { row_number: number; outcome: 'FAILED' | 'DUPLICATE' | 'SKIPPED'; reference: string | null; messages: string[]; row_data: Record<string, unknown> }
export const recordImportJob = (job: ImportJobInput, rows: ImportJobRowInput[]) => rpc<{ job_id: string; status: string }>('import_job_record', { p_job: job, p_rows: rows })

// ---------------------------------------------------------------------------
// Users, health, audit
// ---------------------------------------------------------------------------
export interface UserActivity {
  user_id: string; name: string; email: string; is_active: boolean; created_at: string; roles: string[]; last_activity_at: string | null
  last_sign_in_event_at: string | null; auth_last_sign_in_at?: string | null; actions_30d: number; denied_30d: number
}
export const fetchUserActivity = () => rpc<{ users: UserActivity[]; auth_sign_in_available: boolean; generated_at: string }>('user_activity_list')
export const fetchUserActivityDetail = (userId: string) =>
  rpc<{ actions: { at: string; action: string; resource_type: string; resource_id: string | null }[]; security_events: { at: string; action: string; by: string | null }[] }>(
    'user_activity_detail', { p_user_id: userId, p_limit: 50 })
export const revokeSessions = (userId: string, reason: string) => rpc<{ revoked: boolean; sessions?: number; reason?: string }>('admin_revoke_sessions', { p_user_id: userId, p_reason: reason })

export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'NOT_CONFIGURED'
export interface HealthCheck { key: string; label: string; status: HealthStatus; detail: string }
export const fetchSystemHealth = () =>
  rpc<{ checks: HealthCheck[]; checked_at: string; recent_errors: { at: string; source: string; severity: string; code: string | null; message: string; correlation_id: string }[] }>('system_health_check')

export interface AuditRow { id: string; actor_user_id: string | null; action: string; resource_type: string; resource_id: string | null; event_timestamp: string; metadata: Record<string, unknown> }
export interface AuditFilter { from: string; to: string; actor: string | null; module: string | null; action: string; entityId: string; result: 'success' | 'failure' | null }
export function fetchAuditPage(companyId: string, f: AuditFilter, p: number, size: number) {
  let q = from('audit_logs', true).eq('company_id', companyId).gte('event_timestamp', f.from).lt('event_timestamp', f.to)
  if (f.actor) q = q.eq('actor_user_id', f.actor)
  if (f.module) q = q.like('action', `${f.module}.%`)
  const a = f.action.replace(/[%,()*]/g, '').trim()
  if (a) q = q.ilike('action', `%${a}%`)
  const e = f.entityId.replace(/[%,()*]/g, '').trim()
  if (e) q = q.eq('resource_id', e)
  if (f.result === 'failure') q = q.or('action.like.%denied%,action.like.%failed%,metadata->>result.eq.failure')
  if (f.result === 'success') q = q.not('action', 'like', '%denied%').not('action', 'like', '%failed%')
  return page<AuditRow>(q.order('event_timestamp', { ascending: false }), p, size)
}
export const fetchAuditFilters = () => rpc<{ modules: string[]; actors: { id: string; name: string }[] }>('audit_log_filters')
