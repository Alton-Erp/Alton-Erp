// Sending shared by whatsapp-send-message (text, image, document) and whatsapp-send-template (approved templates).
//
// support_whatsapp_send_prepare (called with the agent's JWT) enforces permission, the 24-hour customer service
// window, template approval and parameters, and the request key (a repeated click returns the same message).
// Then: media is uploaded to POST /{phone-number-id}/media, the message goes to POST /{phone-number-id}/messages,
// and the answer is recorded. An accepted request stays PENDING: only Meta's status webhooks make it sent /
// delivered / read / failed. A refused request is FAILED with Meta's code; a timeout or 5xx is UNCONFIRMED.

import { BUCKET, corsHeaders, log, type Client } from '../google/google.ts'
import { graphError, graphFetch, graphUrl, waSecret, type WaDeps } from './whatsapp.ts'

export interface SendDeps extends WaDeps {
  allowedOrigins: string[]
  caller(auth: string): Client
}
interface Prepared {
  existing: boolean; id: string; message_id: string; conversation_id: string; status?: string; error_code?: number | null; error_title?: string | null
  account_id?: string; phone_number_id?: string; graph_api_version?: string; kind?: 'TEXT' | 'MEDIA' | 'TEMPLATE'; to?: string | null; user_id?: string | null
  text?: string | null; context_wa_message_id?: string | null
  media?: { kind: 'image' | 'document'; path: string; file_name: string; content_type: string | null; caption: string | null; size_bytes: number } | null
  template?: { name: string; language: string; components: unknown[] } | null
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', txt: 'text/plain', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }

export async function handleSend(req: Request, deps: SendDeps, allowed: ('TEXT' | 'MEDIA' | 'TEMPLATE')[], fn: string): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return reply(401, { error: 'Sign in to send WhatsApp messages.' })
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const kind = String(body.kind ?? '').toUpperCase() as 'TEXT' | 'MEDIA' | 'TEMPLATE'
  if (!allowed.includes(kind)) return reply(400, { error: `${fn} sends ${allowed.join(' / ').toLowerCase()} messages only.` })
  const p = await deps.caller(auth).rpc<Prepared>('support_whatsapp_send_prepare', { p: { ...body, kind } })
  if (p.error || !p.data) return reply(p.error?.code === '42501' ? 403 : 400, { error: p.error?.message ?? 'The message could not be prepared.' })
  const m = p.data
  const answer = (status: string, message: string, extra: Record<string, unknown> = {}) =>
    reply(200, { id: m.id, conversation_id: m.conversation_id, status, message, ...extra })
  if (m.existing) return answer(m.status ?? 'PENDING', 'This message was already submitted; its current status is shown.')

  const admin = deps.admin()
  const record = (outcome: 'ACCEPTED' | 'FAILED' | 'UNCONFIRMED', waId: string | null, recipient: string | null, code: number | null, title: string | null, detail: string | null, http: number | null) =>
    admin.rpc('support_whatsapp_send_result', { p_id: m.id, p_outcome: outcome, p_wa_message_id: waId, p_wa_id: recipient, p_error_code: code, p_error_title: title,
      p_error_detail: detail, p_http: http })
  const token = waSecret('WHATSAPP_ACCESS_TOKEN', deps.env)
  if (!token) {
    await record('FAILED', null, null, null, 'Not configured', 'WHATSAPP_ACCESS_TOKEN is not set on the server.', null)
    return answer('FAILED', 'WhatsApp is not configured on the server (access token missing).')
  }
  const base: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual' }
  // Phone number when known; otherwise the business-scoped user id (users who adopted a username).
  if (m.to) base.to = m.to
  else if (m.user_id) base.recipient = m.user_id
  if (m.context_wa_message_id) base.context = { message_id: m.context_wa_message_id }

