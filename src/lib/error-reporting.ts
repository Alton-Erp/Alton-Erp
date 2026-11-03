import { supabase } from '@/lib/supabase'

/**
 * Structured error reporting. Each report gets a correlation id that is shown
 * to the user ("Reference: …") and stored in the server-side error log
 * (public.error_events, readable with system_health.read). The server redacts
 * tokens, secrets and e-mail addresses again before storing; the browser never
 * sends request headers, tokens or form contents.
 */
export const newCorrelationId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`)

const SECRET_KEY = /(token|password|secret|authorization|cookie|api_?key|session|jwt)/i
let recent: { key: string; at: number }[] = []

function describe(error: unknown): { message: string; code: string | null } {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; code?: unknown }
    return { message: typeof e.message === 'string' ? e.message : String(error), code: typeof e.code === 'string' ? e.code : null }
  }
  return { message: String(error), code: null }
}

export function reportError(source: string, error: unknown, context: Record<string, string | number | boolean | null> = {}, severity: 'ERROR' | 'WARNING' = 'ERROR'): string {
  const correlationId = newCorrelationId()
  const { message, code } = describe(error)
  const key = `${source}:${message}`
  const now = Date.now()
  recent = recent.filter((r) => now - r.at < 60_000)
  if (recent.some((r) => r.key === key) || recent.length > 20) return correlationId // same error just reported, or flooding
  recent.push({ key, at: now })
  const safeContext = Object.fromEntries(Object.entries({ ...context, path: typeof location !== 'undefined' ? location.pathname : null })
    .filter(([k]) => !SECRET_KEY.test(k)).slice(0, 15))
  if (supabase) {
    const client = supabase
    void Promise.resolve((client.rpc as unknown as (f: string, a: Record<string, unknown>) => PromiseLike<unknown>).call(client, 'log_client_error', {
      p_correlation_id: correlationId, p_source: source.toLowerCase().replace(/[^a-z0-9_.:/-]/g, '-').slice(0, 100) || 'app',
      p_message: message.slice(0, 500), p_code: code, p_context: safeContext, p_severity: severity,
    })).catch(() => undefined) // reporting must never break the page
  }
  return correlationId
}

let installed = false
/** Reports uncaught errors and unhandled promise rejections of the signed-in app. */
export function installGlobalErrorReporting() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('error', (e) => reportError('app:uncaught', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => reportError('app:unhandled-rejection', e.reason))
}
