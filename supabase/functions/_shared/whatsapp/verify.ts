// Independent Meta account verification for the WhatsApp activation preflight (no Deno / npm imports;
// unit-tested in tests/unit/whatsapp-preflight.test.ts). Read-only GET requests only: nothing is registered,
// migrated, subscribed or deleted at Meta.
//
// Separate requests, so that one refused field or permission never hides the others:
//   phone             GET /{PHONE_NUMBER_ID}?fields=id,display_phone_number,verified_name,quality_rating,status,platform_type,code_verification_status
//   waba (type)       GET /{WABA_ID}?metadata=1&fields=id            → metadata.type: is the id really a WhatsApp Business Account?
//   waba              GET /{WABA_ID}?fields=id,name,account_review_status
//   ownership         GET /{WABA_ID}?fields=owner_business_info
//   phone_in_waba     GET /{WABA_ID}/phone_numbers?fields=id,display_phone_number   (Meta paging, same WABA only)
//   subscription      GET /{WABA_ID}/subscribed_apps
//   token             GET /debug_token?input_token=…                (validity, type, expiry, permissions, granular WABA ids)
//   suggestion        GET /{TOKEN_WABA_ID}/phone_numbers?fields=id  for the WABAs the token covers, only when the number
//                     was not found under the configured WABA: tells the administrator which WABA holds it (never applied).
//
// Each check returns { status, verified, error_code, error_message, checked_at, ... } with status
//   VERIFIED | VERIFICATION_FAILED | PERMISSION_DENIED | INVALID_REQUEST | WRONG_ACCOUNT  (NOT_TESTED = no evidence).
// The evidence holds identifiers, statuses and Meta's short error titles, never the token. Errors thrown by fetch()
// are not copied (a failed request URL may contain the token for debug_token).

import { GRAPH, graphError, graphFetch, graphUrl, type WaRuntime } from './whatsapp.ts'

export const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'] as const
export type CheckStatus = 'VERIFIED' | 'VERIFICATION_FAILED' | 'PERMISSION_DENIED' | 'INVALID_REQUEST' | 'WRONG_ACCOUNT'
export interface Check {
  status: CheckStatus
  verified: boolean
  error_code: number | null
  error_message: string | null
  checked_at: string
  [extra: string]: unknown
}

/** Meaning of the phone number "status" values Meta documents for a WhatsApp business phone number. */
export const PHONE_STATUS_MEANING: Record<string, string> = {
  CONNECTED: 'registered and active on the Cloud API',
  PENDING: 'registration has not finished (the number is not registered on the Cloud API yet)',
  DISCONNECTED: 'not connected: the number is not registered on the Cloud API (it may be on the WhatsApp Business app or another platform)',
  UNVERIFIED: 'the phone number has not been verified',
  MIGRATED: 'migrated away from this account',
  FLAGGED: 'flagged by Meta because of low quality',
  RESTRICTED: 'restricted by Meta (messaging limits apply)',
  RATE_LIMITED: 'temporarily rate limited by Meta',
  BANNED: 'banned by Meta',
  DELETED: 'deleted',
}

const short = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n)
const numeric = (v: unknown) => (typeof v === 'string' && /^[0-9]{5,25}$/.test(v) ? v : null)
const digits = (s: unknown) => String(s ?? '').replace(/[^0-9]/g, '')
const text = (v: unknown, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null)

type Answer = { ok: true; body: Record<string, unknown> } | { ok: false; status: CheckStatus; code: number | null; message: string }

/** Graph error → check status. 190 = token; 10 / 200-299 / 3 = permission; 100 = invalid request (field / object / edge). */
function classify(code: number | null, httpStatus: number): CheckStatus {
  if (code === 190) return 'VERIFICATION_FAILED'
  if (code === 10 || code === 3 || (code !== null && code >= 200 && code <= 299) || httpStatus === 403) return 'PERMISSION_DENIED'
  if (code === 100 || code === 803 || httpStatus === 400 || httpStatus === 404) return 'INVALID_REQUEST'
  return 'VERIFICATION_FAILED'
}

