import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  applyOtpBackspace,
  applyOtpInput,
  clearPendingRequest,
  clearVerifiedUser,
  describeOtpError,
  emptyOtp,
  markVerifiedUser,
  otpComplete,
  passwordChecks,
  readPendingRequest,
  readVerifiedUser,
  resendSecondsLeft,
  retryAfterSeconds,
  savePendingRequest,
  validateNewPassword,
} from '../../src/features/auth/password-recovery.ts'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, String(v)) }
  removeItem(k: string) { this.data.delete(k) }
}

describe('6-digit code input', () => {
  it('typing a digit fills the box and moves on; letters are ignored', () => {
    const r = applyOtpInput(emptyOtp(), 0, '4')
    assert.deepEqual(r.digits, ['4', '', '', '', '', ''])
    assert.equal(r.focus, 1)
    const n = applyOtpInput(r.digits, 1, 'a')
    assert.deepEqual(n.digits, r.digits)
    assert.equal(n.focus, 1)
  })
  it('pasting all six digits (with spaces or dashes) fills every box from the first, whichever box has focus', () => {
    const r = applyOtpInput(emptyOtp(), 3, ' 123-456 ')
    assert.deepEqual(r.digits, ['1', '2', '3', '4', '5', '6'])
    assert.equal(r.focus, 5)
    assert.ok(otpComplete(r.digits))
  })
  it('a partial paste fills from the current box and never overflows', () => {
    const r = applyOtpInput(['1', '2', '', '', '', ''], 4, '789')
    assert.deepEqual(r.digits, ['1', '2', '', '', '7', '8'])
  })
  it('Backspace clears the box, or the previous box when already empty', () => {
    assert.deepEqual(applyOtpBackspace(['1', '2', '3', '', '', ''], 2), { digits: ['1', '2', '', '', '', ''], focus: 2 })
    assert.deepEqual(applyOtpBackspace(['1', '2', '', '', '', ''], 2), { digits: ['1', '', '', '', '', ''], focus: 1 })
    assert.deepEqual(applyOtpBackspace(emptyOtp(), 0), { digits: emptyOtp(), focus: 0 })
  })
  it('complete only with six digits', () => {
    assert.ok(!otpComplete(['1', '2', '3', '4', '5', '']))
    assert.ok(!otpComplete(['1', '2', '3', '4', '5', 'x']))
  })
})

describe('new password rules', () => {
  it('length, letters and numbers, not the e-mail, and confirmation', () => {
    assert.equal(validateNewPassword('short1', 'short1'), 'Use at least 8 characters.')
    assert.equal(validateNewPassword('onlyletters', 'onlyletters'), 'Use a mix of letters and numbers.')
    assert.equal(validateNewPassword('12345678', '12345678'), 'Use a mix of letters and numbers.')
    assert.equal(validateNewPassword('ravi.kumar2026', 'ravi.kumar2026', 'ravi.kumar@alton.example'), 'Do not use your email address in the password.')
    assert.equal(validateNewPassword('Glaze-2026', 'Glaze-2027'), 'The passwords do not match.')
    assert.equal(validateNewPassword('x1'.repeat(40), 'x1'.repeat(40)), 'Use at most 72 characters.')
    assert.equal(validateNewPassword('Glaze-2026', 'Glaze-2026', 'ravi@alton.example'), null)
  })
  it('the checklist reports each rule', () => {
    assert.deepEqual(passwordChecks('Glaze-2026').map((c) => c.ok), [true, true, true, true])
    assert.deepEqual(passwordChecks('').map((c) => c.ok), [false, false, false, false])
  })
})

