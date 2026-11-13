// Mailbox access and synchronisation shared by google-gmail-sync, google-gmail-webhook, google-gmail-send and
// google-gmail-watch-renew.
//
//   * accessToken(): decrypts the stored refresh token and asks Google for a short-lived access token (never
//     stored). invalid_grant (consent revoked, token expired) marks the mailbox "Reauthorization required".
//   * syncMailbox(): history-based sync from the last position (history.list, messageAdded), a full re-sync of
//     recent mail when there is no position or Gmail says it expired (404), and a reconciliation of the last two
//     days so a missed or dropped notification never loses an email. Every message is fetched from the Gmail API
//     (format=full) — a notification carries no content. Storing is idempotent (unique Gmail message id).
//   * The history position advances only past messages that were processed.

import { decryptToken } from './crypto.ts'
import { Gmail, GmailError } from './gmail.ts'
import { BUCKET, b64urlToBytes, log, safeEqual, secret, type Client } from './google.ts'
import { parseGmailMessage, type AttachmentPart, type ParsedEmail } from './mime.ts'
import { refreshAccessToken } from './oauth.ts'

export interface SyncDeps {
  env(name: string): string | undefined
  admin(): Client
  fetch: typeof fetch
  sleep(ms: number): Promise<void>
  now(): Date
}
export interface Runtime {
  company_id: string; account_id: string; mailbox_address: string; connected_address: string | null; display_name: string | null; is_enabled: boolean
  status: string; pubsub_topic: string | null; push_enabled: boolean; mailbox_modify_enabled: boolean; granted_scopes: string[]
  initial_sync_days: number; max_attachment_mb: number; last_history_id: string | null; last_full_sync_at: string | null
  watch_expiration: string | null; has_credentials: boolean
}

export type TokenOutcome = { ok: true; token: string; runtime: Runtime; refreshToken: string } | { ok: false; reauth: boolean; error: string; runtime?: Runtime }

export async function loadRuntime(deps: SyncDeps, account: string): Promise<Runtime | null> {
  const { data, error } = await deps.admin().rpc<Runtime | null>('support_gmail_runtime', { p_account: account })
  return error ? null : data
}

export async function accessToken(deps: SyncDeps, account: string, opts: { requireEnabled?: boolean } = {}): Promise<TokenOutcome> {
  const admin = deps.admin()
  const runtime = await loadRuntime(deps, account)
  if (!runtime) return { ok: false, reauth: false, error: 'Email settings not found.' }
  if ((opts.requireEnabled ?? true) && !runtime.is_enabled) return { ok: false, reauth: false, error: 'The mailbox is not connected.', runtime }
  const clientId = secret('GOOGLE_OAUTH_CLIENT_ID', deps.env)
  const clientSecret = secret('GOOGLE_OAUTH_CLIENT_SECRET', deps.env)
  const key = secret('GOOGLE_TOKEN_ENCRYPTION_KEY', deps.env)
  if (!clientId || !clientSecret || !key) return { ok: false, reauth: false, error: 'The Google OAuth secrets are not configured.', runtime }
  const { data: creds } = await admin.rpc<{ ciphertext: string; iv: string } | null>('support_gmail_credentials', { p_account: account })
  if (!creds) return { ok: false, reauth: true, error: 'No stored authorisation. Reconnect Google Workspace.', runtime }
  let refreshToken: string
  try {
    refreshToken = await decryptToken(creds.ciphertext, creds.iv, key, account)
  } catch {
    const msg = 'The stored authorisation cannot be decrypted (the encryption key changed). Reconnect Google Workspace.'
    await admin.rpc('support_gmail_reauth_required', { p_account: account, p_detail: msg })
    return { ok: false, reauth: true, error: msg, runtime }
  }
  const t = await refreshAccessToken(deps.fetch, { refreshToken, clientId, clientSecret })
  if (!t.ok || !t.accessToken) {
    if (t.revoked) {
      const msg = 'Google no longer accepts the authorisation (revoked or expired). Reconnect Google Workspace.'
      await admin.rpc('support_gmail_reauth_required', { p_account: account, p_detail: msg })
      return { ok: false, reauth: true, error: msg, runtime }
    }
    return { ok: false, reauth: false, error: t.error ?? 'Google token request failed.', runtime }
  }
  return { ok: true, token: t.accessToken, runtime, refreshToken }
}

const safeName = (s: string) => (s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'attachment')

export interface IngestResult {
  result: 'STORED' | 'DUPLICATE' | 'CONFIRMED' | 'IGNORED'; email_id?: string; conversation_id?: string
  attachments?: (AttachmentPart & { state?: string })[]
}

