// Shared HTTP helpers for the Amazon integrations (runs in Deno and Node).
// Retries throttling (429) and transient server errors with exponential
// backoff + jitter, honouring Retry-After and x-amzn-RateLimit-Limit. Never
// retries authorisation or validation errors. Messages are redacted.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>
export type SleepFn = (ms: number) => Promise<void>

export const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms))

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: SleepFn
  random?: () => number
  onRetry?: (info: { attempt: number; status: number | null; delayMs: number; reason: string }) => void | Promise<void>
}

export class AmazonApiError extends Error {
  status: number | null
  code: string
  retryable: boolean
  requestId: string | null
  constructor(message: string, status: number | null, code: string, retryable: boolean, requestId: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
    this.requestId = requestId
  }
}

export const isRetryableStatus = (status: number) => status === 429 || status === 408 || (status >= 500 && status <= 504)

/** Delay before the next attempt: Retry-After, else the rate limit, else exponential backoff with jitter. */
export function retryDelay(attempt: number, res: Response | null, opts: RetryOptions): number {
  const base = opts.baseDelayMs ?? 500
  const max = opts.maxDelayMs ?? 30_000
  const retryAfter = res?.headers.get('retry-after')
  if (retryAfter) {
    const s = Number(retryAfter)
    if (Number.isFinite(s)) return Math.min(max, Math.max(0, s * 1000))
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at)) return Math.min(max, Math.max(0, at - Date.now()))
  }
  const rate = Number(res?.headers.get('x-amzn-ratelimit-limit'))
  const fromRate = Number.isFinite(rate) && rate > 0 ? 1000 / rate : 0
  const exp = base * 2 ** (attempt - 1)
  const jitter = (opts.random ?? Math.random)() * base
  return Math.min(max, Math.max(fromRate, exp + jitter))
}

export async function fetchWithRetry(fetchFn: FetchFn, url: string, init: RequestInit, opts: RetryOptions = {}): Promise<Response> {
  const attempts = opts.maxAttempts ?? 5
  const sleep = opts.sleep ?? defaultSleep
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response | null = null
    try {
      res = await fetchFn(url, init)
    } catch (e) {
      lastError = e
      if (attempt === attempts) break
      const delayMs = retryDelay(attempt, null, opts)
      await opts.onRetry?.({ attempt, status: null, delayMs, reason: `network error: ${(e as Error).message}` })
      await sleep(delayMs)
      continue
    }
    if (!isRetryableStatus(res.status) || attempt === attempts) return res
    const delayMs = retryDelay(attempt, res, opts)
    await opts.onRetry?.({ attempt, status: res.status, delayMs, reason: res.status === 429 ? 'throttled' : `server error ${res.status}` })
    await res.body?.cancel().catch(() => undefined)
    await sleep(delayMs)
  }
  throw new AmazonApiError(`Network error after ${attempts} attempts: ${(lastError as Error)?.message ?? 'unknown'}`, null, 'NETWORK', true)
}

/** Reads a JSON response or throws a typed, redacted error. */
export async function readJson<T>(res: Response, operation: string, secrets: string[] = []): Promise<T> {
  const requestId = res.headers.get('x-amzn-requestid') ?? res.headers.get('x-amz-request-id')
  const text = await res.text()
  if (!res.ok) {
    let code = `HTTP_${res.status}`
    let message = text.slice(0, 500)
    try {
      const j = JSON.parse(text) as { errors?: { code?: string; message?: string }[]; code?: string; message?: string; error?: string; error_description?: string; details?: string }
      code = j.errors?.[0]?.code ?? j.code ?? j.error ?? code
      message = j.errors?.[0]?.message ?? j.message ?? j.error_description ?? j.details ?? message
    } catch {
      // not JSON: keep the text
    }
    throw new AmazonApiError(redact(`${operation}: ${message}`, secrets), res.status, String(code), isRetryableStatus(res.status), requestId)
  }
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new AmazonApiError(`${operation}: the response was not valid JSON`, res.status, 'INVALID_RESPONSE', false, requestId)
  }
}

const TOKEN_PATTERNS = [/Atza\|[A-Za-z0-9\-_.|]+/g, /Atzr\|[A-Za-z0-9\-_.|]+/g, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, /amzn1\.oa2-cs\.[A-Za-z0-9.\-_]+/g]
const KEY_VALUE = /(client_secret|refresh_token|access_token|authorization)(["'=:\s]+)(?:bearer\s+)?[^"'&\s,}]+/gi

/** Removes access / refresh tokens, client secrets and any listed secret value from text. */
export function redact(text: string, secrets: string[] = []): string {
  let out = String(text ?? '')
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]')
  for (const p of TOKEN_PATTERNS) out = out.replace(p, '[redacted]')
  out = out.replace(KEY_VALUE, (_m: string, key: string, sep: string) => `${key}${sep}[redacted]`)
  return out.slice(0, 2000)
}

/** Follows a next-token pagination until exhausted or `maxPages` (protects runtime limits). */
export async function paginate<T>(fetchPage: (token: string | null) => Promise<{ items: T[]; next: string | null }>, maxPages = 50): Promise<{ items: T[]; complete: boolean; next: string | null }> {
  const items: T[] = []
  let token: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const r = await fetchPage(token)
    items.push(...r.items)
    if (!r.next) return { items, complete: true, next: null }
    token = r.next
  }
  return { items, complete: false, next: token }
}

/** Downloads a (possibly gzip-compressed) document and returns its text. */
export async function downloadText(fetchFn: FetchFn, url: string, gzip: boolean, opts: RetryOptions = {}): Promise<string> {
  const res = await fetchWithRetry(fetchFn, url, { method: 'GET' }, opts)
  if (!res.ok) throw new AmazonApiError(`Report download failed (HTTP ${res.status})`, res.status, `HTTP_${res.status}`, isRetryableStatus(res.status))
  if (!gzip) return await res.text()
  const stream = res.body!.pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}
