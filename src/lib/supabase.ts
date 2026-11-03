import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { Database } from '@/types/database'

/**
 * The single Supabase client for the app.
 *
 * Uses only PUBLIC configuration (project URL + publishable/anon key). All
 * authorization is enforced in the database by RLS; this key grants nothing
 * beyond what policies allow. Sessions are persisted and refreshed by
 * supabase-js itself — the app never stores tokens on its own.
 */

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

function decodeJwtRole(token: string): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown }
    return typeof payload.role === 'string' ? payload.role : null
  } catch {
    return null
  }
}

function detectConfigError(): string | null {
  if (!url || !key) {
    return 'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.'
  }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      return 'VITE_SUPABASE_URL must use https.'
    }
  } catch {
    return 'VITE_SUPABASE_URL is not a valid URL.'
  }
  // Refuse privileged keys outright: they bypass RLS and must never ship to a browser.
  if (key.startsWith('sb_secret_') || decodeJwtRole(key) === 'service_role') {
    return 'A privileged (secret / service-role) key was supplied. Use the publishable or anon key instead, and rotate the exposed secret key in Supabase.'
  }
  return null
}

export const supabaseConfigError = detectConfigError()

/** A failed API response: path, HTTP status and the server's request id (when the server exposes it). Never headers or bodies. */
export interface FailedRequest { path: string; status: number; requestId: string | null; at: number }
const failedRequests: FailedRequest[] = []

/** Most recent failed request to a path (e.g. "/rest/v1/rpc/erp_settings_get") in the last minute, for diagnostics. */
export function lastFailedRequest(pathSuffix: string): FailedRequest | null {
  const now = Date.now()
  return [...failedRequests].reverse().find((r) => r.path.endsWith(pathSuffix) && now - r.at < 60_000) ?? null
}

const trackingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  if (!res.ok) {
    try {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      failedRequests.push({ path: u.pathname, status: res.status, requestId: res.headers.get('sb-request-id') ?? res.headers.get('x-request-id'), at: Date.now() })
      if (failedRequests.length > 20) failedRequests.shift()
    } catch {
      // diagnostics only
    }
  }
  return res
}

export const supabase: SupabaseClient<Database> | null = supabaseConfigError
  ? null
  : createClient<Database>(url, key, {
      global: { fetch: trackingFetch },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    })

export function requireSupabase(): SupabaseClient<Database> {
  if (!supabase) throw new Error(supabaseConfigError ?? 'Supabase is not configured.')
  return supabase
}
