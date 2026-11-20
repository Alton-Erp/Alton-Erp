// Mailbox access and synchronisation shared by google-gmail-sync, google-gmail-webhook, google-gmail-send and
// google-gmail-watch-renew.
//
//   * accessToken(): decrypts the stored refresh token and asks Google for a short-lived access token (never
//     stored). invalid_grant (consent revoked, token expired) marks the mailbox "Reauthorization required".
//   * runSync(): one resumable batch (migration 20261224090000). Under a database lock per mailbox it
//       1. queues message ids: mailbox history since the checkpoint (history.list, messageAdded), a full re-sync's
//          discovery (one list page at a time, page token saved), a reconciliation of the last two days;
//       2. fetches a few queued messages (format=full; a notification carries no content) and stores each
//          (support_gmail_ingest, idempotent by Gmail message id) — attachment parts are recorded, not downloaded;
//       3. downloads a few pending attachments into the private bucket.
//     It stops starting new work at its time / CPU / count budget and reports whether more is left; the next
//     invocation (continuation, scheduler or notification) carries on from the stored progress.
//   * The history checkpoint only moves past ids that are durably queued, in the same transaction.

import { decryptToken } from './crypto.ts'
import { Gmail, GmailError, type GmailMessage, type GmailPart } from './gmail.ts'
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
const MB = 1048576

export interface IngestResult {
  result: 'STORED' | 'DUPLICATE' | 'CONFIRMED' | 'IGNORED'; email_id?: string; conversation_id?: string
  attachments?: (AttachmentPart & { state?: string })[]
}

// ---- Limits ---------------------------------------------------------------------------------------------------
/**
 * What one invocation may do. Supabase Edge Functions stop a worker that exceeds its memory, wall-clock or CPU-time
 * limit (HTTP 546); the old single-run sync of up to 300 messages with every attachment exceeded them. A run now
 * stops starting new work when any of these is reached and reports that more is left.
 */
export interface SyncLimits {
  /** Messages fetched (format=full), parsed and stored per invocation. */
  messages: number
  /** Attachments downloaded and uploaded per invocation (at least one is always allowed when one is due). */
  attachments: number
  /** Attachment bytes per invocation (a single larger file is still processed on its own). */
  attachmentBytes: number
  /** Wall-clock budget: no new step starts after this. */
  timeBudgetMs: number
  /** Measured synchronous work (parsing, sanitising, base64 decoding): the part that counts against the CPU limit. */
  cpuBudgetMs: number
  /** Mailbox-history pages and full-sync discovery pages (500 ids each) read per invocation. */
  historyPages: number
  discoveryPages: number
  /** Lock lifetime; a lock not renewed within it is stale (its worker died) and is taken over. */
  lockTtlSeconds: number
  /** Per Gmail request. */
  requestTimeoutMs: number
}
const num = (env: (k: string) => string | undefined, k: string, d: number, lo: number, hi: number) => {
  const v = Number(env(k))
  return Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, Math.floor(v))) : d
}
/** Defaults, adjustable with GMAIL_SYNC_* environment values (never secrets). */
export function syncLimits(env: (k: string) => string | undefined, kind: 'run' | 'webhook' = 'run'): SyncLimits {
  const webhook = kind === 'webhook'
  return {
    messages: num(env, 'GMAIL_SYNC_BATCH_SIZE', webhook ? 5 : 12, 1, 50),
    attachments: num(env, 'GMAIL_SYNC_ATTACHMENTS', webhook ? 1 : 4, 0, 20),
    attachmentBytes: num(env, 'GMAIL_SYNC_ATTACHMENT_MB', 15, 1, 60) * MB,
    timeBudgetMs: num(env, 'GMAIL_SYNC_TIME_BUDGET_MS', webhook ? 15000 : 30000, 5000, 120000),
    cpuBudgetMs: num(env, 'GMAIL_SYNC_CPU_BUDGET_MS', webhook ? 600 : 1200, 200, 10000),
    historyPages: webhook ? 2 : 4,
    discoveryPages: 4,
    lockTtlSeconds: num(env, 'GMAIL_SYNC_LOCK_TTL_SECONDS', 120, 30, 900),
    requestTimeoutMs: 15000,
  }
}

