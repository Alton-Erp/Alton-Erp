import type { PartyPayload, PartyRow, PaymentMethod } from '@/features/ledger/ledger-model'
import { requireSupabase } from '@/lib/supabase'

/**
 * Unified ledger data access. Every call is a permission-checked database
 * function; customers, suppliers and parties are never written directly.
 */
async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await (requireSupabase().rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: T; error: unknown }>)(fn, args)
  if (error) throw error
  return data
}

export interface DuplicateParty {
  party_id: string
  party_code: string
  party_name: string
  party_type: string
  matched_on: string[]
  blocking: boolean
}

export type SavePartyResult =
  | { ok: true; party_id: string; party_code: string; party_type: string; customer_id: string | null; customer_code: string | null; supplier_id: string | null; supplier_code: string | null }
  | { ok: false; duplicates: DuplicateParty[] }

export interface PartyEntry {
  date: string | null
  kind: string
  document: string
  ref_id: string
  description: string
  status: string | null
  amount: number | null
  receivable: number
  payable: number
  receivable_balance: number
  payable_balance: number
}

/** Creates a party for any customer / supplier that has none (cheap; safe to call on every visit). */
export const syncParties = () => rpc<{ customers_added: number; suppliers_added: number }>('ledger_sync_parties')

export const fetchParties = (search: string | null, type: string | null, status: string | null) =>
  rpc<PartyRow[]>('ledger_parties', { p_search: search, p_type: type, p_status: status, p_party_id: null })

export async function fetchParty(partyId: string): Promise<PartyRow> {
  const rows = await rpc<PartyRow[]>('ledger_parties', { p_search: null, p_type: null, p_status: null, p_party_id: partyId })
  if (!rows.length) throw Object.assign(new Error('Party not found.'), { code: 'P0001' })
  return rows[0]
}

export const findDuplicateParties = (input: { name: string; gstin?: string | null; pan?: string | null; phone?: string | null; email?: string | null; excludePartyId?: string | null }) =>
  rpc<DuplicateParty[]>('party_find_duplicates', {
    p_name: input.name, p_gstin: input.gstin ?? null, p_pan: input.pan ?? null, p_phone: input.phone ?? null, p_email: input.email ?? null,
    p_exclude_party: input.excludePartyId ?? null,
  })

export const saveParty = (partyId: string | null, payload: PartyPayload, confirmDuplicates: boolean, key: string | null) =>
  rpc<SavePartyResult>('party_save', { p_party_id: partyId, p_party: payload, p_confirm_duplicates: confirmDuplicates, p_idempotency_key: key })

export const setPartyStatus = (partyId: string, status: 'ACTIVE' | 'INACTIVE') => rpc<{ status: string }>('party_set_status', { p_party_id: partyId, p_status: status })

export const linkParties = (partyId: string, otherPartyId: string) =>
  rpc<{ party_id: string; party_code: string; removed_party_code: string }>('party_link', { p_party_id: partyId, p_other_party_id: otherPartyId })

export const fetchPartyTransactions = (partyId: string) =>
  rpc<{ entries: PartyEntry[]; customer_visible: boolean; supplier_visible: boolean }>('party_transactions', { p_party_id: partyId })

export const recordSupplierPayment = (input: { supplierId: string; date: string; amount: number; method: PaymentMethod; reference: string | null; notes: string | null }, key: string) =>
  rpc<{ payment_id: string; payment_number: string; payable_after: number; overpaid: boolean }>('supplier_payment_record', {
    p_supplier_id: input.supplierId, p_payment_date: input.date, p_amount: input.amount, p_payment_method: input.method,
    p_reference: input.reference, p_notes: input.notes, p_idempotency_key: key,
  })

export const reverseSupplierPayment = (paymentId: string, reason: string) =>
  rpc<{ status: string }>('supplier_payment_reverse', { p_payment_id: paymentId, p_reason: reason })
