// Supabase Edge Function: google-gmail-webhook (Cloud Pub/Sub push endpoint). Rules in handler.ts.
//
// Deploy:  npx supabase functions deploy google-gmail-webhook --no-verify-jwt   (Pub/Sub cannot send a Supabase JWT;
//          the URL token and, optionally, the Pub/Sub OIDC token are checked instead)
// Push endpoint: https://<project>.supabase.co/functions/v1/google-gmail-webhook?token=<GMAIL_PUSH_TOKEN>
// Secrets: GMAIL_PUSH_TOKEN, optional GMAIL_PUSH_AUDIENCE + GMAIL_PUSH_SERVICE_ACCOUNT, GOOGLE_OAUTH_CLIENT_ID,
//          GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY

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
