// Supabase Edge Function: google-gmail-sync. Rules in handler.ts and migration 20261212090000.
//
// Deploy:  npx supabase functions deploy google-gmail-sync --no-verify-jwt   (it checks the caller itself: an
//          administrator's JWT, or the x-cron-secret header from the scheduler)
// Secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY, GOOGLE_CRON_SECRET, ALLOWED_ORIGINS
// Schedule every 5–10 minutes: POST https://<project>.supabase.co/functions/v1/google-gmail-sync  header x-cron-secret: <GOOGLE_CRON_SECRET>

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
