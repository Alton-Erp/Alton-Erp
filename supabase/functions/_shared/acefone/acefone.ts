// Acefone (Servetel) helpers shared by the acefone-* Edge Functions. No Deno / npm imports: unit-tested in
// tests/unit/acefone-functions.test.ts.
//
// From the Acefone documentation (docs.acefone.in, read 2026-11-13):
//   POST {base}/v1/click_to_call          Authorization: Bearer <API token>; body agent_number, destination_number,
//                                         caller_id?, async: 1, call_timeout?, custom_identifier?  -> { success, message, ref_id }
//   POST {base}/v1/click_to_call_support  Authorization: Bearer <API token> (mandatory from 30 Sep 2026) and the
//                                         Click-to-Call Support API key in the BODY (api_key); customer_number, async: 1,
//                                         customer_ring_timeout?, caller_id?, call_timeout?, custom_identifier?
//                                         The API token and the support API key are different credentials.
//   GET  {base}/v1/call/records           call detail records (from_date / to_date 'Y-m-d H:i:s', page, limit, ...)
//   Webhooks: one per trigger, POST/GET, JSON or form; variables such as $call_id, $uuid, $ref_id,
//   $caller_id_number, $call_to_number, $start_stamp, $answer_stamp, $end_stamp, $billsec, $duration,
//   $recording_url. No signature or other security mechanism is documented, so each webhook URL carries a
//   secret token that this code checks (and, optionally, an IP allowlist).

export const ACEFONE_HOSTS = ['https://api.acefone.in', 'https://api-acefone.com'] as const

/** Event names used in the webhook URLs (one Acefone webhook per trigger). */
export const WEBHOOK_EVENTS: Record<string, string> = {
  received: 'Call received on Server',
  ivr: 'Call answered on IVR',
  department: 'Call received on Department',
  dialed_agent: 'Dialed on Agent',
  dtmf: 'DTMF Option',
  agent_answered: 'Call answered by Agent',
  customer_answered: 'Call answered by Customer (Click to Call)',
  customer_missed: 'Call missed by Customer (Click to Call)',
  agent_hangup_answered: 'Call answered by Agent (Hangup)',
  agent_hangup_missed: 'Call missed by Agent (Hangup)',
  hangup: 'Call hangup (Missed or Answered)',
  hangup_answered: 'Call hangup (Answered) (updated)',
  hangup_missed: 'Call hangup (Missed) (updated)',
}

const SECRET_NAME = /^ACEFONE_[A-Z0-9_]{2,72}$/
/** Reads a secret by the name stored in the settings; only ACEFONE_* names are allowed. */
export function readSecret(name: unknown, env: (k: string) => string | undefined): string | null {
  if (typeof name !== 'string' || !SECRET_NAME.test(name)) return null
  const v = env(name)
  return v && v.trim() ? v.trim() : null
}

/** Constant-time string comparison (does not leak the length of a common prefix). */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

function ipv4(ip: string): number | null {
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}
/** True when no allowlist is set, or the address is in one of the IPv4 addresses / ranges. */
export function ipAllowed(ip: string | null, allow: string[]): boolean {
  if (!allow.length) return true
  const n = ip ? ipv4(ip) : null
  if (n === null) return false
  return allow.some((rule) => {
    const [base, bits = '32'] = rule.split('/')
    const b = ipv4(base)
    const len = Number(bits)
    if (b === null || !(len >= 0 && len <= 32)) return false
    const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0
    return ((n & mask) >>> 0) === ((b & mask) >>> 0)
  })
}

/** Client address as seen by the Edge runtime (first X-Forwarded-For hop). */
export function clientIp(headers: Headers): string | null {
  const xff = headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim() || null
  return headers.get('x-real-ip')?.trim() || null
}

