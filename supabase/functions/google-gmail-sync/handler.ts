// google-gmail-sync request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Callers: the scheduler (header x-cron-secret = GOOGLE_CRON_SECRET; every connected mailbox) or an
// administrator (JWT, support.manage_integrations; own mailbox). Body: { action?: 'sync' | 'full' | 'replay', event_id? }.
//   sync    history since the last position (or a full re-sync when needed) plus a reconciliation of the last two days
//   full    re-synchronise recent mail (the configured number of days)
//   replay  re-read the history of one logged notification (administrator only); storing is idempotent

import { corsHeaders, type Client } from '../_shared/google/google.ts'
import { authorizeScheduler, syncMailbox, type SyncDeps } from '../_shared/google/sync.ts'

export interface Deps extends SyncDeps {
  allowedOrigins: string[]
  caller(authHeader: string): Client
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const who = await authorizeScheduler(req, deps)
  if ('status' in who) return reply(who.status, { error: who.error })
  let body: { action?: string; event_id?: string } = {}
  try {
    const text = await req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return reply(400, { error: 'Invalid request.' })
  }
  const action = body.action ?? 'sync'
  if (action === 'replay') {
    if (!who.caller) return reply(403, { error: 'Only an administrator replays notifications.' })
    if (typeof body.event_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.event_id)) return reply(400, { error: 'Choose the notification to replay.' })
    const r = await who.caller.rpc<{ account_id: string; event_id: string; start_history_id: string | null }>('support_gmail_replay', { p_event: body.event_id })
    if (r.error || !r.data) return reply(r.error?.code === '42501' ? 403 : 400, { error: r.error?.message ?? 'Replay refused.' })
    const out = await syncMailbox(deps, r.data.account_id, { mode: 'replay', startHistoryId: r.data.start_history_id, maxMessages: 200, reconcile: false })
    await deps.admin().rpc('support_gmail_event_done', { p_event: r.data.event_id, p_result: out.ok ? 'PROCESSED' : 'ERROR', p_error: out.ok ? null : out.message })
    return reply(out.ok ? 200 : 502, { results: [out] })
  }
  if (action !== 'sync' && action !== 'full') return reply(400, { error: 'Unknown action.' })
  const results = []
  for (const account of who.accounts) {
    results.push({ account, ...await syncMailbox(deps, account, { mode: action === 'full' ? 'full' : 'auto', maxMessages: action === 'full' ? 300 : 150, reconcile: true }) })
  }
  return reply(200, { results })
}