// ---- One run ----------------------------------------------------------------------------------------------------
export interface RunOptions {
  /** auto: history + queued work (+ a full re-sync when there is no position yet); full: start or resume a full re-sync;
   *  replay: queue the history from one notification's position; webhook: like auto with smaller limits, no reconciliation. */
  mode: 'auto' | 'full' | 'replay' | 'webhook'
  startHistoryId?: string | null
  requestedBy?: string | null
  limits: SyncLimits
}
export interface Remaining {
  queue: number; queue_ready: number; failed: number; attachments: number; attachments_ready: number; attachments_failed: number; discovery: boolean
}
export interface SyncSummary {
  ok: boolean
  /** Another worker holds the mailbox lock; it continues the work. */
  busy: boolean
  kind: 'HISTORY' | 'FULL' | 'REPLAY'
  stage: string
  message: string
  job_id: string | null
  stale_lock_recovered: boolean
  history_pages: number; discovered: number; queued: number
  fetched: number; stored: number; duplicates: number; confirmed: number; ignored: number; failed: number
  attachments: number; attachments_failed: number; bytes: number
  /** Attachment downloads from Gmail (the attachments budget); small parts inside the message need none. */
  downloads: number
  duration_ms: number; cpu_ms: number
  /** Messages still queued (compatible with the earlier summary). */
  remaining: number
  remaining_detail: Remaining | null
  /** More work can be done now: the caller schedules a continuation. */
  more: boolean
  /** This run changed something (used to stop a continuation chain that makes no progress). */
  progressed: boolean
}

interface Begin {
  acquired: boolean; busy_until?: string; stale_lock_recovered?: boolean; history_id: string | null; needs_full: boolean; reconcile_due: boolean; job: Job | null
  full_requested?: boolean; full_requested_by?: string | null
}
interface Job { id: string; status: string; query: string; days: number; page_token: string | null; discovery_done: boolean; discovery_restarts: number }
interface Item { id: number; gmail_message_id: string; source: string; attempts: number }
interface Part { email_id: string; gmail_message_id: string; part_id: string; attachment_id: string | null; filename: string; mime_type: string | null; size: number | null; attempts: number }

class LockLost extends Error {}

/** Finds the inline (body.data) content of one part, for the rare part Gmail did not give an attachment id. */
function partData(part: GmailPart | undefined, partId: string): string | null {
  if (!part) return null
  if (part.partId === partId) return part.body?.data ?? null
  for (const c of part.parts ?? []) { const d = partData(c, partId); if (d) return d }
  return null
}

