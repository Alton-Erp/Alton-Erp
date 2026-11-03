// Supabase Edge Function: invite-user
//
// Invites staff by e-mail through Supabase Auth, resends and revokes invitations.
// All rules are in handler.ts and the database (migration 20261116090000):
// the caller is identified from their own JWT; their company, permission and the
// roles they may assign are checked server-side; the service-role key never
// leaves this function.
//
// Deploy:  npx supabase functions deploy invite-user
// Secrets: INVITE_REDIRECT_URL   https://<erp-origin>/accept-invitation   (also add it to Auth → URL Configuration → Redirect URLs)
//          ALLOWED_ORIGINS       https://<erp-origin>   (comma-separated)
//          INVITE_EXPIRY_HOURS   24 (1–24; Supabase Auth e-mail links last at most 24 hours, so set
//                                Auth → Email OTP Expiration to the same value)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2'

import { handle, type AdminClient, type AnonClient, type CallerClient } from './handler.ts'

const url = Deno.env.get('SUPABASE_URL') ?? ''
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const options = { auth: { persistSession: false, autoRefreshToken: false } }

Deno.serve((req) => handle(req, {
  env: {
    redirectTo: Deno.env.get('INVITE_REDIRECT_URL') || undefined,
    expiresHours: Math.min(Math.max(Number(Deno.env.get('INVITE_EXPIRY_HOURS') ?? '24') || 24, 1), 24),
    allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean),
    configured: Boolean(url && anonKey && serviceKey),
  },
  caller: (authHeader) => createClient(url, anonKey, { ...options, global: { headers: { Authorization: authHeader } } }) as unknown as CallerClient,
  admin: () => createClient(url, serviceKey, options) as unknown as AdminClient,
  anon: () => createClient(url, anonKey, options) as unknown as AnonClient,
}))