describe('errors', () => {
  it('invalid and expired codes get one clear message; rate limits and network are explained', () => {
    const bad = describeOtpError({ code: 'otp_expired', status: 403, message: 'Token has expired or is invalid' }, false)
    assert.match(bad, /incorrect or has expired/)
    assert.match(describeOtpError({ status: 429, code: 'over_request_rate_limit' }, false), /Too many attempts/)
    assert.match(describeOtpError(new TypeError('Failed to fetch'), true), /internet connection/)
  })
  it('reads the wait time Supabase states for repeated requests', () => {
    assert.equal(retryAfterSeconds({ message: 'For security purposes, you can only request this after 42 seconds.' }), 42)
    assert.equal(retryAfterSeconds({ message: 'Email rate limit exceeded' }), null)
  })
  it('resend countdown', () => {
    assert.equal(resendSecondsLeft(1_000_000, 1_000_000), 60)
    assert.equal(resendSecondsLeft(1_000_000, 1_000_000 + 59_001), 1)
    assert.equal(resendSecondsLeft(1_000_000, 1_000_000 + 60_000), 0)
    assert.equal(resendSecondsLeft(1_000_000, 1_000_000, 90), 90)
  })
})

describe('browser state never holds the code', () => {
  const g = globalThis as unknown as { window?: unknown }
  it('pending request keeps only the e-mail and send time; stale or malformed entries are dropped', () => {
    const session = new MemoryStorage()
    const local = new MemoryStorage()
    g.window = { sessionStorage: session, localStorage: local }
    try {
      const now = Date.now()
      savePendingRequest({ email: 'ravi@alton.example', sentAt: now, ...({ code: '123456' } as object) } as never)
      const stored = [...session.data.values()].join('')
      assert.ok(!stored.includes('123456'), 'code stored')
      assert.deepEqual(readPendingRequest(now), { email: 'ravi@alton.example', sentAt: now })
      assert.equal(readPendingRequest(now + 61 * 60 * 1000), null, 'expired request kept')
      session.setItem('alton:password-recovery:request:v1', '{"email":"not-an-email","sentAt":1}')
      assert.equal(readPendingRequest(), null)
      clearPendingRequest()
      assert.equal(session.data.size, 0)
      markVerifiedUser('u1')
      assert.equal(readVerifiedUser(), 'u1')
      clearVerifiedUser()
      assert.equal(readVerifiedUser(), null)
      assert.ok(![...local.data.values(), ...session.data.values()].some((v) => /\b\d{6}\b/.test(v)))
    } finally {
      delete g.window
    }
  })
  it('without browser storage nothing throws', () => {
    assert.equal(readPendingRequest(), null)
    savePendingRequest({ email: 'a@b.co', sentAt: 1 })
    assert.equal(readVerifiedUser(), null)
  })
})

describe('Supabase "Reset password" e-mail template', () => {
  const html = readFileSync(new URL('../../supabase/templates/recovery.html', import.meta.url), 'utf8')
  const body = html.replace(/<!--[\s\S]*?-->/, '')
  const [invitation, reset] = body.split('{{ else }}')
  it('shows the 6-digit code and never the confirmation link', () => {
    assert.ok(reset.includes('{{ .Token }}'))
    assert.ok(!body.includes('.ConfirmationURL'))
    assert.ok(!reset.includes('href='), 'the password reset part contains a link')
  })
  it('keeps the activation link only for invitations of existing accounts (invite-user function redirect)', () => {
    assert.match(invitation, /\{\{ if or \(eq \.RedirectTo \(printf "%s\/accept-invitation" \.SiteURL\)\) \(eq \.RedirectTo \(printf "%s\/reset-password" \.SiteURL\)\) \}\}/)
    assert.ok(invitation.includes('{{ .SiteURL }}/accept-invitation?token_hash={{ .TokenHash }}&amp;type=recovery'))
    assert.ok(!invitation.includes('{{ .Token }}'))
    assert.equal((body.match(/\{\{ if /g) ?? []).length, 1)
    assert.equal((body.match(/\{\{ end \}\}/g) ?? []).length, 1)
  })
  it('configured for the local CLI stack', () => {
    const toml = readFileSync(new URL('../../supabase/config.toml', import.meta.url), 'utf8')
    assert.match(toml, /\[auth\.email\.template\.recovery\]\s*\nsubject = "Your Alton ERP password reset code"\s*\ncontent_path = "\.\/supabase\/templates\/recovery\.html"/)
    assert.match(toml, /\[auth\.email\.template\.invite\]/)
  })
})
