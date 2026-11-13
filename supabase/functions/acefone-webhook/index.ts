// Supabase Edge Function: acefone-webhook (public endpoint; deploy with --no-verify-jwt).
// Rules in handler.ts and migration 20261211090000.
//
// Deploy:  npx supabase functions deploy acefone-webhook --no-verify-jwt
// Secrets: ACEFONE_WEBHOOK_SECRET  a long random value (e.g. openssl rand -hex 32), also put in each webhook URL
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2'

import { readSecret } from '../_shared/acefone/acefone.ts'
import { handle, type IngestResult } from './handler.ts'

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })

Deno.serve((req) => handle(req, {
  secret: (name) => readSecret(name, (k) => Deno.env.get(k)),
  runtime: async (account) => {
    const { data, error } = await admin.rpc('support_phone_runtime', { p_account: account })
    if (error) throw new Error(error.message)
    return data as { is_enabled: boolean; webhook_secret_name: string; webhook_allowed_ips: string[] } | null
  },
  ingest: async (account, event, payload, key, ip) => {
    const { data, error } = await admin.rpc('support_acefone_ingest', { p_account: account, p_event: event, p_payload: payload, p_event_key: key, p_source_ip: ip })
    if (error) throw new Error(error.message)
    return data as IngestResult
  },
}))
