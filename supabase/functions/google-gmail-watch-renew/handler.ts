// google-gmail-watch-renew request handling (no Deno / npm imports; unit-tested in tests/unit/gmail-functions.test.ts).
//
// Gmail stops push notifications unless users.watch is called at least every 7 days; Google recommends once a
// day. Schedule this function daily (header x-cron-secret = GOOGLE_CRON_SECRET) or run it as an administrator.
// Mailboxes with push turned off get their watch stopped.

import { Gmail } from '../_shared/google/gmail.ts'
import { corsHeaders, type Client } from '../_shared/google/google.ts'
import { accessToken, authorizeScheduler, type SyncDeps } from '../_shared/google/sync.ts'

export interface Deps extends SyncDeps {
  allowedOrigins: string[]
  caller(authHeader: string): Client
}

export async function renew(deps: Deps, account: string): Promise<{ account: string; ok: boolean; message: string }> {
  const admin = deps.admin()
  const t = await accessToken(deps, account)
  if (!t.ok) return { account, ok: false, message: t.error }
  const gmail = new Gmail(deps.fetch, t.token, deps.sleep)
  const rt = t.runtime
  try {
    if (rt.push_enabled && rt.pubsub_topic) {
      const w = await gmail.watch(rt.pubsub_topic)
      const until = w.expiration && /^[0-9]{10,16}$/.test(w.expiration) ? new Date(Number(w.expiration)).toISOString() : 'unknown'
      const message = `Watching the inbox via ${rt.pubsub_topic} until ${until}.`
      await admin.rpc('support_gmail_watch_state', { p_account: account, p_ok: true, p_expiration_ms: w.expiration ?? null, p_message: message })
      return { account, ok: true, message }
    }
    if (rt.watch_expiration) {
      await gmail.stop()
      await admin.rpc('support_gmail_watch_state', { p_account: account, p_ok: true, p_expiration_ms: null, p_message: 'Push notifications turned off; watch stopped.', p_stopped: true })
      return { account, ok: true, message: 'Watch stopped.' }
    }
    return { account, ok: true, message: 'Push notifications are off.' }
  } catch (e) {
    const message = `Watch renewal failed: ${e instanceof Error ? e.message.slice(0, 300) : 'error'}`
    await admin.rpc('support_gmail_watch_state', { p_account: account, p_ok: false, p_expiration_ms: null, p_message: message })
    return { account, ok: false, message }
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const who = await authorizeScheduler(req, deps)
  if ('status' in who) return reply(who.status, { error: who.error })
  const results = []
  for (const account of who.accounts) results.push(await renew(deps, account))
  return reply(200, { results })
}