/** Fetches, parses and stores one Gmail message and its attachments. */
export async function processMessage(deps: SyncDeps, gmail: Gmail, rt: Runtime, id: string): Promise<IngestResult['result'] | 'FAILED'> {
  const admin = deps.admin()
  let parsed: { email: ParsedEmail; inlineData: Map<string, string> }
  try {
    parsed = parseGmailMessage(await gmail.get(id), rt.max_attachment_mb * 1048576)
  } catch (e) {
    if (e instanceof GmailError && e.status === 404) return 'IGNORED' // deleted since
    throw e
  }
  const { data, error } = await admin.rpc<IngestResult>('support_gmail_ingest', { p_account: rt.account_id, p: parsed.email })
  if (error || !data) {
    log('gmail-sync', 'error', 'ingest failed', { account: rt.account_id, gmail_id: id, error: error?.message })
    return 'FAILED'
  }
  for (const a of data.attachments ?? []) {
    const path = `${rt.company_id}/email/${data.email_id}/${a.part_id.replace(/[^0-9.]/g, '')}-${safeName(a.filename)}`
    try {
      let b64: string | undefined = parsed.inlineData.get(a.part_id)
      if (!b64 && a.attachment_id) b64 = (await gmail.attachment(id, a.attachment_id)).data
      if (!b64) throw new Error('No attachment content.')
      const bytes = b64urlToBytes(b64)
      if (bytes.length > rt.max_attachment_mb * 1048576) throw new Error('Larger than the attachment limit.')
      const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: a.mime_type || 'application/octet-stream', upsert: false })
      if (up.error && !/exist|duplicate/i.test(up.error.message ?? '')) throw new Error(up.error.message ?? 'Upload failed.')
      await admin.rpc('support_gmail_attachment_result', { p_email: data.email_id, p_part_id: a.part_id, p_ok: true, p_path: path, p_file_name: a.filename,
        p_content_type: a.mime_type, p_size: bytes.length })
    } catch (e) {
      await admin.rpc('support_gmail_attachment_result', { p_email: data.email_id, p_part_id: a.part_id, p_ok: false, p_path: null, p_file_name: a.filename,
        p_content_type: a.mime_type, p_size: null, p_reason: e instanceof Error ? e.message.slice(0, 200) : 'Download failed.' })
    }
  }
  return data.result
}

async function unknownIds(deps: SyncDeps, account: string, ids: string[]): Promise<string[]> {
  const known = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await deps.admin().rpc<string[]>('support_gmail_known', { p_account: account, p_ids: ids.slice(i, i + 200) })
    for (const x of data ?? []) known.add(x)
  }
  return ids.filter((x) => !known.has(x))
}

export interface SyncOptions {
  /** auto: history (or full when needed) + reconciliation; full: re-sync recent mail; replay: history from a given position. */
  mode: 'auto' | 'full' | 'replay'
  startHistoryId?: string | null
  maxMessages: number
  reconcile: boolean
}
export interface SyncSummary { ok: boolean; kind: string; stored: number; duplicates: number; confirmed: number; ignored: number; failed: number; remaining: number; message: string }

