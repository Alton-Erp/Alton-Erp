// Independent Meta account verification for the WhatsApp activation preflight (no Deno / npm imports;
// unit-tested in tests/unit/whatsapp-preflight.test.ts). Read-only GET requests; nothing changes at Meta.
//
//   GET /{WABA-ID}/phone_numbers            the configured phone number id is under the configured WABA
//   GET /{WABA-ID}?fields=…owner_business_info  which business portfolio owns the WABA, account review status
//   GET /{WABA-ID}/subscribed_apps          the configured Meta app receives this WABA's webhooks
//   GET /debug_token?input_token=…          token validity, type, expiry and (granular) permissions
//
// The result holds identifiers, statuses and short error titles only, never the token. Errors from fetch()
// are not copied (a failed request URL may contain the token for debug_token).

import { GRAPH, graphError, graphFetch, graphUrl, type WaRuntime } from './whatsapp.ts'

export const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'] as const

export interface MetaVerification {
  checked_at: string
  waba_id: string
  phone_number_id: string
  app_id: string | null
  phone_in_waba: boolean | null
  waba_phone_count: number | null
  waba_error: string | null
  owner_business_id: string | null
  owner_business_name: string | null
  waba_name: string | null
  account_review_status: string | null
  owner_error: string | null
  subscribed_app_ids: string[] | null
  subscribed_error: string | null
  token: {
    is_valid: boolean
    type: string | null
    app_id: string | null
    expires_at: number | null
    scopes: string[]
    /** WABA ids the required permissions are limited to (granular scopes); null = not limited / not reported. */
    targets: Record<string, string[] | null>
  } | null
  token_error: string | null
}

const short = (s: string) => s.replace(/\s+/g, ' ').slice(0, 200)
const numeric = (v: unknown) => (typeof v === 'string' && /^[0-9]{5,25}$/.test(v) ? v : null)

async function getJson(fetcher: typeof fetch, url: string, token: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let res: Response
  try {
    res = await graphFetch(fetcher, url, token)
  } catch {
    return { ok: false, error: 'Meta could not be reached.' }
  }
  if (!res.ok) {
    const e = await graphError(res)
    return { ok: false, error: short(e.code === 190 ? 'Meta refused the access token (190).' : `${e.title}${e.code ? ` (${e.code})` : ''}`) }
  }
  return { ok: true, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

export async function verifyMetaAccount(fetcher: typeof fetch, rt: WaRuntime, token: string, now = new Date()): Promise<MetaVerification> {
  if (!rt.waba_id || !rt.phone_number_id) throw new Error('Enter the Meta ids first.')
  const v: MetaVerification = {
    checked_at: now.toISOString(), waba_id: rt.waba_id, phone_number_id: rt.phone_number_id, app_id: rt.app_id ?? null,
    phone_in_waba: null, waba_phone_count: null, waba_error: null, owner_business_id: null, owner_business_name: null, waba_name: null,
    account_review_status: null, owner_error: null, subscribed_app_ids: null, subscribed_error: null, token: null, token_error: null,
  }

  // 1. Phone numbers of the configured WABA (Meta's own paging, same WABA only, at most 5 pages).
  const ids: string[] = []
  let url: string | null = graphUrl(rt.graph_api_version, rt.waba_id, 'phone_numbers', { fields: 'id,display_phone_number', limit: '100' })
  for (let page = 0; url && page < 5; page++) {
    const r = await getJson(fetcher, url, token)
    if (!r.ok) { v.waba_error = r.error; break }
    for (const p of (r.body.data as { id?: unknown }[] | undefined) ?? []) { const id = numeric(p.id); if (id) ids.push(id) }
    const next = (r.body.paging as { next?: string } | undefined)?.next ?? null
    url = next && next.startsWith(`${GRAPH}/`) && new URL(next).pathname.endsWith(`/${rt.waba_id}/phone_numbers`) ? next : null
  }
  if (!v.waba_error) { v.phone_in_waba = ids.includes(rt.phone_number_id); v.waba_phone_count = ids.length }

  // 2. WABA owner (business portfolio) and review status.
  const w = await getJson(fetcher, graphUrl(rt.graph_api_version, rt.waba_id, '', { fields: 'id,name,owner_business_info,account_review_status' }), token)
  if (w.ok) {
    const owner = w.body.owner_business_info as { id?: unknown; name?: unknown } | undefined
    v.owner_business_id = numeric(owner?.id)
    v.owner_business_name = typeof owner?.name === 'string' ? owner.name.slice(0, 200) : null
    v.waba_name = typeof w.body.name === 'string' ? w.body.name.slice(0, 200) : null
    v.account_review_status = typeof w.body.account_review_status === 'string' ? w.body.account_review_status.slice(0, 40) : null
    if (!v.owner_business_id) v.owner_error = 'Meta did not return the owning business portfolio of this WhatsApp Business Account.'
  } else v.owner_error = w.error

  // 3. Apps subscribed to this WABA's webhooks.
  const s = await getJson(fetcher, graphUrl(rt.graph_api_version, rt.waba_id, 'subscribed_apps'), token)
  if (s.ok) {
    v.subscribed_app_ids = ((s.body.data as { whatsapp_business_api_data?: { id?: unknown } }[] | undefined) ?? [])
      .map((a) => numeric(a.whatsapp_business_api_data?.id)).filter((x): x is string => x !== null).slice(0, 25)
  } else v.subscribed_error = s.error

  // 4. Token: validity, type, expiry and permissions (debug_token answers for the token itself).
  const t = await getJson(fetcher, graphUrl(rt.graph_api_version, 'debug_token', '', { input_token: token }), token)
  if (t.ok) {
    const d = (t.body.data ?? {}) as { is_valid?: unknown; type?: unknown; app_id?: unknown; expires_at?: unknown; scopes?: unknown; granular_scopes?: unknown }
    const scopes = Array.isArray(d.scopes) ? d.scopes.filter((x): x is string => typeof x === 'string').slice(0, 50) : []
    const granular = Array.isArray(d.granular_scopes) ? d.granular_scopes as { scope?: unknown; target_ids?: unknown }[] : []
    const targets: Record<string, string[] | null> = {}
    for (const sc of REQUIRED_SCOPES) {
      const g = granular.find((x) => x.scope === sc)
      targets[sc] = g && Array.isArray(g.target_ids) ? g.target_ids.map(numeric).filter((x): x is string => x !== null).slice(0, 50) : null
    }
    v.token = { is_valid: d.is_valid === true, type: typeof d.type === 'string' ? d.type.slice(0, 40) : null, app_id: numeric(d.app_id),
      expires_at: typeof d.expires_at === 'number' ? d.expires_at : null, scopes, targets }
  } else v.token_error = t.error

  return v
}
