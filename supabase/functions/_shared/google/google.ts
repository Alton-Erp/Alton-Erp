// Shared helpers for the Google Workspace (Gmail) Edge Functions. No Deno / npm imports, so the
// functions' handlers are unit-tested in Node (tests/unit/gmail-functions.test.ts).
//
// Every Google request goes to one of the fixed endpoints below; no URL is ever taken from a request,
// the database or an email, so the functions cannot be used to fetch arbitrary addresses.

export const GOOGLE = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  certs: 'https://www.googleapis.com/oauth2/v3/certs',
} as const

export const SCOPE_READ = 'https://www.googleapis.com/auth/gmail.readonly'
export const SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send'
export const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify'
export const BUCKET = 'support-attachments'

/** The only Edge Function secrets these functions read. */
export const SECRET_NAMES = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'GOOGLE_TOKEN_ENCRYPTION_KEY', 'GOOGLE_APP_URL',
  'GMAIL_PUSH_TOKEN', 'GMAIL_PUSH_AUDIENCE', 'GMAIL_PUSH_SERVICE_ACCOUNT', 'GOOGLE_CRON_SECRET'] as const
export type SecretName = typeof SECRET_NAMES[number]

export function secret(name: SecretName, env: (k: string) => string | undefined): string | null {
  if (!(SECRET_NAMES as readonly string[]).includes(name)) return null
  const v = env(name)
  return v && v.trim() ? v.trim() : null
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetcher(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

const SENSITIVE_KEY = /token|secret|code|authorization|refresh|access|state|cipher|password|key|raw|body|html|data/i

/** Structured log line; values under sensitive-looking keys are replaced. Never pass message content. */
export function log(fn: string, level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}) {
  const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : v]))
  const line = JSON.stringify({ fn, level, message, ...safe })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export function corsHeaders(req: Request, allowed: string[]): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

// ---- encoding ------------------------------------------------------------------
export function bytesToB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}
export const bytesToB64url = (bytes: Uint8Array) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')
  return b64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}
export function randomToken(bytes = 32): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

// ---- configuration checks -------------------------------------------------------
/** The OAuth redirect URI must be exactly this project's google-oauth-callback function (https, no query). */
export function redirectUriProblem(redirectUri: string | null, supabaseUrl: string | undefined): string | null {
  if (!redirectUri) return 'GOOGLE_OAUTH_REDIRECT_URI is not set.'
  let r: URL
  let s: URL
  try {
    r = new URL(redirectUri)
    s = new URL(supabaseUrl ?? '')
  } catch {
    return 'GOOGLE_OAUTH_REDIRECT_URI is not a valid URL.'
  }
  if (r.protocol !== 'https:' && r.hostname !== 'localhost' && r.hostname !== '127.0.0.1') return 'The redirect URI must use https.'
  if (r.origin !== s.origin) return `The redirect URI must be on this project (${s.origin}).`
  if (r.pathname !== '/functions/v1/google-oauth-callback' || r.search || r.hash) return 'The redirect URI must be <project>/functions/v1/google-oauth-callback exactly.'
  return null
}

/** Where the browser goes back after authorising: GOOGLE_APP_URL (https, or localhost for development), no query. */
export function appUrl(env: (k: string) => string | undefined): string | null {
  const v = secret('GOOGLE_APP_URL', env)
  if (!v) return null
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return null
    if (u.search || u.hash || u.username || u.password) return null
    return u.origin + u.pathname.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface RpcError { code?: string; message?: string }
export interface RpcResult<T> { data: T | null; error: RpcError | null }
export interface StorageBucket {
  upload(path: string, body: Uint8Array, opts: { contentType?: string; upsert?: boolean }): PromiseLike<{ error: { message?: string } | null }>
  download(path: string): PromiseLike<{ data: Blob | null; error: { message?: string } | null }>
}
export interface Client {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult<T>>
  storage: { from(bucket: string): StorageBucket }
}
