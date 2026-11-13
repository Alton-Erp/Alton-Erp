// Supabase Edge Function: google-oauth-callback. Rules in handler.ts and migration 20261212090000.
//
// Deploy:  npx supabase functions deploy google-oauth-callback --no-verify-jwt   (Google redirects the browser here;
//          the single-use OAuth state is the check)
// Secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI, GOOGLE_TOKEN_ENCRYPTION_KEY, GOOGLE_APP_URL

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type Deps } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

const deps: Deps = {
  supabaseUrl: url,
  env: (name) => Deno.env.get(name),
  admin: () => createClient(url, serviceKey, options) as unknown as ReturnType<Deps['admin']>,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => new Date(),
}

Deno.serve((req) => handle(req, deps))
