// acefone-webhook request handling (no Deno / npm imports; unit-tested in tests/unit/acefone-functions.test.ts).
//
// URL configured in Acefone (one webhook per trigger):
//   https://<project>.supabase.co/functions/v1/acefone-webhook?account=<phone account id>&event=<event>&token=<ACEFONE_WEBHOOK_SECRET>
//
// Security: Acefone documents no webhook signature, so the request must carry the shared secret in the URL
// (compared in constant time) and, when configured, come from an allowed IP address. The secret, the
// recording link's token and authorization headers are never stored or logged.
// Idempotency: the database keeps one row per event key; a repeat returns 200 without changing anything.
// Retries: a processing error returns 500, so Acefone's retry (two attempts) reprocesses the event.

import { WEBHOOK_EVENTS, clientIp, eventKey, ipAllowed, log, parsePayload, redactPayload, safeEqual } from '../_shared/acefone/acefone.ts'

export interface IngestResult { result: 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'REJECTED' | 'ERROR' | 'RATE_LIMITED'; reason?: string; call_id?: string; status?: string }
export interface WebhookDeps {
  secret: (name: string) => string | null
  runtime(account: string): Promise<{ is_enabled: boolean; webhook_secret_name: string; webhook_allowed_ips: string[] } | null>
  ingest(account: string, event: string, payload: Record<string, unknown>, key: string, ip: string | null): Promise<IngestResult>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY = 64 * 1024
const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export async function handle(req: Request, deps: WebhookDeps): Promise<Response> {
  const url = new URL(req.url)
  if (req.method !== 'POST' && req.method !== 'GET') return json(405, { ok: false })
  const account = url.searchParams.get('account') ?? ''
  const event = url.searchParams.get('event') ?? ''
  const token = url.searchParams.get('token') ?? ''
  const ip = clientIp(req.headers)
  if (!UUID.test(account) || !(event in WEBHOOK_EVENTS)) {
    log('acefone-webhook', 'warn', 'rejected: bad account or event', { event: event.slice(0, 40), ip })
    return json(400, { ok: false })
  }
  let rt: Awaited<ReturnType<WebhookDeps['runtime']>>
  try {
    rt = await deps.runtime(account)
  } catch (e) {
    log('acefone-webhook', 'error', 'runtime lookup failed', { error: String(e).slice(0, 200) })
    return json(500, { ok: false })
  }
  // Same answer for an unknown account and a wrong token (no account enumeration).
  const secret = rt ? deps.secret(rt.webhook_secret_name) : null
  if (!rt || !secret || !token || !safeEqual(token, secret)) {
    log('acefone-webhook', 'warn', rt && !secret ? 'rejected: webhook secret not configured' : 'rejected: invalid token', { event, ip })
    return json(401, { ok: false })
  }
  if (!ipAllowed(ip, rt.webhook_allowed_ips ?? [])) {
    log('acefone-webhook', 'warn', 'rejected: source IP not allowed', { event, ip })
    return json(403, { ok: false })
  }
  const body = req.method === 'POST' ? await req.text() : ''
  if (body.length > MAX_BODY) return json(413, { ok: false })
  let payload: Record<string, string>
  try {
    payload = parsePayload(req.method, req.headers.get('content-type'), body, url.searchParams)
  } catch {
    log('acefone-webhook', 'warn', 'rejected: unreadable body', { event, ip })
    return json(400, { ok: false })
  }
  const key = await eventKey(event, payload)
  const stored: Record<string, unknown> = { ...redactPayload(payload), ...(payload.recording_url ? { __recording_url: payload.recording_url } : {}) }
  let r: IngestResult
  try {
    r = await deps.ingest(account, event, stored, key, ip)
  } catch (e) {
    log('acefone-webhook', 'error', 'ingest failed', { event, error: String(e).slice(0, 200) })
    return json(500, { ok: false })
  }
  log('acefone-webhook', r.result === 'ERROR' ? 'error' : 'info', 'event', { event, result: r.result, call: r.call_id ?? null, status: r.status ?? null })
  if (r.result === 'ERROR') return json(500, { ok: false })
  if (r.result === 'RATE_LIMITED') return json(429, { ok: false })
  return json(200, { ok: true, result: r.result })
}
