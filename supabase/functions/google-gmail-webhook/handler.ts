// google-gmail-webhook request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Cloud Pub/Sub push endpoint for Gmail notifications. A notification only says "mailbox X changed, history id
// N" ({ message: { data: base64url {emailAddress, historyId}, messageId, publishTime }, subscription }); the
// mail itself is always fetched from the Gmail API.
//
// Security: the push URL carries ?token=GMAIL_PUSH_TOKEN (compared in constant time). When GMAIL_PUSH_AUDIENCE
// is set, the Pub/Sub OIDC token (authenticated push) is verified too. Body at most 64 KB.
// Idempotency: each Pub/Sub message id is logged once; a redelivery is acknowledged without work.
// Acknowledgement: 2xx acknowledges. Unknown mailboxes and duplicates are acknowledged; a rate-limited burst gets
// 429 so Pub/Sub retries later. A failed sync is still acknowledged: the scheduled sync reconciles the mailbox.

import { b64urlToBytes, log, safeEqual, secret, type Client } from '../_shared/google/google.ts'
import { verifyGoogleOidc } from '../_shared/google/oidc.ts'
import { syncMailbox, type SyncDeps } from '../_shared/google/sync.ts'

export interface Deps extends SyncDeps { admin(): Client }
const MAX_BODY = 64 * 1024

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const reply = (status: number, result: string) => new Response(JSON.stringify({ result }), { status, headers: { 'Content-Type': 'application/json' } })
  if (req.method !== 'POST') return reply(405, 'method')
  const expected = secret('GMAIL_PUSH_TOKEN', deps.env)
  if (!expected) return reply(503, 'not_configured')
  const token = new URL(req.url).searchParams.get('token') ?? ''
  if (!safeEqual(token, expected)) return reply(401, 'unauthorized')
  const audience = secret('GMAIL_PUSH_AUDIENCE', deps.env)
  if (audience) {
    const v = await verifyGoogleOidc(req.headers.get('Authorization'), { audience, serviceAccount: secret('GMAIL_PUSH_SERVICE_ACCOUNT', deps.env), fetch: deps.fetch, now: deps.now() })
    if (!v.ok) {
      log('google-gmail-webhook', 'warn', 'push token rejected', { why: v.reason })
      return reply(401, 'unauthorized')
    }
  }
  const text = await req.text()
  if (text.length > MAX_BODY) return reply(413, 'too_large')
  let envelope: { message?: { data?: string; messageId?: string; message_id?: string; publishTime?: string }; subscription?: string }
  let note: { emailAddress?: string; historyId?: string | number }
  try {
    envelope = JSON.parse(text)
    note = JSON.parse(new TextDecoder().decode(b64urlToBytes(envelope.message?.data ?? '')))
  } catch {
    return reply(400, 'invalid')
  }
  const pubsubId = envelope.message?.messageId ?? envelope.message?.message_id
  const historyId = note.historyId === undefined ? null : String(note.historyId)
  if (typeof note.emailAddress !== 'string' || !pubsubId || (historyId !== null && !/^[0-9]{1,20}$/.test(historyId))) return reply(400, 'invalid')

  const admin = deps.admin()
  const logged = await admin.rpc<{ result: string; account_id?: string; event_id?: string }>('support_gmail_push', {
    p_address: note.emailAddress, p_pubsub_id: String(pubsubId).slice(0, 200), p_history_id: historyId,
    p_details: { publish_time: envelope.message?.publishTime ?? null, subscription: typeof envelope.subscription === 'string' ? envelope.subscription.slice(0, 300) : null },
  })
  if (logged.error || !logged.data) return reply(500, 'error') // Pub/Sub retries
  const r = logged.data
  if (r.result === 'RATE_LIMITED') return reply(429, 'rate_limited')
  if (r.result !== 'LOGGED' || !r.account_id || !r.event_id) return reply(200, r.result.toLowerCase())
  const out = await syncMailbox(deps, r.account_id, { mode: 'auto', maxMessages: 25, reconcile: false })
  await admin.rpc('support_gmail_event_done', { p_event: r.event_id, p_result: out.ok ? 'PROCESSED' : 'ERROR', p_error: out.ok ? null : out.message.slice(0, 500) })
  return reply(200, out.ok ? 'processed' : 'logged')
}
