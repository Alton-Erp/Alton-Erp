import { requireSupabase } from '@/lib/supabase'

/**
 * Drafts keep the product / component / BOM versions they were made with
 * (migration 20261118090000_master_versioning.sql). These calls report newer
 * versions and refresh a draft only when the user asks.
 */
export type DraftKind = 'PRODUCTION_ORDER' | 'BOM' | 'SALES_ORDER' | 'PURCHASE_ORDER' | 'INVOICE'

export interface DraftVersionItem {
  product_id: string
  sku: string | null
  field: string
  draft_value: string | number | null
  current_value: string | number | null
  /** False for commercial terms (GST rate) the user changes on the line. */
  refreshable: boolean
}

export interface DraftVersionCheck {
  kind: DraftKind
  id: string
  status: string
  stale: boolean
  items: DraftVersionItem[]
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export const fetchDraftVersionCheck = (kind: DraftKind, id: string) => rpc<DraftVersionCheck>('draft_version_check', { p_kind: kind, p_id: id })
export const refreshDraftVersions = (kind: DraftKind, id: string) => rpc<{ refreshed_lines: number }>('draft_refresh_versions', { p_kind: kind, p_id: id })
