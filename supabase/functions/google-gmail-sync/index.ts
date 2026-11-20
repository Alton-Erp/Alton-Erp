// Supabase Edge Function: google-gmail-sync. Rules in handler.ts and migration 20261212090000.
//
// Deploy:  npx supabase functions deploy google-gmail-sync --no-verify-jwt   (it checks the caller itself: an
//          administrator's JWT, or the x-cron-secret header from the scheduler)
// Secrets: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_TOKEN_ENCRYPTION_KEY, GOOGLE_CRON_SECRET, ALLOWED_ORIGINS
// Schedule every 2 minutes: POST https://<project>.supabase.co/functions/v1/google-gmail-sync  header x-cron-secret: <GOOGLE_CRON_SECRET>
// (each run is one small batch; while work is left, batches continue in the background — see handler.ts).
// Optional limits (not secrets): GMAIL_SYNC_BATCH_SIZE, GMAIL_SYNC_ATTACHMENTS, GMAIL_SYNC_ATTACHMENT_MB, GMAIL_SYNC_TIME_BUDGET_MS,
// GMAIL_SYNC_CPU_BUDGET_MS, GMAIL_SYNC_LOCK_TTL_SECONDS.

import { createClient } from 'npm:@supabase/supabase-js@2'

import { makeContinuation } from '../_shared/google/continuation.ts'
import { secret } from '../_shared/google/google.ts'

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
  // The next batch runs as a new request (scheduler secret) in the background; see continuation.ts.
  continueLater: makeContinuation({ supabaseUrl: url, cronSecret: secret('GOOGLE_CRON_SECRET', (k) => Deno.env.get(k)), fetch: (input, init) => fetch(input, init),
    waitUntil: typeof EdgeRuntime === 'undefined' ? undefined : (p) => EdgeRuntime!.waitUntil(p) }),
}

Deno.serve((req) => handle(req, deps))