/** Webhook body: JSON, form-urlencoded, or the query string for GET. Keys keep their names ("$" removed). */
export function parsePayload(method: string, contentType: string | null, body: string, query: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined) return
    const key = k.replace(/^\$/, '').slice(0, 80)
    if (!key || ['token', 'account', 'event'].includes(key)) return
    out[key] = typeof v === 'string' ? v.slice(0, 2000) : JSON.stringify(v).slice(0, 2000)
  }
  if (method === 'GET') {
    for (const [k, v] of query) put(k, v)
    return out
  }
  const ct = (contentType ?? '').toLowerCase()
  if (ct.includes('application/json')) {
    const parsed = JSON.parse(body || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The JSON body is not an object.')
    for (const [k, v] of Object.entries(parsed)) put(k, v)
  } else {
    for (const [k, v] of new URLSearchParams(body)) put(k, v)
  }
  return out
}

/** Recording link without its query string (which carries an access token) for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}${u.search ? '?[redacted]' : ''}`
  } catch {
    return '[redacted]'
  }
}

const SENSITIVE_KEY = /token|secret|password|authorization|api_key|apikey|signature/i
/** Payload for the event log: no credentials, recording link without its token. */
export function redactPayload(p: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(p)) {
    if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]'
    else if (k === 'recording_url' && v) out[k] = redactUrl(v)
    else out[k] = v
  }
  return out
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** De-duplication key: the same event for the same call with the same content is the same key. */
export async function eventKey(event: string, p: Record<string, string>): Promise<string> {
  const id = p.call_id || p.uuid || p.ref_id || ''
  const stable = Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join('&')
  return `wh:${event}:${id}:${(await sha256(`${event}|${stable}`)).slice(0, 32)}`
}

export interface PreparedCall {
  call_id: string
  mode: 'AGENT' | 'SUPPORT'
  api_base_url: string
  api_token_secret: string
  support_api_key_secret: string
  agent_number: string
  destination_number: string
  caller_id: string | null
  custom_identifier: Record<string, string>
}

/** Click-to-Call request (headers include the secret: never log the result). */
export function buildClickToCall(c: PreparedCall, token: string, supportKey: string | null): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  if (!(ACEFONE_HOSTS as readonly string[]).includes(c.api_base_url)) throw new Error('API host not allowed')
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` }
  if (c.mode === 'SUPPORT') {
    if (!supportKey) throw new Error('Click-to-Call Support API key missing')
    return { url: `${c.api_base_url}/v1/click_to_call_support`, init: { method: 'POST', headers, body: JSON.stringify({
      customer_number: c.destination_number, api_key: supportKey, async: 1, ...(c.caller_id ? { caller_id: c.caller_id } : {}), custom_identifier: c.custom_identifier }) } }
  }
  return { url: `${c.api_base_url}/v1/click_to_call`, init: { method: 'POST', headers, body: JSON.stringify({
    agent_number: c.agent_number, destination_number: c.destination_number, async: 1, ...(c.caller_id ? { caller_id: c.caller_id } : {}), custom_identifier: c.custom_identifier }) } }
}

/** Acefone's answer: accepted only when HTTP 2xx AND success === true. */
export function interpretClickToCall(status: number, json: unknown): { accepted: boolean; refId: string | null; message: string } {
  const o = json && typeof json === 'object' ? json as Record<string, unknown> : {}
  const message = typeof o.message === 'string' ? o.message.slice(0, 300)
    : Object.values(o).flat().filter((x) => typeof x === 'string').join(' ').slice(0, 300) || `HTTP ${status}`
  const accepted = status >= 200 && status < 300 && o.success === true
  return { accepted, refId: accepted && typeof o.ref_id === 'string' ? o.ref_id.slice(0, 120) : null, message: accepted ? (message || 'Accepted') : message }
}

/** 'Y-m-d H:i:s' in a time zone (call records API date format). */
export function acefoneDate(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit', hour12: false }).formatToParts(d).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`
}

const RECORDING_HOSTS = [/\.servetel\.in$/i, /\.acefone\.in$/i, /\.acefone\.com$/i, /\.amazonaws\.com$/i, /^servetel\.in$/i, /^acefone\.in$/i]
/** Recording links are fetched only over HTTPS from the provider's hosts (no arbitrary server-side fetching). */
export function recordingUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && RECORDING_HOSTS.some((r) => r.test(u.hostname))
  } catch {
    return false
  }
}

/** Fetch with a timeout. */
export async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetcher(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Structured log line without secrets. */
export function log(fn: string, level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : v]))
  const line = JSON.stringify({ fn, level, message, ...safe })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
