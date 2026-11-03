// Shared helpers for the live staging verification scripts (Phase 12).
//
//  * Five result statuses, never conflated: PASS, FAIL, BLOCKED, NOT RUN,
//    MANUAL REVIEW REQUIRED. Only PASS counts as passed.
//  * Environment variables are reported by NAME only; values are never printed.
//    Every configured secret (passwords, keys) is redacted from any message.
//  * Exit codes: 0 = every check PASS (MANUAL items listed separately),
//    1 = at least one FAIL, 2 = configuration missing or refused (nothing run),
//    3 = no FAIL, but some checks BLOCKED or NOT RUN (validation incomplete).

export const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  BLOCKED: 'BLOCKED',
  NOT_RUN: 'NOT RUN',
  MANUAL: 'MANUAL REVIEW REQUIRED',
})

const SECRET_NAME = /(PASSWORD|SECRET|SERVICE_ROLE|TOKEN|KEY)/i
const PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs (access tokens, legacy keys)
  /sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g, // Supabase API keys
]

/** Removes configured secret values, JWTs and API keys from text that will be printed. */
export function redact(text, env = process.env) {
  let out = String(text ?? '')
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 4 && SECRET_NAME.test(name)) out = out.split(value).join('[redacted]')
  }
  for (const p of PATTERNS) out = out.replace(p, '[redacted]')
  return out
}

/** True when a key is privileged (secret / service-role) and must never be used by these scripts. */
export function isPrivilegedKey(key) {
  if (!key) return false
  if (key.startsWith('sb_secret_')) return true
  try {
    return /"role"\s*:\s*"service_role"/.test(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString())
  } catch {
    return false
  }
}

/** Names of the variables in `names` that are missing or empty. */
export const missingEnv = (names, env = process.env) => names.filter((n) => !env[n] || !String(env[n]).trim())

/**
 * Validates the Supabase connection settings. Returns { url, key } or exits 2
 * with the NAMES of what is missing (never the values).
 */
export function connectionFromEnv(env = process.env) {
  const url = env.VITE_SUPABASE_URL
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY
  const missing = []
  if (!url) missing.push('VITE_SUPABASE_URL')
  if (!key) missing.push('VITE_SUPABASE_PUBLISHABLE_KEY (or VITE_SUPABASE_ANON_KEY)')
  if (missing.length) stop(`Missing required environment variables: ${missing.join(', ')}.`)
  if (isPrivilegedKey(key)) stop('Refusing to run with a privileged (secret / service-role) key. Use the publishable or anon key, and rotate the secret key if it was shared.')
  if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) stop('VITE_SUPABASE_URL must use https.')
  return { url, key }
}

export function stop(message, code = 2) {
  console.error(`\n${STATUS.BLOCKED}: ${redact(message)}\nNothing was run.`)
  process.exit(code)
}

export function createReport(title) {
  const results = []
  const add = (name, status, detail = '') => {
    if (!Object.values(STATUS).includes(status)) throw new Error(`Unknown status ${status}`)
    const clean = redact(detail)
    results.push({ name, status, detail: clean })
    console.log(`${status.padEnd(22)} ${name}${clean ? ` — ${clean}` : ''}`)
  }
  return {
    results,
    pass: (name, detail) => add(name, STATUS.PASS, detail),
    fail: (name, detail) => add(name, STATUS.FAIL, detail),
    check: (name, ok, detail) => add(name, ok ? STATUS.PASS : STATUS.FAIL, detail),
    blocked: (name, reason) => add(name, STATUS.BLOCKED, reason),
    notRun: (name, reason) => add(name, STATUS.NOT_RUN, reason),
    manual: (name, what) => add(name, STATUS.MANUAL, what),
    /** Prints the summary and returns the process exit code. */
    finish() {
      const count = (s) => results.filter((r) => r.status === s).length
      const c = Object.fromEntries(Object.values(STATUS).map((s) => [s, count(s)]))
      console.log(`\n${title}: ${Object.entries(c).map(([s, n]) => `${s} ${n}`).join(' · ')}`)
      if (c[STATUS.FAIL]) {
        console.log('Result: FAILED. Fix the failures before continuing.')
        return 1
      }
      if (c[STATUS.BLOCKED] || c[STATUS.NOT_RUN]) {
        console.log('Result: INCOMPLETE. Some checks were blocked or not run; staging validation is not complete.')
        return 3
      }
      console.log(c[STATUS.MANUAL] ? 'Result: all automated checks passed; complete the MANUAL REVIEW items listed above.' : 'Result: all checks passed.')
      return 0
    },
  }
}

/**
 * Confirms the project answers before any check runs. Without this, an unreachable or
 * wrong URL would make every "must be rejected" check look like a PASS.
 */
export async function preflight(url, key) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/health`, { headers: { apikey: key } })
    if (!res.ok) stop(`The Supabase project did not answer correctly (HTTP ${res.status}). Check VITE_SUPABASE_URL and the key.`)
  } catch (e) {
    stop(`The Supabase project could not be reached (${e.cause?.code ?? e.message}). Check VITE_SUPABASE_URL and the network.`)
  }
}

/** True for a transport failure (no answer from the server), as opposed to a refusal. */
export const isNetworkError = (r) => Boolean(r?.error) && !r.error.code && /fetch failed|network|ECONN|ENOTFOUND|timed? ?out/i.test(String(r.error.message ?? r.error))

/** Error text of a Supabase response, or '' when it succeeded. */
export const errorText = (r) => (r?.error ? `${r.error.code ?? ''} ${r.error.message ?? String(r.error)}`.trim() : '')
/** True when the response is a permission refusal (42501 / "not allowed"). */
export const isDenied = (r) => Boolean(r?.error) && (r.error.code === '42501' || /not allowed|permission/i.test(r.error.message ?? ''))
