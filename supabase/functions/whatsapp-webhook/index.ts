// Supabase Edge Function: whatsapp-webhook (Meta callback URL). Rules in handler.ts and migration 20261213090000.
//
// Deploy:  npx supabase functions deploy whatsapp-webhook --no-verify-jwt   (Meta cannot send a Supabase JWT; the
//          X-Hub-Signature-256 signature and the verify token are checked instead)
// Callback URL: https://<project>.supabase.co/functions/v1/whatsapp-webhook?account=<channel account id>
// Secrets: WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type Deps } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

const deps: Deps = {
  env: (name) => Deno.env.get(name),
  admin: () => createClient(url, serviceKey, options) as unknown as ReturnType<Deps['admin']>,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
}

Deno.serve((req) => handle(req, deps))
