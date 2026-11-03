import { requireSupabase } from '@/lib/supabase'
import type { CompanyRow, CompanySettingRow, Database, Json } from '@/types/database'

export type CompanyUpdate = Database['public']['Tables']['companies']['Update']

export interface CompanySettingsData {
  company: CompanyRow
  settings: CompanySettingRow[]
}

/** Company profile and key/value settings. Settings rows require settings.manage (RLS). */
export async function fetchCompanySettings(companyId: string): Promise<CompanySettingsData> {
  const db = requireSupabase()
  const [company, settings] = await Promise.all([
    db.from('companies').select('*').eq('id', companyId).single(),
    db.from('company_settings').select('*').eq('company_id', companyId),
  ])
  if (company.error) throw company.error
  if (settings.error) throw settings.error
  return { company: company.data, settings: settings.data ?? [] }
}

export async function updateCompany(companyId: string, changes: CompanyUpdate): Promise<void> {
  if (Object.keys(changes).length === 0) return
  const { error, count } = await requireSupabase()
    .from('companies')
    .update(changes, { count: 'exact' })
    .eq('id', companyId)
  if (error) throw error
  if (count === 0) throw Object.assign(new Error('not permitted'), { code: '42501' })
}

/**
 * Creates or updates one setting. Done as an explicit update-or-insert (rather
 * than an upsert) because clients may only UPDATE the setting_value column.
 */
export async function saveCompanySetting(
  companyId: string,
  key: string,
  value: Json,
  existing: CompanySettingRow | undefined,
): Promise<void> {
  const db = requireSupabase()
  if (existing) {
    const { error } = await db.from('company_settings').update({ setting_value: value }).eq('id', existing.id)
    if (error) throw error
  } else {
    const { error } = await db
      .from('company_settings')
      .insert({ company_id: companyId, setting_key: key, setting_value: value })
    if (error) throw error
  }
}
