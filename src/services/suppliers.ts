import { describeDataError } from '@/lib/errors'
import { requireSupabase } from '@/lib/supabase'
import type { SupplierActivityRow, SupplierInsert, SupplierRow, SupplierStatus, SupplierUpdate } from '@/types/database-suppliers'

/**
 * Supplier master data access. Reads and writes go straight to the
 * RLS-protected `suppliers` table (company isolation and suppliers.read /
 * suppliers.manage are enforced by the database). Suppliers are never deleted.
 */

const db = () => requireSupabase()

/** All suppliers visible to the user (their company only, via RLS). */
export async function fetchSuppliers(): Promise<SupplierRow[]> {
  const { data, error } = await db().from('suppliers').select('*').order('legal_name').limit(5000)
  if (error) throw error
  return data ?? []
}

export async function getSupplier(id: string): Promise<SupplierRow> {
  const { data, error } = await db().from('suppliers').select('*').eq('id', id).single()
  if (error) throw error
  return data
}

/**
 * Active suppliers for pickers (e.g. new supplier purchase orders). Inactive
 * suppliers are excluded by default; existing documents keep their reference.
 */
export async function fetchSupplierOptions(includeInactive = false): Promise<Pick<SupplierRow, 'id' | 'supplier_code' | 'legal_name' | 'display_name' | 'status'>[]> {
  let query = db().from('suppliers').select('id, supplier_code, legal_name, display_name, status').order('legal_name').limit(5000)
  if (!includeInactive) query = query.eq('status', 'ACTIVE')
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

export async function createSupplier(companyId: string, input: Omit<SupplierInsert, 'company_id'>): Promise<SupplierRow> {
  const { data, error } = await db().from('suppliers').insert({ ...input, company_id: companyId }).select('*').single()
  if (error) throw error
  return data
}

export async function updateSupplier(id: string, changes: SupplierUpdate): Promise<void> {
  const { error, count } = await db().from('suppliers').update(changes, { count: 'exact' }).eq('id', id)
  if (error) throw error
  // RLS hides rows the user may not change: report it instead of silently succeeding.
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

export const setSupplierStatus = (id: string, status: SupplierStatus) => updateSupplier(id, { status })

/** Audit history of one supplier (requires suppliers.read; no audit_logs.read needed). */
export async function fetchSupplierActivity(supplierId: string): Promise<SupplierActivityRow[]> {
  const { data, error } = await db().rpc('supplier_activity', { p_supplier_id: supplierId })
  if (error) throw error
  return data ?? []
}

/** Supplier-specific wording for constraint violations. */
export function describeSupplierError(error: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: string; message?: string }
  const m = e.message ?? ''
  if (e.code === '23505') {
    if (m.includes('suppliers_company_gstin_unique')) return 'Another supplier in your company already has this GSTIN.'
    if (m.includes('suppliers_company_code_unique')) return 'Another supplier already uses this supplier code.'
    return 'A supplier with these details already exists.'
  }
  if (e.code === '23514') {
    if (m.includes('suppliers_gstin_pan_check')) return 'The PAN does not match the GSTIN.'
    if (m.includes('suppliers_pin_india_check')) return 'An Indian PIN code is 6 digits and does not start with 0.'
    if (m.includes('suppliers_custom_terms_check')) return 'Custom payment terms need a number of days.'
    return 'One or more values are invalid. Check the highlighted fields.'
  }
  return describeDataError(error)
}
