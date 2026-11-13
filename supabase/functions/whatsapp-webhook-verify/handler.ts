// whatsapp-webhook-verify request handling (no Deno / npm imports; unit-tested in tests/unit/whatsapp-functions.test.ts).
//
//   GET   The same verification challenge as whatsapp-webhook (if Meta is pointed at this URL for the check).
//   POST  Administrator check (JWT, support.manage_integrations): which WhatsApp secrets are set (yes / no only),
//         the callback URL to register, and whether the Meta app appears in GET /{WABA-ID}/subscribed_apps
//         (read-only; nothing is subscribed or changed at Meta).

import { corsHeaders, type Client } from '../_shared/google/google.ts'
import { answerVerification, graphFetch, graphUrl, waSecret, type WaDeps, type WaRuntime } from '../_shared/whatsapp/whatsapp.ts'

export interface Deps extends WaDeps {
  allowedOrigins: string[]
  supabaseUrl: string
  caller(auth: string): Client
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method === 'GET') return answerVerification(req, deps)
  const headers = { ...corsHeaders(req, deps.allowedOrigins), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req, deps.allowedOrigins) })
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' })
  const auth = req.headers.get('Authorization') ?? ''
  if (!/^Bearer\s+\S+$/.test(auth)) return reply(401, { error: 'Sign in first.' })
  const check = await deps.caller(auth).rpc<{ account_id: string } | null>('support_whatsapp_admin_check')
  if (check.error) return reply(check.error.code === '42501' ? 403 : 400, { error: check.error.message ?? 'Not allowed.' })
  if (!check.data) return reply(400, { error: 'Save the WhatsApp settings first.' })
  const account = check.data.account_id
  const env = deps.env
  const secrets = { access_token: Boolean(waSecret('WHATSAPP_ACCESS_TOKEN', env)), app_secret: Boolean(waSecret('WHATSAPP_APP_SECRET', env)),
    verify_token: Boolean(waSecret('WHATSAPP_VERIFY_TOKEN', env)), cron_secret: Boolean(waSecret('WHATSAPP_CRON_SECRET', env)) }
  const callback = `${deps.supabaseUrl.replace(/\/+$/, '')}/functions/v1/whatsapp-webhook?account=${account}`
  const { data: rt } = await deps.admin().rpc<WaRuntime | null>('support_whatsapp_runtime', { p_account: account })
  let subscription: { checked: boolean; subscribed: boolean | null; message: string } = { checked: false, subscribed: null, message: 'Not checked.' }
  const token = waSecret('WHATSAPP_ACCESS_TOKEN', env)
  if (rt?.waba_id && rt.graph_api_version && token) {
    try {
      const res = await graphFetch(deps.fetch, graphUrl(rt.graph_api_version, rt.waba_id, 'subscribed_apps'), token)
      const text = await res.text()
      if (!res.ok) subscription = { checked: true, subscribed: null, message: `Meta answered HTTP ${res.status}; check the token permissions.` }
      else {
        const found = Boolean(rt.app_id && text.includes(`"${rt.app_id}"`))
        subscription = { checked: true, subscribed: found, message: found ? 'The app is subscribed to this WhatsApp Business Account.' : 'The configured app id is not in the subscribed apps.' }
      }
    } catch (e) {
      subscription = { checked: true, subscribed: null, message: e instanceof Error ? e.message : 'Meta could not be reached.' }
    }
  }
  return reply(200, { secrets, callback_url: callback, verify_token_hint: 'The value of WHATSAPP_VERIFY_TOKEN (never shown here).', subscription })
}
