import type { AmazonSettings, CampaignRow, ProductRow, SearchTermRow } from '@/features/amazon/analysis'
import type { ImportKind } from '@/features/amazon/report-import'
import type { Recommendation, SuggestedChange } from '@/features/amazon/recommendations'
import { requireSupabase } from '@/lib/supabase'

export { stableUuid } from '@/features/amazon/request-id'

/**
 * Amazon Intelligence data access. Reads use the RLS-protected tables and the
 * amazon_* database functions; writes go only through permission-checked
 * functions. Amazon API calls go through the amazon-spapi / amazon-ads Edge
 * Functions, which hold the Amazon credentials server-side.
 */
const db = () => requireSupabase()

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (db().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}
type Loose = PromiseLike<{ data: unknown[] | null; error: unknown; count: number | null }> & {
  eq(c: string, v: unknown): Loose; in(c: string, v: unknown[]): Loose; like(c: string, v: string): Loose; order(c: string, o?: { ascending: boolean }): Loose
  range(a: number, b: number): Loose; limit(n: number): Loose
}
const from = (table: string, count = false) =>
  (db().from(table as 'profiles') as unknown as { select: (c: string, o?: { count: 'exact' }) => Loose }).select('*', count ? { count: 'exact' } : undefined)
async function rows<T>(q: Loose): Promise<T[]> {
  const { data, error } = await q
  if (error) throw error
  return (data ?? []) as T[]
}
async function page<T>(q: Loose, p: number, size: number): Promise<{ rows: T[]; total: number }> {
  const { data, error, count } = await q.range(p * size, p * size + size - 1)
  if (error) throw error
  return { rows: (data ?? []) as T[], total: count ?? 0 }
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
export interface Connection {
  api: 'SP_API' | 'ADS_API'
  status: 'NOT_CONFIGURED' | 'CONFIGURED' | 'CONNECTED' | 'ERROR' | 'DISCONNECTED'
  account_identifier: string | null; account_name: string | null; region: string | null; marketplace_ids: string[]; profile_id: string | null
  permissions: { name: string; status: string; detail: string }[]
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null
  last_successful_sync_at: string | null; last_error_at: string | null; last_error_message: string | null; updated_at: string
}
export interface DataStatus {
  demo: boolean; listings: number; mapped_listings: number; sales_days: number; fee_days: number; campaign_days: number; ad_product_days: number
  search_term_days: number; inventory_snapshot_at: string | null; last_sales_date: string | null; last_ads_date: string | null; period_days: number; connections: Connection[]
}
export const fetchDataStatus = (from: string, to: string, demo: boolean) => rpc<DataStatus>('amazon_data_status', { p_from: from, p_to: to, p_demo: demo })

export interface ProductPerformance { from: string; to: string; today: string; demo: boolean; settings: AmazonSettings; rows: ProductRow[]; generated_at: string }
export const fetchProductPerformance = (from: string, to: string, demo: boolean) => rpc<ProductPerformance>('amazon_product_performance', { p_from: from, p_to: to, p_demo: demo })

export interface DayComponents {
  ordered_sales: number | null; units: number | null; order_items: number | null; sessions: number | null; refund_amount: number | null; promotion_discounts: number | null
  sales_ex_gst: number | null; refunds_ex_gst: number | null; discounts_ex_gst: number | null; gst_missing: boolean | null
  actual_referral: number | null; actual_fulfilment: number | null; actual_other: number | null; est_referral: number | null; est_fulfilment: number | null; fee_missing_days: number | null
  shipping_cost: number | null; other_variable_cost: number | null; product_cost: number | null; units_without_cost: number | null
  ad_spend: number | null; ad_sales: number | null; ad_orders: number | null; ad_clicks: number | null; ad_impressions: number | null; sales_days: number | null
}
export interface DayRow { date: string; components: DayComponents | null; account_ads: { spend: number; sales: number; orders: number; clicks: number; impressions: number; budget: number | null; rows: number } | null }
export const fetchDailySeries = (from: string, to: string, demo: boolean, sku?: string | null) =>
  rpc<{ days: DayRow[] }>('amazon_daily_series', { p_from: from, p_to: to, p_demo: demo, p_seller_sku: sku ?? null })

export const fetchCampaignPerformance = (from: string, to: string, demo: boolean) => rpc<{ rows: CampaignRow[] }>('amazon_campaign_performance', { p_from: from, p_to: to, p_demo: demo })

export interface CampaignDetail {
  campaign: CampaignRow & { daily_budget: number | null }
  days: { date: string; impressions: number; clicks: number; spend: number; sales: number; orders: number; budget: number | null }[]
  ad_groups: { ad_group_id: string; name: string; state: string; default_bid: number | null }[]
  targets: { target_id: string; ad_group_id: string | null; expression: string; match_type: string | null; target_type: string; state: string; bid: number | null
    impressions: number; clicks: number; spend: number; sales: number; orders: number }[]
  products: { seller_sku: string; asin: string | null; impressions: number; clicks: number; spend: number; sales: number; orders: number; units: number }[]
  placements: { available: boolean; reason: string }
}
export const fetchCampaignDetail = (campaignId: string, from: string, to: string, demo: boolean) =>
  rpc<CampaignDetail>('amazon_campaign_detail', { p_campaign_id: campaignId, p_from: from, p_to: to, p_demo: demo })

export const fetchSearchTerms = (from: string, to: string, demo: boolean, opts: { campaignId?: string | null; search?: string; limit?: number; offset?: number } = {}) =>
  rpc<{ total: number; rows: SearchTermRow[] }>('amazon_search_terms', { p_from: from, p_to: to, p_demo: demo, p_campaign_id: opts.campaignId ?? null, p_search: opts.search ?? null,
    p_limit: opts.limit ?? 500, p_offset: opts.offset ?? 0 })

// ---------------------------------------------------------------------------
// Settings, connections, listings
// ---------------------------------------------------------------------------
export async function fetchSettings(): Promise<AmazonSettings> {
  const r = await rows<AmazonSettings>(from('amazon_settings').limit(1))
  if (!r[0]) throw new Error('Amazon settings are not available for your company.')
  return r[0]
}
export const updateSettings = (changes: Partial<AmazonSettings>) => rpc<AmazonSettings>('amazon_settings_update', { p_changes: changes })
export const fetchConnections = () => rows<Connection>(from('amazon_connections').order('api'))

export interface Listing {
  id: string; marketplace_id: string; seller_sku: string; asin: string | null; title: string | null; product_id: string | null; listing_status: string | null; item_price: number | null
  fulfillment_channel: string | null; referral_fee_pct: number | null; closing_fee_per_unit: number | null; fulfilment_fee_per_unit: number | null; shipping_cost_per_unit: number | null
  other_variable_cost_per_unit: number | null; gst_rate: number | null; unit_cost_override: number | null; cost_note: string | null; costs_updated_at: string | null
  desired_contribution_per_unit: number | null; target_acos_pct: number | null; min_stock: number | null; lead_time_days: number | null; advertising_status: string
  data_source: 'API' | 'CSV' | 'MANUAL' | 'DEMO'; is_demo: boolean; last_synced_at: string | null; updated_at: string
}
export const fetchListings = (demo: boolean) => rows<Listing>(from('amazon_listings').eq('is_demo', demo).order('seller_sku'))
export const saveListing = (listing: Partial<Listing> & { id?: string }) => rpc<{ id: string }>('amazon_listing_save', { p_listing: listing })
export const autoMapListings = () => rpc<{ mapped: number; conflicts: number }>('amazon_listing_auto_map')

export interface ErpProduct { id: string; sku: string; product_name: string; standard_cost: number | null; gst_rate: number | null; hsn_code: string | null; base_unit: string }
export async function fetchErpProducts(): Promise<ErpProduct[]> {
  const { data, error } = await (db().from('products') as unknown as { select: (c: string) => { is: (c: string, v: null) => { order: (c: string) => { limit: (n: number) => Promise<{ data: unknown[]; error: unknown }> } } } })
    .select('id, sku, product_name, standard_cost, gst_rate, hsn_code, base_unit').is('archived_at', null).order('sku').limit(5000)
  if (error) throw error
  return (data ?? []) as ErpProduct[]
}

// ---------------------------------------------------------------------------
// Imports and demo data
// ---------------------------------------------------------------------------
export interface ImportResult { job_id: string; duplicate: boolean; status: string; received: number; inserted: number; updated: number; skipped: number; errors: { row: number; message: string }[] }
export const importRows = (kind: ImportKind, data: Record<string, unknown>[], fileName: string, key: string) =>
  rpc<ImportResult>('amazon_import_rows', { p_kind: kind, p_rows: data, p_file_name: fileName, p_idempotency_key: key })
export const loadDemo = (days = 60) => rpc<{ job_id: string; rows: number; days: number }>('amazon_demo_load', { p_days: days })
export const clearDemo = () => rpc<{ deleted: number }>('amazon_demo_clear')

// ---------------------------------------------------------------------------
// Recommendations, budget plans, ad change requests
// ---------------------------------------------------------------------------
export interface StoredRecommendation extends Omit<Recommendation, 'change' | 'financial'> {
  /** The suggested change (if any) is kept inside financial.change. */
  financial: Recommendation['financial'] & { change?: SuggestedChange | null }
  id: string; status: 'OPEN' | 'ACCEPTED' | 'DISMISSED' | 'EXECUTED' | 'SUPERSEDED'; status_note: string | null; outcome: Record<string, unknown> | null; is_demo: boolean
  created_at: string; updated_at: string
}
export const fetchRecommendations = (demo: boolean) => rows<StoredRecommendation>(from('amazon_recommendations').eq('is_demo', demo).order('priority', { ascending: false }).limit(1000))
export const saveRecommendations = (items: Recommendation[], demo: boolean) =>
  rpc<{ saved: number; superseded: number }>('amazon_recommendations_save', { p_items: items.map(({ change, ...r }) => ({ ...r, financial: { ...r.financial, change: change ?? null } })), p_demo: demo })
export const setRecommendationStatus = (id: string, status: 'OPEN' | 'ACCEPTED' | 'DISMISSED' | 'EXECUTED', note?: string | null, outcome?: Record<string, unknown> | null) =>
  rpc<{ id: string; status: string }>('amazon_recommendation_set_status', { p_id: id, p_status: status, p_note: note ?? null, p_outcome: outcome ?? null })

export interface BudgetPlan { id: string; name: string; month: string; inputs: Record<string, unknown>; allocation: Record<string, unknown>; assumptions: string[]; is_demo: boolean; created_at: string; created_by: string | null }
export const fetchBudgetPlans = (demo: boolean) => rows<BudgetPlan>(from('amazon_budget_plans').eq('is_demo', demo).order('created_at', { ascending: false }).limit(50))
export const saveBudgetPlan = (name: string, month: string, inputs: unknown, allocation: unknown, assumptions: string[], demo: boolean) =>
  rpc<{ id: string }>('amazon_budget_plan_save', { p_name: name, p_month: month, p_inputs: inputs, p_allocation: allocation, p_assumptions: assumptions, p_demo: demo })

export interface ChangeRequest {
  id: string; change_type: string; profile_id: string; campaign_id: string; ad_group_id: string | null; target_id: string | null; entity_label: string
  old_value: Record<string, unknown>; proposed_value: Record<string, unknown>; reason: string; expected_impact: string | null; recommendation_id: string | null
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXECUTING' | 'SUCCEEDED' | 'FAILED'
  requested_by: string; requested_at: string; decided_by: string | null; decided_at: string | null; decision_note: string | null; executed_by: string | null; executed_at: string | null
  api_request_id: string | null; api_response: unknown; error_message: string | null; rollback_instructions: string | null; is_demo: boolean
}
export const fetchChangeRequests = (demo: boolean) => rows<ChangeRequest>(from('amazon_ad_change_requests').eq('is_demo', demo).order('requested_at', { ascending: false }).limit(300))
export const requestChange = (change: Record<string, unknown>) => rpc<{ id: string; status: string }>('amazon_ad_change_request', { p_change: change })
export const decideChange = (id: string, decision: 'APPROVE' | 'REJECT', note: string | null) => rpc<{ id: string; status: string; stale?: boolean }>('amazon_ad_change_decide', { p_id: id, p_decision: decision, p_note: note })
export const cancelChange = (id: string, reason: string) => rpc<{ id: string; status: string }>('amazon_ad_change_cancel', { p_id: id, p_reason: reason })

// ---------------------------------------------------------------------------
// Sync history and audit
// ---------------------------------------------------------------------------
export interface SyncJob {
  id: string; api: string; job_type: string; status: string; file_name: string | null; date_from: string | null; date_to: string | null; rows_received: number; rows_inserted: number
  rows_updated: number; rows_skipped: number; state: { pending?: unknown[]; errors?: { row: number; message: string }[] }; error_code: string | null; error_message: string | null
  requested_by: string | null; started_at: string; finished_at: string | null
}
export interface SyncError { id: string; job_id: string | null; api: string; operation: string; http_status: number | null; error_code: string | null; message: string; retryable: boolean; attempt: number; occurred_at: string }
export const fetchSyncJobs = (p: number, size: number) => page<SyncJob>(from('amazon_sync_jobs', true).order('started_at', { ascending: false }), p, size)
export const fetchSyncErrors = (p: number, size: number) => page<SyncError>(from('amazon_sync_errors', true).order('occurred_at', { ascending: false }), p, size)
export interface AuditEvent { id: string; actor_user_id: string | null; action: string; resource_type: string; resource_id: string | null; event_timestamp: string; metadata: Record<string, unknown> }
export const fetchAmazonAudit = (p: number, size: number) => page<AuditEvent>(from('audit_logs', true).like('action', 'amazon.%').order('event_timestamp', { ascending: false }), p, size)

// ---------------------------------------------------------------------------
// Edge Functions (Amazon credentials stay server-side)
// ---------------------------------------------------------------------------
export class EdgeUnavailableError extends Error {}

export async function invokeAmazon<T = Record<string, unknown>>(fn: 'amazon-spapi' | 'amazon-ads', body: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().functions.invoke(fn, { body })
  if (error) {
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      let payload: { error?: string; variables?: unknown } | null = null
      try {
        payload = await ctx.clone().json()
      } catch {
        payload = null
      }
      if (ctx.status === 404) throw new EdgeUnavailableError(`The ${fn} Edge Function is not deployed on this Supabase project.`)
      // The Edge Functions return short, redacted, user-facing messages; code P0001 lets describeDataError show them.
      throw Object.assign(new Error(payload?.error ?? `${fn} failed (HTTP ${ctx.status})`), { status: ctx.status, payload, code: 'P0001' })
    }
    throw new EdgeUnavailableError(`The ${fn} Edge Function could not be reached (not deployed, or no network).`)
  }
  return data as T
}
