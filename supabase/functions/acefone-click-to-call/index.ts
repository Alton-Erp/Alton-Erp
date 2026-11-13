// Supabase Edge Function: acefone-click-to-call (JWT required). Rules in handler.ts and migration 20261211090000.
//
// Deploy:  npx supabase functions deploy acefone-click-to-call
// Secrets: ACEFONE_API_TOKEN            Acefone API token (Authorization: Bearer)
//          ACEFONE_C2C_SUPPORT_API_KEY  Click-to-Call Support API key (only for the Support mode; a different credential)
//          ALLOWED_ORIGINS              https://<erp-origin> (comma-separated)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type AdminClient, type CallerClient } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

Deno.serve((req) => handle(req, {
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
  configured: Boolean(url && anonKey && serviceKey),
  env: (name) => Deno.env.get(name),
  caller: (authHeader) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authHeader } } }) as unknown as CallerClient,
  admin: () => createClient(url, serviceKey, options) as unknown as AdminClient,
  fetch: (input, init) => fetch(input, init),
}))
