// Supabase Edge Function: acefone-sync-cdr. Rules in handler.ts and migration 20261211090000.
//
// Deploy:  npx supabase functions deploy acefone-sync-cdr --no-verify-jwt   (it checks the caller itself:
//          an administrator's JWT, or the x-cron-secret header from the scheduler)
// Secrets: ACEFONE_API_TOKEN, ACEFONE_CRON_SECRET (random value used by the scheduler), ALLOWED_ORIGINS
// Schedule (e.g. every 15 minutes with pg_cron + pg_net, or any scheduler):
//   POST https://<project>.supabase.co/functions/v1/acefone-sync-cdr   header x-cron-secret: <ACEFONE_CRON_SECRET>

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type Client } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

Deno.serve((req) => handle(req, {
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  env: (name) => Deno.env.get(name),
  caller: (authHeader) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authHeader } } }) as unknown as Client,
  admin: () => createClient(url, serviceKey, options) as unknown as Client,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
}))
