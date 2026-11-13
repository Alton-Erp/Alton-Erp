// whatsapp-webhook request handling (no Deno / npm imports; unit-tested in tests/unit/whatsapp-functions.test.ts).
//
// Callback URL: https://<project>.supabase.co/functions/v1/whatsapp-webhook?account=<channel account id>
//   GET   Meta's verification challenge (hub.mode / hub.verify_token = WHATSAPP_VERIFY_TOKEN / hub.challenge).
//   POST  Events. X-Hub-Signature-256 (HMAC-SHA256 of the raw body with WHATSAPP_APP_SECRET) is required; an
//         unsigned or wrongly signed body is refused and nothing is stored. Each entry / change is stored raw and
//         processed idempotently by public.support_whatsapp_ingest (a retried delivery is a duplicate). Media is
//         not downloaded here (whatsapp-media-download does that asynchronously), so Meta gets a quick 200.
//         A change that failed to process answers 500 so Meta retries it.

import { log, type Client } from '../_shared/google/google.ts'
import { answerVerification, eventKey, signatureValid, waSecret, type WaDeps } from '../_shared/whatsapp/whatsapp.ts'

export interface Deps extends WaDeps { admin(): Client }
const MAX_BODY = 4 * 1024 * 1024
const MAX_CHANGES = 200

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const reply = (status: number, result: string, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ result, ...extra }), { status, headers: { 'Content-Type': 'application/json' } })
  if (req.method === 'GET') return answerVerification(req, deps)
  if (req.method !== 'POST') return reply(405, 'method')
  const account = new URL(req.url).searchParams.get('account') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(account)) return reply(400, 'missing_account')
  const secret = waSecret('WHATSAPP_APP_SECRET', deps.env)
  if (!secret) return reply(503, 'not_configured')
  const raw = new Uint8Array(await req.arrayBuffer())
  if (raw.length > MAX_BODY) return reply(413, 'too_large')
  if (!(await signatureValid(raw, req.headers.get('X-Hub-Signature-256'), secret))) {
    log('whatsapp-webhook', 'warn', 'signature rejected', { account })
    return reply(401, 'invalid_signature')
  }
  let body: { object?: string; entry?: { id?: string; changes?: { field?: string; value?: unknown }[] }[] }
  try {
    body = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return reply(400, 'invalid_json')
  }
  if (body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return reply(400, 'unexpected_object')
  const changes = body.entry.flatMap((e) => (Array.isArray(e.changes) ? e.changes.map((c) => ({ entry: String(e.id ?? ''), field: String(c.field ?? ''), value: c.value })) : []))
  if (changes.length > MAX_CHANGES) return reply(413, 'too_many_changes')
  const admin = deps.admin()
  const counts: Record<string, number> = {}
  let retry = false
  let limited = false
  for (const c of changes) {
    if (!c.field || !c.value || typeof c.value !== 'object' || Array.isArray(c.value)) { counts.invalid = (counts.invalid ?? 0) + 1; continue }
    const { data, error } = await admin.rpc<{ result: string }>('support_whatsapp_ingest', {
      p_account: account, p_entry_id: c.entry.slice(0, 40), p_field: c.field.slice(0, 80), p_value: c.value, p_event_key: await eventKey(c.entry, c.field, c.value),
    })
    const result = error || !data ? 'ERROR' : data.result
    counts[result.toLowerCase()] = (counts[result.toLowerCase()] ?? 0) + 1
    if (result === 'UNKNOWN') return reply(404, 'unknown_account')
    if (result === 'ERROR') retry = true
    if (result === 'RATE_LIMITED') limited = true
  }
  log('whatsapp-webhook', retry ? 'warn' : 'info', 'webhook processed', { account, ...counts })
  if (limited) return reply(429, 'rate_limited', { counts })
  if (retry) return reply(500, 'retry', { counts })
  return reply(200, 'ok', { counts })
}
