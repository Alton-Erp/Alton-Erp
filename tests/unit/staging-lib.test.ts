import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// @ts-expect-error plain ESM script module without type declarations
import { createReport, isDenied, isPrivilegedKey, missingEnv, redact, STATUS } from '../../scripts/lib/staging.mjs'

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload: object) => `${b64({ alg: 'HS256' })}.${b64(payload)}.signaturepart`

describe('staging verification helpers', () => {
  it('redacts configured secrets, JWTs and Supabase keys, but not ordinary values', () => {
    const env = { STAGING_TEST_PASSWORD: 'Hunter2-Staging!', VITE_SUPABASE_URL: 'https://abc.supabase.co' }
    const out = redact(`login with Hunter2-Staging! at https://abc.supabase.co token ${jwt({ role: 'authenticated', sub: 'x' })} key sb_secret_abcdefgh12345`, env)
    assert.ok(!out.includes('Hunter2-Staging!'))
    assert.ok(!out.includes('sb_secret_abcdefgh12345'))
    assert.ok(!out.includes('eyJ'))
    assert.ok(out.includes('https://abc.supabase.co'), 'the URL is not a secret')
  })

  it('recognises privileged keys and accepts publishable / anon keys', () => {
    assert.equal(isPrivilegedKey('sb_secret_123456789'), true)
    assert.equal(isPrivilegedKey(jwt({ role: 'service_role' })), true)
    assert.equal(isPrivilegedKey(jwt({ role: 'anon' })), false)
    assert.equal(isPrivilegedKey('sb_publishable_123456789'), false)
  })

  it('reports missing variables by name', () => {
    assert.deepEqual(missingEnv(['A', 'B', 'C'], { A: 'x', B: '  ' }), ['B', 'C'])
  })

  it('treats only PASS as passed: FAIL -> 1, BLOCKED or NOT RUN -> 3, all PASS (+ MANUAL) -> 0', () => {
    const log = console.log
    console.log = () => {}
    try {
      const a = createReport('t')
      a.pass('x')
      a.manual('m', 'check by hand')
      assert.equal(a.finish(), 0)
      const b = createReport('t')
      b.pass('x')
      b.blocked('y', 'no account')
      assert.equal(b.finish(), 3)
      const c = createReport('t')
      c.blocked('y', 'no account')
      c.fail('z')
      assert.equal(c.finish(), 1)
      const d = createReport('t')
      d.notRun('n', 'skipped')
      assert.equal(d.finish(), 3)
      assert.deepEqual(Object.values(STATUS), ['PASS', 'FAIL', 'BLOCKED', 'NOT RUN', 'MANUAL REVIEW REQUIRED'])
    } finally {
      console.log = log
    }
  })

  it('detects permission refusals', () => {
    assert.equal(isDenied({ error: { code: '42501', message: 'x' } }), true)
    assert.equal(isDenied({ error: { code: 'P0001', message: 'You are not allowed to perform this action' } }), true)
    assert.equal(isDenied({ error: { code: 'P0001', message: 'Quantity must be greater than zero.' } }), false)
    assert.equal(isDenied({ data: {} }), false)
  })
})
