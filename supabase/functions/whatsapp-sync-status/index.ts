// Supabase Edge Function: whatsapp-sync-status (connection test, template catalogue, payload clean-up).
//
// Deploy:  npx supabase functions deploy whatsapp-sync-status --no-verify-jwt   (scheduler x-cron-secret or an administrator's JWT)
// Secrets: WHATSAPP_ACCESS_TOKEN, WHATSAPP_CRON_SECRET, ALLOWED_ORIGINS
// Schedule hourly: POST https://<project>.supabase.co/functions/v1/whatsapp-sync-status  header x-cron-secret: <WHATSAPP_CRON_SECRET>

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type Deps } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

const deps: Deps = {
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  env: (name) => Deno.env.get(name),
  caller: (authHeader) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authHeader } } }) as unknown as ReturnType<Deps['caller']>,
  admin: () => createClient(url, serviceKey, options) as unknown as ReturnType<Deps['admin']>,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
}

Deno.serve((req) => handle(req, deps))
