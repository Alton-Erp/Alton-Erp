// google-gmail-sync request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Callers: the scheduler (header x-cron-secret = GOOGLE_CRON_SECRET; every connected mailbox) or an
// administrator (JWT, support.manage_integrations; own mailbox). Body: { action?, event_id?, account?, depth? }.
//   sync      one batch: history since the checkpoint, queued messages, pending attachments (and a full re-sync
//             when the mailbox has no position yet)
//   full      start (or resume) a full re-sync of recent mail (the configured number of days), then one batch
//   retry     put failed messages / attachments back in the queue (administrator), then one batch
//   replay    queue the history of one logged notification (administrator), then one batch
//   continue  the next batch of a run (scheduler secret only; sent by this function to itself)
//
// Each call does one small batch (migration 20261224090000) and answers within its time budget. When more work is
// left and the batch made progress, the next batch is started in the background (deps.continueLater: a request to
// this function with the scheduler secret), up to MAX_CHAIN batches; the scheduled run picks up anything left after
// that, after a worker failure or when the chain is broken. The browser never has to stay open.

import { corsHeaders, type Client } from '../_shared/google/google.ts'
import { authorizeScheduler, runSync, syncLimits, type SyncDeps, type SyncSummary } from '../_shared/google/sync.ts'

export interface Deps extends SyncDeps {
  allowedOrigins: string[]
  caller(authHeader: string): Client
  /** Starts the next batch for this mailbox without waiting for it (index.ts: a background request to itself). */
  continueLater?(account: string, depth: number): void
}

export const MAX_CHAIN = 400
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const who = await authorizeScheduler(req, deps)
  if ('status' in who) return reply(who.status, { error: who.error })
  let body: { action?: string; event_id?: string; account?: string; depth?: number } = {}
  try {
    const text = await req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const action = body.action ?? 'sync'
  const limits = syncLimits(deps.env)
  const by = async () => (who.caller ? (await who.caller.rpc<{ user_id?: string } | null>('support_email_admin_check')).data?.user_id ?? null : null)
  const next = (account: string, out: SyncSummary, depth: number) => {
    if (out.more && out.progressed && !out.busy && depth < MAX_CHAIN) deps.continueLater?.(account, depth + 1)
  }
  const result = (account: string, out: SyncSummary, depth: number) => ({ account, ...out, continuing: out.more && out.progressed && !out.busy && depth < MAX_CHAIN && Boolean(deps.continueLater) })

  if (action === 'replay') {
    if (!who.caller) return reply(403, { error: 'Only an administrator replays notifications.' })
    if (typeof body.event_id !== 'string' || !UUID.test(body.event_id)) return reply(400, { error: 'Choose the notification to replay.' })
    const r = await who.caller.rpc<{ account_id: string; event_id: string; start_history_id: string | null }>('support_gmail_replay', { p_event: body.event_id })
    if (r.error || !r.data) return reply(r.error?.code === '42501' ? 403 : 400, { error: r.error?.message ?? 'Replay refused.' })
    const out = await runSync(deps, r.data.account_id, { mode: 'replay', startHistoryId: r.data.start_history_id, limits })
    await deps.admin().rpc('support_gmail_event_done', { p_event: r.data.event_id, p_result: out.ok ? 'PROCESSED' : 'ERROR', p_error: out.ok ? null : out.message })
    next(r.data.account_id, out, 0)
    return reply(out.ok ? 200 : 502, { results: [result(r.data.account_id, out, 0)] })
  }
  if (action === 'continue') {
    // Internal: only with the scheduler secret, for a mailbox the scheduler serves.
    if (who.caller) return reply(403, { error: 'Not allowed.' })
    if (typeof body.account !== 'string' || !who.accounts.includes(body.account)) return reply(400, { error: 'Unknown mailbox.' })
    const depth = Math.max(0, Math.min(MAX_CHAIN, Number(body.depth) || 0))
    const out = await runSync(deps, body.account, { mode: 'auto', limits })
    next(body.account, out, depth)
    return reply(200, { results: [result(body.account, out, depth)] })
  }
  if (action !== 'sync' && action !== 'full' && action !== 'retry') return reply(400, { error: 'Unknown action.' })
  if (action === 'retry' && !who.caller) return reply(403, { error: 'Only an administrator retries failed items.' })
  const results = []
  const requestedBy = await by()
  for (const account of who.accounts) {
    if (action === 'retry') {
      const r = await deps.admin().rpc('support_gmail_sync_retry', { p_account: account })
      if (r.error) { results.push({ account, ok: false, message: `Retry could not be prepared: ${r.error.message ?? 'database error'}` }); continue }
    }
    const out = await runSync(deps, account, { mode: action === 'full' ? 'full' : 'auto', requestedBy, limits })
    next(account, out, 0)
    results.push(result(account, out, 0))
  }
  return reply(200, { results })
}
