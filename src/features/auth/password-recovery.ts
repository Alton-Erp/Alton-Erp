/**
 * Password recovery with a 6-digit e-mail code (Supabase Auth recovery OTP).
 *
 *   resetPasswordForEmail(email)                    → Supabase e-mails {{ .Token }}
 *   verifyOtp({ email, token, type: 'recovery' })   → short recovery session
 *   updateUser({ password })                        → new password, then sign out
 *
 * The code itself is never stored. Two small, non-secret values are kept in the browser:
 *  - the e-mail address and send time of the pending request (sessionStorage, this tab only),
 *    so a refresh keeps the code screen and the resend countdown;
 *  - the id of the user who verified a code but has not set the new password yet
 *    (localStorage, all tabs), so the recovery session cannot be used to open the ERP.
 */

export const OTP_LENGTH = 6
/** Seconds between code requests (the server enforces its own minimum as well). */
export const RESEND_SECONDS = 60
/** A pending request older than this is dropped (the code expires on the server). */
const REQUEST_MAX_AGE_MS = 60 * 60 * 1000
export const PASSWORD_MIN_LENGTH = 8
/** Supabase (bcrypt) ignores characters after 72 bytes. */
export const PASSWORD_MAX_LENGTH = 72

const REQUEST_KEY = 'alton:password-recovery:request:v1'
const VERIFIED_KEY = 'alton:password-recovery:verified:v1'

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ---------------------------------------------------------------------------
// Code input
// ---------------------------------------------------------------------------

export const emptyOtp = (): string[] => Array.from({ length: OTP_LENGTH }, () => '')

/**
 * Applies typed or pasted text at box `index`: only digits are kept and spread over the following
 * boxes. Returns the new digits and the box to focus next. Non-digit input changes nothing.
 */
export function applyOtpInput(digits: readonly string[], index: number, text: string): { digits: string[]; focus: number } {
  const incoming = text.replace(/\D/g, '')
  const next = [...digits]
  if (!incoming) return { digits: next, focus: index }
  // A full code pasted or auto-filled into any box replaces the whole code.
  const start = incoming.length >= OTP_LENGTH ? 0 : index
  const chars = incoming.slice(0, OTP_LENGTH - start)
  for (let i = 0; i < chars.length; i++) next[start + i] = chars[i]
  return { digits: next, focus: Math.min(start + chars.length, OTP_LENGTH - 1) }
}

/** Backspace: clears the current box, or the previous one when the current box is already empty. */
export function applyOtpBackspace(digits: readonly string[], index: number): { digits: string[]; focus: number } {
  const next = [...digits]
  if (next[index]) {
    next[index] = ''
    return { digits: next, focus: index }
  }
  const prev = Math.max(index - 1, 0)
  next[prev] = ''
  return { digits: next, focus: prev }
}

export const otpComplete = (digits: readonly string[]) => digits.length === OTP_LENGTH && digits.every((d) => /^\d$/.test(d))

// ---------------------------------------------------------------------------
// New password
// ---------------------------------------------------------------------------

export interface PasswordCheck { key: string; label: string; ok: boolean }

export function passwordChecks(password: string, email = ''): PasswordCheck[] {
  const local = email.split('@')[0]?.toLowerCase() ?? ''
  return [
    { key: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, ok: password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH },
    { key: 'letter', label: 'A letter', ok: /\p{L}/u.test(password) },
    { key: 'number', label: 'A number', ok: /\d/.test(password) },
    { key: 'email', label: 'Not your email address', ok: password.length > 0 && !(local.length >= 3 && password.toLowerCase().includes(local)) },
  ]
}

/** First problem with the new password and its confirmation, or null when both are acceptable. */
export function validateNewPassword(password: string, confirm: string, email = ''): string | null {
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`
  const failed = passwordChecks(password, email).find((c) => !c.ok)
  if (failed?.key === 'length') return `Use at least ${PASSWORD_MIN_LENGTH} characters.`
  if (failed?.key === 'letter' || failed?.key === 'number') return 'Use a mix of letters and numbers.'
  if (failed?.key === 'email') return 'Do not use your email address in the password.'
  if (password !== confirm) return 'The passwords do not match.'
  return null
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface ErrorLike { code?: string; error_code?: string; status?: number; message?: string; name?: string }

/** Seconds the server asks to wait ("…you can only request this after 42 seconds."), if stated. */
export function retryAfterSeconds(error: unknown): number | null {
  const m = /after (\d+) seconds?/i.exec((error as ErrorLike | null)?.message ?? '')
  return m ? Number(m[1]) : null
}

/** Message for a failed code check. Invalid and expired codes get the same answer (Supabase does not distinguish them). */
export function describeOtpError(error: unknown, network: boolean): string {
  if (network) return 'Cannot reach the sign-in service. Check your internet connection and try again.'
  const e = (error ?? {}) as ErrorLike
  const code = e.code ?? e.error_code ?? ''
  if (code === 'over_request_rate_limit' || e.status === 429) return 'Too many attempts. Wait a few minutes, then request a new code.'
  if (code === 'otp_expired' || code === 'otp_disabled' || /expired|invalid/i.test(e.message ?? '')) {
    return 'That code is incorrect or has expired. Check the latest email, or request a new code.'
  }
  return 'The code could not be verified. Please try again.'
}

// ---------------------------------------------------------------------------
// Browser state (never the code)
// ---------------------------------------------------------------------------

export interface PendingRequest { email: string; sentAt: number }

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

export function readPendingRequest(now = Date.now()): PendingRequest | null {
  try {
    const raw = storage('session')?.getItem(REQUEST_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PendingRequest>
    if (typeof v.email !== 'string' || !EMAIL_RE.test(v.email) || typeof v.sentAt !== 'number' || v.sentAt > now + 60_000 || now - v.sentAt > REQUEST_MAX_AGE_MS) {
      clearPendingRequest()
      return null
    }
    return { email: v.email, sentAt: v.sentAt }
  } catch {
    return null
  }
}

export function savePendingRequest(request: PendingRequest) {
  try {
    storage('session')?.setItem(REQUEST_KEY, JSON.stringify({ email: request.email, sentAt: request.sentAt }))
  } catch {
    // Without storage a refresh returns to the e-mail step; nothing else is lost.
  }
}

export function clearPendingRequest() {
  try {
    storage('session')?.removeItem(REQUEST_KEY)
  } catch {
    // ignore
  }
}

/** Seconds left before another code may be requested. */
export const resendSecondsLeft = (sentAt: number, now = Date.now(), cooldown = RESEND_SECONDS) =>
  Math.max(0, Math.ceil((sentAt + cooldown * 1000 - now) / 1000))

export const VERIFIED_STORAGE_KEY = VERIFIED_KEY

export function readVerifiedUser(): string | null {
  try {
    return storage('local')?.getItem(VERIFIED_KEY) ?? null
  } catch {
    return null
  }
}

export function markVerifiedUser(userId: string) {
  try {
    storage('local')?.setItem(VERIFIED_KEY, userId)
  } catch {
    // ignore: the page still shows the password step from its own state
  }
}

export function clearVerifiedUser() {
  try {
    storage('local')?.removeItem(VERIFIED_KEY)
  } catch {
    // ignore
  }
}