  try {
    let payload: Record<string, unknown>
    if (m.kind === 'TEXT') payload = { ...base, type: 'text', text: { body: m.text, preview_url: false } }
    else if (m.kind === 'TEMPLATE') payload = { ...base, type: 'template', template: { name: m.template!.name, language: { code: m.template!.language }, components: m.template!.components } }
    else {
      const media = m.media!
      const file = await admin.storage.from(BUCKET).download(media.path)
      if (!file.data) {
        await record('FAILED', null, null, null, 'File missing', 'The uploaded file could not be read.', null)
        return answer('FAILED', 'The file could not be read; attach it again.')
      }
      const bytes = new Uint8Array(await file.data.arrayBuffer())
      const ext = /\.([A-Za-z0-9]{1,8})$/.exec(media.file_name)?.[1]?.toLowerCase() ?? ''
      const mime = MIME[ext]
      if (!mime || bytes.length === 0 || bytes.length > (media.kind === 'image' ? 5242880 : 26214400)) {
        await record('FAILED', null, null, null, 'File not accepted', 'Type or size not accepted.', null)
        return answer('FAILED', 'The file type or size is not accepted by WhatsApp.')
      }
      const form = new FormData()
      form.append('messaging_product', 'whatsapp')
      form.append('type', mime)
      form.append('file', new Blob([bytes], { type: mime }), media.file_name)
      const up = await graphFetch(deps.fetch, graphUrl(m.graph_api_version, m.phone_number_id, 'media'), token, { method: 'POST', body: form }, 60000)
      if (!up.ok) {
        const e = await graphError(up)
        if (up.status >= 500) {
          await record('FAILED', null, null, e.code, 'Media upload failed', e.title, up.status)
          return answer('FAILED', `Meta did not accept the file upload (HTTP ${up.status}). Nothing was sent; try again.`)
        }
        await record('FAILED', null, null, e.code, e.title, e.detail, up.status)
        return answer('FAILED', `Meta refused the file: ${e.title}`, { error_code: e.code })
      }
      const mediaId = (await up.json().catch(() => ({})) as { id?: string }).id
      if (!mediaId) {
        await record('FAILED', null, null, null, 'Media upload failed', 'Meta returned no media id.', up.status)
        return answer('FAILED', 'Meta returned no media id. Nothing was sent.')
      }
      payload = { ...base, type: media.kind, [media.kind]: media.kind === 'document'
        ? { id: mediaId, filename: media.file_name, ...(media.caption ? { caption: media.caption } : {}) }
        : { id: mediaId, ...(media.caption ? { caption: media.caption } : {}) } }
    }
    let res: Response
    try {
      res = await graphFetch(deps.fetch, graphUrl(m.graph_api_version, m.phone_number_id, 'messages'), token,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    } catch {
      await record('UNCONFIRMED', null, null, null, null, 'No answer from Meta (network error or timeout).', null)
      return answer('PENDING', 'Meta did not answer. The message shows as Pending; check WhatsApp Manager before sending it again.')
    }
    if (res.ok) {
      const j = await res.json().catch(() => ({})) as { messages?: { id?: string }[]; contacts?: { wa_id?: string }[] }
      const waId = j.messages?.[0]?.id ?? null
      if (!waId) {
        await record('UNCONFIRMED', null, null, null, null, 'Meta answered without a message id.', res.status)
        return answer('PENDING', 'Meta did not return a message id. The message shows as Pending.')
      }
      await record('ACCEPTED', waId, j.contacts?.[0]?.wa_id ?? null, null, null, null, res.status)
      log(fn, 'info', 'accepted', { id: m.id })
      return answer('PENDING', 'Accepted by Meta. The status changes to Sent, Delivered or Read when Meta reports it.')
    }
    const e = await graphError(res)
    if (res.status >= 500) {
      await record('UNCONFIRMED', null, null, e.code, null, e.title, res.status)
      return answer('PENDING', `Meta answered HTTP ${res.status}. The message shows as Pending; check WhatsApp Manager before sending it again.`)
    }
    await record('FAILED', null, null, e.code, e.title, e.detail, res.status)
    log(fn, 'warn', 'refused', { id: m.id, code: e.code, status: res.status })
    const hint = e.code === 131047 ? ' The 24-hour window has closed: send an approved template.'
      : e.code === 190 ? ' The access token expired or is invalid: an administrator must replace it.'
      : e.code === 130429 || e.code === 131056 ? ' Rate limit: try again later.'
      : e.code === 132000 || e.code === 132001 ? ' Template parameters or approval do not match Meta: synchronise templates.' : ''
    return answer('FAILED', `Meta refused the message: ${e.title}${e.code ? ` (${e.code})` : ''}.${hint}`, { error_code: e.code })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'The message could not be sent.'
    await record('FAILED', null, null, null, 'Not sent', msg, null)
    return answer('FAILED', msg)
  }
}
