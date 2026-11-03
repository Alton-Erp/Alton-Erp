// Edge Function plumbing shared by amazon-spapi and amazon-ads (Deno only).
// Authenticates the caller with their own JWT, checks permissions in the
// database, and restricts the Amazon credentials (one seller account per
// deployment) to the ERP company named in AMAZON_COMPANY_CODE.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

import { AmazonApiError, redact } from './http.ts'

export const env = (name: string) => (Deno.env.get(name) ?? '').trim()

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = env('ALLOWED_ORIGINS').split(',').map((o) => o.trim()).filter(Boolean)
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

export const json = (req: Request, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(req), 'Content-Type': 'application/json' } })

export interface Caller {
  userId: string
  companyId: string
  companyCode: string
  permissions: string[]
  admin: SupabaseClient
}

/** Returns the caller or an error Response. `anyOf`: at least one of these permissions is required. */
export async function authenticate(req: Request, anyOf: string[]): Promise<Caller | Response> {
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) return json(req, 401, { error: 'Not signed in' })
  const url = env('SUPABASE_URL')
  const anonKey = env('SUPABASE_ANON_KEY')
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !anonKey || !serviceKey) return json(req, 500, { error: 'Function is not configured (Supabase environment missing)' })
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: user, error: userError } = await caller.auth.getUser()
  if (userError || !user.user) return json(req, 401, { error: 'Session is invalid or expired' })
  const { data: access, error } = await caller.rpc('get_my_access')
  if (error || !access?.company?.id || !access.profile?.is_active || !access.company.is_active) return json(req, 403, { error: 'Could not verify your access' })
  const permissions: string[] = access.permissions ?? []
  if (!anyOf.some((p) => permissions.includes(p))) return json(req, 403, { error: `Requires one of: ${anyOf.join(', ')}` })
  const expected = env('AMAZON_COMPANY_CODE')
  if (!expected) return json(req, 412, { error: 'AMAZON_COMPANY_CODE is not set: the Amazon credentials are not assigned to an ERP company yet.' })
  if (expected !== access.company.company_code) return json(req, 403, { error: 'The configured Amazon account belongs to a different ERP company.' })
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  return { userId: user.user.id, companyId: access.company.id, companyCode: access.company.company_code, permissions, admin }
}

/** Which required variables are set (names only, never values). */
export const configStatus = (names: string[]) => names.map((name) => ({ name, set: env(name) !== '' }))

export const secretValues = (names: string[]) => names.map(env).filter((v) => v.length >= 6)

export async function rpcOrThrow<T>(admin: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

export async function logApiError(c: Caller, jobId: string | null, api: 'SP_API' | 'ADS_API', operation: string, e: unknown, secrets: string[], attempt = 1) {
  const err = e instanceof AmazonApiError ? e : null
  await c.admin.rpc('amazon_service_log_error', {
    p_company: c.companyId, p_job: jobId, p_api: api, p_operation: operation, p_http_status: err?.status ?? null, p_error_code: err?.code ?? 'ERROR',
    p_message: redact((e as Error)?.message ?? String(e), secrets), p_retryable: err?.retryable ?? false, p_attempt: attempt,
  })
}

/** Polls until the deadline; returns null when still pending. */
export async function pollUntil<T>(check: () => Promise<T | null>, deadline: number, intervalMs = 5000): Promise<T | null> {
  while (Date.now() < deadline) {
    const r = await check()
    if (r !== null) return r
    await new Promise((res) => setTimeout(res, intervalMs))
  }
  return null
}

export const daysBetween = (from: string, to: string) => {
  const out: string[] = []
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10))
  return out
}
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))