async function getJson(fetcher: typeof fetch, url: string, token: string): Promise<Answer> {
  let res: Response
  try {
    res = await graphFetch(fetcher, url, token)
  } catch {
    return { ok: false, status: 'VERIFICATION_FAILED', code: null, message: 'Meta could not be reached.' }
  }
  if (!res.ok) {
    const e = await graphError(res)
    return { ok: false, status: classify(e.code, res.status), code: e.code,
      message: short(e.code === 190 ? 'Meta refused the access token (190): it expired or is invalid.' : `${e.title}${e.code ? ` (${e.code})` : ''}`) }
  }
  return { ok: true, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const check = (now: string, status: CheckStatus, extra: Record<string, unknown> = {}, err?: { code: number | null; message: string }): Check =>
  ({ status, verified: status === 'VERIFIED', error_code: err?.code ?? null, error_message: err?.message ?? null, checked_at: now, ...extra })
const failed = (now: string, a: Extract<Answer, { ok: false }>, extra: Record<string, unknown> = {}) => check(now, a.status, extra, { code: a.code, message: a.message })

/** Phone number ids listed under GET /{waba}/phone_numbers (Meta paging, same WABA only, at most 5 pages). */
async function phoneIds(fetcher: typeof fetch, version: string, waba: string, token: string): Promise<{ ok: true; ids: string[] } | Extract<Answer, { ok: false }>> {
  const ids: string[] = []
  let url: string | null = graphUrl(version, waba, 'phone_numbers', { fields: 'id,display_phone_number', limit: '100' })
  for (let page = 0; url && page < 5; page++) {
    const r = await getJson(fetcher, url, token)
    if (!r.ok) return r
    for (const p of (r.body.data as { id?: unknown }[] | undefined) ?? []) { const id = numeric(p.id); if (id) ids.push(id) }
    const next = (r.body.paging as { next?: string } | undefined)?.next ?? null
    url = next && next.startsWith(`${GRAPH}/`) && new URL(next).pathname.endsWith(`/${waba}/phone_numbers`) ? next : null
  }
  return { ok: true, ids }
}

export interface MetaVerification {
  version: 2
  checked_at: string
  waba_id: string
  phone_number_id: string
  app_id: string | null
  checks: {
    phone_registration: Check
    waba: Check
    ownership: Check
    phone_in_waba: Check
    subscription: Check
    token: Check
    app_secret: { configured: boolean; checked_at: string }
  }
}

export async function verifyMetaAccount(fetcher: typeof fetch, rt: WaRuntime, token: string, opts: { appSecretConfigured: boolean; now?: Date } = { appSecretConfigured: false }): Promise<MetaVerification> {
  if (!rt.waba_id || !rt.phone_number_id || !rt.graph_api_version) throw new Error('Enter the Meta ids first.')
  const now = (opts.now ?? new Date()).toISOString()
  const version = rt.graph_api_version
  const waba = rt.waba_id
  const phone = rt.phone_number_id

  // Phone number details (the number itself, independent of the WABA).
  let phoneRegistration: Check
  const p = await getJson(fetcher, graphUrl(version, phone, '', { fields: 'id,display_phone_number,verified_name,quality_rating,status,platform_type,code_verification_status' }), token)
  if (p.ok) {
    const status = String(p.body.status ?? '').trim().toUpperCase() || null
    const platform = p.body.platform_type === undefined ? null : String(p.body.platform_type).trim().toUpperCase()
    const extra = { phone_status: status, platform_type: platform, display_phone_number: text(p.body.display_phone_number, 40), verified_name: text(p.body.verified_name),
      quality_rating: text(p.body.quality_rating, 20), code_verification_status: text(p.body.code_verification_status, 40) }
    const numberMatches = digits(p.body.display_phone_number) === digits(rt.display_phone_number)
    phoneRegistration = !numberMatches
      ? check(now, 'WRONG_ACCOUNT', extra, { code: null, message: `Meta reports ${p.body.display_phone_number ?? 'no number'} for phone number id ${phone}, not the configured ${rt.display_phone_number}.` })
      : status !== 'CONNECTED'
        ? check(now, 'VERIFICATION_FAILED', extra, { code: null, message: `Meta reports status ${status ?? 'not reported'}${status && PHONE_STATUS_MEANING[status] ? `: ${PHONE_STATUS_MEANING[status]}` : ''}. CONNECTED is required.` })
        : platform !== null && platform !== 'CLOUD_API'
          ? check(now, 'VERIFICATION_FAILED', extra, { code: null, message: `Meta reports platform ${platform}; the Cloud API (CLOUD_API) is required.` })
          : check(now, 'VERIFIED', extra)
  } else phoneRegistration = failed(now, p)

  // Is the configured WABA id really a WhatsApp Business Account? (metadata.type names the object type.)
  let wabaType: string | null = null
  const t = await getJson(fetcher, graphUrl(version, waba, '', { metadata: '1', fields: 'id' }), token)
  if (t.ok) wabaType = text((t.body.metadata as { type?: unknown } | undefined)?.type, 60)
  const notWaba = wabaType !== null && wabaType !== 'whatsapp_business_account'
  const wrongType = (what: string) => check(now, 'WRONG_ACCOUNT', { waba_type: wabaType }, { code: null,
    message: `Id ${waba} is a ${wabaType?.replace(/_/g, ' ')}, not a WhatsApp Business Account, so ${what} cannot be read. Check the WhatsApp Business Account ID.` })

  // WABA name and review status.
  let wabaCheck: Check
  if (notWaba) wabaCheck = wrongType('its name')
  else {
    const w = await getJson(fetcher, graphUrl(version, waba, '', { fields: 'id,name,account_review_status' }), token)
    wabaCheck = w.ok
      ? check(now, 'VERIFIED', { waba_type: wabaType, waba_name: text(w.body.name), account_review_status: text(w.body.account_review_status, 40) })
      : failed(now, w, { waba_type: wabaType, hint: w.code === 100 ? `Meta answered that ${waba} has no WhatsApp Business Account field: the id is probably not a WABA id (a phone number id or another object?).` : null })
  }

  // Owner (business portfolio), requested on its own so a permission error is reported precisely.
  let ownership: Check
  if (notWaba) ownership = wrongType('its owner')
  else {
    const o = await getJson(fetcher, graphUrl(version, waba, '', { fields: 'owner_business_info' }), token)
    if (o.ok) {
      const info = o.body.owner_business_info as { id?: unknown; name?: unknown } | undefined
      const owner = numeric(info?.id)
      ownership = owner
        ? check(now, 'VERIFIED', { owner_business_id: owner, owner_business_name: text(info?.name) })
        : check(now, 'PERMISSION_DENIED', {}, { code: null, message: 'Meta did not return owner_business_info for this WhatsApp Business Account (the token may lack business_management or access to the portfolio).' })
    } else ownership = failed(now, o)
  }

  // The configured phone number id under the configured WABA.
  let phoneInWaba: Check
  if (notWaba) phoneInWaba = wrongType('its phone numbers')
  else {
    const l = await phoneIds(fetcher, version, waba, token)
    phoneInWaba = 'ids' in l
      ? (l.ids.includes(phone) ? check(now, 'VERIFIED', { waba_phone_count: l.ids.length })
        : check(now, 'WRONG_ACCOUNT', { waba_phone_count: l.ids.length }, { code: null, message: `Phone number id ${phone} is not among the ${l.ids.length} number(s) of WhatsApp Business Account ${waba}.` }))
      : failed(now, l)
  }

  // Apps subscribed to the WABA's webhooks.
  let subscription: Check
  if (notWaba) subscription = wrongType('its subscribed apps')
  else {
    const s = await getJson(fetcher, graphUrl(version, waba, 'subscribed_apps'), token)
    if (s.ok) {
      const apps = ((s.body.data as { whatsapp_business_api_data?: { id?: unknown } }[] | undefined) ?? [])
        .map((a) => numeric(a.whatsapp_business_api_data?.id)).filter((x): x is string => x !== null).slice(0, 25)
      subscription = rt.app_id && apps.includes(rt.app_id) ? check(now, 'VERIFIED', { subscribed_app_ids: apps })
        : check(now, 'WRONG_ACCOUNT', { subscribed_app_ids: apps }, { code: null, message: `App ${rt.app_id ?? '(not set)'} is not subscribed to WhatsApp Business Account ${waba} (subscribed: ${apps.join(', ') || 'none'}).` })
    } else subscription = failed(now, s)
  }

  // Token: validity, expiry and permissions, and which WABAs its WhatsApp permissions cover.
  let tokenCheck: Check
  let tokenWabas: string[] = []
  const d = await getJson(fetcher, graphUrl(version, 'debug_token', '', { input_token: token }), token)
  if (d.ok) {
    const data = (d.body.data ?? {}) as { is_valid?: unknown; type?: unknown; expires_at?: unknown; scopes?: unknown; granular_scopes?: unknown }
    const scopes = Array.isArray(data.scopes) ? data.scopes.filter((x): x is string => typeof x === 'string' && /^[a-z_]{2,60}$/.test(x)).slice(0, 50) : []
    const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes as { scope?: unknown; target_ids?: unknown }[] : []
    const targets: Record<string, string[] | null> = {}
    for (const sc of REQUIRED_SCOPES) {
      const g = granular.find((x) => x.scope === sc)
      targets[sc] = g && Array.isArray(g.target_ids) ? g.target_ids.map(numeric).filter((x): x is string => x !== null).slice(0, 50) : null
    }
    tokenWabas = [...new Set(Object.values(targets).flatMap((x) => x ?? []))]
    const expires = typeof data.expires_at === 'number' ? data.expires_at : null
    const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s))
    const limited = REQUIRED_SCOPES.filter((s) => targets[s] !== null && !targets[s]!.includes(waba))
    const extra = { token_type: text(data.type, 40), expires_at: expires, scopes, token_waba_ids: tokenWabas, describable: true }
    tokenCheck = data.is_valid !== true ? check(now, 'VERIFICATION_FAILED', extra, { code: null, message: 'Meta reports the access token as invalid. Replace WHATSAPP_ACCESS_TOKEN.' })
      : missing.length ? check(now, 'PERMISSION_DENIED', extra, { code: null, message: `The access token is missing the permission(s): ${missing.join(', ')}.` })
        : limited.length ? check(now, 'PERMISSION_DENIED', extra, { code: null,
          message: `The token's ${limited.join(' and ')} permission covers WhatsApp Business Account(s) ${tokenWabas.join(', ') || 'none'}, not ${waba}.` })
          : expires !== null && expires > 0 ? check(now, 'VERIFICATION_FAILED', extra, { code: null,
            message: `The access token expires on ${new Date(expires * 1000).toISOString().slice(0, 10)}: a permanent (never-expiring) system-user token is required.` })
            : check(now, 'VERIFIED', extra)
  } else tokenCheck = failed(now, d, { describable: false })

  // Which WABA actually holds the number (only when it was not found under the configured one). Never applied.
  if (!phoneInWaba.verified && tokenWabas.length) {
    for (const cand of tokenWabas.filter((x) => x !== waba).slice(0, 5)) {
      const l = await phoneIds(fetcher, version, cand, token)
      if ('ids' in l && l.ids.includes(phone)) { phoneInWaba = { ...phoneInWaba, suggested_waba_id: cand }; wabaCheck = { ...wabaCheck, suggested_waba_id: cand }; break }
    }
  }

  return {
    version: 2, checked_at: now, waba_id: waba, phone_number_id: phone, app_id: rt.app_id ?? null,
    checks: { phone_registration: phoneRegistration, waba: wabaCheck, ownership, phone_in_waba: phoneInWaba, subscription, token: tokenCheck,
      app_secret: { configured: opts.appSecretConfigured, checked_at: now } },
  }
}
