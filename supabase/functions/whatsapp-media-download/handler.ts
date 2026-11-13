// whatsapp-media-download request handling (no Deno / npm imports; unit-tested in tests/unit/whatsapp-functions.test.ts).
//
// Downloads received media asynchronously (never inside the webhook). Callers: the scheduler (x-cron-secret =
// WHATSAPP_CRON_SECRET; the pending queue), an administrator (JWT; the queue), or an agent (JWT, support.view;
// body { message_id } for one message).
//   GET /{media-id}?phone_number_id=…  → { url, mime_type, sha256, file_size }  (the URL is valid for 5 minutes)
//   GET <url> with the access token     → bytes (only Meta media hosts; no redirects followed)
// Checks: size (25 MB bucket limit), executable types blocked, checksum when Meta gave one. Stored in the private
// support-attachments bucket under <company>/whatsapp/<message>/. Webhook media ids expire after 7 days (EXPIRED).

import { BUCKET, corsHeaders, log, safeEqual, type Client } from '../_shared/google/google.ts'
import { authorizeWa, graphError, graphFetch, graphUrl, mediaUrlAllowed, waSecret, type WaDeps, type WaRuntime } from '../_shared/whatsapp/whatsapp.ts'

export interface Deps extends WaDeps {
  allowedOrigins: string[]
  caller(auth: string): Client
}
interface Due { id: string; company_id: string; account_id: string; media_id: string; mime: string | null; sha256: string | null; filename: string | null; msg_type: string }

const MAX_BYTES = 25 * 1048576
const BLOCKED = /^(application\/(x-msdownload|x-msdos-program|x-sh|x-bat|java-archive|vnd\.microsoft\.portable-executable|x-dosexec)|text\/javascript|application\/javascript)/i
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'audio/amr': 'amr', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/plain': 'txt' }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))

export async function downloadOne(deps: Deps, rt: WaRuntime, d: Due, token: string): Promise<string> {
  const admin = deps.admin()
  const done = async (state: string, path: string | null, type: string | null, size: number | null, error: string | null) => {
    await admin.rpc('support_whatsapp_media_result', { p_id: d.id, p_state: state, p_path: path, p_content_type: type, p_size: size, p_error: error })
    return state
  }
  let info: { url?: string; mime_type?: string; sha256?: string; file_size?: number }
  try {
    const res = await graphFetch(deps.fetch, graphUrl(rt.graph_api_version, d.media_id, '', rt.phone_number_id ? { phone_number_id: rt.phone_number_id } : undefined), token)
    if (!res.ok) {
      const e = await graphError(res)
      if (res.status === 404 || res.status === 400) return done('EXPIRED', null, null, null, `Meta no longer has this media (${e.title}).`)
      return done('FAILED', null, null, null, `Media lookup failed: ${e.title}${e.code ? ` (${e.code})` : ''}`)
    }
    info = await res.json()
  } catch {
    return done('FAILED', null, null, null, 'Meta could not be reached.')
  }
  const type = (info.mime_type ?? d.mime ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
  if (BLOCKED.test(type) || /\.(exe|bat|cmd|com|scr|js|vbs|msi|jar|ps1|sh|apk|dll)$/i.test(d.filename ?? '')) return done('BLOCKED', null, null, null, 'Executable or script files are not stored.')
  if (typeof info.file_size === 'number' && info.file_size > MAX_BYTES) return done('TOO_LARGE', null, null, null, 'Larger than 25 MB.')
  if (!info.url || !mediaUrlAllowed(info.url)) return done('FAILED', null, null, null, 'Meta returned a download address outside its media hosts.')
  let bytes: Uint8Array
  try {
    const res = await graphFetch(deps.fetch, info.url, token, { redirect: 'manual' }, 60000)
    if (res.status === 404) return done('FAILED', null, null, null, 'The download link expired; retried on the next run.')
    if (!res.ok) return done('FAILED', null, null, null, `Download failed (HTTP ${res.status}).`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch {
    return done('FAILED', null, null, null, 'Download failed (network error or timeout).')
  }
  if (bytes.length === 0) return done('FAILED', null, null, null, 'Empty file.')
  if (bytes.length > MAX_BYTES) return done('TOO_LARGE', null, null, null, 'Larger than 25 MB.')
  const expected = info.sha256 ?? d.sha256
  if (expected) {
    const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
    if (!safeEqual(expected.toLowerCase(), hex(dig)) && !safeEqual(expected, b64(dig))) return done('FAILED', null, null, null, 'Checksum mismatch.')
  }
  const name = (d.filename ?? `${d.msg_type}.${EXT[type] ?? 'bin'}`).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'media'
  const path = `${d.company_id}/whatsapp/${d.id}/${name}`
  const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false })
  if (up.error && !/exist|duplicate/i.test(up.error.message ?? '')) return done('FAILED', null, null, null, 'Storing the file failed.')
  return done('STORED', path, type, bytes.length, null)
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  let body: { message_id?: string } = {}
  try {
    const t = await req.text()
    body = t ? JSON.parse(t) : {}
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const admin = deps.admin()
  let due: Due[]
  if (body.message_id) {
    // One message, requested by an agent who can see it.
    if (!/^[0-9a-f-]{36}$/i.test(body.message_id)) return reply(400, { error: 'Invalid message.' })
    const auth = req.headers.get('Authorization') ?? ''
    if (!/^Bearer\s+\S+$/.test(auth)) return reply(401, { error: 'Sign in first.' })
    const ok = await deps.caller(auth).rpc<boolean>('support_whatsapp_media_request', { p_id: body.message_id })
    if (ok.error) return reply(ok.error.code === '42501' ? 403 : 400, { error: ok.error.message ?? 'Not allowed.' })
    if (ok.data !== true) return reply(200, { results: [], message: 'Nothing to download for this message.' })
    due = (await admin.rpc<Due[]>('support_whatsapp_media_due', { p_limit: 1, p_message: body.message_id })).data ?? []
  } else {
    const who = await authorizeWa(req, deps)
    if ('status' in who) return reply(who.status, { error: who.error })
    due = ((await admin.rpc<Due[]>('support_whatsapp_media_due', { p_limit: 20 })).data ?? []).filter((d) => who.accounts.includes(d.account_id))
  }
  const token = waSecret('WHATSAPP_ACCESS_TOKEN', deps.env)
  if (!token) return reply(503, { error: 'WHATSAPP_ACCESS_TOKEN is not set.' })
  const runtimes = new Map<string, WaRuntime | null>()
  const results: { id: string; state: string }[] = []
  for (const d of due) {
    if (!runtimes.has(d.account_id)) runtimes.set(d.account_id, (await admin.rpc<WaRuntime | null>('support_whatsapp_runtime', { p_account: d.account_id })).data)
    const rt = runtimes.get(d.account_id)
    if (!rt?.graph_api_version) { results.push({ id: d.id, state: 'SKIPPED' }); continue }
    results.push({ id: d.id, state: await downloadOne(deps, rt, d, token) })
  }
  log('whatsapp-media-download', 'info', 'media run', { count: results.length, stored: results.filter((r) => r.state === 'STORED').length })
  return reply(200, { results })
}
