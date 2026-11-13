// google-gmail-send request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Agents (JWT; support.reply checked by the database):
//   send       support_gmail_send_prepare records the email as PENDING (idempotency key: a repeated click returns
//              the same email) → attachments are read from the private bucket and checked again → the MIME message
//              is built with From = the connected mailbox, Message-ID, In-Reply-To / References → users.messages.send
//              (with threadId for replies; one attempt, never retried automatically).
//              Outcome: SENT only when Gmail returns the message id; FAILED when Gmail refused it (4xx) or the
//              mailbox needs reconnecting; PENDING when the outcome is unknown (timeout, 5xx) — the next mailbox
//              sync confirms it by its Message-ID.
//   mark_read  removes Gmail's UNREAD label from the conversation's received emails, only when gmail.modify was
//              explicitly enabled and granted.

import { Gmail, GmailError } from '../_shared/google/gmail.ts'
import { BUCKET, corsHeaders, log, type Client } from '../_shared/google/google.ts'
import { buildMime, toRaw, type Address } from '../_shared/google/mime.ts'
import { accessToken, type SyncDeps } from '../_shared/google/sync.ts'

export interface Deps extends SyncDeps {
  allowedOrigins: string[]
  caller(authHeader: string): Client
}

interface Prepared {
  existing: boolean; email_id: string; message_id: string; conversation_id: string; account_id?: string; send_state?: string; send_error?: string | null
  from?: Address; to?: Address[]; cc?: Address[]; bcc?: Address[]; subject?: string; body?: string; rfc_message_id?: string
  in_reply_to?: string | null; references?: string | null; thread_id?: string | null
  attachments?: { id: string; path: string; file_name: string; content_type: string | null; size_bytes: number }[]
}

const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'txt', 'csv', 'rtf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']
const MAX_TOTAL = 10 * 1048576
const STATE_LABEL: Record<string, string> = { SENT: 'Sent', PENDING: 'Pending', FAILED: 'Failed' }

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return reply(401, { error: 'Sign in to send email.' })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const caller = deps.caller(auth)
  const admin = deps.admin()

  if (body.action === 'mark_read') {
    const t = await caller.rpc<{ enabled: boolean; account_id?: string; ids?: string[] }>('support_gmail_mark_read_targets', { p_conversation: body.conversation_id })
    if (t.error) return reply(t.error.code === '42501' ? 403 : 400, { error: t.error.message ?? 'Not allowed.' })
    if (!t.data?.enabled || !t.data.account_id || !t.data.ids?.length) return reply(200, { skipped: true })
    const tok = await accessToken(deps, t.data.account_id)
    if (!tok.ok) return reply(502, { error: tok.error })
    try {
      await new Gmail(deps.fetch, tok.token, deps.sleep).removeUnread(t.data.ids)
      await admin.rpc('support_gmail_marked_read', { p_account: t.data.account_id, p_ids: t.data.ids })
      return reply(200, { marked: t.data.ids.length })
    } catch (e) {
      return reply(502, { error: e instanceof Error ? e.message : 'Gmail did not update the mailbox.' })
    }
  }
  if (body.action !== 'send') return reply(400, { error: 'Unknown action.' })

  const p = await caller.rpc<Prepared>('support_gmail_send_prepare', { p: { ...body, action: undefined } })
  if (p.error || !p.data) return reply(p.error?.code === '42501' ? 403 : 400, { error: p.error?.message ?? 'The email could not be prepared.' })
  const e = p.data
  const answer = (state: string, message: string, status = 200) => reply(status, { email_id: e.email_id, conversation_id: e.conversation_id, send_state: state, label: STATE_LABEL[state], message })
  if (e.existing) return answer(e.send_state ?? 'PENDING', 'This email was already submitted; its current status is shown.')
  const result = (outcome: 'SENT' | 'FAILED' | 'UNCONFIRMED', gmailId: string | null, threadId: string | null, error: string | null, http: number | null) =>
    admin.rpc('support_gmail_send_result', { p_email: e.email_id, p_outcome: outcome, p_gmail_id: gmailId, p_thread_id: threadId, p_error: error, p_http: http })

  const tok = await accessToken(deps, e.account_id!)
  if (!tok.ok) {
    await result('FAILED', null, null, tok.error, null)
    return answer('FAILED', tok.error)
  }

  // Attachments: read back from the private bucket and checked again (type and real size).
  const files: { fileName: string; contentType: string | null; bytes: Uint8Array }[] = []
  let total = 0
  for (const a of e.attachments ?? []) {
    const ext = /\.([A-Za-z0-9]{1,8})$/.exec(a.file_name)?.[1]?.toLowerCase() ?? ''
    const d = ALLOWED_EXT.includes(ext) ? await admin.storage.from(BUCKET).download(a.path) : { data: null, error: { message: 'type' } }
    const bytes = d.data ? new Uint8Array(await d.data.arrayBuffer()) : null
    total += bytes?.length ?? 0
    if (!bytes || bytes.length === 0 || bytes.length > MAX_TOTAL || total > MAX_TOTAL) {
      const why = !bytes ? `The attachment ${a.file_name} could not be read.` : `Attachments together must be at most 10 MB.`
      await result('FAILED', null, null, why, null)
      return answer('FAILED', why)
    }
    files.push({ fileName: a.file_name, contentType: a.content_type, bytes })
  }

  let raw: string
  try {
    raw = toRaw(buildMime({ from: e.from!, to: e.to ?? [], cc: e.cc ?? [], bcc: e.bcc ?? [], subject: e.subject ?? '', body: e.body ?? '', messageId: e.rfc_message_id!,
      inReplyTo: e.in_reply_to ?? null, references: e.references ?? null, date: deps.now(), attachments: files }))
  } catch (err) {
    const why = err instanceof Error ? err.message : 'The email could not be built.'
    await result('FAILED', null, null, why, null)
    return answer('FAILED', why)
  }

  try {
    const sent = await new Gmail(deps.fetch, tok.token, deps.sleep).send(raw, e.thread_id ?? null)
    if (!sent.id) {
      await result('UNCONFIRMED', null, null, 'Gmail answered without a message id.', 200)
      return answer('PENDING', 'Gmail did not confirm the message yet. It is confirmed by the next mailbox sync if it was sent.')
    }
    await result('SENT', sent.id, sent.threadId ?? null, null, 200)
    log('google-gmail-send', 'info', 'sent', { email: e.email_id })
    return answer('SENT', 'Sent: Gmail accepted the message.')
  } catch (err) {
    const status = err instanceof GmailError ? err.status : 0
    const msg = err instanceof Error ? err.message : 'Gmail did not answer.'
    log('google-gmail-send', 'warn', 'send not confirmed', { email: e.email_id, status })
    if (status === 401) {
      await admin.rpc('support_gmail_reauth_required', { p_account: e.account_id, p_detail: 'Gmail refused the access token. Reconnect Google Workspace.' })
      await result('FAILED', null, null, 'The mailbox needs to be reconnected.', status)
      return answer('FAILED', 'The mailbox needs to be reconnected by an administrator.')
    }
    if (status >= 400 && status < 500) {
      await result('FAILED', null, null, `Gmail refused the message: ${msg}`, status)
      return answer('FAILED', `Gmail refused the message: ${msg}`)
    }
    // Network error, timeout or 5xx: the message may or may not have been accepted.
    await result('UNCONFIRMED', null, null, `Gmail did not confirm the message (${status ? `HTTP ${status}` : 'no answer'}).`, status || null)
    return answer('PENDING', 'Gmail did not confirm the message. It shows as Pending until the next mailbox sync confirms it.')
  }
}
