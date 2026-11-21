import type { FieldConfig, FieldDefinition, FieldModule, FieldType, FormField, LayoutItem, LookupTarget, StandardField, StandardKey, Visibility } from '@/features/support/ticket-fields/field-model'
import { requireSupabase } from '@/lib/supabase'
import type { TicketCreate } from '@/services/support'

/**
 * Support ticket fields and Product Master links (migration 20261226090000). Reads and writes go through the
 * support_ticket_* database functions (permissions, company and every value rule are checked there).
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

/** The migration is not applied yet (the app then keeps the earlier New Ticket form). */
export function isMissingTicketFields(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | null
  return x?.code === 'PGRST202' || x?.code === '42883' || /could not find the function|does not exist/i.test(x?.message ?? '')
}

export interface FieldsAdmin {
  stamp: string; max_custom: number; active_custom: number
  standard: StandardField[]
  definitions: FieldDefinition[]
  layout: { standard_key: StandardKey | null; field_definition_id: string | null; display_order: number; is_visible: boolean; is_required_override: boolean | null }[]
  can: { create: boolean; update: boolean; delete: boolean }
}
// Ticket fields keep using their own functions (they exist since 20261226090000); customer fields need 20261228090000.
export const fetchFieldsAdmin = (module: FieldModule = 'TICKET') =>
  module === 'TICKET' ? rpc<FieldsAdmin>('support_ticket_fields_admin') : rpc<FieldsAdmin>('support_fields_admin', { p_module: module })

export interface FieldInput {
  field_label?: string; field_type?: FieldType; field_config?: FieldConfig; is_required?: boolean; is_active?: boolean
  default_value?: unknown; help_text?: string | null; placeholder?: string | null; visibility?: Visibility
}
export const saveFieldDefinition = (id: string | null, p: FieldInput, module: FieldModule = 'TICKET') => module === 'TICKET'
  ? rpc<FieldDefinition>('support_ticket_field_save', { p_id: id, p }) : rpc<FieldDefinition>('support_field_save', { p_module: module, p_id: id, p })
export const saveFieldLayout = (used: LayoutItem[], stamp: string, module: FieldModule = 'TICKET') => module === 'TICKET'
  ? rpc<{ stamp: string }>('support_ticket_fields_save_layout', { p_used: used, p_stamp: stamp })
  : rpc<{ stamp: string }>('support_fields_save_layout', { p_module: module, p_used: used, p_stamp: stamp })

export interface TicketForm {
  fields: FormField[]
  formula_inputs: { field_key: string; field_type: FieldType }[]
  products: { view: boolean; manage: boolean; archived: boolean }
}
/** The New Ticket form layout; null before the migration. */
export async function fetchTicketForm(): Promise<TicketForm | null> {
  try { return await rpc<TicketForm>('support_ticket_form') } catch (e) { if (isMissingTicketFields(e)) return null; throw e }
}

export interface TicketProductInput { product_id: string; quantity: number | string }
export const createTicketWithFields = (p: TicketCreate & { custom_fields: Record<string, unknown>; products: TicketProductInput[]; allow_archived_products?: boolean; pipeline_id?: string }) =>
  rpc<{ id: string; ticket_number: string; custom_fields: number; products: number }>('support_ticket_create_v2', { p })

export interface TicketProduct {
  id: string; product_id: string; quantity: number; product_name: string; sku: string; product_name_snapshot: string; sku_snapshot: string
  model_number: string | null; barcode: string | null; ean: string | null; base_unit: string | null; archived: boolean; added_at: string; added_by: string | null
}
export interface TicketExtras {
  fields: (FieldDefinition & { value: unknown; in_form: boolean; required: boolean })[]
  formula_inputs: Record<string, unknown>
  products: TicketProduct[] | null
  can: { edit_fields: boolean; manage_products: boolean; archived_products: boolean }
}
/** Custom field values and products of a ticket; null before the migration. */
export async function fetchTicketExtras(ticketId: string): Promise<TicketExtras | null> {
  try { return await rpc<TicketExtras>('support_ticket_extras', { p_ticket: ticketId }) } catch (e) { if (isMissingTicketFields(e)) return null; throw e }
}
export const saveTicketCustomFields = (ticketId: string, values: Record<string, unknown>) =>
  rpc<{ changed: string[] }>('support_ticket_custom_fields_save', { p_ticket: ticketId, p_values: values })
export const saveTicketProducts = (ticketId: string, items: TicketProductInput[], allowArchived = false) =>
  rpc<{ added: string[]; removed: string[]; changed: string[] }>('support_ticket_products_save', { p_ticket: ticketId, p_items: items, p_allow_archived: allowArchived })

export interface ProductHit {
  id: string; sku: string; product_name: string; model_number: string | null; barcode: string | null; ean: string | null; brand: string | null; base_unit: string | null; archived: boolean
}
export const searchTicketProducts = (term: string, includeArchived = false, limit = 15) =>
  rpc<ProductHit[]>('support_ticket_product_search', { p_term: term, p_include_archived: includeArchived, p_limit: limit })
export const searchLookup = (target: LookupTarget, term: string, limit = 10) =>
  rpc<{ id: string; label: string }[]>('support_ticket_lookup_search', { p_target: target, p_term: term, p_limit: limit })
export const fetchUserOptions = (scope: 'EMPLOYEES' | 'AGENTS' = 'EMPLOYEES') =>
  rpc<{ id: string; name: string; is_agent: boolean }[]>('support_ticket_user_options', { p_scope: scope })