export async function syncMailbox(deps: SyncDeps, account: string, opts: SyncOptions): Promise<SyncSummary> {
  const admin = deps.admin()
  const s: SyncSummary = { ok: false, kind: opts.mode === 'full' ? 'FULL' : 'HISTORY', stored: 0, duplicates: 0, confirmed: 0, ignored: 0, failed: 0, remaining: 0, message: '' }
  const finish = async (ok: boolean, message: string, historyId: string | null) => {
    s.ok = ok
    s.message = message
    await admin.rpc('support_gmail_sync_state', { p_account: account, p_history_id: historyId, p_ok: ok, p_message: message,
      p_kind: s.kind, p_counts: { stored: s.stored, duplicates: s.duplicates, confirmed: s.confirmed, ignored: s.ignored, failed: s.failed, remaining: s.remaining } })
    return s
  }
  const tok = await accessToken(deps, account)
  if (!tok.ok) {
    s.message = tok.error
    if (!tok.reauth && tok.runtime?.is_enabled) await finish(false, tok.error, null)
    return s
  }
  const rt = tok.runtime
  const gmail = new Gmail(deps.fetch, tok.token, deps.sleep)
  let budget = opts.maxMessages
  const run = async (ids: string[]) => {
    for (const id of ids) {
      if (budget <= 0) { s.remaining++; continue }
      budget--
      const r = await processMessage(deps, gmail, rt, id)
      if (r === 'STORED') s.stored++
      else if (r === 'DUPLICATE') s.duplicates++
      else if (r === 'CONFIRMED') s.confirmed++
      else if (r === 'IGNORED') s.ignored++
      else s.failed++
    }
  }

  const full = async (): Promise<string | null> => {
    s.kind = 'FULL'
    const profile = await gmail.profile()
    const ids: string[] = []
    let page: string | undefined
    do {
      const r = await gmail.list(`newer_than:${rt.initial_sync_days}d (in:inbox OR in:sent)`, 500, page)
      for (const m of r.messages ?? []) ids.push(m.id)
      page = r.nextPageToken
    } while (page && ids.length < 2000)
    // Gmail lists newest first: keep the newest within the budget, then store them oldest first.
    const missing = await unknownIds(deps, account, ids)
    const pick = missing.slice(0, Math.max(0, budget))
    s.remaining += missing.length - pick.length
    await run(pick.reverse())
    return profile.historyId
  }

  try {
    let position: string | null
    const start = opts.mode === 'replay' ? opts.startHistoryId ?? null : rt.last_history_id
    if (opts.mode === 'full' || !start || (opts.mode === 'auto' && !rt.last_full_sync_at)) {
      position = await full()
    } else {
      // History: every message added since the last position, oldest first.
      const added: { id: string; history: string }[] = []
      let page: string | undefined
      let latest: string | null = null
      try {
        do {
          const h = await gmail.history(start, page)
          for (const rec of h.history ?? []) for (const a of rec.messagesAdded ?? []) added.push({ id: a.message.id, history: rec.id })
          latest = h.historyId ?? latest
          page = h.nextPageToken
        } while (page && added.length < 5000)
      } catch (e) {
        if (e instanceof GmailError && e.status === 404) {
          if (opts.mode === 'replay') return await finish(false, 'That notification is too old: Gmail no longer has its history. Run a full sync instead.', null)
          log('gmail-sync', 'warn', 'history expired; full re-sync', { account })
          position = await full()
          if (opts.reconcile) await reconcile()
          return await finish(s.failed === 0, summary('Gmail history had expired; recent mail re-synchronised'), position)
        }
        throw e
      }
      const seen = new Set<string>()
      const unique = added.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
      const todo = new Set(await unknownIds(deps, account, unique.map((a) => a.id)))
      // The position freezes before the first message that ran out of budget or failed, so it is read again next time.
      let processedUpTo: string | null = null
      let stopped = false
      for (const a of unique) {
        if (!todo.has(a.id)) { if (!stopped) processedUpTo = a.history; continue }
        if (budget <= 0) { stopped = true; s.remaining++; continue }
        const failedBefore = s.failed
        await run([a.id])
        if (s.failed > failedBefore) stopped = true
        if (!stopped) processedUpTo = a.history
      }
      // Advance only past what was processed; with work left the next run continues from there.
      position = stopped ? processedUpTo : latest ?? processedUpTo
      if (opts.mode === 'replay') s.kind = 'REPLAY'
    }
    if (opts.reconcile && opts.mode !== 'replay') await reconcile()
    return await finish(s.failed === 0, summary(s.kind === 'FULL' ? 'Recent mail synchronised' : 'Mailbox history synchronised'), position)
  } catch (e) {
    const msg = e instanceof GmailError ? `Gmail API error ${e.status}: ${e.message}` : e instanceof Error ? e.message : 'Sync failed.'
    if (e instanceof GmailError && e.status === 401) {
      await admin.rpc('support_gmail_reauth_required', { p_account: account, p_detail: 'Gmail refused the access token. Reconnect Google Workspace.' })
      s.message = msg
      return s
    }
    log('gmail-sync', 'error', 'sync failed', { account, status: e instanceof GmailError ? e.status : null, reason: e instanceof GmailError ? e.reason : null })
    return await finish(false, msg.slice(0, 400), null)
  }

  async function reconcile() {
    // Periodic safety net: anything in the last two days that is not stored yet.
    const r = await gmail.list('newer_than:2d (in:inbox OR in:sent)', 100)
    const missing = await unknownIds(deps, account, (r.messages ?? []).map((m) => m.id))
    await run(missing.reverse())
  }
  function summary(head: string) {
    const parts = [`${s.stored} new`, s.confirmed ? `${s.confirmed} sent confirmed` : '', s.duplicates ? `${s.duplicates} already stored` : '',
      s.failed ? `${s.failed} failed` : '', s.remaining ? `${s.remaining} left for the next run` : ''].filter(Boolean)
    return `${head}: ${parts.join(', ')}.`
  }
}

/** Authorises the scheduler (x-cron-secret) or an administrator (JWT, support.manage_integrations). */
export async function authorizeScheduler(req: Request, deps: { env(name: string): string | undefined; admin(): Client; caller(auth: string): Client }):
  Promise<{ accounts: string[]; caller: Client | null } | { status: number; error: string }> {
  const cron = req.headers.get('x-cron-secret')
  if (cron) {
    const expected = secret('GOOGLE_CRON_SECRET', deps.env)
    if (!expected || !safeEqual(cron, expected)) return { status: 401, error: 'Not allowed.' }
    const { data, error } = await deps.admin().rpc<(string | { support_gmail_accounts: string })[]>('support_gmail_accounts')
    if (error) return { status: 500, error: 'Accounts could not be read.' }
    return { accounts: (data ?? []).map((x) => (typeof x === 'string' ? x : x.support_gmail_accounts)), caller: null }
  }
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return { status: 401, error: 'Sign in first.' }
  const caller = deps.caller(auth)
  const { data, error } = await caller.rpc<{ account_id: string } | null>('support_email_admin_check')
  if (error) return { status: error.code === '42501' ? 403 : 400, error: error.message ?? 'Not allowed.' }
  if (!data) return { status: 400, error: 'Save the email settings first.' }
  return { accounts: [data.account_id], caller }
}