export async function runSync(deps: SyncDeps, account: string, opts: RunOptions): Promise<SyncSummary> {
  const admin = deps.admin()
  const L = opts.limits
  const t0 = deps.now().getTime()
  const elapsed = () => deps.now().getTime() - t0
  let cpu = 0
  const measure = <T>(fn: () => T): T => { const a = performance.now(); try { return fn() } finally { cpu += performance.now() - a } }
  const timeLeft = (reserve: number) => elapsed() + reserve < L.timeBudgetMs && cpu < L.cpuBudgetMs
  const s: SyncSummary = { ok: false, busy: false, kind: opts.mode === 'replay' ? 'REPLAY' : 'HISTORY', stage: 'lock', message: '', job_id: null, stale_lock_recovered: false,
    history_pages: 0, discovered: 0, queued: 0, fetched: 0, stored: 0, duplicates: 0, confirmed: 0, ignored: 0, failed: 0, attachments: 0, attachments_failed: 0, bytes: 0, downloads: 0,
    duration_ms: 0, cpu_ms: 0, remaining: 0, remaining_detail: null, more: false, progressed: false }
  const owner = crypto.randomUUID()
  // Every progress write carries the lock owner; the database refuses it once another worker took the lock over.
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc<T>(fn, { p_account: account, p_owner: owner, ...args })
    if (error) {
      if (/LOCK_LOST/.test(error.message ?? '')) throw new LockLost(error.message)
      throw new Error(`${fn}: ${error.message ?? 'database error'}`)
    }
    return data as T
  }
  const counts = () => ({ batch_kind: s.kind, job_id: s.job_id, history_pages: s.history_pages, discovered: s.discovered, queued: s.queued, fetched: s.fetched,
    stored: s.stored, duplicates: s.duplicates, confirmed: s.confirmed, ignored: s.ignored, failed: s.failed, attachments: s.attachments,
    attachments_failed: s.attachments_failed, bytes: s.bytes, downloads: s.downloads, duration_ms: elapsed(), cpu_ms: Math.round(cpu) })
  const finish = async (ok: boolean, message: string) => {
    s.ok = ok
    s.message = message
    s.duration_ms = elapsed()
    s.cpu_ms = Math.round(cpu)
    const { data } = await admin.rpc<{ released: boolean; more?: boolean; remaining?: Remaining }>('support_gmail_sync_finish',
      { p_account: account, p_owner: owner, p_summary: counts(), p_ok: ok, p_message: message.slice(0, 500), p_stage: ok ? null : s.stage })
    s.remaining_detail = data?.remaining ?? null
    s.remaining = data?.remaining?.queue ?? 0
    s.more = Boolean(data?.more)
    s.progressed = s.history_pages + s.discovered + s.queued + s.fetched + s.attachments + s.attachments_failed > 0
    log('gmail-sync', ok ? 'info' : 'error', 'batch', { account, ...counts(), ok, stage: s.stage, more: s.more, remaining: s.remaining_detail })
    return s
  }

  let begin: Begin
  {
    const { data, error } = await admin.rpc<Begin>('support_gmail_sync_begin', { p_account: account, p_owner: owner, p_ttl_seconds: L.lockTtlSeconds })
    if (error || !data) { s.message = `The sync state could not be read: ${error?.message ?? 'no answer'}`; return s }
    begin = data
  }
  if (!begin.acquired) {
    // A full re-sync asked for meanwhile is recorded; the running batch (or the next one) starts it.
    if (opts.mode === 'full') await admin.rpc('support_gmail_sync_request_full', { p_account: account, p_by: opts.requestedBy ?? null })
    Object.assign(s, { ok: true, busy: true, stage: 'lock', message: opts.mode === 'full'
      ? 'A sync of this mailbox is running; the full re-sync starts with its next batch.' : 'A sync of this mailbox is already running; it continues the remaining work.' })
    return s
  }
  s.stale_lock_recovered = Boolean(begin.stale_lock_recovered)
  if (s.stale_lock_recovered) log('gmail-sync', 'warn', 'stale lock taken over (the previous worker stopped)', { account })

  s.stage = 'token'
  const tok = await accessToken(deps, account)
  if (!tok.ok) {
    s.ok = false
    if (tok.reauth) {
      await admin.rpc('support_gmail_sync_finish', { p_account: account, p_owner: owner, p_summary: counts(), p_ok: false, p_message: tok.error, p_stage: 'token' })
      s.message = tok.error
      return s
    }
    return finish(false, tok.error)
  }
  const rt = tok.runtime
  const gmail = new Gmail(deps.fetch, tok.token, deps.sleep, L.requestTimeoutMs)
  const maxBytes = rt.max_attachment_mb * MB
  let job: Job | null = begin.job
  let checkpoint = begin.history_id
  if (job) { s.job_id = job.id; s.kind = 'FULL' }

  const startJob = async (reason: 'MANUAL' | 'INITIAL' | 'HISTORY_EXPIRED', by: string | null = opts.requestedBy ?? null) => {
    s.stage = 'full-start'
    const profile = await gmail.profile()
    const r = await call<{ job: Job }>('support_gmail_sync_job_start', { p_history_id: profile.historyId ?? null,
      p_query: `newer_than:${rt.initial_sync_days}d (in:inbox OR in:sent)`, p_days: rt.initial_sync_days, p_reason: reason, p_by: by })
    job = r.job
    s.job_id = job.id
    s.kind = 'FULL'
    if (!checkpoint || reason === 'HISTORY_EXPIRED') checkpoint = profile.historyId ?? checkpoint
  }

  /** Reads history pages from `start` and queues the added messages. With `advance`, the checkpoint moves to the
   *  last record of each page queued (to Gmail's current id after the last page), never past an unread page. */
  const readHistory = async (start: string, advance: boolean) => {
    let page: string | undefined
    let pages = 0
    do {
      const h = await gmail.history(start, page)
      const ids: string[] = []
      let last: string | null = null
      for (const rec of h.history ?? []) {
        last = rec.id
        for (const a of rec.messagesAdded ?? []) ids.push(a.message.id)
      }
      page = h.nextPageToken
      const next = advance ? (page ? last : h.historyId ?? last) : null
      if (ids.length || next) {
        const r = await call<{ added: number }>('support_gmail_sync_enqueue', { p_ids: ids, p_source: opts.mode === 'replay' ? 'REPLAY' : 'HISTORY', p_history_id: next })
        s.queued += r.added
      }
      if (next) checkpoint = next
      pages++
      s.history_pages++
    } while (page && pages < L.historyPages && timeLeft(5000))
  }

  const processItem = async (it: Item): Promise<'ok' | 'failed'> => {
    const fail = async (why: string) => {
      s.failed++
      await call('support_gmail_sync_item_result', { p_item: it.id, p_ok: false, p_result: null, p_error: why.slice(0, 500) })
      return 'failed' as const
    }
    s.fetched++
    let msg: GmailMessage | null
    try {
      msg = await gmail.get(it.gmail_message_id)
    } catch (e) {
      if (e instanceof GmailError && e.status === 404) {
        s.ignored++
        await call('support_gmail_sync_item_result', { p_item: it.id, p_ok: true, p_result: 'IGNORED' }) // deleted since
        return 'ok'
      }
      if (e instanceof GmailError && e.status === 401) throw e
      return fail(e instanceof GmailError ? `Gmail API error ${e.status}: ${e.message}` : e instanceof Error ? e.message : 'Fetch failed.')
    }
    let parsed: { email: ParsedEmail; inlineData: Map<string, string> } | null
    try {
      const m = msg
      parsed = measure(() => parseGmailMessage(m, maxBytes))
    } catch (e) {
      return fail(`The message could not be read: ${e instanceof Error ? e.message : 'parse error'}`)
    }
    msg = null
    const { data, error } = await admin.rpc<IngestResult>('support_gmail_ingest', { p_account: rt.account_id, p: parsed.email })
    if (error || !data) return fail(`Storing failed: ${error?.message ?? 'no answer'}`)
    // Small parts Gmail sent inside the message are already in memory: store them now. Parts with an attachment id
    // stay PENDING for the attachment stage.
    for (const a of data.attachments ?? []) {
      const inline = parsed.inlineData.get(a.part_id)
      if (!inline || !data.email_id) continue
      await storePart({ email_id: data.email_id, gmail_message_id: it.gmail_message_id, part_id: a.part_id, attachment_id: null, filename: a.filename,
        mime_type: a.mime_type, size: a.size, attempts: 0 }, inline)
    }
    parsed = null
    const r = data.result
    if (r === 'STORED') s.stored++
    else if (r === 'DUPLICATE') s.duplicates++
    else if (r === 'CONFIRMED') s.confirmed++
    else s.ignored++
    await call('support_gmail_sync_item_result', { p_item: it.id, p_ok: true, p_result: r })
    return 'ok'
  }

  /** Downloads (unless given) one attachment part and copies it to the private bucket. Idempotent: the path is fixed
   *  per email and part, an existing object counts as stored, and the attachment row is unique per path. */
  async function storePart(p: Part, given?: string): Promise<void> {
    const path = `${rt.company_id}/email/${p.email_id}/${p.part_id.replace(/[^0-9.]/g, '')}-${safeName(p.filename)}`
    try {
      let b64: string | null | undefined = given
      if (!b64) s.downloads++
      if (!b64 && p.attachment_id) b64 = (await gmail.attachment(p.gmail_message_id, p.attachment_id)).data
      if (!b64) {
        const full = await gmail.get(p.gmail_message_id)
        b64 = partData(full.payload, p.part_id)
      }
      if (!b64) throw new Error('No attachment content.')
      const encoded = b64
      b64 = null
      let bytes: Uint8Array | null = measure(() => b64urlToBytes(encoded))
      if (bytes.length > maxBytes) throw new Error(`Larger than the ${rt.max_attachment_mb} MB attachment limit.`)
      const size = bytes.length
      const up = await admin.storage.from(BUCKET).upload(path, bytes, { contentType: p.mime_type || 'application/octet-stream', upsert: false })
      bytes = null
      if (up.error && !/exist|duplicate/i.test(up.error.message ?? '')) throw new Error(up.error.message ?? 'Upload failed.')
      const done = await admin.rpc('support_gmail_attachment_result', { p_email: p.email_id, p_part_id: p.part_id, p_ok: true, p_path: path, p_file_name: p.filename,
        p_content_type: p.mime_type, p_size: size })
      if (done.error) throw new Error(done.error.message ?? 'Recording the attachment failed.')
      s.attachments++
      s.bytes += size
    } catch (e) {
      if (e instanceof GmailError && e.status === 401) throw e
      s.attachments_failed++
      const why = e instanceof GmailError ? `Gmail API error ${e.status}: ${e.message}` : e instanceof Error ? e.message : 'Download failed.'
      await admin.rpc('support_gmail_attachment_failed', { p_email: p.email_id, p_part_id: p.part_id, p_reason: why.slice(0, 200) })
      log('gmail-sync', 'warn', 'attachment failed', { account, email_id: p.email_id, part_id: p.part_id, reason: why.slice(0, 200) })
    }
  }

  try {
    // 1. Position: replay queues one notification's history; otherwise history from the checkpoint, and a full
    //    re-sync when asked for or when there is no usable position.
    if (opts.mode === 'replay') {
      s.stage = 'replay'
      if (!opts.startHistoryId) return await finish(false, 'The notification has no mailbox position to replay.')
      try {
        await readHistory(opts.startHistoryId, false)
      } catch (e) {
        if (e instanceof GmailError && e.status === 404) return await finish(false, 'That notification is too old: Gmail no longer has its history. Run a full sync instead.')
        throw e
      }
    } else {
      if (!job && (opts.mode === 'full' || begin.full_requested || (opts.mode === 'auto' && begin.needs_full))) {
        await startJob(opts.mode === 'full' || begin.full_requested ? 'MANUAL' : 'INITIAL', opts.requestedBy ?? begin.full_requested_by ?? null)
      }
      if (checkpoint) {
        s.stage = 'history'
        try {
          await readHistory(checkpoint, true)
        } catch (e) {
          if (!(e instanceof GmailError && e.status === 404)) throw e
          log('gmail-sync', 'warn', 'history expired; full re-sync', { account })
          if (!job) await startJob('HISTORY_EXPIRED')
        }
      }
      // Safety net (every 15 minutes): anything of the last two days not stored yet is queued.
      if (opts.mode === 'auto' && begin.reconcile_due && timeLeft(5000)) {
        s.stage = 'reconcile'
        const r = await gmail.list('newer_than:2d (in:inbox OR in:sent)', 100)
        s.queued += (await call<{ added: number }>('support_gmail_sync_enqueue', { p_ids: (r.messages ?? []).map((m) => m.id), p_source: 'RECONCILE', p_history_id: null })).added
      }
      // 2. Full re-sync discovery: one list page (ids only) at a time; the page token is saved after each page.
      if (job && !job.discovery_done && opts.mode !== 'webhook') {
        s.stage = 'discovery'
        let pages = 0
        while (job && !job.discovery_done && pages < L.discoveryPages && timeLeft(5000)) {
          const token = job.page_token ?? undefined
          let r: Awaited<ReturnType<Gmail['list']>>
          try {
            r = await gmail.list(job.query, 500, token)
          } catch (e) {
            // An expired or invalid page token: start discovery again (queued and stored ids are skipped).
            if (token && e instanceof GmailError && e.status === 400) {
              if (job.discovery_restarts >= 3) {
                await call('support_gmail_sync_job_fail', { p_job: job.id, p_error: 'Gmail kept refusing the listing position; start a Full re-sync again.', p_stage: 'discovery' })
                job = null
                break
              }
              const rs: { restarts: number } = await call<{ restarts: number }>('support_gmail_sync_discovered', { p_job: job.id, p_ids: [], p_next_page: null, p_restart: true })
              log('gmail-sync', 'warn', 'page token expired; discovery restarted', { account, job_id: s.job_id })
              job = { ...job, page_token: null, discovery_restarts: rs.restarts }
              continue
            }
            throw e
          }
          const d: { added: number; done: boolean } = await call<{ added: number; done: boolean }>('support_gmail_sync_discovered', { p_job: job.id, p_ids: (r.messages ?? []).map((m) => m.id),
            p_next_page: r.nextPageToken ?? null, p_restart: false })
          s.discovered += d.added
          job = { ...job, page_token: r.nextPageToken ?? null, discovery_done: d.done }
          pages++
        }
      }
    }

    // 3. Messages: a few at a time, oldest first; each outcome is stored before the next starts.
    s.stage = 'messages'
    let failuresInARow = 0
    let budget = L.messages
    while (budget > 0 && timeLeft(8000) && failuresInARow < 3) {
      const items = await call<Item[]>('support_gmail_sync_next', { p_limit: budget })
      if (!items.length) break
      for (const it of items) {
        if (budget <= 0 || !timeLeft(8000) || failuresInARow >= 3) break
        budget--
        failuresInARow = (await processItem(it)) === 'failed' ? failuresInARow + 1 : 0
      }
    }

    // 4. Attachments: separately, within a count and byte budget.
    s.stage = 'attachments'
    if (L.attachments > 0 && timeLeft(10000)) {
      const parts = await call<Part[]>('support_gmail_sync_attachments_next', { p_limit: L.attachments })
      for (const p of parts) {
        if (!timeLeft(10000)) break
        if (s.downloads >= L.attachments) break
        if (s.downloads > 0 && s.bytes + (p.size ?? 0) > L.attachmentBytes) break
        await storePart(p)
      }
    }

    s.stage = 'done'
    return await finish(true, describe(s))
  } catch (e) {
    if (e instanceof LockLost) {
      // Another worker owns the mailbox now; it continues. Nothing is released or reported from here.
      log('gmail-sync', 'warn', 'lock lost; stopping', { account, stage: s.stage })
      Object.assign(s, { ok: false, message: 'This run took too long and another sync took over the mailbox; it continues the work.', duration_ms: elapsed() })
      return s
    }
    if (e instanceof GmailError && e.status === 401) {
      await admin.rpc('support_gmail_reauth_required', { p_account: account, p_detail: 'Gmail refused the access token. Reconnect Google Workspace.' })
      return finish(false, 'Gmail refused the access token. Reconnect Google Workspace.')
    }
    const msg = e instanceof GmailError ? `Gmail API error ${e.status}: ${e.message}` : e instanceof Error ? e.message : 'Sync failed.'
    return finish(false, `Sync stopped at ${s.stage}: ${msg}`.slice(0, 400))
  }
}

const n = (x: number, one: string, many = `${one}s`) => `${x.toLocaleString('en-IN')} ${x === 1 ? one : many}`
function describe(s: SyncSummary): string {
  const done = [s.stored ? `${n(s.stored, 'new email')}` : '', s.confirmed ? `${s.confirmed} sent confirmed` : '', s.duplicates ? `${s.duplicates} already stored` : '',
    s.failed ? `${s.failed} to retry` : '', s.attachments ? `${n(s.attachments, 'attachment')} (${(s.bytes / MB).toFixed(1)} MB)` : '',
    s.attachments_failed ? `${s.attachments_failed} attachment${s.attachments_failed > 1 ? 's' : ''} to retry` : '',
    s.discovered ? `${n(s.discovered, 'message')} found to re-sync` : ''].filter(Boolean)
  return `${s.kind === 'FULL' ? 'Full re-sync' : s.kind === 'REPLAY' ? 'Replay' : 'Mailbox sync'}: ${done.length ? done.join(', ') : 'no new mail'}.`
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
